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

const { EJSON, Binary } = require('bson');

// EJSON non riconosce i Buffer dei driver SQL: senza questo confine enumera
// ogni byte come proprietà JSON. Copiamo soltanto i contenitori modificati;
// le viste binarie mantengono offset e lunghezza, senza copiare i byte.
function preparaBinariEjson(value, visti) {
  if (value instanceof Uint8Array) return new Binary(value);
  if (!value || typeof value !== 'object') return value;
  if (value._bsontype === 'Binary') {
    return value.position === value.buffer.byteLength ? value : new Binary(value.value(), value.sub_type);
  }
  if (value._bsontype || value instanceof Date || value instanceof RegExp) return value;
  visti ||= new WeakMap();
  if (visti.has(value)) return visti.get(value);
  let out = value;
  visti.set(value, out);
  for (const key of Object.keys(value)) {
    const next = preparaBinariEjson(value[key], visti);
    if (next === value[key]) continue;
    if (out === value) {
      out = Array.isArray(value) ? value.slice() : { ...value };
      visti.set(value, out);
    }
    Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function bufferSql(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Converte un valore proveniente dal client (già "deserializzato" da EJSON) in
// un parametro SQL sicuro: i tipi primitivi, Date e Buffer passano invariati,
// oggetti e array diventano testo JSON (utile per le colonne JSON), il tipo
// BSON Binary torna a essere un Buffer.
function toSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return bufferSql(v);
  if (typeof v === 'object') {
    if (Object.keys(v).length === 1 && typeof v.$numberDecimal === 'string') return v.$numberDecimal;
    if (v._bsontype === 'Binary') return bufferSql(v.value());
    if (v._bsontype === 'Long' || v._bsontype === 'Decimal128') return v.toString();
    if (v._bsontype === 'Int32' || v._bsontype === 'Double') return v.value;
    // Nei documenti JSON un Long annidato deve conservare il wrapper EJSON:
    // JSON.stringify da solo ne esporrebbe i campi interni low/high/unsigned.
    return JSON.stringify(v, (_key, value) => value && value._bsontype === 'Long'
      ? { $numberLong: value.toString() } : value);
  }
  return v;
}

// Il client invia i valori in Extended JSON. `relaxed: false` conserva Long,
// Decimal128 e gli altri numeri tipizzati fino a `toSqlValue`, evitando che un
// intero oltre 2^53 venga prima arrotondato dal runtime JavaScript.
function parseClientValue(text) {
  const originale = JSON.parse(String(text));
  return deserializeClientObject(originale);
}

function deserializeClientObject(obj) {
  // NUMERIC SQL non ha il limite di 34 cifre di Decimal128 BSON.
  function leggi(value) {
    if (!value || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && typeof value.$numberDecimal === 'string') {
      const text = value.$numberDecimal;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^(?:NaN|[+-]?Infinity)$/.test(text)) throw new Error('Numero EJSON non valido.');
      try { return EJSON.deserialize(value, { relaxed: false }); }
      catch { return { $numberDecimal: text }; }
    }
    if (Object.keys(value).some(k => k.startsWith('$'))) {
      return numeriNativi(EJSON.deserialize(value, { relaxed: false }), value);
    }
    return Array.isArray(value) ? value.map(leggi) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, leggi(v)]));
  }
  // Gli oggetti JSON annidati mantengono i wrapper, come prima della conversione SQL.
  return leggi(obj);
}

// La lettura canonica protegge Long, ma incapsula anche le coordinate e i
// numeri JSON ordinari. Int32 e Double sono già rappresentabili come Number;
// Long e Decimal128 restano tipizzati fino alla conversione del parametro SQL.
function numeriNativi(value, originale) {
  // EJSON canonico converte anche 2147483648 in Long: un numero JSON
  // ordinario conserva la propria forma, un $numberLong esplicito no.
  if (typeof originale === 'number') return originale;
  if (!value || typeof value !== 'object') return value;
  if (value._bsontype === 'Int32' || value._bsontype === 'Double') return value.value;
  if (value._bsontype || value instanceof Date || Buffer.isBuffer(value)) return value;
  for (const key of Object.keys(value)) value[key] = numeriNativi(value[key], originale?.[key]);
  return value;
}

// Una riga letta include le colonne calcolate e, negli schemi storici, l'id
// virtuale. La scrittura conserva invece ogni colonna reale, anche `_id`.
function documentoScrivibile(doc, columns) {
  const generate = new Set(columns.filter(c => c.generated).map(c => c.name));
  if (!columns.some(c => c.name === '_id')) generate.add('_id');
  for (const key of generate) delete doc[key];
  return doc;
}

// Le righe viaggiano verso il client come Extended JSON relaxed, come per
// MongoDB: le Date diventano { $date: ... } e il frontend le riconosce.
function serializeRow(row, columns = []) {
  row = preparaBinariEjson(row);
  const cols = Array.isArray(columns) ? columns : [];
  const exact = new Map(cols.map((c) => [c && c.name, String((c && (c.declaredType || c.type || c.columnType || c.dataType)) || '').toLowerCase()]));
  const arrayColumns = new Set(cols.filter(c => c?.pgType?.kind === 'array').map(c => c.name));
  if (!exact.size) return EJSON.serialize(row, { relaxed: true });
  const out = { ...row };
  for (const [name, type] of exact) {
    if (!name) continue;
    // Il testo nativo di un array NUMERIC/BIGINT non è un numero scalare.
    if (/\[\]$/.test(type) || arrayColumns.has(name)) continue;
    const value = out[name];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !value._bsontype) continue;
    if (/(^|\W)(decimal|numeric|dec|fixed)(\W|$)/.test(type)) {
      out[name] = { $numberDecimal: String(value) };
    } else if (/(^|\W)(bigint|int8|bigserial|serial8|int64|long)(\W|$)/.test(type)) {
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
  preparaBinariEjson,
  toSqlValue,
  parseClientValue,
  deserializeClientObject,
  serializeRow,
  documentoScrivibile,
};
