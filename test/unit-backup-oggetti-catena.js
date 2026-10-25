'use strict';

// Si eseguono writer, resolver e restore reali con cataloghi e tabelle vuote.
// Le fixture non contengono validatori, colonne generate o DDL MySQL qualificata:
// quei percorsi hanno regressioni dedicate e non appartengono a questa prova.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EJSON } = require('bson');
const schemaBson = require('../db/mongoSchemaBson');
// Un mutante semantico deve cambiare entrambe le rappresentazioni dello
// schema: un sidecar incoerente proverebbe soltanto il controllo d'integrità.
const mutaMetadati = (value, change) => {
  const changed = change(schemaBson.decodificaMetadati(value));
  return Object.hasOwn(value, schemaBson.FIELD) ? schemaBson.codificaMetadati(changed) : changed;
};
const ordinaDocumento = value => Array.isArray(value) ? value.map(ordinaDocumento)
  : value && typeof value === 'object' && !value._bsontype && !(value instanceof Date) && !(value instanceof RegExp) && !Buffer.isBuffer(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordinaDocumento(value[key])])) : value;
const fotografie = require('../backup/lib/schema-snapshot');
const risolviOriginale = fotografie.risolviOggettiCatena;
const vuoto = (objects) => Object.values(objects || {}).every((items) => Array.isArray(items) && items.length === 0);

if (process.argv.includes('--mutant')) {
  fotografie.risolviOggettiCatena = (chain, options) => {
    const risultato = risolviOriginale(chain, options);
    // Il difetto: il file vuoto viene scambiato per un file assente, facendo
    // ricomparire gli oggetti rimossi nell'ultima fotografia.
    return chain.length > 1 && risultato.complete && vuoto(risultato.objects)
      ? risolviOriginale(chain.slice(0, -1), options) : risultato;
  };
}
if (process.argv.includes('--mutant-primo')) {
  fotografie.risolviOggettiCatena = (chain, options) => risolviOriginale(chain.slice(0, 1), options);
}
if (process.argv.includes('--mutant-indici')) {
  fotografie.risolviOggettiCatena = (chain, options) => ({
    ...risolviOriginale(chain, options), indexes: risolviOriginale(chain.slice(0, 1), options).indexes,
  });
}
if (process.argv.includes('--mutant-nomi')) {
  fotografie.risolviOggettiCatena = (chain, options) => {
    const risultato = risolviOriginale(chain, options);
    return { ...risultato, indexes: Object.assign({}, risultato.indexes),
      indexNames: Object.assign({}, risultato.indexNames) };
  };
}
const percorsoRestore = require.resolve('../backup/lib/restore');
const moduloRestoreOriginale = require.cache[percorsoRestore];
if (process.argv.includes('--mutant-selezione')) {
  const Module = require('module');
  const source = fs.readFileSync(percorsoRestore, 'utf8');
  const controllo = /  if \(onlyCollections\) \{\r?\n    const available = new Set\(chain\.flatMap\([\s\S]*?\r?\n  \}\r?\n/;
  assert(controllo.test(source), 'il mutante deve trovare la validazione della selezione');
  const mutato = new Module(percorsoRestore, module);
  mutato.filename = percorsoRestore;
  mutato.paths = Module._nodeModulePaths(path.dirname(percorsoRestore));
  mutato._compile(source.replace(controllo, ''), percorsoRestore);
  require.cache[percorsoRestore] = mutato;
}
// Il resolver va sostituito prima che i consumatori ne acquisiscano l'export.
const { runRestore, resolveChain } = require('../backup/lib/restore');
const { runBackup } = require('../backup/lib/engine');
const { descriviBackup, createBackupRestoreAdapter } = require('../db/backupRestoreAdapter');
const schemaObjects = require('../db/schemaObjects');
const canonicalIndiceOriginale = schemaObjects.canonicalMongoIndex;
const canonicalInventarioOriginale = schemaObjects.canonicalSchemaInventory;
if (process.argv.includes('--mutant-vista-ordine')) {
  schemaObjects.canonicalSchemaInventory = (objects, options) => canonicalInventarioOriginale({ ...objects,
    views: (objects.views || []).map(view => mutaMetadati(view, native => ({ ...native, pipeline: ordinaDocumento(native.pipeline) }))) }, options);
}
if (process.argv.includes('--mutant-vista-collation')) {
  schemaObjects.canonicalSchemaInventory = (objects, options) => canonicalInventarioOriginale({ ...objects,
    views: (objects.views || []).map(view => mutaMetadati(view, ({ collation, ...native }) => native)) }, options);
}
if (process.argv.includes('--mutant-ordine')) {
  schemaObjects.canonicalMongoIndex = (index) => canonicalIndiceOriginale(mutaMetadati(index, native => ({
    ...native, key: Object.fromEntries(Object.entries(native.key).sort(([a], [b]) => a.localeCompare(b))),
  })));
}
if (process.argv.includes('--mutant-opzioni')) {
  schemaObjects.canonicalMongoIndex = index => canonicalIndiceOriginale(mutaMetadati(index, ({ hidden, weights, ...native }) => native));
}
if (process.argv.includes('--mutant-letterali')) {
  schemaObjects.canonicalMongoIndex = index => canonicalIndiceOriginale(mutaMetadati(index, native => ({ ...native,
    ...(native.partialFilterExpression ? { partialFilterExpression: ordinaDocumento(native.partialFilterExpression) } : {}) })));
}
const motori = ['mongodb', 'mysql', 'postgresql'];
const log = { info() {}, warn() {}, error() {} };
const q = (type, name) => type === 'mysql' ? '`' + name + '`' : '"' + name + '"';
const copia = (value) => JSON.parse(JSON.stringify(value));

function vista(type, name, n) {
  return type === 'mongodb'
    ? { name, viewOn: 'base', pipeline: [{ $project: { n: { $literal: n } } }] }
    : { name, ddl: `CREATE VIEW ${q(type, name)} AS SELECT ${n} AS n` };
}

function creaCatena(root, nome, type, layers) {
  const group = path.join(root, nome);
  fs.mkdirSync(group, { recursive: true });
  let baseId = null;
  let ultimo;
  for (const [index, layer] of layers.entries()) {
    const collection = layer.collection || 'base';
    const tipo = layer.type || (index === 0 ? 'full' : 'incremental');
    const id = `20261023-12000${index}_${tipo}`;
    const dir = path.join(group, id);
    fs.mkdirSync(dir);
    const files = [];
    const aggiungi = (rel, content, meta) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      const bytes = fs.readFileSync(file);
      files.push({ path: rel, bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...meta });
    };
    const columns = [type === 'mongodb' ? '_id' : 'id'];
    aggiungi(`data/${collection}.ndjson`, '', { kind: 'data', collection, count: 0, mode: 'full',
      columns, identity: type === 'mongodb' ? { kind: 'mongodb-id', columns }
        : { kind: 'primary-key', name: 'pk_base', columns },
      ...(type === 'mongodb' ? {} : { columnSchema: [{ name: 'id', type: 'integer', nullable: false }] }),
      sourceCardinality: 0, sourceDistinctIdentities: 0 });
    if (index === 0 && type !== 'mongodb') {
      aggiungi(`schema/${collection}.sql`, `CREATE TABLE ${q(type, collection)} (id integer NOT NULL PRIMARY KEY);`,
        { kind: 'schema', collection, schema: 'src' });
    }
    if (Object.hasOwn(layer, 'objects')) {
      aggiungi('objects/schema.json', JSON.stringify(layer.objects),
        { kind: 'objects', ...(layer.legacy ? {} : { mode: 'snapshot' }), collection: null });
    }
    if (type === 'mongodb' && (Object.hasOwn(layer, 'indexes') || Object.hasOwn(layer, 'objects') && !layer.legacy)) {
      aggiungi(`indexes/${collection}.json`, JSON.stringify(layer.indexes || []), { kind: 'indexes', collection,
        ...(layer.legacyIndexes ?? layer.legacy ? {} : { mode: 'snapshot' }) });
    }
    const startedAt = `2026-10-23T12:00:0${index}.000Z`;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      tool: 'codedb-backup', version: 2, id, type: tipo, baseId,
      connection: 'unit-catena', db: 'src', dbType: type, startedAt, endedAt: startedAt, files,
    }), 'utf8');
    baseId = id;
    ultimo = dir;
  }
  return { backupDir: ultimo, chain: resolveChain(ultimo) };
}

