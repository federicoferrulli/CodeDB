'use strict';

// AUD014: tipi compositi impliciti, routine e reg* fuori dallo schema promosso.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-riferimenti-esterni.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { runBackup } = require('../../backup/lib/engine');
const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
const { createImportArtifactAdapter } = require('../../db/importArtifactAdapter');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_re_p' });
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-014/riferimenti-host');
const report = { suite: 'backup-riferimenti-esterni', motore: 'postgresql', iniziato: new Date().toISOString(), verifiche: [], sorgenti: {} };
const hash = data => createHash('sha256').update(data).digest('hex');
const files = ['db/backupRestoreAdapter.js', 'db/importArtifactAdapter.js', 'db/pg-references.js', 'backup/lib/restore.js', 'test/lab/backup-riferimenti-esterni.cjs'];
for (const file of files) report.sorgenti[file] = hash(fs.readFileSync(path.resolve(__dirname, '../..', file)));
const q = name => '"' + name.replaceAll('"', '""') + '"';
const table = (db, name) => `${q(db)}.${q(name)}`;
const log = { info() {}, warn() {}, error() {} };
let native, strategy;
const query = async (sql, params = []) => (await native.query(sql, params)).rows;
const source = registry.target('origine'), target = registry.target('destinazione'), external = registry.target('esterno');
function technicalOwner(name, owned = registry.targets()) {
  const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
  return suffix && owned.find(base => name === base.slice(0, 63 - suffix.length) + suffix);
}
async function check(id, action) {
  try { const dettagli = await action(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${id}`); }
  catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message}`); }
}
async function references() {
  return query(`SELECT id,rel::oid::text AS relazione,tipo::oid::text AS tipo,funzione::oid::text AS funzione,
    rel::text AS "nomeRelazione",tipo::text AS "nomeTipo",funzione::text AS "nomeFunzione"
    FROM ${table(external, 'riferimenti')} ORDER BY id`);
}
async function snapshot() {
  return {
    targetRows: await query(`SELECT * FROM ${table(target, 'scelta')} ORDER BY id`),
    current: (await query(`SELECT $1::text::regclass::oid::text AS relazione,$1::text::regtype::oid::text AS tipo,$2::text::regprocedure::oid::text AS funzione`,
      [table(target, 'scelta'), `${table(target, 'f_base')}(integer)`]))[0],
    references: await references(),
    columns: await query(`SELECT a.attname AS nome,a.atttypid::text AS "tipoOid",format_type(a.atttypid,a.atttypmod) AS tipo
      FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [table(external, 'riferimenti')]),
    routines: await query(`SELECT p.proname AS nome,pg_get_function_identity_arguments(p.oid) AS firma,pg_get_functiondef(p.oid) AS ddl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 ORDER BY p.proname`, [external]),
  };
}
async function behavior() {
  assert.deepEqual(await query(`SELECT ${table(external, 'f_lettura')}() AS valore`), [{ valore: 100 }]);
  assert.deepEqual(await query(`SELECT ${table(external, 'f_composito')}(ROW(9,90)::${table(target, 'scelta')}) AS valore`), [{ valore: 90 }]);
}
async function main() {
  fs.mkdirSync(reportDir, { recursive: true });
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
    native = new Client(config); await native.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool({ ...config, max: 3 });
    for (const db of registry.targets()) { registry.assertOwned(db); await query(`CREATE SCHEMA ${q(db)}`); }
    for (const db of [source, target]) {
      await query(`CREATE TABLE ${table(db, 'scelta')} (id INT PRIMARY KEY,valore INT NOT NULL)`);
      await query(`CREATE FUNCTION ${table(db, 'f_base')}(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT n*2$$`);
    }
    await query(`INSERT INTO ${table(source, 'scelta')} VALUES (1,100),(2,200)`);
    await query(`INSERT INTO ${table(target, 'scelta')} VALUES (1,-1)`);
    await query(`CREATE MATERIALIZED VIEW ${table(target, 'materializzata')} AS SELECT id,valore FROM ${table(target, 'scelta')}`);
    await query(`CREATE VIEW ${table(external, 'via_materializzata')} AS SELECT * FROM ${table(target, 'materializzata')}`);
    const materializedOid = (await query('SELECT $1::regclass::oid::text AS oid', [table(target, 'materializzata')]))[0].oid;
    await query(`CREATE FUNCTION ${table(external, 'f_lettura')}() RETURNS integer LANGUAGE SQL BEGIN ATOMIC
      SELECT valore FROM ${table(target, 'scelta')} WHERE id=1; END`);
    await query(`CREATE FUNCTION ${table(external, 'f_composito')}(v ${table(target, 'scelta')}) RETURNS integer LANGUAGE SQL IMMUTABLE AS $$SELECT (v).valore$$`);
    await query(`CREATE TABLE ${table(external, 'riferimenti')} (id INT PRIMARY KEY,rel regclass,tipo regtype,funzione regprocedure,contenuto ${table(target, 'scelta')})`);
    await query(`INSERT INTO ${table(external, 'riferimenti')} VALUES (10,$1::text::regclass,$1::text::regtype,$2::text::regprocedure,ROW(1,-1)::${table(target, 'scelta')})`,
      [table(target, 'scelta'), `${table(target, 'f_base')}(integer)`]);
    report.before = await snapshot();
    await check('fixture-riferimenti-validi-prima', async () => {
      const { id, nomeRelazione, nomeTipo, nomeFunzione, ...refs } = report.before.references[0];
      assert.deepEqual(refs, report.before.current);
      assert.deepEqual(await query(`SELECT ${table(external, 'f_lettura')}() AS valore`), [{ valore: -1 }]);
      assert.deepEqual(await query(`SELECT ${table(external, 'f_composito')}(contenuto) AS valore FROM ${table(external, 'riferimenti')}`), [{ valore: -1 }]);
    });
    const archive = await runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'riferimenti-esterni', db: source,
      type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: true, log });
    report.result = await runRestoreViaPlan({ session: { strategy, dbType: 'postgresql' }, backupDir: archive.backupDir,
      targetDb: target, onlyCollections: ['scelta'], drop: true, connName: 'riferimenti-esterni', recoveryRoot: path.join(reportDir, 'recovery'), log });
    report.after = await snapshot();
    await check('ripristino-completato-con-dati-nuovi', async () => {
      assert.equal(report.result.status, 'completato', report.result.error);
      assert.deepEqual(report.after.targetRows, [{ id: 1, valore: 100 }, { id: 2, valore: 200 }]);
    });
    await check('routine-sql-legge-nuova-tabella', async () => assert.deepEqual(await query(`SELECT ${table(external, 'f_lettura')}() AS valore`), [{ valore: 100 }]));
    await check('routine-accetta-tipo-composito-attuale', async () => assert.deepEqual(await query(`SELECT ${table(external, 'f_composito')}(ROW(9,90)::${table(target, 'scelta')}) AS valore`), [{ valore: 90 }]));
    await check('colonna-composita-usa-tipo-attuale', async () => {
      assert.equal(report.after.columns.find(col => col.nome === 'contenuto')?.tipoOid, report.after.current.tipo);
      assert.deepEqual(await query(`SELECT (contenuto).id AS id,(contenuto).valore AS valore FROM ${table(external, 'riferimenti')}`), [{ id: 1, valore: -1 }]);
    });
    await check('valori-reg-riferiscono-oggetti-attuali', async () => {
      const { id, nomeRelazione, nomeTipo, nomeFunzione, ...refs } = report.after.references[0];
      assert.deepEqual(refs, report.after.current);
    });
    if (report.result.status !== 'intervento_richiesto' && report.result.staging) {
      for (const db of [report.result.staging.db, report.result.recovery?.physicalDb].filter(Boolean)) assert.equal(technicalOwner(db), target);
      await createImportArtifactAdapter({ strategy, dbType: 'postgresql', connName: 'riferimenti-esterni', recoveryRoot: path.join(reportDir, 'recovery'), log }).cleanup(report.result);
    }
    report.afterCleanup = await snapshot();
    await check('cleanup-preserva-routine-e-colonna-composita', async () => {
      assert.deepEqual(report.afterCleanup.routines.map(item => item.nome), report.before.routines.map(item => item.nome));
      assert.deepEqual(report.afterCleanup.columns.map(item => item.nome), report.before.columns.map(item => item.nome));
      await behavior();
      assert.equal((await query('SELECT $1::regclass::oid::text AS oid', [table(target, 'materializzata')]))[0].oid, materializedOid);
      assert.deepEqual(await query(`SELECT * FROM ${table(external, 'via_materializzata')} ORDER BY id`), [{ id: 1, valore: 100 }, { id: 2, valore: 200 }]);
    });
    await check('cleanup-non-lascia-reg-dangling', async () => {
      const refs = report.afterCleanup.references[0];
      const actual = (await query(`SELECT EXISTS(SELECT 1 FROM pg_class WHERE oid=$1::oid) AS relazione,
        EXISTS(SELECT 1 FROM pg_type WHERE oid=$2::oid) AS tipo,EXISTS(SELECT 1 FROM pg_proc WHERE oid=$3::oid) AS funzione`,
        [refs.relazione, refs.tipo, refs.funzione]))[0];
      assert.deepEqual(actual, { relazione: true, tipo: true, funzione: true });
    });
    await check('sorgente-inalterata', async () => assert.deepEqual(await query(`SELECT * FROM ${table(source, 'scelta')} ORDER BY id`), [{ id: 1, valore: 100 }, { id: 2, valore: 200 }]));
  } catch (error) { report.fatale = { errore: error.message, stack: error.stack }; console.error(error.stack); }
  finally {
    if (native) {
      try {
        const owned = registry.targets();
        await registry.drop(external, db => query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`));
        const names = (await query('SELECT schema_name FROM information_schema.schemata')).map(row => row.schema_name);
        for (const name of names.filter(name => technicalOwner(name, owned))) { assert(technicalOwner(name, owned)); await query(`DROP SCHEMA ${q(name)} CASCADE`); }
        await registry.cleanup(db => query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`));
        const remaining = (await query('SELECT schema_name FROM information_schema.schemata')).map(row => row.schema_name).filter(name => owned.includes(name) || technicalOwner(name, owned));
        assert.deepEqual(remaining, []); report.cleanup = { completato: true, residui: remaining };
      } catch (error) { report.cleanup = { completato: false, errore: error.message }; }
    }
    if (strategy?.pool) await strategy.pool.end(); if (native) await native.end();
    report.hashStabili = files.every(file => report.sorgenti[file] === hash(fs.readFileSync(path.resolve(__dirname, '../..', file))));
    report.finito = new Date().toISOString(); report.fallimenti = report.verifiche.filter(item => !item.ok).map(item => item.id);
    report.ok = !report.fatale && !report.fallimenti.length && report.hashStabili && report.cleanup?.completato === true;
    fs.writeFileSync(path.join(reportDir, 'backup-riferimenti-esterni.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ verifiche: report.verifiche.length, fallimenti: report.fallimenti, fatale: report.fatale, cleanup: report.cleanup, hashStabili: report.hashStabili }));
    process.exitCode = report.ok ? 0 : 1;
  }
}
main();
