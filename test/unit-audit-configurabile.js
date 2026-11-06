'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const auditorPath = require.resolve('../db/AuditLog');
if (process.argv.includes('--mutant-options') || process.argv.includes('--mutant-cache') || process.argv.includes('--mutant-retention')) {
  const Module = require('node:module');
  const mutant = new Module(auditorPath, module);
  mutant.filename = auditorPath;
  mutant.paths = module.paths;
  let source = fs.readFileSync(auditorPath, 'utf8').replace(/\r\n/g, '\n');
  if (process.argv.includes('--mutant-options')) source = source.replace('maxBytes = bytes;', 'maxBytes = maxBytes;');
  else if (process.argv.includes('--mutant-cache')) source = source.replace('cacheBytes + size > maxCacheBytes', 'false').replace('cacheBytes > maxCacheBytes', 'false');
  else source = source.replace('while (retentionDirty) {', 'if (retentionDirty) {').replace('      retentionDirty = false;\n', '').replace('      cache = null;\n', '      retentionDirty = false;\n      cache = null;\n');
  mutant._compile(source, auditorPath);
  require.cache[auditorPath] = mutant;
}
const { makeAuditor } = require('../db/AuditLog');

module.exports = (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-audit-settings-'));
  try {
    const file = path.join(dir, 'audit.log');
    const auditor = makeAuditor(file, 100000, { maxGenerations: 5 });
    await auditor.audit({ n: 0 });
    auditor.updateOptions({ maxBytes: 1, maxGenerations: 2 });
    for (let n = 1; n <= 4; n++) await auditor.audit({ n });
    assert.equal(auditor.options().maxBytes, 1, 'la nuova soglia deve diventare effettiva');
    assert.equal(fs.existsSync(`${file}.2`), true, 'la soglia cambiata deve causare rotazioni reali');
    assert.deepEqual(auditor.readRecent().entries.map(e => e.n), [4, 3, 2], 'la cache deve rispettare la conservazione corrente');
    const restarted = makeAuditor(file, 1, { maxGenerations: 2 });
    assert.deepEqual(restarted.readRecent(), auditor.readRecent(), 'riavviare non deve cambiare lo storico visibile');
    assert.throws(() => auditor.updateOptions({ maxBytes: -1 }), /non valida/);
    assert.throws(() => auditor.updateOptions({ maxGenerations: 101 }), /non valido/);
    assert.equal(auditor.options().maxBytes, 1, 'un aggiornamento non valido non deve applicarsi parzialmente');

    const retentionFile = path.join(dir, 'conservazione.log');
    const retention = makeAuditor(retentionFile, 1, { maxGenerations: 5 });
    for (let n = 0; n < 6; n++) await retention.audit({ n });
    assert(fs.existsSync(`${retentionFile}.5`));
    retention.updateOptions({ maxGenerations: 2 });
    await retention.audit({ n: 6 });
    assert(!fs.existsSync(`${retentionFile}.3`) && !fs.existsSync(`${retentionFile}.5`), 'ridurre la conservazione deve rimuovere davvero le generazioni eccedenti');
    retention.updateOptions({ maxGenerations: 5 });
    assert.deepEqual(retention.readRecent().entries.map(e => e.n), [6, 5, 4], 'aumentare il limite non deve far riapparire eventi eliminati');

    const concurrentFile = path.join(dir, 'concorrenza.log');
    const concurrent = makeAuditor(concurrentFile, 1, { maxGenerations: 5 });
    for (let n = 0; n < 6; n++) await concurrent.audit({ n });
    concurrent.updateOptions({ maxGenerations: 3 });
    const originalUnlink = fs.promises.unlink;
    let changedDuringDelete = false;
    try {
      fs.promises.unlink = async function(file, ...args) {
        if (file === `${concurrentFile}.4` && !changedDuringDelete) {
          changedDuringDelete = true;
          concurrent.updateOptions({ maxGenerations: 1 });
        }
        return originalUnlink.call(this, file, ...args);
      };
      await concurrent.audit({ n: 6 });
      await concurrent.audit({ n: 7 });
    } finally { fs.promises.unlink = originalUnlink; }
    assert(changedDuringDelete, 'la prova deve cambiare la conservazione durante la cancellazione');
    assert(!fs.existsSync(`${concurrentFile}.2`) && !fs.existsSync(`${concurrentFile}.3`), 'la conservazione concorrente non deve perdere il secondo aggiornamento');
    concurrent.updateOptions({ maxGenerations: 5 });
    assert.deepEqual(concurrent.readRecent().entries.map(e => e.n), [7, 6], 'la conservazione concorrente non deve far riapparire gli eventi eliminati');

    const limited = makeAuditor(path.join(dir, 'limitato.log'), 100000, { maxCacheEntries: 3 });
    for (let n = 0; n < 6; n++) await limited.audit({ n });
    assert.equal(limited.readRecent().truncated, true, 'il tetto dello storico deve essere dichiarato');
    assert(limited.readRecent().total < 6);

    const largeFile = path.join(dir, 'grande.log');
    const unicode = '😀'.repeat(7000);
    fs.writeFileSync(largeFile, Array.from({ length: 32 }, (_, n) => JSON.stringify({ n, testo: unicode })).join('\n') + '\n');
    const bounded = makeAuditor(largeFile, 1000000, { maxCacheBytes: 65536 });
    const originalRead = fs.readSync;
    let readBytes = 0, recent;
    try {
      fs.readSync = function(...args) { const count = originalRead.apply(this, args); readBytes += count; return count; };
      recent = bounded.readRecent();
    } finally { fs.readSync = originalRead; }
    assert.deepEqual(recent.entries.map(e => e.n), [31, 30], 'il budget in byte deve limitare la lettura dal fondo');
    assert.equal(recent.entries[0].testo, unicode, 'UTF-8 deve sopravvivere ai confini dei blocchi');
    assert.equal(recent.truncated, true);
    assert(readBytes < fs.statSync(largeFile).size / 2, 'la consultazione non deve leggere l’intero registro');
    await bounded.audit({ n: 32, testo: unicode });
    assert.deepEqual(bounded.readRecent().entries.map(e => e.n), [32, 31], 'anche gli append devono rispettare il budget in byte');

    const legacyFile = path.join(dir, 'legacy.log');
    fs.writeFileSync(legacyFile, [JSON.stringify({ ts: '2026-01-01', n: 0 }),
      JSON.stringify({ ts: '2026-01-02', ownerId: 'a', userId: 'u1', n: 1 }),
      JSON.stringify({ ts: '2026-01-03', ownerId: 'b', userId: 'u2', n: 2 }), 'corrotto'].join('\n'));
    const legacy = makeAuditor(legacyFile);
    assert.deepEqual(legacy.readRecent({ ownerId: 'a' }).entries.map(e => e.n), [1]);
    assert.equal(legacy.readRecent().truncated, true, 'le righe illeggibili non devono sembrare uno storico completo');

    if (process.argv.includes('--sensitivity')) {
      const result = spawnSync(process.execPath, [__filename, '--mutant-options'], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(result.status, 0, 'il mutante che ignora la soglia deve fallire');
      assert.match(result.stderr, /nuova soglia|rotazioni reali/);
      const cacheResult = spawnSync(process.execPath, [__filename, '--mutant-cache'], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(cacheResult.status, 0, 'il mutante che ignora il budget memoria deve fallire');
      assert.match(cacheResult.stderr, /budget in byte/);
      const retentionResult = spawnSync(process.execPath, [__filename, '--mutant-retention'], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(retentionResult.status, 0, 'il mutante che perde un aggiornamento concorrente deve fallire');
      assert.match(retentionResult.stderr, /conservazione concorrente/);
      console.log('  OK   sensibilità audit: soglia, memoria e aggiornamenti concorrenti');
    }
    console.log('  OK   audit configurabile: rotazioni, riavvio, validazione, limiti e isolamento legacy');
  } finally {
    assert(path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('codedb-audit-settings-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
