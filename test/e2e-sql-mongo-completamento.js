'use strict';
const assert = require('node:assert/strict');
const mutant = process.argv.find(v => v.startsWith('--mutant='))?.split('=')[1];
const variants = {
  rollback: ['sqlSavepointMongo.js', 'for (const [coll, rows] of frame.images)', 'for (const [coll, rows] of [])'],
  trigger_of: ['sqlTriggerMongo.js', 'columns && !trigger.updateColumns.some(n => columns.includes(n))', 'false'],
  fk_rename: ['sqlAlterMongo.js', 'if (to) fk.references.columns =', 'if (false) fk.references.columns ='],
  padding: ['sqlSchemaMongo.js', "if (c.type === 'BINARY') value =", 'if (false) value ='],
  exception: ['sqlProcedureMongo.js', 'await flow.savepoints.rollback(frame);', '/* rollback del blocco omesso */'],
  indice: ['sqlDipendenzeMongo.js', "if (index[key]) index[key] = rename(index[key], a.name, to);", 'if (false) index[key] = rename(index[key], a.name, to);'],
  hex: ['sqlEspressioni.js', "in: '$$result.text'", "in: '0'"],
};
let mutated = false;
if (mutant) {
  assert.ok(variants[mutant]);
  require('node:module').registerHooks({ load(url, context, next) {
    const result = next(url, context), [file, from, to] = variants[mutant];
    if (!url.endsWith('/' + file)) return result;
    assert.ok(String(result.source).includes(from), `Mutazione ${mutant} non applicata`); mutated = true;
    return { ...result, source: String(result.source).replace(from, to) };
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
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_completamento' }), db = targets.target('mongo');
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
    my = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MYSQL_PORT), user: 'root', password: '', multipleStatements: true });
    await my.query(`CREATE DATABASE \`${db}\`; USE \`${db}\``);
  }
  const counts = await require('./sql-mongo-completamento')({ query, database: client.db(db), strategy, base, pg, my });
  console.log('PASS completamento', counts);
  if (mutant) { assert.ok(mutated); throw new Error(`Mutazione ${mutant} sopravvissuta`); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  if (pg) { targets.assertOwned(db); await pg.query(`DROP SCHEMA "${db}" CASCADE`); await pg.end(); }
  if (my) { targets.assertOwned(db); await my.query(`DROP DATABASE \`${db}\``); await my.end(); }
  await client.close();
});
