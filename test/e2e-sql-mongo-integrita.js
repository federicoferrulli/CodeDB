'use strict';
const assert = require('node:assert/strict');
const mutant = process.argv.find(a => a.startsWith('--mutant='))?.split('=')[1];
let mutato = false;
const mutations = {
  insieme: ['sqlInsiemi.js', "{ $min: ['$sinistra', '$destra'] }", "{ $max: ['$sinistra', '$destra'] }"],
  sorgente: ['MongoSqlRuntime.js', 'if (plan.source) plan.docs = await run(plan.source);', 'if (plan.source) plan.docs = [];'],
  join_scrittura: ['MongoSqlRuntime.js', 'row[`v${i}`] ?? null', '0'],
  schema: ['sqlSchemaMongo.js', "validationAction: 'error'", "validationAction: 'warn'"],
  foreign: ['sqlVincoliReferenziali.js', 'if (await cursor.hasNext()) throw', 'if (false) throw'],
  procedura: ['sqlProcedureMongo.js', 'await transact(async () => {', 'await (async fn => fn())(async () => {'],
  permessi: ['sqlProcedureMongo.js', 'const authorize = payload[AUTHORIZE];', 'const authorize = () => {};'],
  precisione: ['SqlToMql.js', "const precise = val.replace(/[^0-9]/g, '').replace(/^0+/, '').length > 15;", 'const precise = false;'],
  mql: ['sqlScrittureMongo.js', 'await refs.dopo(before, options,', 'await (async () => {})(before, options,'],
};
if (mutant) {
  assert.ok(mutations[mutant], 'Mutazione sconosciuta');
  require('node:module').registerHooks({ load(url, context, next) {
    const r = next(url, context), [file, from, to] = mutations[mutant];
    if (!url.endsWith('/' + file)) return r;
    const source = String(r.source);
    assert.ok(source.includes(from), `Mutazione ${mutant} non applicata`); mutato = true;
    return { ...r, source: source.replace(from, to) };
  } });
}
const { MongoClient, Long } = require('mongodb');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { guardStrategy } = require('../auth/guardStrategy');
const { makePrincipal } = require('../auth/principal');
const { createE2eTargetRegistry } = require('./e2e-harness');
const sql = require('../db/SqlToMql');
const procedures = require('../db/sqlProcedureMongo');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_integrita' });
const db = targets.target('mongo');
const client = new MongoClient(`mongodb://127.0.0.1:${process.env.MONGO_PORT || 27039}`, { serverSelectionTimeoutMS: 5000 });
let connected = false;
process.env.CODEDB_RBAC = 'on';
const base = new MongoDbStrategy({ env: {} }); base.client = client;
const protetta = (caps = ['read', 'write', 'delete', 'ddl'], collections = ['*']) => guardStrategy(base, {
  connName: 'test', principal: makePrincipal({ _id: 'test', type: 'subuser', ownerId: 'owner' },
    [{ connName: 'test', capabilities: caps, scope: { databases: [db], collections } }]),
});
const strategy = protetta();
async function execute(text, target = strategy, extra = {}) {
  if (procedures.riconosci(text)) return target.mongoSqlProcedure(db, procedures.parse(text).name, { sql: text, ...extra });
  const plan = sql.looksLikeSql(text) ? sql.translate(text) : sql.translateWrite(text);
  if (plan.kind === 'ddl') return target.mongoSqlSchema(db, plan.coll, { sql: text, ...extra });
  return target[plan.kind === 'write' ? 'mongoSqlReturning' : 'mongoSqlRead'](db, plan.coll, { sql: text, ...extra });
}
(async () => {
  targets.assertOwned(db); await client.connect(); connected = true;
  await client.db(db).collection('a').insertMany([{ n: 1 }, { n: 1 }]);
  await client.db(db).collection('b').insertOne({ n: 1 });
  assert.deepEqual((await execute('SELECT n FROM a INTERSECT ALL SELECT n FROM b')).docs, [{ n: 1 }]);
  await execute('INSERT INTO copiati(n) SELECT n FROM a');
  assert.equal(await client.db(db).collection('copiati').countDocuments(), 2);
  await execute('UPDATE copiati c JOIN a ON c.n=a.n SET c.n=a.n+5');
  assert.deepEqual((await execute('SELECT n FROM copiati')).docs, [{ n: 6 }, { n: 6 }]);
  await execute('CREATE TABLE padre(id INT PRIMARY KEY, n INT CHECK(n>0))');
  await execute('CREATE TABLE figlio(id INT PRIMARY KEY, pid INT, FOREIGN KEY(pid) REFERENCES padre(id) ON DELETE CASCADE)');
  await execute('INSERT INTO padre(id,n) VALUES(1,1)');
  await assert.rejects(client.db(db).collection('padre').insertOne({ id: 10, n: -1 }), e => e.code === 121);
  await assert.rejects(execute('INSERT INTO figlio(id,pid) VALUES(1,999)'), /FOREIGN KEY/);
  console.log('  OK   Semantica insiemi, sorgenti INSERT, validatore nativo e FK verificate con dati reali');

  await execute('CREATE PROCEDURE incremento() BEGIN UPDATE padre SET n=n+1 WHERE id=1; INSERT INTO padre(id,n) VALUES(1,2); END');
  await assert.rejects(execute('CALL incremento()'), /duplic|E11000/i);
  assert.equal((await client.db(db).collection('padre').findOne({ id: 1 })).n, 1, 'Una CALL fallita deve annullare anche il primo UPDATE');
  await execute('CREATE PROCEDURE legittima() BEGIN UPDATE padre SET n=n+1 WHERE id=1; END');
  await assert.rejects(execute('CALL legittima()', protetta(['read'])), /Permesso negato/);
  assert.equal((await client.db(db).collection('padre').findOne({ id: 1 })).n, 1, 'CALL non può elevare i privilegi');
  await execute('CREATE PROCEDURE fuori_scope() BEGIN SELECT n FROM a; END');
  await assert.rejects(execute('CALL fuori_scope()', protetta(['read'], ['fuori_scope'])), /Permesso negato/);
  await execute('INSERT INTO figlio(id,pid) VALUES(1,1)');
  await assert.rejects(execute('DELETE FROM padre WHERE id=1', protetta(['read', 'delete'], ['padre'])), /Permesso negato/);
  assert.equal(await client.db(db).collection('padre').countDocuments({ id: 1 }), 1);
  console.log('  OK   Procedure e cascata rispettano rollback, capability e scope di tutte le tabelle');
  await execute('CREATE PROCEDURE infinita() BEGIN UPDATE padre SET n=n+100 WHERE id=1; WHILE TRUE DO SET impossibile=1; END WHILE; END').then(
    () => assert.fail('Una variabile sconosciuta deve essere rifiutata alla definizione'),
    err => assert.match(err.message, /Variabile SQL sconosciuta/));
  await execute('CREATE PROCEDURE infinita() BEGIN DECLARE i INT DEFAULT 0; UPDATE padre SET n=n+100 WHERE id=1; WHILE TRUE DO SET i=i+1; END WHILE; END');
  base.env = { CODEDB_AGGREGATE_TIMEOUT_MS: '500' };
  try { await assert.rejects(execute('CALL infinita()'), /Tempo massimo|time limit|maxTimeMS/i); }
  finally { base.env = {}; }
  assert.equal((await client.db(db).collection('padre').findOne({ id: 1 })).n, 1);
  console.log('  OK   Una procedura senza termine scade e annulla le scritture precedenti');

  await execute('CREATE TABLE esatti(id INT PRIMARY KEY, n BIGINT)');
  await execute('INSERT INTO esatti(id,n) VALUES(1,9223372036854775807)');
  const exact = (await execute('SELECT n FROM esatti')).docs[0];
  assert.deepEqual(exact, { n: { $numberLong: '9223372036854775807' } });
  assert.equal((await client.db(db).collection('esatti').findOne({ id: 1 })).n.toString(), Long.MAX_VALUE.toString());
  console.log('  OK   BIGINT resta esatto nel database e nel protocollo EJSON');

  await execute('CREATE TABLE riferimento(id INT PRIMARY KEY, pid INT, FOREIGN KEY(pid) REFERENCES padre(id))');
  for (let i = 10; i < 20; i++) {
    await execute(`INSERT INTO padre(id,n) VALUES(${i},1)`);
    const outcomes = await Promise.allSettled([
      execute(`DELETE FROM padre WHERE id=${i}`),
      execute(`INSERT INTO riferimento(id,pid) VALUES(${i},${i})`),
    ]);
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1, 'Una sola delle due operazioni concorrenti è valida');
    const parent = await client.db(db).collection('padre').findOne({ id: i });
    const child = await client.db(db).collection('riferimento').findOne({ id: i });
    assert.ok(!child || parent, 'Mai un figlio orfano dopo scritture concorrenti');
    assert.match(outcomes.find(o => o.status === 'rejected').reason.message, /FOREIGN KEY/);
  }
  console.log('  OK   Dieci competizioni DELETE genitore / INSERT figlio non producono orfani');
  const native = (op, fields, target = strategy) => target.shellWrite(db, 'riferimento', { op, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, JSON.stringify(v)])) });
  for (const action of [
    () => native('insertOne', { doc: { id: 100, pid: 999 } }),
    () => native('insertMany', { docs: [{ id: 100, pid: 1 }, { id: 101, pid: 999 }] }),
    () => native('updateOne', { filter: { id: 999 }, update: { $set: { id: 100, pid: 999 } }, options: { upsert: true } }),
    () => strategy.docInsert(db, 'riferimento', { doc: '{"id":100,"pid":999}' }),
    () => strategy.collectionImport(db, 'riferimento', { docs: [{ id: 100, pid: 1 }, { id: 101, pid: 999 }] }),
  ]) {
    await assert.rejects(action(), /FOREIGN KEY/);
    assert.equal(await client.db(db).collection('riferimento').countDocuments({ id: { $in: [100, 101] } }), 0);
  }
  await native('insertOne', { doc: { id: 100, pid: 1 } });
  const id = require('bson').EJSON.stringify((await client.db(db).collection('riferimento').findOne({ id: 100 }))._id);
  for (const action of [
    () => native('updateMany', { filter: { id: 100 }, update: [{ $set: { pid: 999 } }] }),
    () => native('replaceOne', { filter: { id: 100 }, doc: { id: 100, pid: 999 } }),
    () => native('findOneAndUpdate', { filter: { id: 100 }, update: { $set: { pid: 999 } }, options: { returnDocument: 'after' } }),
    () => strategy.docUpdate(db, 'riferimento', { id, set: { pid: 999 } }),
    () => strategy.docReplace(db, 'riferimento', { id, doc: '{"id":100,"pid":999}' }),
    () => strategy.collectionUpdateMany(db, 'riferimento', { filter: '{"id":100}', set: '{"pid":999}' }),
  ]) {
    await assert.rejects(action(), /FOREIGN KEY/);
    assert.equal((await client.db(db).collection('riferimento').findOne({ id: 100 })).pid, 1);
  }
  await assert.rejects(native('insertOne', { doc: { id: 101, pid: 1 } }, protetta(['write'], ['riferimento'])), /Permesso negato/);
  await assert.rejects(strategy.shellWrite(db, 'padre', { op: 'deleteMany', filter: '{"id":1}' }), /FOREIGN KEY/);
  assert.equal(await client.db(db).collection('padre').countDocuments({ id: 1 }), 1);
  await strategy.docDelete(db, 'riferimento', { id });
  await strategy.shellWrite(db, 'padre', { op: 'findOneAndDelete', filter: '{"id":1}' });
  assert.equal(await client.db(db).collection('figlio').countDocuments({ pid: 1 }), 0);
  console.log('  OK   Shell, pipeline MQL, upsert, griglia e import: FK, cascata, rollback dei blocchi e scope');
  if (mutant) { assert.ok(mutato); console.error(`Mutazione ${mutant} sopravvissuta: i test non l’hanno rilevata.`); }
  console.log('PASS: integrità SQL, concorrenza, precisione, procedure e RBAC su MongoDB reale.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  await client.close();
});
