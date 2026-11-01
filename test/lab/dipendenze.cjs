'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (process.argv.includes('--mutant')) {
  const Module = require('node:module'), file = require.resolve('../../mcp/McpGateway');
  const source = fs.readFileSync(file, 'utf8');
  const broken = source.replaceAll('z.record(z.string(), z.unknown())', 'z.record(z.string(), z.string())');
  assert.notEqual(broken, source);
  const mod = new Module(file, module); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(broken, file); require.cache[file] = mod;
  require('../unit-mcp-execute-write-batch');
} else {
  const { spawnSync } = require('node:child_process');
  const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/dipendenze', 'dipendenze'); fs.mkdirSync(dir, { recursive: true });
  const results = [];
  for (const mutant of [false, true]) {
    const run = spawnSync(process.execPath, mutant ? [__filename, '--mutant'] : [path.join(__dirname, '../unit-mcp-execute-write-batch.js')],
      { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const output = (run.stdout || '') + (run.stderr || '');
    fs.writeFileSync(path.join(dir, mutant ? 'mutante.log' : 'controllo.log'), output);
    assert(!run.error, run.error?.message); assert.equal(run.status, mutant ? 1 : 0);
    if (mutant) assert.match(output, /tutte le mutazioni MongoDB devono comparire/);
    results.push({ mutant, code: run.status });
  }
  fs.writeFileSync(path.join(dir, 'sensibilita.json'), JSON.stringify(results, null, 2));
  console.log('OK compatibilità MCP con Zod 4 e mutante del contratto record rilevato');
}
