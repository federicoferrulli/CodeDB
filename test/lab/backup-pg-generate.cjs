'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// DDL, dati e vincoli delle colonne calcolate: il catalogo nativo è l'oracolo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { createE2eTargetRegistry } = require('../e2e-harness');
const pgDdl = require('../../db/pg-ddl');
let mutationHits = 0;
function senzaGenerazione(original) {
  const changed = original.replace(/ GENERATED ALWAYS AS \([^\n]*\) (?:STORED|VIRTUAL)/g, '');
  assert.notEqual(original, changed, 'Il mutante deve rimuovere la generazione');
  mutationHits++;
  return changed;
}
// Il backup e l'export leggono il catalogo nella propria snapshot. La mutazione
// precede i require dei chiamanti, senza sostituire dati o risultati dei test.
if (process.argv.includes('--mutant-backup')) {
  const createTable = pgDdl.pgCreateTable;
  pgDdl.pgCreateTable = async (...args) => senzaGenerazione(await createTable(...args));
}
const Strategy = require('../../db/PostgreSqlStrategy');
const { runBackup } = require('../../backup/lib/engine');
const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
const { leggiCatalogoExport } = require('../../db/exportCatalogo');
const { creaPianoExport } = require('../../db/exportPlan');
const { esportaDatabase } = require('../../db/databaseExport');
const { creaPianoImport, eseguiPianoImport } = require('../../db/importPlan');
const { createImportArtifactAdapter } = require('../../db/importArtifactAdapter');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-008/reali-host');
const log = { info() {}, warn() {}, error() {} };
const q = name => '"' + name.replaceAll('"', '""') + '"';
const generation = process.env.LAB_PG_GENERATION || 'STORED';
assert(['STORED', 'VIRTUAL'].includes(generation));
const connection = { host: process.env.LAB_PG_HOST || '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432),
  user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'lab_pg_gen' });
