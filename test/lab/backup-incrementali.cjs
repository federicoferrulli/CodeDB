'use strict';

// Le modifiche sono provate dal contenuto nativo, anche quando le date restano ferme.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');
const { createE2eTargetRegistry } = require('../e2e-harness');
const mutant = process.env.LAB_INCREMENTALI_MUTANTE || null;
let mutationHits = 0;
if (mutant) {
  assert(process.argv.includes('--worker'), 'Il mutante si applica soltanto nel processo isolato');
  const state = require('../../backup/lib/content-state');
  if (mutant === 'digest-costante') state.hashRiga = () => { mutationHits++; return '0'.repeat(64); };
  else if (mutant === 'cancellazioni-omesse') {
    const original = state.creaDelta;
    state.creaDelta = (...args) => {
      const delta = original(...args);
      return { ...delta, conclude(...values) {
        const result = delta.conclude(...values);
        mutationHits += result.tombstones.length;
        return { ...result, tombstones: [] };
      } };
    };
  } else if (mutant === 'lo-selettivo-invariato') {
    const Module = require('node:module'), file = require.resolve('../../backup/lib/restore');
    const source = fs.readFileSync(file, 'utf8');
    const needle = 'async function restoreLayerPostgreSql({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, opts, explicitTarget, tracker }) {';
    assert.equal(source.split(needle).length, 2, 'Punto di mutazione LO univoco');
    const altered = new Module(file, module); altered.filename = file;
    altered.paths = Module._nodeModulePaths(path.dirname(file));
    altered.__rilevaMutazione = () => { mutationHits++; };
    require.cache[file] = altered;
    altered._compile(source.replace(needle, needle + '\nif (onlyCollections && opts.largeObjectReferences?.size) { module.__rilevaMutazione(); opts.largeObjectReferences.clear(); }'), file);
  } else throw new Error('Mutante incrementale sconosciuto: ' + mutant);
}
const { runBackup } = require('../../backup/lib/engine');
const { runRestore, resolveChain } = require('../../backup/lib/restore');
const { equivalenzaCatena } = require('../../backup/lib/tombstones');
const { verifyBackupDir, readManifest } = require('../../backup/lib/util');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-012/reali-host');
const log = { info() {}, warn() {}, error() {} };
const report = { suite: 'backup-incrementali', iniziato: new Date().toISOString(), verifiche: [], archivi: [] };
const sources = ['backup/lib/engine.js', 'backup/lib/restore.js', 'backup/lib/identity.js', 'backup/lib/content-state.js',
  'backup/lib/tombstones.js', 'db/pg-alias.js', 'db/pg-references.js', 'test/lab/backup-incrementali.cjs'];
