'use strict';
const assert = require('node:assert/strict');
const mutant = process.argv.find(a => a.startsWith('--mutant='))?.split('=')[1];
if (mutant) require('node:module').registerHooks({ load(url, context, next) {
  const r = next(url, context);
  let source = String(r.source);
  if (mutant === 'rollback' && url.endsWith('/MongoSqlRuntime.js')) source = source.replace('await transact(async () => {', 'await (async callback => callback())(async () => {');
  if (mutant === 'cte' && url.endsWith('/MongoSqlRuntime.js')) source = source.replace('if (key != null && seen.has(key)) return false;', 'if (false) return false;');
  if (mutant === 'join' && url.endsWith('/SqlToMql.js')) source = source.replace('stages.push({ $unionWith:', 'if (false) stages.push({ $unionWith:');
  if (mutant === 'window' && url.endsWith('/sqlFinestre.js')) source = source.replace("output: { valoreFinestra: { $sum: 1,", "output: { valoreFinestra: { $sum: 2,");
  if (mutant === 'distinct' && url.endsWith('/sqlRaggruppamenti.js')) source = source.replace('if (e.distinct)', 'if (false)');
  if (mutant === 'filter' && url.endsWith('/sqlFinestre.js')) source = source.replace('const a = w.filter ?', 'const a = false ?');
  if (mutant === 'subquery' && url.endsWith('/sqlSottoquery.js')) source = source.replace('$lte: [{ $size: rows }, 1]', '$lte: [{ $size: rows }, 2]');
  if (mutant === 'limit' && url.endsWith('/MongoSqlRuntime.js')) source = source.replace('const cursor = plan.selection ?', 'const cursor = false ?');
  if (mutant === 'conflict' && url.endsWith('/sqlConflitti.js')) source = source.replace('if (plan.conflict.nothing)', 'if (true)');
  return source === String(r.source) ? r : { ...r, source };
} });
const { MongoClient } = require('mongodb');
const { createE2eTargetRegistry } = require('./e2e-harness');
const runtime = require('../db/MongoSqlRuntime');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_atomicita' });
const db = targets.target('mongo');
const client = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.MONGO_PORT || 27039)}`, { monitorCommands: true, serverSelectionTimeoutMS: 5000 });
let connected = false;
const read = (sql, env = {}) => runtime.leggi(client, db, { sql }, env);
const write = (sql, payload = {}, env = {}) => runtime.scrivi(client, db, 't', { sql, ...payload }, env);
(async () => {
  targets.assertOwned(db); await client.connect(); connected = true;
  await client.db(db).collection('t').insertMany([{ _id: 1, n: 1 }, { _id: 2, n: 2 }]);
  assert.deepEqual((await read('SELECT _id,ROW_NUMBER() OVER(ORDER BY _id) AS r FROM t ORDER BY _id')).docs, [{ _id: 1, r: 1 }, { _id: 2, r: 2 }]);
  assert.deepEqual((await read('SELECT a._id AS l,b._id AS r FROM (SELECT _id FROM t WHERE _id=1) a RIGHT JOIN t b ON a._id=b._id ORDER BY r')).docs, [{ l: 1, r: 1 }, { l: null, r: 2 }]);
  assert.deepEqual((await read('WITH RECURSIVE c(n) AS (SELECT 1 UNION SELECT n FROM c) SELECT n FROM c', { CODEDB_SQL_RECURSION_LIMIT: '3' })).docs, [{ n: 1 }]);
  console.log('  OK   Risultati reali: finestre, ramo anti-join e deduplicazione ricorsiva');
  assert.deepEqual((await read('SELECT COUNT(DISTINCT 1) AS n FROM t')).docs, [{ n: 1 }]);
  assert.deepEqual((await read('SELECT _id,COUNT(*) FILTER(WHERE _id=1) OVER() AS n FROM t ORDER BY _id')).docs, [{ _id: 1, n: 1 }, { _id: 2, n: 1 }]);
  await assert.rejects(() => read('SELECT (SELECT n FROM t) AS n'), /Sottoquery scalare/);
  console.log('  OK   DISTINCT, FILTER e cardinalità delle sottoquery su dati reali');
  const invariati = async () => assert.deepEqual(await client.db(db).collection('t').find().sort({ _id: 1 }).toArray(), [{ _id: 1, n: 1 }, { _id: 2, n: 2 }]);
  await assert.rejects(() => write('UPDATE t SET n=999 RETURNING 1/0 AS errore'), /zero|divide/i); await invariati();
  await assert.rejects(() => write('INSERT INTO t (_id,n) VALUES(3,3),(4,4) RETURNING n', { maxRows: 1 }), /limite/); await invariati();
  await assert.rejects(() => write('UPDATE t SET n=999 RETURNING n', { maxRows: 1 }), /limite/); await invariati();
  await assert.rejects(() => write('UPDATE t SET n=999 RETURNING _id,n', {}, { CODEDB_MAX_RESULT_BYTES: '5' }), /limite/); await invariati();
  console.log('  OK   RETURNING: rollback per errore, limite righe e limite byte');
  const opHandle = { interrotto: false, runId: `test_${Date.now()}` };
  const annulla = event => { if (event.commandName === 'update') opHandle.interrotto = true; };
  client.on('commandSucceeded', annulla);
  try { await assert.rejects(() => write('UPDATE t SET n=999 RETURNING n', { opHandle }), /annullata/); }
  finally { client.off('commandSucceeded', annulla); }
  assert.equal(opHandle.interrotto, true); await invariati();
  console.log('  OK   Annullamento dopo UPDATE: rollback prima di restituire o confermare');
  await assert.rejects(() => read(`WITH RECURSIVE x(n) AS (SELECT '${'a'.repeat(200)}') SELECT n FROM x`, { CODEDB_MAX_RESULT_BYTES: '64' }), /limite/);
  const stop = { interrotto: false };
  const ferma = event => { if (event.commandName === 'aggregate') stop.interrotto = true; };
  client.on('commandSucceeded', ferma);
  try {
    await assert.rejects(() => runtime.leggi(client, db, { sql: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c', opHandle: stop }, {}), /annullata/);
  } finally { client.off('commandSucceeded', ferma); }
  assert.equal(stop.interrotto, true);
  console.log('  OK   CTE: limite byte e annullamento fra iterazioni senza risultato parziale');
  assert.deepEqual((await write('UPDATE t SET n=n+1 ORDER BY _id DESC LIMIT 1 RETURNING _id,n')).docs, [{ _id: 2, n: 3 }]);
  assert.deepEqual((await write('INSERT INTO t(_id,n) VALUES(2,4) ON CONFLICT(_id) DO UPDATE SET n=excluded.n RETURNING _id,n')).docs, [{ _id: 2, n: 4 }]);
  await Promise.all(Array.from({ length: 10 }, () => write('INSERT INTO t(_id,n) VALUES(3,1) ON CONFLICT(_id) DO UPDATE SET n=t.n+1')));
  assert.equal((await client.db(db).collection('t').findOne({ _id: 3 })).n, 10);
  console.log('  OK   Scritture limitate e dieci conflitti concorrenti, senza perdita di aggiornamenti');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  await client.close();
});
