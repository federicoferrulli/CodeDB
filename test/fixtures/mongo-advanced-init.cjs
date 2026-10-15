'use strict';
const { MongoClient } = require('mongodb');
async function ready(uri, callback) {
  const end = Date.now()+90000;
  while(Date.now()<end) {
    const client = new MongoClient(uri,{serverSelectionTimeoutMS:1000});
    try { await client.connect(); const result=await callback(client); if(result!==false) return; }
    catch(err) { if(Date.now()+1500>=end) throw err; }
    finally { await client.close(); }
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error('Fixture MongoDB non pronta');
}
(async()=>{
  for(const [name,host,port,configsvr] of [['config','config',27060,true],['shardA','shard-a',27061,false],['shardB','shard-b',27062,false]]) {
    await ready(`mongodb://127.0.0.1:${port}/?directConnection=true`,async client=>{
      const admin=client.db('admin');
      try { await admin.command({replSetGetStatus:1}); }
      catch(err) { if(err.code!==94) throw err; await admin.command({replSetInitiate:{_id:name,configsvr,members:[{_id:0,host:`${host}:${port}`} ]}}); }
      return (await admin.command({hello:1})).isWritablePrimary;
    });
    console.log('Pronto replica set '+name);
  }
  await ready('mongodb://127.0.0.1:27063',async client=>{
    const admin=client.db('admin');
    for(const spec of ['shardA/shard-a:27061','shardB/shard-b:27062']) await admin.command({addShard:spec});
    console.log('Shard effettivi:',(await admin.command({listShards:1})).shards.map(s=>s._id));
  });
  await ready('mongodb://127.0.0.1:27059/?directConnection=true',async client=>{
    await client.db('admin').command({ping:1}); console.log('Pronto Atlas Local');
  });
  for(const port of [27065,27066]) await ready(`mongodb://127.0.0.1:${port}/`,async client=>{
    await client.db('admin').command({hello:1}); console.log('Pronto servizio CSFLE '+port);
  });
})().catch(err=>{console.error(err.message);process.exitCode=1;});
