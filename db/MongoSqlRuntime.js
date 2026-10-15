'use strict';

const { EJSON, calculateObjectSize } = require('bson');
const DbStrategy = require('./DbStrategy');
const sql = require('./SqlToMql');
const { opzioniDriver } = require('./mongoOpzioni');
const { SESSION, FLOW } = require('./sqlMongoContesto');

function contesto(env, payload) {
  const timeout = DbStrategy.aggregateTimeoutMs(env);
  const fine = timeout > 0 ? Date.now() + timeout : Infinity;
  const verifica = () => {
    if (payload.opHandle?.interrotto) throw new Error('Query SQL annullata.');
    if (Date.now() >= fine) throw new Error('Tempo massimo della query SQL superato.');
  };
  return { verifica, opzioni: session => {
    verifica();
    return opzioniDriver(session ? { session } : {}, payload, fine === Infinity ? 0 : Math.max(1, fine - Date.now()));
  } };
}

async function raccogli(cursor, cap, budget, verifica) {
  try {
    const result = await DbStrategy.collectCapped(cursor, cap, budget);
    verifica();
    if (result.truncated) throw new Error('Risultato SQL oltre il limite di righe o byte: esecuzione interrotta senza risultato parziale. Riduci la query.');
    return result.docs;
  } finally { await cursor.close(); }
}

function risultato(docs) {
  return { docs: docs.map(require('./mongoEjson').serializza), columns: [...new Set(docs.flatMap(Object.keys))],
    total: docs.length, skip: 0, resultSet: true };
}

function chiaveRiga(doc, columns) {
  const normalizza = v => {
    if (v == null) return null;
    if (['Int32', 'Double', 'Long', 'Decimal128'].includes(v?._bsontype)) return { numero: v.toString() };
    if (typeof v === 'number') return { numero: String(v) };
    if (Array.isArray(v)) return v.map(normalizza);
    if (v && typeof v === 'object' && !v._bsontype && !(v instanceof Date)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, normalizza(v[k])]));
    return v;
  };
  return EJSON.stringify(columns.map(c => normalizza(doc[c])), { relaxed: false });
}

async function leggi(client, db, payload, env) {
  const plan = sql.translate(payload.sql);
  const ctx = contesto(env, payload), budget = DbStrategy.maxResultBytes(env);
  const run = (p, session, cap = Infinity) => {
    const database = client.db(db), pipeline = sql.planToPipeline(p);
    if (calculateObjectSize({ pipeline }) > 16 * 1024 * 1024 - 4096) throw new Error('Il piano SQL supera la dimensione massima di un comando MongoDB. Riduci le CTE materializzate.');
    if (session?.inTransaction()) return eseguiPipeline(database, p.coll, pipeline, ctx.opzioni(session), cap, budget, ctx.verifica);
    const cursor = (p.coll ? database.collection(p.coll) : database).aggregate(pipeline, ctx.opzioni(session));
    return raccogli(cursor, cap, budget, ctx.verifica);
  };
  if (plan.kind !== 'program') return risultato(await run(plan, payload[SESSION], DbStrategy.resultCap(payload)));
  const { definitions } = sql.analizzaProgramma(plan);
  const envCte = new Map(plan.inherited);
  let memoriaCte = 0;
  const maximum = Number(env.CODEDB_SQL_RECURSION_LIMIT || 1000);
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('CODEDB_SQL_RECURSION_LIMIT deve essere un intero positivo.');
  // Lo snapshot mantiene le letture coerenti fra le iterazioni sui replica set.
  // Anche uno standalone esegue la ricorsione, con la consistenza delle singole
  // letture MongoDB; non vengono create collezioni temporanee.
  const hello = await client.db(db).command({ hello: 1 }, ctx.opzioni());
  const session = client.startSession(hello.setName || hello.msg === 'isdbgrid' ? { snapshot: true } : { causalConsistency: true });
  try {
    for (const d of definitions) {
      let delta = await run(sql.rinominaPiano(sql.translateTokens(d.seed, envCte), d.columns), session);
      const rows = [], seen = new Set();
      let bytes = 0;
      const aggiungi = input => input.filter(row => {
        const key = d.step && !d.all ? chiaveRiga(row, d.columns) : null;
        if (key != null && seen.has(key)) return false;
        if (key != null) seen.add(key);
        bytes += calculateObjectSize(row) + 16;
        // I risultati di una CTE entrano nel comando successivo via $documents;
        // riserva margine al piano rispetto ai 16 MiB di un comando BSON.
        if (bytes > Math.min(budget || Infinity, 12 * 1024 * 1024)) throw new Error(`La CTE ${d.name} supera il budget di memoria del piano SQL.`);
        rows.push(row); return true;
      });
      delta = aggiungi(delta);
      if (d.step) {
        let iteration = 0;
        while (delta.length) {
          ctx.verifica();
          if (++iteration > maximum) throw new Error(`La CTE ${d.name} supera ${maximum} iterazioni. Controlla la condizione di arresto o CODEDB_SQL_RECURSION_LIMIT.`);
          envCte.set(d.name, sql.pianoDocumenti(delta, d.columns));
          delta = aggiungi(await run(sql.rinominaPiano(sql.translateTokens(d.step, envCte), d.columns), session));
        }
      }
      envCte.set(d.name, sql.pianoDocumenti(rows, d.columns));
      memoriaCte += bytes;
      if (memoriaCte > (budget || 32 * 1024 * 1024)) throw new Error('Le CTE superano il budget complessivo di memoria del piano SQL.');
    }
    return risultato(await run(sql.translateTokens(plan.query, envCte), session, DbStrategy.resultCap(payload)));
  } finally { await session.endSession(); }
}

