'use strict';

const { mysqlSchemaObjects } = require('../backup/lib/engine');
const { pgSchemaObjects } = require('./pg-ddl');
const { quotaSempre } = require('./identificatori');
const { codificaMetadati, decodificaMetadati, documentoCanonico } = require('./mongoSchemaBson');

/** Legge gli oggetti non-tabella usando gli stessi cataloghi del backup full. */
async function readSchemaObjects(strategy, dbType, db) {
  const type = dbType === 'postgres' ? 'postgresql' : dbType;
  if (type === 'mongodb') {
    const infos = await strategy.client.db(db).listCollections({}, { promoteValues: false }).toArray();
    const out = { views: [], collectionOptions: [] };
    for (const info of infos) {
      if (info.type === 'view') {
        out.views.push({
          name: info.name, viewOn: info.options && info.options.viewOn,
          pipeline: info.options && info.options.pipeline || [],
          collation: info.options && info.options.collation,
        });
      } else {
        const options = { ...(info.options || {}) };
        delete options.uuid;
        delete options.idIndex;
        if (Object.keys(options).length) out.collectionOptions.push({ name: info.name, options });
      }
    }
    out.views = out.views.map(codificaMetadati);
    out.collectionOptions = out.collectionOptions.map(codificaMetadati);
    return out;
  }
  if (type === 'mysql') {
    const conn = await strategy.pool.getConnection();
    try { return await mysqlSchemaObjects(conn, db); }
    finally { conn.release(); }
  }
  if (type === 'postgresql') {
    const client = await strategy.pool.connect();
    try { return await pgSchemaObjects((sql, params) => client.query(sql, params), db); }
    finally { client.release(); }
  }
  throw new Error(`Motore non supportato per gli oggetti di schema: ${dbType}.`);
}

function objectInventory(objects) {
  const out = {};
  for (const field of ['views', 'collectionOptions', 'routines', 'triggers', 'events', 'sequences', 'types', 'collations', 'extensions']) {
    out[field] = (objects && objects[field] || []).map((item) => String(item.name)).sort();
  }
  return out;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

// Il catalogo può esprimere una condizione regex come operatori di campo o
// come BSONRegExp. Sono equivalenti soltanto in quel contesto: sotto $eq/$in
// un documento con chiavi $regex/$options rimane invece un valore letterale.
function canonicaValidatorMongo(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return query;
  const condizione = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    if (value._bsontype || value instanceof Date || value instanceof RegExp) return value;
    const keys = Object.keys(value);
    if (typeof value.$regex === 'string' && keys.every(key => key === '$regex' || key === '$options')
        && (value.$options === undefined || typeof value.$options === 'string')) {
      return new (require('bson').BSONRegExp)(value.$regex, value.$options || '');
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === '$not' ? condizione(item) : key === '$elemMatch' ? canonicaValidatorMongo(item) : item]));
  };
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key,
    ['$and', '$or', '$nor'].includes(key) && Array.isArray(value) ? value.map(canonicaValidatorMongo)
      : !key.startsWith('$') ? condizione(value) : value]));
}

// Compatta solo lo spazio esterno a stringhe e identificatori quotati: il
// contenuto di una routine o di una CHECK resta semanticamente intatto.
function canonicalSql(sql) {
  const input = String(sql || '').trim().replace(/;+\s*$/, '');
  let out = '';
  let quote = null;
  let pendingSpace = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (input[i + 1] === quote) out += input[++i];
        else quote = null;
      } else if (ch === '\\' && quote !== '`' && input[i + 1]) out += input[++i];
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      if (pendingSpace && out && !/[\s(.]/.test(out[out.length - 1])) out += ' ';
      pendingSpace = false; quote = ch; out += ch; continue;
    }
    if (/\s/.test(ch)) { pendingSpace = true; continue; }
    if (pendingSpace && out && !/[\s(.]/.test(out[out.length - 1]) && !/[),.;]/.test(ch)) out += ' ';
    pendingSpace = false; out += ch;
  }
  return out;
}

