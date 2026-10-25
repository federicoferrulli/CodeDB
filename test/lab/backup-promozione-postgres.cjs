'use strict';

// AUD014: promozione con vincoli immediati, overload e colonne locali.
// Gli oracoli leggono cataloghi e dati nativi, anche dopo il cleanup reale.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { runBackup } = require('../../backup/lib/engine');
const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
const { createImportArtifactAdapter } = require('../../db/importArtifactAdapter');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_pr_p' });
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-014/promozione-host');
const files = ['db/pg-routine-selezione.js', 'db/schema-merge.js', 'db/backupRestoreAdapter.js', 'db/importArtifactAdapter.js', 'db/importPlan.js', 'db/pg-restore-transaction.js', 'db/pg-promozione.js', 'db/pg-schema-compare.js', 'db/schemaObjects.js', 'db/pg-types.js',
  'backup/lib/engine.js', 'backup/lib/restore.js', 'backup/lib/schema-snapshot.js', 'test/lab/backup-promozione-postgres.cjs'];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../..', file))).digest('hex')]));
const report = { suite: 'backup-promozione-postgres', iniziato: new Date().toISOString(), verifiche: [], operazioni: [], sorgenti: hashes() };
const log = { info() {}, warn() {}, error() {} };
const q = name => '"' + name.replaceAll('"', '""') + '"';
const table = (db, name) => `${q(db)}.${q(name)}`;
let native, strategy;
const query = async (sql, params = []) => (await native.query(sql, params)).rows;
async function check(id, action) {
  try { const dettagli = await action(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${id}`); }
  catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message.split('\n')[0]}`); }
}
async function schema(label) {
  const name = registry.target(label); registry.assertOwned(name); await query(`CREATE SCHEMA ${q(name)}`); return name;
}
function technicalOwner(name, owned = registry.targets()) {
  const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
  return suffix && owned.find(base => name === base.slice(0, 63 - suffix.length) + suffix);
}
async function archive(db) {
  return runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'promozione-pg', db,
    type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: true, log });
}
async function restore(saved, targetDb, options = {}) {
  const result = await runRestoreViaPlan({ session: { strategy, dbType: 'postgresql' }, backupDir: saved.backupDir,
    targetDb, drop: true, connName: 'promozione-pg', recoveryRoot: path.join(reportDir, 'recupero'), log, ...options });
  report.operazioni.push({ targetDb, result }); return result;
}
async function cleanup(result, targetDb) {
  assert.notEqual(result.status, 'intervento_richiesto', 'Non pulire una destinazione con intervento richiesto');
  for (const name of [result.staging?.db, result.recovery?.physicalDb].filter(Boolean)) assert.equal(technicalOwner(name), targetDb);
  await createImportArtifactAdapter({ strategy, dbType: 'postgresql', connName: 'promozione-pg', recoveryRoot: path.join(reportDir, 'recupero'), log }).cleanup(result);
}
async function oid(db, name) { return (await query('SELECT $1::regclass::oid::text AS oid', [table(db, name)]))[0].oid; }

