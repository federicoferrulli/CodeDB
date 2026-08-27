'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

module.exports = (async () => {
  const V = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'valori-esatti.js')).href);
  console.log('--- Test unitari codec dei valori esatti ---');

  const casi = [
    ['-9223372036854775808', { type: 'bigint' }, { $numberLong: '-9223372036854775808' }],
    ['9223372036854775807', { type: 'int8' }, { $numberLong: '9223372036854775807' }],
    ['18446744073709551615', { type: 'bigint unsigned' }, { $numberDecimal: '18446744073709551615' }],
    ['9007199254740993', { wrapper: '$numberLong' }, { $numberLong: '9007199254740993' }],
    ['1234567890.123456789012345678', { type: 'decimal(38,18)' },
      { $numberDecimal: '1234567890.123456789012345678' }],
  ];
  for (const [testo, metadato, atteso] of casi) {
    assert.deepStrictEqual(V.decodificaNumeroEsatto(testo, metadato), atteso, testo);
  }

  assert.strictEqual(V.decodificaNumeroEsatto('12.5', { type: 'double' }), 12.5);
  assert.throws(() => V.decodificaNumeroEsatto('9223372036854775808', { type: 'bigint' }), /intervallo/i);
  assert.throws(() => V.decodificaNumeroEsatto('-1', { type: 'bigint unsigned' }), /intervallo/i);
  assert.throws(() => V.decodificaNumeroEsatto('1.2.3', { type: 'decimal' }), /decimale/i);

  const long = { $numberLong: '9007199254740993' };
  assert.deepStrictEqual(V.metadatoNumerico(long), { wrapper: '$numberLong' });
  assert.strictEqual(V.testoNumeroEsatto(long), '9007199254740993');
  assert.deepStrictEqual(V.decodificaTemporale('2026-10-25T01:30:00Z', 'istante'),
    { $date: '2026-10-25T01:30:00.000Z' });
  assert.deepStrictEqual(V.decodificaTemporale('2026-10-25', 'data'), '2026-10-25');
  assert.strictEqual(V.decodificaTemporale('2026-10-25T01:30:00', 'locale'), '2026-10-25T01:30:00');
  assert.throws(() => V.decodificaTemporale('2026-10-25T01:30:00', 'istante'), /fuso|Z|offset/i);
  assert.deepStrictEqual(V.aggregaNumeriEsatti([
    { $numberLong: '9007199254740993' }, { $numberLong: '2' },
  ], 'somma').testo, '9007199254740995');
  assert.strictEqual(V.aggregaNumeriEsatti([
    { $numberDecimal: '0.1' }, { $numberDecimal: '0.2' },
  ], 'somma').testo, '0.3');
  assert.strictEqual(V.aggregaNumeriEsatti([
    { $numberDecimal: '0.1' }, { $numberDecimal: '0.2' },
  ], 'media').testo, '0.15');
  assert.strictEqual(V.aggregaNumeriEsatti([{ $numberDecimal: '1' }, { $numberDecimal: '3' }], 'media').testo, '2');
  console.log('  OK   BIGINT, Long e Decimal non attraversano Number');
})();
