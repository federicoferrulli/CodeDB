'use strict';

const assert = require('assert');
const { deserializeClientObject, serializeRow, toSqlValue } = require('../db/sqlValori');

const valori = deserializeClientObject({
  id: { $numberLong: '9007199254740993' },
  importo: { $numberDecimal: '1234567890.123456789012345678' },
});
assert.strictEqual(toSqlValue(valori.id), '9007199254740993');
assert.strictEqual(toSqlValue(valori.importo), '1234567890.123456789012345678');
assert.deepStrictEqual(serializeRow({ id: '9007199254740993', totale: '0.100000000000000001' }, [
  { name: 'id', declaredType: 'bigint' }, { name: 'totale', type: 'numeric' },
]), {
  id: { $numberLong: '9007199254740993' },
  totale: { $numberDecimal: '0.100000000000000001' },
});
console.log('  OK   parametri SQL esatti: Long e Decimal arrivano al driver come testo canonico');
