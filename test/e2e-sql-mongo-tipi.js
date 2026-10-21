'use strict';
const assert = require('node:assert/strict');
const mutant = process.argv.find(v => v.startsWith('--mutant='))?.split('=')[1];
const variants = {
  snapshot: ['sqlSavepointMongo.js', "if (method === 'aggregate') return (pipeline, options = {}) => options.session === session", "if (method === 'aggregate') return (pipeline, options = {}) => false"],
  array_index: ['sqlArrayIndici.js', "{ $subtract: [item.index, { $arrayElemAt: ['$$limiti', depth] }] }", 'item.index'],
  array_shape: ['sqlArrayMongo.js', '{ $eq: [dimensioni(child), dimensioni({ $arrayElemAt: [v, 0] })] }', 'true'],
  domains: ['sqlSchemaMongo.js', 'for (const constraint of c.elementDomain ? [] : c.domainChecks || [])', 'for (const constraint of [])'],
  range: ['sqlRangeMongo.js', "const discrete = ['INT4RANGE', 'INT8RANGE', 'DATERANGE'].includes(type);", 'const discrete = false;'],
  statement: ['sqlTriggerMongo.js', "statement: (timing, event, columns) => fire(timing, event, null, null, columns, 'STATEMENT')", 'statement: async () => {}'],
  routine: ['sqlDipendenzeRoutine.js', 'if (!dependency) continue;', 'if (true) continue;'],
  domain_rollback: ['sqlAlterMongo.js', 'for (const dependency of job.dependencies || []) {', 'for (const dependency of []) {'],
  array_fk: ['sqlVincoliReferenziali.js', 'const filter = { $expr: { $and: fk.columns.map((n, i) => ({ $eq: [`$${n}`, { $literal: old[cols[i]] }] })) } };', 'const filter = Object.fromEntries(fk.columns.map((n,i)=>[n,{$eq:old[cols[i]]}]));'],
  cast_null: ['sqlSchemaMongo.js', "{ $eq: ['$$testo', null] }", 'false'],
  cast_overflow: ['sqlSchemaMongo.js', "if (c.cast && ['TINYINT','SMALLINT','INT','BIGINT'].includes(c.type))", 'if (false)'],
  domain_state: ['sqlSavepointMongo.js', "del dominio ${column.domain}.`, '23514', 'HY000'", "del dominio ${column.domain}.`, '22000', 'HY000'"],
  native_state: ['sqlSavepointMongo.js', "241: '22P02'", "241: '22018'"],
  duplicate_condition: ['sqlProcedureMongo.js', 'conditions.push(...states)', 'conditions.push(states[0])'],
  cast_binary: ['sqlSchemaMongo.js', "c.cast || { $lt: [{ $binarySize: '$$b' }, c.args[0]] }", "{ $lt: [{ $binarySize: '$$b' }, c.args[0]] }"],
  array_cat: ['sqlArrayMongo.js', "{ $lt: ['$$ld', '$$rd'] }", 'false'],
  array_replace: ['sqlArrayMongo.js', "converti(original, v => ({ $cond: [{ $eq: [v, b] }, c, v] }))", "{ $map: { input: a, as: 'v', in: { $cond: [{ $eq: ['$$v', b] }, c, '$$v'] } } }"],
  domain_array: ['sqlDominiMongo.js', 'declared.default || !elementDomain && base.default', 'declared.default || base.default'],
  default_boundary: ['sqlEspressioni.js', "if (op === 'NOT' && !['IN', 'BETWEEN', 'LIKE', 'ILIKE'].includes(String(p.peek(1)?.value).toUpperCase())) break;", ''],
  statement_columns: ['MongoSqlRuntime.js', 'plan.update || plan.conflict?.update', 'plan.update'],
  excluded_case: ['SqlToMql.js', '/^excluded\\./i.test(name)', "name.startsWith('excluded.')"],
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
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_tipi' }), db = targets.target('mongo');
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
  const counts = await require('./sql-mongo-tipi')({ query, database: client.db(db), strategy, base, pg, my });
  console.log('PASS tipi', counts);
  if (mutant) { assert.ok(mutated); throw new Error(`Mutazione ${mutant} sopravvissuta`); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  if (pg) { targets.assertOwned(db); await pg.query(`DROP SCHEMA "${db}" CASCADE`); await pg.end(); }
  if (my) { targets.assertOwned(db); await my.query(`DROP DATABASE \`${db}\``); await my.end(); }
  await client.close();
});