function strategia(type, { catalogoVuoto = false, preesistenti = [], dipendenteEstranea = false, indiciPreesistenti = [] } = {}) {
  const eventi = [];
  const views = new Map();
  const routines = new Map();
  const collezioni = new Map();
  const contatori = new Map();
  const indexes = new Map([{ name: '_id_', key: { _id: 1 } }, ...indiciPreesistenti].map((index) => [index.name, copia(index)]));
  for (const view of preesistenti) views.set(view.name, { n: view.n, sql: vista(type, view.name, view.n).ddl });
  const applicata = (kind, name, content) => {
    eventi.push({ kind, name, content });
    const key = `${kind}:${name}`;
    contatori.set(key, (contatori.get(key) || 0) + 1);
  };
  const eseguiSql = (sql) => {
    const semplice = sql.replace(/["`]/g, '');
    const drop = /^DROP(?:\s+MATERIALIZED)?\s+VIEW\s+(?:IF EXISTS\s+)?(?:dest\.)?(\w+)/i.exec(semplice);
    if (drop) {
      if (dipendenteEstranea && drop[1] === 'v_main') {
        eventi.push({ kind: 'drop-bloccato', name: drop[1] });
        throw Object.assign(new Error('cannot drop view because other objects depend on it'), { code: '2BP01' });
      }
      eventi.push({ kind: 'drop-view', name: drop[1] });
      views.delete(drop[1]);
      return;
    }
    const fn = /^CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+["`]?([\w]+)["`]?/i.exec(sql);
    if (fn) { routines.set(fn[1], sql); applicata('routine', fn[1], sql); return; }
    const view = /^CREATE(?:\s+OR\s+REPLACE)?\s+VIEW\s+["`]?([\w]+)["`]?/i.exec(sql);
    if (!view) return;
    if (views.has(view[1]) && !/^CREATE\s+OR\s+REPLACE/i.test(sql)) throw Object.assign(new Error('view already exists'), { code: '42P07' });
    if (sql.includes('f_value()') && !routines.has('f_value')) throw new Error('routine f_value non ancora presente');
    if (/FROM\s+["`]?v_base["`]?/i.test(sql) && !views.has('v_base')) {
      eventi.push({ kind: 'dipendenza', name: view[1] });
      throw new Error('view v_base non ancora presente');
    }
    const n = /SELECT\s+(\d+)\s+AS\s+n/i.exec(sql)?.[1];
    views.set(view[1], { sql, n: n == null ? null : Number(n) });
    applicata('view', view[1], sql);
  };
  const queryPg = async (sql) => {
    if (sql.includes("relkind IN ('v','m')")) return { rows: [...views.keys()].map((name) => ({ name, kind: 'v' })) };
    if (sql.startsWith('SELECT t.oid, t.typtype')) eventi.push({ kind: 'inizio-dati' });
    if (/SELECT NOT EXISTS\(/.test(sql)) return { rows: [{ empty: true }] };
    if (/SELECT COUNT\(\*\) AS n\b/.test(sql)) return { rows: [{ n: '0' }] };
    if (/SELECT COUNT\(\*\) AS cardinality/.test(sql)) return { rows: [{ cardinality: '0', distinctIdentities: '0' }] };
    if (/SELECT a.attname AS name/.test(sql)) return { rows: [{ name: 'id', ctype: 'integer', notnull: true }] };
    if (/SELECT tc.constraint_name AS name/.test(sql)) return { rows: [{ name: 'pk_base', ctype: 'PRIMARY KEY', col: 'id', pos: 1 }] };
    eseguiSql(sql);
    return { rows: [] };
  };
  const queryMy = async (sql) => {
    if (/FROM information_schema\.VIEWS/i.test(sql)) return [[...views.keys()].map((name) => ({ name }))];
    if (/SELECT @@SESSION.time_zone/.test(sql)) return [[{ timezone: '+00:00', mode: '' }]];
    if (/SELECT NOT EXISTS\(/.test(sql)) return [[{ is_empty: 1 }]];
    if (/SELECT COUNT\(\*\) AS n\b/.test(sql)) return [[{ n: 0 }]];
    if (/SELECT COUNT\(\*\) AS cardinality/.test(sql)) return [[{ cardinality: 0, distinctIdentities: 0 }]];
    if (/SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type/.test(sql)) return [[{ name: 'id', type: 'integer', nullable: 'NO' }]];
    if (/SELECT tc.CONSTRAINT_NAME AS name/.test(sql)) return [[{ name: 'pk_base', ctype: 'PRIMARY KEY', col: 'id', pos: 1 }]];
    eseguiSql(sql);
    return [[]];
  };
  const mongoDb = {
    listCollections(filter = {}) { return { async toArray() {
      return [...collezioni].filter(([name]) => !filter.name || filter.name === name)
        .map(([name, options]) => ({ name, type: options.viewOn ? 'view' : 'collection', options }));
    } }; },
    async createCollection(name, options = {}) {
      if (collezioni.has(name)) throw Object.assign(new Error('collection already exists'), { code: 48 });
      collezioni.set(name, copia(options));
      if (options.viewOn) {
        views.set(name, { n: options.pipeline?.[0]?.$project?.n?.$literal, options: copia(options) });
        applicata('view', name, copia(options));
      }
    },
    collection() { return {
      async countDocuments() { return 0; }, async estimatedDocumentCount() { return 0; },
      async findOne() { return null; },
      aggregate() { return { async toArray() { return []; } }; },
      async indexes() { return [...indexes.values()].map(copia); },
      async dropIndex(name) {
        eventi.push({ kind: 'drop-index', name });
        if (!indexes.delete(name)) throw Object.assign(new Error('index not found'), { code: 27 });
      },
      async createIndex(key, options) {
        const spec = { key: copia(key), ...copia(options) };
        indexes.set(options.name, spec);
        applicata('index', options.name, spec);
        return options.name;
      },
    }; },
    async command(command) {
      if (command.hello) return { isWritablePrimary: true };
      assert.fail('la fixture non richiede collMod o validatori');
    },
  };
  const strategy = {
    type,
    async listCollections() { return catalogoVuoto ? [] : [{ name: 'base', type: 'table' }]; },
    pool: {
      query: type === 'mysql' ? queryMy : queryPg,
      async connect() { return { query: queryPg, release() {} }; },
      async getConnection() { return { query: queryMy, release() {} }; },
    },
    client: { db() { return mongoDb; } },
    async collectionAggregate(_db, _collection, { pipeline }) {
      if (pipeline.startsWith('SELECT tablename FROM pg_catalog.pg_tables')) return { docs: [] };
      eseguiSql(pipeline);
      return { docs: [] };
    },
    async collectionImport() { assert.fail('le tabelle della fixture devono essere vuote'); },
  };
  return { strategy, views, routines, indexes, eventi, contatori };
}

async function ripristina(fixture, type, marker, options) {
  const fake = strategia(type, options);
  let summary;
  try {
    summary = await runRestore({ session: { strategy: fake.strategy, dbType: type },
      backupDir: fixture.backupDir, targetDb: 'dest', drop: false, log });
  } catch (err) { assert.fail(`${marker} il ripristino valido deve riuscire: ${err.message}`); }
  return { ...fake, summary };
}

const casi = [];
casi.push(['le pipeline delle viste MongoDB conservano ordine di sort e documenti letterali', async () => {
  const canonical = pipeline => schemaObjects.canonicalSchemaInventory({ views: [schemaBson.codificaMetadati({ name: 'vista', viewOn: 'base', pipeline })] });
  for (const [name, pipeline, reversed] of [
    ['sort', [{ $sort: { a: 1, b: 1 } }], [{ $sort: { b: 1, a: 1 } }]],
    ['literal', [{ $project: { valore: { $literal: { a: 1, b: 2 } } } }], [{ $project: { valore: { $literal: { b: 2, a: 1 } } } }]],
  ]) {
    assert.notDeepStrictEqual(canonical(pipeline), canonical(reversed), `[SCHEMA-VISTA-ORDINE] ${name}: ordine diverso è semantica diversa`);
    assert.deepStrictEqual(canonical(pipeline), schemaObjects.canonicalSchemaInventory({ views: [{ name: 'vista', viewOn: 'base', pipeline: EJSON.serialize(pipeline, { relaxed: false }) }] }),
      `[SCHEMA-VISTA-EJSON] ${name}: la rappresentazione EJSON conserva il medesimo valore BSON`);
  }
}]);
casi.push(['le viste MongoDB distinguono collation reali e normalizzano solo il default', async () => {
  const view = { name: 'vista', viewOn: 'base', pipeline: [{ $match: { codice: 'caffè' } }] };
  const canonical = collation => schemaObjects.canonicalSchemaInventory({ views: [schemaBson.codificaMetadati({ ...view, ...collation })] });
  assert.deepStrictEqual(canonical({}), canonical({ collation: null }),
    '[SCHEMA-VISTA-COLLATION] collation assente e null descrivono lo stesso default');
  assert.deepStrictEqual(canonical({}), canonical({ collation: undefined }));
  assert.notDeepStrictEqual(canonical({}), canonical({ collation: { locale: 'it', strength: 1 } }),
    '[SCHEMA-VISTA-COLLATION] una collation esplicita non può sparire dalla verifica');
  assert.notDeepStrictEqual(canonical({ collation: { locale: 'it', strength: 1 } }),
    canonical({ collation: { locale: 'it', strength: 2 } }),
    '[SCHEMA-VISTA-COLLATION] le differenze reali di collation restano verificabili');
}]);
casi.push(['la verifica degli indici composti conserva l’ordine dei campi', async () => {
  const indice = { name: 'composto', key: { stato: 1, data: -1 }, unique: true,
    collation: { locale: 'it', strength: 2 } };
  const prima = JSON.stringify(indice);
  const inverso = { ...indice, key: { data: -1, stato: 1 } };
  assert.notStrictEqual(schemaObjects.canonicalMongoIndex(schemaBson.codificaMetadati(indice)), schemaObjects.canonicalMongoIndex(schemaBson.codificaMetadati(inverso)),
    '[SCHEMA-INDICE-ORDINE] invertire i campi di un indice composto cambia il suo significato');
  assert.strictEqual(schemaObjects.canonicalMongoIndex(indice), schemaObjects.canonicalMongoIndex({
    collation: { strength: 2, locale: 'it' }, unique: true, key: { stato: 1, data: -1 }, name: 'composto',
  }), '[SCHEMA-INDICE-ORDINE] l’ordine dei descrittori e delle opzioni non cambia l’indice');
  assert(schemaObjects.inventoryDifferences({ indexes: [schemaObjects.canonicalMongoIndex(indice)] },
    { indexes: [schemaObjects.canonicalMongoIndex(inverso)] }).length,
  '[SCHEMA-INDICE-ORDINE] il confronto inventari deve rifiutare un indice composto invertito');
  assert.strictEqual(JSON.stringify(indice), prima, 'la canonicalizzazione non modifica la chiave originale');
}]);
casi.push(['la verifica MongoDB conserva tutte le opzioni semantiche degli indici', async () => {
  const base = { name: 'indice', key: { campo: 1 } };
  const canonica = schemaObjects.canonicalMongoIndex;
  const varianti = [
    ['hidden', false, true], ['unique', false, true], ['sparse', false, true],
    ['weights', { titolo: 1, testo: 2 }, { titolo: 2, testo: 1 }],
    ['default_language', 'italian', 'english'], ['language_override', 'lingua', 'language'],
    ['textIndexVersion', 2, 3], ['2dsphereIndexVersion', 2, 3],
    ['bits', 26, 30], ['min', -180, -90], ['max', 180, 90], ['bucketSize', 1, 2],
    ['expireAfterSeconds', 0, 3600], ['wildcardProjection', { nome: 1 }, { data: 1 }],
    ['partialFilterExpression', { stato: 'attivo' }, { stato: 'archiviato' }],
    ['collation', { locale: 'it', strength: 1 }, { locale: 'it', strength: 2 }],
    ['storageEngine', { wiredTiger: { configString: 'block_compressor=zlib' } }, { wiredTiger: { configString: 'block_compressor=zstd' } }],
    ['opzioneFutura', { valore: 1 }, { valore: 2 }], ['prepareUnique', false, true],
  ];
  for (const [option, first, second] of varianti) {
    assert.notStrictEqual(canonica(schemaBson.codificaMetadati({ ...base, [option]: first })), canonica(schemaBson.codificaMetadati({ ...base, [option]: second })),
      `[SCHEMA-INDICE-OPZIONI] la differenza di ${option} deve restare verificabile`);
  }
  for (const flag of ['unique', 'sparse', 'hidden']) assert.strictEqual(canonica(base), canonica({ ...base, [flag]: false }),
    `[SCHEMA-INDICE-PREDEFINITI] ${flag}: falso equivale all'assenza`);
  assert.strictEqual(canonica(base), canonica({ ...base, v: 2, ns: 'src.base', background: true,
    buildUUID: 'costruzione-transitoria', ready: true, dropDups: false }),
  '[SCHEMA-INDICE-METADATI] formato interno, namespace e flag di costruzione non cambiano la semantica');
  assert.strictEqual(canonica(base), canonica(EJSON.parse(JSON.stringify(base), { relaxed: false })),
    '[SCHEMA-INDICE-BSON] i numeri del catalogo e gli Int32 del backup devono equivalere');
  const { Long } = require('bson');
  assert.notStrictEqual(canonica({ ...base, partialFilterExpression: { n: Long.fromString('9007199254740992') } }),
    canonica({ ...base, partialFilterExpression: { n: Long.fromString('9007199254740993') } }),
    '[SCHEMA-INDICE-BSON] i filtri con interi oltre i 53 bit non possono essere arrotondati');
  for (const operator of [null, '$eq', '$in']) {
    const filtro = value => ({ campo: operator === null ? value : { [operator]: operator === '$in' ? [value] : value } });
    const a = { annidato: { a: 1, b: 2 } }, b = { annidato: { b: 2, a: 1 } };
    assert.notStrictEqual(canonica(schemaBson.codificaMetadati({ ...base, partialFilterExpression: filtro(a) })),
      canonica(schemaBson.codificaMetadati({ ...base, partialFilterExpression: filtro(b) })),
      `[SCHEMA-INDICE-LETTERALI] ${operator || 'uguaglianza implicita'}: l'ordine dei documenti BSON letterali deve restare intatto`);
  }
}]);

casi.push(['una selezione assente viene rifiutata prima di ogni mutazione', async (root) => {
  for (const type of motori) {
    const fixture = creaCatena(root, `selezione-assente-${type}`, type, [{ objects: {}, indexes: [
      { name: 'idx_base', key: { codice: 1 } },
    ] }]);
    const nienteAccessi = () => assert.fail('[SCHEMA-CATENA-SELEZIONE] la selezione invalida deve essere rifiutata prima di accedere al target');
    const strategy = { listCollections: nienteAccessi, collectionAggregate: nienteAccessi,
      client: { db: nienteAccessi }, pool: { query: nienteAccessi, connect: nienteAccessi, getConnection: nienteAccessi } };
    for (const onlyCollections of [['inesistente'], ['base', 'inesistente']]) {
      for (const drop of [false, true]) await assert.rejects(runRestore({ session: { strategy, dbType: type },
        backupDir: fixture.backupDir, targetDb: 'dest', onlyCollections, drop, log }), /non presente nel backup/,
      '[SCHEMA-CATENA-SELEZIONE] niente DROP di dati, indici o oggetti prima della validazione');
      assert.throws(() => descriviBackup(fixture.backupDir, onlyCollections), /non presente nel backup/,
        '[SCHEMA-CATENA-SELEZIONE] anche il piano deve rifiutare la selezione assente');
    }
  }
}]);

const casoNomi = ['il resolver tratta i nomi speciali come chiavi ordinarie', async (root) => {
  for (const collection of ['__proto__', 'constructor']) {
    const originale = { name: 'idx_primo', key: JSON.parse('{"__proto__":1,"constructor":-1}') };
    const finale = { name: 'idx_finale', key: { valore: -1 } };
    const fixture = creaCatena(root, `nomi-${collection}`, 'mongodb', [
      { collection, objects: {}, indexes: [originale] }, { collection, objects: {}, indexes: [finale] },
    ]);
    const result = fotografie.risolviOggettiCatena(fixture.chain);
    assert(Object.hasOwn(result.indexes, collection), '[SCHEMA-CATENA-NOMI] il nome della collection deve essere una proprietà propria');
    assert(Object.hasOwn(result.indexNames, collection), '[SCHEMA-CATENA-NOMI] anche l’inventario storico conserva il nome esatto');
    assert.deepStrictEqual(EJSON.serialize(result.indexes[collection], { relaxed: true }), [finale],
      '[SCHEMA-CATENA-NOMI] la fotografia finale non si confonde con il prototipo');
    assert.deepStrictEqual(result.indexNames[collection], ['idx_primo', 'idx_finale']);
    assert.strictEqual(result.complete, true);
  }
}];
casi.push(['la fotografia finale sostituisce viste modificate e rimosse sui tre motori', async (root) => {
  for (const type of motori) {
    for (const tipoFinale of ['incremental', 'differential']) {
      const fixture = creaCatena(root, `${type}-${tipoFinale}`, type, [
        { objects: { views: [vista(type, 'v_main', 1), vista(type, 'v_rimossa', 9)] } },
        { type: tipoFinale, objects: { views: [vista(type, 'v_main', 2)] } },
      ]);
      const out = await ripristina(fixture, type, '[SCHEMA-CATENA-FINALE]');
      assert.deepStrictEqual([...out.views.keys()], ['v_main'],
        `[SCHEMA-CATENA-FINALE] ${type}: la vista rimossa non deve ricomparire`);
      assert.deepStrictEqual(EJSON.serialize(out.views.get('v_main').n, { relaxed: false }), EJSON.serialize(2, { relaxed: false }),
        `[SCHEMA-CATENA-FINALE] ${type}: deve valere la nuova definizione, con il tipo BSON conservato`);
      assert.strictEqual(out.contatori.get('view:v_main'), 1, '[SCHEMA-CATENA-UNA-VOLTA] la vista finale deve essere applicata una sola volta');
      assert.strictEqual(out.summary.coerenzaSchema.completa, true);
      assert.strictEqual(out.summary.coerenzaSchema.layerId, fixture.chain.at(-1).manifest.id);
    }
  }
}]);

casi.push(['una fotografia finale vuota rimuove tutti gli oggetti attesi', async (root) => {
  for (const type of motori) {
    const fixture = creaCatena(root, `vuota-${type}`, type, [
      { objects: { views: [vista(type, 'v_rimossa', 9)] } }, { objects: {} },
    ]);
    const resolved = fotografie.risolviOggettiCatena(fixture.chain);
    assert(vuoto(resolved.objects), `[SCHEMA-CATENA-VUOTA] ${type}: vuoto esplicito non significa assente`);
    assert.strictEqual(resolved.complete, true, '[SCHEMA-CATENA-VUOTA] il vuoto esplicito è una fotografia completa');
    const out = await ripristina(fixture, type, '[SCHEMA-CATENA-VUOTA]');
    assert.strictEqual(out.views.size, 0, `[SCHEMA-CATENA-VUOTA] ${type}: non applicare vecchie viste`);
    assert.strictEqual(out.eventi.filter((e) => e.kind === 'view').length, 0);
    assert.strictEqual(out.summary.coerenzaSchema.completa, true);
  }
}]);

casi.push(['viste SQL omonime aggiornate senza eliminare dipendenze estranee', async (root) => {
  for (const type of ['mysql', 'postgresql']) {
    for (const dipendenteEstranea of [false, true]) {
      const fixture = creaCatena(root, `merge-${type}-${dipendenteEstranea}`, type, [
        { objects: { views: [vista(type, 'v_main', 1)] } },
        { objects: { views: [vista(type, 'v_main', 2)] } },
      ]);
      const out = await ripristina(fixture, type, '[SCHEMA-CATENA-MERGE]', {
        preesistenti: [{ name: 'v_main', n: 99 }, { name: 'v_estranea', n: 7 }], dipendenteEstranea,
      });
      assert.deepStrictEqual(EJSON.serialize(out.views.get('v_main').n, { relaxed: false }), EJSON.serialize(2, { relaxed: false }),
        '[SCHEMA-CATENA-MERGE] la vista omonima deve ricevere la definizione finale');
      assert.deepStrictEqual(EJSON.serialize(out.views.get('v_estranea').n, { relaxed: false }), EJSON.serialize(7, { relaxed: false }),
        '[SCHEMA-CATENA-MERGE] preservare la vista estranea');
      assert(!out.eventi.some((e) => e.kind === 'drop-view' && e.name === 'v_estranea'),
        '[SCHEMA-CATENA-MERGE] nessuna eliminazione di oggetti estranei');
      assert.strictEqual(out.contatori.get('view:v_main'), 1, '[SCHEMA-CATENA-UNA-VOLTA] una sola applicazione della definizione finale');
      if (dipendenteEstranea) assert(out.eventi.some((e) => e.kind === 'drop-bloccato'),
        'il caso deve attraversare il fallback non distruttivo dopo DROP bloccata');
    }
  }
}]);

casi.push(['la lettura e validazione del piano rispettano allowUnsafeSchema esplicito', async (root) => {
  const fixture = creaCatena(root, 'permesso-schema', 'postgresql', [{ objects: {
    views: [{ name: 'v_main', ddl: 'CREATE VIEW v_main AS SELECT n FROM esterno.segreti' }],
  } }]);
  assert.throws(() => descriviBackup(fixture.backupDir), /esterno|schema|qualificat|cross|riferiment/i,
    '[SCHEMA-CATENA-PERMESSO] senza autorizzazione il riferimento esterno deve essere rifiutato');
  const source = descriviBackup(fixture.backupDir, null, { allowUnsafeSchema: true });
  const fake = strategia('postgresql');
  const adapter = createBackupRestoreAdapter({ strategy: fake.strategy, dbType: 'postgresql', connName: 'unit-catena', log });
  const plan = { kind: 'restore-backup', dbType: 'postgresql', source, sourceDb: 'src', targetDb: 'dest',
    collections: source.collections, drop: false, allowUnsafeSchema: true };
  await adapter.validatePlan(plan);
  await assert.rejects(adapter.validatePlan({ ...plan, allowUnsafeSchema: false }), /esterno|schema|qualificat|cross|riferiment/i,
    '[SCHEMA-CATENA-PERMESSO] il flag non deve restare implicito da una precedente validazione');
  assert.strictEqual(fake.eventi.length, 0, 'validare il piano non deve applicare oggetti');
}]);

casi.push(['compatibilità storica: ultima fotografia disponibile e limite dichiarato', async (root) => {
  for (const type of motori) {
    const antica = { views: [vista(type, 'v_main', 1), vista(type, 'v_ignota', 9)] };
    const recente = { views: [vista(type, 'v_main', 2)] };
    const varianti = [
      ['file assente', [{ objects: antica, legacy: true }, {}], antica, false, 0],
      ['ultimo file storico', [{ objects: antica, legacy: true }, { objects: recente, legacy: true }], recente, false, 1],
      ['nessun file', [{}, {}], {}, false, null],
      ['coda storica dopo snapshot', [{ objects: antica }, {}], antica, false, 0],
      ['nuova fotografia dopo storico', [{ objects: antica, legacy: true }, { objects: recente }], recente, true, 1],
    ];
    for (const [nome, layers, attesi, complete, posizione] of varianti) {
      const fixture = creaCatena(root, `legacy-${type}-${nome}`, type, layers);
      const prima = JSON.stringify(fixture.chain);
      const result = fotografie.risolviOggettiCatena(fixture.chain);
      assert.deepStrictEqual(EJSON.serialize(result.objects.views || [], { relaxed: false }), EJSON.serialize(attesi.views || [], { relaxed: false }),
        `[SCHEMA-CATENA-LEGACY] ${type}/${nome}: non unire fotografie né dedurre rimozioni`);
      assert.strictEqual(result.complete, complete, `[SCHEMA-CATENA-LEGACY] ${type}/${nome}: completezza corretta`);
      assert.strictEqual(result.layerId, posizione == null ? null : fixture.chain[posizione].manifest.id);
      assert.strictEqual(result.db, 'src');
      if (!complete) assert(typeof result.nota === 'string' && result.nota.length > 20,
        '[SCHEMA-CATENA-LEGACY] il limite dello storico deve essere comunicato');
      else assert.strictEqual(result.nota, null);
      assert.strictEqual(JSON.stringify(fixture.chain), prima, 'il resolver non modifica la catena');
    }
    const fixture = creaCatena(root, `legacy-restore-${type}`, type, [{ objects: antica, legacy: true }, {}]);
    const out = await ripristina(fixture, type, '[SCHEMA-CATENA-LEGACY]');
    assert.strictEqual(out.summary.coerenzaSchema.completa, false);
    assert(out.summary.coerenzaSchema.nota, 'anche il riepilogo restore dichiara il limite storico');
    assert.deepStrictEqual([...out.views.keys()].sort(), ['v_ignota', 'v_main']);
  }
}]);

casi.push(['MongoDB applica una volta gli indici finali e rispetta l’inventario vuoto', async (root) => {
  const originale = { name: 'idx_stato', key: { stato: 1 }, unique: false };
  const finale = { name: 'idx_stato', key: { stato: -1 }, unique: true };
  const rimosso = { name: 'idx_rimosso', key: { codice: 1 } };
  const estraneo = { name: 'idx_estraneo', key: { altro: 1 } };
  for (const finali of [[finale], []]) {
    const fixture = creaCatena(root, `indici-mongo-${finali.length}`, 'mongodb', [
      { objects: {}, indexes: [originale, rimosso] }, { objects: {}, indexes: finali },
    ]);
    const resolved = fotografie.risolviOggettiCatena(fixture.chain);
    assert.deepStrictEqual(EJSON.serialize(resolved.indexes.base, { relaxed: true }), finali,
      '[SCHEMA-CATENA-INDICI] la fotografia finale degli indici sostituisce quella full, anche quando è vuota');
    const out = await ripristina(fixture, 'mongodb', '[SCHEMA-CATENA-INDICI]', {
      indiciPreesistenti: [originale, rimosso, estraneo],
    });
    assert.deepStrictEqual([...out.indexes.keys()].sort(), ['_id_', 'idx_estraneo', ...finali.map((index) => index.name)].sort(),
      '[SCHEMA-CATENA-INDICI] rimuovere solo i nomi noti alla catena, conservando _id_ ed estranei');
    if (finali.length) assert.deepStrictEqual(out.indexes.get('idx_stato'), finale,
      '[SCHEMA-CATENA-INDICI] conservare chiavi, direzione e univocità della definizione finale');
    assert.strictEqual(out.eventi.filter((e) => e.kind === 'index').length, finali.length,
      '[SCHEMA-CATENA-INDICI] ogni indice finale deve essere creato una volta');
    assert(!out.eventi.some((e) => e.kind === 'drop-index' && ['_id_', 'idx_estraneo'].includes(e.name)),
      '[SCHEMA-CATENA-INDICI] nessuna rimozione degli indici fuori dal perimetro dichiarato');
  }
  const legacy = creaCatena(root, 'indici-mongo-storici', 'mongodb', [
    { legacy: true, objects: {}, indexes: [originale] }, {},
  ]);
  const resolved = fotografie.risolviOggettiCatena(legacy.chain);
  assert.deepStrictEqual(EJSON.serialize(resolved.indexes.base, { relaxed: true }), [originale],
    '[SCHEMA-CATENA-INDICI] ereditare l’ultima fotografia storica nota');
  assert.strictEqual(resolved.complete, false, '[SCHEMA-CATENA-INDICI] gli indici storici non provano le rimozioni successive');
}]);

casi.push(casoNomi);

casi.push(['PostgreSQL usa routine finali prima dei dati e risolve le dipendenze delle viste', async (root) => {
  const fn = (name, n) => ({ name, ddl: `CREATE FUNCTION ${name}() RETURNS integer LANGUAGE SQL IMMUTABLE AS $$SELECT ${n}$$` });
  const fixture = creaCatena(root, 'pg-dipendenze', 'postgresql', [
    { objects: { routines: [fn('f_value', 1), fn('f_rimossa', 9)], views: [vista('postgresql', 'v_vecchia', 1)] } },
    { objects: { routines: [fn('f_value', 2)], views: [
      { name: 'v_dep', ddl: 'CREATE VIEW v_dep AS SELECT n FROM v_base' },
      { name: 'v_routine', ddl: 'CREATE VIEW v_routine AS SELECT f_value() AS n' },
      vista('postgresql', 'v_base', 2),
    ] } },
  ]);
  const out = await ripristina(fixture, 'postgresql', '[SCHEMA-CATENA-DIPENDENZE]');
  assert.deepStrictEqual([...out.routines.keys()], ['f_value'], '[SCHEMA-CATENA-DIPENDENZE] non ricreare routine rimosse');
  assert(out.routines.get('f_value').includes('SELECT 2'), '[SCHEMA-CATENA-DIPENDENZE] usare il corpo finale della routine');
  assert.strictEqual(out.contatori.get('routine:f_value'), 1,
    '[SCHEMA-CATENA-UNA-VOLTA] la routine preparata prima dei dati non va applicata di nuovo dopo');
  const routineIndex = out.eventi.findIndex((e) => e.kind === 'routine' && e.name === 'f_value');
  const datiIndex = out.eventi.findIndex((e) => e.kind === 'inizio-dati');
  assert(routineIndex >= 0 && datiIndex > routineIndex, '[SCHEMA-CATENA-PREREQUISITI] la routine finale precede la fase dati');
  assert.deepStrictEqual([...out.views.keys()].sort(), ['v_base', 'v_dep', 'v_routine']);
  for (const name of out.views.keys()) assert.strictEqual(out.contatori.get(`view:${name}`), 1,
    `[SCHEMA-CATENA-UNA-VOLTA] ${name}: contare le applicazioni riuscite, non i tentativi per dipendenze`);
  assert(out.eventi.some((e) => e.kind === 'dipendenza'), 'la prova deve esercitare il riordino delle dipendenze');
}]);

casi.push(['il writer emette una fotografia completa anche senza oggetti', async (root) => {
  for (const type of motori) {
    const fake = strategia(type, { catalogoVuoto: true });
    const result = await runBackup({ session: { strategy: fake.strategy, dbType: type }, connName: `vuoto-${type}`,
      db: 'src', type: 'full', onlyCollections: null, destRoot: path.join(root, `writer-${type}`), compress: false, log });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir, 'manifest.json'), 'utf8'));
    const files = manifest.files.filter((file) => file.kind === 'objects');
    assert.strictEqual(files.length, 1, `[SCHEMA-CATENA-WRITER] ${type}: anche il vuoto deve produrre un file`);
    assert.strictEqual(files[0].mode, 'snapshot', '[SCHEMA-CATENA-WRITER] la fotografia completa deve essere esplicita');
    const bytes = fs.readFileSync(path.join(result.backupDir, files[0].path));
    assert.strictEqual(files[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert(vuoto(JSON.parse(bytes)), `[SCHEMA-CATENA-WRITER] ${type}: non inventare oggetti`);
    const resolved = fotografie.risolviOggettiCatena(resolveChain(result.backupDir));
    assert.strictEqual(resolved.complete, true);
    assert(vuoto(resolved.objects));
  }
}]);

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-unit-oggetti-catena-'));
  try {
    for (const [nome, esegui] of casi) {
      await esegui(root);
      console.log('  OK   Oggetti catena:', nome);
    }
  } finally {
    fotografie.risolviOggettiCatena = risolviOriginale;
    schemaObjects.canonicalMongoIndex = canonicalIndiceOriginale;
    schemaObjects.canonicalSchemaInventory = canonicalInventarioOriginale;
    if (process.argv.includes('--mutant-selezione')) {
      if (moduloRestoreOriginale) require.cache[percorsoRestore] = moduloRestoreOriginale;
      else delete require.cache[percorsoRestore];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
if (require.main === module) module.exports.catch((err) => { console.error(err); process.exitCode = 1; });
