'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/mcp-parziale', 'mcp-parziale');
const results = [];
for (const mutant of [false, true]) {
  const out = path.join(dir, mutant ? 'mutante' : 'controllo'); fs.mkdirSync(out, { recursive: true });
  const preloader = path.join(__dirname, 'mcp-esito-mutante.cjs').replaceAll('\\', '/');
  const run = spawnSync(process.execPath, [path.join(__dirname, 'mcp.cjs')], { windowsHide: true, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, LAB_REPORT_DIR: out, LAB_MCP_REPORT: '',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''}${mutant ? ` --require="${preloader}"` : ''}` } });
  fs.writeFileSync(path.join(out, 'console.log'), (run.stdout || '') + (run.stderr || ''));
  assert(!run.error, run.error?.message); assert.equal(run.status, mutant ? 1 : 0);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'mcp.json')));
  assert.equal(report.results.length, 28);
  assert.deepEqual(report.results.filter(r => r.status === 'failed').map(r => r.id), mutant ? ['MCP-018'] : []);
  results.push({ mutant, passed: report.passed, failed: report.failed });
}
fs.writeFileSync(path.join(dir, 'sensibilita.json'), JSON.stringify(results, null, 2));
console.log('OK MCP reale: inserimenti parziali e batch osservabili, mutante rilevato');
