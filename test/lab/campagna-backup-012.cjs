'use strict';

// Campagna seriale LAB012 nel runner isolato. Il benchmark volume precede
// le regressioni e non deve sovrapporsi alla suite funzionale incrementali.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
if (process.env.CODEDB_LAB_CONTAINER !== '1' || !fs.existsSync('/.dockerenv')) {
  throw new Error('Campagna consentita solo nel container isolato del laboratorio.');
}
const { runSuite } = require('./runner.cjs');
const lock = require('./lock.cjs');
const root = path.resolve(__dirname, '../..');
const directory = path.resolve(process.env.LAB_REPORT_DIR || '/laboratorio/rapporti/lab012-regressioni');
const definitions = [
  'backup-incrementali-volume', 'backup-tempi', 'backup-indici', 'backup-oggetti',
  'backup-merge-identita', 'backup-validator', 'backup-mysql-schema', 'backup-pg-generate',
];
const selected = process.argv.includes('--volume-only') ? definitions.slice(0, 1)
  : process.argv.includes('--regressioni') ? definitions.slice(1) : definitions;
const production = ['backup/lib/engine.js', 'backup/lib/content-state.js', 'backup/lib/restore.js', 'backup/lib/util.js',
  'backup/lib/identity.js', 'backup/lib/tombstones.js', 'backup/lib/schema-snapshot.js',
  'db/backupRestoreAdapter.js', 'db/importArtifactAdapter.js', 'db/schemaObjects.js', 'db/artefatti.js',
  'db/PostgreSqlStrategy.js', 'db/MySqlStrategy.js', 'db/MongoDbStrategy.js', 'db/pg-ddl.js', 'db/pg-types.js',
  'db/pg-references.js', 'db/pg-alias.js', 'db/mongoBson.js', 'db/mongoSchemaBson.js', 'db/mongoCollectionOptions.js',
  'db/codecFedele.js', 'db/mysql-ddl.js', 'test/lab/runner.cjs', 'test/lab/output-mutanti.cjs', 'test/lab/campagna-backup-012.cjs'];
const files = [...production, ...selected.map(name => `test/lab/${name}.cjs`)];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { suite: 'campagna-backup-012', iniziato: new Date().toISOString(), node: process.version, selezionate: selected,
  sorgenti: hashes(), risultati: [] };
const save = () => fs.writeFileSync(path.join(directory, 'campagna-backup-012.json'), JSON.stringify(report, null, 2));

async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
  fs.mkdirSync(directory, { recursive: true });
  const release = lock.acquisisci('LAB012 volume e regressioni backup');
  try {
    for (const name of selected) {
      const out = path.join(directory, name); fs.mkdirSync(out, { recursive: true });
      const json = path.join(out, `${name}.json`); fs.rmSync(json, { force: true });
      const started = new Date().toISOString(); console.log(`AVVIO ${name} ${started}`);
      const result = await runSuite({ file: path.join(root, 'test/lab', `${name}.cjs`), cwd: root,
        log: path.join(directory, `${name}.log`), timeoutMs: name === 'backup-incrementali-volume' ? 180000 : 300000,
        args: ['--sensitivity'], env: { ...process.env, LAB_REPORT_DIR: out, LAB_MONGO_PORT: '27017', LAB_MYSQL_PORT: '3306', LAB_PG_PORT: '5432',
          LAB_MONGO_PASSWORD: '', LAB_MYSQL_PASSWORD: 'lab_mysql', LAB_PG_PASSWORD: 'lab_postgres',
          LAB_VOLUME_ENGINE: '', LAB_OGGETTI_ENGINE: '', LAB_MERGE_ENGINE: '', LAB_BACKUP_TEMPI_CASE: '', LAB_PG_GENERATION: 'STORED' } });
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(json, 'utf8')); }
      catch (error) { result.erroreRapporto = error.message; }
      const value = { nome: name, iniziato: started, runner: result, rapporto: json, ok: result.esito === 'superato' && result.code === 0 && parsed?.ok === true };
      report.risultati.push(value); save();
      console.log(`${value.ok ? 'SUPERATO' : 'FALLITO'} ${name} (${result.ms} ms)`);
      if (!value.ok) console.log(fs.readFileSync(result.log, 'utf8').split('\n').slice(-12).join('\n'));
    }
    report.hashStabili = JSON.stringify(report.sorgenti) === JSON.stringify(hashes());
    report.ok = report.risultati.length === selected.length && report.risultati.every(item => item.ok) && report.hashStabili;
  } finally { report.terminato = new Date().toISOString(); save(); release(); }
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { report.erroreFatale = error.stack; report.ok = false; save(); console.error(error.stack); process.exitCode = 1; });