report.sorgenti = Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../..', file))).digest('hex')]));
const specs = [
  { name: 'creazione', field: 'created_at' },
  { name: 'modifica', field: 'updated_at' },
  { name: 'alternativa', field: 'modified_at' },
  { name: 'senza_date', field: null },
];
async function check(id, action) {
  const start = Date.now();
  try { const dettagli = await action(); report.verifiche.push({ id, ok: true, ms: Date.now() - start, dettagli }); console.log(`OK ${id}`); }
  catch (error) { report.verifiche.push({ id, ok: false, ms: Date.now() - start, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message.split('\n')[0]}`); }
}
async function scenario(type) {
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'lab_inc' });
  const source = targets.target(type);
  const mongo = type === 'mongodb', mysql = type === 'mysql';
  const q = name => mysql ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"';
  const table = (db, name) => `${q(db)}.${q(name)}`;
  let native, strategy;
  const ownedLargeObjects = new Set();
  const query = async sql => mysql ? (await native.query(sql))[0] : (await native.query(sql)).rows;
  async function snapshot(db, spec) {
    if (mongo) return native.db(db).collection(spec.name).find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
    const date = spec.field ? `,${mysql ? `CAST(${q(spec.field)} AS CHAR)` : `${q(spec.field)}::text`} AS data` : '';
    return query(`SELECT id,valore,testo${date} FROM ${table(db, spec.name)} ORDER BY id`);
  }
  async function insert(spec, id, value) {
    if (mongo) return native.db(source).collection(spec.name).insertOne({ _id: id, id, valore: value, testo: `riga ${id}`, ...(spec.field ? { [spec.field]: new Date('2020-01-01T00:00:00Z') } : {}) });
    return query(`INSERT INTO ${table(source, spec.name)} (id,valore,testo${spec.field ? ',' + q(spec.field) : ''}) VALUES (${id},${value},'riga ${id}'${spec.field ? ",'2020-01-01 00:00:00'" : ''})`);
  }
  async function update(spec, id, value) {
    if (mongo) return native.db(source).collection(spec.name).updateOne({ _id: id }, { $set: { valore: value } });
    return query(`UPDATE ${table(source, spec.name)} SET valore=${value} WHERE id=${id}`);
  }
  async function remove(spec, id) {
    if (mongo) return native.db(source).collection(spec.name).deleteOne({ _id: id });
    return query(`DELETE FROM ${table(source, spec.name)} WHERE id=${id}`);
  }
  async function setDate(db, spec, id, date) {
    if (!spec.field) return;
    if (mongo) return native.db(db).collection(spec.name).updateOne({ _id: id }, { $set: { [spec.field]: date == null ? null : new Date(date) } });
    return query(`UPDATE ${table(db, spec.name)} SET ${q(spec.field)}=${date == null ? 'NULL' : "'" + date.replace('T', ' ').replace('Z', '') + "'"} WHERE id=${id}`);
  }
  async function createNamespace(db) {
    if (!mongo) await query(mysql ? `CREATE DATABASE ${q(db)}` : `CREATE SCHEMA ${q(db)}`);
  }
  try {
    if (mongo) {
      native = new (require('mongodb').MongoClient)(`mongodb://127.0.0.1:${Number(process.env.LAB_MONGO_PORT || 37017)}/?directConnection=true`);
      await native.connect(); strategy = new (require('../../db/MongoDbStrategy'))(); strategy.client = native;
    } else if (mysql) {
      const cfg = { host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), user: 'root', password: 'lab_mysql' };
      native = await require('mysql2/promise').createConnection(cfg);
      strategy = new (require('../../db/MySqlStrategy'))(); await strategy.connect({ ...cfg, username: cfg.user });
      await query(`CREATE DATABASE ${q(source)}`);
    } else {
      const cfg = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: 'lab_postgres', database: 'postgres' };
      native = new (require('pg').Client)(cfg); await native.connect();
      strategy = new (require('../../db/PostgreSqlStrategy'))(); await strategy.connect({ ...cfg, username: cfg.user });
      // Registra esclusivamente gli OID allocati dalle nostre operazioni: gli
      // oggetti grandi non appartengono a uno schema e DROP SCHEMA non li pulisce.
      const observed = new WeakSet();
      strategy.pool.on('acquire', client => {
        if (observed.has(client)) return;
        observed.add(client);
        const original = client.query;
        client.query = function (...queryArgs) {
          const result = original.apply(this, queryArgs);
          if (!/^SELECT lo_create\(0\) AS oid$/i.test(queryArgs[0])) return result;
          return result.then(value => {
            for (const row of value.rows) ownedLargeObjects.add(String(row.oid));
            return value;
          });
        };
      });
      await query(`CREATE SCHEMA ${q(source)}`);
    }
    for (const spec of specs) {
      if (mongo) await native.db(source).createCollection(spec.name);
      else await query(`CREATE TABLE ${table(source, spec.name)} (id INT PRIMARY KEY,valore INT NOT NULL,testo VARCHAR(80)${spec.field ? ',' + q(spec.field) + (mysql ? ' DATETIME(6)' : ' TIMESTAMP(6)') : ''})`);
      for (let id = 1; id <= 5; id++) await insert(spec, id, id * 10);
    }
    const session = { strategy, dbType: type };
    const args = { session, connName: 'incrementali', db: source, destRoot: path.join(reportDir, 'archivi'), compress: true, log };
    async function backup(kind, label, overrides = {}) {
      const result = await runBackup({ ...args, ...overrides, type: kind });
      const manifest = readManifest(result.backupDir);
      assert.equal((await verifyBackupDir(result.backupDir)).valid, true);
      report.archivi.push({ motore: type, label, percorso: result.backupDir, dati: manifest.files.filter(file => file.kind === 'data').map(({ collection, count, mode, sinceColumn }) => ({ collection, count, mode, sinceColumn })) });
      return result;
    }
    async function emptyDelta(result, label) {
      await check(`${type}/${label}/delta-vuoto`, async () => {
        const data = readManifest(result.backupDir).files.filter(file => file.kind === 'data');
        assert.equal(data.length, specs.length, '[INCREMENTALE-VUOTO] inventario completo anche senza righe cambiate');
        for (const file of data) assert.equal(file.count, 0,
          `[INCREMENTALE-VUOTO] ${file.collection}: nessuna riscrittura dei dati invariati`);
      });
    }
    async function restore(result, label) {
      const target = targets.target(label + '_' + type);
      await check(`${type}/${label}/ripristino`, () => runRestore({ session, backupDir: result.backupDir, targetDb: target, drop: true, log }));
      for (const spec of specs) await check(`${type}/${label}/${spec.name}`, async () => {
        const expected = await snapshot(source, spec), actual = await snapshot(target, spec);
        assert.deepEqual(actual, expected, `[INCREMENTALE-CONTENUTO] ${type}/${spec.name}: aggiornamenti e inserimenti retrodatati non devono sparire`);
        return { righe: actual.length };
      });
    }
    await restore(await backup('full', 'full'), 'full');
    const unchanged = await backup('incremental', 'i0-invariato');
    await emptyDelta(unchanged, 'i0-invariato');
    await restore(unchanged, 'i0-invariato');
    for (const spec of specs) { await update(spec, 1, 111); await remove(spec, 2); await insert(spec, 6, 60); }
    // Tre aggiornamenti distinti: data ferma, NULL e più vecchia di quella
    // precedente. Delete+insert mantiene il conteggio e impedisce falsi verdi.
    for (const spec of specs) {
      await update(spec, 3, 313); await setDate(source, spec, 3, null);
      await update(spec, 4, 414); await setDate(source, spec, 4, '1990-01-01T00:00:00Z');
    }
    await restore(await backup('incremental', 'i1'), 'i1');
    if (process.env.LAB_INCREMENTALI_FOCUS === 'i1') return;
    for (const spec of specs) { await update(spec, 1, 222); await update(spec, 3, 333); await remove(spec, 6); await insert(spec, 7, 70); }
    await restore(await backup('incremental', 'i2'), 'i2');
    await restore(await backup('differential', 'd2'), 'd2');
    for (const spec of specs) { await update(spec, 1, 333); await remove(spec, 4); await insert(spec, 8, 80); }
    await restore(await backup('incremental', 'i3'), 'i3');
    const unchangedFinal = await backup('incremental', 'i4-invariato');
    await emptyDelta(unchangedFinal, 'i4-invariato');
    await restore(unchangedFinal, 'i4-invariato');

    await check(`${type}/filtro-esplicito/preparazione`, async () => {
      const db = targets.target('filtro_' + type), spec = { name: 'eventi', field: 'updated_at' };
      await createNamespace(db);
      if (mongo) {
        await native.db(db).createCollection(spec.name);
        await native.db(db).collection(spec.name).insertMany([1, 2, 5].map(id => ({ _id: id, id, valore: id * 10, testo: `riga ${id}`, updated_at: new Date('2020-01-01T00:00:00Z') })));
      } else {
        await query(`CREATE TABLE ${table(db, spec.name)} (id INT PRIMARY KEY,valore INT NOT NULL,testo VARCHAR(80),updated_at ${mysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'})`);
        await query(`INSERT INTO ${table(db, spec.name)} VALUES (1,10,'riga 1','2020-01-01 00:00:00'),(2,20,'riga 2','2020-01-01 00:00:00'),(5,50,'riga 5','2020-01-01 00:00:00')`);
      }
      const options = { db, connName: 'filtro_esplicito' };
      await backup('full', 'filtro-full', options);
      const initial = await snapshot(db, spec);
      if (mongo) await native.db(db).collection(spec.name).updateMany({}, { $inc: { valore: 100 } });
      else await query(`UPDATE ${table(db, spec.name)} SET valore=valore+100`);
      await setDate(db, spec, 2, '2099-01-01T00:00:00Z');
      if (mongo) {
        await native.db(db).collection(spec.name).deleteOne({ _id: 5 });
        await native.db(db).collection(spec.name).insertMany([3, 4].map(id => ({ _id: id, id, valore: id * 10, testo: `riga ${id}`,
          updated_at: new Date(id === 3 ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z') })));
      } else {
        await query(`DELETE FROM ${table(db, spec.name)} WHERE id=5`);
        await query(`INSERT INTO ${table(db, spec.name)} VALUES (3,30,'riga 3','2020-01-01 00:00:00'),(4,40,'riga 4','2099-01-01 00:00:00')`);
      }
      const current = await snapshot(db, spec);
      // Oracolo indipendente: riga 1 della base, modifica 2 e inserimento 4
      // selezionati; inserimento 3 escluso dalla data e cancellazione 5 applicata.
      const expected = [initial.find(row => row.id === 1), current.find(row => row.id === 2), current.find(row => row.id === 4)];
      const inc = await backup('incremental', 'filtro-incrementale', { ...options, sinceField: spec.field });
      await check(`${type}/filtro-esplicito/selezione`, async () => {
        const data = readManifest(inc.backupDir).files.filter(file => file.kind === 'data');
        assert.equal(data.length, 1); assert.equal(data[0].count, 2, '[INCREMENTALE-FILTRO] il campo esplicito conserva il filtro richiesto');
        assert.equal(data[0].sourceCardinality, current.length, '[INCREMENTALE-FILTRO] cardinalità sorgente reale, distinta dal risultato selezionato');
        assert.notEqual(expected.length, current.length, '[INCREMENTALE-FILTRO] il caso prova anche inserimenti esclusi dal filtro');
        assert.equal(data[0].sinceColumn, spec.field);
      });
      await check(`${type}/filtro-esplicito/dichiarazione`, async () => {
        const equivalence = equivalenzaCatena(resolveChain(inc.backupDir));
        assert.equal(equivalence.completa, false, '[INCREMENTALE-FILTRO-EQUIVALENZA] un filtro temporale esplicito non prova equivalenza completa');
        assert.ok(equivalence.motivo, '[INCREMENTALE-FILTRO-EQUIVALENZA] limite spiegato al chiamante');
      });
      const target = targets.target('filtro_ripristino_' + type);
      let outcome;
      await check(`${type}/filtro-esplicito/ripristino`, async () => {
        outcome = await runRestore({ session, backupDir: inc.backupDir, targetDb: target, drop: true, log });
        assert.deepEqual(await snapshot(target, spec), expected, '[INCREMENTALE-FILTRO] conserva il risultato selezionato senza inventare aggiornamenti fuori filtro');
        assert.notDeepEqual(expected, current, '[INCREMENTALE-FILTRO] la fixture distingue il filtro dalla snapshot completa');
      });
      await check(`${type}/filtro-esplicito/esito-pubblico`, async () => {
        assert.ok(outcome, '[INCREMENTALE-FILTRO-EQUIVALENZA] ripristino riuscito disponibile');
        assert.equal(outcome.equivalenzaDati?.completa, false, '[INCREMENTALE-FILTRO-EQUIVALENZA] esito pubblico dichiara il limite');
      });
    });

    if (!mongo) await check(`${type}/senza-identita/preparazione`, async () => {
      const db = targets.target('senza_pk_' + type), name = 'duplicati';
      await createNamespace(db);
      await query(`CREATE TABLE ${table(db, name)} (categoria VARCHAR(40),valore INT,updated_at ${mysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'})`);
      await query(`INSERT INTO ${table(db, name)} VALUES ('uguale',1,NULL),('uguale',1,NULL),('vecchia',2,'2020-01-01 00:00:00')`);
      const options = { db, connName: 'senza_identita' };
      await backup('full', 'senza-pk-full', options);
      // La duplicazione non è un'identità inventata: deve restare tale.
      await query(`UPDATE ${table(db, name)} SET valore=3 WHERE categoria='uguale'`);
      await query(`DELETE FROM ${table(db, name)} WHERE categoria='vecchia'`);
      await query(`INSERT INTO ${table(db, name)} VALUES ('nuova',4,'1990-01-01 00:00:00')`);
      for (const kind of ['incremental', 'differential']) await check(`${type}/senza-identita/${kind}`, async () => {
        const result = await backup(kind, 'senza-pk-' + kind, options);
        const target = targets.target('senza_pk_' + kind + '_' + type);
        await runRestore({ session, backupDir: result.backupDir, targetDb: target, drop: true, log });
        const rows = namespace => query(`SELECT categoria,valore,${mysql ? 'CAST(updated_at AS CHAR)' : 'updated_at::text'} AS data FROM ${table(namespace, name)} ORDER BY categoria,valore`);
        const expected = await rows(db), actual = await rows(target);
        assert.deepEqual(actual, expected, '[INCREMENTALE-SENZA-PK] snapshot sostitutiva conserva duplicati e rimuove righe obsolete');
        assert.equal(actual.filter(row => row.categoria === 'uguale' && row.valore === 3).length, 2);
        const data = readManifest(result.backupDir).files.find(file => file.kind === 'data' && file.collection === name);
        assert.equal(data.count, expected.length, '[INCREMENTALE-SENZA-PK] senza identità stabile il fallback salva tutti i dati');
      });
    });

    if (!mongo && !mysql) await check(`${type}/riferimenti/preparazione`, async () => {
      const db = targets.target('riferimenti_' + type), name = 'funzioni';
      await createNamespace(db);
      await query(`CREATE TABLE ${table(db, name)} (id INT PRIMARY KEY,riferimenti REGPROC[],updated_at TIMESTAMP(6))`);
      await query(`INSERT INTO ${table(db, name)} VALUES (1,ARRAY['abs(integer)'::regprocedure::oid::regproc,'abs(bigint)'::regprocedure::oid::regproc],'2020-01-01 00:00:00')`);
      const options = { db, connName: 'riferimenti_immutati' };
      await backup('full', 'riferimenti-full', options);
      const same = await backup('incremental', 'riferimenti-invariati', options);
      await check(`${type}/riferimenti/delta-vuoto`, async () => {
        const data = readManifest(same.backupDir).files.find(file => file.kind === 'data');
        assert.equal(data.count, 0, '[INCREMENTALE-RIFERIMENTI] marker di trasporto casuali non sono modifiche ai dati');
      });
      await query(`UPDATE ${table(db, name)} SET riferimenti=ARRAY['lower(text)'::regprocedure::oid::regproc,'upper(text)'::regprocedure::oid::regproc] WHERE id=1`);
      const changed = await backup('incremental', 'riferimenti-modificati', options);
      await check(`${type}/riferimenti/contenuto`, async () => {
        const target = targets.target('riferimenti_ripristino');
        await runRestore({ session, backupDir: changed.backupDir, targetDb: target, drop: true, log });
        const rows = namespace => query(`SELECT id,riferimenti::oid[]::regprocedure[]::text AS funzioni FROM ${table(namespace, name)} ORDER BY id`);
        assert.deepEqual(await rows(target), await rows(db), '[INCREMENTALE-RIFERIMENTI] confronto e restore preservano firme/ordine dei riferimenti non-PK');
      });
    });
    if (!mongo && !mysql) await check(`${type}/large-object/preparazione`, async () => {
      const db = targets.target('large_object'), name = 'allegati';
      await createNamespace(db);
      const oid = String((await native.query('SELECT lo_from_bytea(0,$1::bytea) AS oid', [Buffer.from('prima versione lunga')])).rows[0].oid);
      ownedLargeObjects.add(oid);
      await query(`CREATE TABLE ${table(db, name)} (id INT PRIMARY KEY,contenuto OID,copie OID[],updated_at TIMESTAMP(6))`);
      await native.query(`INSERT INTO ${table(db, name)} VALUES (1,$1::oid,ARRAY[$1::oid,$1::oid],'2020-01-01 00:00:00')`, [oid]);
      const options = { db, connName: 'oggetti_grandi' };
      const full = await backup('full', 'large-object-full', options);
      const values = namespace => query(`SELECT id,encode(lo_get(contenuto),'hex') AS contenuto,
        encode(lo_get(copie[1]),'hex') AS copia1,encode(lo_get(copie[2]),'hex') AS copia2,
        contenuto=copie[1] AND copie[1]=copie[2] AS condiviso FROM ${table(namespace, name)} ORDER BY id`);
      await check(`${type}/large-object/controllo-full`, async () => {
        const target = targets.target('large_object_full');
        await runRestore({ session, backupDir: full.backupDir, targetDb: target, drop: true, log });
        assert.deepEqual(await values(target), await values(db));
      });
      for (const [kind, contents] of [['incremental', 'seconda versione'], ['differential', 'breve'], ['incremental', '']]) {
        const bytes = Buffer.from(contents), label = `${kind}-${bytes.length}`;
        // Cambia solo il contenuto esterno alla riga, preservando OID e date.
        await native.query('BEGIN');
        try {
          const fd = (await native.query('SELECT lo_open($1::oid,131072) AS fd', [oid])).rows[0].fd;
          await native.query('SELECT lo_truncate64($1,0)', [fd]);
          await native.query('SELECT lo_close($1)', [fd]);
          await native.query('SELECT lo_put($1::oid,0,$2::bytea)', [oid, bytes]);
          await native.query('COMMIT');
        } catch (error) { await native.query('ROLLBACK'); throw error; }
        const result = await backup(kind, 'large-object-' + label, options);
        await check(`${type}/large-object/${label}/archivio`, async () => {
          const manifest = readManifest(result.backupDir), objects = manifest.files.filter(file => file.kind === 'large-object');
          assert.equal(manifest.files.find(file => file.kind === 'data').count, 0,
            '[INCREMENTALE-LO-RIGA] non riscrivere una riga invariata per salvare il contenuto esterno');
          assert.equal(objects.length, 1, '[INCREMENTALE-LO] acquisire anche i riferimenti delle righe invariate');
          assert.equal(objects[0].oid, oid); assert.equal(objects[0].size, bytes.length);
          assert.equal(objects[0].sha256, createHash('sha256').update(bytes).digest('hex'), '[INCREMENTALE-LO] byte aggiornati, inclusi troncamento e contenuto vuoto');
        });
        await check(`${type}/large-object/${label}/contenuto`, async () => {
          const target = targets.target('lo_' + kind + '_' + bytes.length);
          await runRestore({ session, backupDir: result.backupDir, targetDb: target, drop: true, log });
          assert.deepEqual(await values(target), await values(db), '[INCREMENTALE-LO] contenuto corrente e condivisione dei riferimenti preservati');
        });
        await check(`${type}/large-object/${label}/selettivo`, async () => {
          const target = targets.target('sel_' + kind + '_' + bytes.length);
          await runRestore({ session, backupDir: result.backupDir, targetDb: target, drop: true, onlyCollections: [name], log });
          assert.deepEqual(await values(target), await values(db), '[INCREMENTALE-LO-SELETTIVO] aggiornare i byte anche se il layer non emette righe della tabella selezionata');
        });
      }
    });
  } finally {
    try {
      if (native) await check(`${type}/pulizia`, async () => {
        const owned = targets.targets();
        await targets.cleanup(db => mongo ? native.db(db).dropDatabase() : query(mysql ? `DROP DATABASE IF EXISTS ${q(db)}` : `DROP SCHEMA IF EXISTS ${q(db)} CASCADE`));
        if (!mongo && !mysql && ownedLargeObjects.size) {
          const ids = [...ownedLargeObjects];
          await native.query('SELECT lo_unlink(oid) FROM pg_largeobject_metadata WHERE oid=ANY($1::oid[])', [ids]);
          assert.deepEqual((await native.query('SELECT oid FROM pg_largeobject_metadata WHERE oid=ANY($1::oid[])', [ids])).rows, [],
            '[INCREMENTALE-PULIZIA] nessun Large Object allocato dalla fixture deve restare');
        }
        const existing = mongo ? (await native.db('admin').admin().listDatabases()).databases.map(db => db.name)
          : (await query('SELECT schema_name AS name FROM information_schema.schemata')).map(db => db.name);
        const remaining = owned.filter(name => existing.includes(name));
        (report.pulizia ||= []).push({ motore: type, bersagli: owned, residui: remaining });
        assert.deepEqual(remaining, [], '[INCREMENTALE-PULIZIA] tutte le fixture possedute devono essere rimosse');
      });
    } finally {
      const closingError = error => (report.erroriChiusura ||= []).push({ motore: type, errore: error.message });
      await strategy?.disconnect().catch(closingError);
      if (native) await (mongo ? native.close() : native.end()).catch(closingError);
    }
  }
}
async function worker() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1'); fs.mkdirSync(reportDir, { recursive: true });
  for (const type of ['mysql', 'postgresql', 'mongodb']) {
    if (process.env.LAB_INCREMENTALI_MOTORE && process.env.LAB_INCREMENTALI_MOTORE !== type) continue;
    await check(`${type}/campagna`, () => scenario(type));
  }
  report.mutante = mutant; report.mutazioni = mutationHits;
  report.sorgentiStabili = sources.every(file => report.sorgenti[file] === createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../..', file))).digest('hex'));
  report.ok = report.sorgentiStabili && !report.erroriChiusura?.length && report.verifiche.length > 0 && report.verifiche.every(item => item.ok);
  report.terminato = new Date().toISOString(); fs.writeFileSync(path.join(reportDir, 'backup-incrementali.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

async function child(type, name = null) {
  const dir = path.join(reportDir, name ? `${type}-${name}` : 'controllo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-incrementali.json'); fs.rmSync(file, { force: true });
  const log = fs.createWriteStream(path.join(dir, 'esecuzione.log'));
  const env = { ...process.env, LAB_REPORT_DIR: dir };
  delete env.LAB_INCREMENTALI_MUTANTE; delete env.LAB_INCREMENTALI_FOCUS;
  if (type) env.LAB_INCREMENTALI_MOTORE = type;
  if (name) {
    env.LAB_INCREMENTALI_MUTANTE = name;
    if (name !== 'lo-selettivo-invariato') env.LAB_INCREMENTALI_FOCUS = 'i1';
  }
  const proc = spawn(process.execPath, [__filename, '--worker'], { windowsHide: true,
    cwd: path.resolve(__dirname, '../..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  inoltraOutputFiglio(proc, { log, mutante: name ? `${type}/${name}` : null });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 180000);
  let code;
  try { code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); }); }
  finally { clearTimeout(timer); await new Promise(resolve => log.end(resolve)); }
  return { code, timedOut, report: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

async function sensitivity() {
  fs.mkdirSync(reportDir, { recursive: true });
  const base = await child(process.env.LAB_INCREMENTALI_MOTORE || null), mutants = [];
  if (base.code === 0 && base.report?.ok) for (const type of ['mysql', 'postgresql', 'mongodb']) {
    if (process.env.LAB_INCREMENTALI_MOTORE && process.env.LAB_INCREMENTALI_MOTORE !== type) continue;
    for (const name of ['digest-costante', 'cancellazioni-omesse', ...(type === 'postgresql' ? ['lo-selettivo-invariato'] : [])]) {
      const result = await child(type, name), checks = result.report?.verifiche || [], failures = checks.filter(item => !item.ok);
      const expected = name === 'lo-selettivo-invariato'
        ? ['incremental-16', 'differential-5', 'incremental-0'].map(label => `${type}/large-object/${label}/selettivo`)
        : specs.map(spec => `${type}/i1/${spec.name}`);
      if (name === 'cancellazioni-omesse') expected.push(`${type}/i1/ripristino`);
      const detected = result.code === 1 && !result.timedOut && result.report?.sorgentiStabili === true
        && result.report?.mutazioni > 0 && !result.report?.erroriChiusura?.length
        && result.report?.pulizia?.length === 1 && result.report.pulizia.every(item => item.residui.length === 0)
        && JSON.stringify(failures.map(item => item.id).sort()) === JSON.stringify(expected.sort())
        && failures.every(item => name === 'lo-selettivo-invariato' ? item.errore.includes('[INCREMENTALE-LO-SELETTIVO]')
          : item.id.endsWith('/ripristino') ? /cardinalit[àa]/i.test(item.errore) : item.errore.includes('[INCREMENTALE-CONTENUTO]'))
        && expected.every(id => base.report.verifiche.some(item => item.id === id && item.ok));
      mutants.push({ motore: type, mutante: name, rilevata: detected, risultato: result });
      console.log(`${detected ? 'OK' : 'FAIL'} sensibilità incrementali ${type}/${name}`);
    }
  }
  const summary = { suite: 'backup-incrementali', controllo: base, sensibilita: mutants,
    ok: base.code === 0 && !base.timedOut && base.report?.ok && mutants.length > 0 && mutants.every(item => item.rilevata) };
  fs.writeFileSync(path.join(reportDir, 'backup-incrementali.json'), JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

(process.argv.includes('--sensitivity') ? sensitivity() : worker())
  .catch(error => { console.error(error); process.exitCode = 1; });
