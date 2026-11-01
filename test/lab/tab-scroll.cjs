'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/tab-scroll', 'tab-scroll');
const root = path.resolve(__dirname, '../..');
const sources = ['public/js/tab-drag.js', 'test/e2e-tab-motion.js'];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const before = hashes(), results = [];
for (const [name, args] of [['normale', []], ['frame-ravvicinati', ['--same-frame']], ['mutante', ['--mutant-scroll']]]) {
  const out = path.join(dir, name); fs.mkdirSync(out, { recursive: true });
  const run = spawnSync(process.execPath, [path.join(__dirname, '../e2e-tab-motion.js'), '--checks-only', ...args], {
    env: { ...process.env, TAB_MOTION_REPORT_DIR: out }, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  const output = (run.stdout || '') + (run.stderr || ''); fs.writeFileSync(path.join(out, 'console.log'), output);
  assert(!run.error, run.error?.message); assert.equal(run.status, name === 'mutante' ? 1 : 0);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json')));
  assert.deepEqual(report.errors, []);
  if (name === 'mutante') { assert.match(output, /\[QA001-SCROLL\]/); assert(report.reversibile.scroll <= 40); }
  else { assert.equal(report.checks.length, 10); assert(report.reversibile.scroll > 40); }
  assert(report.reversibile.annullato && report.reversibile.invariato);
  results.push({ name, code: run.status, checks: report.checks.length, scroll: report.reversibile.scroll });
  console.log('OK auto-scroll ' + name);
}
assert.deepEqual(hashes(), before);
fs.writeFileSync(path.join(dir, 'sensibilita.json'), JSON.stringify({ sources: before, results, ok: true }, null, 2));
