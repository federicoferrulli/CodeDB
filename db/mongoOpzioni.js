'use strict';

// Opzioni di lettura condivise da shell singola, script e driver. I campi
// interni di CodeDB (runId, opHandle, maxRows) non arrivano mai dal documento.
const COMUNI = ['allowDiskUse', 'batchSize', 'collation', 'comment', 'hint', 'maxTimeMS',
  'readConcern', 'readPreference', 'let'];
function opzioniLettura(valore, aggregate = false) {
  if (valore == null) return {};
  if (typeof valore !== 'object' || Array.isArray(valore)) throw new Error('Le opzioni MongoDB devono essere un documento.');
  const ammesse = new Set([...COMUNI, ...(aggregate ? ['bypassDocumentValidation'] : ['min', 'max', 'returnKey', 'showRecordId'])]);
  for (const k of Object.keys(valore)) {
    if (!ammesse.has(k)) throw new Error(`Opzione MongoDB non gestita: "${k}".`);
  }
  const result = { ...valore };
  for (const k of ['maxTimeMS', 'batchSize']) {
    if (valore[k] == null) continue;
    const v = typeof valore[k] === 'number' ? valore[k]
      : ['Int32', 'Double', 'Long', 'Decimal128'].includes(valore[k]?._bsontype) ? Number(valore[k].toString()) : NaN;
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${k} richiede un intero non negativo.`);
    result[k] = v;
  }
  return result;
}

function opzioniDriver(opzioni, payload, timeout) {
  for (const key of ['limit', 'skip', 'batchSize', 'maxTimeMS', 'maxAwaitTimeMS', 'maxCommitTimeMS', 'timeoutMS']) {
    const value = opzioni[key];
    if (value?._bsontype && ['Int32', 'Double', 'Long', 'Decimal128'].includes(value._bsontype)) {
      const number = Number(value.toString());
      if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${key} richiede un intero non negativo.`);
      opzioni[key] = number;
    }
  }
  const session = require('./mongoSessioneScript').attiva();
  if (session && !opzioni.session) opzioni.session = session;
  const runId = payload.runId || payload.opHandle?.runId;
  const comment = opzioni.comment ?? payload.comment;
  if (runId) opzioni.comment = comment === undefined ? runId : { codedbRunId: runId, comment };
  else if (comment !== undefined) opzioni.comment = comment;
  // Una query può restringere il timeout, mai disabilitare il tetto del server.
  if (timeout > 0) opzioni.maxTimeMS = opzioni.maxTimeMS > 0 ? Math.min(timeout, opzioni.maxTimeMS) : timeout;
  return opzioni;
}

module.exports = { opzioniLettura, opzioniDriver };
