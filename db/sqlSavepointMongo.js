'use strict';
// shortcut: MongoDB non offre subtransazioni; le immagini BSON ripristinano soltanto
// errori rilevati prima dell'aborto del server. Gli errori transitori restano
// al retry della transazione, senza tentare di proseguire su uno snapshot perso.
const { ObjectId } = require('bson');
const DbStrategy = require('./DbStrategy');
const CONDITION = Symbol('condizione SQL recuperabile');
const errore = (message, sqlState, mysqlState = sqlState.startsWith('23') ? '23000' : sqlState) => Object.assign(new Error(message), { sqlState, mysqlState, [CONDITION]: new Set() });
function erroreEspressione(error) {
  const arrayState = error.code === 241 && /Array SQL \[([0-9A-Z]{5})\]/.exec(error.message)?.[1];
  const state = arrayState || (error.code === 241 && /Dimensioni degli array SQL/.test(error.message) ? '2202E'
    : error.code === 241 && /Intervallo SQL non valido: NULL/.test(error.message) ? '22004'
    : error.code === 241 && /Intervallo SQL non valido:/.test(error.message) ? '22000'
    : error.code === 241 && /overflow|out of range/i.test(error.message) ? '22003'
    : error.code === 2 && /(?:divide|mod).*zero/i.test(error.message) ? '22012'
    : { 241: '22P02', 14: '42804', 16608: '22012', 16554: '22003', 8000: '22003' }[error.code]);
  return state ? Object.assign(errore(error.message, state, state === '22P02' ? '22018' : undefined), { cause: error, code: error.code, codeName: error.codeName }) : error;
}

