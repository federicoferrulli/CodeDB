'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/evoluzione-sensibilita', 'evoluzione');
const results = [];
for (const mutant of [false, true]) {
  const out = path.join(dir, mutant ? 'mutante' : 'controllo'); fs.mkdirSync(out, { recursive: true });
  const run = spawnSync(process.execPath, [path.join(__dirname, 'backup-evoluzione.cjs'), ...(mutant ? ['--mutant'] : [])], {
    env: { ...process.env, LAB_REPORT_DIR: out }, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  fs.writeFileSync(path.join(out, 'console.log'), (run.stdout || '') + (run.stderr || ''));
  assert(!run.error, run.error?.message);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'backup-evoluzione.json')));
  assert.equal(report.cleanup, true); assert(!report.fatale); assert.equal(report.verifiche.length, 20);
  assert.equal(run.status, mutant ? 1 : 0);
  const failures = report.verifiche.filter(r => !r.ok).map(r => r.id);
  assert.deepEqual(failures, mutant ? ['aggiunta', 'rimozione', 'tipo', 'vincolo'].flatMap(k => ['esito', 'dati', 'schema', 'riferimenti-dopo-cleanup'].map(id => k + '/' + id)) : []);
  results.push({ mutant, code: run.status, failures, cleanup: report.cleanup });
}
fs.writeFileSync(path.join(dir, 'sensibilita.json'), JSON.stringify(results, null, 2));
console.log('OK evoluzione PostgreSQL: 20 controlli, mutante rilevato nei 16 controlli attesi');
