'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { roundtripJson }=require('./e2e-export-formati');
if(process.argv.includes('--mutant')) { process.env.CODEDB_TEST_TYPE_FAULT='lo'; process.env.NODE_OPTIONS=`--require "${path.join(__dirname,'fault-tipi.cjs').replace(/\\/g,'/')}"`; }

(async()=>{
  const port=Number(process.env.EXPORT_PG_PORT);assert(port,'Porta PostgreSQL usa-e-getta obbligatoria.');
  const st=new(require('../db/PostgreSqlStrategy'))();await st.connect({host:'127.0.0.1',port,username:'postgres',database:'postgres'});
  const source='codedb_lo_'+crypto.randomBytes(8).toString('hex'),target=source+'_copy';
  const physicalDb=source+'_physical';let createdDb=false;
  const payload=crypto.randomBytes(1024*1024+137),created=[];
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-lo-'));
  const query=(sql,p)=>st.pool.query(sql,p);
  const cleanup=async name=>query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  try{
    // pg_dump --blobs include tutti i LO del database fisico, anche fuori schema.
    await query(`CREATE DATABASE "${physicalDb}"`);createdDb=true;await st.disconnect();
    await st.connect({host:'127.0.0.1',port,username:'postgres',database:physicalDb});
    await query(`CREATE SCHEMA "${source}"`);
    await query(`CREATE DOMAIN "${source}".lo_id AS oid; CREATE TYPE "${source}".ref_record AS (description text, file "${source}".lo_id, others oid[])`);
    await query(`CREATE TABLE "${source}".files (id INT PRIMARY KEY, file oid, files oid[], detail "${source}".ref_record, relation regclass)`);
    const id=String((await query('SELECT lo_from_bytea(0,$1::bytea) AS id',[payload])).rows[0].id);created.push(id);
    await query(`INSERT INTO "${source}".files VALUES(1,$1::oid,ARRAY[$1::oid,NULL,$1::oid],ROW('a," b', $1::oid, ARRAY[$1::oid]),$2::regclass)`,[id,`"${source}".files`]);
    for(const format of ['codedb-json','sql','backup',...(process.env.EXPORT_PG_CONTAINER?['pg_dump']:[])]){
      if(format==='backup') {
        const b=await require('../backup/lib/engine').runBackup({session:{strategy:st,dbType:'postgresql'},connName:'lo',db:source,type:'full',destRoot:root,compress:true,log:{info(){}}});
        await require('../backup/lib/restore').runRestore({session:{strategy:st,dbType:'postgresql'},backupDir:b.backupDir,targetDb:target,drop:true,log:{info(){}}});
      } else if(format==='pg_dump') {
        const dump=require('node:child_process').spawnSync('docker',['exec',process.env.EXPORT_PG_CONTAINER,'pg_dump','-U','postgres','--no-owner','--no-privileges','--blobs','--schema='+source,physicalDb],{encoding:'utf8',windowsHide:true,maxBuffer:128*1024*1024});
        assert.equal(dump.status,0,dump.stderr);
        await roundtripJson('postgresql',port,source,target,'sql',dump.stdout,physicalDb);
      } else await roundtripJson('postgresql',port,source,target,format,null,physicalDb);
      const r=(await query(`SELECT file::text AS file, files::text AS files, (detail).file::text AS nested, (detail).others::text AS others, (detail).description AS description, relation::text AS relation, lo_get(file) AS data FROM "${target}".files`)).rows[0];
      created.push(r.file);
      assert.notEqual(r.file,id,'la copia deve avere un Large Object indipendente dalla sorgente');
      assert.deepEqual(r.data,payload,'contenuto binario completo del Large Object');
      assert.equal(r.nested,r.file);assert.equal(r.files,`{${r.file},NULL,${r.file}}`);assert.equal(r.others,`{${r.file}}`);
      assert.equal(r.description,'a," b');assert.equal(r.relation,`${target}.files`);
      assert.deepEqual((await query('SELECT lo_get($1::oid) AS data',[id])).rows[0].data,payload,'sorgente intatta');
      await cleanup(target);
      console.log(`OK Large Objects ${format}: byte, OID nuovi, array, domini, compositi e riferimenti regclass.`);
    }
    await query('SELECT lo_put($1::oid,0,$2::bytea)',[id,Buffer.from([255,0,2])]);
    const delta=await require('../backup/lib/engine').runBackup({session:{strategy:st,dbType:'postgresql'},connName:'lo',db:source,type:'incremental',destRoot:root,compress:true,log:{info(){}}});
    const restored=await require('../backup/lib/restore').runRestore({session:{strategy:st,dbType:'postgresql'},backupDir:delta.backupDir,targetDb:target,drop:true,log:{info(){}}});
    created.push(...restored.largeObjects);
    assert.deepEqual((await query(`SELECT lo_get(file) AS data FROM "${target}".files`)).rows[0].data,(await query('SELECT lo_get($1::oid) AS data',[id])).rows[0].data,'incrementale: cambia anche il contenuto LO senza cambiare la riga');
    console.log('OK Large Objects incrementale: aggiornamento binario senza modificare la riga referente.');
    await cleanup(target);
    const extra=String((await query('SELECT lo_from_bytea(0,$1::bytea) AS id',[Buffer.from('altra tabella')])).rows[0].id);created.push(extra);
    await query(`CREATE TABLE "${source}".others(id integer PRIMARY KEY,file oid);INSERT INTO "${source}".others VALUES(1,${extra}::oid)`);
    const full=await require('../backup/lib/engine').runBackup({session:{strategy:st,dbType:'postgresql'},connName:'selected',db:source,type:'full',destRoot:root,compress:true,log:{info(){}}});
    const selected=await require('../backup/lib/restore').runRestore({session:{strategy:st,dbType:'postgresql'},backupDir:full.backupDir,targetDb:target,drop:true,onlyCollections:['files'],log:{info(){}}});
    created.push(...selected.largeObjects);assert.equal(selected.largeObjects.length,1,'il restore selettivo non copia Large Objects di tabelle escluse');
    console.log('OK Large Objects selettivo: copiati soltanto i binari delle tabelle richieste.');
    await cleanup(target);
    const artifact={formato:'codedb-database',versione:1,dbType:'postgresql',db:source,objects:{},largeObjects:[{oid:id,size:payload.length,chunks:[payload.toString('base64')]}],collections:[{name:'files',ddl:'CREATE TABLE files(id integer PRIMARY KEY CHECK(id>0),file oid)',identity:{kind:'primary-key',columns:['id']},docs:[{id:-1,file:id}]}]};
    const {creaPianoImport,eseguiPianoImport}=require('../db/importPlan');
    const plan=creaPianoImport({artifact,expectedDbType:'postgresql',connection:'lo',targetDb:target,drop:true});
    const adapter=require('../db/importArtifactAdapter').createImportArtifactAdapter({strategy:st,dbType:'postgresql',connName:'lo',recoveryRoot:root});
    const failed=await eseguiPianoImport(plan,{adapter});
    assert.notEqual(failed.status,'completato');assert.equal(failed.staging.largeObjects.length,1);
    const persisted=require('../db/importOperations').sanitizeImportResult(failed);assert.deepEqual(persisted.staging.largeObjects,failed.staging.largeObjects);
    await adapter.cleanup(persisted);
    assert.equal((await query('SELECT oid FROM pg_largeobject_metadata WHERE oid=ANY($1::oid[])',[persisted.staging.largeObjects])).rows.length,0,'nessun Large Object orfano dopo cleanup di un import fallito');
    assert.equal((await query('SELECT oid FROM pg_largeobject_metadata WHERE oid=$1::oid',[id])).rows.length,1,'il Large Object originale sopravvive alla pulizia');
    console.log('OK Large Objects errore: rifiuto del vincolo, journal e pulizia dei soli binari dello staging.');
  }finally{
    await st.disconnect();
    if(createdDb){await st.connect({host:'127.0.0.1',port,username:'postgres',database:'postgres'});try{await query(`DROP DATABASE "${physicalDb}"`);}finally{await st.disconnect();}}
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1});