function crea(original, db, session, ctx, payload, env) {
  const database = original.db(db), frames = [], budget = DbStrategy.maxResultBytes(env) || 32 * 1024 * 1024;
  let bytes = 0;
  const collect = async cursor => {
    try {
      const result = await DbStrategy.collectCapped(cursor, DbStrategy.resultCap(payload), budget);
      if (result.truncated) throw new Error('Savepoint SQL oltre il limite di righe o byte.');
      return result.docs;
    } finally { await cursor.close(); }
  };
  function begin(name, replace = false) {
    if (replace && name !== undefined) {
      const at = frames.findLastIndex(f => f.name === name);
      if (at >= 0) bytes -= frames.splice(at, 1)[0].bytes;
    }
    if (frames.length >= 128) throw new Error('Oltre 128 savepoint SQL annidati.');
    const frame = { name, images: new Map(), bytes: 0 }; frames.push(frame); return frame;
  }
  function release(frame) {
    const at = frames.indexOf(frame); if (at < 0) throw new Error('Savepoint SQL inesistente.');
    for (const removed of frames.splice(at)) bytes -= removed.bytes;
  }
  const named = name => {
    const frame = frames.findLast(f => f.name === name);
    if (!frame) throw errore(`Savepoint SQL inesistente: ${name}.`, '3B001', '42000'); return frame;
  };
  async function capture(coll) {
    if (!frames.length) return;
    const missing = frames.filter(f => !f.images.has(coll)); if (!missing.length) return;
    const rows = await collect(database.collection(coll).find({}, { ...ctx.opzioni(session), raw: true }));
    const size = rows.reduce((n, r) => n + r.length, 0);
    if (bytes + size * missing.length > budget) throw new Error('Immagini dei savepoint SQL oltre il budget complessivo di byte.');
    for (const frame of missing) { frame.images.set(coll, rows); frame.bytes += size; bytes += size; }
  }
  async function rollback(frame, keep = false) {
    // Si usano i driver originali: il rollback non esegue trigger né registra
    // nuove immagini, e ripristina i byte senza conversioni BSON/EJSON.
    for (const [coll, rows] of frame.images) {
      await database.collection(coll).deleteMany({}, ctx.opzioni(session));
      for (const raw of rows) await require('./mongoBson').scriviRaw(database, coll, raw, ctx.opzioni(session));
    }
    release(frame); if (keep) frames.push({ name: frame.name, images: new Map(), bytes: 0 });
  }
  async function matches(row, filter, options = {}) {
    const cursor = database.aggregate([{ $documents: { $literal: [row] } }, { $match: filter }], { ...ctx.opzioni(), ...options });
    try { return await cursor.hasNext(); } catch (error) { throw erroreEspressione(error); } finally { await cursor.close(); }
  }
  async function validate(collection, rows, previous) {
    const info = await database.listCollections({ name: collection.collectionName }).next();
    const validator = info?.options?.validator;
    const allIndexes = info ? await collection.listIndexes().toArray() : [];
    const indexes = allIndexes.filter(i => i.unique || i.name === '_id_');
    for (const row of rows) {
      if (validator && !await matches(row, validator)) {
        const schema = require('./sqlSchemaMongo').daInfo(info);
        if (schema?.columns.some(c => !c.nullable && row[c.name] == null)) throw errore('La riga viola un vincolo NOT NULL dello schema SQL.', '23502');
        for (const check of schema?.constraints.filter(c => c.kind === 'CHECK') || []) {
          if (!await matches(row, { $expr: { $ne: [require('./sqlEspressioni').emettiEspressione(check.expr), false] } })) throw errore(`La riga viola il vincolo CHECK ${check.name}.`, '23514', 'HY000');
        }
        for (const column of schema?.columns || []) for (const check of column.domainChecks || []) {
          const emit = value => ({ $ne: [require('./sqlEspressioni').emettiEspressione(check.expr, () => value.slice(1)), false] });
          const expression = column.elementDomain ? require('./sqlArrayMongo').valida(`$${column.name}`, emit) : emit(`$${column.name}`);
          if (!await matches(row, { $expr: expression })) throw errore(`La riga viola il vincolo CHECK ${check.name} del dominio ${column.domain}.`, '23514', 'HY000');
        }
        throw errore('La riga viola il tipo o la dimensione dello schema SQL.', '22000');
      }
      const native=require('./sqlPreflightIndici');
      if(native.necessario(row,allIndexes) || previous && require('bson').EJSON.stringify(previous._id)!==require('bson').EJSON.stringify(row._id)) await native.verifica(database,collection,row,info,allIndexes,ctx.opzioni(session),collect,errore,previous);
      for (const index of indexes) {
        if (index.partialFilterExpression && !await matches(row, index.partialFilterExpression, { collation: index.collation })) continue;
        const keys = Object.keys(index.key), values = keys.map(k => k.split('.').reduce((v, n) => v?.[n], row));
        // Gli indici multikey sono già stati provati dal server sullo snapshot.
        if (values.some(Array.isArray) || index.sparse && values.every(v => v === undefined)) continue;
        const filter = Object.fromEntries(keys.map((k, i) => [k, { $eq: values[i] ?? null }]));
        const found = await collection.findOne({ $and: [filter, index.partialFilterExpression || {}, { _id: { $ne: row._id } }] }, { ...ctx.opzioni(session), collation: index.collation });
        if (found) throw errore(`Chiave SQL duplicata: ${index.name}.`, '23505');
      }
    }
  }
  const wrapped = new Map();
  const dbProxy = new Proxy(database, { get(target, key) {
    if (key === 'aggregate') return (pipeline, options = {}) => options.session === session
      ? require('./sqlSnapshotEspressioni').cursore(database, null, pipeline, options, collect, ctx, erroreEspressione) : target.aggregate(pipeline, options);
    if (key !== 'collection') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    return name => {
      if (wrapped.has(name)) return wrapped.get(name);
      const collection = target.collection(name);
      const proxy = new Proxy(collection, { get(c, method) {
        if (method === 'find') return (filter = {}, options = {}) => {
          const expression = v => v && typeof v === 'object' && (Object.hasOwn(v, '$expr') || Object.values(v).some(expression));
          if (options.session !== session || !expression(filter)) return c.find(filter, options);
          const { projection, sort, limit, skip, hint, ...aggregateOptions } = options;
          const pipeline = [{ $match: filter }, ...(sort ? [{ $sort: sort }] : []), ...(skip ? [{ $skip: skip }] : []), ...(limit ? [{ $limit: limit }] : []), ...(projection ? [{ $project: projection }] : [])];
          return require('./sqlSnapshotEspressioni').cursore(database, name, pipeline, aggregateOptions, collect, ctx, erroreEspressione);
        };
        if (method === 'aggregate') return (pipeline, options = {}) => options.session === session
          ? require('./sqlSnapshotEspressioni').cursore(database, name, pipeline, options, collect, ctx, erroreEspressione) : c.aggregate(pipeline, options);
        if (!['insertOne', 'insertMany', 'replaceOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'].includes(method)) return typeof c[method] === 'function' ? c[method].bind(c) : c[method];
        return async (...args) => {
          const options = args[method.startsWith('insert') || method.startsWith('delete') ? 1 : 2];
          const lock = name === '_codedb_sql_locks' && method === 'updateOne' && args[0]?._id === 'referential' && args[1]?.$inc?.versione === 1;
          if (options?.session !== session || lock) return c[method](...args);
          await capture(name);
          if (method.startsWith('insert')) {
            const docs = method === 'insertOne' ? [args[0]] : args[0], insertedIds = {};
            for (const [i, row] of docs.entries()) {
              if (!Object.hasOwn(row, '_id')) row._id = new ObjectId();
              if (await c.findOne({ _id: row._id }, ctx.opzioni(session))) throw errore('Chiave SQL duplicata: _id.', '23505');
              await validate(c, [row]); insertedIds[i] = (await c.insertOne(row, options)).insertedId;
            }
            return method === 'insertOne' ? { acknowledged: true, insertedId: insertedIds[0] } : { acknowledged: true, insertedCount: docs.length, insertedIds };
          }
          if (method === 'replaceOne') await validate(c, [args[1]], await c.findOne(args[0],ctx.opzioni(session)));
          if (method.startsWith('update')) {
            const before = await collect(c.find(args[0], { ...ctx.opzioni(session), limit: method === 'updateOne' ? 1 : 0 }));
            const pipeline = Array.isArray(args[1]) ? args[1] : [{ $set: Object.fromEntries(Object.entries(args[1].$set || {}).map(([k, v]) => [k, { $literal: v }])) }];
            if (!Array.isArray(args[1]) && Object.keys(args[1]).some(k => k !== '$set')) throw new Error('Operatore interno non previsto nel savepoint SQL.');
            for (const old of before) {
              const cursor = database.aggregate([{ $documents: { $literal: [old] } }, ...pipeline], ctx.opzioni());
              let row; try { row = await cursor.next(); } catch (err) { throw erroreEspressione(err); } finally { await cursor.close(); }
              await validate(c, [row], old);
              // La prevalidazione non deve ricodificare i campi BSON estranei
              // all'aggiornamento: il comando originale conserva i loro tag.
              await c.updateOne({ _id: old._id }, args[1], options);
            }
            return { acknowledged: true, matchedCount: before.length, modifiedCount: before.length };
          }
          return c[method](...args);
        };
      } });
      wrapped.set(name, proxy); return proxy;
    };
  } });
  const client = new Proxy(original, { get(target, key) {
    if (key === 'db') return name => name === db ? dbProxy : target.db(name);
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  return { client, begin, release, rollback, named, reset() { frames.length = 0; bytes = 0; } };
}
module.exports = { crea, CONDITION, errore, erroreEspressione };
