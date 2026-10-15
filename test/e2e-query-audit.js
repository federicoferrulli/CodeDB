'use strict';
// Le fixture appartengono esclusivamente a questa esecuzione, anche nei casi falliti.
if (process.env.CODEDB_QUERY_MUTANT) require('./fixtures/query-audit-mutant.cjs');
require('./fixtures/sql-native-dns.cjs');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const { getStrategy } = require('../db/DbFactory');
const { conSessioneSql } = require('../db/sqlSessione');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_query_audit' });
const db = registry.target('a'), altro = registry.target('b');
const pgPort = Number(process.env.PGPORT || 55439), myPort = Number(process.env.MYSQL_PORT || 33339);
const mongoPort = Number(process.env.MONGO_PORT || 27039);
let pg, my, mongo, server, socket;
const esiti = [];
async function prova(nome, fn) {
  if (process.env.CODEDB_QUERY_CASE && !nome.includes(process.env.CODEDB_QUERY_CASE)) return;
  try { await fn(); esiti.push({ nome, ok: true }); console.log(`OK ${nome}`); }
  catch (err) { esiti.push({ nome, ok: false }); console.error(`FAIL ${nome}\n${err.stack}`); }
}
const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(15000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res)));
async function q(type, code, extra = {}) {
  const res = await emit('query:execute', { tabId: type, engine: type, db, coll: 'prova', code, ...extra });
  assert.equal(res.ok, true, `${code}\n${res.error}`); return res;
}
async function diretta(type, fn) {
  const strategy = getStrategy(type), scope = {};
  const execute = (sql, payload = {}) => conSessioneSql(scope, () => strategy.collectionAggregate(db, null, { pipeline: sql, ...payload }), true);
  try {
    await strategy.connect({ host: '127.0.0.1', port: type === 'postgresql' ? pgPort : myPort,
      username: type === 'postgresql' ? 'postgres' : 'root', database: type === 'postgresql' ? 'postgres' : db });
    await fn(execute, strategy);
  } finally { await strategy.disconnect(); }
}
(async () => {
  registry.assertOwned(db); registry.assertOwned(altro);
  pg = new Client({ host: '127.0.0.1', port: pgPort, user: 'postgres', database: 'postgres' }); await pg.connect();
  my = await mysql.createConnection({ host: '127.0.0.1', port: myPort, user: 'root' });
  mongo = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/`); await mongo.connect();
  for (const n of [db, altro]) {
    await pg.query(`CREATE SCHEMA "${n}"`); await pg.query(`CREATE TABLE "${n}".prova(id INT)`);
    await my.query(`CREATE DATABASE \`${n}\``); await my.query(`CREATE TABLE \`${n}\`.prova(id INT)`);
  }
  await mongo.db(db).collection('prova').insertOne({ id: 1, virtualJoin: 'dato', testo: '"virtualJoin"' });
  server = await startTestServer({ port: Number(process.env.E2E_PORT || 3186), env: process.env.CODEDB_QUERY_MUTANT ? {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=./test/fixtures/query-audit-mutant.cjs`,
  } : {} });
  socket = io(server.url, { reconnection: false });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const [type, port, username, database] of [['postgresql', pgPort, 'postgres', 'postgres'], ['mysql', myPort, 'root', db], ['mongodb', mongoPort, '', db]]) {
    const res = await emit('mongo:connect', { tabId: type, dbType: type, host: '127.0.0.1', port, username, database });
    assert.equal(res.ok, true, res.error);
  }
  await prova('instradamento: virtualJoin dentro SQL e MQL resta un dato', async () => {
    for (const type of ['postgresql', 'mysql']) assert.deepEqual((await q(type, `SELECT '"virtualJoin"' AS testo`)).data, [{ testo: '"virtualJoin"' }]);
    for (const code of ['{"virtualJoin":"dato"}', 'db.prova.find({"virtualJoin":"dato"})', '[{"$match":{"virtualJoin":"dato"}}]']) {
      assert.equal((await q('mongodb', code)).data[0].id, 1);
    }
  });
  await prova('MySQL: affectedRows e altri nomi di protocollo sono colonne ordinarie', async () => {
    for (const sql of ['SELECT 7 AS affectedRows, 8 AS insertId, 9 AS serverStatus', 'SELECT 7 AS affectedRows, 8 AS insertId, 9 AS serverStatus UNION ALL SELECT 10,11,12']) {
      const expected = (await my.query(sql))[0];
      assert.deepEqual((await q('mysql', sql)).data, expected);
    }
  });
  await prova('PostgreSQL: COMMIT fallito chiude la transazione anche per CodeDB', () => diretta('postgresql', async execute => {
    await execute('CREATE TEMP TABLE differita(id INT UNIQUE DEFERRABLE INITIALLY DEFERRED)');
    await execute('BEGIN'); await execute('INSERT INTO differita VALUES(1),(1)');
    await assert.rejects(() => execute('COMMIT'), /duplicate key/);
    const res = await execute('SELECT 1 n', { readOnly: true });
    assert.deepEqual(res.docs, [{ n: 1 }], 'Il server ha già annullato la transazione');
  }));
  await prova('MySQL: DDL con commit implicito libera la lettura protetta', () => diretta('mysql', async execute => {
    await execute('START TRANSACTION'); await execute('INSERT INTO prova VALUES(20)');
    await execute('CREATE TABLE commit_implicito(id INT)');
    assert.deepEqual((await execute('SELECT 1 n', { readOnly: true })).docs, [{ n: 1 }]);
    assert.deepEqual((await my.query(`SELECT id FROM \`${db}\`.prova`))[0], [{ id: 20 }]);
  }));
  await prova('MySQL: autocommit qualificato non lascia committare una lettura protetta', () => diretta('mysql', async execute => {
    await execute('SET @@SESSION.autocommit=0'); await execute('INSERT INTO prova VALUES(21)');
    await assert.rejects(() => execute('SELECT 1 n', { readOnly: true }), /lettura protetta/);
    await execute('ROLLBACK'); await execute('SET autocommit=1');
    assert.deepEqual((await my.query(`SELECT id FROM \`${db}\`.prova WHERE id=21`))[0], [], 'La lettura non deve committare la scrittura precedente');
  }));
  await prova('USE: nomi quotati e commenti aggiornano il bersaglio solo dopo il successo', async () => {
    const changed = await q('mysql', `USE /* bersaglio */ \`${altro}\``);
    assert.equal(changed.activeDb, altro);
    const res = await emit('query:execute', { tabId: 'mysql', engine: 'mysql', code: 'SELECT DATABASE() db' });
    assert.equal(res.ok, true, res.error); assert.deepEqual(res.data, [{ db: altro }]);
    const failed = await emit('query:execute', { tabId: 'mysql', engine: 'mysql', code: `USE \`${db}\`; SELECT 1` });
    assert.equal(failed.ok, false);
    assert.deepEqual((await q('mysql', 'SELECT DATABASE() db', { db: undefined })).data, [{ db: altro }]);
  });
  await prova('MySQL: diagnostica, conteggi e warning sopravvivono fra query consecutive', async () => {
    await q('mysql', 'INSERT INTO prova VALUES(31),(32)');
    assert.deepEqual((await q('mysql', 'SELECT ROW_COUNT() n')).data, [{ n: 2 }]);
    await q('mysql', 'SELECT SQL_CALC_FOUND_ROWS id FROM prova LIMIT 1');
    const expected = (await my.query(`SELECT COUNT(*) n FROM \`${db}\`.prova`))[0];
    assert.deepEqual((await q('mysql', 'SELECT FOUND_ROWS() n')).data, expected);
    await q('mysql', "SELECT CAST('non_numerico' AS UNSIGNED) n");
    assert.equal((await q('mysql', 'SHOW WARNINGS')).data[0].Code, 1292);
    const failed = await emit('query:execute', { tabId: 'mysql', engine: 'mysql', db, code: 'SELECT codedb_colonna_inesistente' });
    assert.equal(failed.ok, false);
    assert.equal((await q('mysql', 'SHOW WARNINGS')).data[0].Code, 1054);
  });
  await prova('MySQL: errore DDL dopo commit implicito riallinea lo stato', () => diretta('mysql', async execute => {
    await execute('START TRANSACTION'); await execute('INSERT INTO prova VALUES(40)');
    await assert.rejects(() => execute('CREATE TABLE prova(id INT)'), /already exists/);
    assert.deepEqual((await execute('SELECT 1 n', { readOnly: true })).docs, [{ n: 1 }]);
    assert.deepEqual((await my.query(`SELECT id FROM \`${db}\`.prova WHERE id=40`))[0], [{ id: 40 }]);
  }));
  await prova('PostgreSQL: cambio nativo READ WRITE non eredita la lettura protetta', () => diretta('postgresql', async execute => {
    await execute('BEGIN READ ONLY'); await execute('SET TRANSACTION READ WRITE');
    await assert.rejects(() => execute('SELECT 1 n', { readOnly: true }), /lettura protetta/);
    await execute('ROLLBACK');
  }));
  await prova('PostgreSQL: il guard rifiuta batch raw senza effetti parziali', async () => {
    await q('postgresql', 'BEGIN'); await q('postgresql', 'SELECT 1', { db: altro });
    const batch = await emit('query:execute', { tabId: 'postgresql', engine: 'postgresql', db: altro, code: 'ROLLBACK; INSERT INTO prova VALUES(50)' });
    assert.equal(batch.ok, false); assert.match(batch.error, /ScriptRunner/);
    await q('postgresql', 'ROLLBACK', { db: altro });
    assert.deepEqual((await pg.query(`SELECT * FROM "${db}".prova WHERE id=50`)).rows, []);
    assert.deepEqual((await pg.query(`SELECT * FROM "${altro}".prova WHERE id=50`)).rows, []);
  });
  await prova('Virtual JOIN: automatico ed esplicito mantengono le sorgenti reali', async () => {
    const spec = JSON.stringify({ virtualJoin: { sourceA: { tabId: 'mongodb', db, collection: 'prova' },
      sourceB: { tabId: 'postgresql', db, query: "SELECT 1 AS id, 'collegato' AS nome" }, on: { leftKey: 'id', rightKey: 'id' } } });
    for (const engine of ['auto', 'crossdb']) assert.equal((await q('mongodb', spec, { engine })).data[0].joined_data.nome, 'collegato');
  });
  await prova('MQL: i nomi interni dell’interprete restano normali campi BSON', async () => {
    const doc = { id: 60, __host: true, __funzione: true, __chiamabile: true, __bson: 'long', valore: 'dato' };
    await q('mongodb', `db.marcatori.insertOne(${JSON.stringify(doc)})`);
    const actual = await mongo.db(db).collection('marcatori').findOne({ id: 60 }, { projection: { _id: 0 } });
    assert.deepEqual(actual, doc);
    const result = await q('mongodb', 'const d = db.marcatori.findOne({id:60}); print(d.__host, d.valore);');
    assert.deepEqual(result.scriptOutput, ['true dato']);
  });
  await prova('MQL: Unicode, esadecimali e continuazioni di riga concordano fra shell e script', async () => {
    const value = 'caffè A 😀';
    await mongo.db(db).collection('testi').insertOne({ id: 1, testo: value });
    const literal = String.raw`"caff\u00e8 \x41 \u{1F600}"`;
    assert.equal((await q('mongodb', `db.testi.find({testo:${literal}})`)).data[0]?.id, 1);
    await q('mongodb', `const t=${literal}; db.testi.insertOne({id:2,testo:t});`);
    assert.equal((await mongo.db(db).collection('testi').findOne({ id: 2 })).testo, value);
    await q('mongodb', 'const t=`caff\\u00e8 ${"A"} \\u{1F600}`; db.testi.insertOne({id:3,testo:t});');
    assert.equal((await mongo.db(db).collection('testi').findOne({ id: 3 })).testo, value);
    for (const invalid of [String.raw`"\u00ZZ"`, String.raw`"\xQ1"`, String.raw`"\u{110000}"`]) {
      for (const code of [`db.testi.find({testo:${invalid}})`, `const t=${invalid}; db.testi.insertOne({id:4,testo:t});`]) {
        const result = await emit('query:execute', { tabId: 'mongodb', engine: 'mongodb', db, code });
        assert.equal(result.ok, false, 'Gli escape invalidi devono fallire prima di leggere o scrivere');
      }
    }
    assert.equal(await mongo.db(db).collection('testi').countDocuments({ id: 4 }), 0);
  });
  await prova('MQL: find nello script legge oltre 50 righe e rifiuta risultati parziali', async () => {
    await mongo.db(db).collection('molti').insertMany(Array.from({ length: 101 }, (_, id) => ({ id })));
    assert.deepEqual((await q('mongodb', 'const r=db.molti.find({}).toArray(); print(r.length);')).scriptOutput, ['101']);
    await mongo.db(db).collection('molti').insertMany(Array.from({ length: 9900 }, (_, n) => ({ id: n + 101 })));
    for (const source of ['find({})', 'aggregate([])']) {
      const res = await emit('query:execute', { tabId: 'mongodb', engine: 'mongodb', db,
        code: `const r=db.molti.${source}.toArray(); db.prova.insertOne({id:99,n:r.length});` });
      assert.equal(res.ok, false, 'Non usare un risultato parziale per una scrittura successiva');
      assert.match(res.error, /limite|budget|incomplet/i);
    }
    assert.equal(await mongo.db(db).collection('prova').countDocuments({ id: 99 }), 0);
    assert.deepEqual((await q('mongodb', 'const r=db.molti.find({}).limit(3).toArray(); print(r.length);')).scriptOutput, ['3']);
  });
  await prova('MQL: cursori consumabili, next, count e interruzione del ciclo', async () => {
    await mongo.db(db).collection('cursori').insertMany([1,2,3].map(id => ({ id })));
    const code = `const c=db.cursori.find({}).sort({id:1}); print(c.hasNext()); print(c.next().id);
      print(c.toArray().length); print(c.hasNext()); print(c.toArray().length);
      const d=db.cursori.find({}).sort({id:1}); for(const row of d) { print(row.id); break; } print(d.next().id);
      const e=db.cursori.find({}).limit(1); print(e.count()); print(e.count(true)); print(e.hasNext()); print(e.itcount()); print(e.hasNext());`;
    assert.deepEqual((await q('mongodb', code)).scriptOutput, ['true','1','2','false','0','1','2','3','1','true','1','false']);
    // count restituisce uno scalare nativo, anche senza altre istruzioni.
    const singolo = (await q('mongodb', 'db.cursori.find({}).limit(1).count(true)')).data;
    assert.deepEqual(singolo, [{ valore: 1 }]);
    assert.deepEqual((await q('mongodb', 'const c=db.cursori.find({}).limit(1); c.count(true);')).data, singolo);
    const first = (await q('mongodb', 'db.cursori.find({}).sort({id:1}).next()')).data;
    assert.equal(first.length, 1); assert.equal(first[0].id, 1);
    const plan = await q('mongodb', 'const c=db.cursori.find({id:1}); c.explain();');
    assert(plan.data[0].queryPlanner, 'Lo script deve restituire anche il piano di esecuzione');
  });
  console.log(JSON.stringify({ casi: esiti.length, falliti: esiti.filter(e => !e.ok).length, esiti }));
  assert(esiti.length && esiti.every(e => e.ok), 'Tutte le regressioni SQL/MQL devono passare');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  socket?.disconnect(); if (server) await server.stop();
  for (const n of [db, altro]) {
    registry.assertOwned(n);
    if (pg) await pg.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`).catch(() => {});
    if (my) await my.query(`DROP DATABASE IF EXISTS \`${n}\``).catch(() => {});
    if (mongo) await mongo.db(n).dropDatabase().catch(() => {});
  }
  await Promise.allSettled([pg?.end(), my?.end(), mongo?.close()]);
});
