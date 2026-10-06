'use strict';

const crypto = require('crypto');
const { esportaDatabase } = require('./databaseExport');

// Riusa l'archivio HTTP: quote, checksum, pubblicazione atomica e download con
// Range restano gli stessi. Nessun file parziale viene offerto al browser.
async function creaFileExport({ archivio, ownerId, actorId, maxBytes = Infinity, ...options }) {
  const opened = archivio.avvia(ownerId, actorId);
  const hash = crypto.createHash('sha256');
  const size = Math.min(opened.maxChunkBytes, 1024 * 1024);
  let pending = [], buffered = 0, offset = 0;
  const flush = async () => {
    if (!buffered) return;
    const contenuto = Buffer.concat(pending, buffered);
    await archivio.aggiungi(opened.uploadId, ownerId, { offset, contenuto, attore: actorId });
    hash.update(contenuto);
    offset += contenuto.length;
    pending = []; buffered = 0;
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    const result = await esportaDatabase({ ...options, write: async text => {
      const bytes = Buffer.from(text);
      if (offset + buffered + bytes.length > Math.min(maxBytes, opened.maxBytes)) {
        throw new Error(`Export oltre il limite configurato di ${Math.min(maxBytes, opened.maxBytes)} byte. Aumentare il limite di import/export o scegliere SQL per un database SQL.`);
      }
      for (let start = 0; start < bytes.length;) {
        const part = bytes.subarray(start, start + Math.min(size - buffered, bytes.length - start));
        pending.push(part); buffered += part.length; start += part.length;
        if (buffered === size) await flush();
      }
    } });
    await flush();
    if (options.check) options.check();
    const manifest = await archivio.finalizza(opened.uploadId, ownerId, {
      dimensioneAttesa: offset, digestAtteso: hash.digest('hex'), attore: actorId,
      check: options.check,
      nome: `${options.plan.sourceDb}.${options.plan.formato === 'sql' ? 'sql' : 'codedb.json'}`,
    });
    return { ...result, manifest };
  } catch (err) {
    archivio.scarta(opened.uploadId, ownerId, actorId);
    throw err;
  }
}

module.exports = { creaFileExport };
