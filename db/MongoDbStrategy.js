'use strict';
const { opzioniLettura, opzioniDriver } = require('./mongoOpzioni');
const scritturaVincolata = require('./sqlScrittureMongo').esegui;
const { MongoClient, ObjectId } = require('mongodb');
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');
const MongoShell = require('./MongoShell');
const { LIMITE_RIGHE, stimaConteggio, conteggioLimitato, completaConteggi } = require('./conteggiNavigatore');
// Il filtro come DATO, accanto al documento MQL storico: vedi db/filtro.js.
const { normalizzaFiltro, rendiMongo } = require('./filtro');
const {
  normalizzaRicerca, catalogoDaDocumenti, aggiornaCacheCatalogo,
  catalogoValido, filtroMongo,
} = require('./ricercaGlobale');
const sessioni = require('./sessioni');
const { sampleSchema, installaCatalogoMongo } = require('./mongo-catalogo-schema');
const { installaTrasferimentoMongo } = require('./mongo-trasferimento-shell');
const { installaSessioniStreamMongo } = require('./mongo-sessioni-stream');

const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

// Riconosce l'errore di timeout lato server (maxTimeMS scaduto): codice BSON 50
// / label 'MaxTimeMSExpired'. Usato per degradare il conteggio a "sconosciuto".
function isMaxTimeError(err) {
  return !!err && (err.code === 50 || err.codeName === 'MaxTimeMSExpired'
    || /operation exceeded time limit|maxTimeMS/i.test(err.message || ''));
}

/* ---------------------------------------------------------------------------
 * Helpers MongoDB (EJSON, URI, promozione ObjectId)
 * ------------------------------------------------------------------------- */

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
  if (cfg.directConnection) params.set('directConnection', 'true');
  const qs = params.toString();
  return `mongodb://${auth}${host}:${port}/${qs ? '?' + qs : ''}`;
}

