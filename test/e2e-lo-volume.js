'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
  const port=Number(process.env.EXPORT_PG_PORT);assert(port,'Porta PostgreSQL isolata obbligatoria');
  const st=new(require('../db/PostgreSqlStrategy'))();await st.connect({host:'127.0.0.1',port,username:'postgres',password:require('./lab/credenziali.cjs')('postgresql'),database:'postgres'});
  const db='codedb_lo_volume_'+crypto.randomBytes(6).toString('hex'),target=db+'_copy';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-lo-volume-')),ids=[];
  let timer;
  try {
    await st.pool.query(`CREATE SCHEMA "${db}";CREATE TABLE "${db}".files(id integer PRIMARY KEY,file oid)`);
    const id=String((await st.pool.query('SELECT lo_create(0) AS id')).rows[0].id);ids.push(id);
    const chunk=crypto.randomBytes(1024*1024),expected=crypto.createHash('sha256');
    const size=128*chunk.length;
    for(let i=0;i<128;i++){chunk.writeUInt32LE(i);expected.update(chunk);await st.pool.query('SELECT lo_put($1::oid,$2::bigint,$3::bytea)',[id,String(i*chunk.length),chunk]);}
    await st.pool.query(`INSERT INTO "${db}".files VALUES(1,$1::oid)`,[id]);
    global.gc?.();const baseline=process.memoryUsage().rss;let peak=baseline;
    timer=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),20);
    const start=performance.now(),log={info(){},error(){}};
    const b=await require('../backup/lib/engine').runBackup({session:{strategy:st,dbType:'postgresql'},connName:'lo-volume',db,type:'full',destRoot:root,compress:false,log});
    const r=await require('../backup/lib/restore').runRestore({session:{strategy:st,dbType:'postgresql'},backupDir:b.backupDir,targetDb:target,drop:true,log});ids.push(...r.largeObjects);
    const copy=(await st.pool.query(`SELECT file::text AS id FROM "${target}".files`)).rows[0].id;
    const actual=crypto.createHash('sha256');
    for(let offset=0;offset<size;offset+=chunk.length)actual.update((await st.pool.query('SELECT lo_get($1::oid,$2::bigint,$3::integer) AS data',[copy,String(offset),chunk.length])).rows[0].data);
    assert.equal(actual.digest('hex'),expected.digest('hex'),'128 MiB: hash di tutti i byte, senza caricare il file intero');
    const report={bytes:size,elapsedMs:Math.round(performance.now()-start),rssBaseline:baseline,rssPeak:peak,rssIncrement:peak-baseline,sha256Identico:true};
    fs.mkdirSync('test-reports/import-export-2026-10-12',{recursive:true});fs.writeFileSync('test-reports/import-export-2026-10-12/large-object-volume.json',JSON.stringify(report,null,2));console.log(report);
  } finally {
    clearInterval(timer);await st.pool.query(`DROP SCHEMA IF EXISTS "${target}" CASCADE;DROP SCHEMA IF EXISTS "${db}" CASCADE`);
    for(const id of ids)await st.pool.query('SELECT lo_unlink($1::oid)',[id]);await st.disconnect();fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
