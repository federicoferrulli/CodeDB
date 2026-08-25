'use strict';

const { randomUUID } = require('crypto');
const { eseguiPianoImport } = require('./importPlan');

function sanitizeImportResult(result) {
  if (!result) return null;
  return {
    status: result.status, fingerprint: result.fingerprint,
    recovery: result.recovery ? {
      id: result.recovery.id || null, verified: result.recovery.verified === true,
      physicalDb: result.recovery.physicalDb || null,
    } : null,
    staging: result.staging ? {
      db: result.staging.db || null, retained: result.staging.retained === true,
    } : null,
    error: result.error || null, recoveryError: result.recoveryError || null,
    originalError: result.originalError || null, promotion: result.promotion || null,
    verification: result.verification || null,
  };
}

function createImportOperationRegistry({
  execute = eseguiPianoImport, id = randomUUID, now = () => new Date().toISOString(),
  retentionMs = 24 * 60 * 60 * 1000, maxTerminal = 100,
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (timer) => clearTimeout(timer),
} = {}) {
  const operations = new Map();

  function retainTerminal(op) {
    const timer = schedule(() => {
      op.retentionTimer = null;
      if (operations.get(op.id) === op && op.status !== 'in_corso') operations.delete(op.id);
    }, retentionMs);
    op.retentionTimer = timer;
    if (timer && typeof timer.unref === 'function') timer.unref();
    const terminal = [...operations.values()].filter((item) => item.status !== 'in_corso');
    while (terminal.length > maxTerminal) {
      const oldest = terminal.shift();
      if (oldest.retentionTimer) unschedule(oldest.retentionTimer);
      oldest.retentionTimer = null;
      operations.delete(oldest.id);
    }
  }

  function publicState(op) {
    const safeResult = sanitizeImportResult(op.result);
    return {
      operationId: op.id,
      tabId: op.tabId,
      connection: op.connection,
      targetDb: op.targetDb,
      fingerprint: op.fingerprint,
      status: op.status,
      phase: op.phase,
      progress: op.progress.slice(),
      startedAt: op.startedAt,
      endedAt: op.endedAt,
      recovery: safeResult && safeResult.recovery || null,
      staging: safeResult && safeResult.staging || null,
      error: safeResult && safeResult.error || op.error || null,
      recoveryError: safeResult && safeResult.recoveryError || null,
      originalError: safeResult && safeResult.originalError || op.originalError || null,
      cleanupAt: op.cleanupAt || null,
      promotion: op.result && op.result.promotion || null,
      verification: op.result && op.result.verification || null,
    };
  }

  function requireOwned(operationId, ownerId, actorId = null) {
    const op = operations.get(String(operationId));
    if (!op || (ownerId != null && op.ownerId !== ownerId)
        || (actorId != null && op.actorId !== actorId)) {
      throw new Error('Operazione di import non trovata.');
    }
    return op;
  }

  function start({ plan, adapter, ownerId, actorId = null, tabId, onProgress = () => {}, onSettled = () => {} }) {
    const operationId = String(id());
    const controller = new AbortController();
    const op = {
      id: operationId, ownerId, actorId, tabId, adapter, controller,
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
      try { onProgress(publicState(op)); } catch (_) { /* osservatore best-effort */ }
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
        try { onProgress(publicState(op)); } catch (_) { /* osservatore best-effort */ }
        try { await onSettled(publicState(op)); }
        finally {
          // La pulizia esplicita ricostruisce l'adapter dalla connessione corrente:
          // non trattenere strategy/sessione oltre la fine dell'operazione.
          op.adapter = null;
          retainTerminal(op);
        }
      });
    return publicState(op);
  }

  return {
    start,
    get(operationId, ownerId, actorId = null) { return publicState(requireOwned(operationId, ownerId, actorId)); },
    list(ownerId, actorId = null) {
      return [...operations.values()].filter((op) => (ownerId == null || op.ownerId === ownerId)
        && (actorId == null || op.actorId === actorId)).map(publicState);
    },
    cancel(operationId, ownerId, actorId = null) {
      const op = requireOwned(operationId, ownerId, actorId);
      if (op.status !== 'in_corso') return false;
      op.controller.abort();
      return true;
    },
    wait(operationId) { return requireOwned(operationId).promise; },
    async cleanup(operationId, ownerId, adapter = null, actorId = null) {
      const op = requireOwned(operationId, ownerId, actorId);
      if (op.status === 'in_corso') throw new Error('L’operazione è ancora in corso.');
      if (op.cleanupAt) return publicState(op);
      const cleaner = adapter || op.adapter;
      if (!cleaner || typeof cleaner.cleanup !== 'function') {
        throw new Error('La strategia non offre la pulizia esplicita di staging e recupero.');
      }
      await cleaner.cleanup(op.result);
      op.result = sanitizeImportResult(op.result);
      op.adapter = null;
      op.cleanupAt = now();
      return publicState(op);
    },
  };
}

module.exports = { createImportOperationRegistry, sanitizeImportResult };