async function scrivi(client, db, coll, payload, env) {
  const plan = sql.translateWrite(payload.sql);
  if (plan.coll !== coll || plan.kind !== 'write') throw new Error('Piano SQL di scrittura non valido.');
  const ctx = contesto(env, payload), budget = DbStrategy.maxResultBytes(env), cap = DbStrategy.resultCap(payload);
  const hello = await client.db(db).command({ hello: 1 }, ctx.opzioni());
  if (!hello.setName && hello.msg !== 'isdbgrid' && (plan.returning || plan.selection || plan.conflict || plan.source || plan.changes)) throw new Error('La scrittura SQL atomica richiede un replica set o un cluster MongoDB con transazioni. Nessuna scrittura eseguita.');
  const schemaApi = require('./sqlSchemaMongo');
  const schema = await schemaApi.leggi(client.db(db), coll, ctx.opzioni());
  if (plan.expressionRows && !plan.insertColumns && !schema) throw new Error('INSERT senza colonne richiede una tabella con schema SQL.');
  const { DEFAULT } = require('./sqlMongoContesto');
  if ((plan.values || plan.implicitColumns || plan.needsSchema || plan.docs?.some(d => Object.values(d).includes(DEFAULT))) && !schema) throw new Error('INSERT senza colonne o con DEFAULT richiede una tabella creata con schema SQL. Per una collezione libera indica colonne e valori espliciti.');
  if (plan.values) plan.docs = plan.values.map(row => {
    if (row.length !== schema.columns.length) throw new Error('Numero di valori diverso dal numero di colonne dello schema SQL.');
    return Object.fromEntries(schema.columns.map((c, i) => [c.name, row[i]]));
  });
  if (plan.implicitColumns) plan.source = sql.rinominaPiano(plan.source, schema.columns.map(c => c.name));
  if (plan.docs) plan.docs = plan.docs.map(doc => Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== DEFAULT)));
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    if (schema || plan.returning || plan.selection || plan.conflict || plan.source || plan.changes) throw new Error('La scrittura SQL atomica richiede un replica set o un cluster MongoDB con transazioni. Nessuna scrittura eseguita.');
    const collection = client.db(db).collection(coll);
    const result = plan.docs ? await collection.insertMany(plan.docs, ctx.opzioni())
      : plan.op === 'updateMany' ? await collection.updateMany(plan.filter, plan.update, ctx.opzioni())
        : await collection.deleteMany(plan.filter, ctx.opzioni());
    return risultato([{ affectedRows: result.insertedCount ?? result.matchedCount ?? result.deletedCount }]);
  }
  const collection = client.db(db).collection(coll);
  const references = await require('./sqlVincoliReferenziali').prepara(client.db(db), coll, payload, env, ctx);
  const session = payload[SESSION] || client.startSession();
  const conflitti = require('./sqlConflitti');
  const originalDocs = plan.docs?.map(doc => ({ ...doc }));
  let docs, affected = 0;
  try {
    const indexes = plan.conflict ? await conflitti.indiciConflitto(collection, plan.conflict, ctx.opzioni(), schema) : [];
    for (let attempt = 0; ; attempt++) try {
      const transact = payload[SESSION] ? fn => fn() : (fn, options) => session.withTransaction(fn, options);
      await transact(async () => {
        ctx.verifica();
        const before = references ? await references.prima(ctx.opzioni(session)) : null;
        if (schema && EJSON.stringify(schema) !== EJSON.stringify(await schemaApi.leggi(client.db(db), coll, ctx.opzioni()))) throw new Error('Schema SQL modificato durante la richiesta: ripeti la scrittura con il nuovo schema.');
        const statementTriggers = await require('./sqlTriggerMongo').prepara(client, db, coll, payload, env, ctx, session);
        const triggers = plan.truncate ? null : statementTriggers;
        const event = plan.truncate ? 'TRUNCATE' : plan.op.startsWith('insert') ? 'INSERT' : plan.op.startsWith('update') ? 'UPDATE' : 'DELETE';
        const statementUpdate = plan.update || plan.conflict?.update;
        const statementColumns = plan.assignments || (Array.isArray(statementUpdate) ? statementUpdate.flatMap(s => Object.keys(s.$set || {})) : Object.keys(statementUpdate?.$set || {}));
        const events = [event, ...(plan.conflict && !plan.conflict.nothing ? ['UPDATE'] : [])];
        if (statementTriggers) for (const e of events) await statementTriggers.statement('BEFORE', e, statementColumns);
        let ids;
        const run = p => eseguiPipeline(client.db(db), p.coll, sql.planToPipeline(p), ctx.opzioni(session), cap, budget, ctx.verifica);
        if (plan.expressionRows) {
          const names = plan.insertColumns || schema.columns.map(c => c.name);
          if (new Set(names).size !== names.length) throw new Error('Colonna ripetuta nella INSERT.');
          const rows = plan.expressionRows.map(row => {
            if (row.length !== names.length) throw new Error('Numero di valori diverso dal numero di colonne SQL.');
            return Object.fromEntries(row.flatMap((expr, i) => expr === DEFAULT ? [] : [[names[i], require('./sqlEspressioni').emettiEspressione(expr)]]));
          });
          try { plan.docs = await eseguiPipeline(client.db(db), null, [{ $documents: rows }], ctx.opzioni(payload[FLOW]?.savepoints ? undefined : session), cap, budget, ctx.verifica); }
          catch (error) { throw payload[FLOW]?.savepoints ? require('./sqlSavepointMongo').erroreEspressione(error) : error; }
        }
        if (plan.source) plan.docs = await run(plan.source);
        else if (originalDocs) plan.docs = originalDocs.map(doc => ({ ...doc }));
        const convert = schema && schemaApi.conversioni(schema);
        if (schema && plan.docs?.length) try {
          plan.docs.forEach(doc => schemaApi.normalizzaArray(schema, doc));
          plan.docs = await eseguiPipeline(client.db(db), null,
            [{ $documents: { $literal: plan.docs } }, schemaApi.conversioni(schema, true)], ctx.opzioni(payload[FLOW]?.savepoints ? undefined : session), cap, budget, ctx.verifica);
        } catch (err) { throw payload[FLOW]?.savepoints ? require('./sqlSavepointMongo').erroreEspressione(err) : err; }
        if (schema && plan.docs) plan.docs.forEach(doc => schemaApi.normalizzaJson(schema, doc));
        const update = value => {
          const stages = Array.isArray(value) ? value : [{ $set: Object.fromEntries(Object.entries(value.$set).map(([k, v]) => [k, { $literal: v }])) }];
          if (!convert) return value;
          for (const stage of stages) for (const column of schema.columns.filter(c => c.array)) {
            const v = stage.$set?.[column.name];
            if (typeof v?.$literal === 'string') stage.$set[column.name] = { $literal: require('./sqlArrayValore').parse(v.$literal) };
          }
          return [...stages, convert];
        };
        const applyUpdate = async (filter, value, options = ctx.opzioni(session)) => {
          const previous = triggers ? await triggers.prima(filter, options) : null;
          const fields = Array.isArray(value) ? value.flatMap(s => Object.keys(s.$set || {})) : Object.keys(value.$set || {});
          const json = schema?.columns.some(c => c.type === 'JSON' && fields.includes(c.name));
          if (!json && !triggers?.hasBefore('UPDATE')) {
            const result = await collection.updateMany(filter, update(value), options);
            if (triggers) await triggers.dopo(previous, undefined, fields);
            return result;
          }
          if (fields.includes('_id')) throw new Error('Il campo _id di MongoDB è immutabile.');
          const rows = await raccogli(collection.aggregate([{ $match: filter }, ...update(value)], options), cap, budget, ctx.verifica);
          for (const row of rows) {
            ctx.verifica(); schemaApi.normalizzaJson(schema, row, fields);
            if (triggers?.hasBefore('UPDATE')) await triggers.before('UPDATE', previous.find(d => EJSON.stringify(d._id) === EJSON.stringify(row._id)), row, fields);
            await collection.replaceOne({ _id: row._id }, row, options);
          }
          if (triggers) await triggers.dopo(previous, undefined, fields);
          return { matchedCount: rows.length, modifiedCount: rows.length };
        };
        const applyInsert = async (doc, options) => {
          const result = await collection.insertOne(doc, options);
          if (triggers) await triggers.dopo([], [result.insertedId]);
          return result;
        };
        if (plan.conflict) {
          ids = await conflitti.inserisciConConflitti(collection, plan, indexes, ctx.opzioni(session), ctx.verifica, applyUpdate, applyInsert,
            triggers?.hasBefore('INSERT') ? doc => triggers.before('INSERT', null, doc) : null);
        } else if (plan.op === 'insertOne' || plan.op === 'insertMany') {
          if (triggers?.hasBefore('INSERT')) {
            ids = [];
            for (const doc of plan.docs) {
              await triggers.before('INSERT', null, doc);
              ids.push((await applyInsert(doc, ctx.opzioni(session))).insertedId);
            }
          } else {
            ids = plan.docs.length ? Object.values((await collection.insertMany(plan.docs, ctx.opzioni(session))).insertedIds) : [];
            if (triggers) await triggers.dopo([], ids);
          }
        } else if (plan.changes) {
          const rows = await run(plan.changes), seen = new Set();
          ids = [];
          for (const row of rows) {
            const key = EJSON.stringify(row.rid);
            if (seen.has(key)) continue;
            seen.add(key); ids.push(row.rid);
            if (plan.op === 'updateMany') await applyUpdate({ _id: row.rid }, { $set: Object.fromEntries(plan.assignments.map((name, i) => [name, row[`v${i}`] ?? null])) });
          }
        } else {
          const cursor = plan.selection ? collection.aggregate(plan.selection, ctx.opzioni(session))
            : collection.find(plan.filter, { ...ctx.opzioni(session), projection: { _id: 1 } });
          const matched = await raccogli(cursor, cap, budget, ctx.verifica);
          ids = matched.map(d => d._id);
        }
        const filter = { _id: { $in: ids } };
        if (plan.op === 'updateMany' && !plan.changes && ids.length) await applyUpdate(filter, plan.update);
        affected = ids.length;
        docs = plan.returning ? await raccogli(collection.aggregate([{ $match: filter }, ...plan.returning], ctx.opzioni(session)), cap, budget, ctx.verifica) : [];
        if (plan.op === 'deleteMany' && ids.length) {
          const previous = triggers ? await triggers.prima(filter) : null;
          if (triggers?.hasBefore('DELETE')) for (const old of previous) await triggers.before('DELETE', old, null);
          await collection.deleteMany(filter, ctx.opzioni(session));
          if (triggers) await triggers.dopo(previous);
        }
        if (references) await references.dopo(before, ctx.opzioni(session), async name => {
          const api = require('./sqlTriggerMongo');
          return api.mutazioni(client.db(db).collection(name), await api.prepara(client, db, name, payload, env, ctx, session));
        });
        if (statementTriggers) for (const e of [...events].reverse()) await statementTriggers.statement('AFTER', e, statementColumns);
        ctx.verifica();
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: DbStrategy.aggregateTimeoutMs(env) || 30000 });
      break;
    } catch (err) {
      // Un inserimento concorrente può vincere dopo la lettura del vincolo.
      // E11000 abortisce la transazione: soltanto questo esito è ripetibile.
      if (payload[SESSION] || !plan.conflict || err.code !== 11000 || attempt >= 2) throw err;
      ctx.verifica();
    }
    return plan.returning ? risultato(docs) : risultato([{ messaggio: `${affected} documenti ${plan.op === 'deleteMany' ? 'eliminati' : 'modificati'}.`, affectedRows: affected }]);
  } finally { if (!payload[SESSION]) await session.endSession(); }
}

