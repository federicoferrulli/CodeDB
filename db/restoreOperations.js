'use strict';

const { createHash, randomUUID } = require('crypto');
const { sanitizeImportResult } = require('./importOperations');

// Si conservano soltanto valori pubblici, mai gli oggetti del driver o il
// risultato interno del piano. La copia impedisce a un osservatore di mutare
// la ricevuta che un altro client leggerà dopo la riconnessione.
function copiaPubblica(value, redact = value => value, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redact(value);
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map(item => copiaPubblica(item, redact, depth + 1));
  if (typeof value !== 'object') return null;
  const privateFields = new Set(['password', 'passwd', 'passphrase', 'secret', 'token', 'uri', 'url', 'effectiveCfg', 'strategy', 'principal', 'handshake', 'backupDir', 'recoveryRoot', 'path']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateFields.has(key)).map(([key, item]) => [key, copiaPubblica(item, redact, depth + 1)]));
}

function sanitizeRestoreResult(summary, redact) {
  if (!summary) return null;
  const safe = sanitizeImportResult(summary);
  return copiaPubblica({
    ...safe,
    originalError: summary.originalError ? { code: summary.originalError.code || null, codeName: summary.originalError.codeName || null, target: summary.originalError.target || null } : null,
    targetDb: summary.targetDb, totalDocs: summary.totalDocs, layers: summary.layers,
    equivalenza: summary.equivalenza, equivalenzaDati: summary.equivalenzaDati,
    coerenzaSchema: summary.coerenzaSchema,
  }, redact);
}

function improntaRipristino(request) {
  // Il chiamante passa solo parametri già normalizzati e provenienti dalla
  // sessione autorizzata. Il percorso privato resta nell'hash, non nel record.
  return createHash('sha256').update(JSON.stringify([
    request.connection, request.dbType, request.backupDir, request.targetDb,
    request.drop, request.collections, request.recoveryRoot,
  ])).digest('hex');
}

function createRestoreOperationRegistry({ now = () => new Date().toISOString(), retentionMs = 24 * 60 * 60 * 1000, maxTerminal = 100 } = {}) {
  const operations = new Map();
  let closed = false;
  const keyOf = (id, ownerId, actorId) => JSON.stringify([ownerId ?? null, actorId ?? null, id]);
  const validId = id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id);
  function owned(id, ownerId, actorId) {
    const record = validId(id) && operations.get(keyOf(id, ownerId, actorId));
    if (!record) throw new Error('Operazione di ripristino non trovata.');
    return record;
  }
  function publicState(record) {
    return copiaPubblica({
      ...record.ack?.summary,
      operationId: record.id, tabId: record.tabId, connection: record.connection,
      backupId: record.backupId, targetDb: record.ack?.summary?.targetDb ?? record.targetDb,
      status: record.status, phase: record.phase, progress: record.progress,
      startedAt: record.startedAt, endedAt: record.endedAt,
      error: record.ack?.summary?.error || record.ack?.error || null,
    });
  }
  function retain(record) {
    record.timer = setTimeout(() => operations.delete(record.key), retentionMs);
    record.timer.unref?.();
    const terminal = [...operations.values()].filter(item => item.endedAt != null);
    while (terminal.length > maxTerminal) {
      const first = terminal.shift(); clearTimeout(first.timer); operations.delete(first.key);
    }
  }
  function start({ operationId = randomUUID(), ownerId, actorId, tabId, connection, backupId, targetDb, fingerprint, execute }) {
    if (closed) throw new Error('Registro ripristini in chiusura.');
    if (!validId(operationId)) throw new Error('Identificatore del ripristino non valido.');
    const key = keyOf(operationId, ownerId, actorId), previous = operations.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Identificatore di ripristino già usato per una richiesta diversa.');
      return previous.promise || Promise.resolve(copiaPubblica(previous.ack));
    }
    let settle;
    const completion = new Promise(resolve => { settle = resolve; });
    const record = { key, id: operationId, ownerId, actorId, tabId, connection, backupId, targetDb, fingerprint,
      status: 'in_corso', phase: 'accettata', progress: [], startedAt: now(), endedAt: null, ack: null, promise: completion, timer: null };
    operations.set(key, record);
    const progress = event => {
      if (record.endedAt != null) return;
      const safe = copiaPubblica({ phase: event.phase, status: event.status, count: event.count, riga: event.riga, errore: event.errore, at: now() });
      record.phase = safe.phase || record.phase;
      record.progress.push(safe);
      if (record.progress.length > 200) record.progress.shift();
    };
    const conclude = ack => {
      record.ack = copiaPubblica(ack);
      record.status = ack.ok && ['completato', 'ripristinato_dopo_errore', 'intervento_richiesto'].includes(ack.summary?.status)
        ? ack.summary.status : 'intervento_richiesto';
      record.phase = 'terminata'; record.endedAt = now();
      // Nessuna promise/callback di esecuzione nel record terminale: il suo
      // ambiente può contenere sessione, driver e credenziali.
      record.promise = null;
      retain(record); settle(copiaPubblica(record.ack));
    };
    try {
      // Invocazione sincrona: la lease viene presa prima del primo await e
      // dopo la registrazione, così un duplicato non può avviare altro lavoro.
      Promise.resolve(execute(progress, operationId)).then(conclude, error => conclude({ ok: false, error: String(error?.message || error) }));
    } catch (error) { conclude({ ok: false, error: String(error?.message || error) }); }
    return completion;
  }
  return {
    start,
    get: (id, ownerId, actorId) => publicState(owned(id, ownerId, actorId)),
    list: (ownerId, actorId) => [...operations.values()].filter(record => record.ownerId === ownerId && record.actorId === actorId).map(publicState),
    async close() {
      closed = true;
      await Promise.allSettled([...operations.values()].map(record => record.promise).filter(Boolean));
      for (const record of operations.values()) clearTimeout(record.timer);
      operations.clear();
    },
  };
}

module.exports = { createRestoreOperationRegistry, sanitizeRestoreResult, improntaRipristino };
