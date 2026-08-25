'use strict';

const { randomUUID } = require('crypto');

function createImportUploadRegistry({
  id = randomUUID,
  now = () => Date.now(),
  ttlMs = 30 * 60 * 1000,
  maxBytes = Number(process.env.CODEDB_MAX_IMPORT_BYTES) || 512 * 1024 * 1024,
  maxChunkBytes = 2 * 1024 * 1024,
} = {}) {
  const uploads = new Map();

  function purge() {
    const threshold = now() - ttlMs;
    for (const [key, upload] of uploads) {
      if (upload.touchedAt < threshold) uploads.delete(key);
    }
  }

  function owned(uploadId, ownerId) {
    purge();
    const upload = uploads.get(String(uploadId));
    if (!upload || upload.ownerId !== ownerId) throw new Error('Caricamento artefatto non trovato.');
    upload.touchedAt = now();
    return upload;
  }

  return {
    start(ownerId) {
      purge();
      const uploadId = String(id());
      uploads.set(uploadId, {
        ownerId, chunks: [], nextIndex: 0, bytes: 0, artifact: null, touchedAt: now(),
      });
      return { uploadId, maxChunkBytes, maxBytes };
    },
    append(uploadId, ownerId, index, chunk) {
      const upload = owned(uploadId, ownerId);
      if (upload.artifact) throw new Error('Il caricamento artefatto e gia stato completato.');
      if (Number(index) !== upload.nextIndex) throw new Error(`Blocco fuori sequenza: atteso ${upload.nextIndex}.`);
      if (typeof chunk !== 'string') throw new Error('Il blocco dell artefatto deve essere testo.');
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxChunkBytes) throw new Error(`Blocco troppo grande: massimo ${maxChunkBytes} byte.`);
      if (upload.bytes + bytes > maxBytes) throw new Error(`Artefatto troppo grande: massimo ${maxBytes} byte.`);
      upload.chunks.push(chunk);
      upload.bytes += bytes;
      upload.nextIndex++;
      return { uploadId: String(uploadId), nextIndex: upload.nextIndex, bytes: upload.bytes };
    },
    finish(uploadId, ownerId, normalize) {
      const upload = owned(uploadId, ownerId);
      if (!upload.artifact) {
        const raw = upload.chunks.join('');
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (err) { throw new Error(`File .codedb.json non valido: ${err.message}`); }
        upload.artifact = normalize ? normalize(parsed) : parsed;
        upload.chunks = [];
      }
      return upload.artifact;
    },
    get(uploadId, ownerId) {
      const upload = owned(uploadId, ownerId);
      if (!upload.artifact) throw new Error('Il caricamento artefatto non e ancora completo.');
      return upload.artifact;
    },
    remove(uploadId, ownerId) {
      owned(uploadId, ownerId);
      uploads.delete(String(uploadId));
    },
  };
}

module.exports = { createImportUploadRegistry };
