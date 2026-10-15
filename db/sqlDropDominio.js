'use strict';
const { randomUUID } = require('node:crypto');
const { EJSON } = require('bson');
const { ACCESS } = require('./sqlMongoContesto');
const schemaApi = require('./sqlSchemaMongo');
const alter = require('./sqlAlterMongo');
const depsTypes = require('./sqlDipendenzeTipi');
const JOURNAL = '_codedb_sql_migrations', CATALOG = '_codedb_sql_domains';

async function prepara(database, plan, payload, options) {
  const domains = await database.collection(CATALOG).find({}, options).toArray();
  if (!domains.some(d => d._id === plan.coll)) {
    if (plan.ifExists) return { tables: [], domains: [], domainChanges: [], routines: [], triggers: [] };
    throw new Error(`Dominio SQL inesistente: ${plan.coll}.`);
  }
  const names = new Set([plan.coll]);
  let changed;
  do {
    changed = false;
    for (const d of domains) if (!names.has(d._id) && (names.has(d.definition.domain) || depsTypes.espressione(d.definition.default, names))) {
      names.add(d._id); changed = true;
    }
  } while (changed);
  const domainChanges = [];
  for (const d of domains.filter(d => !names.has(d._id))) {
    const definition = { ...d.definition, checks: (d.definition.checks || []).filter(c => !depsTypes.espressione(c.expr, names)) };
    if (EJSON.stringify(definition) !== EJSON.stringify(d.definition)) {
      domainChanges.push({ name: d._id, definition });
      await require('./sqlCastDomini').aggiorna(database, d._id, definition);
    }
  }
  const overrides = new Map(domainChanges.map(d => [d.name, d.definition]));
  const infos = (await database.listCollections().toArray()).filter(i => schemaApi.daInfo(i));
  const plans = new Map();
  for (const info of infos) {
    const schema = schemaApi.daInfo(info), actions = [];
    for (const c of schema.columns) {
      if (c.domainChain?.some(n => names.has(n))) actions.push({ op: 'drop', name: c.name, cascade: true });
      else if (depsTypes.espressione(c.default, names)) actions.push({ op: 'default', name: c.name });
    }
    for (const c of schema.constraints) if (depsTypes.espressione(c.expr, names)) actions.push({ op: 'dropConstraint', name: c.name, ifExists: true, cascade: true });
    plans.set(info.name, { coll: info.name, actions });
  }
  for (const info of infos) for (const fk of schemaApi.daInfo(info).constraints.filter(c => c.kind === 'FOREIGN')) {
    if (plans.get(fk.references.coll)?.actions.some(a => a.op === 'drop' && fk.references.columns.includes(a.name))) {
      plans.get(info.name).actions.push({ op: 'dropConstraint', name: fk.name, ifExists: true, cascade: true });
    }
  }
  const routines = new Map(), triggers = new Map();
  for (const doc of await database.collection('_codedb_sql_triggers').find({}, options).toArray()) {
    const definition = require('./sqlTriggerMongo').parse(doc.sql);
    if ([...depsTypes.tokens(definition.when || [])].some(name => names.has(name))) triggers.set(doc._id, { _id: doc._id, coll: doc.coll, remove: true });
  }
  for (const doc of await database.collection('_codedb_sql_procedures').find({}, options).toArray()) {
    const definition = require('./sqlDipendenzeRoutine').definizione(doc);
    if (definition && depsTypes.routine(definition, names)) routines.set(doc._id, { _id: doc._id, remove: true });
  }
  const tables = [];
  for (const info of infos) {
    const p = plans.get(info.name);
    const migration = alter.prepara(schemaApi.daInfo(info), p);
    await require('./sqlDominiMongo').risolvi(database, migration.schema, overrides, options);
    const newValidator = schemaApi.validatore(migration.schema);
    if (!p.actions.length && EJSON.stringify(newValidator) === EJSON.stringify(info.options.validator)) continue;
    for (const r of await require('./sqlDipendenzeRoutine').alter(database, p, payload)) routines.set(r._id, r);
    for (const t of await require('./sqlDipendenzeMongo').trigger(database, p, migration.schema)) triggers.set(t._id, t);
    const oldIndexes = (await database.collection(info.name).listIndexes().toArray()).filter(i => i.name !== '_id_').map(alter.indice);
    const newIndexes = oldIndexes.map(i => require('./sqlDipendenzeMongo').indice(EJSON.parse(EJSON.stringify(i)), p)).filter(Boolean);
    tables.push({ coll: info.name, ...migration, oldValidator: info.options.validator, newValidator,
      oldIndexes, newIndexes, indexNames: oldIndexes.filter(i => !newIndexes.some(n => n.name === i.name)).map(i => i.name) });
  }
  const remove = await require('./sqlDipendenzeRoutine').dependenti(database, [...routines.keys()], options);
  for (const name of remove) routines.set(name, { _id: name, remove: true });
  if (!plan.cascade && (names.size > 1 || tables.length || routines.size || triggers.size || domainChanges.length)) throw new Error('DROP DOMAIN impedito da una dipendenza: usa CASCADE per eliminarla.');
  for (const name of names) payload[ACCESS]('ddl', name);
  for (const t of tables) payload[ACCESS]('ddl', t.coll);
  for (const name of routines.keys()) payload[ACCESS]('ddl', name);
  for (const t of triggers.values()) if (t.coll) payload[ACCESS]('ddl', t.coll);
  for (const d of domainChanges) payload[ACCESS]('ddl', d.name);
  return { tables, domains: [...names], domainChanges, routines: [...routines.values()], triggers: [...triggers.values()] };
}
async function esegui(client, db, plan, payload, env) {
  const database = client.db(db), refs = require('./sqlVincoliReferenziali');
  const ctx = require('./MongoSqlRuntime').contesto(env, payload), DbStrategy = require('./DbStrategy');
  await refs.inizializzaBlocco(database);
  try { await database.createCollection(JOURNAL); } catch (error) { if (error.code !== 48) throw error; }
  const session = client.startSession(), options = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
  const fenced = work => session.withTransaction(async () => { await refs.blocca(database, { session }, true); return work(); }, options);
  let job, migration;
  try {
    const recovered = await fenced(() => alter.recupera(database, session, payload[ACCESS]));
    if (recovered?.committed && recovered.sql === payload.sql) return;
    await fenced(async () => {
      if (!migration) {
        migration = await prepara(database, plan, payload, ctx.opzioni(session));
        if (migration.tables.length) {
          const records = migration.tables.map(({ coll, oldValidator, newValidator, oldIndexes, newIndexes, indexNames }) => ({ coll, oldValidator, newValidator, oldIndexes, newIndexes, indexNames }));
          job = { _id: randomUUID(), ...records[0], sql: payload.sql, dependencies: records.slice(1) };
          await database.collection(JOURNAL).insertOne(job);
          for (const t of records) await database.command({ collMod: t.coll, validator: { $and: [t.oldValidator, { $expr: false }] }, validationLevel: 'strict', validationAction: 'error' });
          for (const t of records) await alter.allineaIndici(database.collection(t.coll), t.newIndexes, t.indexNames);
        }
      }
      const op = ctx.opzioni(session);
      for (const t of migration.tables) {
        const cursor = database.collection(t.coll).aggregate(t.pipeline.length ? t.pipeline : [{ $match: {} }], op);
        let result;
        try { result = await DbStrategy.collectCapped(cursor, DbStrategy.resultCap(payload), DbStrategy.maxResultBytes(env)); } finally { await cursor.close(); }
        if (result.truncated) throw new Error('DROP DOMAIN CASCADE oltre il limite di righe o byte.');
        for (const row of result.docs) {
          const check = database.aggregate([{ $documents: { $literal: [row] } }, { $match: schemaApi.validatore(t.schema, true) }], op);
          try { if (!await check.hasNext()) throw new Error('I dati violano lo schema dopo DROP DOMAIN CASCADE.'); } finally { await check.close(); }
          if (t.pipeline.length) await database.collection(t.coll).replaceOne({ _id: row._id }, row, { ...op, bypassDocumentValidation: true });
        }
      }
      for (const r of migration.routines) await database.collection('_codedb_sql_procedures').deleteOne({ _id: r._id }, op);
      for (const t of migration.triggers) {
        if (t.remove) await database.collection('_codedb_sql_triggers').deleteOne({ _id: t._id }, op);
        else await database.collection('_codedb_sql_triggers').updateOne({ _id: t._id }, { $set: { sql: t.sql } }, op);
      }
      await database.collection(CATALOG).deleteMany({ _id: { $in: migration.domains } }, op);
      for (const d of migration.domainChanges) await database.collection(CATALOG).updateOne({ _id: d.name }, { $set: { definition: d.definition } }, op);
      if (job) await database.collection(JOURNAL).insertOne({ _id: `${job._id}:commit` }, op);
      ctx.verifica();
    });
    await fenced(() => alter.recupera(database, session, payload[ACCESS]));
  } catch (error) {
    try {
      const recovered = await fenced(() => alter.recupera(database, session, payload[ACCESS]));
      if (recovered?.committed && recovered.sql === payload.sql) return;
    } catch (recovery) { throw new Error(`${error.message} Recupero da completare ripetendo DROP DOMAIN: ${recovery.message}`, { cause: error }); }
    throw error;
  } finally { await session.endSession(); }
}
module.exports = { esegui };
