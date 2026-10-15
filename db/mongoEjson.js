'use strict';
const { EJSON } = require('bson');
// Relaxed EJSON arrotonda Long oltre 2^53. Conserva il wrapper di quei tipi
// lungo tutto il trasporto, senza trasformare ogni normale numero JS in BSON.
function serializza(value) {
  if (value?._bsontype === 'Long') return Number.isSafeInteger(value.toNumber()) ? value.toNumber() : EJSON.serialize(value, { relaxed: false });
  if (value?._bsontype || value instanceof Date || Buffer.isBuffer(value)) return EJSON.serialize(value, { relaxed: true });
  if (Array.isArray(value)) return value.map(serializza);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializza(v)]));
  return value;
}
module.exports = { serializza };
