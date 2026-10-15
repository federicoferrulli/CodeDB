'use strict';
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const MongoDbStrategy=require('../db/MongoDbStrategy');
const {MongoshRuntime}=require('../db/mongoshRuntime');
const uri='mongodb://codedb%40CODEDB.TEST@mongo.kerberos.test:27017/?authMechanism=GSSAPI&authSource=%24external';
const db='codedb_kerberos_fixture';
(async()=>{
  const strategy=new MongoDbStrategy(); let runtime;
  try {
    await strategy.connect({uri});
    console.log('OK connessione iniziale CodeDB con ticket MIT Kerberos reale');
    runtime=new MongoshRuntime(uri); await runtime.ready;
    const q=code=>runtime.evaluate(code,db);
    const auth=await q('db.runCommand({connectionStatus:1}).authInfo.authenticatedUsers');
    assert.deepEqual(auth.docs,[{user:'codedb@CODEDB.TEST',db:'$external'}]);
    await q('db.prova.insertOne({_id:1,testo:"Kerberos"})');
    assert.equal((await q('db.prova.findOne({_id:1}).testo')).docs[0].valore,'Kerberos');
    await q('db.prova.updateOne({_id:1},{$set:{testo:"GSSAPI"}})');
    assert.equal((await q('db.prova.findOne({_id:1}).testo')).docs[0].valore,'GSSAPI');
    await q('db.dropDatabase()');
    console.log('OK runtime mongosh autenticato GSSAPI, identità verificata e CRUD');
  } finally { await runtime?.close(); await strategy.disconnect(); }
  execFileSync('kdestroy');
  const invalid=new MongoshRuntime(uri,{timeout:15000});
  try { await assert.rejects(invalid.ready,/credential|Kerberos|GSSAPI|ticket/i); }
  finally { await invalid.close(); }
  console.log('OK nuova connessione rifiutata senza ticket Kerberos');
})().catch(e=>{console.error(e);process.exitCode=1;});
