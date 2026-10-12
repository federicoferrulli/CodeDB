'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {leggiCatalogoExport}=require('../db/exportCatalogo');
const {creaPianoExport}=require('../db/exportPlan');
const {esportaDatabase}=require('../db/databaseExport');
const {runBackup}=require('../backup/lib/engine');
const {runRestore}=require('../backup/lib/restore');
if(process.argv.includes('--mutant')) {
  const topology=require('../db/mongoTopologia'),original=topology.apriLettura;
  topology.apriLettura=async client=>({...await original(client),options:{}});
}
(async()=>{
  const port=Number(process.env.EXPORT_MONGO_RS_PORT);assert(port,'Replica set usa-e-getta obbligatorio');
  const st=new(require('../db/MongoDbStrategy'))();await st.connect({uri:`mongodb://127.0.0.1:${port}/?directConnection=true`});
  const db='codedb_snapshot_'+crypto.randomBytes(6).toString('hex'),copy=db+'_copy';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-snapshot-'));
  const coll=n=>st.client.db(db).collection(n);
  try {
    for(const c of ['a','b'])await coll(c).insertOne({_id:1,value:'prima'});
    const catalogo=await leggiCatalogoExport(st,'mongodb',db);
    const plan=creaPianoExport({catalogo:{...catalogo,db,dbType:'mongodb'},connection:'test',formato:'codedb-json'});
    let content='',changed=false;
    await esportaDatabase({strategy:st,plan,write:async part=>{
      content+=part;
      if(!changed && part.includes('"bson":')) {changed=true;await coll('b').updateOne({_id:1},{$set:{value:'durante export'}});}
    }});
    const artifact=JSON.parse(content);
    assert.match(artifact.consistenza,/snapshot unica/);
    assert.equal(require('bson').deserialize(require('../db/mongoBson').decode(artifact.collections.find(c=>c.name==='b').docs[0])).value,'prima','tutte le collection leggono lo stesso istante');
    await coll('b').updateOne({_id:1},{$set:{value:'prima'}});
    let pendingWrite;
    const log={info(message){if(message.startsWith('  a:'))pendingWrite=coll('b').updateOne({_id:1},{$set:{value:'durante backup'}});},error(){}};
    const b=await runBackup({session:{strategy:st,dbType:'mongodb'},connName:'snapshot',db,type:'full',destRoot:root,compress:true,log});
    assert(pendingWrite,'la prova deve avere avviato una scrittura concorrente');await pendingWrite;
    assert.equal((await coll('b').findOne({_id:1})).value,'durante backup');
    await runRestore({session:{strategy:st,dbType:'mongodb'},backupDir:b.backupDir,targetDb:copy,drop:true,log:{info(){},error(){}}});
    assert.equal((await st.client.db(copy).collection('b').findOne({_id:1})).value,'prima');
    assert.equal(JSON.parse(fs.readFileSync(path.join(b.backupDir,'manifest.json'))).coerenza.snapshot,true);
    console.log('OK MongoDB replica set: export e backup usano una snapshot unica anche con scritture concorrenti.');
  } finally {await st.client.db(db).dropDatabase();await st.client.db(copy).dropDatabase();await st.disconnect();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
