'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EJSON}=require('bson'),{runBackup}=require('../backup/lib/engine'),{runRestore}=require('../backup/lib/restore');
(async()=>{
  for(const mysql of [true,false]){
    const type=mysql?'mysql':'postgresql',port=Number(process.env[mysql?'EXPORT_MYSQL_PORT':'EXPORT_PG_PORT']);assert(port,'Porta isolata obbligatoria');
    const st=new(require(`../db/${mysql?'MySql':'PostgreSql'}Strategy`))();await st.connect({host:'127.0.0.1',port,username:mysql?'root':'postgres',database:mysql?'':'postgres'});
    const source='codedb_pages_'+crypto.randomBytes(8).toString('hex'),target=source+'_copy',root=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-pages-'));
    const quote=n=>require('../db/identificatori').quotaSempre(n,type),q=async(s,p)=>{const r=await st.pool.query(s,p);return mysql?r[0]:r.rows;},drop=db=>q(mysql?`DROP DATABASE IF EXISTS ${quote(db)}`:`DROP SCHEMA IF EXISTS ${quote(db)} CASCADE`),log={info(){}};
    try{
      await q(mysql?`CREATE DATABASE ${quote(source)}`:`CREATE SCHEMA ${quote(source)}`);
      for(const [table,definition]of [['num','INT PRIMARY KEY'],['bin',mysql?'VARBINARY(8) PRIMARY KEY':'bytea PRIMARY KEY'],['duplicates','INT']]){
        await q(`CREATE TABLE ${quote(source)}.${quote(table)}(id ${definition},n INT)`);
        for(let i=0;i<1601;i+=500){const docs=Array.from({length:Math.min(500,1601-i)},(_,j)=>({id:table==='bin'?{$binary:{base64:Buffer.from((i+j).toString(16).padStart(8,'0'),'hex').toString('base64'),subType:'00'}}:table==='duplicates'?7:i+j,n:table==='duplicates'?7:i+j}));assert.equal((await st.collectionImport(source,table,{docs})).inserted,docs.length);}
        if(table!=='duplicates'){
          let after=null;const rows=[];
          for(let page=0;page<10;page++){
            const result=await st.collectionExport(source,table,{format:'json',limit:500,after});
            rows.push(...result.lines.map(l=>EJSON.parse(l)));if(result.count<500)break;after=result.nextAfter;
          }
          assert.deepEqual(rows.map(r=>Number(r.n)),Array.from({length:1601},(_,i)=>i),`${type} ${table}: pagine ordinate sui tipi originali, senza omissioni o duplicati`);
        }
      }
      if(!mysql)await q(`CREATE FUNCTION "${source}".f(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';CREATE FUNCTION "${source}".f(text) RETURNS text LANGUAGE sql AS 'SELECT $1';CREATE TABLE "${source}".refs(id int PRIMARY KEY,r regproc);INSERT INTO "${source}".refs VALUES(1,'${source}.f(integer)'::regprocedure::oid)`);
      if(process.argv.includes('--mutant')&&!mysql){const connect=st.pool.connect.bind(st.pool);st.pool.connect=(...args)=>args.length?connect(...args):connect().then(c=>{if(!c._codedbMutant){c._codedbMutant=true;const query=c.query.bind(c);c.query=(s,...p)=>/^FETCH FORWARD .*codedb_backup_rows/.test(s)?query(s,...p).then(r=>{r.rows.pop();return r;}):query(s,...p);}return c;});}
      const b=await runBackup({session:{strategy:st,dbType:type},connName:'pages',db:source,type:'full',destRoot:root,compress:true,log});
      await runRestore({session:{strategy:st,dbType:type},backupDir:b.backupDir,targetDb:target,drop:true,log});
      for(const table of ['num','bin','duplicates'])assert.equal(Number((await q(`SELECT COUNT(*) AS n FROM ${quote(target)}.${quote(table)}`))[0].n),1601,'tutte le righe, anche duplicate senza PK, sopravvivono');
      if(!mysql)assert.equal((await q(`SELECT r::oid::regprocedure::text AS r FROM "${target}".refs`))[0].r,`${target}.f(integer)`,'routine senza tipi custom pronta prima dei dati');
      console.log(`OK ${type}: 1601 righe con chiavi numeriche/binarie e senza chiave, export paginato e backup.`);
    }finally{await drop(target);await drop(source);await st.disconnect();fs.rmSync(root,{recursive:true,force:true});}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
