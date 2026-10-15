'use strict';
const { randomUUID } = require('node:crypto');
const { EJSON } = require('bson');
const schemaApi = require('./sqlSchemaMongo');
const { leggiEspressione, emettiEspressione } = require('./sqlEspressioni');
const { ACCESS, SCHEMAS, MIGRATION } = require('./sqlMongoContesto');
const DbStrategy = require('./DbStrategy');
const word = p => String(p.peek()?.value || '').toUpperCase();
const eat = (p, s) => word(p) === s && !!p.next();
const expect = (p, s) => { if (!eat(p, s)) throw new Error(`ALTER TABLE: atteso ${s}.`); };
const JOURNAL = '_codedb_sql_migrations';

function frammento(p, coll) {
  const tokens = []; let depth = 0;
  while (!p.eof() && !(depth === 0 && p.isPunct(','))) {
    const t = p.next(); if (t.type === 'punct' && t.value === '(') depth++; if (t.type === 'punct' && t.value === ')') depth--; tokens.push(t);
  }
  const { Parser, tokenize } = require('./SqlToMql');
  return schemaApi.definizione(new Parser([...tokenize('('), ...tokens, ...tokenize(')')]), coll, true);
}
function parse(p) {
  expect(p, 'TABLE'); const coll = p.parseIdent(), actions = [];
  do {
    if (['ENABLE','DISABLE'].includes(word(p))) {
      const enabled=eat(p,'ENABLE'); if(!enabled) expect(p,'DISABLE'); expect(p,'TRIGGER');
      const name=['ALL','USER'].includes(word(p))?p.next().value:p.parseIdent(); actions.push({op:'triggerState',name,enabled});
    } else if (eat(p, 'ADD')) {
      eat(p, 'COLUMN'); const ifNotExists = eat(p, 'IF');
      if (ifNotExists) { expect(p, 'NOT'); expect(p, 'EXISTS'); }
      actions.push({ op: 'add', ifNotExists, definition: frammento(p, coll) });
    }
    else if (eat(p, 'DROP')) {
      if (eat(p, 'PRIMARY')) { expect(p, 'KEY'); actions.push({ op: 'dropPrimary' }); }
      else {
        const qualifier = word(p);
        const constraint = eat(p, 'CONSTRAINT') || eat(p, 'CHECK') || eat(p, 'INDEX') || eat(p, 'KEY') || (eat(p, 'FOREIGN') && (expect(p, 'KEY'), true));
        if (!constraint) eat(p, 'COLUMN');
        const ifExists = eat(p, 'IF'); if (ifExists) expect(p, 'EXISTS');
        const kinds = qualifier === 'CHECK' ? ['CHECK'] : qualifier === 'FOREIGN' ? ['FOREIGN'] : ['INDEX', 'KEY'].includes(qualifier) ? ['PRIMARY', 'UNIQUE'] : null;
        actions.push({ op: constraint ? 'dropConstraint' : 'drop', name: p.parseIdent(), ifExists, ...(constraint && kinds ? { kinds } : {}) });
        actions[actions.length - 1].cascade = eat(p, 'CASCADE'); eat(p, 'RESTRICT');
      }
    } else if (eat(p, 'RENAME')) {
      const op = eat(p, 'CONSTRAINT') ? 'renameConstraint' : eat(p, 'INDEX') || eat(p, 'KEY') ? 'renameIndex' : (expect(p, 'COLUMN'), 'rename');
      const name = p.parseIdent(); expect(p, 'TO'); actions.push({ op, name, to: p.parseIdent() });
    } else if (eat(p, 'ALTER')) {
      eat(p, 'COLUMN'); const name = p.parseIdent();
      if (eat(p, 'SET')) {
        if (eat(p, 'DEFAULT')) actions.push({ op: 'default', name, expr: leggiEspressione(p) });
        else if (eat(p, 'DATA')) {
          expect(p, 'TYPE'); const type = schemaApi.tipo(p);
          actions.push({ op: 'type', name, ...type, using: eat(p, 'USING') ? leggiEspressione(p) : null });
        }
        else { expect(p, 'NOT'); expect(p, 'NULL'); actions.push({ op: 'nullable', name, value: false }); }
      } else if (eat(p, 'DROP')) {
        if (eat(p, 'DEFAULT')) actions.push({ op: 'default', name });
        else { expect(p, 'NOT'); expect(p, 'NULL'); actions.push({ op: 'nullable', name, value: true }); }
      } else {
        expect(p, 'TYPE'); const type = schemaApi.tipo(p);
        actions.push({ op: 'type', name, ...type, using: eat(p, 'USING') ? leggiEspressione(p) : null });
      }
    } else if (eat(p, 'MODIFY')) {
      eat(p, 'COLUMN'); actions.push({ op: 'modify', definition: frammento(p, coll) });
    } else if (eat(p, 'CHANGE')) {
      eat(p, 'COLUMN'); const name = p.parseIdent(); actions.push({ op: 'change', name, definition: frammento(p, coll) });
    } else throw new Error(`Clausola ALTER TABLE non tradotta: ${p.peek()?.value}.`);
  } while (p.eatPunct(','));
  return { kind: 'ddl', op: 'alterTable', coll, actions };
}

