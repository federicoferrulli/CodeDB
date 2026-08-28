'use strict';

const { EJSON } = require('bson');

// Un insert MongoDB accetta il documento singolo usato dalla griglia oppure
// un elenco non vuoto usato dal gateway MCP. La stessa regola di forma viene
// applicata in anteprima e subito prima di chiamare il driver.
function normalizzaDocumentiInsert(value) {
  const multiplo = Array.isArray(value);
  const documentoNonValido = (doc) => !doc || typeof doc !== 'object' || Array.isArray(doc)
    || (Object.getPrototypeOf(doc) !== Object.prototype && Object.getPrototypeOf(doc) !== null);

  if (multiplo) {
    if (!value.length || value.some(documentoNonValido)) {
      throw new Error('Array JSON non valido: atteso un elenco non vuoto di documenti { "campo": valore }.');
    }
    return { documenti: value, multiplo: true };
  }
  if (documentoNonValido(value)) {
    throw new Error('Documento JSON non valido: attesa una coppia { "campo": valore }.');
  }
  return { documenti: [value], multiplo: false };
}

function valoriInsertedIds(ids) {
  if (ids instanceof Map) return [...ids.values()];
  return ids && typeof ids === 'object' ? Object.values(ids) : [];
}

// MongoBulkWriteError espone il BulkWriteResult delle operazioni riuscite
// prima dell'errore. Lo si normalizza nello stesso formato del successo così
// l'audit può dichiarare una mutazione parziale invece di registrare soltanto
// "failed" come se il database fosse rimasto intatto.
function risultatoInsertMany(result, insertedDocs) {
  if (!result && !Array.isArray(insertedDocs)) return null;
  let ids = valoriInsertedIds(result && result.insertedIds);
  if (!ids.length && Array.isArray(insertedDocs)) ids = insertedDocs.map((doc) => doc && doc._id).filter(Boolean);
  const insertedCount = Number(result && result.insertedCount != null
    ? result.insertedCount : Array.isArray(insertedDocs) ? insertedDocs.length : ids.length);
  return { insertedCount, insertedIds: ids.map((id) => EJSON.stringify(id)) };
}

module.exports = { normalizzaDocumentiInsert, risultatoInsertMany };
