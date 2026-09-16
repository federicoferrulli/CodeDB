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
  // Diario durevole per tenant (db/diarioOperazioni): senza, un riavvio
  // dimentica le operazioni in volo con staging e recupero penzolanti.
  // Opzionale così i contesti finti dei test restano leggeri.
  diario = null,
  // Periodo del battito sul diario: comodamente sotto la finestra di grazia
  // con cui `riconcilia` dichiara orfana una voce.
  battitoMs = 15 * 1000,
} = {}) {
  const operations = new Map();
  let closed = false;

  // Una voce di diario ha gli stessi nomi dello stato pubblico: la lettura
  // dopo un crash non deve imparare due forme.
  function daVoce(voce) {
    return {
      operationId: voce.operationId, tabId: voce.tabId || null,
      connection: voce.connection, targetDb: voce.targetDb, fingerprint: voce.fingerprint,
      status: voce.status, phase: voce.phase, progress: voce.progress || [],
      startedAt: voce.iniziatoAl, endedAt: voce.terminatoAl,
      recovery: voce.recovery, staging: voce.staging, error: voce.errore,
      recoveryError: null, originalError: null, cleanupAt: null,
      promotion: null, verification: null, esitoIncerto: voce.esitoIncerto === true,
    };
  }

  // Le letture guariscono lo stato dopo un crash: riconciliare è idempotente,
  // quindi la prima lettura dopo il riavvio dichiara l'incertezza una volta
  // sola e le successive la mostrano.
  function guarisci(ownerId) {
    if (!diario || ownerId == null) return;
    diario.riconcilia(ownerId);
  }

  function voceVisibile(voce, ownerId, actorId = null) {
    if (!voce) return null;
    if (ownerId != null && voce.ownerId !== ownerId) return null;
    if (actorId != null && voce.attore !== actorId) return null;
    return daVoce(voce);
  }

  function dimentica(op) {
    // Il diario si rimuove solo a pulizia esplicita o a esito conservato:
    // una voce d'errore col recupero penzolante non si cancella da sola.
    if (diario && (op.cleanupAt || op.status === 'completato')) {
      try { diario.rimuovi({ ownerId: op.ownerId, operationId: op.id }); } catch (_) { /* già sparita */ }
    }
  }

  function retainTerminal(op) {
    const timer = schedule(() => {
      op.retentionTimer = null;
      if (operations.get(op.id) === op && op.status !== 'in_corso') {
        operations.delete(op.id);
        dimentica(op);
      }
    }, retentionMs);
    op.retentionTimer = timer;
    if (timer && typeof timer.unref === 'function') timer.unref();
    const terminal = [...operations.values()].filter((item) => item.status !== 'in_corso');
    while (terminal.length > maxTerminal) {
      const oldest = terminal.shift();
      if (oldest.retentionTimer) unschedule(oldest.retentionTimer);
      oldest.retentionTimer = null;
      operations.delete(oldest.id);
      dimentica(oldest);
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
    if (closed) throw new Error('Registro import in chiusura.');
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
    if (diario) {
      try {
        diario.registra({
          ownerId, operationId, fingerprint: plan.fingerprint,
          connection: op.connection, targetDb: op.targetDb, attore: actorId, tabId,
        });
      } catch (_) { /* il diario non ferma l'operazione: la memoria resta */ }
    }

    // Battito: finché l'operazione lavora, il diario deve poterla distinguere
    // da una lasciata a metà da un crash — anche durante una fase lunga e
    // silenziosa, dove nessun evento di avanzamento arriva.
    let battito = null;
    const batti = () => {
      if (!diario || op.status !== 'in_corso') return;
      try { diario.batte({ ownerId, operationId }); } catch (_) { /* vedi sotto */ }
      battito = schedule(batti, battitoMs);
      if (battito && typeof battito.unref === 'function') battito.unref();
    };
    if (diario) batti();

    const progress = (event) => {
      const faseCambiata = event.phase && event.phase !== op.phase;
      op.phase = event.phase || op.phase;
      op.progress.push({ ...event, at: now() });
      if (op.progress.length > 200) op.progress.shift();
      if (faseCambiata && diario) {
        try { diario.fase({ ownerId, operationId, phase: op.phase, progress: op.progress }); } catch (_) { /* vedi sopra */ }
      }
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
          if (battito) { unschedule(battito); battito = null; }
          if (diario) {
            const finale = sanitizeImportResult(op.result);
            try {
              diario.conclude({
                ownerId, operationId, status: op.status,
                recovery: finale && finale.recovery, staging: finale && finale.staging,
                errore: (finale && finale.error) || op.error,
              });
            } catch (_) { /* vedi sopra */ }
          }
          // La pulizia esplicita ricostruisce l'adapter dalla connessione corrente:
          // non trattenere strategy/sessione oltre la fine dell'operazione.
          op.adapter = null;
          retainTerminal(op);
        }
      });
    return publicState(op);
  }

  return {
    async close() {
      closed = true;
      await Promise.allSettled([...operations.values()].map(op => op.promise));
      for (const op of operations.values()) if (op.retentionTimer) unschedule(op.retentionTimer);
      operations.clear();
    },
    start,
    get(operationId, ownerId, actorId = null) {
      try {
        return publicState(requireOwned(operationId, ownerId, actorId));
      } catch (mancata) {
        if (!diario) throw mancata;
        guarisci(ownerId);
        const vista = voceVisibile(diario.leggi({ ownerId, operationId }), ownerId, actorId);
        if (!vista) throw mancata;
        return vista;
      }
    },
    list(ownerId, actorId = null) {
      const inMemoria = [...operations.values()].filter((op) => (ownerId == null || op.ownerId === ownerId)
        && (actorId == null || op.actorId === actorId)).map(publicState);
      if (!diario || ownerId == null) return inMemoria;
      guarisci(ownerId);
      const visti = new Set(inMemoria.map((op) => op.operationId));
      const dalDiario = diario.elenca(ownerId)
        .map((voce) => voceVisibile(voce, ownerId, actorId))
        .filter((vista) => vista && !visti.has(vista.operationId));
      return [...inMemoria, ...dalDiario];
    },
    cancel(operationId, ownerId, actorId = null) {
      const op = requireOwned(operationId, ownerId, actorId);
      if (op.status !== 'in_corso') return false;
      op.controller.abort();
      return true;
    },
    wait(operationId, ownerId = null) {
      try {
        return requireOwned(operationId).promise;
      } catch (mancata) {
        // Fuori memoria c'è il diario: esito già scritto, niente da attendere.
        // Un id che non esiste NEMMENO lì resta un errore: ingoiarlo farebbe
        // passare per «già conclusa» un'operazione mai avviata.
        if (diario && diario.leggi({ ownerId, operationId })) return Promise.resolve(null);
        throw mancata;
      }
    },
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
      if (diario) {
        try { diario.rimuovi({ ownerId, operationId }); } catch (_) { /* già sparita */ }
      }
      return publicState(op);
    },
  };
}

module.exports = { createImportOperationRegistry, sanitizeImportResult };