function visita(expr, fn) {
  if (!expr || typeof expr !== 'object') return;
  if (expr.tipo === 'colonna') fn(expr);
  else for (const value of Object.values(expr)) visita(value, fn);
}
function riferisce(constraint, name) {
  let found = constraint.columns?.includes(name);
  visita(constraint.expr, e => { if (e.nome === name) found = true; });
  return found;
}
function prepara(old, plan) {
  const schema = EJSON.parse(EJSON.stringify(old), { relaxed: true }), pipeline = [], changed = new Set(), jsonFields = [];
  const column = name => { const c = schema.columns.find(c => c.name === name); if (!c) throw new Error(`Colonna SQL sconosciuta: ${name}.`); return c; };
  function rename(name, to) {
    if (name === '_id' || to === '_id') throw new Error('La chiave nativa _id non può essere rinominata.');
    if (schema.columns.some(c => c.name === to) || !to || to.includes('.') || to.startsWith('$') || to === '__proto__') throw new Error('Nome di colonna SQL duplicato o non valido.');
    column(name).name = to; changed.add(name);
    for (const c of schema.constraints) {
      if (c.columns) c.columns = c.columns.map(n => n === name ? to : n);
      if (c.references?.coll === plan.coll) c.references.columns = c.references.columns?.map(n => n === name ? to : n);
      visita(c.expr, e => { if (e.nome === name) e.nome = to; });
    }
    pipeline.push({ $set: { [to]: `$${name}` } }, { $unset: name });
  }
  for (const a of plan.actions) {
    if(a.op==='triggerState') continue;
    if (a.op === 'add') {
      if (a.ifNotExists) {
        if (a.definition.columns.length !== 1) throw new Error('ADD IF NOT EXISTS richiede una singola colonna.');
        if (schema.columns.some(c => c.name === a.definition.columns[0].name)) continue;
      }
      schema.columns.push(...a.definition.columns); schema.constraints.push(...a.definition.constraints);
      for (const c of a.definition.columns) { pipeline.push(schemaApi.conversioni({ columns: [c] }, true)); if (c.type === 'JSON') jsonFields.push(c.name); }
    } else if (a.op === 'drop') {
      if (!schema.columns.some(c => c.name === a.name) && a.ifExists) continue;
      column(a.name); if (a.name === '_id') throw new Error('La chiave nativa _id non può essere eliminata.');
      for (const fk of schema.constraints.filter(c => c.references?.coll === plan.coll && c.references.columns?.includes(a.name) && !c.columns.includes(a.name))) {
        if (!a.cascade) throw new Error(`ALTER TABLE impedito dalla FOREIGN KEY ${fk.name}: usa CASCADE.`);
        schema.constraints = schema.constraints.filter(c => c !== fk);
      }
      schema.columns = schema.columns.filter(c => c.name !== a.name);
      schema.constraints = schema.constraints.filter(c => !riferisce(c, a.name));
      changed.add(a.name); pipeline.push({ $unset: a.name });
    } else if (a.op === 'rename') rename(a.name, a.to);
    else if (a.op === 'renameConstraint' || a.op === 'renameIndex') {
      const c = schema.constraints.find(c => c.name === a.name && (a.op === 'renameConstraint' || ['PRIMARY', 'UNIQUE'].includes(c.kind)));
      if (!c && a.op === 'renameConstraint') throw new Error(`Vincolo SQL inesistente: ${a.name}.`);
      if (c) c.name = a.to;
    }
    else if (a.op === 'dropConstraint' || a.op === 'dropPrimary') {
      const c = schema.constraints.find(c => a.op === 'dropPrimary' ? c.kind === 'PRIMARY' : c.name === a.name && (!a.kinds || a.kinds.includes(c.kind)));
      if (!c && !a.ifExists) throw new Error(`Vincolo SQL inesistente: ${a.name || 'PRIMARY KEY'}.`);
      schema.constraints = schema.constraints.filter(v => v !== c);
    } else if (a.op === 'default') {
      const c = column(a.name);
      if (a.expr) { emettiEspressione(a.expr, () => { throw new Error('DEFAULT non può riferirsi a colonne.'); }); c.default = a.expr; }
      else delete c.default;
      if (c.domainDeclared) { delete c.domainDeclared.default; if (a.expr) c.domainDeclared.default = a.expr; }
    } else if (a.op === 'nullable') {
      if (a.value && schema.constraints.some(c => c.kind === 'PRIMARY' && c.columns.includes(a.name))) throw new Error('La chiave primaria richiede NOT NULL.');
      column(a.name).nullable = a.value;
      if (column(a.name).domainDeclared) column(a.name).domainDeclared.nullable = a.value;
    } else {
      let c;
      if (a.op === 'type') {
        c = column(a.name);
        const fields = ['type','args','unsigned','array','domain','domainDeclared','domainChain','domainChecks','elementDomain','elementDomainNotNull'];
        for (const key of fields) { delete c[key]; if (Object.hasOwn(a, key)) c[key] = a[key]; }
        if (a.domain && a.nullable === false) c.nullable = false;
        if (a.using) pipeline.push({ $set: { [c.name]: emettiEspressione(a.using, name => { column(name); return name; }) } });
      } else {
        if (a.definition.columns.length !== 1 || a.definition.constraints.length) throw new Error('MODIFY/CHANGE richiede una colonna; usa ADD CONSTRAINT per i vincoli.');
        const definition = a.definition.columns[0], name = a.op === 'change' ? a.name : definition.name;
        c = column(name); if (name !== definition.name) rename(name, definition.name);
        for (const key of ['default','unsigned','array','domain','domainDeclared','domainChain','domainChecks','elementDomain','elementDomainNotNull']) delete c[key];
        Object.assign(c, definition);
      }
      changed.add(a.name || c.name); pipeline.push(schemaApi.conversioni({ columns: [c] }));
      if (c.type === 'JSON') jsonFields.push(c.name);
    }
  }
  schemaApi.verifica(schema, plan.coll);
  return { schema, pipeline, changed, jsonFields };
}