/**
 * La forma canonica di una DDL, senza la qualificazione del database.
 *
 * Perche' TUTTE le forme di quotatura. Il confronto fra cio' che ci si aspetta
 * e cio' che il motore riporta non deve dipendere da come il motore ha deciso
 * di scrivere il nome del database: MySQL, per esempio, qualifica una view con
 * `SHOW CREATE VIEW` soltanto quando il database NON e' quello corrente della
 * connessione. La stessa identica view tornava quindi in due forme diverse a
 * seconda del contesto, e l'import la dichiarava «mancante» sul proprio stesso
 * staging. Si toglievano solo il nome nudo e quello fra virgolette doppie
 * (PostgreSQL): la forma fra apici inversi, cioe' quella che MySQL usa sempre,
 * restava — ed era proprio quella che serviva togliere.
 */
function canonicalSqlForDb(sql, db) {
  const indice = require('./pg-indici').canonicaIndice(sql, db);
  if (indice != null) return indice;
  let normalized = canonicalSql(sql);
  const name = String(db || '');
  if (!name) return normalized;
  const proteggi = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forme = [
    proteggi(quotaSempre(name, 'postgresql')),  // "nome"
    proteggi(quotaSempre(name, 'mysql')),       // `nome`
    proteggi(name),                             // nome
  ];
  normalized = normalized.replace(new RegExp('(?:' + forme.join('|') + ')\\.', 'g'), '');
  return normalized;
}

/**
 * La forma canonica di un indice MongoDB: la sua SEMANTICA, non la sua
 * presentazione.
 *
 * I due lati del confronto non scrivono lo stesso indice allo stesso modo. Il
 * server omette le opzioni lasciate al valore predefinito, quindi un indice non
 * univoco non ha affatto il campo `unique`; l'artefatto esportato, invece, lo
 * porta come `unique: false`. Confrontando la PRESENZA del campo, ogni indice
 * non univoco risultava divergente e l'import falliva la verifica del proprio
 * stesso staging su qualunque database che avesse un indice.
 *
 * Le opzioni booleane assenti valgono quindi il loro predefinito e vengono
 * omesse da entrambe le parti. Cio' che ha un valore — `expireAfterSeconds` di
 * un TTL, un `partialFilterExpression`, una `collation` — resta, perche' li'
 * una differenza e' una differenza vera.
 */
function canonicalMongoIndex(index) {
  const semantic = Object.create(null);
  if (!index) return JSON.stringify(semantic);
  index = decodificaMetadati(index);
  const metadati = new Set(['v', 'ns', 'background', 'buildUUID', 'ready', 'dropDups']);
  const falsePredefinito = new Set(['unique', 'sparse', 'hidden']);
  for (const [option, value] of Object.entries(index)) {
    if (value === undefined || metadati.has(option) || (falsePredefinito.has(option) && value === false)) continue;
    // Nell'indice composto l'ordine delle colonne cambia i prefissi ricercabili.
    // L'array conserva quell'ordine anche quando ordiniamo il descrittore.
    semantic[option] = option === 'key' && value && typeof value === 'object'
      ? Object.entries(value) : value;
  }
  // L'elenco chiuso riguarda solo metadati e valori predefiniti: le opzioni
  // semantiche, comprese quelle introdotte da nuovi server, non vanno perse.
  // EJSON rende confrontabili numeri del driver e Int32 letti dal backup,
  // conservando invece Int64, date e altri valori BSON senza arrotondarli.
  const { EJSON } = require('bson');
  const serialized = EJSON.serialize(semantic, { relaxed: false });
  // Nel filtro un oggetto può essere un valore letterale BSON: {a:1,b:2}
  // non equivale a {b:2,a:1}. Conserviamo prudentemente tutto l'ordine del
  // filtro, anche annidato, senza dedurne equivalenze da un parser parziale.
  if (serialized.partialFilterExpression !== undefined) {
    serialized.partialFilterExpression = documentoCanonico(canonicaValidatorMongo(semantic.partialFilterExpression));
  }
  return JSON.stringify(canonicalValue(serialized));
}