async function rollbackFinale() {
  const source = await schema('rollback_s'), target = await schema('rollback_t');
  for (const db of [source, target]) await query(`CREATE TABLE ${table(db, 'scelta')} (id INT PRIMARY KEY,valore INT NOT NULL)`);
  await query(`INSERT INTO ${table(source, 'scelta')} VALUES (1,100)`);
  await query(`INSERT INTO ${table(target, 'scelta')} VALUES (1,41)`);
  const beforeOid = await oid(target, 'scelta'), saved = await archive(source);
  const module = require('../../db/importPlan'), original = module.eseguiPianoImport;
  let observed = 0, result;
  module.eseguiPianoImport = (plan, options) => {
    const verify = options.adapter.verify.bind(options.adapter);
    options.adapter.verify = async (...args) => {
      const actual = await verify(...args);
      if (args[1] === 'destinazione') {
        assert.equal(actual.ok, true, 'Il guasto deve seguire una verifica finale realmente positiva'); observed++;
        return { ...actual, ok: false, missing: ['guasto-finale-controllato'] };
      }
      return actual;
    };
    return original(plan, options);
  };
  try { result = await restore(saved, target); }
  finally { module.eseguiPianoImport = original; }
  await check('rollback-finale/gate-raggiunto', async () => assert.equal(observed, 1));
  await check('rollback-finale/esito-recuperato', async () => {
    assert.equal(result.status, 'ripristinato_dopo_errore', result.error);
    assert.match(result.error, /guasto-finale-controllato/);
  });
  const unchanged = async () => {
    assert.equal(await oid(target, 'scelta'), beforeOid, 'Il rollback conserva la relazione originale');
    assert.deepEqual(await query(`SELECT * FROM ${table(target, 'scelta')}`), [{ id: 1, valore: 41 }]);
  };
  await check('rollback-finale/originale-intatto', unchanged);
  await cleanup(result, target);
  await check('rollback-finale/cleanup-preserva-originale', unchanged);
}

async function vincoli() {
  const source = await schema('vincoli_s'), target = await schema('vincoli_t'), outside = await schema('vincoli_e');
  for (const db of [source, target]) await query(`CREATE TABLE ${table(db, 'scelta')} (id INT PRIMARY KEY,codice TEXT UNIQUE NOT NULL,valore INT NOT NULL)`);
  await query(`INSERT INTO ${table(source, 'scelta')} VALUES (1,'B',100),(2,'A',200),(3,'C',300)`);
  await query(`INSERT INTO ${table(target, 'scelta')} VALUES (1,'A',-1),(2,'B',-2),(90,'Z',900)`);
  await query(`CREATE TABLE ${table(outside, 'figli')} (id INT PRIMARY KEY,padre INT NOT NULL,codice TEXT NOT NULL,
    CONSTRAINT fk_id FOREIGN KEY(padre) REFERENCES ${table(target, 'scelta')}(id) ON DELETE RESTRICT,
    CONSTRAINT fk_codice FOREIGN KEY(codice) REFERENCES ${table(target, 'scelta')}(codice) ON UPDATE RESTRICT)`);
  await query(`INSERT INTO ${table(outside, 'figli')} VALUES (10,1,'A')`);
  await query(`CREATE VIEW ${table(outside, 'vista')} AS SELECT id,codice,valore FROM ${table(target, 'scelta')}`);
  const beforeOid = await oid(target, 'scelta'), expected = await query(`SELECT * FROM ${table(source, 'scelta')} ORDER BY id`);
  await check('vincoli/fixture-immediata', async () => {
    const constraints = await query(`SELECT conname,condeferrable FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('f') ORDER BY conname`, [table(outside, 'figli')]);
    assert.equal(constraints.length, 2); assert(constraints.every(row => row.condeferrable === false));
    await query('BEGIN');
    try { await assert.rejects(query(`UPDATE ${table(target, 'scelta')} SET codice=CASE id WHEN 1 THEN 'B' ELSE 'A' END WHERE id IN (1,2)`), error => error.code === '23505'); }
    finally { await query('ROLLBACK'); }
  });
  const result = await restore(await archive(source), target);
  await check('vincoli/promozione-completa-scambio-unique', async () => {
    assert.equal(result.status, 'completato', result.error); assert.deepEqual(await query(`SELECT * FROM ${table(target, 'scelta')} ORDER BY id`), expected);
  });
  await check('vincoli/identita-relazione-preservata', async () => assert.equal(await oid(target, 'scelta'), beforeOid, '[PROMOZIONE-OID] preservare la relazione compatibile'));
  const external = async () => {
    assert.deepEqual(await query(`SELECT * FROM ${table(outside, 'vista')} ORDER BY id`), expected, '[PROMOZIONE-VISTA] la vista legge i dati attuali');
    assert.deepEqual(await query(`SELECT * FROM ${table(outside, 'figli')}`), [{ id: 10, padre: 1, codice: 'A' }]);
    const parents = await query(`SELECT confrelid::text AS oid FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f'`, [table(outside, 'figli')]);
    assert.equal(parents.length, 2); assert(parents.every(row => row.oid === beforeOid), '[PROMOZIONE-FK] entrambe le FK puntano alla relazione attuale');
    await query('BEGIN');
    try {
      await query(`INSERT INTO ${table(outside, 'figli')} VALUES (11,3,'C')`);
      await assert.rejects(query(`INSERT INTO ${table(outside, 'figli')} VALUES (12,999,'A')`), error => error.code === '23503');
    } finally { await query('ROLLBACK'); }
  };
  await check('vincoli/dipendenze-native', external);
  await cleanup(result, target);
  await check('vincoli/dipendenze-dopo-cleanup', external);
  await check('vincoli/unique-ancora-immediato', async () => {
    await query('BEGIN');
    try { await assert.rejects(query(`INSERT INTO ${table(target, 'scelta')} VALUES (50,'A',0)`), error => error.code === '23505'); }
    finally { await query('ROLLBACK'); }
  });
}

