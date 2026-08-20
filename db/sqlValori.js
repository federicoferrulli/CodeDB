'use strict';

/* ---------------------------------------------------------------------------
 * Il confine fra Extended JSON e i parametri SQL.
 *
 * Il client parla EJSON con TUTTI i motori (vedi la convenzione in CLAUDE.md):
 * `$oid`, `$date`, `$numberLong` non sono un dettaglio di MongoDB ma il
 * protocollo del trasporto. Tradurre da quel protocollo ai parametri che un
 * driver SQL accetta — e ritradurre le righe che tornano — è quindi una
 * decisione del PROTOCOLLO, non del dialetto: `mysql2` e `pg` accettano
 * entrambi primitivi, `Date` e `Buffer`, e rifiutano entrambi un oggetto.
 *
 * Queste quattro funzioni erano infatti byte per byte identiche nei due
 * adattatori. Sono qui per la stessa ragione delle quattro di
 * `db/sqlTabellare.js`: correggerne una richiedeva due modifiche, e nulla
 * segnalava la seconda.
 *
 * Restano fuori le conversioni che il dialetto decide davvero — le geometrie
 * (`db/geometry.js`, `db/pg-geo-nativo.js`), che su PostgreSQL hanno un
 * formato nativo che su MySQL non esiste.
 * ------------------------------------------------------------------------- */

const { EJSON } = require('bson');

// Converte un valore proveniente dal client (già "deserializzato" da EJSON) in
// un parametro SQL sicuro: i tipi primitivi, Date e Buffer passano invariati,
// oggetti e array diventano testo JSON (utile per le colonne JSON), il tipo
// BSON Binary torna a essere un Buffer.
function toSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') {
    if (v._bsontype === 'Binary') return v.buffer;
    return JSON.stringify(v);
  }
  return v;
}

// Il client invia i valori in Extended JSON: relaxed = true produce tipi
// JavaScript nativi (numeri normali, Date per $date), quelli che servono come
// parametri SQL.
function parseClientValue(text) {
  return EJSON.parse(String(text), { relaxed: true });
}

function deserializeClientObject(obj) {
  return EJSON.deserialize(obj || {}, { relaxed: true });
}

// Le righe viaggiano verso il client come Extended JSON relaxed, come per
// MongoDB: le Date diventano { $date: ... } e il frontend le riconosce.
function serializeRow(row) {
  return EJSON.serialize(row, { relaxed: true });
}

module.exports = {
  toSqlValue,
  parseClientValue,
  deserializeClientObject,
  serializeRow,
};
