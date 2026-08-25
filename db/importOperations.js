'use strict';

const { randomUUID } = require('crypto');
const { eseguiPianoImport } = require('./importPlan');

function createImportOperationRegistry({ execute = eseguiPianoImport, id = randomUUID, now = () => new Date().toISOString() } = {}) {
  const operations = new Map();

  function publicState(op) {
    return {
      operationId: op.id,
      ownerId: op.ownerId,
      tabId: op.tabId,
      connection: op.connection,
      targetDb: op.targetDb,
      fingerprint: op.fingerprint,
      status: op.status,
      phase: op.phase,
      progress: op.progress.slice(),
      startedAt: op.startedAt,
      endedAt: op.endedAt,
      recovery: op.result && op.result.recovery || null,
      staging: op.result && op.result.staging || null,
      error: op.result && op.result.error || op.error || null,
      recoveryError: op.result && op.result.recoveryError || null,
      originalError: op.result && op.result.originalError || op.originalError || null,
      cleanupAt: op.cleanupAt || null,
      promotion: op.result && op.result.promotion || null,
      verification: op.result && op.result.verification || null,
    };
  }

  function requireOwned(operationId, ownerId) {
    const op = operations.get(String(operationId));
    if (!op || (ownerId != null && op.ownerId !== ownerId)) {
      throw new Error('Operazione di import non trovata.');
    }
    return op;
  }

  function start({ plan, adapter, ownerId, tabId, onProgress = () => {}, onSettled = () => {} }) {
    const operationId = String(id());
    const controller = new AbortController();
    const op = {
      id: operationId, ownerId, tabId, adapter, controller,
      connection: plan.connection || null, targetDb: plan.targetDb || null,
      fingerprint: plan.fingerprint, status: 'in_corso', phase: 'accettata',
      progress: [], startedAt: now(), endedAt: null, result: null, error: null,
      originalError: null,
      promise: null,
    };
    operations.set(operationId, op);

    const progress = (event) => {
      op.phase = event.phase || op.phase;
      op.progress.push({ ...event, at: now() });
      if (op.progress.length > 200) op.progress.shift();
      onProgress(publicState(op));
    };
    op.promise = Promise.resolve()
      .then(() => execute(plan, { adapter, signal: controller.signal, onProgress: progress }))
      .then((result) => {
        op.result = result;
        op.status = result.status;
        op.phase = 'terminata';
      })
      .catch((err) => {
        // Prima di ogni mutazione il motore puo' ancora rigettare: anche questo
        // e' un fallimento esplicito, mai un completato implicito.
        op.error = err.message;
        op.originalError = {
          code: err.code || null,
          codeName: err.codeName || null,
          target: err.target || null,
        };
        op.status = 'intervento_richiesto';
        op.phase = 'terminata';
      })
      .finally(async () => {
        op.endedAt = now();
        onProgress(publicState(op));
        await onSettled(publicState(op));
      });
    return publicState(op);
  }

  return {
    start,
    get(operationId, ownerId) { return publicState(requireOwned(operationId, ownerId)); },
    list(ownerId) {
      return [...operations.values()].filter((op) => ownerId == null || op.ownerId === ownerId).map(publicState);
    },
    cancel(operationId, ownerId) {
      const op = requireOwned(operationId, ownerId);
      if (op.status !== 'in_corso') return false;
      op.controller.abort();
      return true;
    },
    wait(operationId) { return requireOwned(operationId).promise; },
    async cleanup(operationId, ownerId, adapter = null) {
      const op = requireOwned(operationId, ownerId);
      if (op.status === 'in_corso') throw new Error('L’operazione è ancora in corso.');
      if (op.cleanupAt) return publicState(op);
      const cleaner = adapter || op.adapter;
      if (!cleaner || typeof cleaner.cleanup !== 'function') {
        throw new Error('La strategia non offre la pulizia esplicita di staging e recupero.');
      }
      await cleaner.cleanup(op.result);
      op.cleanupAt = now();
      return publicState(op);
    },
  };
}

module.exports = { createImportOperationRegistry };