async function overload() {
  const source = await schema('overload_s'), target = await schema('overload_t'), outside = await schema('overload_e');
  for (const db of [source, target]) {
    await query(`CREATE TABLE ${table(db, 'dati')} (id INT PRIMARY KEY,valore INT)`);
    await query(`CREATE FUNCTION ${table(db, 'calcola')}(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT n*2$$`);
    await query(`CREATE FUNCTION ${table(db, 'calcola')}(n text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT upper(n)$$`);
  }
  await query(`INSERT INTO ${table(source, 'dati')} VALUES (1,100)`);
  await query(`INSERT INTO ${table(target, 'dati')} VALUES (1,-1)`);
  await query(`CREATE TABLE ${table(outside, 'firme')} (id INT PRIMARY KEY,funzione regprocedure)`);
  await query(`INSERT INTO ${table(outside, 'firme')} VALUES (1,$1::regprocedure),(2,$2::regprocedure)`, [`${table(target, 'calcola')}(integer)`, `${table(target, 'calcola')}(text)`]);
  const before = await query(`SELECT id,funzione::oid::text AS oid FROM ${table(outside, 'firme')} ORDER BY id`);
  let saved;
  await check('overload/backup-due-firme', async () => { saved = await archive(source); assert(saved.backupDir); });
  assert(saved, '[PROMOZIONE-OVERLOAD] archivio di entrambe le firme necessario');
  const result = await restore(saved, target);
  await check('overload/ripristino-completo', async () => {
    assert.equal(result.status, 'completato', result.error);
    assert.deepEqual(await query(`SELECT ${table(target, 'calcola')}(7) AS numero,${table(target, 'calcola')}('ciao'::text) AS testo`), [{ numero: 14, testo: 'CIAO' }]);
  });
  const references = async () => {
    const current = await query(`SELECT p.oid::text AS oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='calcola' ORDER BY p.oid`, [target]);
    assert.equal(current.length, 2); assert.deepEqual(current.map(row => row.oid).sort(), before.map(row => row.oid).sort(), '[PROMOZIONE-OVERLOAD] preservare entrambe le identità');
    assert.deepEqual(await query(`SELECT id,funzione::oid::text AS oid FROM ${table(outside, 'firme')} ORDER BY id`), before);
  };
  await check('overload/riferimenti-entrambe-firme', references);
  await cleanup(result, target); await check('overload/riferimenti-dopo-cleanup', references);

  // Una modifica della famiglia di overload non deve tenere la firma rimossa
  // soltanto perché ne sopravvive un'altra con lo stesso nome.
  const chainTarget = await schema('overload_catena');
  const initial = await restore(saved, chainTarget);
  assert.equal(initial.status, 'completato', initial.error); await cleanup(initial, chainTarget);
  await query(`DROP FUNCTION ${table(source, 'calcola')}(text)`);
  await query(`CREATE FUNCTION ${table(source, 'calcola')}(n bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$SELECT n*3$$`);
  const incremental = await runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'promozione-pg', db: source,
    type: 'incremental', destRoot: path.join(reportDir, 'archivi'), compress: true, log });
  const merged = await restore(incremental, chainTarget, { drop: false });
  await check('overload/catena-completata', async () => assert.equal(merged.status, 'completato', merged.error));
  const signatures = async () => {
    assert.deepEqual(await query(`SELECT oidvectortypes(p.proargtypes) AS argomenti FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname='calcola' ORDER BY argomenti`, [chainTarget]), [{ argomenti: 'bigint' }, { argomenti: 'integer' }],
    '[PROMOZIONE-FIRME] rimuovere soltanto la firma obsoleta e aggiungere quella nuova');
    assert.deepEqual(await query(`SELECT ${table(chainTarget, 'calcola')}(7::bigint)::text AS grande,${table(chainTarget, 'calcola')}(7::integer) AS piccolo`), [{ grande: '21', piccolo: 14 }]);
  };
  await check('overload/catena-firme-esatte', signatures);
  await cleanup(merged, chainTarget); await check('overload/catena-dopo-cleanup', signatures);
}

