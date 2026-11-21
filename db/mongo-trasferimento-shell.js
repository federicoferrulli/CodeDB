'use strict';

const { EJSON } = require('bson');
const scritturaVincolata = require('./sqlScrittureMongo').esegui;
const { assertImportOutcomeKnown } = require('./importFailure');
const { definisciMetodi } = require('./prototipoStrategia');

function errMsgSafe(err) {
  return (err && err.message) || String(err);
}

function installaTrasferimentoMongo(prototipo, { parseQueryObject, serialize, withIdBound }) {
  definisciMetodi(prototipo, {
    async shellWrite(db, coll, payload) {
      const client = this.requireClient();
      const parse = (text, fallback) => parseQueryObject(text, fallback, !payload.nativeResult);
      const op = String(payload.op || '');
      const filtro = () => {
        const f = parse(payload.filter, null);
        if (f === null || f === undefined) {
          throw new Error(`${op} richiede un filtro: per agire su TUTTI i documenti scrivilo esplicitamente, ${op}({}).`);
        }
        if (typeof f !== 'object' || Array.isArray(f)) {
          throw new Error(`${op}: il filtro deve essere un oggetto.`);
        }
        return f;
      };
      if (!['insertOne', 'insertMany'].includes(op)) filtro();
      return scritturaVincolata(client, db, coll, payload, this.env, async (options, c) => {
        const opzioni = () => ({ ...parse(payload.options, {}), ...options });

        const aggiornamento = () => {
          const u = parse(payload.update, null);
          if (Array.isArray(u)) {
            if (!u.length || u.some((s) => !s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).length !== 1)) {
              throw new Error('La pipeline di aggiornamento richiede stadi non vuoti con un solo operatore.');
            }
            return u;
          }
          if (!u || typeof u !== 'object') {
            throw new Error('Aggiornamento non valido: serve un oggetto con operatori (es. { $set: { … } }).');
          }
          if (!Object.keys(u).some((k) => k.startsWith('$'))) {
            throw new Error('Aggiornamento senza operatori: usa { $set: { … } }. Per sostituire l\'intero documento serve replaceOne().');
          }
          return u;
        };

        switch (op) {
          case 'insertOne': {
            const doc = parse(payload.doc, null);
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('insertOne richiede un documento.');
            const res = await c.insertOne(doc, opzioni());
            return payload.nativeResult ? serialize(res) : { acknowledged: res.acknowledged, insertedId: EJSON.stringify(res.insertedId), inserted: 1 };
          }
          case 'insertMany': {
            const docs = parse(payload.docs, null);
            if (!Array.isArray(docs) || !docs.length) throw new Error('insertMany richiede un array di documenti non vuoto.');
            const res = await c.insertMany(docs, opzioni());
            return payload.nativeResult ? serialize(res) : { acknowledged: res.acknowledged, inserted: res.insertedCount };
          }
          case 'updateOne': {
            const res = await c.updateOne(filtro(), aggiornamento(), opzioni());
            return payload.nativeResult ? serialize(res) : { matched: res.matchedCount, modified: res.modifiedCount, upserted: res.upsertedCount || 0 };
          }
          case 'updateMany': {
            const res = await c.updateMany(filtro(), aggiornamento(), opzioni());
            return payload.nativeResult ? serialize(res) : { matched: res.matchedCount, modified: res.modifiedCount, upserted: res.upsertedCount || 0 };
          }
          case 'replaceOne': {
            const doc = parse(payload.doc, null);
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('replaceOne richiede un documento.');
            const res = await c.replaceOne(filtro(), doc, opzioni());
            return payload.nativeResult ? serialize(res) : { matched: res.matchedCount, modified: res.modifiedCount, upserted: res.upsertedCount || 0 };
          }
          case 'deleteOne': {
            const res = await c.deleteOne(filtro(), opzioni());
            return payload.nativeResult ? serialize(res) : { deleted: res.deletedCount };
          }
          case 'deleteMany': {
            const res = await c.deleteMany(filtro(), opzioni());
            return payload.nativeResult ? serialize(res) : { deleted: res.deletedCount };
          }
          case 'findOneAndUpdate':
          case 'findOneAndReplace': {
            const opts = opzioni();
            const value = op === 'findOneAndUpdate' ? aggiornamento() : parse(payload.doc, null);
            if (op === 'findOneAndReplace' && (!value || typeof value !== 'object' || Array.isArray(value))) {
              throw new Error('findOneAndReplace richiede un documento.');
            }
            const res = await c[op](filtro(), value, opts);
            const doc = opts.includeResultMetadata ? res?.value : res;
            return payload.nativeResult ? serialize(doc) : { doc: doc ? serialize(doc) : null };
          }
          case 'findOneAndDelete': {
            const opts = opzioni();
            const res = await c.findOneAndDelete(filtro(), opts);
            const doc = opts.includeResultMetadata ? res?.value : res;
            return payload.nativeResult ? serialize(doc) : { doc: doc ? serialize(doc) : null };
          }
          default:
            throw new Error(`Operazione di scrittura non supportata: "${op}".`);
        }
      });
    },

    async collectionExport(db, coll, payload) {
      const client = this.requireClient();
      const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 1000);
      const collection = client.db(db).collection(coll);
      const primaPagina = payload.after == null || payload.after === '';
      let filter = {};
      if (!primaPagina) {
        let afterId;
        try {
          afterId = EJSON.parse(String(payload.after), { relaxed: false });
        } catch {
          throw new Error('Cursore di paginazione non valido.');
        }
        filter = withIdBound(null, '$gt', afterId);
      }
      const docs = await collection.find(filter, { promoteValues: false }).sort({ _id: 1 }).limit(limit).toArray();
      const lines = docs.map((d) => EJSON.stringify(d, { relaxed: false }));
      const total = primaPagina ? await collection.countDocuments() : undefined;
      const nextAfter = docs.length ? EJSON.stringify(docs[docs.length - 1]._id, { relaxed: false }) : null;
      return { lines, count: docs.length, total, format: 'json', nextAfter };
    },

    async collectionImport(db, coll, payload) {
      const client = this.requireClient();
      return scritturaVincolata(client, db, coll, payload, this.env, async (options, c, triggers) => {
        if (payload.encoding === require('./mongoBson').ENCODING) {
          return require('./mongoBson').importRows(client, db, coll, payload.docs, payload.upsert, options, triggers);
        }
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
              const res = await c.bulkWrite(
                docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
                { ordered: false, ...options }
              );
              inserted = (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
              if (inserted > docs.length) inserted = docs.length;
            } else {
              const res = await c.insertMany(docs, { ordered: false, ...options });
              inserted = res.insertedCount;
            }
          } catch (err) {
            if (options.session) throw err;
            assertImportOutcomeKnown(err);
            inserted = (err.result && (err.result.insertedCount ?? err.result.nInserted)) || 0;
            for (const we of (err.writeErrors || []).slice(0, 10)) {
              errors.push(we.errmsg || we.message || String(we));
            }
            if (!(err.writeErrors || []).length) errors.push(errMsgSafe(err));
          }
        }
        return { inserted, failed: raw.length - inserted, errors: errors.slice(0, 10) };
      });
    },
  });
}

module.exports = { installaTrasferimentoMongo };
