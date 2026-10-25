'use strict';

const BSON = require('bson');
const FIELD = '__codedbSchemaBson';
const MAX_BYTES = 16 * 1024 * 1024;

// I metadati sono documenti BSON, come i dati: un oggetto letterale con chiavi
// $numberLong o $regularExpression non è necessariamente un valore tipizzato.
// Il gemello EJSON resta leggibile; il sidecar elimina questa ambiguità.
function codificaMetadati(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, FIELD)) {
    throw new Error('Metadati BSON di schema non validi.');
  }
  const raw = BSON.serialize(value, { ignoreUndefined: false });
  if (raw.length > MAX_BYTES) throw new Error('Metadati BSON di schema oltre il limite di 16 MiB.');
  const native = BSON.deserialize(raw, { promoteValues: false, validation: { utf8: true } });
  return { ...BSON.EJSON.serialize(native, { relaxed: false }), [FIELD]: { version: '1', base64: raw.toString('base64') } };
}

// I writer CodeDB usano i tag EJSON v2. $regex/$options è invece sintassi di
// query o un documento letterale, anche nei vecchi archivi senza sidecar.
function decodificaLegacy(value) {
  if (Array.isArray(value)) return value.map(decodificaLegacy);
  if (!value || typeof value !== 'object') return BSON.EJSON.deserialize(value, { relaxed: false });
  const tags = ['$oid', '$binary', '$uuid', '$symbol', '$numberInt', '$numberDecimal', '$numberDouble',
    '$numberLong', '$minKey', '$maxKey', '$regularExpression', '$timestamp', '$date', '$undefined', '$dbPointer'];
  if (tags.some(key => Object.hasOwn(value, key))) return BSON.EJSON.deserialize(value, { relaxed: false });
  if (Object.hasOwn(value, '$code')) return new BSON.Code(value.$code,
    value.$scope === undefined ? undefined : decodificaLegacy(value.$scope));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodificaLegacy(item)]));
}

function decodificaMetadati(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Metadati BSON di schema non validi.');
  if (!Object.hasOwn(value, FIELD)) return decodificaLegacy(BSON.EJSON.serialize(value, { relaxed: false }));
  const sidecar = value[FIELD];
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)
      || sidecar.version !== '1' || typeof sidecar.base64 !== 'string'
      || Object.keys(sidecar).length !== 2 || !Object.hasOwn(sidecar, 'base64')) {
    throw new Error('Sidecar BSON di schema non valido o versione non supportata.');
  }
  if (sidecar.base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('Metadati BSON di schema oltre il limite di 16 MiB.');
  const raw = Buffer.from(sidecar.base64, 'base64');
  if (raw.toString('base64') !== sidecar.base64 || raw.length < 5 || raw.length > MAX_BYTES
      || raw.readInt32LE(0) !== raw.length || raw[raw.length - 1] !== 0) throw new Error('Sidecar BSON di schema malformato.');
  const native = BSON.deserialize(raw, { promoteValues: false, validation: { utf8: true } });
  if (Object.hasOwn(native, FIELD)) throw new Error('Sidecar BSON di schema annidato non ammesso.');
  const readable = Object.fromEntries(Object.entries(value).filter(([key]) => key !== FIELD));
  if (JSON.stringify(readable) !== JSON.stringify(BSON.EJSON.serialize(native, { relaxed: false }))) {
    throw new Error('Metadati EJSON diversi dalla copia BSON di schema.');
  }
  return native;
}

function normalizzaMetadati(value) {
  const copy = BSON.EJSON.serialize(value, { relaxed: false });
  // La versione del sidecar è metadato del formato JSON, non un numero BSON.
  if (Object.hasOwn(value, FIELD)) copy[FIELD] = { ...value[FIELD] };
  decodificaMetadati(copy);
  return copy;
}

// Prima si distinguono i valori BSON dai documenti; solo dopo si emette JSON.
// Così un Long e il documento letterale {$numberLong:"..."} restano diversi.
function documentoCanonico(value) {
  if (Array.isArray(value)) return value.map(documentoCanonico);
  if (value && (value._bsontype || value instanceof Date || value instanceof RegExp || Buffer.isBuffer(value))) {
    return { bson: BSON.EJSON.serialize(value, { relaxed: false }) };
  }
  if (value && typeof value === 'object') {
    return { documento: Object.entries(value).map(([key, item]) => [key, documentoCanonico(item)]) };
  }
  return typeof value === 'number' ? { bson: BSON.EJSON.serialize(value, { relaxed: false }) } : value;
}

module.exports = { FIELD, MAX_BYTES, codificaMetadati, decodificaMetadati, normalizzaMetadati, documentoCanonico };
