'use strict';

// AUD014: restore selettivo con tabelle e oggetti locali da preservare.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-selettivo.cjs
// LAB_SELETTIVO_ENGINE limita il motore; LAB_REPORT_DIR conserva ogni run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EJSON, serialize } = require('bson');
const { createE2eTargetRegistry } = require('../e2e-harness');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-014/reali-host');
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const silenzioso = { info() {}, warn() {}, error() {} };

async function worker(type) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-selettivo', motore: type, iniziato: new Date().toISOString(), verifiche: [], operazioni: [], sorgenti: {} };
  for (const file of ['db/backupRestoreAdapter.js', 'db/importArtifactAdapter.js', 'db/schemaObjects.js',
    'backup/lib/restore.js', 'backup/lib/schema-snapshot.js', 'test/lab/backup-selettivo.cjs']) report.sorgenti[file] = hash(fs.readFileSync(file));
  const mongo = type === 'mongodb', mysql = type === 'mysql';
  const registry = createE2eTargetRegistry({ destructive: true, prefix: mongo ? 'lab_sel_m' : mysql ? 'lab_sel_y' : 'lab_sel_p' });
  const source = registry.target('origine');
  const qid = value => mysql ? '`' + value.replaceAll('`', '``') + '`' : '"' + value.replaceAll('"', '""') + '"';
  const table = (db, name) => `${qid(db)}.${qid(name)}`;
  let native, strategy, tamper = null;
  const restore = require('../../backup/lib/restore'), originalRestore = restore.runRestore;
  restore.runRestore = async options => {
    const result = await originalRestore(options);
    if (tamper && options.onlyCollections?.includes('scelta')) {
      const action = tamper; tamper = null; await action(options.targetDb);
    }
    return result;
  };
  const { runBackup } = require('../../backup/lib/engine');
  const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
  const query = async (sql, params = []) => plain(mysql ? (await native.query(sql, params))[0] : (await native.query(sql, params)).rows);
  async function check(id, action) {
    const started = Date.now();
    try { const dettagli = await action(); report.verifiche.push({ id, ok: true, ms: Date.now() - started, dettagli }); console.log(`OK ${type}/${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, ms: Date.now() - started, errore: error.message, stack: error.stack }); console.error(`FAIL ${type}/${id}: ${error.message}`); return false; }
  }
  const listDb = async () => mongo ? (await native.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(db => db.name)
    : (await query(mysql ? 'SHOW DATABASES' : 'SELECT schema_name FROM information_schema.schemata')).map(row => Object.values(row)[0]);
  function ownerOf(name, owned) {
    const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
    return suffix && owned.find(base => name === base.slice(0, 63 - suffix.length) + suffix);
  }
  const rows = async (db, name) => mongo ? plain(await native.db(db).collection(name).find({}).sort({ _id: 1 }).toArray())
    : query(`SELECT * FROM ${table(db, name)} ORDER BY id`);
  async function collectionSnapshot(db, name) {
    if (mongo) {
      const info = await native.db(db).listCollections({ name }).next(); assert(info, `Collection ${name} assente`);
      const options = { ...info.options, validator: info.options.validator ?? {}, validationLevel: info.options.validationLevel ?? 'strict', validationAction: info.options.validationAction ?? 'error' };
      const indexes = (await native.db(db).collection(name).listIndexes().toArray()).filter(index => index.name !== '_id_')
        .map(({ v, ns, ...index }) => ({ name: index.name, bson: serialize(index).toString('base64') })).sort((a, b) => a.name.localeCompare(b.name));
      return { rows: await rows(db, name), options: EJSON.serialize(options, { relaxed: false }), indexes };
    }
    const columns = mysql
      ? await query(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS tipo,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS valoreDefault,EXTRA AS extra
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [db, name])
      : await query(`SELECT column_name AS name,data_type AS tipo,udt_name,is_nullable AS nullable,column_default AS "valoreDefault"
        FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [db, name]);
    assert(columns.length, `Tabella ${name} assente`);
    const indexes = mysql
      ? await query(`SELECT INDEX_NAME AS name,NON_UNIQUE AS nonUnico,SEQ_IN_INDEX AS posizione,COLUMN_NAME AS colonna,COLLATION AS ordine,SUB_PART AS prefisso
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`, [db, name])
      : await query(`SELECT i.relname AS name,x.indisunique AS unico,x.indisprimary AS primario,
        ARRAY(SELECT pg_get_indexdef(x.indexrelid,p,true) FROM generate_series(1,x.indnatts) p) AS elementi,
        pg_get_expr(x.indpred,x.indrelid,true) AS predicato FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
        JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=$1 AND t.relname=$2 ORDER BY i.relname`, [db, name]);
    return { rows: await rows(db, name), columns, indexes };
  }
  async function snapshot(db, names = ['scelta', 'ignorata', 'locale']) {
    if (!mongo && !mysql) await query(`SET search_path TO ${qid(db)},pg_catalog`);
    const result = { collections: {}, views: {} };
    for (const name of names) result.collections[name] = await collectionSnapshot(db, name);
    const views = mongo ? (await native.db(db).listCollections().toArray()).filter(item => item.type === 'view').map(item => ({ name: item.name, options: EJSON.serialize(item.options, { relaxed: false }) }))
      : mysql ? await query('SELECT TABLE_NAME AS name,VIEW_DEFINITION AS definizione,CHECK_OPTION,SECURITY_TYPE FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [db])
        : await query(`SELECT c.relname AS name,pg_get_viewdef(c.oid,true) AS definizione FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND c.relkind='v' ORDER BY c.relname`, [db]);
    for (const view of views.sort((a, b) => a.name.localeCompare(b.name))) result.views[view.name] = { catalogo: view, rows: await rows(db, view.name) };
    return result;
  }
  async function insert(db, name, data) {
    if (mongo) await native.db(db).collection(name).insertMany(data.map(({ id, ...record }) => ({ _id: id, ...record })));
    else for (const row of data) {
      const keys = Object.keys(row), values = Object.values(row);
      await query(`INSERT INTO ${table(db, name)} (${keys.map(qid).join(',')}) VALUES (${keys.map((_, i) => mysql ? '?' : `$${i + 1}`).join(',')})`, values);
    }
  }
  async function createCollection(db, name, extra) {
    if (mongo) await native.db(db).createCollection(name, extra
      ? { validator: { $jsonSchema: { required: ['nota'], properties: { nota: { bsonType: 'string' } } } } } : {});
    else await query(`CREATE TABLE ${table(db, name)} (id INT PRIMARY KEY,valore INT NOT NULL${extra ? ",nota VARCHAR(32) NOT NULL DEFAULT 'locale'" : ''})`);
    const indexName = name === 'scelta' ? 'ix_scelta' : `ix_${name}_${extra ? 'personale' : 'backup'}`;
    if (mongo) await native.db(db).collection(name).createIndex(extra ? { nota: 1, valore: -1 } : { valore: 1 }, { name: indexName });
    else await query(`CREATE INDEX ${qid(indexName)} ON ${table(db, name)} (${extra ? 'nota,valore DESC' : 'valore'})`);
  }
  async function createView(db, name, base, factor) {
    if (mongo) await native.db(db).createCollection(name, { viewOn: base, pipeline: [{ $project: { _id: 1, calcolo: { $add: [{ $multiply: ['$valore', factor] }, 3] } } }] });
    else await query(`CREATE VIEW ${table(db, name)} AS SELECT id,valore*${factor}+3 AS calcolo FROM ${table(db, base)}`);
  }
  async function fixture(db, isSource) {
    if (!mongo) await query(`CREATE ${mysql ? 'DATABASE' : 'SCHEMA'} ${qid(db)}`);
    await createCollection(db, 'scelta', false); await createCollection(db, 'ignorata', !isSource);
    await insert(db, 'scelta', isSource ? [{ id: 1, valore: 100 }, { id: 2, valore: 200 }] : [{ id: 1, valore: -1 }, { id: 90, valore: 900 }]);
    await insert(db, 'ignorata', isSource ? [{ id: 10, valore: 1000 }]
      : [{ id: 10, valore: 777, nota: 'preservare' }, { id: 11, valore: 778, nota: 'personale' }]);
    await createView(db, 'vista_ignorata', 'ignorata', isSource ? 2 : 7);
    if (!isSource) {
      await createCollection(db, 'locale', true);
      await insert(db, 'locale', [{ id: 30, valore: 3030, nota: 'solo destinazione' }]);
      await createView(db, 'vista_locale', 'locale', 11);
    }
  }
  const dropDb = name => mongo ? native.db(name).dropDatabase() : query(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${qid(name)}${mysql ? '' : ' CASCADE'}`);
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    if (mongo) {
      const { MongoClient } = require('mongodb');
      native = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.LAB_MONGO_PORT || 37017)}/?directConnection=true`, { serverSelectionTimeoutMS: 6000 });
      await native.connect(); strategy = new (require('../../db/MongoDbStrategy'))(); strategy.client = native;
    } else if (mysql) {
      const driver = require('mysql2/promise'), config = { host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), user: 'root', password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql' };
      native = await driver.createConnection(config); strategy = new (require('../../db/MySqlStrategy'))(); strategy.pool = driver.createPool({ ...config, connectionLimit: 3 });
    } else {
      const { Client, Pool } = require('pg'), config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres', connectionTimeoutMillis: 6000 };
      native = new Client(config); await native.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool({ ...config, max: 3 });
    }
    await fixture(source, true);
    const sourceBefore = await snapshot(source, ['scelta', 'ignorata']);
    const backup = await runBackup({ session: { strategy, dbType: type }, connName: 'selettivo', db: source,
      type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: true, log: silenzioso });
    report.backup = backup;
    const controls = new Map();
    for (const drop of [true, false]) {
      const mode = drop ? 'drop' : 'merge', target = registry.target(mode);
      await fixture(target, false);
      const before = await snapshot(target);
      await check(`${mode}-fixture-distinte`, async () => {
        assert.notDeepEqual(before.collections.ignorata, sourceBefore.collections.ignorata);
        assert.notDeepEqual(before.views.vista_ignorata.rows, sourceBefore.views.vista_ignorata.rows);
        assert(before.collections.locale && before.views.vista_locale);
      });
      const phases = [], result = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir: backup.backupDir,
        targetDb: target, onlyCollections: ['scelta'], drop, connName: 'selettivo', recoveryRoot: path.join(reportDir, 'recovery'), log: silenzioso,
        onProgress: event => phases.push(event) });
      report.operazioni.push({ mode, target, result, phases });
      const completed = await check(`${mode}-esito`, async () => assert.equal(result.status, 'completato', JSON.stringify(result)));
      controls.set(drop, completed);
      const after = await snapshot(target);
      fs.writeFileSync(path.join(reportDir, `${mode}-nativo.json`), JSON.stringify({ before, after, source: sourceBefore }, null, 2));
      await check(`${mode}-scelta`, async () => {
        const expected = plain(sourceBefore.collections.scelta), key = mongo ? '_id' : 'id';
        if (!drop) expected.rows = [...expected.rows, ...before.collections.scelta.rows.filter(row => !expected.rows.some(item => item[key] === row[key]))].sort((a, b) => a[key] - b[key]);
        assert.deepEqual(after.collections.scelta, expected);
      });
      for (const name of ['ignorata', 'locale']) await check(`${mode}-${name}-dati-schema-indici`, async () => assert.deepEqual(after.collections[name], before.collections[name]));
      await check(`${mode}-viste-preservate`, async () => assert.deepEqual(after.views, before.views));
    }
    for (const drop of [true, false]) await check(`gate-${drop ? 'drop' : 'merge'}-indice-locale`, async () => {
      const target = registry.target(drop ? 'gate_drop' : 'gate_merge');
      await fixture(target, false);
      const before = await snapshot(target); let applied = 0;
      tamper = async staging => {
        assert.equal(ownerOf(staging, [target]), target, 'La mutazione deve riguardare solo lo staging posseduto'); registry.assertOwned(target);
        if (mongo) await native.db(staging).collection('locale').dropIndex('ix_locale_personale');
        else await query(mysql ? `DROP INDEX ix_locale_personale ON ${table(staging, 'locale')}` : `DROP INDEX ${table(staging, 'ix_locale_personale')}`);
        applied++;
      };
      const phases = [], result = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir: backup.backupDir,
        targetDb: target, onlyCollections: ['scelta'], drop, connName: 'selettivo', recoveryRoot: path.join(reportDir, 'recovery'), log: silenzioso,
        onProgress: event => phases.push(event) });
      tamper = null;
      report.operazioni.push({ gate: true, drop, target, result, phases, applied });
      assert.equal(applied, 1, 'Il guasto deve essere applicato prima della fotografia verificata');
      assert.notEqual(result.status, 'completato', 'Il gate deve fermare lo staging alterato');
      assert(!phases.some(event => event.phase === 'promozione'), 'Nessuna promozione dopo la perdita di un indice locale');
      assert.deepEqual(await snapshot(target), before, 'L’originale deve restare intatto');
      assert(controls.get(drop), 'Il gemello positivo è ancora rosso: il rifiuto non dimostra sensibilità al guasto');
      assert(result.verification?.schemaDifferences?.some(item => JSON.stringify(item.missing).includes('ix_locale_personale')),
        'Il gate deve diagnosticare proprio l’indice locale mancante: ' + JSON.stringify(result.verification));
      return { originalePreservato: true, indiceMancanteRilevato: true };
    });
    await check('sorgente-intatta', async () => assert.deepEqual(await snapshot(source, ['scelta', 'ignorata']), sourceBefore));
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    restore.runRestore = originalRestore;
    if (native) {
      try {
        const owned = registry.targets();
        for (const name of await listDb()) { const owner = ownerOf(name, owned); if (owner) { registry.assertOwned(owner); await dropDb(name); } }
        await registry.cleanup(dropDb);
        assert.deepEqual((await listDb()).filter(name => owned.includes(name) || ownerOf(name, owned)), [], 'Nessun bersaglio della fixture deve rimanere');
        report.pulizia = 'completata';
      } catch (error) { report.errorePulizia = error.stack; }
      await (mongo ? native.close() : native.end()).catch(error => { report.erroreChiusura = error.message; });
    }
    if (strategy?.pool) await strategy.pool.end().catch(error => { report.erroreChiusura = error.message; });
    report.sorgentiStabili = Object.entries(report.sorgenti).every(([name, value]) => value === hash(fs.readFileSync(name)));
    report.ok = !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.sorgentiStabili && report.verifiche.length > 0 && report.verifiche.every(item => item.ok);
    report.terminato = new Date().toISOString();
    fs.writeFileSync(path.join(reportDir, 'backup-selettivo.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1'); fs.mkdirSync(reportDir, { recursive: true });
  const engines = ['postgresql', 'mysql', 'mongodb'].filter(type => !process.env.LAB_SELETTIVO_ENGINE || process.env.LAB_SELETTIVO_ENGINE === type);
  assert(engines.length, 'Nessun motore selezionato');
  const report = { suite: 'backup-selettivo', iniziato: new Date().toISOString(), risultati: [] };
  for (const type of engines) {
    const dir = path.join(reportDir, type); fs.mkdirSync(dir, { recursive: true });
    const log = fs.createWriteStream(path.join(dir, 'console.log'));
    const exitCode = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [__filename, '--worker', type], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_REPORT_DIR: dir } });
      proc.stdout.on('data', data => { log.write(data); process.stdout.write(data); });
      proc.stderr.on('data', data => { log.write(data); process.stderr.write(data); });
      proc.once('error', reject); proc.once('close', resolve);
    }).finally(() => new Promise(resolve => log.end(resolve)));
    const file = path.join(dir, 'backup-selettivo.json');
    report.risultati.push({ exitCode, report: file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ok: false, erroreFatale: 'Rapporto mancante' }) });
  }
  report.ok = report.risultati.every(item => item.ok && item.exitCode === 0);
  report.totali = { verifiche: report.risultati.reduce((sum, item) => sum + (item.verifiche || []).length, 0), fallite: report.risultati.reduce((sum, item) => sum + (item.verifiche || []).filter(test => !test.ok).length, 0) };
  report.terminato = new Date().toISOString();
  fs.writeFileSync(path.join(reportDir, 'backup-selettivo.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv[process.argv.indexOf('--worker') + 1]) : main()).catch(error => { console.error(error.stack); process.exitCode = 1; });
