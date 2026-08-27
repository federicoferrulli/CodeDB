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
    if (v._bsontype === 'Long' || v._bsontype === 'Decimal128') return v.toString();
    if (v._bsontype === 'Int32' || v._bsontype === 'Double') return v.value;
    return JSON.stringify(v);
  }
  return v;
}

// Il client invia i valori in Extended JSON. `relaxed: false` conserva Long,
// Decimal128 e gli altri numeri tipizzati fino a `toSqlValue`, evitando che un
// intero oltre 2^53 venga prima arrotondato dal runtime JavaScript.
function parseClientValue(text) {
  return EJSON.parse(String(text), { relaxed: false });
}

function deserializeClientObject(obj) {
  return EJSON.deserialize(obj || {}, { relaxed: false });
}

// Le righe viaggiano verso il client come Extended JSON relaxed, come per
// MongoDB: le Date diventano { $date: ... } e il frontend le riconosce.
function serializeRow(row, columns = []) {
  const exact = new Map((columns || []).map((c) => [c.name, String(c.declaredType || c.type || '').toLowerCase()]));
  if (!exact.size) return EJSON.serialize(row, { relaxed: true });
  const out = { ...row };
  for (const [name, type] of exact) {
    const value = out[name];
    if (value === null || value === undefined || typeof value === 'object') continue;
    if (/(^|\W)(decimal|numeric|dec|fixed)(\W|$)/.test(type)) {
      out[name] = { $numberDecimal: String(value) };
    } else if (/(^|\W)(bigint|int8|bigserial)(\W|$)/.test(type)) {
      const testo = String(value);
      try {
        const n = BigInt(testo);
        out[name] = n >= -9223372036854775808n && n <= 9223372036854775807n
          ? { $numberLong: n.toString() }
          : { $numberDecimal: n.toString() };
      } catch { /* il driver ha restituito un valore non canonico: non inventare un tipo */ }
    }
  }
  return EJSON.serialize(out, { relaxed: true });
}

module.exports = {
  toSqlValue,
  parseClientValue,
  deserializeClientObject,
  serializeRow,
};