const source = targets.target('origine');
const report = { suite: 'backup-pg-generate', generazione: generation, iniziato: new Date().toISOString(), verifiche: [], operazioni: [], mutazioni: 0 };
report.sorgenti = Object.fromEntries(['db/PostgreSqlStrategy.js', 'db/sqlMetadati.js', 'db/pg-ddl.js', 'db/backupRestoreAdapter.js', 'test/lab/backup-pg-generate.cjs']
  .map(file => [file, createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../..', file))).digest('hex')]));
const native = new Client(connection);
const strategy = new Strategy();
const table = db => `${q(db)}.${q('Misure')}`;
async function check(id, action) {
  try { await action(); report.verifiche.push({ id, ok: true }); console.log(`OK ${id}`); }
  catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message}`); }
}
async function snapshot(db) {
  const columns = (await native.query(`SELECT column_name, data_type, is_nullable, is_generated, generation_expression, collation_name,
      a.attgenerated AS generation_kind FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname=c.table_schema JOIN pg_class t ON t.relnamespace=n.oid AND t.relname=c.table_name
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname=c.column_name
    WHERE table_schema=$1 AND table_name='Misure' ORDER BY ordinal_position`, [db])).rows;
  const rows = (await native.query(`SELECT id, base::text, "Calcolato"::text, testo, etichetta FROM ${table(db)} ORDER BY id`)).rows;
  return { columns, rows };
}
async function behavior(db) {
  await native.query(`INSERT INTO ${table(db)}(id,base,testo) VALUES (90,7.25,'città')`);
  assert.deepEqual((await native.query(`SELECT "Calcolato"::text AS valore,etichetta FROM ${table(db)} WHERE id=90`)).rows,
    [{ valore: '14.50', etichetta: "città / 'quoted'" }]);
  await assert.rejects(native.query(`UPDATE ${table(db)} SET "Calcolato"=1 WHERE id=90`), error => error.code === '428C9');
  await assert.rejects(native.query(`INSERT INTO ${table(db)}(id,base,testo) VALUES (91,NULL,'x')`), error => error.code === '23502');
  await native.query(`DELETE FROM ${table(db)} WHERE id=90`);
}
async function worker() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1'); fs.mkdirSync(dir, { recursive: true });
  try {
    await native.connect();
    report.versioneServer = (await native.query('SHOW server_version_num')).rows[0].server_version_num;
    if (generation === 'VIRTUAL') assert(Number(report.versioneServer) >= 180000, 'Le colonne virtuali richiedono PostgreSQL 18');
    await strategy.connect({ ...connection, username: connection.user });
    if (process.argv.includes('--mutant')) {
      const ddl = strategy.tableDdl.bind(strategy);
      strategy.tableDdl = async (...args) => senzaGenerazione(await ddl(...args));
    }
    await native.query(`CREATE SCHEMA ${q(source)}`);
    await native.query(`CREATE TABLE ${table(source)} (
      id integer PRIMARY KEY, base numeric(10,2),
      "Calcolato" numeric(11,2) GENERATED ALWAYS AS (base * 2) ${generation} NOT NULL,
      testo text, etichetta text COLLATE "C" GENERATED ALWAYS AS (testo || ' / ''quoted''') ${generation}
    )`);
    await native.query(`INSERT INTO ${table(source)}(id,base,testo) VALUES (1,12.34,'iniziale')`);
    const expected = await snapshot(source);
    await check('metadati-espressione', async () => {
      const fields = await strategy.tableFields(source, 'Misure');
      for (const column of expected.columns.filter(item => item.is_generated === 'ALWAYS')) {
        const field = fields.find(item => item.name === column.column_name);
        assert.equal(field.generated, true);
        assert.equal(field.generationExpression, column.generation_expression, '[PG-GENERATA-METADATI] espressione del catalogo');
        assert.equal(field.generationKind, generation, '[PG-GENERATA-METADATI] modalità di calcolo del catalogo');
      }
    });
    await check('ddl-generazione', async () => {
      const ddl = await strategy.tableDdl(source, 'Misure');
      assert.match(ddl, new RegExp('"Calcolato"[^\\n]+GENERATED ALWAYS AS[^\\n]+' + generation + '[^\\n]+NOT NULL'), '[PG-GENERATA-DDL] generazione e nullabilità');
      assert.match(ddl, /etichetta[^\n]+COLLATE "C"[^\n]+GENERATED ALWAYS AS/, '[PG-GENERATA-DDL] collation della colonna generata');
    });
    const backup = await runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'generate', db: source,
      type: 'full', destRoot: path.join(dir, 'archivi'), compress: true, log });
    await check('backup-definizione', async () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(backup.backupDir, 'manifest.json'), 'utf8'));
      const data = manifest.files.find(file => file.kind === 'data' && file.collection === 'Misure');
      assert.deepEqual(data.columns, ['id', 'base', 'testo'], '[PG-GENERATA-COLONNE] si salvano solo le colonne scrivibili');
      const schema = manifest.files.find(file => file.kind === 'schema' && file.collection === 'Misure');
      const ddl = fs.readFileSync(path.join(backup.backupDir, schema.path), 'utf8');
      assert.match(ddl, new RegExp('"Calcolato"[^\\n]+GENERATED ALWAYS AS[^\\n]+' + generation + '[^\\n]+NOT NULL'), '[PG-GENERATA-BACKUP] generazione e nullabilità');
      assert.match(ddl, /etichetta[^\n]+COLLATE "C"[^\n]+GENERATED ALWAYS AS/, '[PG-GENERATA-BACKUP] collation conservata');
    });
    await check('backup-ripristino', async () => {
      const target = targets.target('restore');
      const result = await runRestoreViaPlan({ session: { strategy, dbType: 'postgresql' }, backupDir: backup.backupDir,
        targetDb: target, drop: true, connName: 'generate', recoveryRoot: path.join(dir, 'recupero'), log });
      report.operazioni.push(result);
      assert.equal(result.status, 'completato', JSON.stringify(result));
      assert.deepEqual(await snapshot(target), expected, '[PG-GENERATA-NATIVA] schema e dati conservati');
      await behavior(target);
    });
    await check('export-import', async () => {
      const catalog = await leggiCatalogoExport(strategy, 'postgresql', source);
      const plan = creaPianoExport({ catalogo: { ...catalog, db: source, dbType: 'postgresql' }, connection: 'generate', formato: 'codedb-json' });
      let content = ''; await esportaDatabase({ strategy, plan, write: async part => { content += part; } });
      fs.writeFileSync(path.join(dir, 'export.codedb.json'), content);
      const target = targets.target('import');
      const importPlan = creaPianoImport({ artifact: JSON.parse(content), expectedDbType: 'postgresql', connection: 'generate', targetDb: target, drop: true });
      const adapter = createImportArtifactAdapter({ strategy, dbType: 'postgresql', connName: 'generate', recoveryRoot: path.join(dir, 'recupero'), log });
      const result = await eseguiPianoImport(importPlan, { adapter }); report.operazioni.push(result);
      assert.equal(result.status, 'completato', JSON.stringify(result));
      assert.deepEqual(await snapshot(target), expected, '[PG-GENERATA-NATIVA] export/import conserva il calcolo');
      await behavior(target);
    });
  } catch (error) { report.erroreFatale = error.stack; }
  finally {
    try {
      for (const { nspname } of (await native.query('SELECT nspname FROM pg_namespace')).rows) {
        const owner = targets.targets().find(base => nspname.startsWith(`${base}__codedb_`) && /__codedb_(staging|recovery)_[a-f0-9]{10}$/.test(nspname));
        if (owner) { targets.assertOwned(owner); await native.query(`DROP SCHEMA ${q(nspname)} CASCADE`); }
      }
      await targets.cleanup(db => native.query(`DROP SCHEMA IF EXISTS ${q(db)} CASCADE`)); report.pulizia = 'completata';
    } catch (error) { report.errorePulizia = error.stack; }
    await strategy.disconnect().catch(error => { report.erroreChiusura = error.message; });
    await native.end().catch(error => { report.erroreChiusura = error.message; });
    report.ok = !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.verifiche.length === 5 && report.verifiche.every(item => item.ok);
    report.mutazioni = mutationHits;
    report.terminato = new Date().toISOString(); fs.writeFileSync(path.join(dir, 'backup-pg-generate.json'), JSON.stringify(report, null, 2));
    if (!report.ok) { if (report.erroreFatale) console.error(report.erroreFatale); process.exitCode = 1; }
  }
}
async function child(mutant) {
  const childDir = path.join(dir, mutant ? `mutante-${mutant}` : 'controllo'); fs.mkdirSync(childDir, { recursive: true });
  const file = path.join(childDir, 'backup-pg-generate.json'); fs.rmSync(file, { force: true });
  const output = fs.createWriteStream(path.join(childDir, 'console.log'));
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, ...(mutant ? [mutant === 'backup' ? '--mutant-backup' : '--mutant'] : [])],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_REPORT_DIR: childDir } });
    inoltraOutputFiglio(proc, { log: output, mutante: mutant || null });
    proc.once('error', reject); proc.once('close', resolve);
  }).finally(() => new Promise(resolve => output.end(resolve)));
  return { exitCode, report: file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { erroreFatale: 'Rapporto assente' }) };
}
async function sensitivity() {
  const control = await child(null), sensitivity = [];
  for (const name of ['strategy', 'backup']) {
    const mutant = await child(name), failed = mutant.verifiche?.filter(item => !item.ok) || [];
    const expected = name === 'strategy' ? ['ddl-generazione', 'backup-ripristino']
      : ['backup-definizione', 'backup-ripristino', 'export-import'];
    const marker = name === 'strategy' ? '[PG-GENERATA-DDL]' : '[PG-GENERATA-BACKUP]';
    const detected = mutant.exitCode === 1 && mutant.mutazioni > 0 && !mutant.erroreFatale && !mutant.errorePulizia && !mutant.erroreChiusura && mutant.pulizia === 'completata'
      && failed.length === expected.length && failed.every(item => expected.includes(item.id))
      && failed.find(item => item.id === expected[0])?.errore.includes(marker);
    sensitivity.push({ mutante: name, risultato: mutant, rilevata: detected });
  }
  const result = { suite: 'backup-pg-generate', generazione: generation, controllo: control, sensibilita: sensitivity,
    ok: control.exitCode === 0 && control.ok && sensitivity.every(item => item.rilevata), terminato: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'backup-pg-generate.json'), JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
(process.argv.includes('--sensitivity') ? sensitivity() : worker()).catch(error => { console.error(error); process.exitCode = 1; });