function canonicalSchemaInventory(objects, { db = null } = {}) {
  const result = {};
  for (const field of ['views', 'collectionOptions', 'routines', 'triggers', 'events', 'sequences', 'sequenceValues', 'types', 'collations', 'extensions']) {
    result[field] = (objects && objects[field] || []).map((item) => {
      let normalized = { ...item };
      // Il normalizzatore degli archivi MongoDB può rendere esplicita l'assenza
      // di collation con null; listCollections omette invece la proprietà.
      if (field === 'views' && Object.hasOwn(normalized, 'viewOn')) {
        normalized = decodificaMetadati(item);
        if (normalized.collation == null) delete normalized.collation;
        const pipeline = normalized.pipeline;
        normalized = require('bson').EJSON.serialize(normalized, { relaxed: false });
        // $sort e i documenti $literal dipendono dall'ordine dei campi.
        // La normalizzazione dell'inventario non può riordinarli.
        if (pipeline !== undefined) normalized.pipeline = documentoCanonico(pipeline);
      }
      if (field === 'collectionOptions' && normalized.options) {
        normalized = decodificaMetadati(item);
        const options = { ...normalized.options };
        // collMod rende espliciti i valori predefiniti del validator: la loro
        // presenza non cambia il vincolo, mentre moderate/off/warn lo cambiano.
        if (options.validationLevel === 'strict') delete options.validationLevel;
        if (options.validationAction === 'error') delete options.validationAction;
        if (options.validator && typeof options.validator === 'object'
            && !Array.isArray(options.validator) && Object.keys(options.validator).length === 0) delete options.validator;
        // Senza vincoli né altre opzioni il catalogo può omettere del tutto
        // l'entry: collMod può invece materializzare soltanto i default.
        if (Object.keys(options).length === 0 && Object.keys(normalized).every(key => key === 'name' || key === 'options')) return null;
        const { EJSON } = require('bson');
        normalized.options = EJSON.serialize(options, { relaxed: false });
        // EJSON conserva i tipi BSON e gli interi esatti; l'ordine preserva i
        // documenti letterali annidati nelle espressioni del validator.
        if (normalized.options.validator !== undefined) {
          normalized.options.validator = documentoCanonico(canonicaValidatorMongo(options.validator));
        }
      }
      if (normalized.ddl != null) normalized.ddl = canonicalSqlForDb(normalized.ddl, db);
      if (normalized.sql != null) normalized.sql = canonicalSqlForDb(normalized.sql, db);
      return JSON.stringify(canonicalValue(normalized));
    }).filter(value => value !== null).sort();
  }
  result.foreignKeys = (objects && objects.foreignKeys || [])
    .map((sql) => canonicalSqlForDb(sql, db)).sort();
  result.indexes = (objects && objects.indexes || [])
    .map((sql) => canonicalSqlForDb(sql, db)).sort();
  return result;
}

function inventoryDifferences(expected, actual, { exact = true } = {}) {
  const differences = [];
  for (const field of new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])) {
    const wanted = expected[field] || [];
    const found = actual[field] || [];
    const foundCounts = new Map();
    for (const value of found) foundCounts.set(value, (foundCounts.get(value) || 0) + 1);
    const missing = [];
    for (const value of wanted) {
      const count = foundCounts.get(value) || 0;
      if (count) foundCounts.set(value, count - 1); else missing.push(value);
    }
    const extras = exact ? [...foundCounts].flatMap(([value, count]) => Array(count).fill(value)) : [];
    if (missing.length || extras.length) differences.push({ field, missing, extras });
  }
  return differences;
}

module.exports = {
  readSchemaObjects, objectInventory, canonicalSql, canonicalSqlForDb,
  canonicalSchemaInventory, canonicalMongoIndex, inventoryDifferences,
};
