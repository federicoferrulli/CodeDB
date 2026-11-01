'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// Merge su identità native: collation, binari, array precisi e BSON Int64.
// Il livello runRestore isola la contabilità del merge: nessuna vista, FK o
// colonna generata può mascherare questi contratti con un errore di schema.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-merge-identita.cjs [--sensitivity]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Long } = require('bson');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { readManifest, verifyBackupDir } = require('../../backup/lib/util');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-005/merge-identita');
const log = { info() {}, warn() {}, error() {} };
const hash = value => createHash('sha256').update(value).digest('hex');
const ordinati = rows => rows.sort((a, b) => a.id.localeCompare(b.id));

async function worker(type, mutant) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-merge-identita', motore: type, mutante: mutant, verifiche: [],
    ripristini: [], mutazioni: 0, sorgenti: {}, iniziato: new Date().toISOString(),
    percorso: 'runRestore: merge dati senza oggetti di schema dipendenti' };
  for (const name of ['backup/lib/merge-identita.js', 'backup/lib/restore.js', 'backup/lib/engine.js', 'backup/lib/identity.js',
    'db/mongoBson.js', 'db/pg-alias.js', 'db/pg-references.js', 'test/lab/backup-merge-identita.cjs']) {
    report.sorgenti[name] = hash(fs.readFileSync(path.resolve(__dirname, '../..', name)));
  }
  const helper = require('../../backup/lib/merge-identita');
  if (mutant === 'conteggio') {
    const original = helper.contaIdentitaPreservate;
    helper.contaIdentitaPreservate = async options => {
      const count = await original(options);
      if (count) report.mutazioni++;
      return 0;
    };
  }
  if (mutant === 'identita') {
    const bson = require('../../db/mongoBson');
    const original = bson.importRows;
    bson.importRows = (client, db, collection, rows, upsert, options = {}) => {
      if (collection === 'dati' && options.preservaIdentita) report.mutazioni++;
      return original(client, db, collection, rows, upsert, { ...options, preservaIdentita: false });
    };
  }
  if (mutant === 'alias') {
    const original = helper.contaIdentitaPreservate;
    helper.contaIdentitaPreservate = async options => {
      const aliases = require('../../db/pg-alias');
      const binding = aliases.binding, resolveNested = aliases.resolveNested;
      aliases.binding = value => { report.mutazioni++; return { sql: '$1', param: JSON.stringify(value) }; };
      aliases.resolveNested = async (query, rows, shapes) => {
        if (rows.some(row => Object.values(row).some(value => value?.$pgReference?.kind === 'nested'))) { report.mutazioni++; return; }
        return resolveNested(query, rows, shapes);
      };
      try { return await original(options); }
      finally { aliases.binding = binding; aliases.resolveNested = resolveNested; }
    };
  }
  if (mutant === 'fuso') {
    const original = helper.contaIdentitaPreservate;
    helper.contaIdentitaPreservate = options => {
      const strategy = Object.create(options.strategy), pool = Object.create(options.strategy.pool);
      pool.getConnection = async () => {
        const connection = await options.strategy.pool.getConnection();
        return new Proxy(connection, { get(target, property) {
          if (property === 'query') return (sql, ...args) => {
            if (sql === 'SET SESSION time_zone = ?') { report.mutazioni++; return Promise.resolve([{}, []]); }
            return target.query(sql, ...args);
          };
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      strategy.pool = pool;
      return original({ ...options, strategy });
    };
  }
  if (mutant === 'marker') {
    require('../../db/pg-alias').identitaStabile = value => { report.mutazioni++; return value; };
  }
  const { runBackup } = require('../../backup/lib/engine');
  const { runRestore, resolveChain } = require('../../backup/lib/restore');
  const mongo = type === 'mongodb', mysql = type === 'mysql';
  const registry = createE2eTargetRegistry({ destructive: true, prefix: `lab_merge_${type}` });
  const q = name => mysql ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"';
  const table = db => `${q(db)}.${q('dati')}`;
  const idParameter = (scenario, db) => scenario.bind ? scenario.bind('$1', db) : mysql ? '?' : '$1';
  let native, strategy;
  const query = async (sql, params = []) => mysql ? (await native.query(sql, params))[0] : (await native.query(sql, params)).rows;
  const check = async (id, fn) => {
    try { const dettagli = await fn(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${type}/${id}`); }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${type}/${id}: ${error.message}`); }
  };
  const cases = mysql ? [
    { name: 'testo-collation', ddl: 'VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      keys: ['caffè', 'altro', 'nuovo', 'sentinella'], overlap: 'CAFFE', expr: 'id' },
    { name: 'binary', ddl: 'VARBINARY(32)', keys: ['00ff80', '01007f', 'fe00ff', '0a00bb'].map(s => Buffer.from(s, 'hex')), expr: 'LOWER(HEX(id))' },
    { name: 'timestamp-fuso', ddl: 'TIMESTAMP(6)',
      keys: [1, 2, 3, 4].map(day => `2026-01-0${day} 01:02:03.123456`),
      expr: "DATE_FORMAT(id,'%Y-%m-%d %H:%i:%s.%f')", timezone: '+02:00' },
  ] : mongo ? [
    { name: 'testo-collation', keys: ['caffè', 'altro', 'nuovo', 'sentinella'], overlap: 'CAFFE', collation: { locale: 'it', strength: 1 } },
    { name: 'long-bson', keys: ['9007199254740993', '9007199254740995', '9007199254740997', '9007199254740999'].map(s => Long.fromString(s)) },
  ] : [
    { name: 'bytea', ddl: 'BYTEA', keys: ['00ff80', '01007f', 'fe00ff', '0a00bb'].map(s => Buffer.from(s, 'hex')), expr: "encode(id,'hex')" },
    { name: 'array-numeric', ddl: 'NUMERIC[]',
      keys: [0, 1, 3, 2].map(n => `[${n}:${n + 1}]={9007199254740993.123456789012345678901234567890,2}`), expr: 'id::text' },
    { name: 'regproc', ddl: 'REGPROC', keys: ['abs(integer)', 'abs(bigint)', 'lower(text)', 'upper(text)'],
      bind: parameter => `${parameter}::pg_catalog.regprocedure::oid::pg_catalog.regproc`, expr: 'id::oid::regprocedure::text' },
    { name: 'regproc-array', ddl: 'REGPROC[]',
      keys: [0, 1, 3, 2].map(n => `[${n}:${n + 1}]={"abs(integer)","lower(text)"}`),
      bind: parameter => `${parameter}::pg_catalog.regprocedure[]::oid[]::pg_catalog.regproc[]`, expr: 'id::oid[]::regprocedure[]::text' },
    { name: 'regproc-composito', ddl: db => `${q(db)}.${q('identita_alias')}`,
      keys: ['abs(integer)', 'abs(bigint)', 'lower(text)', 'upper(text)'],
      bind: (parameter, db) => `ROW(${parameter}::pg_catalog.regprocedure::oid)::${q(db)}.${q('identita_alias')}`,
      expr: '(id).funzione::oid::regprocedure::text',
      prepara: db => `CREATE TYPE ${q(db)}.${q('identita_alias')} AS (funzione regproc)` },
  ];
  async function create(db, scenario) {
    if (mongo) await native.db(db).createCollection('dati', scenario.collation ? { collation: scenario.collation } : {});
    else {
      await query(`CREATE ${mysql ? 'DATABASE' : 'SCHEMA'} ${q(db)}`);
      if (scenario.prepara) await query(scenario.prepara(db));
      const ddl = typeof scenario.ddl === 'function' ? scenario.ddl(db) : scenario.ddl;
      await query(`CREATE TABLE ${table(db)}(id ${ddl} PRIMARY KEY, valore INT NOT NULL, updated_at ${mysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'} NOT NULL)`);
    }
  }
  async function insert(db, scenario, id, value, future = false) {
    const date = new Date(future ? '2100-01-01T12:34:56.000Z' : '2000-01-01T00:00:00.000Z');
    if (mongo) await native.db(db).collection('dati').insertOne({ _id: id, valore: value, updated_at: date });
    else await query(`INSERT INTO ${table(db)}(id,valore,updated_at) VALUES(${idParameter(scenario, db)},${mysql ? '?,?' : '$2,$3'})`, [id, value, date]);
  }
  async function read(db, scenario) {
    if (mongo) {
      const rows = await native.db(db).collection('dati').find({}).toArray();
      return ordinati(rows.map(row => ({ id: row._id?.toString(), tipo: row._id?._bsontype || typeof row._id,
        valore: row.valore, updated_at: row.updated_at.toISOString() })));
    }
    const rows = await query(`SELECT ${scenario.expr} AS id,valore,updated_at FROM ${table(db)}`);
    return ordinati(rows.map(row => ({ id: row.id, valore: row.valore,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at })));
  }
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    if (mongo) {
      const { MongoClient } = require('mongodb');
      native = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.LAB_MONGO_PORT || 37017)}/?directConnection=true`,
        { serverSelectionTimeoutMS: 6000, promoteLongs: false });
      await native.connect(); strategy = new (require('../../db/MongoDbStrategy'))(); strategy.client = native;
    } else if (mysql) {
      const driver = require('mysql2/promise');
      const config = { host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), user: 'root',
        password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql', timezone: 'Z' };
      native = await driver.createConnection(config); strategy = new (require('../../db/MySqlStrategy'))();
      strategy.pool = driver.createPool({ ...config, connectionLimit: 3 });
      await native.query("SET SESSION time_zone = '+00:00'");
    } else {
      const { Client, Pool } = require('pg');
      const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres',
        password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
      native = new Client(config); await native.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))();
      strategy.pool = new Pool({ ...config, max: 3 });
      if (mutant === 'cast-delete') {
        const original = strategy.pool.query.bind(strategy.pool);
        strategy.pool.query = (sql, ...args) => {
          const changed = /^DELETE FROM /.test(sql) ? sql.replace(/(\$\d+)::"[^"]+"\."identita_alias"/g,
            (_match, parameter) => { report.mutazioni++; return parameter; }) : sql;
          return original(changed, ...args);
        };
      }
    }
    for (const scenario of cases) {
      if (scenario.timezone) {
        const connections = await Promise.all([0, 1, 2].map(() => strategy.pool.getConnection()));
        try { for (const connection of connections) await connection.query('SET SESSION time_zone = ?', [scenario.timezone]); }
        finally { for (const connection of connections) connection.release(); }
      }
      const source = registry.target(`${scenario.name}_src`), target = registry.target(`${scenario.name}_dest`);
      await create(source, scenario); await create(target, scenario);
      await insert(source, scenario, scenario.keys[0], 10); await insert(source, scenario, scenario.keys[1], 11);
      await insert(target, scenario, scenario.overlap || scenario.keys[0], -1); await insert(target, scenario, scenario.keys[3], 99);
      const sentinel = (await read(target, scenario)).find(row => row.valore === 99);
      const overlap = (await read(target, scenario)).find(row => row.valore === -1);
      const archive = type => runBackup({ session: { strategy, dbType: mongo ? 'mongodb' : mysql ? 'mysql' : 'postgresql' },
        connName: `merge-${scenario.name}`, db: source, type, sinceField: 'updated_at',
        destRoot: path.join(reportDir, 'archivi'), compress: true, log });
      const full = await archive('full');
      if (mongo) await native.db(source).collection('dati').updateOne({ _id: scenario.keys[0] },
        { $set: { valore: 20, updated_at: new Date('2100-01-01T12:34:56.000Z') } });
      else await query(`UPDATE ${table(source)} SET valore=20,updated_at='2100-01-01 12:34:56' WHERE id=${idParameter(scenario, source)}`, [scenario.keys[0]]);
      await insert(source, scenario, scenario.keys[2], 30, true);
      const incremental = await archive('incremental');
      const chain = resolveChain(incremental.backupDir), firstFile = chain[0].manifest.files.find(file => file.kind === 'data');
      let restored = false;
      await check(`${scenario.name}-archivio`, async () => {
        assert.equal(chain.length, 2); assert.equal(chain[1].manifest.baseId, full.id);
        const manifest = readManifest(incremental.backupDir), data = manifest.files.find(file => file.kind === 'data');
        assert.equal(data.mode, 'incremental', 'La prova deve esercitare una vera catena incrementale');
        assert.equal(data.count, 2); assert.equal(data.sourceCardinality, 3);
        const deletions = manifest.files.find(file => file.kind === 'tombstones' && file.collection === 'dati');
        assert(deletions, 'Il layer deve dichiarare le cancellazioni verificate');
        assert.equal(deletions.count, 0, '[MERGE-IDENTITA-TOMBSTONE] aggiornare un valore non deve inventare cancellazioni delle identità');
        if (mongo) assert.equal(data.encoding, 'bson-base64', 'La prova BSON deve attraversare il formato raw');
        assert.equal((await verifyBackupDir(incremental.backupDir)).valid, true);
        return { backup: incremental.backupDir, mode: data.mode, encoding: data.encoding, count: data.count, sourceCardinality: data.sourceCardinality };
      });
      await check(`${scenario.name}-preservate`, async () => {
        const count = await helper.contaIdentitaPreservate({ strategy, dbType: type, targetDb: target,
          collection: 'dati', chain, file: firstFile });
        assert.equal(count, 1, '[MERGE-IDENTITA-PRESERVATE] solo la sentinella è estranea alla catena');
        if (scenario.timezone) {
          const [[session]] = await strategy.pool.query('SELECT @@SESSION.time_zone AS timezone');
          assert.equal(session.timezone, scenario.timezone, '[MERGE-IDENTITA-FUSO] il conteggio deve ripristinare la timezone della connessione');
        }
        return { count, sentinella: sentinel.id, sovrapposta: overlap.id };
      });
      await check(`${scenario.name}-ripristino`, async () => {
        const summary = await runRestore({ session: { strategy, dbType: type }, backupDir: incremental.backupDir,
          targetDb: target, drop: false, log });
        report.ripristini.push({ scenario: scenario.name, summary });
        assert.equal(summary.totalDocs, 4, '[MERGE-IDENTITA-CONTEGGIO] tre righe sorgente e una sentinella');
        assert.equal(summary.expectedDocs, 4);
        assert.deepEqual(summary.collections.map(item => [item.expected, item.preserved, item.cardinality, item.distinctIdentities]), [[4, 1, 4, 4]]);
        restored = true;
        return summary;
      });
      await check(`${scenario.name}-dati`, async () => {
        const expected = await read(source, scenario);
        // L'upsert mantiene l'identità della riga già presente e aggiorna i
        // valori. Su MongoDB questo evita anche di cambiare l'_id immutabile.
        if (scenario.overlap) expected.find(row => row.valore === 20).id = overlap.id;
        expected.push(sentinel);
        const actual = await read(target, scenario);
        assert.equal(actual.length, 4, '[MERGE-IDENTITA-DATI] cardinalità esatta dopo sovrapposizione e merge');
        assert.deepEqual(actual, ordinati(expected), '[MERGE-IDENTITA-DATI] dati e identità precisi preservati dal DBMS');
        if (!mongo && !mysql && ['array-numeric', 'regproc-array'].includes(scenario.name)) {
          const bounds = await query(`SELECT array_lower(id,1) AS basso,array_upper(id,1) AS alto FROM ${table(target)} ORDER BY basso`);
          assert.deepEqual(bounds, [0, 1, 2, 3].map(n => ({ basso: n, alto: n + 1 })));
        }
        return { count: actual.length, righe: actual };
      });
      await check(`${scenario.name}-identita-native`, async () => {
        let count, distinct;
        if (mongo) {
          count = await native.db(target).collection('dati').countDocuments({});
          distinct = (await native.db(target).collection('dati').aggregate([{ $group: { _id: '$_id' } }, { $count: 'n' }]).toArray())[0].n;
          const leftovers = (await native.db(target).listCollections().toArray()).filter(item => item.name.startsWith('_cdb_merge_'));
          assert.deepEqual(leftovers, [], 'Il conteggio non deve lasciare collection temporanee');
        } else {
          const row = (await query(`SELECT COUNT(*) AS n,COUNT(DISTINCT id) AS distinti FROM ${table(target)}`))[0];
          count = Number(row.n); distinct = Number(row.distinti);
        }
        assert.equal(count, 4, '[MERGE-IDENTITA-NATIVE] conteggio esatto del DBMS');
        assert.equal(distinct, 4, '[MERGE-IDENTITA-NATIVE] identità distinte secondo il DBMS');
        return { count, distinct };
      });
      if (scenario.name === 'regproc-composito') {
        if (!restored) (report.nonEseguiti ||= []).push({ id: 'regproc-composito-cancellazione', motivo: 'Il primo ripristino è fallito: la fase successiva richiede quel risultato.' });
        else await check('regproc-composito-cancellazione', async () => {
          await query(`DELETE FROM ${table(source)} WHERE id=${idParameter(scenario, source)}`, [scenario.keys[1]]);
          const deleted = await archive('incremental');
          const manifest = readManifest(deleted.backupDir);
          const tombstone = manifest.files.find(file => file.kind === 'tombstones' && file.collection === 'dati');
          assert.equal(tombstone.count, 1, '[MERGE-IDENTITA-CANCELLAZIONE] una sola cancellazione reale');
          const summary = await runRestore({ session: { strategy, dbType: type }, backupDir: deleted.backupDir,
            targetDb: target, drop: false, log });
          assert.equal(summary.layers, 3); assert.equal(summary.totalDocs, 3); assert.equal(summary.expectedDocs, 3);
          assert.deepEqual(summary.collections.map(item => [item.expected, item.preserved, item.cardinality, item.distinctIdentities]), [[3, 1, 3, 3]]);
          const expected = ordinati([...(await read(source, scenario)), sentinel]), actual = await read(target, scenario);
          assert.equal(actual.length, 3, '[MERGE-IDENTITA-CANCELLAZIONE] due righe sorgente più sentinella');
          assert.deepEqual(actual, expected, '[MERGE-IDENTITA-CANCELLAZIONE] eliminare solo l’identità dichiarata e preservare la sentinella');
          return { backup: deleted.backupDir, cancellazioni: tombstone.count, summary, righe: actual };
        });
      }
    }
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    try {
      if (native) await registry.cleanup(db => mongo ? native.db(db).dropDatabase()
        : query(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${q(db)}${mysql ? '' : ' CASCADE'}`));
      report.pulizia = 'completata';
    } catch (error) { report.errorePulizia = error.stack; }
    if (strategy?.pool) await strategy.pool.end();
    if (native) await (mongo ? native.close() : native.end());
    report.terminato = new Date().toISOString();
    report.ok = !report.erroreFatale && !report.errorePulizia && report.verifiche.length === cases.length * 5 + (type === 'postgresql' ? 1 : 0)
      && report.verifiche.every(item => item.ok);
    fs.writeFileSync(path.join(reportDir, 'backup-merge-identita.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

async function child(type, mutant) {
  const dir = path.join(reportDir, `${type}${mutant ? `-mutante-${mutant}` : ''}`); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-merge-identita.json'); fs.rmSync(file, { force: true });
  const output = fs.createWriteStream(path.join(dir, 'console.log'));
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, '--worker', type,
      ...(mutant === 'conteggio' ? ['--mutant'] : mutant === 'identita' ? ['--mutant-id']
        : mutant === 'alias' ? ['--mutant-alias'] : mutant === 'fuso' ? ['--mutant-fuso']
          : mutant === 'marker' ? ['--mutant-marker'] : mutant === 'cast-delete' ? ['--mutant-cast-delete'] : [])],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_REPORT_DIR: dir } });
    inoltraOutputFiglio(proc, { log: output, mutante: mutant ? `${type}/${mutant}` : null });
    proc.once('error', reject); proc.once('close', resolve);
  }).finally(() => new Promise(resolve => output.end(resolve)));
  return { exitCode, report: file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ok: false, erroreFatale: 'Rapporto assente' }) };
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
  const motors = ['mysql', 'postgresql', 'mongodb'].filter(type => !process.env.LAB_MERGE_ENGINE || process.env.LAB_MERGE_ENGINE === type);
  assert(motors.length); fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-merge-identita', risultati: [], sensibilita: [], iniziato: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(reportDir, 'backup-merge-identita.json'), JSON.stringify(report, null, 2));
  for (const type of motors) { report.risultati.push(await child(type, false)); save(); }
  const integro = result => result.exitCode === 1 && result.mutazioni > 0 && !result.erroreFatale
    && !result.errorePulizia && !result.erroreChiusura && result.pulizia === 'completata';
  if (process.argv.includes('--sensitivity')) for (const type of motors) {
    const result = await child(type, 'conteggio'), failures = (result.verifiche || []).filter(item => !item.ok);
    const cases = { mysql: ['testo-collation', 'binary', 'timestamp-fuso'], mongodb: ['testo-collation', 'long-bson'],
      postgresql: ['bytea', 'array-numeric', 'regproc', 'regproc-array', 'regproc-composito'] }[type];
    const expected = cases.flatMap(name => [`${name}-preservate`, `${name}-ripristino`]);
    report.sensibilita.push({ motore: type, mutante: 'conteggio', risultato: result, rilevata: integro(result)
      && JSON.stringify(failures.map(item => item.id).sort()) === JSON.stringify(expected.sort()) }); save();
  }
  if (process.argv.includes('--sensitivity') && motors.includes('mongodb')) {
    const result = await child('mongodb', 'identita'), failures = (result.verifiche || []).filter(item => !item.ok);
    report.sensibilita.push({ motore: 'mongodb', mutante: 'identita', risultato: result,
      rilevata: integro(result)
        && failures.length === 3 && failures.every(item => ['testo-collation-ripristino', 'testo-collation-dati', 'testo-collation-identita-native'].includes(item.id))
        && /immutable/.test(failures.find(item => item.id === 'testo-collation-ripristino')?.errore || '') }); save();
  }
  if (process.argv.includes('--sensitivity') && motors.includes('postgresql')) {
    const result = await child('postgresql', 'alias'), failures = (result.verifiche || []).filter(item => !item.ok);
    report.sensibilita.push({ motore: 'postgresql', mutante: 'alias', risultato: result,
      rilevata: integro(result)
        && failures.length === 12 && failures.every(item => /^regproc(?:-array|-composito)?-(?:preservate|ripristino|dati|identita-native)$/.test(item.id)) }); save();
  }
  if (process.argv.includes('--sensitivity') && motors.includes('mysql')) {
    const result = await child('mysql', 'fuso'), failures = (result.verifiche || []).filter(item => !item.ok);
    report.sensibilita.push({ motore: 'mysql', mutante: 'fuso', risultato: result,
      rilevata: integro(result)
        && failures.length === 2 && failures.every(item => ['timestamp-fuso-preservate', 'timestamp-fuso-ripristino'].includes(item.id)) }); save();
  }
  if (process.argv.includes('--sensitivity') && motors.includes('postgresql')) {
    for (const mutant of ['marker', 'cast-delete']) {
      const result = await child('postgresql', mutant), failures = (result.verifiche || []).filter(item => !item.ok);
      const expected = mutant === 'marker' ? ['regproc-composito-archivio', 'regproc-composito-ripristino', 'regproc-composito-dati', 'regproc-composito-identita-native']
        : ['regproc-composito-cancellazione'];
      report.sensibilita.push({ motore: 'postgresql', mutante: mutant, risultato: result,
        rilevata: integro(result)
          && failures.length === expected.length && failures.every(item => expected.includes(item.id)) }); save();
    }
  }
  report.ok = report.risultati.every(item => item.ok && item.exitCode === 0) && report.sensibilita.every(item => item.rilevata);
  report.totali = { verifiche: report.risultati.reduce((n, item) => n + item.verifiche.length, 0),
    fallite: report.risultati.flatMap(item => item.verifiche).filter(item => !item.ok).length,
    mutanti: report.sensibilita.length, rilevati: report.sensibilita.filter(item => item.rilevata).length };
  report.terminato = new Date().toISOString(); save(); if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv[process.argv.indexOf('--worker') + 1],
  process.argv.includes('--mutant-id') ? 'identita' : process.argv.includes('--mutant-alias') ? 'alias'
    : process.argv.includes('--mutant-fuso') ? 'fuso' : process.argv.includes('--mutant-marker') ? 'marker'
      : process.argv.includes('--mutant-cast-delete') ? 'cast-delete' : process.argv.includes('--mutant') ? 'conteggio' : null) : main())
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
