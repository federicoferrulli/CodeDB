'use strict';

const { MongoClient, ObjectId } = require('mongodb');
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');
const { isGeoJson } = require('./geometry');
// Il filtro come DATO, accanto al documento MQL storico: vedi db/filtro.js.
const { normalizzaFiltro, rendiMongo } = require('./filtro');
const {
  normalizzaRicerca, catalogoDaDocumenti, aggiornaCacheCatalogo,
  catalogoValido, filtroMongo,
} = require('./ricercaGlobale');
const sessioni = require('./sessioni');
const {
  pianificaDuplicazione, calcolaNuovoValore, documentoSorgente, applicaRicalcolo, valoreSemplice, riavvolgi,
} = require('./duplica');

const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

// Riconosce l'errore di timeout lato server (maxTimeMS scaduto): codice BSON 50
// / label 'MaxTimeMSExpired'. Usato per degradare il conteggio a "sconosciuto".
function isMaxTimeError(err) {
  return !!err && (err.code === 50 || err.codeName === 'MaxTimeMSExpired'
    || /operation exceeded time limit|maxTimeMS/i.test(err.message || ''));
}

/* ---------------------------------------------------------------------------
 * Helpers MongoDB (EJSON, URI, schema campionato)
 * ------------------------------------------------------------------------- */

// Builds a MongoDB connection URI from the form fields, unless a full URI
// is provided directly.
function buildUri(cfg) {
  if (cfg.uri && cfg.uri.trim()) return cfg.uri.trim();

  const host = (cfg.host || 'localhost').trim();
  const port = String(cfg.port || 27017).trim();
  let auth = '';
  if (cfg.username) {
    auth = encodeURIComponent(cfg.username);
    if (cfg.password) auth += ':' + encodeURIComponent(cfg.password);
    auth += '@';
  }
  const params = new URLSearchParams();
  if (cfg.username) params.set('authSource', cfg.authSource || 'admin');
  // Connessione diretta a un singolo nodo (es. dietro tunnel SSH): evita la
  // topology discovery verso host del replica set non raggiungibili.
  if (cfg.directConnection) params.set('directConnection', 'true');
  const qs = params.toString();
  return `mongodb://${auth}${host}:${port}/${qs ? '?' + qs : ''}`;
}

// Parses a user supplied filter/sort/projection string. Accepts Extended
// JSON ({"_id": {"$oid": "..."}}) as well as plain JSON. Plain 24-hex
// strings used as _id are promoted to ObjectId automatically.
/**
 * Il filtro di una lettura: il documento MQL storico e quello STRUTTURATO,
 * conviventi.
 *
 * Quando ci sono entrambi valgono entrambi, uniti da $and: e' la condizione
 * che permette di migrare un chiamante per volta senza che gli altri cambino
 * comportamento (ticket 21).
 */
function filtroDiLettura(payload, fallback = {}) {
  const documento = parseQueryObject(payload.filter, fallback);
  const strutturato = normalizzaFiltro(payload.filtro);
  if (!strutturato) return documento;
  // I valori arrivano in Extended JSON: qui tornano tipi BSON nativi, e le
  // stringhe di 24 esadecimali su _id diventano ObjectId. Senza, un riferimento
  // a un _id verrebbe confrontato con l'oggetto { $oid: … } e non troverebbe
  // mai la riga.
  const reso = EJSON.deserialize(rendiMongo(strutturato), { relaxed: false });
  promoteObjectIds(reso);
  const haDocumento = documento && Object.keys(documento).length > 0;
  return haDocumento ? { $and: [documento, reso] } : reso;
}

function unisciFiltri(...filtri) {
  const presenti = filtri.filter((f) => f && typeof f === 'object' && Object.keys(f).length);
  if (!presenti.length) return {};
  return presenti.length === 1 ? presenti[0] : { $and: presenti };
}

function parseQueryObject(text, fallback = {}) {
  if (text == null || String(text).trim() === '') return fallback;
  const parsed = EJSON.parse(String(text), { relaxed: false });
  promoteObjectIds(parsed);
  return parsed;
}

function promoteObjectIds(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (key === '_id' && typeof val === 'string' && /^[0-9a-fA-F]{24}$/.test(val)) {
      obj[key] = new ObjectId(val);
    } else if (val && typeof val === 'object' && !(val instanceof ObjectId)) {
      promoteObjectIds(val);
    }
  }
}

const HEX24_RE = /^[0-9a-fA-F]{24}$/;
// Operatori il cui valore (o i cui elementi) sono confronti col campo corrente.
const COMPARISON_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST_OPS = new Set(['$in', '$nin', '$all']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);
const OID_PROBE_SAMPLE = 100; // documenti letti al massimo dal probe
const OID_PROBE_TTL_MS = 60_000;

// Oggetto "semplice" del filtro: esclude array, Date e tipi BSON già
// tipizzati (ObjectId, Long, Binary...), dentro cui non bisogna ricorrere.
function isPlainFilterObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !v._bsontype;
}

// Cammina il filtro e promuove in loco a ObjectId le stringhe di 24
// esadecimali (valore diretto, $eq/$ne/$gt/... o $in/$nin/$all — mai $regex
// e simili) i cui campi risultano memorizzati come ObjectId secondo
// isOidField(percorso). Gli operatori non estendono il percorso campo
// ($not, $elemMatch...); $and/$or/$nor lo azzerano perché i loro elementi
// sono sotto-filtri completi.
async function promoteHexStrings(node, path, isOidField) {
  const promote = async (holder, key, fieldPath) => {
    if (fieldPath && HEX24_RE.test(holder[key]) && (await isOidField(fieldPath))) {
      holder[key] = new ObjectId(holder[key]);
    }
  };
  for (const [key, val] of Object.entries(node)) {
    const isOp = key.startsWith('$');
    const fieldPath = isOp ? path : path ? `${path}.${key}` : key;
    if (typeof val === 'string') {
      if (!isOp || COMPARISON_OPS.has(key)) await promote(node, key, fieldPath);
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'string') {
          if (!isOp || LIST_OPS.has(key)) await promote(val, i, fieldPath);
        } else if (isPlainFilterObject(val[i])) {
          await promoteHexStrings(val[i], LOGICAL_OPS.has(key) ? '' : fieldPath, isOidField);
        }
      }
    } else if (isPlainFilterObject(val)) {
      await promoteHexStrings(val, fieldPath, isOidField);
    }
  }
}

// Parses the _id sent by the client (serialized as relaxed EJSON string).
function parseId(rawId) {
  const val = EJSON.parse(rawId, { relaxed: false });
  if (typeof val === 'string' && /^[0-9a-fA-F]{24}$/.test(val)) return new ObjectId(val);
  return val;
}

// Aggiunge al filtro un vincolo sul cursore keyset (`_id <op> val`) senza
// sovrascrivere un eventuale `_id` già presente nel filtro utente (in tal caso
// si combina con $and).
function withIdBound(filter, op, val) {
  const cond = { _id: { [op]: val } };
  if (filter && Object.prototype.hasOwnProperty.call(filter, '_id')) {
    return { $and: [filter, cond] };
  }
  return { ...filter, ...cond };
}

// Relaxed: i numeri restano numeri JSON, ObjectId e Date restano in forma
// estesa ($oid / $date) così il client li riconosce e li preserva.
function serialize(value) {
  return EJSON.serialize(value, { relaxed: true });
}

// Tipi ammessi da $convert per la conversione dei campi.
const MONGO_CONVERT_TYPES = new Set(['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId']);

