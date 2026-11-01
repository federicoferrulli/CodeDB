'use strict';

// Nessun database: confronto semantico delle opzioni, senza perdere vincoli.
const assert = require('node:assert/strict');
const { EJSON, Int32, Double, Long, Decimal128, BSONRegExp, ObjectId, serialize } = require('bson');
const schema = require('../db/schemaObjects');
const originale = schema.canonicalSchemaInventory;
const mutante = process.argv.find(arg => arg.startsWith('--mutant-'))?.slice('--mutant-'.length);
if (['default', 'validator', 'modi'].includes(mutante)) schema.canonicalSchemaInventory = (objects, options) => {
  const result = originale(objects, options);
  if (mutante === 'validator' || mutante === 'modi') result.collectionOptions = result.collectionOptions.map(text => {
    const item = JSON.parse(text);
    if (mutante === 'validator') delete item.options.validator;
    if (mutante === 'modi') { delete item.options.validationLevel; delete item.options.validationAction; }
    return JSON.stringify(item);
  }).sort();
  if (mutante === 'default') result.collectionOptions = result.collectionOptions.map(text => {
    const item = JSON.parse(text), options = objects.collectionOptions.find(value => value.name === item.name).options;
    return JSON.stringify({ ...item, presenzaDefault: [options.validationLevel ?? 'omesso', options.validationAction ?? 'omesso'] });
  }).sort();
  return result;
};
const inventario = options => schema.canonicalSchemaInventory({ collectionOptions: [{ name: 'misure', options }] });
const differenze = (a, b) => schema.inventoryDifferences(inventario(a), inventario(b));
const validator = { $jsonSchema: { bsonType: 'object', required: ['testo'], properties: { testo: { bsonType: 'string' } } } };
const strict = { validator, validationLevel: 'strict', validationAction: 'error' };
const prove = [];
function prova(id, run) {
  try { run(); prove.push({ id, ok: true }); console.log(`OK ${id}`); }
  catch (error) { prove.push({ id, ok: false, errore: error.message }); console.error(`FAIL ${id}: ${error.message}`); }
}

