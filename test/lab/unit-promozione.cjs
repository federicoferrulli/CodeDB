'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/promozione-unita', 'unit-promozione');
fs.mkdirSync(dir, { recursive: true });
const suites = [
  ['test/unit-pg-routine-selezione.js', '[PG-ROUTINE]'],
  ['test/unit-pg-schema-compare.js', '[PG-QUOTE]'],
  ['test/unit-schema-merge.js', '[MERGE-COLONNE]'],
  ['test/unit-import-conferma.js', '[IMPORT-CONFERMA]'],
  ['test/lab/pg-restore-transaction.cjs', null],
];
const sources = ['db/pg-schema-compare.js', 'db/schema-merge.js', 'db/importPlan.js', 'db/pg-restore-transaction.js',
  ...suites.map(([file]) => file), 'test/lab/unit-promozione.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { suite: 'unit-promozione', sorgenti: hashes(), risultati: [] };
function run(file, mutant) {
  const out = path.join(dir, path.basename(file) + (mutant ? '-mutante' : '-controllo'));
  fs.mkdirSync(out, { recursive: true });
  const json = path.join(out, 'pg-restore-transaction.json'); fs.rmSync(json, { force: true });
  const result = spawnSync(process.execPath, [file, ...(mutant ? ['--mutant'] : [])], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, LAB_REPORT_DIR: out },
  });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out, 'console.log'), output);
  return { code: result.status, errore: result.error?.message, output,
    report: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json)) : null };
}
for (const [file, marker] of suites) {
  const base = run(file, false), mutant = run(file, true);
  let ok = base.code === 0 && !base.errore && !mutant.errore && mutant.code === 1;
  if (marker) ok &&= mutant.output.includes(marker) && /AssertionError/.test(mutant.output);
  else {
    const data = mutant.report;
    ok &&= base.report?.ok === true && data?.pulizia === true && data.sorgentiStabili === true
      && !data.fatale && !data.rollbackError && !data.errorePulizia
      && data.verifiche.length === 7
      && JSON.stringify(data.verifiche.filter(item => !item.ok).map(item => item.id)) === JSON.stringify(['rollback-batch-non-annulla-promozione']);
  }
  report.risultati.push({ file, base, mutant, ok: !!ok });
  console.log(`${ok ? 'OK' : 'FAIL'} controllo e mutante ${file}`);
}
report.sorgentiStabili = JSON.stringify(report.sorgenti) === JSON.stringify(hashes());
report.ok = report.sorgentiStabili && report.risultati.every(item => item.ok);
fs.writeFileSync(path.join(dir, 'unit-promozione.json'), JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
