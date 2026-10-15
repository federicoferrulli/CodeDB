'use strict';
// shortcut: i client esterni non passano dal runtime; i trigger richiedono
// scritture CodeDB e non sostituiscono un motore relazionale lato server.
const sql = require('./SqlToMql');
const procedures = require('./sqlProcedureMongo');
const schemaApi = require('./sqlSchemaMongo');
const { quotaSempre } = require('./identificatori');
const { EJSON } = require('bson');
const { leggiEspressione, emettiEspressione } = require('./sqlEspressioni');
const { SESSION, ROUTINE, FLOW, ACCESS } = require('./sqlMongoContesto');
const CATALOG = '_codedb_sql_triggers';
const STAGE = '_codedb_sql_trigger_stage';
const word = p => String(p.peek()?.value || '').toUpperCase();
const eat = (p, s) => word(p) === s && !!p.next();
const expect = (p, s) => { if (!eat(p, s)) throw new Error(`Trigger SQL: atteso ${s}.`); };
function riconosci(text) { return /^\s*(CREATE\s+(?:OR\s+REPLACE\s+)?|DROP\s+|ALTER\s+)TRIGGER\b/i.test(text); }
function parse(text) {
  const p = new sql.Parser(sql.tokenize(text));
  if (eat(p, 'ALTER')) {
    expect(p, 'TRIGGER'); const name = p.parseIdent(); expect(p, 'ON'); const coll = p.parseIdent();
    expect(p, 'RENAME'); expect(p, 'TO'); const to = p.parseIdent(); p.eatPunct(';');
    if (!p.eof()) throw new Error('Testo inatteso dopo ALTER TRIGGER.');
    return { op: 'rename', name, coll, to };
  }
  const op = eat(p, 'DROP') ? 'drop' : (expect(p, 'CREATE'), 'create');
  const replace = eat(p, 'OR'); if (replace) expect(p, 'REPLACE');
  expect(p, 'TRIGGER'); const ifExists = op === 'drop' && eat(p, 'IF'); if (ifExists) expect(p, 'EXISTS');
  const name = p.parseIdent();
  if (op === 'drop') {
    const coll = eat(p, 'ON') ? p.parseIdent() : null; p.eatPunct(';');
    if (!p.eof()) throw new Error('Testo inatteso dopo DROP TRIGGER.');
    return { op, name, coll, ifExists };
  }
  const timing = eat(p, 'BEFORE') ? 'BEFORE' : (expect(p, 'AFTER'), 'AFTER');
  const events = []; let updateColumns;
  do {
    const event = word(p); p.next();
    if (!['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(event) || events.includes(event)) throw new Error('Evento del trigger SQL non valido o duplicato.');
    events.push(event);
    if (event === 'UPDATE' && eat(p, 'OF')) {
      updateColumns = []; do { updateColumns.push(p.parseIdent()); } while (p.eatPunct(','));
      if (new Set(updateColumns).size !== updateColumns.length) throw new Error('Colonna UPDATE OF duplicata.');
    }
  } while (eat(p, 'OR'));
  expect(p, 'ON'); const coll = p.parseIdent(); let level = 'STATEMENT';
  if (eat(p, 'FOR')) { eat(p, 'EACH'); level = word(p); p.next(); if (!['ROW', 'STATEMENT'].includes(level)) throw new Error('Trigger SQL: atteso ROW oppure STATEMENT.'); }
  if (events.includes('TRUNCATE') && level !== 'STATEMENT') throw new Error('TRUNCATE richiede un trigger FOR EACH STATEMENT.');
  let order, when;
  if (['FOLLOWS', 'PRECEDES'].includes(word(p))) {
    order = { direction: p.next().value.toUpperCase(), name: p.parseIdent() };
    if (events.length !== 1) throw new Error('FOLLOWS/PRECEDES richiede un singolo evento come in MySQL.');
  }
  if (eat(p, 'WHEN')) {
    p.expectPunct('('); const start = p.pos; leggiEspressione(p);
    when = p.toks.slice(start, p.pos); p.expectPunct(')');
  }
  return { op, name, coll, event: events[0], events, updateColumns, timing, level, replace, order, when, tokens: p.toks.slice(p.pos) };
}
function compila(plan, schema) {
  if (!schema) throw new Error('Il trigger richiede una tabella con schema SQL.');
  if (plan.updateColumns?.some(n => !schema.columns.some(c => c.name === n))) throw new Error('Colonna UPDATE OF sconosciuta.');
  const refs = [], rewrite = (source, condition = false) => source.map(t => {
    const match = t.type === 'ident' && /^(OLD|NEW)\.(.+)$/i.exec(t.value);
    if (!match) return t;
    if (plan.level === 'STATEMENT') throw new Error('OLD e NEW non sono disponibili nei trigger di istruzione.');
    const record = match[1].toUpperCase(), col = schema.columns.find(c => c.name === match[2]);
    const unavailable = event => record === 'OLD' ? event === 'INSERT' : event === 'DELETE';
    if (!col || (condition ? plan.events.some(unavailable) : plan.events.every(unavailable))) throw new Error(`Riferimento del trigger non disponibile: ${t.value}.`);
    let ref = refs.find(r => r.record === record && r.column.name === col.name);
    if (!ref) { ref = { record, column: col, name: `__record_${refs.length}` }; refs.push(ref); }
    return { type: 'ident', value: ref.name };
  });
  const tokens = rewrite(plan.tokens), condition = plan.when && rewrite(plan.when, true);
  let body = procedures.bind(tokens, {});
  if (word(new sql.Parser(tokens)) !== 'BEGIN') body = `BEGIN ${body.replace(/;\s*$/, '')}; END`;
  const params = refs.map(r => `${quotaSempre(r.name, 'mongodb')} ${r.column.type}${r.column.args.length ? '(' + r.column.args.map(v => procedures.bind([{ type: typeof v === 'string' ? 'str' : 'num', value: v }], {})).join(',') + ')' : ''}${r.column.unsigned ? ' UNSIGNED' : ''}${r.column.array ? '[]' : ''}`).join(',');
  const routine = procedures.parse(`CREATE PROCEDURE ${quotaSempre(plan.name, 'mongodb')}(${params}) ${body}`);
  if (condition) {
    const p = new sql.Parser(condition), expr = leggiEspressione(p);
    if (!p.eof()) throw new Error('Condizione WHEN del trigger non valida.');
    emettiEspressione(expr, n => { if (!refs.some(r => r.name === n)) throw new Error(`WHEN richiede OLD o NEW: ${n}.`); return n; });
    routine.body = [{ op: 'if', expr, then: routine.body, else: [] }];
  }
  const check = nodes => { for (const n of nodes) {
    if (n.op === 'set') {
      const ref = refs.find(r => r.name === n.name);
      if (ref && (plan.timing !== 'BEFORE' || ref.record !== 'NEW')) throw new Error('OLD e NEW sono di sola lettura nei trigger AFTER; BEFORE può assegnare soltanto NEW.');
      if (ref) ref.assigned = true;
    }
    if (n.then) check(n.then); if (n.else) check(n.else);
    for (const h of n.handlers || []) check(h.then);
  } };
  check(routine.body); return { routine, refs };
}
async function esegui(client, db, coll, payload) {
  const plan = parse(payload.sql), database = client.db(db), catalog = database.collection(CATALOG);
  if (plan.coll !== coll) throw new Error('Bersaglio del trigger non valido.');
  const refsApi = require('./sqlVincoliReferenziali'); await refsApi.inizializzaBlocco(database);
  try { await database.createCollection(CATALOG); } catch (err) { if (err.code !== 48) throw err; }
  if (plan.timing === 'BEFORE') try { await database.createCollection(STAGE); } catch (err) { if (err.code !== 48) throw err; }
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await refsApi.blocca(database, { session });
      if (plan.op === 'drop' || plan.op === 'rename') {
        const doc = await catalog.findOne({ _id: plan.name }, { session });
        if (!doc) { if (plan.ifExists) return; throw new Error('Trigger SQL inesistente.'); }
        if (coll && coll !== doc.coll) throw new Error('Il trigger appartiene a una tabella diversa.');
        payload[ACCESS]('ddl', doc.coll);
        if (plan.op === 'rename') {
          if (await catalog.findOne({ _id: plan.to }, { session })) throw new Error('Nome del trigger SQL già utilizzato.');
          const tokens = sql.tokenize(doc.sql), at = tokens.findIndex(t => String(t.value).toUpperCase() === 'TRIGGER');
          tokens[at + 1] = { type: 'ident', value: plan.to };
          await catalog.insertOne({ ...doc, _id: plan.to, sql: procedures.bind(tokens,{}) }, { session });
        }
        await catalog.deleteOne({ _id: plan.name }, { session });
      } else {
        compila(plan, await schemaApi.leggi(database, coll));
        const existing = await catalog.findOne({ _id: plan.name }, { session });
        if (existing) payload[ACCESS]('ddl', existing.coll);
        const doc = { _id: plan.name, coll, sql: payload.sql };
        const group = (await catalog.find({ coll }, { session }).toArray()).filter(d => {
          const p = parse(d.sql); return d._id !== plan.name && p.timing === plan.timing && p.level === plan.level && p.events.length === 1 && p.event === plan.event;
        }).sort(ordine);
        if (plan.order) {
          const at = group.findIndex(d => d._id === plan.order.name);
          if (at < 0) throw new Error('FOLLOWS/PRECEDES richiede un altro trigger della stessa tabella, fase ed evento.');
          group.splice(at + (plan.order.direction === 'FOLLOWS' ? 1 : 0), 0, doc);
        } else if (group.some(d => d.position !== undefined) && plan.events.length === 1) group.push(doc);
        if (group.includes(doc)) for (const [position, item] of group.entries()) {
          if (item === doc) doc.position = position;
          else await catalog.updateOne({ _id: item._id }, { $set: { position } }, { session });
        }
        if (plan.replace) await catalog.replaceOne({ _id: plan.name }, doc, { session, upsert: true });
        else await catalog.insertOne(doc, { session });
      }
    }, { writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
  return { docs: [{ messaggio: `Trigger ${plan.name} ${plan.op === 'create' ? 'creato' : plan.op === 'rename' ? 'rinominato' : 'eliminato'}.` }], columns: ['messaggio'], resultSet: true };
}

// L'ordine esplicito viene materializzato: eliminare il trigger usato come
// riferimento non deve cambiare la sequenza degli altri, come in MySQL.
function ordine(a, b) {
  if (a.position !== undefined || b.position !== undefined) return (a.position ?? Infinity) - (b.position ?? Infinity) || a._id.localeCompare(b._id, 'en');
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

async function prepara(client, db, coll, payload, env, ctx, session) {
  const database = client.db(db), options = ctx.opzioni(session);
  const docs = (await database.collection(CATALOG).find({ coll }, options).toArray()).sort(ordine);
  if (!docs.length) return null;
  const schema = await schemaApi.leggi(database, coll);
  const triggers = docs.filter(doc => doc.enabled !== false).map(doc => {
    const plan = parse(doc.sql);
    if (plan.op !== 'create' || plan.name !== doc._id || plan.coll !== coll) throw new Error('Definizione del trigger non valida nel catalogo.');
    return { ...plan, ...compila(plan, schema) };
  });
  const DbStrategy = require('./DbStrategy'), cap = DbStrategy.resultCap(payload), budget = DbStrategy.maxResultBytes(env);
  async function collect(filter, readOptions = options) {
    // Le opzioni di una scrittura non possono ridurre o proiettare le immagini
    // interne (raw, skip, returnKey...), saltando così l'esecuzione del trigger.
    const selected = Object.fromEntries(['session', 'maxTimeMS', 'signal', 'comment', 'collation', 'let', 'hint', 'sort', 'limit']
      .filter(k => readOptions[k] !== undefined).map(k => [k, readOptions[k]]));
    const cursor = database.collection(coll).find(filter, selected);
    try { const r = await DbStrategy.collectCapped(cursor, cap, budget); if (r.truncated) throw new Error('Trigger SQL oltre il limite di righe o byte.'); return r.docs; }
    finally { await cursor.close(); }
  }
  const key = id => EJSON.stringify(id);
  const flow = payload[FLOW] || { depth: 0, steps: 0, ctx };
  async function fire(timing, event, old, next, columns, level = 'ROW') {
    const changed = {};
    for (const trigger of triggers.filter(t => t.events.includes(event) && t.timing === timing && (t.level || 'ROW') === level)) {
      if (event === 'UPDATE' && trigger.updateColumns && columns && !trigger.updateColumns.some(n => columns.includes(n))) continue;
      const args = trigger.refs.map(r => (r.record === 'NEW' ? next : old)?.[r.column.name] ?? null);
      await procedures.esegui(client, db, trigger.name, { ...payload, [SESSION]: session, [FLOW]: flow,
        [ROUTINE]: { definition: trigger.routine, args, done(values, assigned) {
          for (const ref of trigger.refs.filter(r => r.assigned && assigned.has(r.name))) {
            changed[ref.column.name] = values[ref.name]; next[ref.column.name] = values[ref.name];
          }
        } } }, env);
    }
    return changed;
  }
  return { prima: collect, hasBefore: event => triggers.some(t => t.timing === 'BEFORE' && t.events.includes(event) && t.level === 'ROW'),
    statement: (timing, event, columns) => fire(timing, event, null, null, columns, 'STATEMENT'),
    async before(event, old, next, columns) {
      const changed = await fire('BEFORE', event, old, next, columns);
      if (old && next && key(next._id) !== key(old._id)) throw new Error('Il campo _id di MongoDB è immutabile.');
      return changed;
    },
    async beforeRaw(event, old, raw, columns) {
      const bson = require('./mongoBson');
      const next = require('bson').deserialize(raw, { promoteValues: false });
      const changed = await fire('BEFORE', event, old, next, columns);
      if (old && key(next._id) !== key(old._id)) throw new Error('Il campo _id di MongoDB è immutabile.');
      return bson.sostituisciCampi(raw, changed);
    },
    writeRaw: (raw, opts, replace) => require('./mongoBson').scriviRaw(database, coll, raw, opts, replace),
    async preview(collection, method, filter, value, old, opts) {
      const stage = database.collection(STAGE), bson = require('./mongoBson');
      const clean = { ...opts, projection: undefined, hint: undefined, sort: undefined, includeResultMetadata: undefined };
      if (old) {
        const raw = await collection.findOne({ _id: old._id }, { ...options, raw: true });
        await bson.scriviRaw(database, STAGE, raw, options);
      }
      const result = await stage[['replaceOne', 'findOneAndReplace'].includes(method) ? 'replaceOne' : 'updateOne'](filter, value, clean);
      const id = old ? old._id : result.upsertedCount ? result.upsertedId : undefined;
      if (id === undefined) return null;
      const raw = await stage.findOne({ _id: id }, { ...options, raw: true });
      await stage.deleteOne({ _id: id }, options);
      return raw;
    },
    async dopo(previous, ids = previous.map(d => d._id), columns) {
    const before = new Map(previous.map(d => [key(d._id), d]));
    const after = new Map((await collect({ _id: { $in: ids } })).map(d => [key(d._id), d]));
    for (const id of ids) {
      const old = before.get(key(id)), next = after.get(key(id));
      const event = !old ? 'INSERT' : !next ? 'DELETE' : 'UPDATE';
      await fire('AFTER', event, old, next, columns);
    }
  } };
}

// Mantiene filtri, sort, collation e risultati del driver. La preselezione è
// nella stessa transazione: anche un UPDATE senza modifiche genera l'evento.
function mutazioni(collection, triggers) {
  if (!triggers) return collection;
  const methods = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete']);
  return new Proxy(collection, { get(target, name) {
    if (name === 'bulkWrite') return async (operations, options) => {
      const totals = { acknowledged: true, insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0, insertedIds: {}, upsertedIds: {} };
      for (const [i, operation] of operations.entries()) {
        const [method, args] = Object.entries(operation)[0];
        if (!methods.has(method)) throw new Error(`Operazione bulk non valida: ${method}.`);
        const c = mutazioni(collection, triggers), opts = { ...options, ...args };
        delete opts.filter; delete opts.update; delete opts.replacement; delete opts.document;
        const result = method === 'insertOne' ? await c.insertOne(args.document, opts)
          : method.startsWith('delete') ? await c[method](args.filter, opts)
            : await c[method](args.filter, args.update ?? args.replacement, opts);
        for (const key of ['matchedCount', 'modifiedCount', 'deletedCount', 'upsertedCount']) totals[key] += result[key] || 0;
        if (method === 'insertOne') { totals.insertedCount++; totals.insertedIds[i] = result.insertedId; }
        if (result.upsertedCount) totals.upsertedIds[i] = result.upsertedId;
      }
      return totals;
    };
    if (!methods.has(name)) return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
    return async (...args) => {
      const insert = name.startsWith('insert'), remove = name.includes('Delete') || name.startsWith('delete');
      const returning = name === 'findOneAndUpdate' || name === 'findOneAndReplace';
      const columns = !insert && !remove ? colonneAggiornate(args[1]) : undefined;
      const options = args[insert || remove ? 1 : 2] || {};
      const event = insert ? 'INSERT' : remove ? 'DELETE' : 'UPDATE';
      await triggers.statement('BEFORE', event, columns);
      const execute = async () => {
      const previous = insert ? [] : await triggers.prima(args[0], { ...options, limit: name.endsWith('Many') ? 0 : 1 });
      if (insert && triggers.hasBefore('INSERT')) {
        const docs = name === 'insertOne' ? [args[0]] : args[0], insertedIds = {};
        for (const [i, doc] of docs.entries()) {
          await triggers.before('INSERT', null, doc);
          const r = await target.insertOne(doc, options); insertedIds[i] = r.insertedId;
          await triggers.dopo([], [r.insertedId]);
        }
        return name === 'insertOne' ? { acknowledged: true, insertedId: insertedIds[0] } : { acknowledged: true, insertedCount: docs.length, insertedIds };
      }
      if (remove && triggers.hasBefore('DELETE')) {
        let result, deletedCount = 0;
        for (const old of previous) {
          await triggers.before('DELETE', old, null);
          result = await target[name.includes('findOne') ? name : 'deleteOne']({ $and: [args[0], { _id: old._id }] }, options);
          deletedCount += result?.deletedCount || 0;
          await triggers.dopo([old]);
        }
        if (!previous.length && name === 'findOneAndDelete') return target[name](...args);
        return name === 'findOneAndDelete' ? result : { acknowledged: true, deletedCount };
      }
      if (!insert && !remove && (previous.length ? triggers.hasBefore('UPDATE') : options.upsert && triggers.hasBefore('INSERT'))) {
        let matchedCount = 0, modifiedCount = 0, upsertedCount = 0, upsertedId, value = null;
        const imageOptions = Object.fromEntries(['session', 'maxTimeMS', 'projection', 'let', 'comment']
          .filter(k => options[k] !== undefined).map(k => [k, options[k]]));
        for (const old of previous.length ? previous : [null]) {
          const filter = old ? { $and: [args[0], { _id: old._id }] } : args[0];
          if (returning && old && options.returnDocument !== 'after') value = await target.findOne({ _id: old._id }, imageOptions);
          // Il server calcola l'immagine proposta in una raccolta interna nella
          // stessa transazione; BEFORE legge ancora la tabella originale.
          let raw = await triggers.preview(target, name, filter, args[1], old, options);
          if (!raw) continue;
          raw = await triggers.beforeRaw(old ? 'UPDATE' : 'INSERT', old, raw, columns);
          const id = require('bson').deserialize(require('./mongoBson').inspect(raw).id, { promoteValues: false })._id;
          const r = await triggers.writeRaw(raw, options, !!old);
          if (old) { matchedCount += r.n; modifiedCount += r.nModified; } else { upsertedId = id; upsertedCount++; }
          if (returning && options.returnDocument === 'after') value = await target.findOne({ _id: id }, imageOptions);
          await triggers.dopo(old ? [old] : [], [id], columns);
        }
        if (returning) return options.includeResultMetadata
          ? { ok: 1, value, lastErrorObject: { n: 1, updatedExisting: !!previous.length, ...(upsertedCount ? { upserted: upsertedId } : {}) } } : value;
        return { acknowledged: true, matchedCount, modifiedCount, upsertedCount, upsertedId: upsertedId ?? null };
      }
      // Una selezione singola deve restare la stessa anche quando il driver
      // avrebbe scelto un altro piano per findOneAndUpdate/updateOne.
      if (!insert && !name.endsWith('Many') && previous.length) args[0] = { $and: [args[0], { _id: previous[0]._id }] };
      if (returning) args[2] = { ...options, includeResultMetadata: true };
      const result = await target[name](...args);
      const ids = insert ? (name === 'insertOne' ? [result.insertedId] : Object.values(result.insertedIds)) : previous.map(d => d._id);
      if (!insert && options.upsert && !previous.length) {
        if (result.upsertedCount) ids.push(result.upsertedId);
        else if (Object.hasOwn(result.lastErrorObject || {}, 'upserted')) ids.push(result.lastErrorObject.upserted);
      }
      await triggers.dopo(previous, ids, columns);
      return returning && !options.includeResultMetadata ? result.value : result;
      };
      const result = await execute();
      await triggers.statement('AFTER', event, columns);
      return result;
    };
  } });
}
// Le sostituzioni assegnano l'intera riga; gli operatori conservano i bersagli
// dichiarati, anche se il valore non cambia o un BEFORE modifica altri campi.
function colonneAggiornate(update) {
  if (!update || !Array.isArray(update) && !Object.keys(update).some(k => k.startsWith('$'))) return undefined;
  const fields = [];
  for (const stage of Array.isArray(update) ? update : [update]) for (const [op, value] of Object.entries(stage)) {
    if (['$replaceRoot', '$replaceWith', '$project'].includes(op)) return undefined;
    fields.push(...(typeof value === 'string' ? [value] : Array.isArray(value) ? value : Object.keys(value || {})));
    if (op === '$rename') fields.push(...Object.values(value));
  }
  return [...new Set(fields.map(n => n.split('.')[0]))];
}
module.exports = { riconosci, parse, compila, esegui: require('./sqlCastDomini').avvolgi(esegui, 3), prepara, mutazioni };
