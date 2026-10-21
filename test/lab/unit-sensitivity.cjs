'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/lab-reports');
fs.mkdirSync(dir, { recursive: true });
const results = [];
for (const [file, flag, expected] of [
  ['unit-runner.cjs', '--mutant', /AssertionError[\s\S]*errore[\s\S]*superato[\s\S]*fallito/],
  ['unit-connection.cjs', '--mutant-connection', /Missing expected rejection[\s\S]*Una chiusura durante handshake deve fallire/],
]) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file), flag], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(dir, file + '.mutante.log'), output);
  const detected = result.status === 1 && expected.test(output);
  results.push({ file, flag, detected, code: result.status });
  fs.writeFileSync(path.join(dir, 'unit-sensitivity.json'), JSON.stringify(results, null, 2));
  assert(detected, `Mutante ${file} non intercettato dall'asserzione attesa: ${output}`);
  console.log('OK sensibilità ' + file);
}
