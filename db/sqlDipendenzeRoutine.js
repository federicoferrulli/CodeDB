'use strict';
const procedures = require('./sqlProcedureMongo');
const schemaApi = require('./sqlSchemaMongo');
const { ACCESS } = require('./sqlMongoContesto');
const CATALOG = '_codedb_sql_procedures';
// Un documento alterato da un client nativo non diventa una routine valida e
// non deve impedire DDL su oggetti estranei. CALL continua a rifiutarlo.
function definizione(doc) { try { return procedures.parse(doc.sql); } catch { return null; } }
function statements(nodes) {
  return nodes.flatMap(n => [ ...(n.tokens ? [n] : []), ...statements(n.then || []), ...statements(n.else || []), ...(n.handlers || []).flatMap(h => statements(h.then)) ]);
}
async function analizza(database, plan) {
  const tables = new Map(), calls = new Set(), opaque = new Set();
  if (!plan.bound) return { tables: [], calls: [], opaque: [] };
  const schemas = new Map((await database.listCollections().toArray()).map(i => [i.name, schemaApi.daInfo(i)]));
  for (const node of statements(plan.body)) {
    const text = procedures.bind(node.tokens, Object.fromEntries(plan.variables.map(n => [n, 0]))), compiled = procedures.compila(text);
    if (compiled.kind === 'call') { calls.add(compiled.name); continue; }
    const referenced = new Set();
    function sources(value) {
      if (!value || typeof value !== 'object' || value._bsontype) return;
      if (value.coll) referenced.add(value.coll);
      if (value.$lookup?.from) referenced.add(value.$lookup.from);
      for (const [key, child] of Object.entries(value)) if (!['docs', 'values', '$literal'].includes(key)) sources(child);
    }
    sources(compiled);
    if (node.tokens.some(t => t.value === 'WITH') || node.tokens.filter(t => t.value === 'SELECT').length > 1 || node.tokens.some((t, i) => t.value === 'FROM' && node.tokens[i + 1]?.value === '(')) {
      for(const dependency of require('./sqlScopeRoutine').analizza(node.tokens,schemas,plan.variables)) {
        if(!tables.has(dependency.name))tables.set(dependency.name,new Set());
        for(const column of dependency.columns)tables.get(dependency.name).add(column);
      }
      continue;
    }
    for (const name of referenced) { if (!schemas.get(name)) throw new Error(`La routine BEGIN ATOMIC richiede uno schema SQL per ${name}.`); if (!tables.has(name)) tables.set(name, new Set()); }
    const tokens = node.tokens, skip = new Set(), aliases = new Map([...referenced].map(n => [n, n]));
    for (let i = 0; i < tokens.length; i++) {
      if (!['FROM', 'JOIN', 'UPDATE', 'INTO', 'USING'].includes(String(tokens[i].value).toUpperCase()) || !referenced.has(tokens[i + 1]?.value)) continue;
      const name = tokens[i + 1].value; skip.add(i + 1);
      let at = i + 2; if (tokens[at]?.value === 'AS') at++;
      if (tokens[at]?.type === 'ident' && !['SET', 'VALUES', 'RETURNING'].includes(tokens[at].value.toUpperCase())) { aliases.set(tokens[at].value, name); skip.add(at); }
    }
    const target = compiled.coll;
    const selectAt = tokens.findIndex(t => t.value === 'SELECT');
    const allColumns = tokens.some((t, i) => t.value === '*' && ['SELECT', ','].includes(tokens[i - 1]?.value))
      || compiled.values || compiled.expressionRows && !compiled.insertColumns || compiled.implicitColumns;
    if (allColumns) for (const name of referenced) for (const c of schemas.get(name).columns) tables.get(name).add(c.name);
    for (const [i, token] of tokens.entries()) {
      if (token.type !== 'ident' || skip.has(i) || plan.variables.includes(token.value) || tokens[i - 1]?.value === 'AS' || tokens[i + 1]?.value === '(') continue;
      const dot = token.value.lastIndexOf('.'), prefix = dot < 0 ? '' : token.value.slice(0, dot), column = token.value.slice(dot + 1);
      const table = prefix ? aliases.get(prefix) : compiled.source && i > selectAt ? compiled.source.coll : target;
      if (schemas.get(table)?.columns.some(c => c.name === column)) {
        tables.get(table)?.add(column); token.sqlColumn = { table, column, prefix };
      }
    }
  }
  return { tables: [...tables].map(([name, columns]) => ({ name, columns: [...columns] })), calls: [...calls], opaque: [...opaque] };
}
async function dependenti(database, roots, options = {}) {
  const docs = await database.collection(CATALOG).find({}, options).toArray(), removed = new Set(roots);
  let changed;
  do { changed = false; for (const doc of docs) {
    if (removed.has(doc._id)) continue;
    const routine = definizione(doc); if (!routine) continue;
    const deps = await analizza(database, routine);
    if (deps.calls.some(name => removed.has(name))) { removed.add(doc._id); changed = true; }
  } } while (changed);
  return [...removed];
}
async function modifica(client, db, plan, payload) {
  const database = client.db(db), refs = require('./sqlVincoliReferenziali'), catalog = database.collection(CATALOG);
  await refs.inizializzaBlocco(database);
  try { await database.createCollection(CATALOG); } catch (error) { if (error.code !== 48) throw error; }
  const session = client.startSession();
  try { await session.withTransaction(async () => {
    await refs.blocca(database, { session });
    if (plan.op === 'create') {
      await require('./sqlDominiMongo').risolvi(database, { columns: plan.params.map(c => ({ ...c, nullable: true })) }, new Map(), { session });
      const dependencies = await analizza(database, plan);
      for (const call of dependencies.calls) if (call !== plan.name && !await catalog.findOne({ _id: call }, { session })) throw new Error(`Procedura dipendente inesistente: ${call}.`);
      const doc = { _id: plan.name, sql: payload.sql, dependencies };
      if (plan.replace) {
        const old = await catalog.findOne({ _id: plan.name }, { session });
        if (old && JSON.stringify(procedures.parse(old.sql).params) !== JSON.stringify(plan.params)) throw new Error('CREATE OR REPLACE non può cambiare la firma della procedura.');
        await catalog.replaceOne({ _id: plan.name }, doc, { session, upsert: true });
      } else await catalog.insertOne(doc, { session });
    } else {
      const remove = await dependenti(database, [plan.name], { session });
      if (remove.length > 1 && !plan.cascade) throw new Error(`DROP PROCEDURE impedito dalla dipendenza ${remove.find(n => n !== plan.name)}: usa CASCADE.`);
      for (const name of remove) payload[ACCESS]('ddl', name);
      const result = await catalog.deleteMany({ _id: { $in: remove } }, { session });
      if (!result.deletedCount && !plan.ifExists) throw new Error(`Procedura ${plan.name} inesistente.`);
    }
  }, { writeConcern: { w: 'majority' } }); } finally { await session.endSession(); }
}
async function alter(database, plan, payload) {
  const result = [], removed = new Set();
  for (const doc of await database.collection(CATALOG).find({}).toArray()) {
    const routine = definizione(doc); if (!routine) continue;
    const deps = await analizza(database, routine);
    const dependency = deps.tables.find(t => t.name === plan.coll); if (!dependency) continue;
    if (deps.opaque.includes(plan.coll) && plan.actions.some(a => ['drop','rename','type','modify','change'].includes(a.op))) throw new Error(`La dipendenza della procedura ${doc._id} contiene scope SQL annidati: occorre ricreare la routine per modificare le colonne senza riferimenti ambigui.`);
    let changed = false;
    for (const a of plan.actions) {
      const name = a.name || a.definition?.columns[0]?.name;
      if (!dependency.columns.includes(name)) continue;
      if (['type', 'modify', 'change'].includes(a.op)) throw new Error(`ALTER TYPE impedito dalla dipendenza della procedura ${doc._id}.`);
      if (a.op === 'drop') {
        if (!a.cascade) throw new Error(`ALTER TABLE impedito dalla dipendenza della procedura ${doc._id}: usa CASCADE.`);
        removed.add(doc._id);
      }
      if (a.op === 'rename') {
        changed=require('./sqlScopeRoutine').rinomina(routine.sourceTokens,plan.coll,a.name,a.to)||changed;
      }
    }
    if (changed) { payload[ACCESS]('ddl', doc._id); result.push({ _id: doc._id, sql: procedures.bind(routine.sourceTokens, {}) }); }
  }
  for (const name of removed.size ? await dependenti(database, [...removed]) : []) { payload[ACCESS]('ddl', name); result.push({ _id: name, remove: true }); }
  return result;
}
module.exports = { analizza, dependenti, modifica, alter, definizione };
