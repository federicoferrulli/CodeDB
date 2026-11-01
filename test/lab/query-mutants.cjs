'use strict';

// Guasti deliberati caricati SOLO nel processo usa-e-getta del laboratorio.
// Il codice di produzione sul disco rimane intatto; gli oracoli nativi non
// caricano questo modulo e devono riconoscere la corruzione introdotta.
const mutant = process.env.LAB_QUERY_MUTANT;
if (mutant === 'perdita-riga') {
  const Strategy = require('../../db/MongoDbStrategy');
  for (const metodo of ['collectionAggregate', 'collectionFind', 'mongoSqlRead']) {
    const originale = Strategy.prototype[metodo];
    Strategy.prototype[metodo] = async function (...args) {
      const result = await originale.apply(this, args);
      if (result.docs?.length > 1) result.docs = result.docs.slice(1);
      return result;
    };
  }
} else if (mutant === 'update-saltato') {
  const Strategy = require('../../db/MySqlStrategy');
  Strategy.prototype.docUpdate = async function () { return { matched: 1, modified: 1 }; };
} else if (mutant === 'join-deduplicato') {
  const Engine = require('../../db/VirtualJoinEngine');
  const originale = Engine.execute;
  Engine.execute = async function (...args) {
    const rows = await originale.apply(this, args);
    const viste = new Set();
    return rows.filter(row => { if (viste.has(row.id)) return false; viste.add(row.id); return true; });
  };
} else if (mutant === 'array-cifre') {
  const valori = require('../../db/pg-valori');
  const { parseClientValue } = require('../../db/sqlValori');
  // Ripristina il parsing approssimato del testo prima del binding array.
  valori.valoreDalJson = (text, column) => valori.valorePostgres(parseClientValue(text), column);
} else if (mutant) {
  throw new Error(`Mutazione laboratorio sconosciuta: ${mutant}`);
}