function filtroDiLettura(payload, fallback = {}) {
  const documento = parseDocumentObject(payload.filter, fallback, !payload.shell, 'Filtro MongoDB');
  const strutturato = normalizzaFiltro(payload.filtro);
  if (!strutturato) return documento;
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

function parseQueryObject(text, fallback = {}, promote = true) {
  if (text == null || String(text).trim() === '') return fallback;
  const raw = String(text);
  let parsed;
  try {
    parsed = EJSON.parse(raw, { relaxed: false });
  } catch {
    try {
      parsed = EJSON.deserialize(MongoShell.parseDocument(raw), { relaxed: false });
    } catch (shellErr) {
      throw new Error(`Documento MongoDB non valido: ${shellErr.message}`);
    }
  }
  if (promote) promoteObjectIds(parsed);
  return parsed;
}

function parseDocumentObject(text, fallback = {}, promote = true, label = 'Filtro MongoDB') {
  if (text == null || String(text).trim() === '') return fallback;
  const parsed = parseQueryObject(text, fallback, promote);
  if (!isPlainFilterObject(parsed)) {
    throw new Error(`${label} non valido: inserisci un oggetto documento tra graffe (es. { "campo": "valore" }).`);
  }
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
const COMPARISON_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST_OPS = new Set(['$in', '$nin', '$all']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);
const OID_PROBE_SAMPLE = 100;
const OID_PROBE_TTL_MS = 60_000;

function isPlainFilterObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !v._bsontype;
}

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

function parseId(rawId) {
  // Il tipo EJSON della chiave distingue anche stringhe e ObjectId omonimi.
  return EJSON.parse(rawId, { relaxed: false });
}

function withIdBound(filter, op, val) {
  // Il confronto fra espressioni segue l'ordine BSON completo dell'indice _id.
  const cond = { $expr: { [op]: ['$_id', { $literal: val }] } };
  return filter && Object.keys(filter).length ? { $and: [filter, cond] } : cond;
}

// BSON Long oltre i 53 bit non deve attraversare Number in relaxed mode (CDB-04):
// fuori da [-2^53+1, 2^53-1] deve essere serializzato come {$numberLong: "..."}.
const { Long } = require('bson');
if (Long && Long.prototype && Long.prototype.toExtendedJSON && !Long.prototype.__codedbLongPatched) {
  const origLongToExtendedJSON = Long.prototype.toExtendedJSON;
  Long.prototype.toExtendedJSON = function (options) {
    if (options && options.relaxed) {
      const s = this.toString();
      try {
        const b = BigInt(s);
        if (b > 9007199254740991n || b < -9007199254740991n) {
          return { $numberLong: s };
        }
      } catch { /* ignora e ricadi su default */ }
    }
    return origLongToExtendedJSON.call(this, options);
  };
  Long.prototype.__codedbLongPatched = true;
}

function serialize(value) {
  return require('./mongoEjson').serializza(value);
}

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
  constructor(options = {}) {
    super(options);
    /** @type {MongoClient|null} */
    this.client = null;
    this.uri = '';
    // Cache dei probe "campo → è ObjectId?" (chiave db.coll.campo, con TTL).
    this.oidFieldCache = new Map();
    this._cacheRicerca = new Map();
    this.changeStreams = new Map();
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
    await client.db(name).dropDatabase(opzioniDriver({}, {}, DbStrategy.queryTimeoutMs(this.env)));
  }

  async listCollections(db, { includeCounts = true } = {}) {
    const client = this.requireClient();
    const database = client.db(db);
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const result = collections.map(c => ({ name: c.name, type: c.type, ...stimaConteggio(null) }));
    result.sort((a, b) => a.name.localeCompare(b.name));
    if (!includeCounts) return result;
    return completaConteggi(result, async (coll, limit, ms) => {
      const collection = database.collection(coll.name);
      const inizio = performance.now();
      const estimate = await collection.estimatedDocumentCount({ maxTimeMS: ms });
      Object.assign(coll, stimaConteggio(estimate));
      const restante = Math.floor(ms - (performance.now() - inizio));
      if (estimate > LIMITE_RIGHE || restante <= 0) return stimaConteggio(estimate);
      const n = await collection.countDocuments({}, { limit, maxTimeMS: restante });
      return conteggioLimitato(n, estimate);
    });
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
    const sort = parseDocumentObject(payload.sort, {}, true, 'Ordinamento MongoDB');
    const projection = parseDocumentObject(payload.projection, {}, true, 'Proiezione MongoDB');
    const cap = DbStrategy.resultCap(payload);
    const limit = cap === Infinity
      ? (payload.limit == null ? Infinity : Math.abs(parseInt(payload.limit, 10) || 0))
      : Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), cap);
    const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);

    const collection = client.db(db).collection(coll);
    const filter = unisciFiltri(
      filtroDiLettura(payload, {}),
      await filtroRicercaGlobale(this, collection, db, coll, payload.cercaOvunque)
    );
    if (!payload.shell) await this.promoteFilterObjectIds(collection, filter);
    const findOpts = { ...opzioniLettura(parseDocumentObject(payload.options, {}, true, 'Opzioni MongoDB')), projection };
    // Timeout lato server sulla find: una scansione lenta (es. skip profondo)
    // viene interrotta (MaxTimeMSExpired) invece di tenere la connessione
    // occupata all'infinito. Annullabile anche via killOp sul `comment` (runId).
    const maxTimeMS = DbStrategy.queryTimeoutMs(this.env);
    opzioniDriver(findOpts, payload, maxTimeMS);

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
      cursor = collection.find(kfilter, findOpts).sort(ksort);
    } else {
      cursor = collection.find(filter, findOpts).sort(sort).skip(skip);
    }
    // Il limite negativo MongoDB richiede un solo batch, con al massimo |n| documenti.
    if (Number.isFinite(limit) && limit > 0) cursor.limit(payload.limit < 0 ? -limit : limit);

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
    if (payload.shell || findOpts.session) {
      total = null;
    } else if (payload.deferCount) {
      total = hasFilter ? null : await collection.estimatedDocumentCount().catch(() => null);
    } else {
      total = await this.countWithTimeout(collection, filter, hasFilter);
    }
    // Lettura a budget: il cursore si ferma al tetto delle righe O a quello dei
    // byte, così pochi documenti enormi non possono esaurire la memoria del
    // processo (vedi DbStrategy.collectCapped).
    const collected = limit === 0
      ? { docs: [], truncated: false }
      : await DbStrategy.collectCapped(cursor, limit, DbStrategy.maxResultBytes(this.env));
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
    const maxTimeMS = DbStrategy.countTimeoutMs(this.env);
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
    if (hasFilter && !payload.shell) await this.promoteFilterObjectIds(collection, filter);
    const total = payload.shell || require('./mongoSessioneScript').attiva()
      ? await collection.countDocuments(filter, opzioniDriver(parseQueryObject(payload.options, {}), payload, DbStrategy.countTimeoutMs(this.env)))
      : await this.countWithTimeout(collection, filter, hasFilter);
    return { total, timedOut: total === null };
  }

  async mongoCommand(db, payload) {
    return require('./mongoComando').esegui(this.requireClient(), db, payload, this.env);
  }

  async mongoShellRead(db, coll, payload) {
    return require('./mongoMetadatiShell').leggi(this.requireClient(), db, coll, payload, this.env);
  }

  async mongoCollectionInfos(db, payload = {}) {
    const filter = parseDocumentObject(payload.filter, {}, false, 'Filtro delle collezioni');
    require('../auth/capabilities').assertNoMongoServerJs(filter, 'Filtro delle collezioni');
    const options = opzioniDriver({ nameOnly: !!payload.nameOnly, authorizedCollections: !!payload.authorizedCollections }, payload, DbStrategy.queryTimeoutMs(this.env));
    const result = await DbStrategy.collectCapped(this.requireClient().db(db).listCollections(filter, options), Infinity, DbStrategy.maxResultBytes(this.env));
    if (result.truncated) throw new Error('Elenco collezioni oltre il limite di byte. Restringi il filtro.');
    return serialize(result.docs);
  }

  async mongoDatabaseAggregate(db, payload) {
    const pipeline = parseQueryObject(payload.pipeline, [], false);
    require('../auth/capabilities').assertNoMongoServerJs(pipeline, 'Pipeline di database');
    const options = opzioniDriver(opzioniLettura(parseQueryObject(payload.options, {}, false), true), payload, DbStrategy.aggregateTimeoutMs(this.env));
    const result = await DbStrategy.collectCapped(this.requireClient().db(db).aggregate(pipeline, options), DbStrategy.resultCap(payload), DbStrategy.maxResultBytes(this.env));
    return { docs: result.docs.map(serialize), truncated: result.truncated };
  }

  async mongoShellIndex(db, coll, payload) {
    return serialize(await require('./mongoMetadatiShell').indici(this.requireClient(), db, coll, payload, this.env));
  }

  async mongoDistinct(db, coll, payload) {
    const result = await this.requireClient().db(db).collection(coll).distinct(String(payload.field),
      parseDocumentObject(payload.filter, {}, false, 'Filtro MongoDB'), opzioniDriver(parseDocumentObject(payload.options, {}, false, 'Opzioni MongoDB'), payload, DbStrategy.queryTimeoutMs(this.env)));
    if (Buffer.byteLength(EJSON.stringify(result)) > DbStrategy.maxResultBytes(this.env)) throw new Error('Risultato distinct oltre il limite di byte.');
    return serialize(result);
  }

  async collectionAggregate(db, coll, payload) {
    const client = this.requireClient();
    const pipeline = parseQueryObject(payload.pipeline, [], false);
    if (!Array.isArray(pipeline)) throw new Error('La pipeline deve essere un array JSON.');
    const cap = DbStrategy.resultCap(payload);
    const aggOpts = opzioniLettura(parseQueryObject(payload.options, {}), true);

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
    const aggTimeout = DbStrategy.aggregateTimeoutMs(this.env);
    opzioniDriver(aggOpts, payload, materializza ? 0 : aggTimeout);

    const agg = client.db(db).collection(coll).aggregate(pipeline, aggOpts);
    const cursor = materializza || !Number.isFinite(cap) ? agg : agg.limit(cap);
    // Come nella find: si smette di leggere al tetto delle righe o dei byte.
    const { docs, truncated } = await DbStrategy.collectCapped(cursor, cap, DbStrategy.maxResultBytes(this.env));
    const columns = [...new Set(docs.flatMap((d) => Object.keys(d)))];
    return { docs: docs.map(serialize), columns, total: docs.length, skip: 0, limit: cap, truncated: truncated || undefined, resultSet: true };
  }

  async mongoSqlRead(db, _coll, payload) {
    return require('./MongoSqlRuntime').leggi(this.requireClient(), db, payload, this.env);
  }

  async mongoSqlReturning(db, coll, payload) {
    return require('./MongoSqlRuntime').scrivi(this.requireClient(), db, coll, payload, this.env);
  }

  async mongoSqlSchema(db, coll, payload) {
    return require('./sqlSchemaMongo').crea(this.requireClient(), db, coll, payload, this.env);
  }

  async mongoSqlProcedure(db, name, payload) {
    return require('./sqlProcedureMongo').esegui(this.requireClient(), db, name, payload, this.env);
  }
  async mongoSqlTrigger(db, coll, payload) {
    return require('./sqlTriggerMongo').esegui(this.requireClient(), db, coll, payload);
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

  // Piano di esecuzione: explain() sul find o sull'aggregate corrente,
  // con gli stessi parametri di collectionFind/collectionAggregate.
  // Un filtro vuoto è valido: è l'explain del find senza condizioni.
  async collectionExplain(db, coll, payload) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    const verbosity = payload.verbosity || 'executionStats';
    if (!['queryPlanner', 'executionStats', 'allPlansExecution'].includes(verbosity)) throw new Error('Livello explain non valido.');
    const opts = opzioniDriver(opzioniLettura(parseQueryObject(payload.options, {}), payload.mode === 'aggregate'), payload, DbStrategy.queryTimeoutMs(this.env));
    let explanation;
    if (payload.mode === 'aggregate') {
      const pipeline = parseQueryObject(payload.pipeline, [], false);
      if (!Array.isArray(pipeline)) throw new Error('La pipeline deve essere un array JSON.');
      explanation = await collection.aggregate(pipeline, opts).explain(verbosity);
    } else {
      const filter = unisciFiltri(
        filtroDiLettura(payload, {}),
        await filtroRicercaGlobale(this, collection, db, coll, payload.cercaOvunque)
      );
      const sort = parseDocumentObject(payload.sort, {}, true, 'Ordinamento MongoDB');
      const projection = parseDocumentObject(payload.projection, {}, true, 'Proiezione MongoDB');
      const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
      const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
      if (!payload.shell) await this.promoteFilterObjectIds(collection, filter);
      explanation = await collection
        .find(filter, { ...opts, projection })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .explain(verbosity);
    }
    return { format: 'json', plan: serialize(explanation) };
  }

  async docInsert(db, coll, payload) {
    const client = this.requireClient();
    return scritturaVincolata(client, db, coll, payload, this.env, (options, c, triggers) => require('./insertBson').inserisciBson(client, db, coll, payload.doc, options, triggers));
  }

  // Aggiornamento di massa per il gateway MCP: $set su tutti i documenti che
  // corrispondono al filtro, che deve essere esplicito e non vuoto. L'upsert è
  // esplicito e resta disattivato quando il chiamante non lo richiede.
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
    const res = await scritturaVincolata(client, db, coll, payload, this.env, (options, c) => c.updateMany(
      filter,
      { $set: set },
      { upsert: payload.upsert === true, ...options },
    ));
    return {
      matched: res.matchedCount,
      modified: res.modifiedCount,
      upserted: res.upsertedCount,
      ...(res.upsertedId != null ? { upsertedId: EJSON.stringify(res.upsertedId) } : {}),
    };
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
    const res = await scritturaVincolata(client, db, coll, payload, this.env, (options, c) => c.updateOne({ _id }, update, options));
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
    const res = await scritturaVincolata(client, db, coll, payload, this.env, (options, c) => c.replaceOne({ _id }, doc, options));
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async docDelete(db, coll, payload) {
    const client = this.requireClient();
    const _id = parseId(payload.id);
    const res = await scritturaVincolata(client, db, coll, payload, this.env, (options, c) => c.deleteOne({ _id }, options));
    return { deleted: res.deletedCount };
  }

  async collectionDeleteMany(db, coll, payload) {
    const client = this.requireClient();
    const collection = client.db(db).collection(coll);
    const filter = unisciFiltri(
      filtroDiLettura(payload, {}),
      await filtroRicercaGlobale(this, collection, db, coll, payload.cercaOvunque)
    );
    const res = await scritturaVincolata(client, db, coll, payload, this.env, (options, c) => c.deleteMany(filter, options));
    return { deleted: res.deletedCount };
  }

}

installaCatalogoMongo(MongoDbStrategy.prototype, { parseQueryObject });
installaTrasferimentoMongo(MongoDbStrategy.prototype, { parseQueryObject, serialize, withIdBound });
installaSessioniStreamMongo(MongoDbStrategy.prototype, { serialize });

MongoDbStrategy.serialize = serialize;

module.exports = MongoDbStrategy;