function indice(i) { const { v, ns, background, ...spec } = i; return spec; }
const same = (a, b) => EJSON.stringify(a) === EJSON.stringify(b);
async function allineaIndici(collection, desired, names) {
  const existing = (await collection.listIndexes().toArray()).map(indice);
  for (const name of names) {
    const old = existing.find(i => i.name === name), next = desired.find(i => i.name === name);
    if (old && (!next || !same(old, next))) await collection.dropIndex(name);
  }
  // MongoDB non accetta due nomi per la stessa specifica: durante il recupero
  // di una rinomina va rimosso il nuovo nome prima di ricreare quello vecchio.
  for (const name of names) {
    const old = existing.find(i => i.name === name), next = desired.find(i => i.name === name);
    if (next && (!old || !same(old, next))) await collection.createIndexes([next], { commitQuorum: 'majority' });
  }
}

async function recupera(database, session, access) {
  const catalog = database.collection(JOURNAL), job = await catalog.findOne({ coll: { $exists: true } }, { session });
  if (!job) return;
  if (!access) throw new Error('Manca il controllo dei permessi della migrazione SQL.');
  access('ddl', job.coll);
  const forward = !!await catalog.findOne({ _id: `${job._id}:commit` }, { session });
  for (const dependency of job.dependencies || []) access('ddl', dependency.coll);
  for (const item of [job, ...(job.dependencies || [])]) if (item.indexNames) await allineaIndici(database.collection(item.coll), forward ? item.newIndexes : item.oldIndexes, item.indexNames);
  for (const item of [job, ...(job.dependencies || [])]) await database.command({ collMod: item.coll, validator: forward ? item.newValidator : item.oldValidator,
    validationLevel: 'strict', validationAction: 'error' });
  await catalog.deleteMany({ _id: { $in: [job._id, `${job._id}:commit`] } }, { session });
  return { sql: job.sql, committed: forward };
}

