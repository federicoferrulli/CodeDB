'use strict';
require('./fixtures/sql-native-dns.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MongoClient } = require('mongodb');
const { io } = require('socket.io-client');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_mongosh' });
const db = targets.target('runtime'), altro = targets.target('altro');
let server, socket, client, tmp, checks = 0;
const events = [];
const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(45000).emit(event, payload, (err, result) => err ? reject(err) : resolve(result)));
async function q(code, tabId = 'a') {
  const r = await emit('query:execute', { code, engine: 'mongosh', db, tabId, runId: `prova-${checks++}` });
  assert.equal(r.ok, true, `${code}\n${r.error}`); return r;
}
async function attendi(fn, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = fn(); if (r) return r; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Evento mongosh non arrivato entro il termine');
}
(async () => {
  client = new MongoClient('mongodb://127.0.0.1:27039/'); await client.connect();
  server = await startTestServer({ port: 3198, env: {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=./test/fixtures/sql-native-dns.cjs --require=./test/fixtures/mongosh-mutante.cjs`,
    CODEDB_TEST_MONGOSH_MUTANT: process.argv.find(v => v.startsWith('--mutant='))?.split('=')[1] || '',
  } });
  socket = io(server.url, { reconnection: false });
  socket.on('mongosh:event', e => events.push(e));
  await new Promise((r,j) => { socket.once('connect',r); socket.once('connect_error',j); });
  for (const tabId of ['a', 'b']) assert.equal((await emit('mongo:connect', {
    tabId, dbType: 'mongodb', host: '127.0.0.1', port: 27039,
  })).ok, true);

  assert.deepEqual((await q('const dati = [1, 2, 3]; const {max} = Math; class Numero { constructor(n) { this.n=n; } }; dati.map(n => new Numero(n).n)')).data, [{valore:1},{valore:2},{valore:3}]);
  assert.deepEqual((await q('switch(dati.length) { case 3: print(max(...dati)); break; default: throw new Error("switch"); }')).scriptOutput, ['3']);
  assert.equal((await q('typeof dati','b')).data[0].valore, 'undefined');
  assert.deepEqual((await q('Promise.all(dati.map(async n => n*2))')).data, [{valore:2},{valore:4},{valore:6}]);
  console.log('OK runtime JavaScript ufficiale e variabili persistenti isolate per tab');

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codedb-mongosh-'));
  const source = path.join(tmp, 'caricato.js'); await fs.writeFile(source, 'globalThis.daFile = 23;');
  await q(`load(${JSON.stringify(source)})`);
  assert.equal((await q('daFile + require("node:path").basename("/a/b").length')).data[0].valore, 24);
  assert.equal((await q('import("node:path").then(modulo => modulo.basename("/a/b"))')).data[0].valore, 'b');
  console.log('OK load, require, import e contesto Node.js ufficiale');
  assert.deepEqual((await q('console.log("console %s", "nativa"); console.warn("avviso");')).scriptOutput, ['console %s nativa', 'avviso']);
  assert.equal((await q('123456789012345678901234567890n')).data[0].valore, '123456789012345678901234567890n');
  assert.deepEqual((await q('({v:[123456789012345678901234567890n],m:new Map([["x",2n]]),s:new Set([3n])})')).data[0],
    {v:['123456789012345678901234567890n'],m:{x:'2n'},s:['3n']});
  assert.match((await q('const ciclico={}; ciclico.se=ciclico; ciclico')).data[0].valore, /Circular/);
  await q('config.set("displayBatchSize", 3)');
  assert.equal((await q('config.get("displayBatchSize")')).data[0].valore, 3);
  await q('config.reset("displayBatchSize")');
  assert.equal((await q('config.get("displayBatchSize")')).data[0].valore, 20);
  await q(`use ${altro}`);
  assert.equal((await q('db.getName()')).data[0].valore, altro);
  await q(`use ${db}`);
  assert((await q('db.help()')).data.length > 0);

  await q('db.eventi.insertMany([{_id:1,n:1},{_id:2,n:2}])');
  await q('const bulk=db.eventi.initializeUnorderedBulkOp(); bulk.find({_id:1}).updateOne({$inc:{n:2}}); bulk.insert({_id:3,n:3}); bulk.execute()');
  assert.equal((await client.db(db).collection('eventi').findOne({_id:1})).n, 3);
  await q('db.createView("vista", "eventi", [{$match:{n:3}}])');
  assert.equal((await q('db.vista.find().toArray()')).data.length, 2);
  await q('db.vista.renameCollection("vista_rinominata")').catch(async err => {
    // MongoDB non permette rinominare una vista: l'errore deve essere quello del server.
    assert.match(err.message, /view|vista/i);
    await q('db.eventi.renameCollection("eventi_rinominati")');
    await q('db.eventi_rinominati.renameCollection("eventi")');
  });
  assert.equal((await q('db.eventi.validate().valid')).data[0].valore, true);
  assert.equal((await q('rs.status().ok')).data[0].valore, 1);
  assert((await q('db.eventi.getPlanCache().list()')).ok);
  assert.equal((await q('db.eventi.insertOne({_id:4,n:NumberLong("9223372036854775807")}); db.eventi.findOne({_id:4}).n')).data[0].$numberLong, '9223372036854775807');
  assert.deepEqual((await q('({nan:NaN,inf:Infinity,decimal:NumberDecimal("123456789.0000000001")})')).data[0], {
    nan: {$numberDouble:'NaN'}, inf: {$numberDouble:'Infinity'}, decimal: {$numberDecimal:'123456789.0000000001'},
  });
  await q('config.set("displayBatchSize", 2)');
  const batch = await q('db.eventi.find().sort({_id:1})');
  assert.equal(batch.data.length, 2); assert.equal(batch.cursorHasMore, true);
  assert.equal((await q('it')).data.length, 2);
  await q('show collections');
  console.log('OK helper ufficiali bulk, viste, rinomina, validate, rs, plan cache e BSON');

  await q(`const sessione=db.getMongo().startSession(); sessione.startTransaction(); const tx=sessione.getDatabase("${db}"); tx.eventi.insertOne({_id:10})`);
  assert.equal(await client.db(db).collection('eventi').countDocuments({_id:10}), 0);
  await q('sessione.commitTransaction()');
  assert.equal(await client.db(db).collection('eventi').countDocuments({_id:10}), 1);
  await q('sessione.endSession()');
  console.log('OK transazione reale mantenuta fra due esecuzioni');

  const watching = await q('db.eventi.watch([], {fullDocument:"updateLookup", maxAwaitTimeMS:100})');
  assert(watching.streamId);
  await q('const continua=42; continua');
  await client.db(db).collection('eventi').insertOne({_id:20,n:1});
  const first = await attendi(() => events.find(e => e.id === watching.streamId && e.document?.documentKey?._id === 20));
  assert.equal(first.tabId, 'a'); assert.equal(first.document.operationType, 'insert');
  await client.db(db).collection('eventi').updateOne({_id:20},{$set:{n:9}});
  const update = await attendi(() => events.find(e => e.id === watching.streamId && e.document?.operationType === 'update'));
  assert.equal(update.document.fullDocument.n, 9); assert(update.resumeToken);
  const primary = (await client.db('admin').command({hello:1})).primary;
  const node = new MongoClient(`mongodb://${primary}/?directConnection=true`);
  try {
    await node.connect();
    await node.db('admin').command({replSetStepDown:5, force:true}).catch(err => {
      assert(/network|closed|step|primary|interrupted/i.test(err.message), err.message);
    });
    await client.db(db).collection('eventi').insertOne({_id:200,n:7}, {timeoutMS:20000});
    await attendi(() => events.find(e => e.id === watching.streamId && e.document?.documentKey?._id === 200), 20000);
  } finally { await node.close(); }
  console.log('OK ripresa automatica dello stream dopo cambio del primario reale');
  assert.equal((await emit('mongosh:state',{tabId:'b'})).streams.length, 0);
  const snapshot = await emit('mongosh:state',{tabId:'a'}); assert(snapshot.streams[0].events.length >= 2);
  await emit('mongosh:closeStream',{tabId:'a',streamId:watching.streamId});
  await client.db(db).collection('eventi').insertOne({_id:21});
  const resumed = await q(`db.eventi.watch([], {resumeAfter:${JSON.stringify(update.resumeToken)},maxAwaitTimeMS:100})`);
  await attendi(() => events.find(e => e.id === resumed.streamId && e.document?.documentKey?._id === 21));
  await emit('mongosh:closeStream',{tabId:'a',streamId:resumed.streamId});
  console.log('OK stream vivo fra query, eventi insert/update, isolamento, chiusura e resumeAfter');

  await q('const manuale=db.eventi.watch([], {maxAwaitTimeMS:100}); manuale.tryNext()');
  await client.db(db).collection('eventi').insertOne({_id:22});
  assert.equal((await q('manuale.next()')).data[0].documentKey._id, 22);
  await q('manuale.close()');
  console.log('OK cursore change stream conservato come variabile senza consumo automatico');

  const capped = await q('db.eventi.watch([], {maxAwaitTimeMS:100})');
  await client.db(db).collection('eventi').insertMany(Array.from({length:205},(_,i)=>({_id:1000+i})));
  await attendi(() => events.find(e=>e.id===capped.streamId&&e.document?.documentKey?._id===1204));
  const history = (await emit('mongosh:state',{tabId:'a'})).streams.find(f=>f.id===capped.streamId);
  assert.equal(history.events.length,200); assert.equal(history.omessi,5);
  await emit('mongosh:closeStream',{tabId:'a',streamId:capped.streamId});
  console.log('OK cronologia limitata a 200 eventi, omissioni dichiarate e token conservato');

  const pending = q('passwordPrompt()');
  const prompt = await attendi(() => events.find(e => e.event === 'prompt'));
  assert.equal((await emit('mongosh:answer',{tabId:'b',promptId:prompt.id,value:'estraneo'})).ok, false);
  assert.equal((await emit('mongosh:answer',{tabId:'a',promptId:prompt.id,value:'prova-non-segreta'})).ok, true);
  assert.equal((await pending).data[0].valore, 'prova-non-segreta');
  const loop = emit('query:execute',{tabId:'a',engine:'mongosh',db,code:'while(true){}',runId:'loop'});
  await new Promise(r=>setTimeout(r,350));
  assert.equal((await q('1+1','b')).data[0].valore,2);
  assert.equal((await emit('query:cancel',{tabId:'a',runId:'loop'})).cancelled,true);
  assert.equal((await loop).ok,false);
  assert.equal((await q('typeof dati')).data[0].valore,'undefined');
  console.log('OK prompt per tab, cancellazione del ciclo infinito e server ancora utilizzabile');

  for (const action of ['pause','abort']) {
    const runId=`script-${action}`;
    const start=await emit('script:execute',{tabId:'a',db,engine:'mongosh',runId,code:'while(true){}'});
    assert.equal(start.ok,true,start.error);
    await new Promise(r=>setTimeout(r,250));
    const stop=await emit(`script:${action}`,{tabId:'a',runId,force:true});
    assert.equal(stop.ok,true,stop.error);
    if(action==='pause') { assert.equal(stop.cancelled,true); await emit('script:abort',{tabId:'a',runId}); }
    else assert.equal(stop.aborted,true);
    assert.equal((await q('1+1')).data[0].valore,2);
  }
  console.log('OK pausa forzata e arresto del runner script chiudono anche il processo mongosh');

  await q('sessione2=db.getMongo().startSession(); sessione2.startTransaction(); sessione2.getDatabase(db.getName()).eventi.insertOne({_id:30})');
  const reset=emit('mongosh:reset',{tabId:'a'});
  assert.equal((await q('typeof sessione2')).data[0].valore,'undefined');
  await reset;
  assert.equal(await client.db(db).collection('eventi').countDocuments({_id:30}),0);
  await client.db(db).collection('eventi').insertOne({_id:30}, { timeoutMS: 3000 });
  assert.equal((await q('typeof sessione2')).data[0].valore,'undefined');
  assert.equal((await q('quit()')).exited, true);
  assert.equal((await q('typeof continua')).data[0].valore, 'undefined');
  const closing = await q('db.eventi.watch([], {maxAwaitTimeMS:100})');
  await emit('mongo:disconnect',{tabId:'a'});
  await attendi(()=>events.find(e=>e.id===closing.streamId&&e.status==='chiuso'));
  assert(events.find(e=>e.id===closing.streamId&&e.status==='chiuso').resumeToken);
  assert.equal((await emit('mongosh:state',{tabId:'a'})).ok,false);
  const {MongoshRuntime} = require('../db/mongoshRuntime');
  const bounded = new MongoshRuntime('mongodb://127.0.0.1:27039/', {timeout:10000,maxBytes:2048});
  try {
    await bounded.ready;
    await assert.rejects(bounded.evaluate('"x".repeat(4096)',db), /limite di byte/);
    assert.equal((await bounded.evaluate('1+1',db)).docs[0].valore,2);
    bounded.timeout=150;
    await assert.rejects(bounded.evaluate('while(true){}',db), /Tempo mongosh esaurito/);
    assert.equal(bounded.closed,true);
  } finally { await bounded.close(); }
  console.log('OK tetto byte, recupero dopo risultato eccessivo e timeout del processo');
  const invalid = new MongoshRuntime('uri-mongodb-non-valido', {timeout:10000});
  await assert.rejects(invalid.ready);
  assert.equal(invalid.closed,true);
  console.log(`OK reset e disconnessione chiudono transazioni e stream; ${checks} esecuzioni reali`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  socket?.disconnect(); if(server) await server.stop();
  if(client) { for(const name of [db,altro]) { targets.assertOwned(name); await client.db(name).dropDatabase(); } await client.close(); }
  if(tmp) {
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert(path.basename(tmp).startsWith('codedb-mongosh-'));
    await fs.rm(tmp,{recursive:true,force:true});
  }
});
