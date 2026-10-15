'use strict';
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');
const { opzioniDriver } = require('./mongoOpzioni');
const { assertNoMongoServerJs } = require('../auth/capabilities');

async function leggi(client, db, coll, payload, env) {
  const collection = client.db(db).collection(coll);
  const extra = payload.options ? EJSON.parse(payload.options, { relaxed: false }) : {};
  if (Object.hasOwn(extra, 'session')) throw new Error('La sessione della lettura è gestita dallo script.');
  const options = opzioniDriver(extra, payload, DbStrategy.queryTimeoutMs(env));
  let result;
  switch (payload.method) {
    case 'getIndexes': {
      const r = await DbStrategy.collectCapped(collection.listIndexes(options), Infinity, DbStrategy.maxResultBytes(env));
      if (r.truncated) throw new Error('Elenco indici oltre il limite di byte.');
      result = r.docs; break;
    }
    case 'options': result = await collection.options(options); break;
    case 'isCapped': result = await collection.isCapped(options); break;
    case 'estimatedDocumentCount': result = await collection.estimatedDocumentCount(options); break;
    case 'stats': result = await client.db(db).command({ collStats: coll, scale: Number(payload.scale || 1), maxTimeMS: options.maxTimeMS }, { session: options.session }); break;
    default: throw new Error(`Metodo di lettura MongoDB sconosciuto: ${payload.method}.`);
  }
  return require('./mongoEjson').serializza(result);
}
async function indici(client, db, coll, payload, env) {
  const args = EJSON.parse(payload.args, { relaxed: false });
  assertNoMongoServerJs(args, 'Opzioni degli indici');
  const collection = client.db(db).collection(coll);
  if (Object.hasOwn(args[1] || {}, 'session')) throw new Error('La sessione degli indici è gestita dallo script.');
  const options = opzioniDriver({ ...args[1] }, payload, DbStrategy.queryTimeoutMs(env));
  if (args[2] !== undefined) options.commitQuorum = args[2];
  switch (payload.method) {
    case 'createIndex': return collection.createIndex(args[0], options);
    case 'createIndexes': {
      if (!Array.isArray(args[0]) || !args[0].length) throw new Error('createIndexes richiede un array non vuoto di chiavi.');
      // La shell riceve key pattern, il driver descrittori con un campo key.
      const indexes = args[0].map(key => ({ ...args[1], key }));
      return collection.createIndexes(indexes, options);
    }
    case 'dropIndex': return collection.dropIndex(args[0], options);
    case 'dropIndexes': return collection.dropIndex(args[0] === undefined ? '*' : args[0], options);
    case 'hideIndex': case 'unhideIndex': return client.db(db).command({ collMod: coll, index: {
      ...(typeof args[0] === 'string' ? { name: args[0] } : { keyPattern: args[0] }), hidden: payload.method === 'hideIndex',
    } }, { session: options.session });
    default: throw new Error(`Metodo di modifica degli indici sconosciuto: ${payload.method}.`);
  }
}
module.exports = { leggi, indici };
