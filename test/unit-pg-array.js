'use strict';

const assert = require('node:assert/strict');
const { Binary, Decimal128, Long } = require('bson');
const { parse: leggiArray } = require('postgres-array');
const { prepareValue } = require('pg/lib/utils');
const pg = require('../db/pg-valori');
const { deserializeClientObject } = require('../db/sqlValori');

const scalare = name => ({ kind: 'scalar', name, schema: 'pg_catalog' });
const arrayDi = (element, delimiter = ',') => ({ pgType: { kind: 'array', delimiter, element } });
const interi = arrayDi(scalare('int4'));
const testi = arrayDi(scalare('text'));
const jsonb = { kind: 'json', name: 'jsonb', schema: 'pg_catalog' };
const bytea = { kind: 'bytea', name: 'bytea', schema: 'pg_catalog' };
const originale = pg.valorePostgres;
const jsonOriginale = pg.valoreDalJson;
const catalogoOriginale = pg.tipoDaCatalogo;

// Il mutante degrada solo gli array SQL a JSON; il percorso JSON/JSONB rimane
// quello reale. L'asserzione PG-ARRAY-FORMA deve intercettare la regressione.
if (process.argv.includes('--mutant')) {
  pg.valorePostgres = (value, column) => Array.isArray(value) && column?.pgType?.kind === 'array'
    ? JSON.stringify(value) : originale(value, column);
}
if (process.argv.includes('--mutant-raw')) {
  pg.valoreDalJson = (source, column) => jsonOriginale(JSON.stringify(JSON.parse(source)), column);
}
if (process.argv.includes('--mutant-domini')) {
  pg.valorePostgres = (value, column) => originale(value, column?.pgType?.element?.kind === 'array'
    ? { ...column, pgType: { ...column.pgType, element: column.pgType.element.element } } : column);
}
if (process.argv.includes('--mutant-catalogo')) {
  pg.tipoDaCatalogo = (nodes, dimensions) => catalogoOriginale(nodes.map(node => ({ ...node, array: node.category === 'A' })), dimensions);
}

function fotografa(value) {
  if (value instanceof Date) return { tipo: 'Date', valore: value.toISOString() };
  if (value instanceof Uint8Array) return { tipo: value.constructor.name, offset: value.byteOffset, bytes: [...value] };
  if (value?._bsontype === 'Binary') return { tipo: 'Binary', sottotipo: value.sub_type, position: value.position, buffer: fotografa(value.buffer) };
  if (value?._bsontype) return { tipo: value._bsontype, valore: value.toString() };
  if (Array.isArray(value)) return value.map(fotografa);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fotografa(v)]));
  return value;
}

let verificati = 0;
function verificaArray(nome, value, column, atteso) {
  const prima = fotografa(value), metaPrima = fotografa(column);
  const parametro = pg.valorePostgres(value, column);
  assert(typeof parametro === 'string' && parametro.startsWith('{') && parametro.endsWith('}'),
    `[PG-ARRAY-FORMA] ${nome}: il parametro deve essere un letterale array PostgreSQL, non JSON`);
  // Il parser è quello indipendente già usato dal driver PostgreSQL in lettura.
  assert.deepEqual(leggiArray(parametro), atteso, `${nome}: celle, NULL e dimensioni devono sopravvivere alla codifica`);
  assert.equal(prepareValue(parametro), parametro, `${nome}: il driver non deve reinterpretare il parametro come JSON`);
  assert.deepEqual(fotografa(value), prima, `${nome}: nessuna mutazione dei valori originali`);
  assert.deepEqual(fotografa(column), metaPrima, `${nome}: nessuna mutazione dei metadati`);
  verificati++;
  return parametro;
}

