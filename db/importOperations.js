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
      ...(result.staging.largeObjects?.length ? { largeObjects: result.staging.largeObjects.slice() } : {}),
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
  const pulizie = new Map();
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
      recoveryError: null, originalError: null, cleanupAt: voce.cleanupAt || null,
      errorePulizia: voce.errorePulizia || null,
      puliziaStorica: !Object.hasOwn(voce, 'risorse'),
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
    // Il diario trattiene le risorse ancora da pulire e la ricevuta di pulizia.
    const senzaRisorse = op.risorse ? op.risorse.length === 0 : !op.result?.recovery && !op.result?.staging;
    if (diario && !op.cleanupAt && op.status === 'completato' && !op.errorePulizia && senzaRisorse) {
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
      errorePulizia: op.errorePulizia || null,
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

  function start({ plan, adapter, ownerId, actorId = null, tabId, backupOriginId = null, onProgress = () => {}, onSettled = () => {} }) {
    if (closed) throw new Error('Registro import in chiusura.');
    const operationId = String(id());
    const controller = new AbortController();
    const op = {
      id: operationId, ownerId, actorId, tabId, adapter, controller, backupOriginId,
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
          connection: op.connection, backupOriginId, targetDb: op.targetDb, attore: actorId, tabId,
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
      .then(async (result) => {
        op.result = result;
        if (diario && adapter.inventarioPulizia && result.status !== 'intervento_richiesto') {
          try { op.risorse = await adapter.inventarioPulizia(result); }
          catch (err) { op.errorePulizia = 'Inventario incompleto. ' + err.message; }
        }
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
                risorse: op.risorse || null, errorePulizia: op.errorePulizia || null,
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
    async cleanup(operationId, ownerId, adapter = null, actorId = null, connessione = null) {
      const op = operations.get(String(operationId));
      const vista = this.get(operationId, ownerId, actorId);
      const voce = diario?.leggi({ ownerId, operationId });
      const origine = op?.backupOriginId || voce?.backupOriginId;
      if (origine ? connessione?.backupOriginId !== origine : connessione && connessione.connection !== vista.connection) {
        throw new Error('La connessione corrente non corrisponde a quella dell’import.');
      }
      if (vista.cleanupAt) return vista;
      if (vista.status === 'in_corso') throw new Error('L’operazione è ancora in corso.');
      if (vista.status === 'intervento_richiesto') throw new Error('Esito incerto: verificare la destinazione prima di pulire.');
      if (op) await op.promise;
      const cleaner = adapter || op?.adapter;
      const errorePulizia = op?.errorePulizia || voce?.errorePulizia;
      if (errorePulizia) throw new Error(errorePulizia);
      if (Array.isArray(voce?.risorse) || (voce && !Object.hasOwn(voce, 'risorse') && cleaner?.inventarioStorico)) {
        if (voce.cleanupAt) return daVoce(voce);
        if (pulizie.has(operationId)) return pulizie.get(operationId);
        const pulisci = async (aggiornata) => {
          if (aggiornata.cleanupAt) return daVoce(aggiornata);
          if (!Array.isArray(aggiornata.risorse)) {
            const verificate = await cleaner.inventarioStorico(aggiornata);
            diario.aggiornaPulizia({ ownerId, operationId, risorse: verificate });
            aggiornata.risorse = verificate;
          }
          const risorse = aggiornata.risorse.slice();
          while (risorse.length) {
            await cleaner.eliminaRisorsa(risorse[0]);
            risorse.shift();
            diario.aggiornaPulizia({ ownerId, operationId, risorse });
          }
          const cleanupAt = now();
          diario.aggiornaPulizia({ ownerId, operationId, risorse, cleanupAt });
          if (op) { op.cleanupAt = cleanupAt; op.result = sanitizeImportResult(op.result); }
          return { ...vista, cleanupAt };
        };
        const inCorso = diario.conPulizia({ ownerId, operationId }, pulisci).finally(() => pulizie.delete(operationId));
        pulizie.set(operationId, inCorso);
        return inCorso;
      }
      if (!op) throw new Error(vista.errorePulizia || 'Inventario privato delle risorse non disponibile.');
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