// MongoDB vieta $unionWith nelle transazioni: i rami vengono letti nello stesso
// snapshot e il resto della pipeline riparte da $documents, con gli stessi cap.
async function eseguiPipeline(database, coll, pipeline, options, cap, budget, verifica) {
  const at = pipeline.findIndex(s => s.$unionWith);
  if (at < 0) return raccogli((coll ? database.collection(coll) : database).aggregate(pipeline, options), cap, budget, verifica);
  const left = await eseguiPipeline(database, coll, pipeline.slice(0, at), options, cap, budget, verifica);
  const u = pipeline[at].$unionWith;
  const right = await eseguiPipeline(database, u.coll, u.pipeline || [], options, cap, budget, verifica);
  const rows = left.concat(right);
  if (rows.length > cap || calculateObjectSize({ rows }) > Math.min(budget || Infinity, 12 * 1024 * 1024)) throw new Error('Risultato intermedio SQL oltre il limite di righe o byte.');
  return eseguiPipeline(database, null, [{ $documents: { $literal: rows } }, ...pipeline.slice(at + 1)], options, cap, budget, verifica);
}

module.exports = { leggi: require('./sqlCastDomini').avvolgi(leggi, 2), scrivi: require('./sqlCastDomini').avvolgi(scrivi, 3), chiaveRiga, contesto };