async function esegui(client, db, coll, plan, payload, env) {
  payload[ACCESS]?.('ddl', coll);
  const database = client.db(db), refsApi = require('./sqlVincoliReferenziali');
  const hello = await database.command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('ALTER TABLE con migrazione richiede un replica set MongoDB.');
  const ctx = require('./MongoSqlRuntime').contesto(env, payload);
  await refsApi.inizializzaBlocco(database);
  // Il registro deve esistere prima della transazione e delle DDL native.
  try { await database.createCollection(JOURNAL); } catch (err) { if (err.code !== 48) throw err; }
  const session = client.startSession(), options = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
  const fenced = fn => session.withTransaction(async () => { await refsApi.blocca(database, { session }, true); return fn(); }, options);
  let job, migration;
  try {
    const recovered = await fenced(() => recupera(database, session, payload[ACCESS]));
    if (recovered?.committed && recovered.sql === payload.sql) return;
    await fenced(async () => {
      if (!job) {
        await recupera(database, session, payload[ACCESS]);
        const info = await database.listCollections({ name: coll }).next(), old = schemaApi.daInfo(info);
        if (!old) throw new Error('ALTER TABLE richiede una tabella creata con schema SQL.');
        for (const action of plan.actions) {
          if (action.definition) await require('./sqlDominiMongo').risolvi(database, action.definition, new Map(), { session });
          if (action.op === 'type' && action.domain) {
            const previous = old.columns.find(c => c.name === action.name);
            const typed = { columns: [{ ...action, nullable: previous?.nullable, ...(previous?.default ? { default: previous.default } : {}) }] };
            await require('./sqlDominiMongo').risolvi(database, typed, new Map(), { session }); Object.assign(action, typed.columns[0]);
          }
        }
        migration = prepara(old, plan);
        const { schema, changed } = migration;
        const domains = require('./sqlDominiMongo');
        const overrides = new Map(plan.domainChange ? [[plan.domainChange.name, plan.domainChange.definition]] : []);
        if (plan.domainChange) {
          const current = await database.collection('_codedb_sql_domains').findOne({ _id: plan.domainChange.name }, { session });
          if (!same(current?.definition, plan.domainChange.previous)) throw new Error('Dominio modificato contemporaneamente: ripeti ALTER DOMAIN.');
        }
        await domains.risolvi(database, schema, overrides, { session });
        const infos = await database.listCollections().toArray();
        const dependencies = [], schemas = new Map([[coll, schema]]);
        for (const info of infos.filter(i => i.name !== coll)) {
          const dependent = schemaApi.daInfo(info); if (!dependent) continue;
          const original = EJSON.stringify(dependent);
          if (plan.domainChange) await domains.risolvi(database, dependent, overrides, { session });
          for (const fk of [...dependent.constraints].filter(c => c.kind === 'FOREIGN' && c.references.coll === coll)) {
            for (const a of plan.actions) {
              const to = a.op === 'rename' ? a.to : a.op === 'change' ? a.definition.columns[0].name : null;
              if (to) fk.references.columns = fk.references.columns.map(n => n === a.name ? to : n);
            }
            if (!schema.constraints.some(c => ['PRIMARY', 'UNIQUE'].includes(c.kind) && same(c.columns, fk.references.columns))) {
              const cascade = plan.actions.some(a => a.cascade && (a.op === 'drop' ? fk.references.columns.includes(a.name)
                : a.op === 'dropConstraint' && old.constraints.some(c => c.name === a.name && same(c.columns, fk.references.columns))));
              if (!cascade) throw new Error(`ALTER TABLE impedito dalla FOREIGN KEY ${fk.name} su ${info.name}: usa CASCADE per eliminare il vincolo dipendente.`);
              dependent.constraints = dependent.constraints.filter(c => c !== fk);
            }
          }
          schemas.set(info.name, dependent);
          const newValidator = schemaApi.validatore(dependent);
          if (EJSON.stringify(dependent) !== original || plan.domainChange && !same(newValidator, info.options.validator)) {
            payload[ACCESS]('ddl', info.name);
            dependencies.push({ coll: info.name, oldValidator: info.options.validator, newValidator });
          }
        }
        for (const [name, definition] of schemas) for (const fk of definition.constraints.filter(c => c.kind === 'FOREIGN' && (name === coll || c.references.coll === coll))) {
          payload[ACCESS]?.('read', fk.references.coll);
          await schemaApi.riferimenti(database, name, { ...definition, constraints: [fk] }, schemas);
        }
        migration.schemas = schemas;
        migration.triggers = await require('./sqlDipendenzeMongo').trigger(database, plan, schema);
        migration.routines = await require('./sqlDipendenzeRoutine').alter(database, plan, payload);
        await schemaApi.verificaDefault(database, schema);
        const oldIndexes = (await database.collection(coll).listIndexes().toArray()).map(indice).filter(i => i.name !== '_id_');
        const sqlNames = new Set(old.constraints.filter(c => ['PRIMARY', 'UNIQUE'].includes(c.kind)).map(c => c.name));
        const customIndexes = oldIndexes.filter(i => !sqlNames.has(i.name)).map(i => EJSON.parse(EJSON.stringify(i)))
          .map(i => require('./sqlDipendenzeMongo').indice(i, plan)).filter(Boolean);
        const indexNamesInUse = new Set(oldIndexes.map(i => i.name));
        for (const a of plan.actions.filter(a => ['renameIndex', 'renameConstraint'].includes(a.op))) {
          if (a.op === 'renameConstraint' && !sqlNames.has(a.name)) continue;
          if (a.to === '_id_' || (a.name !== a.to && indexNamesInUse.has(a.to))) throw new Error(`Nome di indice SQL già utilizzato: ${a.to}.`);
          if (a.op === 'renameIndex' && !indexNamesInUse.has(a.name)) throw new Error(`Indice SQL inesistente: ${a.name}.`);
          const index = customIndexes.find(i => i.name === a.name);
          if (index && a.op === 'renameIndex') index.name = a.to;
          if (indexNamesInUse.delete(a.name)) indexNamesInUse.add(a.to);
          if (sqlNames.delete(a.name)) sqlNames.add(a.to);
        }
        const newIndexes = [...customIndexes, ...schemaApi.indici(schema)];
        const indexNames = [...new Set([...oldIndexes, ...newIndexes].map(i => i.name))].filter(n => !same(oldIndexes.find(i => i.name === n), newIndexes.find(i => i.name === n)));
        job = { _id: randomUUID(), coll, sql: payload.sql, phase: 'prepared', oldValidator: info.options.validator, newValidator: schemaApi.validatore(schema), oldIndexes, newIndexes, indexNames, dependencies };
        await database.collection(JOURNAL).insertOne(job);
        // Il validatore funge da barriera anche per gli altri client: soltanto
        // le sostituzioni interne della migrazione usano bypassDocumentValidation.
        for (const item of [job, ...dependencies]) {
          const oldParts = item.oldValidator.$and || [item.oldValidator];
          await database.command({ collMod: item.coll, validator: { $and: [...oldParts, { $expr: { $eq: [1, 0] } }] }, validationLevel: 'strict', validationAction: 'error' });
        }
        const bridge = newIndexes.map(i => {
          if (!indexNames.includes(i.name) || i.partialFilterExpression || !i.unique) return i;
          return { ...i, partialFilterExpression: { $and: Object.keys(i.key).map(n => ({ [n]: { $type: schemaApi.bsonTypes(schema.columns.find(c => c.name === n)) } })) } };
        });
        await allineaIndici(database.collection(coll), bridge, indexNames);
      }
      const op = ctx.opzioni(session), cap = DbStrategy.resultCap(payload), budget = DbStrategy.maxResultBytes(env);
      const cursor = database.collection(coll).aggregate(migration.pipeline.length ? migration.pipeline : [{ $match: {} }], op);
      let collected;
      try { collected = await DbStrategy.collectCapped(cursor, cap, budget); } finally { await cursor.close(); }
      if (collected.truncated) throw new Error('Migrazione SQL oltre il limite di righe o byte.');
      const rows = collected.docs;
      for (const dependency of job.dependencies || []) {
        const cursor = database.collection(dependency.coll).find({}, op);
        let result;
        try { result = await DbStrategy.collectCapped(cursor, cap, budget); } finally { await cursor.close(); }
        if (result.truncated) throw new Error('Verifica dei dati dipendenti oltre il limite di righe o byte.');
        for (const row of result.docs) {
          const valid = database.aggregate([{ $documents: { $literal: [row] } }, { $match: schemaApi.validatore(migration.schemas.get(dependency.coll), true) }], op);
          try { if (!await valid.hasNext()) throw new Error(`I dati esistenti di ${dependency.coll} violano il nuovo schema SQL.`); } finally { await valid.close(); }
        }
      }
      const converted=new Set(plan.actions.flatMap(a=>a.op==='type'?[a.name]:['add','modify','change'].includes(a.op)?a.definition.columns.map(c=>c.name):[]));
      const rowValidator=schemaApi.validatore(migration.schema,new Set(migration.schema.columns.filter(c=>!converted.has(c.name)).map(c=>c.name)));
      for (const row of rows) {
        ctx.verifica(); schemaApi.normalizzaJson(migration.schema, row, migration.jsonFields);
        const validation = database.aggregate([{ $documents: { $literal: [row] } }, { $match: rowValidator }], op);
        try { if (!await validation.hasNext()) throw new Error('I dati esistenti violano il nuovo schema SQL.'); } finally { await validation.close(); }
        if (migration.pipeline.length) await database.collection(coll).replaceOne({ _id: row._id }, row, { ...op, bypassDocumentValidation: true });
      }
      for (const trigger of migration.triggers) {
        if (trigger.remove) await database.collection('_codedb_sql_triggers').deleteOne({ _id: trigger._id }, op);
        else await database.collection('_codedb_sql_triggers').updateOne({ _id: trigger._id }, { $set: { sql: trigger.sql, ...(trigger.enabled === undefined ? {} : { enabled: trigger.enabled }) } }, op);
      }
      for (const routine of migration.routines) {
        if (routine.remove) await database.collection('_codedb_sql_procedures').deleteOne({ _id: routine._id }, op);
        else await database.collection('_codedb_sql_procedures').updateOne({ _id: routine._id }, { $set: { sql: routine.sql }, $unset: { dependencies: '' } }, op);
      }
      if (plan.domainChange) await database.collection('_codedb_sql_domains').updateOne({ _id: plan.domainChange.name }, { $set: { definition: plan.domainChange.definition } }, op);
      const refs = await refsApi.prepara(database, coll, { ...payload, sql: undefined, [SCHEMAS]: migration.schemas, [MIGRATION]: true }, env, ctx);
      if (refs) await refs.dopo([], op);
      await database.collection(JOURNAL).insertOne({ _id: `${job._id}:commit` }, op);
      ctx.verifica();
    });
  } catch (err) {
    try {
      const recovered = await fenced(() => recupera(database, session, payload[ACCESS]));
      if (recovered?.committed && recovered.sql === payload.sql) return;
    }
    catch (recovery) { throw new Error(`${err.message} Recupero della migrazione da completare ripetendo ALTER TABLE: ${recovery.message}`, { cause: err }); }
    throw err;
  } finally { await session.endSession(); }
  const finish = client.startSession();
  try {
    await finish.withTransaction(async () => { await refsApi.blocca(database, { session: finish }, true); await recupera(database, finish, payload[ACCESS]); }, options);
  } finally { await finish.endSession(); }
}

module.exports = { parse, prepara, esegui, recupera, allineaIndici, indice };
