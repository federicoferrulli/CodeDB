'use strict';
const { EJSON } = require('bson');
const schemaApi = require('./sqlSchemaMongo');
const DbStrategy = require('./DbStrategy');
const { ACCESS, SCHEMAS, MIGRATION } = require('./sqlMongoContesto');
const LOCKS = '_codedb_sql_locks';
const foreign = schema => schema?.constraints.filter(c => c.kind === 'FOREIGN') || [];

async function inizializzaBlocco(database, options = {}) {
  if (!await database.collection(LOCKS).findOne({ _id: 'referential' }, options)) {
    try { await database.collection(LOCKS).insertOne({ _id: 'referential', versione: 0 }, options); }
    catch (err) { if (err.code !== 11000) throw err; }
  }
}
async function blocca(database, options, migration = false) {
  await database.collection(LOCKS).updateOne({ _id: 'referential' }, { $inc: { versione: 1 } }, options);
  if (!migration && await database.collection('_codedb_sql_migrations').findOne({}, options)) {
    throw new Error('Migrazione SQL in corso o interrotta: ripeti ALTER TABLE per completare il recupero prima di scrivere.');
  }
}

async function prepara(database, coll, payload, env, ctx) {
  const names = await database.listCollections({}, ctx.opzioni()).toArray();
  const schemas = new Map();
  for (const info of names) {
    const { name } = info;
    if (name.startsWith('system.') || name.startsWith('_codedb_sql_')) continue;
    const schema = schemaApi.daInfo(info);
    if (schema) schemas.set(name, schema);
  }
  for (const [name, schema] of payload[SCHEMAS] || []) schemas.set(name, schema);
  const interested = new Set([coll]);
  let added;
  do {
    added = false;
    for (const [name, schema] of schemas) for (const fk of foreign(schema)) {
      if (interested.has(fk.references.coll) && !interested.has(name)) { interested.add(name); added = true; }
    }
  } while (added);
  const constraints = [...schemas].flatMap(([name, schema]) => interested.has(name) ? foreign(schema).map(fk => ({ name, fk })) : []);
  if (!constraints.length && !schemas.has(coll)) return null;
  if (payload.sql && require('./SqlToMql').translateWrite(payload.sql).truncate && constraints.some(c => c.fk.references.coll === coll && c.name !== coll)) throw new Error('TRUNCATE impedito da una FOREIGN KEY: elimina prima il vincolo o usa DELETE con le azioni referenziali definite.');
  const access = payload[ACCESS];
  if (constraints.length && !access) throw new Error('Manca la verifica degli scope dei vincoli referenziali.');
  for (const { name, fk } of constraints) { access('read', name); access('read', fk.references.coll); }
  // Il documento esiste prima della transazione. Un aggiornamento concorrente
  // produce WriteConflict e fa ripetere l'intera transazione su uno snapshot
  // nuovo: due scritture SQL non possono introdurre un orfano per write skew.
  await inizializzaBlocco(database, ctx.opzioni());
  const cap = DbStrategy.resultCap(payload), budget = DbStrategy.maxResultBytes(env);
  const collect = async cursor => {
    try {
      const result = await DbStrategy.collectCapped(cursor, cap, budget); ctx.verifica();
      if (result.truncated) throw new Error('Verifica referenziale oltre il limite di righe o byte. Nessuna modifica parziale.');
      return result.docs;
    } finally { await cursor.close(); }
  };
  const incoming = target => constraints.filter(c => c.fk.references.coll === target);
  return {
    hasForeign: constraints.length > 0,
    async prima(options) {
      await blocca(database, options, payload[MIGRATION]);
      if (!payload[MIGRATION]) for (const [name, schema] of schemas) {
        const current = await schemaApi.leggi(database, name, ctx.opzioni());
        if (EJSON.stringify(current) !== EJSON.stringify(schema)) throw new Error('Schema SQL modificato durante la richiesta: ripeti la scrittura con il nuovo schema. Nessuna modifica eseguita.');
      }
      return incoming(coll).length ? collect(database.collection(coll).find({}, options)) : [];
    },
    async dopo(before, options, mutations = name => database.collection(name)) {
      let steps = 0;
      async function propagate(target, previous) {
        if (++steps > 1000) throw new Error('Cascata referenziale oltre il limite di 1000 passi.');
        ctx.verifica();
        if (!previous.length || !incoming(target).length) return;
        const current = await collect(database.collection(target).find({ _id: { $in: previous.map(d => d._id) } }, options));
        const now = new Map(current.map(d => [EJSON.stringify(d._id), d]));
        for (const old of previous) for (const { name, fk } of incoming(target)) {
          const row = now.get(EJSON.stringify(old._id)), cols = fk.references.columns;
          if (cols.some(n => old[n] == null) || (row && cols.every(n => EJSON.stringify(old[n]) === EJSON.stringify(row[n])))) continue;
          const action = row ? fk.onUpdate : fk.onDelete;
          if (['RESTRICT', 'NO ACTION'].includes(action)) continue;
          const filter = { $expr: { $and: fk.columns.map((n, i) => ({ $eq: [`$${n}`, { $literal: old[cols[i]] }] })) } };
          const children = await collect(database.collection(name).find(filter, options));
          if (!children.length) continue;
          const ids = { _id: { $in: children.map(d => d._id) } };
          const remove = action === 'CASCADE' && !row;
          access(remove ? 'delete' : 'write', name);
          const child = await mutations(name);
          if (remove) await child.deleteMany(ids, options);
          else await child.updateMany(ids, { $set: Object.fromEntries(fk.columns.map((n, i) => [n, action === 'SET NULL' ? null : row[cols[i]]])) }, options);
          await propagate(name, children);
        }
      }
      await propagate(coll, before);
      for (const name of interested) for (const unique of schemas.get(name)?.constraints.filter(c => ['PRIMARY', 'UNIQUE'].includes(c.kind) && c.columns.some(n => schemas.get(name).columns.find(col => col.name === n)?.array)) || []) {
        const cursor = database.collection(name).aggregate([
          { $match: { $expr: { $and: unique.columns.map(n => ({ $ne: [{ $ifNull: [`$${n}`, null] }, null] })) } } },
          { $group: { _id: unique.columns.map(n => `$${n}`), count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $limit: 1 },
        ], options);
        try { if (await cursor.hasNext()) throw require('./sqlSavepointMongo').errore(`Chiave SQL duplicata: ${unique.name}.`, '23505'); }
        finally { await cursor.close(); }
      }
      for (const { name, fk } of constraints) {
        const letFields = Object.fromEntries(fk.columns.map((n, i) => [`v${i}`, `$${n}`]));
        const cursor = database.collection(name).aggregate([
          { $match: { $expr: { $and: fk.columns.map(n => ({ $ne: [{ $ifNull: [`$${n}`, null] }, null] })) } } },
          { $lookup: { from: fk.references.coll, let: letFields, pipeline: [
            { $match: { $expr: { $and: fk.references.columns.map((n, i) => ({ $eq: [`$${n}`, `$$v${i}`] })) } } }, { $limit: 1 },
          ], as: '__riferimento_sql' } },
          { $match: { '__riferimento_sql.0': { $exists: false } } }, { $limit: 1 }, { $project: { _id: 1 } },
        ], options);
        try { if (await cursor.hasNext()) throw require('./sqlSavepointMongo').errore(`Violazione della FOREIGN KEY ${fk.name} su ${name}.`, '23503'); }
        finally { await cursor.close(); }
      }
    },
  };
}
module.exports = { prepara, inizializzaBlocco, blocca };
