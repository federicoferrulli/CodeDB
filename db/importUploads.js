'use strict';

const { randomUUID } = require('crypto');

const { creaLettoreCodedbJson } = require('./artefattoStreaming');

function createImportUploadRegistry({
  id = randomUUID,
  now = () => Date.now(),
  ttlMs = 30 * 60 * 1000,
  maxBytes = Number(process.env.CODEDB_MAX_IMPORT_BYTES) || 64 * 1024 * 1024,
  maxChunkBytes = 2 * 1024 * 1024,
  maxActive = Number(process.env.CODEDB_MAX_IMPORT_UPLOADS) || 4,
  maxPerOwner = Number(process.env.CODEDB_MAX_IMPORT_UPLOADS_PER_OWNER) || 2,
  maxTotalBytes = Number(process.env.CODEDB_MAX_IMPORT_TOTAL_BYTES) || maxBytes,
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (timer) => clearTimeout(timer),
} = {}) {
  const uploads = new Map();

  function discard(key) {
    const upload = uploads.get(String(key));
    if (!upload) return;
    if (upload.timer) unschedule(upload.timer);
    upload.chunks.length = 0;
    upload.artifact = null;
    uploads.delete(String(key));
  }

  function arm(key, upload) {
    if (upload.timer) unschedule(upload.timer);
    upload.timer = schedule(() => discard(key), ttlMs);
    if (upload.timer && typeof upload.timer.unref === 'function') upload.timer.unref();
  }

  function purge() {
    const threshold = now() - ttlMs;
    for (const [key, upload] of uploads) {
      if (upload.touchedAt < threshold) discard(key);
    }
  }

  function owned(uploadId, ownerId, actorId = null) {
    purge();
    const upload = uploads.get(String(uploadId));
    if (!upload || upload.ownerId !== ownerId || (actorId != null && upload.actorId !== actorId)) {
      throw new Error('Caricamento artefatto non trovato.');
    }
    upload.touchedAt = now();
    arm(String(uploadId), upload);
    return upload;
  }

  function totalBytes() {
    return [...uploads.values()].reduce((sum, upload) => sum + upload.bytes, 0);
  }

  return {
    close() {
      for (const key of uploads.keys()) discard(key);
    },
    start(ownerId, actorId = null) {
      purge();
      if (uploads.size >= maxActive) throw new Error('Troppi caricamenti di import contemporanei.');
      const ownerUploads = [...uploads.values()].filter((upload) => upload.ownerId === ownerId).length;
      if (ownerUploads >= maxPerOwner) throw new Error('Troppi caricamenti di import contemporanei per questo account.');
      const uploadId = String(id());
      const upload = {
        ownerId, actorId, chunks: [], nextIndex: 0, bytes: 0, artifact: null, touchedAt: now(), timer: null,
      };
      uploads.set(uploadId, upload);
      arm(uploadId, upload);
      return { uploadId, maxChunkBytes, maxBytes };
    },
    append(uploadId, ownerId, index, chunk, actorId = null) {
      const upload = owned(uploadId, ownerId, actorId);
      if (upload.artifact) throw new Error('Il caricamento artefatto e gia stato completato.');
      if (Number(index) !== upload.nextIndex) throw new Error(`Blocco fuori sequenza: atteso ${upload.nextIndex}.`);
      if (typeof chunk !== 'string') throw new Error('Il blocco dell artefatto deve essere testo.');
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxChunkBytes) throw new Error(`Blocco troppo grande: massimo ${maxChunkBytes} byte.`);
      if (upload.bytes + bytes > maxBytes) throw new Error(`Artefatto troppo grande: massimo ${maxBytes} byte.`);
      if (totalBytes() + bytes > maxTotalBytes) {
        throw new Error(`Quota complessiva dei caricamenti superata: massimo ${maxTotalBytes} byte.`);
      }
      upload.chunks.push(chunk);
      upload.bytes += bytes;
      upload.nextIndex++;
      return { uploadId: String(uploadId), nextIndex: upload.nextIndex, bytes: upload.bytes };
    },
    /**
     * Ricompone l'artefatto dai blocchi ricevuti.
     *
     * Non con `chunks.join('')` più `JSON.parse`: quella via tiene in memoria
     * DUE copie intere del file nello stesso istante — la stringa unita e
     * l'oggetto che ne esce — mentre i blocchi originali non sono ancora stati
     * liberati. Su un artefatto da mezzo giga è il punto in cui il server
     * muore, ed è il limite che §2 del piano registra: un trasferimento a
     * blocchi che finisce in una stringa unica non limita la memoria, la
     * sposta.
     *
     * Il lettore incrementale (`db/artefattoStreaming.js`) consuma un blocco
     * alla volta — e ogni blocco consumato viene LASCIATO ANDARE subito, che è
     * l'unica ragione per cui la copia in più sparisce davvero — tenendo
     * soltanto l'involucro e i documenti man mano che li riconosce. Porta con
     * sé anche i suoi tetti (involucro e singolo documento), che si applicano
     * DURANTE la lettura invece che dopo.
     */
    finish(uploadId, ownerId, normalize, actorId = null) {
      const upload = owned(uploadId, ownerId, actorId);
      if (!upload.artifact) {
        try {
          const gruppi = [];
          const lettore = creaLettoreCodedbJson({
            // I documenti si raccolgono per POSIZIONE, nell'ordine in cui i
            // rispettivi `docs` si aprono: è lo stesso ordine dell'involucro.
            // Per nome non si potrebbe — un nome può mancare o ripetersi.
            onCollection: () => { gruppi.push([]); },
            onDocumento: (_nome, testo) => { gruppi[gruppi.length - 1].push(JSON.parse(testo)); },
          });
          for (let i = 0; i < upload.chunks.length; i += 1) {
            lettore.scrivi(upload.chunks[i]);
            upload.chunks[i] = null; // consumato: non deve sopravvivere al proprio uso
          }
          upload.chunks = [];
          const parsed = lettore.fine();
          const collections = Array.isArray(parsed.collections) ? parsed.collections : [];
          for (let i = 0; i < collections.length; i += 1) collections[i].docs = gruppi[i] || [];
          upload.artifact = normalize ? normalize(parsed) : parsed;
        } catch (err) {
          discard(uploadId);
          throw new Error(`File .codedb.json non valido: ${err.message}`);
        }
        upload.chunks = [];
      }
      return upload.artifact;
    },
    get(uploadId, ownerId, actorId = null) {
      const upload = owned(uploadId, ownerId, actorId);
      if (!upload.artifact) throw new Error('Il caricamento artefatto non e ancora completo.');
      return upload.artifact;
    },
    remove(uploadId, ownerId, actorId = null) {
      owned(uploadId, ownerId, actorId);
      discard(String(uploadId));
    },
  };
}

module.exports = { createImportUploadRegistry };
