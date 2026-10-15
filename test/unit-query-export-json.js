'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EJSON, ObjectId, Long, Decimal128, Int32, Double, Binary, BSONRegExp, Timestamp, Code, MinKey, MaxKey } = require('bson');

module.exports = (async () => {
  const { serializzaJsonStandard } = await import('../public/js/export-json.js');
  const documento = {
    _id: new ObjectId('507f1f77bcf86cd799439011'),
    data: new Date('2026-10-15T12:00:00Z'),
    intero: new Int32(42), piccolo: Long.fromString('9007199254740991'),
    grande: Long.fromString('9223372036854775807'), negativo: Long.fromString('-9223372036854775808'),
    decimale: Decimal128.fromString('12345678901234567890.12345678901234'),
    zeroDecimale: Decimal128.fromString('0.00'), reale: new Double(1.25),
    speciale: [new Double(NaN), new Double(Infinity), new Double(-Infinity)],
    binario: new Binary(Buffer.from([0, 255, 127]), 0x80),
    regex: new BSONRegExp('a.*b', 'im'), timestamp: new Timestamp({ t: 123, i: 4 }),
    codice: new Code('return 1;'), conScope: new Code('return x;', { x: new Int32(2) }),
    minimo: new MinKey(), massimo: new MaxKey(),
    annidato: [{ id: new ObjectId('507f1f77bcf86cd799439012') }],
    geo: { type: 'Point', coordinates: [12.5, 41.9] },
    nullo: null, falso: false, zero: 0, vuoto: '', elenco: [], oggetto: {},
  };
  const atteso = {
    _id: '507f1f77bcf86cd799439011', data: '2026-10-15T12:00:00.000Z',
    intero: 42, piccolo: 9007199254740991, grande: '9223372036854775807', negativo: '-9223372036854775808',
    decimale: '12345678901234567890.12345678901234', zeroDecimale: '0.00', reale: 1.25,
    speciale: ['NaN', 'Infinity', '-Infinity'], binario: 'AP9/',
    regex: { pattern: 'a.*b', options: 'im' }, timestamp: { t: 123, i: 4 },
    codice: 'return 1;', conScope: { code: 'return x;', scope: { x: 2 } },
    minimo: 'MinKey', massimo: 'MaxKey', annidato: [{ id: '507f1f77bcf86cd799439012' }],
    geo: { type: 'Point', coordinates: [12.5, 41.9] },
    nullo: null, falso: false, zero: 0, vuoto: '', elenco: [], oggetto: {},
  };
  const righe = [EJSON.serialize(documento, { relaxed: false })];
  const prima = structuredClone(righe);
  assert.deepEqual(JSON.parse(serializzaJsonStandard(righe)), [atteso]);
  assert.deepEqual(JSON.parse(serializzaJsonStandard([require('../db/mongoEjson').serializza(documento)])), [atteso],
    'Anche il formato ricevuto dal server deve produrre JSON standard');
  assert.deepEqual(righe, prima, 'Esportare non deve cambiare i risultati da visualizzare o modificare');

  const casi = [
    [{ $symbol: 'simbolo' }, 'simbolo'], [{ $uuid: 'uuid' }, 'uuid'], [{ $undefined: true }, null],
    [{ $dbPointer: { $ref: 'clienti', $id: { $oid: atteso._id } } }, { namespace: 'clienti', id: atteso._id }],
    [{ $date: { $numberLong: '9223372036854775807' } }, '9223372036854775807'],
    [{ $date: '0000-00-00' }, '0000-00-00'], [{ $date: 0 }, '1970-01-01T00:00:00.000Z'],
    [{ $date: '2026-10-15T14:00:00+02:00' }, '2026-10-15T12:00:00.000Z'],
    [{ $numberLong: '9007199254740992' }, '9007199254740992'],
    [{ $numberDouble: '-0.0' }, 0], [{ $numberDecimal: 'NaN' }, 'NaN'],
  ];
  for (const [input, expected] of casi) assert.deepEqual(JSON.parse(serializzaJsonStandard(input)), expected);
  for (const input of [
    { $oid: atteso._id, nome: 'documento ordinario' }, { $date: '2026-10-15', altro: 1 },
    { $numberLong: '1', altro: 2 }, { $binary: { base64: '', subType: '00', altro: true } },
    { $timestamp: { t: 1, i: 2, altro: true } }, { $date: null }, { $numberLong: 'testo' },
    { $oid: 3 }, { $sconosciuto: 'dato' },
    JSON.parse('{"__proto__":{"valore":1},"constructor":"campo"}'),
  ]) assert.deepEqual(JSON.parse(serializzaJsonStandard(input)), input, 'I documenti ordinari devono conservare i campi');

  // La funzione reale crea il Blob e rispetta l'ordine visibile; solo il download è sostituito.
  let scaricato;
  const context = {
    serializzaJsonStandard, currentResults: [...righe, { _id: 'secondo' }],
    currentColumns: [], queryOrdine: ['_id'], queryTableRows: [{ _id: 'secondo' }, ...righe],
    colonneRisultato: () => Object.keys(documento), $: () => null, dbmsCorrente: () => 'mongodb', Blob,
    scaricaFile: (blob, nome) => { scaricato = { blob, nome }; }, toast() {},
  };
  const source = fs.readFileSync(require.resolve('../public/js/query-tab.js'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('export function exportQueryResults')).replace('export function', 'function'), context);
  context.exportQueryResults('json');
  assert.equal(scaricato.blob.type, 'application/json');
  assert.match(scaricato.nome, /^query_result_\d+\.json$/);
  assert.deepEqual(JSON.parse(await scaricato.blob.text()), [{ _id: 'secondo' }, atteso]);
  context.queryOrdine = [];
  context.exportQueryResults('json');
  assert.deepEqual(JSON.parse(await scaricato.blob.text()), [atteso, { _id: 'secondo' }]);
  context.currentResults = [];
  scaricato = null;
  context.exportQueryResults('json');
  assert.equal(scaricato, null, 'Nessun download quando non ci sono risultati');
  console.log('OK: export JSON standard, tipi BSON, precisione, campi ordinari e ordine dei risultati.');
})();
module.exports.catch(error => { console.error(error); process.exitCode = 1; });
