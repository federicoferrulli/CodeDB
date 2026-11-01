'use strict';

// AUD014: dipendenze PostgreSQL in uno schema esterno al bersaglio.
// Entrambi i namespace sono registrati e appartengono solo a questa fixture.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-selettivo-esterno.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { runBackup } = require('../../backup/lib/engine');
const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
const { createImportArtifactAdapter } = require('../../db/importArtifactAdapter');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-014/esterno-host');
const report = { suite: 'backup-selettivo-esterno', motore: 'postgresql', iniziato: new Date().toISOString(), verifiche: [], operazioni: [], sorgenti: {} };
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_se_p' });
const log = { info() {}, warn() {}, error() {} };
const hash = data => createHash('sha256').update(data).digest('hex');
const q = name => '"' + name.replaceAll('"', '""') + '"';
const table = (db, name) => `${q(db)}.${q(name)}`;
let native, strategy;
const query = async (sql, params = []) => (await native.query(sql, params)).rows;
const files = ['db/backupRestoreAdapter.js', 'db/importArtifactAdapter.js', 'db/importPlan.js', 'backup/lib/restore.js', 'test/lab/backup-selettivo-esterno.cjs'];
const root = path.resolve(__dirname, '../..');
for (const file of files) report.sorgenti[file] = hash(fs.readFileSync(path.join(root, file)));

async function check(id, action) {
  try { const dettagli = await action(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${id}`); }
  catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message}`); }
}
async function createSchema(label) {
  const db = registry.target(label); registry.assertOwned(db);
  await query(`CREATE SCHEMA ${q(db)}`); return db;
}
function technicalOwner(name, owned = registry.targets()) {
  const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
  return suffix && owned.find(base => name === base.slice(0, 63 - suffix.length) + suffix);
}
async function rows(db, name) { return query(`SELECT * FROM ${table(db, name)} ORDER BY id`); }
async function snapshot(target, external) {
  const targetRows = await rows(target, 'scelta');
  const externalTables = await query(`SELECT c.relname AS nome,c.relkind AS tipo,c.oid::text AS oid
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','v') ORDER BY c.relname`, [external]);
  const foreignKeys = await query(`SELECT k.conname AS nome,k.conrelid::text AS "figlioOid",k.confrelid::text AS "padreOid",
    pn.nspname AS "padreSchema",p.relname AS padre,pg_get_constraintdef(k.oid,true) AS ddl
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    WHERE n.nspname=$1 AND k.contype='f' ORDER BY c.relname,k.conname`, [external]);
  const viewDependencies = await query(`SELECT DISTINCT v.relname AS vista,t.oid::text AS oid,n.nspname AS schema,t.relname AS tabella
    FROM pg_rewrite r JOIN pg_class v ON v.oid=r.ev_class JOIN pg_namespace vn ON vn.oid=v.relnamespace
    JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid AND d.refclassid='pg_class'::regclass
    JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE vn.nspname=$1 AND v.relname='vista_esterna' AND t.oid<>v.oid ORDER BY n.nspname,t.relname`, [external]);
  const oid = (await query('SELECT to_regclass($1)::oid::text AS oid', [`${q(target)}.${q('scelta')}`]))[0].oid;
  return { targetRows, targetOid: oid, externalTables, foreignKeys, viewDependencies,
    children: await rows(external, 'figli'),
    view: externalTables.some(row => row.nome === 'vista_esterna') ? await rows(external, 'vista_esterna') : null };
}
async function assertFkAcceptsCurrentParent(external) {
  await query('BEGIN');
  try {
    await query(`INSERT INTO ${table(external, 'figli')} VALUES (99,2,'nuovo padre')`);
    await assert.rejects(query(`INSERT INTO ${table(external, 'figli')} VALUES (100,999,'orfano')`), error => error.code === '23503');
  } finally { await query('ROLLBACK'); }
}

