'use strict';

const { createHash } = require('crypto');

// Ricevute senza documenti, conservate per riconciliare una risposta persa.
// Un errore del driver può seguire una scrittura: non autorizza mai un retry.
function createImportBatchRegistry({ now = Date.now, retentionMs = 86400000, maxEntries = 10000 } = {}) {
  const batches = new Map();
  function key(scope, batchId) {
    if (typeof batchId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(batchId)) {
      throw new Error('Identificativo del blocco di import non valido.');
    }
    return JSON.stringify([scope, batchId]);
  }
  function prune() {
    for (const [id, value] of batches) {
      if (value.endedAt != null && now() - value.endedAt > retentionMs) batches.delete(id);
    }
  }
  return {
    async request(scope, payload, execute) {
      prune();
      const id = key(scope, payload.batchId);
      const previous = batches.get(id);
      if (payload.statusOnly) {
        return previous ? previous.state : { batchId: payload.batchId, status: 'sconosciuto' };
      }
      const digest = createHash('sha256').update(JSON.stringify({
        docs: payload.docs, upsert: !!payload.upsert, conflictColumns: payload.conflictColumns,
      })).digest('hex');
      if (previous) {
        if (previous.digest !== digest) throw new Error('Identificativo del blocco già usato con dati diversi.');
        return previous.promise;
      }
      if (batches.size >= maxEntries) throw new Error('Registro degli import pieno: attendi prima di iniziare un nuovo import.');
      const entry = { digest, state: { batchId: payload.batchId, status: 'in_corso' }, endedAt: null };
      batches.set(id, entry);
      entry.promise = Promise.resolve().then(execute).then(
        (result) => ({ ...result, batchId: payload.batchId, status: 'completato' }),
        (err) => ({ batchId: payload.batchId, status: 'incerto', error: err.message }),
      ).then((result) => {
        entry.state = result;
        entry.endedAt = now();
        return result;
      });
      return entry.promise;
    },
  };
}

module.exports = { createImportBatchRegistry };
