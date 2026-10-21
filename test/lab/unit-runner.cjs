'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let runner = require('./runner.cjs');
if (process.argv.includes('--mutant')) {
  const Module = require('node:module');
  const filename = require.resolve('./runner.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const modified = source.replace('code !== 0 || errori.length', 'false');
  assert.notEqual(modified, source, 'La mutazione deve colpire il classificatore reale');
  const copy = new Module(filename, module);
  copy.filename = filename; copy.paths = module.paths; copy._compile(modified, filename);
  runner = copy.exports;
}
const { runSuite } = runner;
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-runner-'));
  try {
    for (const [name, source, expected, timeout] of [
      ['successo', "console.log('OK prova effettiva')", 'superato', 3000],
      ['errore', 'process.exitCode = 7', 'fallito', 3000],
      ['verde-falso', "console.log('FAIL scrittura errata')", 'fallito', 3000],
      ['saltato', "console.log('SALTATO: database assente')", 'incompleto', 3000],
      ['browser-flag', "console.log('--edge-skip-compat-layer-relaunch')", 'superato', 3000],
      ['bloccato', 'setInterval(()=>{},1000)', 'timeout', 200],
    ]) {
      const file = path.join(dir, name + '.cjs'); fs.writeFileSync(file, source);
      const result = await runSuite({ file, log: path.join(dir, name + '.log'), cwd: dir, timeoutMs: timeout });
      assert.equal(result.esito, expected, name);
      console.log('OK runner ' + name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(err => { console.error(err); process.exitCode = 1; });
