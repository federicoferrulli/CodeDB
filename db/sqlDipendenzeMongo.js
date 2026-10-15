'use strict';
const sql = require('./SqlToMql');
const procedures = require('./sqlProcedureMongo');

function indice(index, plan) {
  const path = (value, from, to) => value === from ? to : value.startsWith(from + '.') ? to + value.slice(from.length) : value;
  function rename(object, from, to) {
    if (Array.isArray(object)) return object.map(v => rename(v, from, to));
    if (!object || typeof object !== 'object' || object._bsontype || object instanceof Date) return object;
    return Object.fromEntries(Object.entries(object).map(([k, v]) => [k.startsWith('$') ? k : path(k, from, to), rename(v, from, to)]));
  }
  function refers(object, column) {
    if (!object || typeof object !== 'object' || object._bsontype) return false;
    return Object.entries(object).some(([key, value]) => path(key, column, '') !== key || refers(value, column));
  }
  for (const a of plan.actions) {
    if (a.op === 'drop' && ['key', 'weights', 'partialFilterExpression', 'wildcardProjection'].some(k => refers(index[k], a.name))) return null;
    const to = a.op === 'rename' ? a.to : a.op === 'change' ? a.definition.columns[0].name : null;
    if (!to) continue;
    for (const key of ['key', 'weights', 'partialFilterExpression', 'wildcardProjection']) if (index[key]) index[key] = rename(index[key], a.name, to);
  }
  return index;
}

async function trigger(database, plan, schema) {
  const api = require('./sqlTriggerMongo'), output = [];
  const docs=await database.collection('_codedb_sql_triggers').find({ coll: plan.coll }).toArray();
  if(plan.actions.some(a=>a.op==='triggerState'&&a.name==='ALL')) {
    const related=(await database.listCollections().toArray()).some(i=>require('./sqlSchemaMongo').daInfo(i)?.constraints.some(c=>c.kind==='FOREIGN'&&(i.name===plan.coll||c.references.coll===plan.coll)));
    if(related)throw new Error('ALL include anche i trigger interni delle FOREIGN KEY in PostgreSQL. Usa USER o il nome del trigger: la sospensione dei vincoli referenziali non è ancora implementata.');
  }
  for(const a of plan.actions.filter(a=>a.op==='triggerState')) if(!['ALL','USER'].includes(a.name) && !docs.some(d=>d._id===a.name)) throw new Error(`Trigger SQL inesistente: ${a.name}.`);
  for (const doc of docs) {
    const definition = api.parse(doc.sql), tokens = sql.tokenize(doc.sql);
    let remove = false, changed = false, enabled=doc.enabled;
    for (const a of plan.actions) {
      if(a.op==='triggerState' && (['ALL','USER'].includes(a.name) || a.name===doc._id)) {enabled=a.enabled;changed=true;}
      const to = a.op === 'rename' ? a.to : a.op === 'change' ? a.definition.columns[0].name : null;
      const refs = tokens.filter(t => t.type === 'ident' && /^(OLD|NEW)\./i.test(t.value) && t.value.slice(4) === a.name);
      const columns = definition.updateColumns?.includes(a.name);
      if (a.op === 'drop' && (refs.length || columns)) {
        if (!a.cascade) throw new Error(`ALTER TABLE impedito dal trigger ${doc._id}: usa CASCADE per eliminarlo.`);
        remove = true;
      }
      if (to) {
        for (const t of refs) { t.value = t.value.slice(0, 4) + to; changed = true; }
        // UPDATE OF contiene nomi di colonne prima della tabella, senza OLD/NEW.
        if (columns) {
          const on = tokens.findIndex(t => t.value === 'ON');
          for (const t of tokens.slice(0, on)) if (t.type === 'ident' && t.value === a.name) t.value = to;
          changed = true;
        }
      }
    }
    if (remove) { output.push({ _id: doc._id, remove: true }); continue; }
    const source = changed ? procedures.bind(tokens, {}) : doc.sql;
    api.compila(api.parse(source), schema);
    if (changed) output.push({ _id: doc._id, sql: source, enabled });
  }
  return output;
}
module.exports = { indice, trigger };
