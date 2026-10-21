'use strict';
const assert = require('node:assert/strict');
const mutant = process.argv.find(v => v.startsWith('--mutant='))?.split('=')[1];
const variants = {
  "array_bounds": [
    "sqlArrayValore.js",
    "field('$$arrayValue', 'lower')",
    "{ $map: { input: field('$$arrayValue', 'lower'), as: 'd', in: 1 } }"
  ],
  "array_slice": [
    "sqlArrayIndici.js",
    "const slicing = items.some(i => i.slice);",
    "const slicing = false;"
  ],
  "array_write": [
    "sqlArrayAssegnazione.js",
    "at('$$source',offset(coords,'$$lo','$$selection'))",
    "at('$$source',0)"
  ],
  "array_native": [
    "sqlSchemaMongo.js",
    "{ $eq: [v, av.impacchetta(data, lower)] }",
    "true"
  ],
  "multirange_merge": [
    "sqlMultirangeMongo.js",
    "[envelope('$$last','$$this')]",
    "['$$last']"
  ],
  "multirange_difference": [
    "sqlMultirangeMongo.js",
    "{ $not:['$$intersection.upperInc'] }",
    "'$$intersection.upperInc'"
  ],
  "domain_not_valid": [
    "sqlSchemaMongo.js",
    "constraint.validated !== false",
    "true"
  ],
  "domain_validate": [
    "sqlDominiMongo.js",
    "{validated:true}",
    "{validated:false}"
  ],
  "domain_conversion": [
    "sqlAlterMongo.js",
    "!converted.has(c.name)",
    "true"
  ],
  "trigger_state": [
    "sqlTriggerMongo.js",
    "docs.filter(doc => doc.enabled !== false)",
    "docs"
  ],
  "nested_scope": [
    "sqlScopeRoutine.js",
    "dependencies.get(origin.table).add(origin.column)",
    "void 0"
  ],
  "nested_alias": [
    "sqlScopeRoutine.js",
    "if(t.sqlOutputName)",
    "if(false)"
  ],
  "native_probe": [
    "sqlSavepointMongo.js",
    "native.necessario(row,allIndexes)",
    "false"
  ],
  sort_sql: ['sqlOrdinamentoMongo.js', 'const chiave = value => ({ valore: valore(value) });', 'const chiave = value => value;'],
  range_aggregate: ['sqlMultirangeMongo.js', "{ $concatArrays: ['$$value', list('$$this')] }", "list('$$this')"],
  range_intersection: ['sqlMultirangeMongo.js', "algebra('*', '$$value', '$$this')", "algebra('+', '$$value', '$$this')"],
  array_text: ['sqlArrayTesto.js', "initialValue: root, in: step", "initialValue: root, in: '$$value'"],
  array_text_output: ['sqlValoreTesto.js', "av.tag('$$textInput')", 'false'],
  cast_domain: ['sqlCastDomini.js', "for (const c of column.domainChecks || [])", 'for (const c of [])'],
  cast_domain_array: ['sqlCastDomini.js', "column.elementDomainNotNull ?", 'false ?'],
  cascade_domain: ['sqlDropDominio.js', 'if (t.pipeline.length) await', 'if (false) await'],
  cascade_types: ['sqlDipendenzeTipi.js', "word === 'AS' && stack.at(-1) === 'CAST'", 'false'],
  domain_recompile: ['sqlDominiMongo.js', "await require('./sqlCastDomini').aggiorna(database, plan.coll, definition);", 'void 0;'],
  trigger_rename: ['sqlTriggerMongo.js', "{ ...doc, _id: plan.to, sql:", "{ ...doc, enabled: true, _id: plan.to, sql:"],
  native_geo: ['sqlPreflightIndici.js', "16755:'22000'", "16755:undefined"],
  native_parallel: ['sqlPreflightIndici.js', "171:'22000'", "171:undefined"],
  native_immutable: ['sqlPreflightIndici.js', "66:'22000'", "66:undefined"],
  cascade_recovery: ['sqlAlterMongo.js', 'forward ? item.newIndexes : item.oldIndexes', 'item.newIndexes'],
  cascade_default: ['sqlDropDominio.js', ' || depsTypes.espressione(d.definition.default, names)', ''],
  cascade_check: ['sqlDropDominio.js', '(d.definition.checks || []).filter(c => !depsTypes.espressione(c.expr, names))', '(d.definition.checks || [])'],
  cascade_trigger: ['sqlDropDominio.js', 'depsTypes.tokens(definition.when || [])', '[]'],
  native_cleanup: ['sqlPreflightIndici.js', 'attempt>=2', 'attempt>=0'],
  array_index_cast: ['sqlArrayIndici.js', "require('./sqlSchemaMongo').convertiValore({type:'INT',args:[],cast:true},value)", 'value'],
};
let mutated = false;
if (mutant) {
  assert.ok(variants[mutant]);
  require('node:module').registerHooks({ load(url, context, next) {
    const result = next(url, context), [file, from, to] = variants[mutant];
    if (!url.endsWith('/' + file)) return result;
    assert.ok(String(result.source).includes(from), `Mutazione ${mutant} non applicata`); mutated = true;
    return { ...result, source: String(result.source).replace(from, () => to) };
  } });
}
const { MongoClient } = require('mongodb');
const { Client, types } = require('pg');
const mysql = require('mysql2/promise');
const { EJSON } = require('bson');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { guardStrategy } = require('../auth/guardStrategy'), { makePrincipal } = require('../auth/principal');
const { createE2eTargetRegistry } = require('./e2e-harness');
const sql = require('../db/SqlToMql'), triggers = require('../db/sqlTriggerMongo'), procedures = require('../db/sqlProcedureMongo');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_estesi' }), db = targets.target('mongo');
const client = new MongoClient(`mongodb://127.0.0.1:${process.env.MONGO_PORT || 27039}`, { serverSelectionTimeoutMS: 5000 });
const base = new MongoDbStrategy({ env: {} }); base.client = client;
process.env.CODEDB_RBAC = 'on';
const strategy = guardStrategy(base, { connName: 'test', principal: makePrincipal({ _id: 'test', type: 'subuser', ownerId: 'owner' },
  [{ connName: 'test', capabilities: ['read', 'write', 'delete', 'ddl'], scope: { databases: [db], collections: ['*'] } }]) });
