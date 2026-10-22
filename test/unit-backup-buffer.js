'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
let { createFileSink } = require('../backup/lib/util');
if (process.argv.includes('--mutant')) {
  const file = require.resolve('../backup/lib/util'), module = { exports: {} };
  const source = fs.readFileSync(file, 'utf8').replace('if (bufferedBytes >= 64 * 1024) return flush();', 'return flush();');
  require('node:vm').runInNewContext(source, { module, require: require('node:module').createRequire(file), Buffer, process });
  ({ createFileSink } = module.exports);
}

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-backup-buffer-'));
  const original = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
  let blocchi = 0;
  Object.defineProperty(zlib, 'createGzip', { ...original, value: (...args) => {
    const gzip = original.value(...args), transform = gzip._transform;
    gzip._transform = function (...params) { blocchi++; return transform.apply(this, params); };
    return gzip;
  } });
  try {
    const start = performance.now();
    const file = path.join(root, 'righe.gz');
    const sink = createFileSink(file);
    const righe = Array.from({ length: 50000 }, (_, i) => JSON.stringify({ i, nome: 'città 日本語', valore: 'x'.repeat(80) }));
    for (const riga of righe) { const pending = sink.writeLine(riga); if (pending) await pending; }
    await sink.writeChunk(Buffer.from('fine\n'));
    const digest = await sink.close();
    console.log(`Compressione 50.000 righe: ${Math.round(performance.now() - start)} ms, ${blocchi} blocchi gzip`);
    const bytes = fs.readFileSync(file);
    assert.equal(zlib.gunzipSync(bytes).toString(), righe.join('\n') + '\nfine\n');
    assert.equal(digest.bytes, bytes.length);
    assert.equal(digest.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert(blocchi < 500, 'Le righe piccole devono raggiungere gzip a blocchi, senza una chiamata nativa per riga');
    console.log('OK buffer backup: ordine, Unicode, byte e checksum conservati');
  } finally {
    Object.defineProperty(zlib, 'createGzip', original);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
