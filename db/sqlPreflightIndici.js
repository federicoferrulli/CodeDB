'use strict';
const {randomUUID}=require('node:crypto');
// MongoDB abortisce la transazione anche su E11000: gli indici multikey e
// speciali vengono provati dal server su una copia dello snapshot corrente.
function necessario(row,indexes) {
  function arrayAt(value,path) {
    if(Array.isArray(value)) return true;
    if(!path.length || value==null) return false;
    return arrayAt(value[path[0]],path.slice(1));
  }
  return indexes.some(i=>Object.entries(i.key).some(([key,mode])=>typeof mode!=='number' || arrayAt(row,key.split('.'))));
}
async function verifica(database,collection,row,info,indexes,options,collect,condition,previous) {
  const name='_codedb_sql_probe_'+randomUUID().replaceAll('-','');
  let created=false;
  try {
    await database.createCollection(name,info.options?.collation?{collation:info.options.collation}:{}); created=true;
    const probe=database.collection(name);
    const specs=indexes.filter(i=>i.name!=='_id_').map(({v,ns,background,expireAfterSeconds,...spec})=>spec);
    if(specs.length) await probe.createIndexes(specs,{commitQuorum:'majority'});
    const rows=await collect(collection.find({_id:{$ne:previous?._id ?? row._id}},{...options,raw:true}));
    for(const raw of rows) await require('./mongoBson').scriviRaw(database,name,raw,{});
    if(previous) await probe.insertOne(previous);
    try {if(previous) await probe.replaceOne({_id:previous._id},row); else await probe.insertOne(row);}
    catch(error) {
      const state={11000:'23505',66:'22000',16755:'22000',171:'22000'}[error.code];
      if(state) throw Object.assign(condition(error.message,state),{cause:error,code:error.code,codeName:error.codeName});
      throw error;
    }
  } finally {
    if(created) for(let attempt=0;;attempt++) {
      try {await database.collection(name).drop();break;}
      catch(error) {
        // DROP non è retryable nel driver. Il nome è univoco della sola prova:
        // dopo una risposta incerta, NamespaceNotFound conferma già la pulizia.
        if(error.code===26) break;
        const transient=[91,189,10107,11600,11602,13435,13436].includes(error.code) || error instanceof require('mongodb').MongoNetworkError;
        if(!transient || attempt>=2) throw error;
      }
    }
  }
}
module.exports={necessario,verifica};
