'use strict';
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { io } = require('socket.io-client');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const targets = createE2eTargetRegistry({destructive:true,prefix:'codedb_mongosh_adv'});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function attendi(fn, ms=90000) {
  const end=Date.now()+ms;
  while(Date.now()<end) { const result=await fn(); if(result) return result; await sleep(250); }
  throw new Error('Condizione non raggiunta entro il termine');
}
async function verifica(url) {
  const socket=io(url,{reconnection:false}), events=[], clients=[];
  socket.on('mongosh:event',e=>events.push(e));
  const emit=(event,payload)=>new Promise((resolve,reject)=>socket.timeout(100000).emit(event,payload,(err,r)=>err?reject(err):resolve(r)));
  let checks=0;
  try {
    await new Promise((r,j)=>{socket.once('connect',r);socket.once('connect_error',j);});
    async function ambiente(tabId,uri) {
      const db=targets.target(tabId), client=new MongoClient(uri); await client.connect(); clients.push({client,db});
      const c=await emit('mongo:connect',{tabId,dbType:'mongodb',uri}); assert.equal(c.ok,true,c.error);
      const q=async code=>{const r=await emit('query:execute',{tabId,db,code,engine:'mongosh',runId:`adv-${checks++}`});assert.equal(r.ok,true,`${code}\n${r.error}`);return r;};
      return {db,client,q};
    }
    const atlasUri='mongodb://127.0.0.1:27059/?directConnection=true';
    const atlas=await ambiente('atlas',atlasUri);
    console.log('Atlas Local MongoDB', (await atlas.client.db('admin').command({buildInfo:1})).version);
    await atlas.q('db.documenti.insertMany([{_id:1,testo:"gatto nero",v:[1,0,0]},{_id:2,testo:"cane bianco",v:[0,1,0]},{_id:3,testo:"gatto bianco",v:[0.9,0.1,0]}])');
    await atlas.q('db.documenti.createSearchIndex("testo", {mappings:{dynamic:true}})');
    await atlas.q('db.documenti.createSearchIndex("vettori", "vectorSearch", {fields:[{type:"vector",path:"v",numDimensions:3,similarity:"cosine"}]})');
    await attendi(async()=>{
      const indexes=(await atlas.q('db.documenti.getSearchIndexes()')).data;
      return indexes.length===2&&indexes.every(i=>i.queryable);
    });
    const text=await atlas.q('db.documenti.aggregate([{$search:{index:"testo",text:{query:"gatto",path:"testo"}}},{$sort:{_id:1}},{$project:{_id:1}}]).toArray()');
    assert.deepEqual(text.data,[{_id:1},{_id:3}]);
    const vector=await atlas.q('db.documenti.aggregate([{$vectorSearch:{index:"vettori",path:"v",queryVector:[1,0,0],numCandidates:3,limit:2}},{$project:{_id:1,score:{$meta:"vectorSearchScore"}}}]).toArray()');
    assert.deepEqual(vector.data.map(r=>r._id),[1,3]); assert(vector.data[0].score>vector.data[1].score);
    await atlas.q('db.documenti.updateSearchIndex("testo",{mappings:{dynamic:false,fields:{testo:{type:"string"}}}})');
    await attendi(async()=>(await atlas.q('db.documenti.getSearchIndexes("testo")')).data.some(i=>i.latestDefinition?.mappings?.dynamic===false));
    await atlas.q('db.documenti.dropSearchIndex("testo"); db.documenti.dropSearchIndex("vettori")');
    await attendi(async()=>(await atlas.q('db.documenti.getSearchIndexes()')).data.length===0);
    console.log('OK Atlas Local: indici Search/Vector, ricerca testuale, similarità, aggiornamento e rimozione');

    const sh=await ambiente('sharding','mongodb://127.0.0.1:27063/');
    await sh.q(`sh.enableSharding(${JSON.stringify(sh.db)},"shardA"); db.eventi.createIndex({k:1}); sh.shardCollection(${JSON.stringify(sh.db+'.eventi')},{k:1})`);
    await sh.q(`sh.splitAt(${JSON.stringify(sh.db+'.eventi')},{k:0})`);
    await sh.q('db.eventi.insertMany([{_id:1,k:-1},{_id:2,k:1}])');
    const stream=await sh.q('db.eventi.watch([],{maxAwaitTimeMS:100,fullDocument:"updateLookup"})'); assert(stream.streamId);
    await sh.q(`sh.moveChunk(${JSON.stringify(sh.db+'.eventi')},{k:1},"shardB")`);
    const meta=await sh.client.db('config').collection('collections').findOne({_id:sh.db+'.eventi'});
    const chunks=await sh.client.db('config').collection('chunks').find({uuid:meta.uuid}).toArray();
    assert.deepEqual([...new Set(chunks.map(c=>c.shard))].sort(),['shardA','shardB']);
    await sh.q('db.eventi.updateOne({_id:1,k:-1},{$set:{prova:true}}); db.eventi.updateOne({_id:2,k:1},{$set:{prova:true}})');
    await attendi(()=>[1,2].every(id=>events.some(e=>e.id===stream.streamId&&e.document?.documentKey?._id===id&&e.document.operationType==='update'&&e.document.fullDocument.prova===true)),20000);
    const token=events.filter(e=>e.id===stream.streamId&&e.document).at(-1).resumeToken; assert(token);
    assert.equal((await emit('mongosh:closeStream',{tabId:'sharding',id:stream.streamId})).ok,true);
    await sh.q('db.eventi.insertOne({_id:3,k:2})');
    const resumed=await sh.q(`db.eventi.watch([],{resumeAfter:EJSON.deserialize(${JSON.stringify(token)}),maxAwaitTimeMS:100})`);
    await attendi(()=>events.some(e=>e.id===resumed.streamId&&e.document?.documentKey?._id===3),20000);
    assert.equal((await emit('mongosh:closeStream',{tabId:'sharding',id:resumed.streamId})).ok,true);
    await sh.q(`const sessione=db.getMongo().startSession(); sessione.startTransaction(); const tx=sessione.getDatabase(${JSON.stringify(sh.db)}); tx.eventi.updateOne({k:-1},{$set:{tx:true}}); tx.eventi.updateOne({k:1},{$set:{tx:true}}); sessione.commitTransaction(); sessione.endSession()`);
    assert.equal(await sh.client.db(sh.db).collection('eventi').countDocuments({tx:true}),2);
    await sh.q('sh.status()');
    console.log('OK sharding: due shard, split/migrazione reale, stream su entrambi, resume e transazione distribuita');

    const fleUri='mongodb://127.0.0.1:27066/';
    const fle=await ambiente('csfle',fleUri);
    await fle.q(`const opzioni={keyVaultNamespace:${JSON.stringify(fle.db+'.chiavi')},kmsProviders:{local:{key:Buffer.alloc(96,42)}},explicitEncryptionOnly:true}; const cifrato=new Mongo(${JSON.stringify(fleUri)},opzioni); const chiave=cifrato.getKeyVault().createKey("local"); const crittografia=cifrato.getClientEncryption(); const segreto=crittografia.encrypt(chiave,"dato riservato","AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic"); db.espliciti.insertOne({_id:1,segreto})`);
    const stored=await fle.client.db(fle.db).collection('espliciti').findOne({_id:1});
    assert.equal(stored.segreto._bsontype,'Binary'); assert.equal(stored.segreto.sub_type,6);
    assert.equal((await fle.q('crittografia.decrypt(db.espliciti.findOne({_id:1}).segreto)')).data[0].valore,'dato riservato');
    await fle.q(`const errato=new Mongo(${JSON.stringify(fleUri)},{...opzioni,kmsProviders:{local:{key:Buffer.alloc(96,43)}}}); let rifiutata=false; try { errato.getClientEncryption().decrypt(db.espliciti.findOne({_id:1}).segreto) } catch(e) { rifiutata=true; } if(!rifiutata) throw new Error("Decifratura riuscita con chiave errata")`);
    const trovato=await fle.q(`const automatico=new Mongo(${JSON.stringify(fleUri)},{keyVaultNamespace:opzioni.keyVaultNamespace,kmsProviders:opzioni.kmsProviders,schemaMap:{[${JSON.stringify(fle.db+'.automatici')}]:{bsonType:"object",properties:{segreto:{encrypt:{keyId:[chiave],bsonType:"string",algorithm:"AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic"}}}}}}); const dati=automatico.getDB(${JSON.stringify(fle.db)}); dati.automatici.insertOne({_id:1,segreto:"cifratura automatica"}); dati.automatici.findOne({segreto:"cifratura automatica"})`);
    assert.deepEqual(trovato.data,[{_id:1,segreto:'cifratura automatica'}]);
    assert.equal((await fle.q('dati.automatici.findOne({_id:1}).segreto')).data[0].valore,'cifratura automatica');
    const auto=await fle.client.db(fle.db).collection('automatici').findOne({_id:1}); assert.equal(auto.segreto.sub_type,6);
    if(process.env.CODEDB_MONGOSH_CRYPT_SHARED_LIB_PATH) {
      const lib=await fle.q('automatico._serviceProvider.getRawClient().autoEncrypter.cryptSharedLibVersionInfo.versionStr');
      assert.match(lib.data[0].valore,/\d+\.\d+/); console.log('OK libreria crypt_shared effettivamente caricata:',lib.data[0].valore);
    }
    console.log('OK CSFLE: key vault, cifratura esplicita/automatica, query cifrata, dati BSON cifrati sul server, chiave errata rifiutata');
    console.log(`PASS ${checks} esecuzioni reali avanzate`);
    return {checks};
  } finally {
    socket.disconnect();
    for(const {client,db} of clients) { await targets.drop(db,name=>client.db(name).dropDatabase()); await client.close(); }
  }
}
if(require.main===module) {
  let server;
  (async()=>{server=await startTestServer({port:3199,env:{
    CODEDB_MONGOSH_MONGOCRYPTD_URI:'mongodb://127.0.0.1:27065',
    NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --require=./test/fixtures/mongosh-mutante.cjs`,
  }});await verifica(server.url);})()
    .catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await server?.stop();});
}
module.exports={verifica};
