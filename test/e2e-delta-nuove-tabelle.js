'use strict';
const assert = require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const { createE2eTargetRegistry }=require('./e2e-harness');
const { runBackup }=require('../backup/lib/engine');
const { runRestore }=require('../backup/lib/restore');
const quiet={info(){},error(){}};
async function prova(type) {
  const pg=type==='postgresql', Strategy=require(pg?'../db/PostgreSqlStrategy':'../db/MySqlStrategy');
  const strategy=new Strategy(), session={dbType:type,strategy};
  const targets=createE2eTargetRegistry({destructive:true,prefix:'codedb_delta'});
  const source=targets.target('fonte'), destRoot=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-tabelle-'));
  const q=name=>(pg?'"':'\u0060')+name+(pg?'"':'\u0060');
  const sql=(db,s)=>strategy.pool.query(s.replaceAll('@',q(db)+'.'));
  try {
    targets.assertOwned(source);
    await strategy.connect(pg?{host:process.env.PGHOST||'127.0.0.1',port:Number(process.env.PGPORT||5432),
      database:process.env.PGDATABASE||'postgres',username:process.env.PGUSER||'postgres',password:process.env.PGPASSWORD||''}
      :{host:process.env.MYSQL_HOST||'127.0.0.1',port:Number(process.env.MYSQL_PORT||3306),
        username:process.env.MYSQL_USER||'root',password:process.env.MYSQL_PASSWORD||''});
    await strategy.createDatabase(source);
    await sql(source,'CREATE TABLE @padri (id INT PRIMARY KEY)');
    await sql(source,'INSERT INTO @padri VALUES (1)');
    const args={session,db:source,connName:'delta',destRoot,log:quiet,compress:false};
    await runBackup({...args,type:'full'});
    await sql(source,'CREATE TABLE @figli (id INT PRIMARY KEY, pid INT, CONSTRAINT relazione FOREIGN KEY (pid) REFERENCES @padri(id))');
    await sql(source,'CREATE INDEX indice_padre ON @figli(pid)');
    await sql(source,'INSERT INTO @figli VALUES (2,1)');
    const delta=await runBackup({...args,type:'incremental'});
    for (const mode of ['vuota','merge','sostituisci','storico']) {
      if (mode === 'storico') {
        // I manifest precedenti all'inventario contengono già la DDL della tabella.
        for(const entry of fs.readdirSync(path.dirname(delta.backupDir),{withFileTypes:true})) if(entry.isDirectory()){
          const file=path.join(path.dirname(delta.backupDir),entry.name,'manifest.json');if(!fs.existsSync(file))continue;
          const manifest=JSON.parse(fs.readFileSync(file)); delete manifest.entityInventory; manifest.version=Math.min(manifest.version,5);
          fs.writeFileSync(file,JSON.stringify(manifest));
        }
      }
      const db=targets.target(mode);
      if (mode==='merge'||mode==='sostituisci') {
        await strategy.createDatabase(db);
        await sql(db,'CREATE TABLE @figli (id INT PRIMARY KEY, pid INT)');
        await sql(db,'INSERT INTO @figli VALUES (8,NULL),(2,NULL)');
      }
      const r=await runRestore({session,backupDir:delta.backupDir,targetDb:db,drop:mode!=='merge',log:quiet});
      assert.equal(r.totalDocs,mode==='merge'?3:2);
      const res=await sql(db,'SELECT id,pid FROM @figli ORDER BY id');
      const rows=pg?res.rows:res[0];
      assert.deepEqual(rows.map(x=>[Number(x.id),x.pid===null?null:Number(x.pid)]),mode==='merge'?[[2,1],[8,null]]:[[2,1]]);
      await assert.rejects(sql(db,'INSERT INTO @figli VALUES (10,99)'),/foreign key|vincolo/i);
      const ind=pg ? (await strategy.pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='figli'",[db])).rows.map(x=>x.indexname)
        :(await sql(db,'SHOW INDEX FROM @figli'))[0].map(x=>x.Key_name);
      assert.ok(ind.includes('indice_padre'),JSON.stringify(ind));
      if (mode === 'vuota') {
        const pubblicato = targets.target('piano');
        const piano = await require('../db/backupRestoreAdapter').runRestoreViaPlan({ session,backupDir:delta.backupDir,targetDb:pubblicato,
          drop:true,log:quiet,recoveryRoot:path.join(destRoot,'recupero') });
        assert.equal(piano.status,'completato',JSON.stringify(piano));assert.equal(piano.totalDocs,2);
      }
      console.log(type,mode,'OK');
    }
  } finally {
    try {if(strategy.pool)await targets.cleanup(name=>strategy.pool.query((pg?'DROP SCHEMA IF EXISTS ':'DROP DATABASE IF EXISTS ')+q(name)+(pg?' CASCADE':'')));}
    finally {await strategy.disconnect();fs.rmSync(destRoot,{recursive:true,force:true});}
  }
}
(async()=>{for(const t of ['postgresql','mysql'])await prova(t);})().catch(e=>{console.error(e);process.exitCode=1;});