// Valore "libero" digitato dall'utente: prova il parse EJSON/JSON
// (numeri, booleani, {"$date": ...}), altrimenti è una stringa semplice.
function parseLooseValue(text) {
  try {
    return EJSON.parse(String(text), { relaxed: false });
  } catch {
    return String(text);
  }
}

function errMsgSafe(err) {
  return (err && err.message) || String(err);
}

// Ripiego quando manca il permesso listDatabases: prova a leggere il nome
// del db dalla URI di connessione. Le URI reali possono contenere caratteri
// che new URL() rifiuta (credenziali non percent-encoded, host particolari):
// in tal caso torna null invece di lanciare, per non rompere il ripiego con
// un errore diverso da quello originale.
function dbNameFromUri(uri) {
  try {
    const name = new URL(String(uri || '').replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace('/', '');
    return name || null;
  } catch {
    return null;
  }
}

function assertDbName(name) {
  if (!name || /[\\/. "$*<>:|?]/.test(name)) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

// Tipo BSON "leggibile" di un valore, per lo schema dedotto dal campione.
function bsonTypeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (typeof v === 'object') {
    const t = v._bsontype;
    if (t === 'ObjectId') return 'objectId';
    if (t === 'Long') return 'long';
    if (t === 'Int32') return 'int';
    if (t === 'Double') return 'double';
    if (t === 'Decimal128') return 'decimal';
    if (t === 'Binary') return 'binary';
    if (t === 'Timestamp') return 'timestamp';
    if (t) return String(t).toLowerCase();
    // Un GeoJSON è un `object` come tutti gli altri, ma è l'unico che la UI sa
    // aprire su una mappa: distinguerlo qui è ciò che permette al form di
    // inserimento di proporre l'editor geografico invece di una textarea JSON
    // (su MySQL/PostgreSQL lo dice il tipo della colonna, qui no).
    if (isGeoJson(v)) return 'geojson';
    return 'object';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  return typeof v; // string, boolean
}

// Schema dedotto da un campione di documenti: per ogni campo, tipi e presenza %.
async function sampleSchema(collection, sampleSize = 100) {
  let docs;
  try {
    docs = await collection.aggregate([{ $sample: { size: sampleSize } }]).toArray();
  } catch {
    docs = await collection.find().limit(sampleSize).toArray();
  }
  const fields = new Map();
  for (const doc of docs) {
    for (const key in doc) {
      const val = doc[key];
      let f = fields.get(key);
      if (!f) fields.set(key, (f = { name: key, types: new Set(), count: 0 }));
      f.count += 1;
      f.types.add(bsonTypeOf(val));
    }
  }
  const out = [...fields.values()].map((f) => ({
    name: f.name,
    types: [...f.types].sort(),
    presence: docs.length ? Math.round((f.count / docs.length) * 100) : 0,
  }));
  out.sort((a, b) =>
    a.name === '_id' ? -1 : b.name === '_id' ? 1 : b.presence - a.presence || a.name.localeCompare(b.name)
  );
  return { fields: out, sampled: docs.length, catalogo: catalogoDaDocumenti(docs) };
}

async function filtroRicercaGlobale(strategy, collection, db, coll, input) {
  const valore = normalizzaRicerca(input);
  if (!valore) return null;
  const chiave = `${db}\0${coll}`;
  let catalogo = catalogoValido(strategy._cacheRicerca, chiave);
  if (!catalogo) {
    const schema = await sampleSchema(collection, 100);
    catalogo = aggiornaCacheCatalogo(strategy._cacheRicerca, chiave, schema.catalogo);
  }
  return filtroMongo(valore, catalogo);
}

/* ---------------------------------------------------------------------------
 * Strategia MongoDB: un MongoClient dedicato per istanza (cioè per socket)
 * ------------------------------------------------------------------------- */

class MongoDbStrategy extends DbStrategy {
  constructor() {
    super();
    /** @type {MongoClient|null} */
    this.client = null;
    this.uri = '';
    // Cache dei probe "campo → è ObjectId?" (chiave db.coll.campo, con TTL).
    this.oidFieldCache = new Map();
    this._cacheRicerca = new Map();
    this.changeStream = null;
    this.schemaStream = null;
  }

  get type() { return 'mongodb'; }

  requireClient() {
    if (!this.client) throw new Error('Nessuna connessione attiva al database.');
    return this.client;
  }

  async connect(cfg) {
    const uri = buildUri(cfg);
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 6000,
      // Presentarsi per nome al server non è cosmesi: è l'unico modo, nel
      // monitor delle sessioni, di distinguere le connessioni di CodeDB da
      // quelle degli altri client — cioè di non offrire all'utente il
      // pulsante che ucciderebbe la propria scheda. Compare in $currentOp e
      // nei log del server come `appName`.
      appName: sessioni.APP_NAME,
    });
    try {
      await client.connect();
      // Force a round-trip so bad credentials fail here and not later.
      await client.db('admin').command({ ping: 1 });
    } catch (err) {
      // La strategia non è ancora pubblicata alla sessione, quindi il normale
      // teardown non può raggiungere questo client. Senza chiuderlo qui, ogni
      // tentativo fallito può lasciare timer/socket del driver fino alla loro
      // scadenza naturale e una raffica di login errati esaurisce le risorse.
      await client.close().catch(() => {});
      throw err;
    }
    this.client = client;
    this.uri = uri;
  }

  async disconnect() {
    this.unwatch();
    this.unwatchSchema();
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.close().catch(() => {});
    }
    this.uri = null;
  }

  async health() {
    const client = this.requireClient();
    const t0 = Date.now();
    await client.db('admin').command({ ping: 1 });
    const latencyMs = Date.now() - t0;
    // Il driver Mongo non espone contatori di pool pubblici e stabili: si
    // riporta solo il numero di server della topology, quando accessibile.
    let extra;
    try {
      const desc = client.topology && client.topology.description;
      if (desc && desc.servers) extra = { servers: desc.servers.size };
    } catch { /* internals non disponibili: si omette */ }
    return { latencyMs, pool: null, extra };
  }

  async listDatabases() {
    const client = this.requireClient();
    try {
      const res = await client.db('admin').admin().listDatabases({ nameOnly: false });
      return res.databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk }));
    } catch {
      // User may lack listDatabases permission: fall back to the db in the URI.
      const dbName = dbNameFromUri(this.uri);
      return dbName ? [{ name: dbName, sizeOnDisk: 0 }] : [];
    }
  }

  async search(query) {
    const term = (query || '').toLowerCase();
    const client = this.requireClient();
    
    let databases = [];
    try {
      const res = await client.db('admin').admin().listDatabases({ nameOnly: false });
      databases = res.databases || [];
    } catch {
      const dbName = dbNameFromUri(this.uri);
      if (dbName) databases = [{ name: dbName }];
    }

    const promises = databases
      .filter((d) => !SYSTEM_DBS.has(d.name))
      .map(async (dbInfo) => {
        const dbMatches = dbInfo.name.toLowerCase().includes(term);
        const db = client.db(dbInfo.name);
        try {
          const collections = await db.listCollections().toArray();
          const matchedCols = collections
            .filter((c) => !c.name.startsWith('system.'))
            .filter((c) => dbMatches || c.name.toLowerCase().includes(term))
            .map((c) => ({ name: c.name }));
            
          if (dbMatches || matchedCols.length > 0) {
            return { name: dbInfo.name, collections: matchedCols };
          }
        } catch (err) {
          // Ignora DB senza permessi
        }
        return null;
      });

    const results = await Promise.all(promises);
    return results.filter(Boolean);
  }

  async createDatabase(db, firstColl) {
    const client = this.requireClient();
    const name = String(db || '').trim();
    assertDbName(name);
    // Vedi la nota in MySqlStrategy: vale solo per i nomi creati da CodeDB.
    DbStrategy.assertCreatableName(name, 'del database');
    const collName = String(firstColl || '').trim() || 'collection1';
    DbStrategy.assertCreatableName(collName, 'della collection');
    const existing = await this.listDatabases();
    if (existing.some((d) => d.name === name)) throw new Error(`Il database "${name}" esiste già.`);
    // In MongoDB un database esiste solo se contiene almeno una collection.
    await client.db(name).createCollection(collName);
  }

  async renameDatabase(db, newName) {
    this.requireClient();
    const from = String(db || '').trim();
    const to = String(newName || '').trim();
    assertDbName(from);
    assertDbName(to);
    DbStrategy.assertCreatableName(to, 'del database');
    if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
    if (SYSTEM_DBS.has(from)) throw new Error(`Il database di sistema "${from}" non può essere rinominato.`);
    // MongoDB non offre una rinomina atomica del database, e questo metodo NON
    // la emula: la vecchia emulazione copiava le collection e droppava il
    // sorgente, perdendo opzioni, validatori e — in silenzio — gli indici.
    // La rinomina passa da dump → verifica → restore, orchestrata dal server
    // (`rinominaViaDump`), che eredita checksum e ripristino degli oggetti.
    // Arrivare qui significa che qualcuno ha scavalcato quel percorso.
    throw new Error(
      'La rinomina di un database MongoDB non passa da questo metodo: usa il ' +
      'percorso dump/restore del server (db:rename), che copia anche indici, ' +
      'view, opzioni e validatori e verifica il risultato prima di concludere.'
    );
  }

  async dropDatabase(db) {
    const client = this.requireClient();
    const name = String(db || '').trim();
    assertDbName(name);
    if (SYSTEM_DBS.has(name)) throw new Error(`Il database di sistema "${name}" non può essere eliminato.`);
    await client.db(name).dropDatabase();
  }

  async listCollections(db) {
    const client = this.requireClient();
    const database = client.db(db);
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const result = await Promise.all(
      collections.map(async (c) => {
        let count = null;
        try {
          count = await database.collection(c.name).estimatedDocumentCount();
        } catch { /* views don't support estimatedDocumentCount */ }
        return { name: c.name, type: c.type, count };
      })
    );
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  async createCollection(db, name) {
    const client = this.requireClient();
    const coll = String(name || '').trim();
    if (!coll) throw new Error('Nome della collection mancante.');
    DbStrategy.assertCreatableName(coll, 'della collection');
    await client.db(db).createCollection(coll);
  }

  async renameCollection(db, coll, newName) {
    const client = this.requireClient();
    const to = String(newName || '').trim();
    if (!to) throw new Error('Nuovo nome della collection mancante.');
    DbStrategy.assertCreatableName(to, 'della collection');
    await client.db(db).renameCollection(coll, to);
  }

  async dropCollection(db, coll) {
    const client = this.requireClient();
    const ok = await client.db(db).collection(coll).drop();
    if (!ok) throw new Error(`Impossibile eliminare la collection "${coll}".`);
  }

  /* "Colonne" in MongoDB = campi dei documenti: le operazioni agiscono su
   * tutti i documenti della collection. */

  // Aggiunge il campo (con un eventuale valore iniziale) ai documenti che
  // non lo hanno già.
  async addColumn(db, coll, column) {
    const client = this.requireClient();
    const name = String((column && column.name) || '').trim();
    if (!name) throw new Error('Nome del campo mancante.');
    if (name === '_id') throw new Error('Il campo "_id" esiste già in ogni documento.');
    let value = null;
    if (column.default != null && String(column.default).trim() !== '') {
      value = parseLooseValue(column.default);
    }
    const res = await client.db(db).collection(coll)
      .updateMany({ [name]: { $exists: false } }, { $set: { [name]: value } });
    return { modified: res.modifiedCount };
  }

  // Rinomina il campo ($rename) e/o ne converte il tipo ($convert via update
  // con pipeline, MongoDB >= 4.2). I valori non convertibili restano invariati.
  async alterColumn(db, coll, payload) {
    const client = this.requireClient();
    const oldName = String((payload && payload.oldName) || '').trim();
    const column = (payload && payload.column) || {};
    const newName = String(column.name || '').trim() || oldName;
    if (!oldName) throw new Error('Nome del campo da modificare mancante.');
    if (oldName === '_id' || newName === '_id') throw new Error('Il campo "_id" non può essere modificato.');

    const collection = client.db(db).collection(coll);
    let modified = 0;
    if (newName !== oldName) {
      const res = await collection.updateMany({ [oldName]: { $exists: true } }, { $rename: { [oldName]: newName } });
      modified = Math.max(modified, res.modifiedCount);
    }
    const to = String(column.type || '').trim();
    if (to) {
      if (!MONGO_CONVERT_TYPES.has(to)) {
        throw new Error(`Tipo di conversione non valido: "${to}". Tipi ammessi: ${[...MONGO_CONVERT_TYPES].join(', ')}.`);
      }
      const res = await collection.updateMany(
        { [newName]: { $exists: true } },
        [{ $set: { [newName]: { $convert: { input: `$${newName}`, to, onError: `$${newName}`, onNull: null } } } }]
      );
      modified = Math.max(modified, res.modifiedCount);
    }
    if (newName === oldName && !to) throw new Error('Nessuna modifica da applicare.');
    return { modified };
  }

  // Rimuove il campo da tutti i documenti ($unset).
  async dropColumn(db, coll, name) {
    const client = this.requireClient();
    const field = String(name || '').trim();
    if (!field) throw new Error('Nome del campo da eliminare mancante.');
    if (field === '_id') throw new Error('Il campo "_id" non può essere eliminato.');
    const res = await client.db(db).collection(coll)
      .updateMany({ [field]: { $exists: true } }, { $unset: { [field]: '' } });
    return { modified: res.modifiedCount };
  }

  async createIndex(db, coll, payload) {
    const client = this.requireClient();
    const spec = parseQueryObject(payload.fields, null);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.keys(spec).length) {
      throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
    }
    const options = {};
    if (payload.unique) options.unique = true;
    const name = String(payload.name || '').trim();
    if (name) options.name = name;
    // Le altre opzioni dell'indice, quando il chiamante le dichiara. L'elenco
    // e' chiuso di proposito: `createIndex` e' anche un evento del browser, e
    // inoltrare al driver un oggetto arbitrario sarebbe una superficie in piu'.
    // Senza queste, l'import ricreava ogni indice come indice semplice e
    // perdeva TTL, indici parziali, sparsi e la collation — divergenze che la
    // verifica poi segnalava, ma soprattutto vincoli che non esistevano piu'.
    if (payload.sparse) options.sparse = true;
    if (Number.isFinite(payload.expireAfterSeconds)) options.expireAfterSeconds = payload.expireAfterSeconds;
    if (payload.partialFilterExpression && typeof payload.partialFilterExpression === 'object') {
      options.partialFilterExpression = payload.partialFilterExpression;
    }
    if (payload.collation && typeof payload.collation === 'object') options.collation = payload.collation;
    if (payload.wildcardProjection && typeof payload.wildcardProjection === 'object') {
      options.wildcardProjection = payload.wildcardProjection;
    }
    const created = await client.db(db).collection(coll).createIndex(spec, options);
    return { name: created };
  }

  async dropIndex(db, coll, name) {
    const client = this.requireClient();
    if (name === '_id_') throw new Error('L\'indice "_id_" non può essere eliminato.');
    await client.db(db).collection(coll).dropIndex(name);
  }

  async collectionStats(db, coll) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    let stats = null;
    try {
      const res = await collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const s = res[0] && res[0].storageStats;
      if (s) {
        stats = {
          count: s.count,
          size: s.size,
          storageSize: s.storageSize,
          avgObjSize: s.avgObjSize,
          totalIndexSize: s.totalIndexSize,
          nindexes: s.nindexes,
        };
      }
    } catch { /* le view non supportano $collStats */ }
    if (!stats) stats = { count: await collection.countDocuments().catch(() => null) };

    let indexes = [];
    try {
      // Descrittori COMPLETI, non ridotti a `{name, key, unique}`: da qui passa
      // anche l'export dell'intero database, e un indice TTL esportato senza
      // `expireAfterSeconds` veniva ricreato come indice normale — cioe' una
      // scadenza che non scade piu'. La vista Dettagli legge `unique` come
      // valore di verita', quindi la sua assenza le va bene.
      indexes = await this.indexList(db, coll);
    } catch { /* le view non hanno indici */ }

    const schema = await sampleSchema(collection);
    return { stats, indexes, fields: schema.fields, sampled: schema.sampled };
  }

  /**
   * Gli indici di una collection COSI' COME LI DICHIARA IL SERVER.
   *
   * Perche' i descrittori restano grezzi. Questo metodo esiste per la verifica
   * di import e ripristino, che confronta l'indice ricreato con quello salvato
   * nel backup: quel confronto normalizza entrambi i lati con lo stesso
   * insieme di campi semantici (`name`, `key`, `unique`, `sparse`,
   * `expireAfterSeconds`, `partialFilterExpression`, `collation`,
   * `wildcardProjection`) e considera DIVERSO un campo presente da una parte e
   * assente dall'altra. Normalizzare qui — per esempio `unique: !!i.unique`,
   * come fa `collectionInfo` per la vista Dettagli — farebbe risultare
   * `unique: false` su ogni indice non univoco letto dal vivo, contro
   * l'assenza del campo nel file di backup: una divergenza inventata su
   * ciascun indice. Si tolgono solo `v` e `ns`, che descrivono il formato
   * interno e il namespace, non l'indice.
   *
   * Una collection inesistente non ha indici e non e' un errore: lo dice il
   * confronto, che trovera' mancante cio' che era atteso.
   */
  async indexList(db, coll) {
    const client = this.requireClient();
    try {
      const indexes = await client.db(db).collection(coll).indexes();
      return indexes.map(({ v, ns, ...index }) => index);
    } catch (err) {
      if (/NamespaceNotFound/i.test(err.message) || err.code === 26) return [];
      throw err;
    }
  }

  async dbSchema(db) {
    const client = this.requireClient();
    const database = client.db(db);
    const infos = (await database.listCollections({}, { nameOnly: true }).toArray())
      .filter((c) => c.type !== 'view');
    const collections = [];
    for (const c of infos) {
      const schema = await sampleSchema(database.collection(c.name), 50);
      collections.push({ name: c.name, fields: schema.fields });
    }
    collections.sort((a, b) => a.name.localeCompare(b.name));
    return { collections, relations: DbStrategy.detectRelations(collections) };
  }

  // Riferimenti uscenti dalla sola collection indicata (pannello di riferimento
  // della griglia). MongoDB non dichiara chiavi esterne: qui c'è la stessa
  // euristica del diagramma UML — `cliente_id` verso `clienti`, un ObjectId che
  // porta il nome di una collection — e per questo l'origine è 'euristica'.
  // Il pannello lo mostra con un badge diverso: un'ipotesi presentata come
  // certezza è il modo migliore per far fidare l'utente di un collegamento
  // che non esiste.
  //
  // Il costo è un elenco di nomi più UN campionamento, non uno per collection
  // come in `dbSchema`: questa risposta serve a ogni apertura di collection.
  async columnRelations(db, coll) {
    const client = this.requireClient();
    const database = client.db(db);
    const infos = (await database.listCollections({}, { nameOnly: true }).toArray())
      .filter((c) => c.type !== 'view');
    const schema = await sampleSchema(database.collection(coll), 50);
    const byName = DbStrategy.indexCollectionNames(infos.map((c) => c.name));
    const relations = DbStrategy.relationsForCollection({ name: coll, fields: schema.fields }, byName);
    return relations.map((r) => ({
      campo: r.field,
      db,
      tabella: r.to,
      // L'euristica è per costruzione un riferimento all'`_id`: "cliente_id"
      // significa "l'_id di un documento di clienti", mai un altro suo campo.
      colonna: '_id',
      origine: 'euristica',
      molti: !!r.many,
    }));
  }

  /**
   * Documento pronto da inserire come duplicato di quello ricevuto.
   *
   * Su MongoDB le chiavi sono due cose: l'`_id` e gli indici unici. L'`_id` si
   * rifà sempre — se è un ObjectId basta NON scriverlo (lo genera il server, ed
   * è la chiave nuova migliore possibile); se è un numero o una stringa
   * ometterlo cambierebbe il TIPO della chiave, quindi si calcola un valore
   * dello stesso tipo. Gli indici unici valgono come chiavi solo nella modalità
   * "senza chiavi", e lì `null` non è una via d'uscita come in SQL: su MongoDB
   * il campo assente vale null nell'indice e collide con gli altri, per questo
   * quei campi sono trattati come non annullabili e ricevono un valore nuovo.
   */
  async duplicatePlan(db, coll, payload) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    const doc = documentoSorgente(payload.doc);

    let indici = [];
    try {
      indici = await collection.indexes();
    } catch { /* collection appena creata o vista: nessun indice da rispettare */ }

    // I percorsi annidati ("indirizzo.cap") non sono chiavi di primo livello:
    // toccarli qui creerebbe un campo con il punto nel nome invece di
    // modificare il sottodocumento. Restano fuori, dichiarandolo.
    const unicheGrezze = indici
      .filter((i) => i.unique && i.name !== '_id_')
      .map((i) => Object.keys(i.key || {}));
    const annidate = [...new Set(unicheGrezze.flat().filter((n) => n.includes('.')))];
    const uniche = unicheGrezze.map((cols) => cols.filter((n) => !n.includes('.')));

    const haId = Object.prototype.hasOwnProperty.call(doc, '_id');
    const idObjectId = haId && !!doc._id && typeof doc._id === 'object' && typeof doc._id.$oid === 'string';
    const colonne = [{
      name: '_id',
      tipo: '',
      pk: true,
      nullable: false,
      // Omettere l'_id fa generare un ObjectId nuovo: vale come ricalcolo solo
      // se l'originale era a sua volta un ObjectId.
      generabile: !haId || idObjectId,
      generata: false,
    }];
    for (const nome of new Set(uniche.flat())) {
      if (nome === '_id') continue;
      colonne.push({ name: nome, tipo: '', pk: false, nullable: false, generabile: false, generata: false });
    }

    const piano = pianificaDuplicazione({
      doc, colonne, uniche, conChiavi: payload.conChiavi === true, idVirtuale: false,
    });
    if (annidate.length && payload.conChiavi !== true) {
      piano.note.push(`Chiavi uniche su campi annidati non toccate: ${annidate.map((n) => `«${n}»`).join(', ')}.`);
    }

    for (const nome of piano.ricalcola) {
      const originale = valoreSemplice(doc[nome]);
      const nuovo = await calcolaNuovoValore({
        tipo: '',
        originale,
        massimo: async () => {
          // Solo fra i valori NUMERICI: in una collection con _id misti
          // (ObjectId e numeri) l'ordinamento BSON mette gli ObjectId sopra i
          // numeri, e il "massimo" sarebbe una stringa esadecimale — cioe' un
          // NaN, cioe' una chiave nuova che riparte da 1 sopra quelle esistenti.
          const soloNumeri = { [nome]: { $type: ['int', 'long', 'double', 'decimal'] } };
          const r = await collection
            .find(soloNumeri, { projection: { [nome]: 1 }, sort: { [nome]: -1 }, limit: 1 })
            .toArray();
          return r.length ? valoreSemplice(EJSON.serialize(r[0], { relaxed: true })[nome]) : null;
        },
        esiste: async (v) => (await collection.countDocuments({ [nome]: v }, { limit: 1 })) > 0,
      });
      applicaRicalcolo(piano, nome, nuovo && { ...nuovo, valore: riavvolgi(doc[nome], nuovo.valore) }, {
        pk: nome === '_id',
        etichetta: `tipo ${typeof originale}`,
      });
    }
    // JSON.stringify e non EJSON.stringify: `piano.doc` NON contiene valori
    // BSON ma il testo EJSON gia' pronto arrivato dal client, e i campi non
    // toccati devono tornare a `docInsert` esattamente come erano.
    return { doc: JSON.stringify(piano.doc), note: piano.note, azioni: piano.azioni };
  }

  // Il campo è memorizzato come ObjectId? Probe a costo fisso pensato per
  // collection grandi ($limit prima del $match: legge al più i primi
  // OID_PROBE_SAMPLE documenti, mai una scansione completa), con cache TTL
  // così la paginazione non lo ripete a ogni pagina.
  async isObjectIdField(collection, path) {
    const key = `${collection.dbName}.${collection.collectionName}.${path}`;
    const cached = this.oidFieldCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.isOid;

    let isOid = false;
    try {
      const hit = await collection
        .aggregate([
          { $limit: OID_PROBE_SAMPLE },
          { $match: { [path]: { $type: 'objectId' } } },
          { $limit: 1 },
        ])
        .toArray();
      isOid = hit.length > 0;
    } catch {
      /* campo non sondabile: nessuna promozione */
    }
    if (this.oidFieldCache.size > 500) this.oidFieldCache.clear();
    this.oidFieldCache.set(key, { isOid, expires: Date.now() + OID_PROBE_TTL_MS });
    return isOid;
  }

  // Promozione consapevole del tipo: le stringhe di 24 esadecimali del
  // filtro diventano ObjectId se il campo confrontato è memorizzato così.
  async promoteFilterObjectIds(collection, filter) {
    if (!isPlainFilterObject(filter)) return;
    await promoteHexStrings(filter, '', (path) => this.isObjectIdField(collection, path));
  }

  async collectionFind(db, coll, payload) {
    const client = this.requireClient();
    const sort = parseQueryObject(payload.sort, {});
    const projection = parseQueryObject(payload.projection, {});
    const cap = DbStrategy.resultCap(payload);
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), cap);
    const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);

    const collection = client.db(db).collection(coll);
    const filter = unisciFiltri(
      filtroDiLettura(payload, {}),
      await filtroRicercaGlobale(this, collection, db, coll, payload.cercaOvunque)
    );
    await this.promoteFilterObjectIds(collection, filter);
    const runComment = payload.comment || payload.runId || payload.opHandle?.runId;
    const findOpts = { projection };
    if (runComment) findOpts.comment = runComment;
    // Timeout lato server sulla find: una scansione lenta (es. skip profondo)
    // viene interrotta (MaxTimeMSExpired) invece di tenere la connessione
    // occupata all'infinito. Annullabile anche via killOp sul `comment` (runId).
    const maxTimeMS = DbStrategy.queryTimeoutMs();
    if (maxTimeMS > 0) findOpts.maxTimeMS = maxTimeMS;

    // Keyset (seek) pagination: se richiesta (`payload.keyset`) e l'ordinamento è
    // quello di default, si pagina con `_id > :after` (avanti) / `_id < :before`
    // (indietro) invece di `.skip()`, che su collection enormi è O(skip). Costo
    // O(pagina) a qualsiasi profondità grazie all'indice su `_id`. Con un sort
    // personalizzato si ricade su `.skip()`.
    const hasCustomSort = Object.keys(sort).length > 0;
    const ks = (payload.keyset && !hasCustomSort) ? payload.keyset : null;
    let cursor;
    let reverse = false;
    if (ks) {
      let kfilter = filter;
      let ksort = { _id: 1 };
      if (ks.after != null) {
        kfilter = withIdBound(filter, '$gt', parseId(ks.after));
      } else if (ks.from != null) {
        // Refresh in place: ricarica la pagina corrente a partire (incluso) dal
        // primo _id già mostrato, senza tornare all'inizio.
        kfilter = withIdBound(filter, '$gte', parseId(ks.from));
      } else if (ks.before != null) {
        kfilter = withIdBound(filter, '$lt', parseId(ks.before));
        ksort = { _id: -1 };
        reverse = true;
      }
      // ks.first (o nessun estremo): prima pagina, solo ORDER BY _id ASC.
      cursor = collection.find(kfilter, findOpts).sort(ksort).limit(limit);
    } else {
      cursor = collection.find(filter, findOpts).sort(sort).skip(skip).limit(limit);
    }

    // Il conteggio con filtro è una scansione completa: su collection enormi
    // bloccherebbe la griglia. Il client della UI passa `deferCount` e recupera
    // il totale a parte via `collection:count`; qui restituiamo solo il totale
    // istantaneo dai metadati (filtro vuoto) e altrimenti null. Senza
    // `deferCount` (MCP, test) manteniamo il conteggio esatto ma con un timeout
    // così non può mai bloccarsi all'infinito. (`estimatedDocumentCount` è
    // metadata autorevole: non lo segnaliamo come stima, a differenza delle
    // statistiche del planner SQL.)
    const hasFilter = Object.keys(filter).length > 0;
    let total;
    if (payload.deferCount) {
      total = hasFilter ? null : await collection.estimatedDocumentCount().catch(() => null);
    } else {
      total = await this.countWithTimeout(collection, filter, hasFilter);
    }
    // Lettura a budget: il cursore si ferma al tetto delle righe O a quello dei
    // byte, così pochi documenti enormi non possono esaurire la memoria del
    // processo (vedi DbStrategy.collectCapped).
    const collected = await DbStrategy.collectCapped(cursor, limit);
    aggiornaCacheCatalogo(this._cacheRicerca, `${db}\0${coll}`, catalogoDaDocumenti(collected.docs));
    let docs = collected.docs;
    // Keyset "indietro": la query gira in ordine _id DESC, qui si riordina ASC.
    if (reverse) docs.reverse();

    // Union of the keys of all returned documents -> table columns.
    const columns = [];
    const seen = new Set();
    for (const doc of docs) {
      for (const key of Object.keys(doc)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }

    return { docs: docs.map(serialize), columns, total, skip, limit, keyset: !!ks, truncated: collected.truncated || undefined, resultSet: true };
  }

  // Conteggio con timeout: countDocuments (con filtro) o estimatedDocumentCount
  // (senza). Se supera CODEDB_COUNT_TIMEOUT_MS il server MongoDB interrompe la
  // query (MaxTimeMSExpired) e restituiamo null anziché propagare l'errore.
  async countWithTimeout(collection, filter, hasFilter) {
    const maxTimeMS = DbStrategy.countTimeoutMs();
    try {
      if (!hasFilter) return await collection.estimatedDocumentCount();
      const opts = maxTimeMS > 0 ? { maxTimeMS } : {};
      return await collection.countDocuments(filter, opts);
    } catch (err) {
      if (isMaxTimeError(err)) return null;
      throw err;
    }
  }

  // Conteggio disaccoppiato richiesto dalla griglia (evento collection:count).
  async collectionCount(db, coll, payload) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    const filter = unisciFiltri(
      filtroDiLettura(payload, {}),
      await filtroRicercaGlobale(this, collection, db, coll, payload.cercaOvunque)
    );
    const hasFilter = Object.keys(filter).length > 0;
    if (hasFilter) await this.promoteFilterObjectIds(collection, filter);
    const total = await this.countWithTimeout(collection, filter, hasFilter);
    return { total, timedOut: total === null };
  }

  async collectionAggregate(db, coll, payload) {
    const client = this.requireClient();
    const pipeline = parseQueryObject(payload.pipeline, []);
    if (!Array.isArray(pipeline)) throw new Error('La pipeline deve essere un array JSON.');
    const cap = DbStrategy.resultCap(payload);
    const runComment = payload.comment || payload.runId || payload.opHandle?.runId;
    const aggOpts = {};
    if (runComment) aggOpts.comment = runComment;

    // `$out`/`$merge` DEVONO restare l'ultimo stage: applicare `.limit()` come
    // per le letture vi accodava un `$limit` e MongoDB rifiutava la pipeline
    // ("$out can only be the final stage"), rendendo impossibile l'unica
    // scrittura via pipeline che il Query Engine dichiara di supportare.
    // Del resto queste pipeline non restituiscono documenti: il tetto è inutile.
    const ultimo = pipeline.length ? Object.keys(pipeline[pipeline.length - 1] || {})[0] : null;
    const materializza = ultimo === '$out' || ultimo === '$merge';

    // Timeout lato server sulle aggregazioni di LETTURA (CDB-17): senza, una
    // pipeline pesante ($lookup senza indice, $group su collection enorme) tiene
    // occupata una connessione del pool finché MongoDB non finisce da solo.
    // Le pipeline che MATERIALIZZANO ($out/$merge) restano escluse di proposito:
    // interromperle a metà lascerebbe la collection di destinazione scritta per
    // metà, cioè lo stato incoerente che il timeout dovrebbe evitare. Là il
    // rimedio giusto è l'annullamento esplicito dell'utente (cancelQuery).
    const aggTimeout = DbStrategy.aggregateTimeoutMs();
    if (!materializza && aggTimeout > 0) aggOpts.maxTimeMS = aggTimeout;

    const agg = client.db(db).collection(coll).aggregate(pipeline, aggOpts);
    const cursor = materializza ? agg : agg.limit(cap);
    // Come nella find: si smette di leggere al tetto delle righe o dei byte.
    const { docs, truncated } = await DbStrategy.collectCapped(cursor, cap);
    const columns = [...new Set(docs.flatMap((d) => Object.keys(d)))];
    return { docs: docs.map(serialize), columns, total: docs.length, skip: 0, limit: cap, truncated: truncated || undefined, resultSet: true };
  }

  /**
   * L'unica esecuzione che su MongoDB non va fermata dal tetto di tempo: una
   * pipeline che MATERIALIZZA (`$out`/`$merge`). Interromperla a metà lascia la
   * collection di destinazione scritta per metà — lo stato incoerente che il
   * tetto dovrebbe evitare. Là il rimedio giusto è l'annullamento esplicito
   * dell'utente (`cancelQuery`).
   *
   * Prima questa esclusione viveva dentro `collectionAggregate`, dove era anche
   * la sola cosa che teneva il `maxTimeMS` lontano dalla pipeline; ora che il
   * tetto lo impone la giuntura (`db/tetti.js`), l'esclusione va dichiarata
   * dove la giuntura la può leggere.
   */
  fuoriDalTettoDiTempo(metodo, args) {
    if (metodo !== 'collectionAggregate') return false;
    const pipeline = parseQueryObject((args[2] || {}).pipeline, []);
    if (!Array.isArray(pipeline) || !pipeline.length) return false;
    const ultimo = Object.keys(pipeline[pipeline.length - 1] || {})[0];
    return ultimo === '$out' || ultimo === '$merge';
  }

  async cancelQuery(opHandle) {
    if (!opHandle || !opHandle.runId || !this.client) return { cancelled: false };
    try {
      const admin = this.client.db('admin');
      const ops = await admin.aggregate([
        { $currentOp: { allUsers: true, idleConnections: false } },
        { $match: { $or: [{ "command.comment": opHandle.runId }, { comment: opHandle.runId }] } }
      ]).toArray();

      if (!ops || ops.length === 0) return { cancelled: false };

      let cancelled = false;
      for (const op of ops) {
        if (op.opid !== undefined) {
          await admin.command({ killOp: 1, op: op.opid }).catch(() => {});
          cancelled = true;
        }
      }
      return { cancelled };
    } catch (err) {
      return { cancelled: false };
    }
  }

  /* --- Monitor delle sessioni ---------------------------------------------
   * `$currentOp` mostra solo le operazioni IN CORSO: MongoDB non ha un
   * equivalente della connessione "addormentata" di MySQL o della sessione
   * "idle in transaction" di PostgreSQL, e `idleConnections: false` lo rende
   * esplicito invece di riempire la tabella di righe senza contenuto. Su un
   * server tranquillo il monitor sarà quindi quasi vuoto: è la verità, non un
   * malfunzionamento, e l'interfaccia lo dichiara nella nota.
   * ---------------------------------------------------------------------- */
  async listSessions() {
    const client = this.requireClient();
    const admin = client.db('admin');

    let ops;
    let nota = null;
    try {
      ops = await admin.aggregate([
        { $currentOp: { allUsers: true, idleConnections: false, idleSessions: false } },
      ]).toArray();
    } catch (err) {
      // `allUsers: true` richiede il privilegio `inprog` su cluster: senza, si
      // ripiega sulle sole operazioni dell'utente collegato DICENDOLO. Restare
      // in silenzio darebbe una lista corta e credibile — cioè la risposta
      // sbagliata a "chi sta bloccando il database".
      ops = await admin.aggregate([
        { $currentOp: { allUsers: false, idleConnections: false, idleSessions: false } },
      ]).toArray();
      nota = 'Vengono mostrate solo le operazioni dell\'utente collegato: al ruolo manca il privilegio "inprog" sul cluster, necessario per vedere quelle degli altri utenti.';
    }

    // Si ordina PRIMA di troncare: al contrario si scarterebbero righe a caso,
    // e fra quelle scartate ci sarebbe proprio l'operazione lenta che si sta
    // cercando. Le fonti SQL ottengono lo stesso con ORDER BY … LIMIT.
    const tutte = sessioni.ordina(sessioni.normalizzaMongo(ops));
    const troncato = tutte.length > sessioni.MAX_SESSIONI;
    const lista = tutte.slice(0, sessioni.MAX_SESSIONI);
    return {
      sessioni: lista,
      // MongoDB sa fermare l'OPERAZIONE (killOp) ma non chiudere la
      // connessione di un altro client: non esiste un comando che lo faccia.
      // `saBloccanti: false` = non sa dire CHI tiene il lock che un'altra
      // operazione sta aspettando (`waitingForLock` dice solo che aspetta):
      // l'interfaccia lo dichiara invece di lasciar credere che non ci siano
      // blocchi in corso.
      capacita: { annullaQuery: true, terminaConnessione: false, saBloccanti: false },
      troncato,
      nota,
    };
  }

  async killSession(id, modo) {
    const client = this.requireClient();
    if (modo === 'connessione') {
      throw new Error('MongoDB non permette di chiudere la connessione di un altro client: si può solo annullare l\'operazione in corso.');
    }
    // L'opid è numerico sul server singolo e una stringa "shard:numero" via
    // mongos: `killOp` accetta entrambe le forme, ma non la stringa "123" al
    // posto del numero 123 — da qui la riconversione.
    const raw = String(id);
    const op = /^\d+$/.test(raw) ? Number(raw) : raw;
    const res = await client.db('admin').command({ killOp: 1, op });
    return { terminata: !!(res && res.ok), modo: 'query' };
  }

  // Piano di esecuzione: explain() sul find o sull'aggregate corrente,
  // con gli stessi parametri di collectionFind/collectionAggregate.
  // Un filtro vuoto è valido: è l'explain del find senza condizioni.
  async collectionExplain(db, coll, payload) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    let explanation;
    if (payload.mode === 'aggregate') {
      const pipeline = parseQueryObject(payload.pipeline, []);
      if (!Array.isArray(pipeline)) throw new Error('La pipeline deve essere un array JSON.');
      explanation = await collection.aggregate(pipeline).explain('executionStats');
    } else {
      const filter = unisciFiltri(
        filtroDiLettura(payload, {}),
        await filtroRicercaGlobale(this, collection, db, coll, payload.cercaOvunque)
      );
      const sort = parseQueryObject(payload.sort, {});
      const projection = parseQueryObject(payload.projection, {});
      const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
      const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
      await this.promoteFilterObjectIds(collection, filter);
      explanation = await collection
        .find(filter, { projection })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .explain('executionStats');
    }
    return { format: 'json', plan: serialize(explanation) };
  }

  async docInsert(db, coll, payload) {
    const client = this.requireClient();
    const doc = parseQueryObject(payload.doc, null);
    // `typeof [] === 'object'` (CDB-24): un array passava il controllo e finiva
    // in `insertOne`, che lo scriveva come documento con chiavi "0", "1", "2"…
    // — un documento inutilizzabile, creato senza un solo messaggio d'errore.
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('Documento JSON non valido: attesa una coppia { "campo": valore }.');
    }
    const res = await client.db(db).collection(coll).insertOne(doc);
    return { insertedId: EJSON.stringify(res.insertedId) };
  }

  // Aggiornamento di massa per il gateway MCP: $set su tutti i documenti che
  // corrispondono al filtro, che deve essere esplicito e non vuoto.
  async collectionUpdateMany(db, coll, payload) {
    const client = this.requireClient();
    const filter = parseQueryObject(payload.filter, null);
    if (!filter || typeof filter !== 'object' || Array.isArray(filter) || !Object.keys(filter).length) {
      throw new Error('Filtro mancante o vuoto: per un aggiornamento di massa serve un filtro esplicito.');
    }
    const set = parseQueryObject(payload.set, null);
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) {
      throw new Error('Oggetto "set" mancante o vuoto: indica i campi da aggiornare.');
    }
    const res = await client.db(db).collection(coll).updateMany(filter, { $set: set });
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async docUpdate(db, coll, payload) {
    const client = this.requireClient();
    const _id = parseId(payload.id);
    const update = {};
    if (payload.set && Object.keys(payload.set).length) {
      update.$set = EJSON.deserialize(payload.set, { relaxed: false });
    }
    if (payload.unset && payload.unset.length) {
      update.$unset = Object.fromEntries(payload.unset.map((f) => [f, '']));
    }
    if (!Object.keys(update).length) throw new Error('Nessuna modifica da applicare.');
    const res = await client.db(db).collection(coll).updateOne({ _id }, update);
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async docReplace(db, coll, payload) {
    const client = this.requireClient();
    const _id = parseId(payload.id);
    const doc = parseQueryObject(payload.doc, null);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('Documento JSON non valido.');
    }
    delete doc._id; // l'_id non è modificabile
    const res = await client.db(db).collection(coll).replaceOne({ _id }, doc);
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async docDelete(db, coll, payload) {
    const client = this.requireClient();
    const _id = parseId(payload.id);
    const res = await client.db(db).collection(coll).deleteOne({ _id });
    return { deleted: res.deletedCount };
  }

  /**
   * Scritture della shell eseguite da uno SCRIPT (db/MongoScriptRunner.js).
   *
   * Un metodo solo, con l'operazione nel payload, invece di dieci metodi nuovi:
   * così c'è **un unico punto** da autorizzare (`METHOD_CAPABILITY.shellWrite`,
   * capability decisa dall'operazione) e le scritture dello script non possono
   * scavalcare il Proxy per una svista.
   *
   * Non è un doppione di docInsert/docUpdate: quelli servono la griglia e
   * lavorano su un `_id` singolo con `$set`, mentre qui servono filtri e
   * operatori di aggiornamento arbitrari, che sono il senso di uno script.
   */
  async shellWrite(db, coll, payload) {
    const client = this.requireClient();
    const c = client.db(db).collection(coll);
    const op = String(payload.op || '');
    // Il filtro è OBBLIGATORIO. Senza questa riga `db.c.deleteMany()` — il
    // campo `filter` semplicemente assente nel payload — ripiegava su `{}`, che
    // per MongoDB significa "tutti i documenti": l'intera collezione spariva,
    // l'operazione risultava riuscita e nell'audit compariva come una normale
    // scrittura. Il vero mongosh, che questo interprete imita, rifiuta la
    // chiamata. Stessa forma di difesa dell'aggiornamento senza operatori qui
    // sotto, e stessa motivazione.
    const filtro = () => {
      const f = parseQueryObject(payload.filter, null);
      if (f === null || f === undefined) {
        throw new Error(`${op} richiede un filtro: per agire su TUTTI i documenti scrivilo esplicitamente, ${op}({}).`);
      }
      if (typeof f !== 'object' || Array.isArray(f)) {
        throw new Error(`${op}: il filtro deve essere un oggetto.`);
      }
      return f;
    };
    const opzioni = () => parseQueryObject(payload.options, {}) || {};

    // Un "aggiornamento" senza operatori ($set, $inc…) sostituirebbe l'intero
    // documento: in mongosh è un errore, e qui lo è a maggior ragione — è la
    // differenza fra correggere un campo e cancellare tutti gli altri.
    const aggiornamento = () => {
      const u = parseQueryObject(payload.update, null);
      if (!u || typeof u !== 'object' || Array.isArray(u)) {
        throw new Error('Aggiornamento non valido: serve un oggetto con operatori (es. { $set: { … } }).');
      }
      if (!Object.keys(u).some((k) => k.startsWith('$'))) {
        throw new Error('Aggiornamento senza operatori: usa { $set: { … } }. Per sostituire l\'intero documento serve replaceOne().');
      }
      return u;
    };

    switch (op) {
      case 'insertOne': {
        const doc = parseQueryObject(payload.doc, null);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('insertOne richiede un documento.');
        const res = await c.insertOne(doc);
        return { acknowledged: true, insertedId: EJSON.stringify(res.insertedId), inserted: 1 };
      }
      case 'insertMany': {
        const docs = parseQueryObject(payload.docs, null);
        if (!Array.isArray(docs) || !docs.length) throw new Error('insertMany richiede un array di documenti non vuoto.');
        const res = await c.insertMany(docs);
        return { acknowledged: true, inserted: res.insertedCount };
      }
      case 'updateOne': {
        const res = await c.updateOne(filtro(), aggiornamento(), opzioni());
        return { matched: res.matchedCount, modified: res.modifiedCount, upserted: res.upsertedCount || 0 };
      }
      case 'updateMany': {
        const res = await c.updateMany(filtro(), aggiornamento(), opzioni());
        return { matched: res.matchedCount, modified: res.modifiedCount, upserted: res.upsertedCount || 0 };
      }
      case 'replaceOne': {
        const doc = parseQueryObject(payload.doc, null);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('replaceOne richiede un documento.');
        const res = await c.replaceOne(filtro(), doc, opzioni());
        return { matched: res.matchedCount, modified: res.modifiedCount };
      }
      case 'deleteOne': {
        const res = await c.deleteOne(filtro());
        return { deleted: res.deletedCount };
      }
      case 'deleteMany': {
        const res = await c.deleteMany(filtro());
        return { deleted: res.deletedCount };
      }
      case 'findOneAndUpdate': {
        const res = await c.findOneAndUpdate(filtro(), aggiornamento(), opzioni());
        // Driver MongoDB 6: per default torna direttamente il documento;
        // le versioni/configurazioni con includeResultMetadata usano `.value`.
        const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
        return { doc: doc ? serialize(doc) : null };
      }
      case 'findOneAndDelete': {
        const res = await c.findOneAndDelete(filtro(), opzioni());
        const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
        return { doc: doc ? serialize(doc) : null };
      }
      default:
        throw new Error(`Operazione di scrittura non supportata: "${op}".`);
    }
  }

  async collectionDeleteMany(db, coll, payload) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    const filter = unisciFiltri(
      filtroDiLettura(payload, {}),
      await filtroRicercaGlobale(this, collection, db, coll, payload.cercaOvunque)
    );
    const res = await collection.deleteMany(filter);
    return { deleted: res.deletedCount };
  }

  // Esporta un blocco di documenti come righe EJSON (una per documento):
  // il client li assembla in un array JSON. Paginazione con skip/limit.
  // Paginazione keyset su _id (sempre presente e indicizzato): evita la
  // scansione O(n²) di skip su collection grandi. payload.after = EJSON
  // (relaxed:false) dell'ultimo _id ricevuto; omesso per la prima pagina.
  async collectionExport(db, coll, payload) {
    const client = this.requireClient();
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 1000);
    const collection = client.db(db).collection(coll);
    const filter = {};
    if (payload.after != null && payload.after !== '') {
      let afterId;
      try {
        afterId = EJSON.parse(String(payload.after), { relaxed: false });
      } catch {
        throw new Error('Cursore di paginazione non valido.');
      }
      filter._id = { $gt: afterId };
    }
    const docs = await collection.find(filter).sort({ _id: 1 }).limit(limit).toArray();
    // relaxed: i numeri restano numeri, ObjectId/Date restano $oid/$date,
    // così il file riesportato si può reimportare senza perdita di tipi.
    const lines = docs.map((d) => EJSON.stringify(d, { relaxed: true }));
    const total = await collection.countDocuments();
    const nextAfter = docs.length ? EJSON.stringify(docs[docs.length - 1]._id, { relaxed: false }) : null;
    return { lines, count: docs.length, total, format: 'json', nextAfter };
  }

  // Importa un blocco di documenti (payload.docs = array di oggetti Extended
  // JSON serializzati). relaxed: false preserva i tipi BSON ($oid, $date...).
  async collectionImport(db, coll, payload) {
    const client = this.requireClient();
    const raw = Array.isArray(payload.docs) ? payload.docs : [];
    if (!raw.length) throw new Error('Nessun documento da importare nel blocco.');
    const errors = [];
    const docs = [];
    raw.forEach((d, i) => {
      try {
        const doc = EJSON.deserialize(d, { relaxed: false });
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          throw new Error('il documento deve essere un oggetto JSON');
        }
        docs.push(doc);
      } catch (err) {
        errors.push(`Documento ${i + 1}: ${err.message}`);
      }
    });
    let inserted = 0;
    if (docs.length) {
      try {
        if (payload.upsert) {
          const invalid = docs.findIndex((doc) => doc._id == null);
          if (invalid >= 0) throw new Error(`Documento ${invalid + 1}: _id mancante o null.`);
          const res = await client.db(db).collection(coll).bulkWrite(
            docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
            { ordered: false },
          );
          inserted = (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
          // matchedCount include anche replacement identici: dal punto di vista
          // dell'import sono documenti applicati con successo.
          if (inserted > docs.length) inserted = docs.length;
        } else {
          const res = await client.db(db).collection(coll).insertMany(docs, { ordered: false });
          inserted = res.insertedCount;
        }
      } catch (err) {
        // BulkWriteError: alcuni documenti possono comunque essere entrati.
        inserted = (err.result && (err.result.insertedCount ?? err.result.nInserted)) || 0;
        for (const we of (err.writeErrors || []).slice(0, 10)) {
          errors.push(we.errmsg || we.message || String(we));
        }
        if (!(err.writeErrors || []).length) errors.push(errMsgSafe(err));
      }
    }
    return { inserted, failed: raw.length - inserted, errors: errors.slice(0, 10) };
  }

  // Change stream: richiede un replica set; su server standalone degrada
  // segnalando onUnavailable. Un solo stream per sessione: aprirne uno nuovo
  // chiude il precedente (this.unwatch()), quindi con più coll-tab aperti
  // nella stessa connessione solo l'ultimo watch avviato risulta "LIVE".
  // Scelta deliberata per limitare i change stream aperti per sessione
  // (ognuno è una connessione persistente lato server Mongo), non un bug.
  watch(db, coll, { onChange, onUnavailable }) {
    const client = this.requireClient();
    this.unwatch();
    this.changeStream = client.db(db).collection(coll).watch([], { fullDocument: 'updateLookup' });
    this.changeStream.on('change', (change) => {
      onChange({
        operationType: change.operationType,
        documentKey: change.documentKey ? serialize(change.documentKey) : null,
      });
    });
    this.changeStream.on('error', () => {
      this.unwatch();
      onUnavailable();
    });
  }

  unwatch() {
    if (this.changeStream) {
      this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
  }

  // Change stream a livello di cluster filtrato sulle sole operazioni DDL:
  // tiene aggiornata la sidebar quando lo schema cambia dall'esterno.
  // Richiede un replica set; su server standalone degrada con onUnavailable.
  watchSchema({ onChange, onUnavailable }) {
    const client = this.requireClient();
    this.unwatchSchema();
    const pipeline = [{ $match: { operationType: { $in: ['create', 'drop', 'rename', 'dropDatabase'] } } }];
    const open = (expanded) => {
      // showExpandedEvents (MongoDB ≥ 6.0) aggiunge l'evento "create"; sui
      // server più vecchi lo stream fallirebbe: si riprova senza l'opzione.
      const stream = client.watch(pipeline, expanded ? { showExpandedEvents: true } : {});
      stream.on('change', (change) => {
        onChange({
          operationType: change.operationType,
          db: change.ns ? change.ns.db : null,
          coll: (change.ns && change.ns.coll) || null,
        });
      });
      stream.on('error', () => {
        stream.close().catch(() => {});
        if (this.schemaStream !== stream) return;
        this.schemaStream = null;
        if (expanded) this.schemaStream = open(false);
        else onUnavailable();
      });
      return stream;
    };
    this.schemaStream = open(true);
  }

  unwatchSchema() {
    if (this.schemaStream) {
      this.schemaStream.close().catch(() => {});
      this.schemaStream = null;
    }
  }
}

module.exports = MongoDbStrategy;
