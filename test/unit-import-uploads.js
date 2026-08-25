'use strict';

const assert = require('assert');
const { createImportUploadRegistry } = require('../db/importUploads');

module.exports = (async () => {
  const registry = createImportUploadRegistry({
    id: () => 'upload-1', now: () => 1000, maxBytes: 100, maxChunkBytes: 60,
  });
  const opened = registry.start('owner-1');
  assert.strictEqual(opened.uploadId, 'upload-1');
  registry.append('upload-1', 'owner-1', 0, '{"db":');
  assert.throws(() => registry.append('upload-1', 'owner-1', 2, '"x"}'), /fuori sequenza/i);
  registry.append('upload-1', 'owner-1', 1, '"x"}');
  const artifact = registry.finish('upload-1', 'owner-1', (value) => ({ ...value, validato: true }));
  assert.deepStrictEqual(artifact, { db: 'x', validato: true });
  assert.deepStrictEqual(registry.get('upload-1', 'owner-1'), artifact);
  assert.throws(() => registry.get('upload-1', 'owner-2'), /non trovato/i);
  registry.remove('upload-1', 'owner-1');
  assert.throws(() => registry.get('upload-1', 'owner-1'), /non trovato/i);

  const limited = createImportUploadRegistry({ id: () => 'upload-2', maxBytes: 3, maxChunkBytes: 3 });
  limited.start('owner-1');
  assert.throws(() => limited.append('upload-2', 'owner-1', 0, 'quattro'), /troppo grande/i);

  console.log('  OK   Upload artefatto a blocchi, limiti e isolamento owner passed');
})().catch((err) => {
  console.error('  FAIL Upload artefatto:', err.stack || err);
  process.exitCode = 1;
});
