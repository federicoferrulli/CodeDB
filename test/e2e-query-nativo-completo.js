'use strict';
// Database casuali registrati: nessuna prova usa i dati o il vault dell'utente.
require('./fixtures/sql-native-dns.cjs');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { io } = require('socket.io-client');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_nativo_completo' });
const db = registry.target('dati');
let mongo, pg, my, server, socket, falliti = 0, eseguiti = 0;
const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(20000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res)));
async function q(code, type = 'mongodb') {
  const r = await emit('query:execute', { tabId: type, engine: type, db, coll: 'prova', code });
  assert.equal(r.ok, true, `${code}\n${r.error}`); return r.data;
}
async function prova(nome, fn) {
  if (process.env.CODEDB_NATIVE_CASE && !nome.includes(process.env.CODEDB_NATIVE_CASE)) return;
  eseguiti++;
  try { await fn(); console.log(`OK ${nome}`); }
  catch (err) { falliti++; console.error(`FAIL ${nome}\n${err.stack}`); }
}
(async () => {
  registry.assertOwned(db);
  mongo = new MongoClient('mongodb://127.0.0.1:27039/'); await mongo.connect();
  pg = new Client({ host: '127.0.0.1', port: 55439, user: 'postgres', database: 'postgres' }); await pg.connect();
  my = await mysql.createConnection({ host: '127.0.0.1', port: 33339, user: 'root' });
  console.log('Motori reali:', JSON.stringify({ mongodb: (await mongo.db('admin').command({ buildInfo: 1 })).version,
    postgresql: (await pg.query('SHOW server_version')).rows[0].server_version,
    mysql: (await my.query('SELECT VERSION() AS versione'))[0][0].versione }));
  await pg.query(`CREATE SCHEMA "${db}"`); await my.query(`CREATE DATABASE \`${db}\``);
  await mongo.db(db).collection('prova').insertMany([{ _id: 1, tags: ['a', 'b'] }, { _id: 2, tags: ['b', 'c'] }]);
  server = await startTestServer({ port: Number(process.env.E2E_PORT || 3191), env: {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=./test/fixtures/sql-native-dns.cjs`,
    ...(process.env.CODEDB_NATIVE_MUTANT ? {
      CODEDB_NATIVE_MUTANT: process.env.CODEDB_NATIVE_MUTANT,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=./test/fixtures/sql-native-dns.cjs --require=./test/fixtures/query-native-mutant.cjs`,
    } : {}),
  } });
  socket = io(server.url, { reconnection: false });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const [type, port, username, database] of [['mongodb', 27039, '', db], ['postgresql', 55439, 'postgres', 'postgres'], ['mysql', 33339, 'root', db]]) {
    const r = await emit('mongo:connect', { tabId: type, dbType: type, host: '127.0.0.1', port, username, database });
    assert.equal(r.ok, true, r.error);
  }
  await prova('MongoDB: runCommand conserva il risultato nativo', async () => {
    const r = await q('db.runCommand({ping:1})'); assert.equal(r[0].ok, 1);
    const count = await q('db.runCommand({count:"prova",query:{}})'); assert.equal(count[0].n, 2);
  });
  await prova('MongoDB: database fratello e risultato scalare', async () => {
    assert.deepEqual(await q(`db.getSiblingDB("${db}").getName()`), [{ valore: db }]);
  });
  await prova('MongoDB: distinct nativo espande gli array', async () => {
    const r = await q('const valori = db.prova.distinct("tags"); printjson(valori.sort());');
    assert.deepEqual(JSON.parse(r[0].output), ['a', 'b', 'c']);
  });
  await prova('MongoDB: metadati, opzioni di creazione e indici', async () => {
    await q('db.createCollection("validata", {validator:{$jsonSchema:{bsonType:"object",required:["nome"]}}})');
    const info = await mongo.db(db).listCollections({ name: 'validata' }).next();
    assert.deepEqual(info.options.validator.$jsonSchema.required, ['nome']);
    const name = await q('db.validata.createIndex({nome:1},{name:"nome_unico",unique:true})');
    assert.deepEqual(name, [{ valore: 'nome_unico' }]);
    const indexes = await q('db.validata.getIndexes()'); assert(indexes.some(i => i.name === 'nome_unico'));
  });
  await prova('MongoDB: risultati CRUD compatibili con mongosh', async () => {
    const insert = await q('db.risultati.insertOne({_id:10,n:1})'); assert.equal(insert[0].insertedId, 10);
    const update = await q('db.risultati.updateOne({_id:10},{$inc:{n:1}})');
    assert.equal(update[0].matchedCount, 1); assert.equal(update[0].modifiedCount, 1);
    const doc = await q('db.risultati.findOneAndUpdate({_id:10},{$inc:{n:1}},{returnDocument:"after"})');
    assert.equal(doc[0].n, 3); assert.equal(doc[0]._id, 10);
  });
  await prova('MongoDB: sessione commit con lettura delle proprie scritture', async () => {
    const r = await q(`const s=db.getMongo().startSession(); s.startTransaction();
      const c=s.getDatabase("${db}").transazioni;
      c.insertOne({_id:1,n:10}); print(c.countDocuments({}));
      print(c.findOne({_id:1}).n); s.commitTransaction(); s.endSession();`);
    assert.deepEqual(r.map(v => v.output), ['1', '10']);
    assert.equal((await mongo.db(db).collection('transazioni').findOne({ _id: 1 })).n, 10);
  });
  await prova('MongoDB: abort e chiusura automatica su errore', async () => {
    await q(`const s=db.getMongo().startSession(); s.startTransaction();
      s.getDatabase("${db}").transazioni.insertOne({_id:2}); s.abortTransaction(); s.endSession();`);
    const r = await emit('query:execute', { tabId: 'mongodb', engine: 'mongodb', db,
      code: `const s=db.getMongo().startSession(); s.startTransaction();
        s.getDatabase("${db}").transazioni.insertOne({_id:3}); throw new Error("rollback richiesto");` });
    assert.equal(r.ok, false); assert.match(r.error, /rollback richiesto/);
    assert.equal(await mongo.db(db).collection('transazioni').countDocuments({ _id: { $in: [2, 3] } }), 0);
  });
  await prova('MongoDB: await e callback transazionale', async () => {
    const r = await q(`const s=db.getMongo().startSession();
      await s.withTransaction(async () => { await s.getDatabase("${db}").transazioni.insertOne({_id:4}); });
      print(s.hasEnded()); s.endSession(); print(s.hasEnded());`);
    assert.deepEqual(r.map(v => v.output), ['false', 'true']);
    assert.equal(await mongo.db(db).collection('transazioni').countDocuments({ _id: 4 }), 1);
  });
  await prova('MongoDB: tipi BSON, _id testuale e comando singolo', async () => {
    const id = '665f1c2d3e4f5a6b7c8d9e0f';
    await q(`db.tipi.insertOne({_id:"${id}",n:NumberLong("9223372036854775807")})`);
    assert.equal(typeof (await mongo.db(db).collection('tipi').findOne({ _id: id }))._id, 'string');
    assert.deepEqual((await q(`db.tipi.find({_id:"${id}"})`))[0].n, { $numberLong: '9223372036854775807' });
    assert.deepEqual((await q('db.prova.distinct("tags")')).map(r => r.valore).sort(), ['a', 'b', 'c']);
    assert.deepEqual(await q('db.prova.countDocuments({_id:999})'), [{ valore: 0 }]);
    assert.deepEqual(await q('db.prova.countDocuments({},{limit:1})'), [{ valore: 1 }]);
    assert.deepEqual(await q('db.prova.estimatedDocumentCount()'), [{ valore: 2 }]);
    assert.deepEqual(await q('db.aggregate([{$documents:[{n:2},{n:3}]},{$group:{_id:null,n:{$sum:"$n"}}}])'), [{ _id: null, n: 5 }]);
  });
  await prova('MongoDB: getMore, cursori chiusi e metadati oltre un batch', async () => {
    for (let i = 0; i < 103; i++) await mongo.db(db).createCollection(`elenco_${i}`);
    const infos = await q('db.getCollectionInfos({name:{$regex:"^elenco_"}})'); assert.equal(infos.length, 103);
    const r = await q('const a=db.runCommand({find:"prova",filter:{},batchSize:1}); const b=db.runCommand({getMore:a.cursor.id,collection:"prova"}); print(b.cursor.nextBatch.length);');
    assert.equal(r[0].output, '1');
    assert.deepEqual(await q('const c=db.prova.find({}); c.close(); print(c.hasNext());'), [{ '#': 1, output: 'false' }]);
  });
  await prova('MongoDB: errore nativo conserva codice e transazione aperta viene annullata', async () => {
    const r = await q('try { db.prova.insertOne({_id:1}); } catch(e) { print(e.code); }');
    assert.equal(r[0].output, '11000');
    await q(`const s=db.getMongo().startSession(); s.startTransaction(); s.getDatabase("${db}").transazioni.insertOne({_id:99});`);
    assert.equal(await mongo.db(db).collection('transazioni').countDocuments({ _id: 99 }), 0);
  });
  await prova('MongoDB: indici nativi, opzioni e isolamento di due sessioni', async () => {
    await q('db.risultati.createIndex({n:1},{name:"n_nascosto",hidden:true})');
    assert.equal((await q('db.risultati.getIndexes()')).find(i => i.name === 'n_nascosto').hidden, true);
    await q('db.risultati.unhideIndex("n_nascosto")');
    assert.notEqual((await q('db.risultati.getIndexes()')).find(i => i.name === 'n_nascosto').hidden, true);
    const r = await q(`const a=db.getMongo().startSession(), b=db.getMongo().startSession(); a.startTransaction();
      a.getDatabase("${db}").transazioni.insertOne({_id:100});
      print(b.getDatabase("${db}").transazioni.countDocuments({_id:100}));
      print(a.getDatabase("${db}").transazioni.countDocuments({_id:100})); a.abortTransaction();`);
    assert.deepEqual(r.map(v => v.output), ['0', '1']);
  });
  await prova('MongoDB: precisione BSON anche nelle opzioni DDL', async () => {
    await q('db.createCollection("precisa", {validator:{n:{$lte:NumberLong("9223372036854775807")}}})');
    const info = await mongo.db(db).listCollections({ name: 'precisa' }).next();
    assert.equal(info.options.validator.n.$lte.toString(), '9223372036854775807');
    await q('db.precisa.createIndex({n:1},{name:"parziale",partialFilterExpression:{n:{$gte:NumberLong("9223372036854775807")}}})');
    const ix = (await mongo.db(db).collection('precisa').indexes()).find(i => i.name === 'parziale');
    assert.equal(ix.partialFilterExpression.n.$gte.toString(), '9223372036854775807');
  });
  await prova('MongoDB: indici nella sessione e DDL vietata nella transazione', async () => {
    await mongo.db(db).collection('ddl_sessione').insertOne({ _id: 1, n: 1 });
    await q(`const s=db.getMongo().startSession();
      s.getDatabase("${db}").ddl_sessione.createIndex({n:1},{name:"n_sessione"}); s.endSession();`);
    assert((await mongo.db(db).collection('ddl_sessione').indexes()).some(i => i.name === 'n_sessione'));
    const drop = await emit('query:execute', { tabId: 'mongodb', engine: 'mongodb', db,
      code: `const s=db.getMongo().startSession(); s.startTransaction(); s.getDatabase("${db}").ddl_sessione.drop();` });
    assert.equal(drop.ok, false, 'DROP deve arrivare al server nella transazione e venire rifiutato');
    assert.equal(await mongo.db(db).collection('ddl_sessione').countDocuments(), 1);
  });
  await prova('MongoDB: bulkWrite conserva identificativi, conteggi ed errori parziali', async () => {
    const r = await q('db.bulk.bulkWrite([{insertOne:{document:{_id:1,n:1}}},{updateOne:{filter:{_id:2},update:{$set:{n:2}},upsert:true}}])');
    assert.equal(r[0].insertedCount, 1); assert.equal(r[0].upsertedCount, 1);
    assert.equal(r[0].insertedIds[0], 1); assert.equal(r[0].upsertedIds[1], 2);
    const partial = await q('try { db.bulk.bulkWrite([{insertOne:{document:{_id:1}}},{insertOne:{document:{_id:3}}}],{ordered:false}); } catch(e) { print(e.code); print(e.result.insertedCount); print(e.writeErrors[0].index); }');
    assert.deepEqual(partial.map(v => v.output), ['11000', '1', '0']);
    assert.equal(await mongo.db(db).collection('bulk').countDocuments({ _id: 3 }), 1);
  });
  await prova('MongoDB: createIndexes accetta le chiavi della shell e le opzioni comuni', async () => {
    await q('db.indici_multipli.createIndexes([{a:1},{b:-1}],{sparse:true},"majority")');
    const indexes = await mongo.db(db).collection('indici_multipli').indexes();
    assert.deepEqual(indexes.filter(i => i.name !== '_id_').map(i => [i.name, i.sparse]), [['a_1', true], ['b_-1', true]]);
  });
  await prova('MongoDB: dropIndexes selettivo conserva gli altri indici', async () => {
    const coll = mongo.db(db).collection('indici_selettivi');
    await coll.createIndexes([{ key: { a: 1 } }, { key: { b: 1 } }, { key: { c: 1 } }]);
    const result = await q('db.indici_selettivi.dropIndexes(["a_1","b_1"])');
    assert.deepEqual((await coll.indexes()).map(i => i.name), ['_id_', 'c_1']);
    assert.equal(result[0].ok, 1);
    await q('db.indici_selettivi.dropIndexes({c:1})');
    assert.deepEqual((await coll.indexes()).map(i => i.name), ['_id_']);
  });
  await prova('MySQL: commenti eseguibili nativi per il gestore', async () => {
    assert.deepEqual(await q('SELECT /*!80000 2 + */ 3 AS n', 'mysql'), [{ n: 5 }]);
  });
  await prova('MySQL: routine native con DEFINER esplicito', async () => {
    await q('CREATE DEFINER=CURRENT_USER PROCEDURE procedura_definer() BEGIN SELECT 9 AS n; END', 'mysql');
    assert.equal((await q('CALL procedura_definer()', 'mysql'))[0].n, 9);
    await q("CREATE DEFINER='root'@'%' FUNCTION funzione_definer() RETURNS INT DETERMINISTIC BEGIN RETURN 11; END", 'mysql');
    assert.deepEqual(await q('SELECT funzione_definer() n', 'mysql'), [{ n: 11 }]);
  });
  await prova('PostgreSQL: CTE di scrittura, MERGE e routine native', async () => {
    await q('CREATE TABLE nativa(id INT PRIMARY KEY, n INT)', 'postgresql');
    assert.deepEqual(await q('WITH nuovi AS (INSERT INTO nativa VALUES(1,2) RETURNING *) SELECT * FROM nuovi', 'postgresql'), [{ id: 1, n: 2 }]);
    await q('MERGE INTO nativa t USING (VALUES(1,4)) s(id,n) ON t.id=s.id WHEN MATCHED THEN UPDATE SET n=s.n', 'postgresql');
    assert.deepEqual(await q('SELECT * FROM nativa', 'postgresql'), [{ id: 1, n: 4 }]);
  });
  assert(eseguiti > 0, 'Il filtro deve selezionare almeno una prova');
  console.log(JSON.stringify({ eseguiti, falliti }));
})().catch(err => { falliti++; console.error(err.stack); }).finally(async () => {
  if (socket) socket.disconnect(); if (server) await server.stop();
  registry.assertOwned(db);
  if (mongo) { await mongo.db(db).dropDatabase(); await mongo.close(); }
  if (pg) { await pg.query(`DROP SCHEMA IF EXISTS "${db}" CASCADE`); await pg.end(); }
  if (my) { await my.query(`DROP DATABASE IF EXISTS \`${db}\``); await my.end(); }
  if (falliti) process.exitCode = 1;
});