async function colonneLocali() {
  const source = await schema('colonne_s'), target = await schema('colonne_t');
  await query(`CREATE TABLE ${table(source, 'scelta')} (id INT PRIMARY KEY,valore INT NOT NULL)`);
  await query(`INSERT INTO ${table(source, 'scelta')} VALUES (1,100),(2,200)`);
  await query(`CREATE TABLE ${table(target, 'scelta')} (id INT PRIMARY KEY,valore INT NOT NULL,nota TEXT DEFAULT 'locale')`);
  await query(`INSERT INTO ${table(target, 'scelta')} VALUES (1,-1,'personale'),(90,900,'conservare')`);
  const beforeOid = await oid(target, 'scelta');
  const result = await restore(await archive(source), target, { drop: false, onlyCollections: ['scelta'] });
  await check('colonne-locali/merge-completato', async () => assert.equal(result.status, 'completato', result.error));
  const expected = [{ id: 1, valore: 100, nota: 'personale' }, { id: 2, valore: 200, nota: 'locale' }, { id: 90, valore: 900, nota: 'conservare' }];
  await check('colonne-locali/dati-e-default-preservati', async () => assert.deepEqual(await query(`SELECT * FROM ${table(target, 'scelta')} ORDER BY id`), expected));
  await check('colonne-locali/identita-preservata', async () => assert.equal(await oid(target, 'scelta'), beforeOid));
  await cleanup(result, target);
  await check('colonne-locali/dati-dopo-cleanup', async () => assert.deepEqual(await query(`SELECT * FROM ${table(target, 'scelta')} ORDER BY id`), expected));
}