module.exports = (async () => {
try {
  console.log('--- Test unitari array PostgreSQL e JSON ---');
  verificaArray('interi con NULL', Object.freeze([1, null, 3]), interi, ['1', null, '3']);
  verificaArray('array vuoto', Object.freeze([]), interi, []);
  verificaArray('soli NULL', Object.freeze([null, null]), interi, [null, null]);
  assert.equal(pg.valorePostgres(null, interi), null, 'Una colonna array SQL NULL non diventa un array vuoto');

  const parole = Object.freeze(['', 'NULL', 'null', 'a,b', '{parentesi}', '"virgolette"', 'a\\b', 'a\nb', 'a\tb', 'è🦊', 'x","y']);
  verificaArray('testi con caratteri speciali e Unicode', parole, testi, parole);
  const matrice = Object.freeze([Object.freeze([1, null]), Object.freeze([3, 4])]);
  verificaArray('matrice di interi', matrice, interi, [['1', null], ['3', '4']]);
  verificaArray('tre dimensioni', [[[1, 2]], [[3, 4]]], interi, [[['1', '2']], [['3', '4']]]);
  verificaArray('matrice di testi', [['a,b', 'NULL'], [null, '']], testi, [['a,b', 'NULL'], [null, '']]);

  const grande = '9007199254740993', massimo = '9223372036854775807';
  const importo = '1234567890.123456789012345678';
  verificaArray('bigint oltre 53 bit', [Long.fromString(grande), Long.fromString(massimo), null], arrayDi(scalare('int8')), [grande, massimo, null]);
  verificaArray('numeric esatti', [Decimal128.fromString(importo), Decimal128.fromString('0.100000000000000001')], arrayDi(scalare('numeric')), [importo, '0.100000000000000001']);
  const enorme = '1234567890123456789012345678901234567890.123456789';
  const ricevuti = deserializeClientObject([{ $numberLong: grande }, { $numberDecimal: enorme }, null]);
  verificaArray('numeri dal protocollo EJSON', ricevuti, arrayDi(scalare('numeric')), [grande, enorme, null]);
  verificaArray('booleani', [true, false, null], arrayDi(scalare('bool')), ['true', 'false', null]);

  // La sorgente JSON può contenere numeri non ancora protetti da wrapper:
  // validarla non autorizza a usare il Number arrotondato prodotto dal parser.
  const numeroRaw = '9007199254740993.123456789012345678901234567890';
  const numeriRaw = pg.valoreDalJson(`[${numeroRaw}]`, arrayDi(scalare('numeric')));
  assert.deepEqual(leggiArray(numeriRaw), [numeroRaw], '[PG-ARRAY-RAW] NUMERIC[] conserva tutte le cifre della sorgente JSON');
  assert.equal(prepareValue(numeriRaw), numeriRaw);
  const jsonRaw = '[{"n":9007199254740993.123456789},[9007199254740993]]';
  const documentiRaw = pg.valoreDalJson(jsonRaw, arrayDi(jsonb));
  assert.deepEqual(leggiArray(documentiRaw), ['{"n":9007199254740993.123456789}', '[9007199254740993]'],
    '[PG-ARRAY-RAW-JSON] JSONB[] conserva i testi numerici anche dentro oggetti e array JSON');
  assert.equal(prepareValue(documentiRaw), documentiRaw);
  verificati += 2;

  // Array di domini che a loro volta contengono array: la foglia resta un
  // valore autonomo, non un'ulteriore dimensione dell'array esterno.
  const arrayDomini = arrayDi(interi.pgType);
  const dominioInput = Object.freeze([Object.freeze([1, null]), Object.freeze([2, 3])]);
  const dominioPrima = fotografa(dominioInput);
  const elementiDominio = leggiArray(pg.valorePostgres(dominioInput, arrayDomini));
  assert(elementiDominio.every(value => typeof value === 'string'), '[PG-ARRAY-DOMINI] le foglie dominio-array devono restare elementi SQL distinti');
  assert.deepEqual(elementiDominio.map(value => leggiArray(value)), [['1', null], ['2', '3']], 'Ogni dominio conserva il proprio array interno');
  const elementiDominioRaw = leggiArray(pg.valoreDalJson('[[1,null],[2,3]]', arrayDomini));
  assert.deepEqual(elementiDominioRaw.map(value => leggiArray(value)), [['1', null], ['2', '3']], 'Anche il percorso JSON originale rispetta il confine del dominio');
  assert.deepEqual(fotografa(dominioInput), dominioPrima, 'La codifica dei domini non modifica gli array originali');
  verificati++;

  const nodiDominio = Object.freeze([
    Object.freeze({ oid: 91001, name: 'importi', schema: 'app', kind: 'd', category: 'A', base: 91002, dimensions: 2, array: false }),
    Object.freeze({ oid: 91002, name: '_importo', schema: 'app', kind: 'b', category: 'A', element: 91003, array: true }),
    Object.freeze({ oid: 91003, name: 'importo', schema: 'app', kind: 'd', category: 'N', base: 1700, delimiter: ',', array: false }),
    Object.freeze({ oid: 1700, name: 'numeric', schema: 'pg_catalog', kind: 'b', category: 'N', delimiter: ',', array: false }),
  ]);
  const catalogoPrima = fotografa(nodiDominio);
  const tipoDominio = pg.tipoDaCatalogo(nodiDominio);
  assert.deepEqual(tipoDominio, { kind: 'array', delimiter: ',', dimensions: 2,
    element: { kind: 'scalar', name: 'numeric', schema: 'pg_catalog', oid: 1700 } },
  'Il catalogo risolve dominio → array → dominio → numeric, comprese le dimensioni del dominio');
  assert.equal(pg.tipoDaCatalogo(nodiDominio, 3).dimensions, 3, 'Le dimensioni della colonna prevalgono su quelle del dominio');
  verificaArray('dominio su array di domini numeric', [[Long.fromString(grande), null]], { pgType: tipoDominio }, [[grande, null]]);
  assert.deepEqual(fotografa(nodiDominio), catalogoPrima, 'La risoluzione del catalogo non modifica i nodi');
  for (const [oid, name, element] of [[22, 'int2vector', 21], [30, 'oidvector', 26]]) {
    const tipoVettore = pg.tipoDaCatalogo([{ oid, name, schema: 'pg_catalog', kind: 'b', category: 'A', element, array: false }]);
    assert.equal(tipoVettore.kind, 'scalar', '[PG-ARRAY-CATALOGO] categoria A non basta per riconoscere un array PostgreSQL standard');
    assert.equal(tipoVettore.name, name);
    verificati++;
  }

  // Il medesimo array JavaScript è JSON in una colonna JSON scalare, SQL in
  // int[]; in JSONB[] ogni elemento è un documento JSON, anche se è un array.
  const documento = Object.freeze([1, null, Object.freeze({ testo: 'è🦊', lista: [2, 3] })]);
  for (const name of ['json', 'jsonb']) {
    const column = { pgType: { kind: 'json', name, schema: 'pg_catalog' } };
    const prima = fotografa(documento);
    const parametro = pg.valorePostgres(documento, column);
    assert.equal(parametro, JSON.stringify(documento), `${name} scalare: conservare l'array come JSON`);
    assert.deepEqual(JSON.parse(parametro), documento);
    // Gli editor esistenti passano anche testo JSON già validato: quel testo
    // non va codificato una seconda volta come stringa JSON.
    for (const letterale of ['{"x":1}', '"testo \\"JSON\\""']) {
      assert.equal(pg.valorePostgres(letterale, column), letterale, `${name}: il letterale JSON nativo rimane invariato`);
    }
    assert.equal(pg.valorePostgres(null, column), null, `${name}: NULL SQL resta NULL`);
    assert.deepEqual(fotografa(documento), prima);
    verificati++;
  }
  const documenti = Object.freeze([Object.freeze({ nome: 'a,b', nullo: null }), Object.freeze([1, 2]), 'NULL', 42, false, null]);
  const jsonAttesi = documenti.map(value => value === null ? null : JSON.stringify(value));
  const codificato = verificaArray('JSONB[] con elementi array JSON', documenti, arrayDi(jsonb), jsonAttesi);
  assert.deepEqual(leggiArray(codificato, JSON.parse), documenti, 'Gli array JSON interni non diventano dimensioni SQL');
  verificaArray('JSON[] vuoto', [], arrayDi({ ...jsonb, name: 'json' }), []);
  verificaArray('JSON[] con array JSON vuoto', [[]], arrayDi({ ...jsonb, name: 'json' }), ['[]']);
  const jsonMatrice = [[{ n: 1 }, [2, 3]], [null, { n: 4 }]];
  const tipoJsonMatrice = arrayDi(jsonb);
  tipoJsonMatrice.pgType.dimensions = 2;
  const jsonMatriceCodificata = verificaArray('JSONB[][] con dimensioni dichiarate', jsonMatrice, tipoJsonMatrice,
    [['{"n":1}', '[2,3]'], [null, '{"n":4}']]);
  assert.deepEqual(leggiArray(jsonMatriceCodificata, JSON.parse), jsonMatrice, 'La profondità SQL dichiarata distingue matrici e array JSON');
  const documentoEsatto = { intero: Long.fromString(grande), importo: Decimal128.fromString(importo) };
  const jsonEsatto = JSON.stringify({ intero: { $numberLong: grande }, importo: { $numberDecimal: importo } });
  verificaArray('JSONB[] con numeri BSON esatti', [documentoEsatto], arrayDi(jsonb), [jsonEsatto]);
  assert.equal(pg.valorePostgres(documentoEsatto, { pgType: jsonb }), jsonEsatto, 'JSONB scalare mantiene i wrapper esatti già previsti dal protocollo');

  const riserva = new Binary();
  [0, 255, 128].forEach(byte => riserva.put(byte));
  const finestra = Uint8Array.from([17, 0, 255, 128, 34]).subarray(1, 4);
  verificaArray('bytea[] con viste, riserva e vuoti', [Buffer.from([0, 255, 128]), finestra, riserva, Buffer.alloc(0), null],
    arrayDi(bytea), ['\\x00ff80', '\\x00ff80', '\\x00ff80', '\\x', null]);
  verificaArray('bytea[][]', [[Buffer.from([0]), null], [Buffer.from([255]), Buffer.alloc(0)]],
    arrayDi(bytea), [['\\x00', null], ['\\xff', '\\x']]);

  // Il letterale nativo consente offset e forme JSON multidimensionali senza
  // dedurre dal contenuto JavaScript una dimensione che PostgreSQL non impone.
  for (const [column, letterale] of [
    [testi, '[0:1]={"uno","due"}'],
    [arrayDi(jsonb), '{{"null","[1,2]"},{"{}",NULL}}'],
  ]) assert.equal(pg.valorePostgres(letterale, column), letterale, 'I letterali array PostgreSQL espliciti passano invariati');

  for (const type of ['integer[]', '_int4']) verificaArray(`compatibilità metadati ${type}`, [1, null, 2], { type }, ['1', null, '2']);
  verificaArray('il catalogo prevale sul nome dichiarato', [1, 2], { type: 'jsonb', ...interi }, ['1', '2']);
  assert.equal(pg.valorePostgres([1, 2], { type: 'integer[]', pgType: jsonb }), '[1,2]', 'Il catalogo JSON prevale sul nome array obsoleto');

  const separatore = pg.valorePostgres(['(1,2),(3,4)', '(5,6),(7,8)'], arrayDi(scalare('box'), ';'));
  assert.equal(separatore, '{"(1,2),(3,4)";"(5,6),(7,8)"}', 'Il delimitatore viene dal catalogo: box[] separa le celle con punto e virgola');
  assert.equal(prepareValue(separatore), separatore);
  assert.equal(pg.valorePostgres('testo', { pgType: scalare('text') }), 'testo', 'Il testo SQL scalare rimane invariato');

  const percorsoCodec = require('node:path').join(__dirname, '..', 'public', 'js', 'valori-esatti.js');
  let urlCodec = require('node:url').pathToFileURL(percorsoCodec).href;
  if (process.argv.includes('--mutant-editor')) {
    const source = require('node:fs').readFileSync(percorsoCodec, 'utf8');
    const guardia = "if (metadato.pgType?.kind === 'array' || /\\[\\s*\\]/.test(tipo)) return false;";
    assert(source.includes(guardia), 'Preparazione del mutante editor: guardia array presente');
    urlCodec = 'data:text/javascript;base64,' + Buffer.from(source.replace(guardia, 'if (false) return false;')).toString('base64');
  }
  const codec = await import(urlCodec);
  for (const metadato of [
    { declaredType: 'bigint[]', type: '_int8' }, { declaredType: 'numeric(38,18)[]', type: '_numeric' },
    { type: 'decimal[][]' }, { type: '_int8' }, { type: '_numeric' },
    { declaredType: 'numeric', pgType: { kind: 'array', element: scalare('numeric') } },
    'bigint[]', 'numeric[]',
  ]) assert.equal(codec.richiedePrecisioneEsatta(metadato), false,
    '[PG-ARRAY-EDITOR] un array numerico non deve essere validato come singolo numero');
  for (const metadato of [{ type: 'bigint' }, { declaredType: 'numeric(38,18)' }, { wrapper: '$numberLong' }, { wrapper: '$numberDecimal' }]) {
    assert.equal(codec.richiedePrecisioneEsatta(metadato), true, 'I numeri scalari esatti conservano il proprio editor');
  }
  console.log(`  OK   ${verificati} casi array/JSON: forma, dimensioni, NULL, Unicode e tipi esatti`);
  console.log('  OK   JSONB[], bytea[], letterali nativi, delimitatori e input immutati');
  console.log('  OK   editor: array numerici distinti dai numeri scalari esatti');
} finally {
  pg.valorePostgres = originale;
  pg.valoreDalJson = jsonOriginale;
  pg.tipoDaCatalogo = catalogoOriginale;
}

return { verificati };
})();
