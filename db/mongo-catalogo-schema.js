'use strict';

const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');
const { opzioniDriver } = require('./mongoOpzioni');
const { isGeoJson } = require('./geometry');
const { catalogoDaDocumenti } = require('./ricercaGlobale');
const {
  pianificaDuplicazione,
  calcolaNuovoValore,
  documentoSorgente,
  applicaRicalcolo,
  valoreSemplice,
  riavvolgi,
} = require('./duplica');
const { definisciMetodi } = require('./prototipoStrategia');

const CAMPIONE_SCHEMA = 50;
const MONGO_CONVERT_TYPES = new Set(['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId']);

function parseLooseValue(text) {
  try {
    return EJSON.parse(String(text), { relaxed: false });
  } catch {
    return String(text);
  }
}

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
    if (isGeoJson(v)) return 'geojson';
    return 'object';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  return typeof v;
}

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

function installaCatalogoMongo(prototipo, { parseQueryObject }) {
  definisciMetodi(prototipo, {
    async createCollection(db, name, options = {}) {
      const client = this.requireClient();
      const coll = String(name || '').trim();
      if (!coll) throw new Error('Nome della collection mancante.');
      DbStrategy.assertCreatableName(coll, 'della collection');
      const opts = EJSON.deserialize(options, { relaxed: false });
      if (Object.hasOwn(opts, 'session')) throw new Error('La sessione della collezione è gestita dallo script.');
      require('../auth/capabilities').assertNoMongoServerJs(opts, 'Opzioni della collezione');
      await client.db(db).createCollection(coll, opzioniDriver(opts, {}, DbStrategy.queryTimeoutMs(this.env)));
    },

    async renameCollection(db, coll, newName) {
      const client = this.requireClient();
      const to = String(newName || '').trim();
      if (!to) throw new Error('Nuovo nome della collection mancante.');
      DbStrategy.assertCreatableName(to, 'della collection');
      await client.db(db).renameCollection(coll, to);
    },

    async dropCollection(db, coll) {
      const client = this.requireClient();
      const ok = await client.db(db).collection(coll).drop(opzioniDriver({}, {}, DbStrategy.queryTimeoutMs(this.env)));
      if (!ok) throw new Error(`Impossibile eliminare la collection "${coll}".`);
    },

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
    },

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
    },

    async dropColumn(db, coll, name) {
      const client = this.requireClient();
      const field = String(name || '').trim();
      if (!field) throw new Error('Nome del campo da eliminare mancante.');
      if (field === '_id') throw new Error('Il campo "_id" non può essere eliminato.');
      const res = await client.db(db).collection(coll)
        .updateMany({ [field]: { $exists: true } }, { $unset: { [field]: '' } });
      return { modified: res.modifiedCount };
    },

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
    },

    async dropIndex(db, coll, name) {
      const client = this.requireClient();
      if (name === '_id_') throw new Error('L\'indice "_id_" non può essere eliminato.');
      await client.db(db).collection(coll).dropIndex(name);
    },

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
        indexes = await this.indexList(db, coll);
      } catch { /* le view non hanno indici */ }

      const schema = await sampleSchema(collection);
      return { stats, indexes, fields: schema.fields, sampled: schema.sampled };
    },

    async indexList(db, coll, { schemaBson = false } = {}) {
      const client = this.requireClient();
      try {
        const indexes = await client.db(db).collection(coll).indexes(schemaBson ? { promoteValues: false } : {});
        return indexes.map(({ v, ns, ...index }) => (
          schemaBson ? require('./mongoSchemaBson').codificaMetadati(index) : index
        ));
      } catch (err) {
        if (/NamespaceNotFound/i.test(err.message) || err.code === 26) return [];
        throw err;
      }
    },

    async dbSchema(db) {
      const client = this.requireClient();
      const database = client.db(db);
      const infos = (await database.listCollections({}, { nameOnly: true }).toArray())
        .filter((c) => c.type !== 'view');
      const collections = [];
      for (const c of infos) {
        const collection = database.collection(c.name);
        const schema = await sampleSchema(collection, CAMPIONE_SCHEMA);
        let rowsApprox = null;
        try {
          rowsApprox = await collection.estimatedDocumentCount();
        } catch (err) {
          console.warn(`Conteggio stimato non disponibile per ${c.name}:`, err.message);
        }
        collections.push({ name: c.name, fields: schema.fields, rowsApprox });
      }
      collections.sort((a, b) => a.name.localeCompare(b.name));
      return {
        collections,
        relations: DbStrategy.detectRelations(collections),
        campionamento: {
          documenti: CAMPIONE_SCHEMA,
          collezioni: collections.length,
          quando: new Date().toISOString(),
        },
      };
    },

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
        colonna: '_id',
        origine: 'euristica',
        molti: !!r.many,
      }));
    },

    async duplicatePlan(db, coll, payload) {
      const client = this.requireClient();
      const collection = client.db(db).collection(coll);
      const doc = documentoSorgente(payload.doc);

      let indici = [];
      try {
        indici = await collection.indexes();
      } catch { /* collection appena creata o vista: nessun indice da rispettare */ }

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
      return { doc: JSON.stringify(piano.doc), note: piano.note, azioni: piano.azioni };
    },
  });
}

module.exports = {
  CAMPIONE_SCHEMA,
  sampleSchema,
  installaCatalogoMongo,
};