let connected, pg, my;
async function query(text, error) {
  const execute = async () => {
    const plan = triggers.riconosci(text) ? { ...triggers.parse(text), kind: 'trigger' } : procedures.riconosci(text) ? { ...procedures.parse(text), kind: 'procedure' }
      : sql.looksLikeSql(text) ? sql.translate(text) : sql.translateWrite(text);
    const method = { trigger: 'mongoSqlTrigger', procedure: 'mongoSqlProcedure', ddl: 'mongoSqlSchema', write: 'mongoSqlReturning' }[plan.kind] || 'mongoSqlRead';
    if (plan.op === 'createIndex') { await strategy.createIndex(db, plan.coll, { fields: EJSON.stringify(plan.keys), ...plan.options }); return []; }
    const result = await strategy[method](db, plan.kind === 'procedure' ? plan.name : plan.coll, { sql: text });
    return EJSON.deserialize(result?.docs || [], { relaxed: true });
  };
  if (error) { await assert.rejects(execute(), error, text); return; }
  return execute();
}
(async () => {
  targets.assertOwned(db); await client.connect(); connected = true;
  if (process.env.PGPORT) {
    types.setTypeParser(20, Number);
    pg = new Client({ host: '127.0.0.1', port: Number(process.env.PGPORT), user: 'postgres', database: 'postgres' }); await pg.connect();
    await pg.query(`CREATE SCHEMA "${db}"; SET search_path TO "${db}"`);
  }
  if (process.env.MYSQL_PORT) {
    my = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MYSQL_PORT), user: 'root', password: require('./lab/credenziali.cjs')('mysql'), multipleStatements: true });
    await my.query(`CREATE DATABASE \`${db}\`; USE \`${db}\``);
  }
  const counts = await require(process.argv.includes('--compatibilita') ? './sql-mongo-compatibilita' : './sql-mongo-estesi')({ query, database: client.db(db), strategy, base, pg, my });
  console.log('PASS estesi', counts);
  if (mutant) { assert.ok(mutated); throw new Error(`Mutazione ${mutant} sopravvissuta`); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  if (pg) { targets.assertOwned(db); await pg.query(`DROP SCHEMA "${db}" CASCADE`); await pg.end(); }
  if (my) { targets.assertOwned(db); await my.query(`DROP DATABASE \`${db}\``); await my.end(); }
  await client.close();
});
