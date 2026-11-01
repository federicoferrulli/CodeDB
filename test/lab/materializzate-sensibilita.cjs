'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (process.argv.includes('--mutant')) {
  const Module = require('node:module'), file = require.resolve('../../backup/lib/restore');
  const source = fs.readFileSync(file, 'utf8');
  const changed = source.replace('await strategy.pool.query(`REFRESH MATERIALIZED VIEW ${pgQid(targetDb)}.${pgQid(v.name)}`);', 'await Promise.resolve();');
  assert.notEqual(changed, source);
  const mod = new Module(file, module); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(changed, file); require.cache[file] = mod;
  require('./backup-riferimenti-esterni.cjs');
} else {
  const { spawnSync } = require('node:child_process');
  const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/materializzate', 'materializzate');
  const results = [];
  for (const mutant of [false, true]) {
    const out = path.join(dir, mutant ? 'mutante' : 'controllo'); fs.mkdirSync(out, { recursive: true });
    const run = spawnSync(process.execPath, mutant ? [__filename, '--mutant'] : [path.join(__dirname, 'backup-riferimenti-esterni.cjs')],
      { env: { ...process.env, LAB_REPORT_DIR: out }, encoding: 'utf8', timeout: 120000, windowsHide: true });
    fs.writeFileSync(path.join(out, 'console.log'), (run.stdout || '') + (run.stderr || ''));
    assert(!run.error, run.error?.message); assert.equal(run.status, mutant ? 1 : 0);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'backup-riferimenti-esterni.json')));
    assert(!report.fatale); assert.equal(report.cleanup.completato, true); assert.equal(report.verifiche.length, 9);
    assert.deepEqual(report.fallimenti, mutant ? ['cleanup-preserva-routine-e-colonna-composita'] : []);
    results.push({ mutant, code: run.status, failures: report.fallimenti });
  }
  fs.writeFileSync(path.join(dir, 'sensibilita.json'), JSON.stringify(results, null, 2));
  console.log('OK vista materializzata: identità e dati aggiornati, mutante rilevato');
}