async function main() {
  fs.mkdirSync(reportDir, { recursive: true });
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
    native = new Client(config); await native.connect();
    strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool({ ...config, max: 3 });
    const source = await createSchema('origine');
    await query(`CREATE TABLE ${table(source, 'scelta')} (id INT PRIMARY KEY,valore INT NOT NULL)`);
    await query(`INSERT INTO ${table(source, 'scelta')} VALUES (1,100),(2,200)`);
    const sourceBefore = await rows(source, 'scelta');
    const archive = await runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'selettivo-esterno',
      db: source, type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: true, log });
    const incompatible = await createSchema('origine_incompat');
    await query(`CREATE TABLE ${table(incompatible, 'scelta')} (id INT PRIMARY KEY,valore INT NOT NULL)`);
    await query(`INSERT INTO ${table(incompatible, 'scelta')} VALUES (2,200)`);
    const incompatibleArchive = await runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'selettivo-esterno',
      db: incompatible, type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: true, log });
    const scenarios = [
      { id: 'selettivo-drop', drop: true, selective: true },
      { id: 'selettivo-merge', drop: false, selective: true },
      { id: 'full-drop', drop: true, selective: false },
      { id: 'incompatibile', drop: true, selective: true, incompatible: true },
    ];
    for (const scenario of scenarios) {
      const target = await createSchema(scenario.id), external = await createSchema(scenario.id + '_est');
      await query(`CREATE TABLE ${table(target, 'scelta')} (id INT PRIMARY KEY,valore INT NOT NULL)`);
      await query(`INSERT INTO ${table(target, 'scelta')} VALUES (1,-1),(90,900)`);
      await query(`CREATE TABLE ${table(external, 'figli')} (id INT PRIMARY KEY,padre_id INT NOT NULL,nota TEXT,
        CONSTRAINT fk_esterna FOREIGN KEY(padre_id) REFERENCES ${table(target, 'scelta')}(id) ON DELETE RESTRICT)`);
      await query(`INSERT INTO ${table(external, 'figli')} VALUES (10,1,'preservare')`);
      await query(`CREATE VIEW ${table(external, 'vista_esterna')} AS SELECT id,valore*7 AS valore FROM ${table(target, 'scelta')}`);
      const before = await snapshot(target, external), phases = [];
      let result;
      try {
        result = await runRestoreViaPlan({ session: { strategy, dbType: 'postgresql' },
          backupDir: (scenario.incompatible ? incompatibleArchive : archive).backupDir,
          targetDb: target, onlyCollections: scenario.selective ? ['scelta'] : null, drop: scenario.drop,
          connName: 'selettivo-esterno', recoveryRoot: path.join(reportDir, 'recovery'), log, onProgress: event => phases.push(event) });
      } catch (error) { result = { status: 'eccezione', error: error.message, stack: error.stack }; }
      const after = await snapshot(target, external);
      const operation = { ...scenario, target, external, before, after, result, phases };
      report.operazioni.push(operation);
      if (scenario.incompatible) {
        await check('incompatibile-rifiutato-per-fk', async () => {
          assert.equal(result.status, 'ripristinato_dopo_errore', JSON.stringify(result));
          assert.match(result.error || '', /foreign key|chiav.*estern|fk_esterna|dipenden/i);
        });
        await check('incompatibile-originale-e-dipendenze-intatti', async () => assert.deepEqual(after, before));
      } else {
        await check(`${scenario.id}-esito`, async () => assert.equal(result.status, 'completato', result.error));
        await check(`${scenario.id}-dati-bersaglio`, async () => {
          const expected = [...sourceBefore]; if (!scenario.drop) expected.push({ id: 90, valore: 900 });
          assert.deepEqual(after.targetRows, expected);
        });
        await check(`${scenario.id}-vista-esterna-dati`, async () => assert.deepEqual(after.view, after.targetRows.map(row => ({ id: row.id, valore: row.valore * 7 }))));
        await check(`${scenario.id}-riferimenti-catalogo-al-bersaglio`, async () => {
          assert.equal(after.foreignKeys.length, 1);
          assert.equal(after.foreignKeys[0].padreSchema, target);
          assert.equal(after.foreignKeys[0].padreOid, after.targetOid);
          assert.deepEqual(after.viewDependencies, [{ vista: 'vista_esterna', oid: after.targetOid, schema: target, tabella: 'scelta' }]);
        });
        await check(`${scenario.id}-fk-accetta-nuovo-padre-rifiuta-orfano`, async () => assertFkAcceptsCurrentParent(external));
        await check(`${scenario.id}-figli-preservati`, async () => assert.deepEqual(after.children, before.children));
      }
      // Esercita il cleanup reale solo dopo avere verificato che ogni namespace
      // che puo essere rimosso appartiene a questa fixture. Gli unici dipendenti
      // della copia di recupero sono la vista/FK nello schema esterno registrato.
      if (result.status !== 'intervento_richiesto' && result.staging) {
        for (const db of [result.staging.db, result.recovery?.physicalDb].filter(Boolean)) assert.equal(technicalOwner(db), target);
        const cleanupAdapter = createImportArtifactAdapter({ strategy, dbType: 'postgresql', connName: 'selettivo-esterno', recoveryRoot: path.join(reportDir, 'recovery'), log });
        await cleanupAdapter.cleanup(result);
      }
      operation.afterCleanup = await snapshot(target, external);
      await check(`${scenario.id}-cleanup-preserva-vista-e-fk-esterne`, async () => {
        const names = values => values.map(({ nome, tipo }) => ({ nome, tipo }));
        assert.deepEqual(names(operation.afterCleanup.externalTables), names(before.externalTables));
        assert.equal(operation.afterCleanup.foreignKeys.length, 1);
        assert.equal(operation.afterCleanup.foreignKeys[0].padreOid, operation.afterCleanup.targetOid);
        assert.deepEqual(operation.afterCleanup.children, before.children);
        if (!scenario.incompatible) await assertFkAcceptsCurrentParent(external);
      });
    }
    await check('sorgenti-inalterate', async () => {
      assert.deepEqual(await rows(source, 'scelta'), sourceBefore);
      assert.deepEqual(await rows(incompatible, 'scelta'), [{ id: 2, valore: 200 }]);
    });
  } catch (error) { report.fatale = { errore: error.message, stack: error.stack }; console.error(error.stack); }
  finally {
    if (native) {
      try {
        const owned = registry.targets();
        // Prima gli schemi esterni registrati: nessun CASCADE puo uscire dal
        // perimetro della fixture, anche se il motore ha lasciato vecchi OID.
        for (const name of owned.filter(name => name.includes('_est_'))) await registry.drop(name, db => query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`));
        const names = (await query('SELECT schema_name FROM information_schema.schemata')).map(row => row.schema_name);
        for (const name of names.filter(name => technicalOwner(name, owned))) {
          assert(technicalOwner(name, owned)); await query(`DROP SCHEMA ${q(name)} CASCADE`);
        }
        await registry.cleanup(db => query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`));
        const remaining = (await query('SELECT schema_name FROM information_schema.schemata')).map(row => row.schema_name)
          .filter(name => owned.includes(name) || technicalOwner(name, owned));
        assert.deepEqual(remaining, []); report.cleanup = { completato: true, residui: remaining };
      } catch (error) { report.cleanup = { completato: false, errore: error.message }; }
    }
    if (strategy?.pool) await strategy.pool.end();
    if (native) await native.end();
    report.hashStabili = files.every(file => report.sorgenti[file] === hash(fs.readFileSync(path.join(root, file))));
    report.finito = new Date().toISOString();
    report.fallimenti = report.verifiche.filter(item => !item.ok).map(item => item.id);
    report.ok = !report.fatale && !report.fallimenti.length && report.hashStabili && report.cleanup?.completato === true;
    fs.writeFileSync(path.join(reportDir, 'backup-selettivo-esterno.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ verifiche: report.verifiche.length, fallimenti: report.fallimenti, fatale: report.fatale, cleanup: report.cleanup, hashStabili: report.hashStabili }));
    process.exitCode = report.ok ? 0 : 1;
  }
}
main();
