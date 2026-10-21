'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {runBackup} = require('../backup/lib/engine');
const {runRestore} = require('../backup/lib/restore');
const log = {info(){},error(){}};
(async()=>{
  for(const type of ['mysql','postgresql']) {
    const mysql=type==='mysql', port=Number(process.env[mysql?'EXPORT_MYSQL_PORT':'EXPORT_PG_PORT']);assert(port,'Porta isolata obbligatoria');
    const st=new(require(`../db/${mysql?'MySql':'PostgreSql'}Strategy`))();
    await st.connect({host:'127.0.0.1',port,username:mysql?'root':'postgres',password:require('./lab/credenziali.cjs')(mysql?'mysql':'postgresql'),database:mysql?'':'postgres'});
    const conn=mysql?await st.pool.getConnection():await st.pool.connect();
    if(process.argv.includes('--mutant') && mysql) {
      const original=st.pool.getConnection.bind(st.pool);
      st.pool.getConnection=async()=>{const c=await original(),query=c.query.bind(c);c.query=(sql,...args)=>/^DELETE FROM/.test(sql)?Promise.resolve([{affectedRows:0}]):query(sql,...args);return c;};
    }
    const q=async(s,p)=>{const r=await conn.query(s,p);return mysql?r[0]:r.rows;};
    const source='codedb_keys_'+crypto.randomBytes(6).toString('hex'), target=source+'_copy';
    const quote=n=>(mysql?'`':'"')+n+(mysql?'`':'"');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-keys-'));
    const drop=db=>q(mysql?`DROP DATABASE IF EXISTS ${quote(db)}`:`DROP SCHEMA IF EXISTS ${quote(db)} CASCADE`);
    const use=db=>q(mysql?`USE ${quote(db)}`:`SET search_path TO ${quote(db)},public`);
    const snapshot=async db=>{await use(db);return {
      bin:await q(`SELECT ${mysql?'HEX(id)':"encode(id,'hex')"} AS id,value FROM bin ORDER BY id`),
      enums:await q(`SELECT ${mysql?'CAST(id AS UNSIGNED)':'id::text'} AS id,value FROM enums ORDER BY id`)
    };};
    try {
      await q(mysql?`CREATE DATABASE ${quote(source)} CHARACTER SET utf8mb4`:`CREATE SCHEMA ${quote(source)}`);await use(source);
      if(!mysql)await q("CREATE TYPE label AS ENUM('z','a','','🦊')");
      await q(`CREATE TABLE bin(id ${mysql?'VARBINARY(8)':'bytea'} PRIMARY KEY,value TEXT)`);
      await q(`CREATE TABLE enums(id ${mysql?"ENUM('z','a','','🦊')":'label'} PRIMARY KEY,value TEXT)`);
      await q(`INSERT INTO bin VALUES(${mysql?"X'0001'":"decode('0001','hex')"},'prima'),(${mysql?"X'FF00'":"decode('ff00','hex')"},'seconda')`);
      await q("INSERT INTO enums VALUES('z','prima'),('','vuoto'),('a','seconda')");
      await runBackup({session:{strategy:st,dbType:type},connName:'keys',db:source,type:'full',destRoot:root,compress:true,log});
      await q(`DELETE FROM bin WHERE id=${mysql?"X'0001'":"decode('0001','hex')"}`);await q("UPDATE bin SET value='modificata'");
      await q("DELETE FROM enums WHERE id='z'");await q("UPDATE enums SET value='modificata' WHERE id='a'");
      await q("INSERT INTO enums VALUES('🦊','nuova')");
      const inc=await runBackup({session:{strategy:st,dbType:type},connName:'keys',db:source,type:'incremental',destRoot:root,compress:true,log});
      await runRestore({session:{strategy:st,dbType:type},backupDir:inc.backupDir,targetDb:target,drop:true,log});
      assert.deepEqual(await snapshot(target),await snapshot(source),'identità binarie ed ENUM: aggiornamenti e cancellazioni esatti');
      console.log(`OK ${type}: backup incrementale con PK binarie ed ENUM, vuoti, Unicode, upsert e cancellazioni.`);
    } finally {await drop(target);await drop(source);conn.release();await st.disconnect();fs.rmSync(root,{recursive:true,force:true});}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