async function riferimentiSelettivi() {
  const source = await schema('reg_s'), target = await schema('reg_t');
  for (const [db, factor] of [[source, 2], [target, 7]]) {
    await query(`CREATE FUNCTION ${table(db, 'aiuto_transitivo')}(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT n*${factor}$$`);
    for (const name of ['calcola', 'calcolo preciso', 'solo_array', 'solo_annidata', 'solo_precisa_annidata']) await query(`CREATE FUNCTION ${table(db, name)}(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT n*${factor}$$`);
    await query(`CREATE OR REPLACE FUNCTION ${table(db, 'calcola')}(n integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$BEGIN RETURN ${table(db, 'aiuto_transitivo')}(n); END$$`);
    await query(`CREATE TYPE ${table(db, 'pacchetto')} AS (funzione regproc, altre regproc[], precisa regprocedure)`);
    await query(`CREATE TABLE ${table(db, 'scelta')} (id INT PRIMARY KEY,semplice regproc,precisa regprocedure,lista regproc[],annidata ${table(db, 'pacchetto')})`);
    await query(`INSERT INTO ${table(db, 'scelta')} VALUES (1,'${table(db, 'calcola')}','${table(db, 'calcolo preciso')}(integer)',ARRAY['${table(db, 'solo_array')}'::regproc],ROW('${table(db, 'solo_annidata')}'::regproc,ARRAY['${table(db, 'solo_annidata')}'::regproc],'${table(db, 'solo_precisa_annidata')}(integer)'::regprocedure))`);
  }
  const beforeOid = await oid(target, 'scelta');
  const result = await restore(await archive(source), target, { onlyCollections: ['scelta'] });
  await check('reg-selettivo/esito', async () => assert.equal(result.status, 'completato', result.error));
  const verify = async () => {
    assert.deepEqual(await query(`SELECT ${table(target, 'solo_precisa_annidata')}(3) AS risultato`), [{ risultato: 6 }]);
    assert.deepEqual(await query(`SELECT ${table(target, 'calcola')}(3) AS semplice,${table(target, 'calcolo preciso')}(3) AS precisa,
      ${table(target, 'solo_array')}(3) AS lista,${table(target, 'solo_annidata')}(3) AS annidata`), [{ semplice: 6, precisa: 6, lista: 6, annidata: 6 }]);
    assert.deepEqual(await query(`SELECT semplice='${table(target, 'calcola')}'::regproc AS semplice,
      precisa='${table(target, 'calcolo preciso')}(integer)'::regprocedure AS precisa,
      lista[1]='${table(target, 'solo_array')}'::regproc AS lista,
      (annidata).funzione='${table(target, 'solo_annidata')}'::regproc AS annidata FROM ${table(target, 'scelta')}`),
    [{ semplice: true, precisa: true, lista: true, annidata: true }]);
  };
  await check('reg-selettivo/funzioni-e-riferimenti', verify);
  await check('reg-selettivo/identita', async () => assert.equal(await oid(target, 'scelta'), beforeOid));
  await cleanup(result, target); await check('reg-selettivo/dopo-cleanup', verify);
}

async function main() {
  fs.mkdirSync(reportDir, { recursive: true });
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
    native = new Client(config); await native.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool({ ...config, max: 3 });
    for (const [name, scenario] of [['rollback-finale', rollbackFinale], ['vincoli', vincoli], ['overload', overload], ['colonne-locali', colonneLocali], ['reg-selettivo', riferimentiSelettivi]]) await check(`${name}/scenario`, scenario);
  } catch (error) { report.fatale = error.stack; console.error(error.stack); }
  finally {
    if (native) try {
      const owned = registry.targets(), names = (await query('SELECT schema_name FROM information_schema.schemata')).map(row => row.schema_name);
      // Rimuove prima gli schemi esterni posseduti dalla fixture e poi quelli
      // tecnici derivati esattamente dai namespace registrati.
      for (const name of owned.filter(name => /(?:vincoli_e|overload_e)/.test(name))) await registry.drop(name, db => query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`));
      for (const name of names.filter(name => technicalOwner(name, owned))) { assert(technicalOwner(name, owned)); await query(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`); }
      await registry.cleanup(db => query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`));
      const remaining = (await query('SELECT schema_name FROM information_schema.schemata')).map(row => row.schema_name).filter(name => owned.includes(name) || technicalOwner(name, owned));
      assert.deepEqual(remaining, []); report.cleanup = { completato: true, residui: remaining };
    } catch (error) { report.cleanup = { completato: false, errore: error.message }; }
    try { if (strategy?.pool) await strategy.pool.end(); if (native) await native.end(); }
    catch (error) { report.erroreChiusura = error.message; }
    report.hashStabili = JSON.stringify(report.sorgenti) === JSON.stringify(hashes());
    report.fallimenti = report.verifiche.filter(item => !item.ok).map(item => item.id); report.finito = new Date().toISOString();
    report.ok = !report.fatale && !report.erroreChiusura && !report.fallimenti.length && report.hashStabili && report.cleanup?.completato === true;
    fs.writeFileSync(path.join(reportDir, 'backup-promozione-postgres.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ verifiche: report.verifiche.length, fallimenti: report.fallimenti, cleanup: report.cleanup, hashStabili: report.hashStabili }));
    if (!report.ok) process.exitCode = 1;
  }
}
main();
