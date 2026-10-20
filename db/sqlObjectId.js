'use strict';

const { ObjectId } = require('bson');

// Una costante SQL esadecimale può identificare sia una stringa sia un
// ObjectId. Conserviamo entrambe: una collezione può contenere i due tipi.
function varianti(valore) {
  return typeof valore === 'string' && /^[0-9a-fA-F]{24}$/.test(valore)
    ? [valore, new ObjectId(valore)] : [valore];
}

function filtro(colonna, operatore, valore) {
  const valori = varianti(valore);
  if (valori.length === 1) return { [colonna]: { [operatore]: valore } };
  if (operatore === '$eq' || operatore === '$ne') return { [colonna]: { [operatore === '$eq' ? '$in' : '$nin']: valori } };
  return { $or: valori.map(v => ({ [colonna]: { [operatore]: v } })) };
}

// Nelle espressioni ($expr, SELECT, CASE...) conta il tipo della singola
// riga, senza campionare lo schema né convertire campi o valori da salvare.
function operandi(a, b) {
  const adatta = (valore, altro) => {
    const oid = varianti(valore?.$literal)[1];
    return oid ? { $cond: [{ $eq: [{ $type: altro }, 'objectId'] }, { $literal: oid }, valore] } : valore;
  };
  return [adatta(a, b), adatta(b, a)];
}

module.exports = { varianti, filtro, operandi };