module.exports = (async () => {
  prova('VALIDATOR-DEFAULT-IMPLICITI', () => {
    const variants = [
      { validator }, { validator, validationLevel: 'strict' },
      { validator, validationAction: 'error' }, strict,
    ];
    for (const a of variants) for (const b of variants) assert.deepEqual(differenze(a, b), [], 'Omettere strict/error non cambia il validatore');
  });
  prova('VALIDATOR-DEFAULT-SENZA-OPZIONI', () => {
    const base = schema.canonicalSchemaInventory({ collectionOptions: [] });
    for (const options of [{}, { validator: {} }, { validationLevel: 'strict', validationAction: 'error' },
      { validator: {}, validationLevel: 'strict', validationAction: 'error' }]) {
      assert.deepEqual(schema.inventoryDifferences(base, inventario(options)), [], 'Opzioni vuote e default non devono inventare un vincolo');
    }
  });
  prova('VALIDATOR-MODI-DISTINTI', () => {
    const variants = ['strict', 'moderate', 'off'].flatMap(validationLevel => ['error', 'warn']
      .map(validationAction => ({ validator, validationLevel, validationAction })));
    for (let a = 0; a < variants.length; a++) for (let b = a + 1; b < variants.length; b++) {
      assert(differenze(variants[a], variants[b]).length, `I modi ${a}/${b} non devono collassare`);
    }
  });
  prova('VALIDATOR-VINCOLI-DISTINTI', () => {
    const variants = [
      validator,
      { $jsonSchema: { bsonType: 'object', required: ['testo'], properties: { testo: { bsonType: 'int' } } } },
      { $jsonSchema: { bsonType: 'object', required: ['altro'], properties: { testo: { bsonType: 'string' } } } },
      { testo: { $regex: '^ok$', $options: 'i' } },
      { testo: { $regex: '^ok$', $options: '' } },
      { valore: { $gte: 0 } }, { valore: { $gte: 1 } }, {},
    ];
    for (let a = 0; a < variants.length; a++) for (let b = a + 1; b < variants.length; b++) {
      assert(differenze({ validator: variants[a] }, { validator: variants[b] }).length, `I vincoli ${a}/${b} non devono collassare`);
    }
  });
  prova('VALIDATOR-LITERAL-BSON-ORDINATO', () => {
    assert(differenze({ validator: { annidato: { $eq: { a: 1, b: 2 } } } },
      { validator: { annidato: { $eq: { b: 2, a: 1 } } } }).length,
    'L’ordine del documento letterale cambia il confronto BSON');
  });
  prova('VALIDATOR-BSON-EJSON-EQUIVALENTI', () => {
    const values = [new Int32(2), new Double(0.25), Long.fromString('9007199254740993'),
      Decimal128.fromString('12345678901234567890.123456789'), new BSONRegExp('^ok$', 'i')];
    for (const value of values) {
      const native = { validator: { valore: { $eq: value } } };
      assert.deepEqual(differenze(native, EJSON.serialize(native, { relaxed: false })), [], `BSON/EJSON equivalenti: ${value._bsontype}`);
    }
    assert.deepEqual(differenze({ validator: { valore: { $gte: 2 } } }, { validator: { valore: { $gte: new Int32(2) } } }), []);
  });
  prova('VALIDATOR-BSON-VALORI-DISTINTI', () => {
    for (const [a, b] of [
      [Long.fromString('9007199254740993'), Long.fromString('9007199254740994')],
      [Decimal128.fromString('12345678901234567890.123456789'), Decimal128.fromString('12345678901234567890.123456788')],
      [new Int32(2), '2'], [new Double(0.25), new Double(0.5)],
    ]) assert(differenze({ validator: { valore: { $eq: a } } }, { validator: { valore: { $eq: b } } }).length,
      'Soglie o tipi diversi non devono diventare lo stesso vincolo');
  });
  prova('VALIDATOR-BSON-REGEX-TIPO', () => {
    assert(differenze({ validator: { valore: { $eq: new BSONRegExp('^ok$', 'i') } } },
      { validator: { valore: { $eq: { pattern: '^ok$', options: 'i' } } } }).length,
    'Un valore BSON regex non equivale a un documento che ne imita le proprietà interne');
  });
  prova('VALIDATOR-REGEX-CONTESTO', () => {
    const field = { testo: { $regex: '^ok$', $options: 'i' } };
    const native = { testo: new BSONRegExp('^ok$', 'i') };
    assert.deepEqual(differenze({ validator: field }, { validator: native }), [], 'Regex operatore e regex BSON di campo equivalenti');
    for (const branch of ['$and', '$or', '$nor']) {
      assert.deepEqual(differenze({ validator: { [branch]: [field] } }, { validator: { [branch]: [native] } }), [], branch);
    }
    assert(differenze({ validator: { testo: { $eq: { $regex: '^ok$', $options: 'i' } } } },
      { validator: { testo: { $eq: new BSONRegExp('^ok$', 'i') } } }).length,
    'Dentro $eq il documento con chiavi $regex/$options resta letterale');
  });
  prova('VALIDATOR-TRASPORTO-BSON-FEDELE', () => {
    const { normalizzaLayerBackup, normalizzaExportDatabase } = require('../db/artefatti');
    let objects = { collectionOptions: [{ name: 'misure', options: { validator: {
      testo: new BSONRegExp('^ok$', 'i'), importo: { $gte: Long.fromString('9007199254740993') },
    } } }] };
    if (mutante === 'trasporto') objects = JSON.parse(JSON.stringify(objects));
    const layer = normalizzaLayerBackup({ dbType: 'mongodb', database: 'origine', schemas: [], collections: ['misure'], objects });
    const exported = normalizzaExportDatabase({ formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
      collections: [{ name: 'misure', indexes: [], docs: [] }], objects });
    for (const result of [layer, exported]) {
      const encoded = result.objects.collectionOptions[0].options.validator;
      assert.deepEqual(encoded.testo, { $regularExpression: { pattern: '^ok$', options: 'i' } }, 'La regex conserva il marcatore EJSON');
      assert.deepEqual(encoded.importo.$gte, { $numberLong: '9007199254740993' }, 'La soglia conserva tutte le cifre');
      const decoded = EJSON.deserialize(encoded, { relaxed: false });
      assert(decoded.testo instanceof BSONRegExp); assert.equal(decoded.testo.pattern, '^ok$'); assert.equal(decoded.testo.options, 'i');
      assert(decoded.importo.$gte instanceof Long); assert.equal(decoded.importo.$gte.toString(), '9007199254740993');
    }
  });
  prova('METADATI-SIDECAR-BSON-FEDELE', () => {
    const { codificaMetadati, decodificaMetadati, normalizzaMetadati } = require('../db/mongoSchemaBson');
    const values = [
      { $regex: 'x', $options: 'i' }, { $regularExpression: { pattern: 'x', options: 'i' } },
      { $numberLong: '9007199254740993' }, { $date: '2020-01-02T03:04:05.000Z' }, { $oid: '507f1f77bcf86cd799439011' },
      new BSONRegExp('x', 'i'), Long.fromString('9007199254740993'), new Date('2020-01-02T03:04:05.000Z'), new ObjectId('507f1f77bcf86cd799439011'),
    ];
    for (const value of values) for (const entry of [
      { name: 'misure', options: { validator: { valore: { $eq: value } } } },
      { name: 'vista', viewOn: 'misure', pipeline: [{ $match: { valore: { $eq: value } } }] },
      { name: 'indice', key: { valore: 1 }, partialFilterExpression: { valore: { $eq: value } } },
    ]) {
      const encoded = codificaMetadati(entry);
      assert.deepEqual(Object.keys(encoded.__codedbSchemaBson).sort(), ['base64', 'version']);
      assert.equal(encoded.__codedbSchemaBson.version, '1');
      assert.equal(typeof encoded.__codedbSchemaBson.base64, 'string');
      let transported = JSON.parse(JSON.stringify(normalizzaMetadati(encoded)));
      if (mutante === 'sidecar') delete transported.__codedbSchemaBson;
      const decoded = decodificaMetadati(transported);
      assert(!Object.hasOwn(decoded, '__codedbSchemaBson'), 'Il marcatore di trasporto non deve arrivare al driver');
      assert.deepEqual(serialize(decoded), serialize(entry), 'La copia BSON deve preservare tipo, valore e ordine del documento originale');
    }
  });
  prova('METADATI-SIDECAR-VALIDAZIONE', () => {
    const { codificaMetadati, decodificaMetadati } = require('../db/mongoSchemaBson');
    const entry = { name: 'misure', options: { validator: { valore: { $eq: { a: 1, b: 2 } } } } };
    const encoded = codificaMetadati(entry), clone = () => JSON.parse(JSON.stringify(encoded));
    const cases = [];
    let changed = clone(); changed.name = 'estranea'; cases.push(changed);
    changed = clone(); changed.options.validator.valore.$eq = { b: { $numberInt: '2' }, a: { $numberInt: '1' } }; cases.push(changed);
    for (const sidecar of [null, 'testo', { version: 1, base64: encoded.__codedbSchemaBson.base64 }, { version: '2', base64: encoded.__codedbSchemaBson.base64 },
      { ...encoded.__codedbSchemaBson, extra: true }, { version: '1', base64: '@@non-base64@@' },
      { version: '1', base64: encoded.__codedbSchemaBson.base64 + '\n' },
      { version: '1', base64: serialize({ name: 'estranea' }).toString('base64') },
      { version: '1', base64: Buffer.concat([Buffer.from(encoded.__codedbSchemaBson.base64, 'base64'), Buffer.from([0])]).toString('base64') },
    ]) { changed = clone(); changed.__codedbSchemaBson = sidecar; cases.push(changed); }
    const invalidUtf8 = serialize({ name: 'misure' }); invalidUtf8[14] = 255;
    changed = clone(); changed.__codedbSchemaBson.base64 = invalidUtf8.toString('base64'); cases.push(changed);
    for (const value of cases) assert.throws(() => decodificaMetadati(value), 'Metadati incoerenti o illeggibili devono essere rifiutati');
    assert.throws(() => codificaMetadati({ name: 'eccessiva', options: { validator: { testo: 'x'.repeat(16 * 1024 * 1024) } } }),
      'Il payload BSON dei metadati deve rispettare il limite di 16 MiB');
  });
  prova('METADATI-SIDECAR-LEGACY', () => {
    const { decodificaMetadati } = require('../db/mongoSchemaBson');
    const native = { name: 'compatibile', options: { validator: { importo: { $gte: Long.fromString('9007199254740993') }, testo: new BSONRegExp('x', 'i') } } };
    const decoded = decodificaMetadati(EJSON.serialize(native, { relaxed: false }));
    assert.deepEqual(serialize(decoded), serialize(native), 'I precedenti artefatti EJSON tipizzati restano leggibili');
  });
  prova('METADATI-SIDECAR-CONFRONTO-TIPI', () => {
    const { codificaMetadati } = require('../db/mongoSchemaBson');
    for (const [literal, native] of [
      [{ $regularExpression: { pattern: 'x', options: 'i' } }, new BSONRegExp('x', 'i')],
      [{ $numberLong: '9007199254740993' }, Long.fromString('9007199254740993')],
      [{ $date: '2020-01-02T03:04:05.000Z' }, new Date('2020-01-02T03:04:05.000Z')],
      [{ $oid: '507f1f77bcf86cd799439011' }, new ObjectId('507f1f77bcf86cd799439011')],
    ]) {
      const entry = value => codificaMetadati({ name: 'misure', options: { validator: { valore: { $eq: value } } } });
      const inventory = value => schema.canonicalSchemaInventory({ collectionOptions: [entry(value)] });
      assert(schema.inventoryDifferences(inventory(literal), inventory(native)).length, 'Il documento letterale non equivale al valore BSON descritto dal suo tag');
      const index = value => codificaMetadati({ name: 'indice', key: { valore: 1 }, partialFilterExpression: { valore: { $eq: value } } });
      assert.notEqual(schema.canonicalMongoIndex(index(literal)), schema.canonicalMongoIndex(index(native)), 'Anche il filtro parziale distingue i tipi');
    }
  });
  prova('VALIDATOR-OPZIONI-ALTRE-PRESERVATE', () => {
    for (const [a, b] of [
      [{ capped: true, size: 8192 }, { capped: true, size: 16384 }],
      [{ collation: { locale: 'it', strength: 1 } }, { collation: { locale: 'it', strength: 2 } }],
      [{ expireAfterSeconds: 10 }, { expireAfterSeconds: 20 }],
      [{ changeStreamPreAndPostImages: { enabled: true } }, { changeStreamPreAndPostImages: { enabled: false } }],
      [{ futuraOpzione: { abilitata: true } }, { futuraOpzione: { abilitata: false } }],
    ]) assert(differenze({ ...strict, ...a }, { ...strict, ...b }).length, 'Le altre opzioni semantiche restano nel confronto');
  });
  prova('VALIDATOR-NESSUNA-MUTAZIONE', () => {
    const input = { collectionOptions: [{ name: 'misure', options: { validator } }] };
    const before = JSON.stringify(input);
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(input); schema.canonicalSchemaInventory(input);
    assert.equal(JSON.stringify(input), before);
  });
  const fallite = prove.filter(item => !item.ok);
  assert.equal(fallite.length, 0, `Gruppi falliti: ${fallite.map(item => item.id).join(', ')}`);
  return prove;
})();
if (require.main === module) module.exports.catch(error => { console.error(error.message); process.exitCode = 1; });
