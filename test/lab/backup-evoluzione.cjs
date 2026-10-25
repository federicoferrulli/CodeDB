'use strict';

// Cataloghi e dati esterni sono l'oracolo: non basta l'esito del piano.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { runBackup } = require('../../backup/lib/engine');
const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
const { createImportArtifactAdapter } = require('../../db/importArtifactAdapter');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_ev_p' });
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-014/evoluzione-host');
const report = { verifiche: [], iniziato: new Date().toISOString() };
const q = n => '"' + n.replaceAll('"', '""') + '"';
const t = (db, name) => `${q(db)}.${q(name)}`;
const log = { info() {}, warn() {}, error() {} };
let client, strategy;
const query = async (sql, params) => (await client.query(sql, params)).rows;
async function check(id, fn) {
  try { await fn(); report.verifiche.push({ id, ok: true }); console.log('OK ' + id); }
  catch (error) { report.verifiche.push({ id, ok: false, errore: error.message }); console.error('FAIL ' + id + ': ' + error.message); }
}
async function scenario(kind) {
  const source = registry.target(kind + '_s'), target = registry.target(kind + '_t'), external = registry.target(kind + '_e');
  for (const db of [source, target, external]) await query(`CREATE SCHEMA ${q(db)}`);
  await query(`CREATE TABLE ${t(target, 'dati')} (id integer PRIMARY KEY,valore integer NOT NULL${kind === 'rimozione' ? ',vecchia text' : ''})`);
  await query(`CREATE TABLE ${t(source, 'dati')} (id integer PRIMARY KEY,valore ${kind === 'tipo' ? 'bigint' : 'integer'} NOT NULL${kind === 'aggiunta' ? ',nota text DEFAULT \'nuova\'' : ''}${kind === 'vincolo' ? ',CHECK(valore>0)' : ''})`);
  await query(`INSERT INTO ${t(source, 'dati')}(id,valore) VALUES(1,100),(2,200)`);
  await query(`INSERT INTO ${t(target, 'dati')}(id,valore) VALUES(1,-1)`);
  await query(`CREATE TABLE ${t(external, 'riferimenti')}(rel regclass,tipo regtype)`);
  await query(`INSERT INTO ${t(external, 'riferimenti')} VALUES($1::text::regclass,$1::text::regtype)`, [t(target, 'dati')]);
  // La vista usa solo id: il cambio tipo di valore è compatibile.
  await query(`CREATE VIEW ${t(external, 'vista')} AS SELECT id FROM ${t(target, 'dati')}`);
  await query(`CREATE TABLE ${t(external, 'figli')}(padre integer REFERENCES ${t(target, 'dati')}(id))`);
  await query(`INSERT INTO ${t(external, 'figli')} VALUES(1)`);
  const before = await query(`SELECT rel::oid::text AS rel,tipo::oid::text AS tipo FROM ${t(external, 'riferimenti')}`);
  const saved = await runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'evoluzione', db: source,
    type: 'full', destRoot: path.join(dir, 'archivi'), compress: true, log });
  const result = await runRestoreViaPlan({ session: { strategy, dbType: 'postgresql' }, backupDir: saved.backupDir,
    targetDb: target, drop: true, connName: 'evoluzione', recoveryRoot: path.join(dir, 'recupero'), log });
  await check(kind + '/esito', async () => assert.equal(result.status, 'completato', result.error));
  await check(kind + '/dati', async () => assert.deepEqual(await query(`SELECT id,valore::text AS valore FROM ${t(target, 'dati')} ORDER BY id`), [{ id: 1, valore: '100' }, { id: 2, valore: '200' }]));
  await check(kind + '/schema', async () => {
    const rows = await query(`SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='dati' ORDER BY ordinal_position`, [target]);
    assert.deepEqual(rows.map(r => r.column_name), kind === 'aggiunta' ? ['id', 'valore', 'nota'] : ['id', 'valore']);
    assert.equal(rows[1].data_type, kind === 'tipo' ? 'bigint' : 'integer');
    if (kind === 'aggiunta') assert.equal(rows[2].column_default, "'nuova'::text");
    if (kind === 'vincolo') await assert.rejects(query(`INSERT INTO ${t(target, 'dati')} VALUES(3,-1)`), error => error.code === '23514');
  });
  if (result.status !== 'intervento_richiesto') await createImportArtifactAdapter({ strategy, dbType: 'postgresql', connName: 'evoluzione', recoveryRoot: path.join(dir, 'recupero'), log }).cleanup(result);
  await check(kind + '/riferimenti-dopo-cleanup', async () => {
    const now = await query('SELECT $1::text::regclass::oid::text AS rel,$1::text::regtype::oid::text AS tipo', [t(target, 'dati')]);
    assert.deepEqual(now, before);
    assert.deepEqual(await query(`SELECT * FROM ${t(external, 'vista')} ORDER BY id`), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(await query(`SELECT * FROM ${t(external, 'figli')}`), [{ padre: 1 }]);
  });
}
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
    client = new Client(config); await client.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool(config);
    if (process.argv.includes('--mutant')) require('../../db/pg-evoluzione').evolviTabella = async () => {};
    for (const kind of ['aggiunta', 'rimozione', 'tipo', 'vincolo']) await check(kind + '/scenario', () => scenario(kind));
  } catch (error) { report.fatale = error.stack; console.error(error.stack); }
  finally {
    if (client) try {
      const owned = registry.targets();
      for (const db of owned.filter(n => n.endsWith('_e'))) await registry.drop(db, n => query(`DROP SCHEMA IF EXISTS ${q(n)} CASCADE`));
      const names = (await query('SELECT nspname FROM pg_namespace')).map(r => r.nspname);
      for (const name of names) {
        const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
        if (suffix && owned.some(base => name === base.slice(0, 63 - suffix.length) + suffix)) await query(`DROP SCHEMA ${q(name)} CASCADE`);
      }
      await registry.cleanup(db => query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`)); report.cleanup = true;
    } catch (error) { report.cleanup = error.message; }
    await strategy?.pool.end(); await client?.end();
    report.ok = !report.fatale && report.cleanup === true && report.verifiche.every(r => r.ok);
    fs.writeFileSync(path.join(dir, 'backup-evoluzione.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
})();
