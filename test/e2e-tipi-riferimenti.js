'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {roundtripJson}=require('./e2e-export-formati');
const aliases=require('../db/pg-alias'),refs=require('../db/pg-references');
if(process.argv.includes('--mutant')) {process.env.CODEDB_TEST_TYPE_FAULT='nested';process.env.NODE_OPTIONS=`--require "${path.join(__dirname,'fault-tipi.cjs').replace(/\\/g,'/')}"`;}
(async()=>{
  const port=Number(process.env.EXPORT_PG_PORT);assert(port,'Porta usa-e-getta obbligatoria');
  const st=new(require('../db/PostgreSqlStrategy'))();await st.connect({host:'127.0.0.1',port,username:'postgres',password:require('./lab/credenziali.cjs')('postgresql'),database:'postgres'});
  const source='codedb_refs_'+crypto.randomBytes(8).toString('hex'),target=source+'_copy',root=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-refs-'));
  const q=(s,p)=>st.pool.query(s,p),drop=db=>q(`DROP SCHEMA IF EXISTS "${db}" CASCADE`),log={info(){}};
  const snapshot=async db=>{
    const info=await st.tableColumnsInfo(db,'data'),shapes=await refs.columnReferences(q,db,'data');aliases.attach(info.columns,shapes);
    const rows=(await q(`SELECT ${require('../db/sqlTransfer').projection(info,false)} FROM "${db}".data ORDER BY id`)).rows;
    return rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v?.refs?{text:v.text.replaceAll(db,source),refs:v.refs.map(r=>({...r,value:r.value.replaceAll(db,source)}))}:typeof v==='string'?v.replaceAll(db,source):v])));
  };
  try{
    await q(`CREATE SCHEMA "${source}";CREATE DOMAIN "${source}".proc AS regproc;CREATE TYPE "${source}".pair AS (label text,p "${source}".proc,o regoper,more regproc[]);CREATE DOMAIN "${source}".pairs AS "${source}".pair[]`);
    await q(`CREATE FUNCTION "${source}".f(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';CREATE FUNCTION "${source}".f(text) RETURNS text LANGUAGE sql AS 'SELECT $1'`);
    await q(`CREATE TABLE "${source}".data(id int PRIMARY KEY,p "${source}".proc,ps "${source}".proc[],r "${source}".pair,rs "${source}".pairs)`);
    const proc=`'${source}.f(integer)'::regprocedure::oid`,other=`'abs(bigint)'::regprocedure::oid`,oper=`'+(integer,integer)'::regoperator::oid`;
    await q(`INSERT INTO "${source}".data VALUES(1,${proc},ARRAY[${proc},${other},NULL]::oid[]::"${source}".proc[],ROW('a,"%s🦊',${proc},${oper},ARRAY[${other},NULL]::oid[]::regproc[]),ARRAY[ROW('r',${proc},${oper},ARRAY[${other}]::oid[]::regproc[])::"${source}".pair,NULL,ROW(NULL,NULL,NULL,NULL)::"${source}".pair]);INSERT INTO "${source}".data(id) VALUES(2)`);
    const expected=await snapshot(source);
    for(const format of ['codedb-json','sql','backup']){
      if(format==='backup'){
        const b=await require('../backup/lib/engine').runBackup({session:{strategy:st,dbType:'postgresql'},connName:'refs',db:source,type:'full',destRoot:root,compress:true,log});
        await require('../backup/lib/restore').runRestore({session:{strategy:st,dbType:'postgresql'},backupDir:b.backupDir,targetDb:target,drop:true,log});
      }else await roundtripJson('postgresql',port,source,target,format);
      assert.deepEqual(await snapshot(target),expected,'domini e compositi: firma esatta degli overload, NULL, array e testo');await drop(target);
      console.log(`OK riferimenti annidati ${format}: domini, array di domini, compositi, domini su array di compositi, NULL e overload.`);
    }
    const info=await st.tableColumnsInfo(source,'data');aliases.attach(info.columns,await refs.columnReferences(q,source,'data'));
    const row=(await q(`SELECT ${require('../db/sqlTransfer').projection(info,false)} FROM "${source}".data WHERE id=1`)).rows[0];
    const encoded=aliases.encode(row,info.columns),literal=v=>"E'"+v.replace(/\\/g,'\\\\').replace(/'/g,"''")+"'";
    for(const col of ['ps','r','rs']){
      const result=(await q(`SELECT (${aliases.sqlNested(encoded[col],literal)})::text AS v`)).rows[0].v;
      assert.equal(result,row[col].text,'SQL esportato eseguibile anche direttamente sul server');
    }
  }finally{await drop(target);await drop(source);await st.disconnect();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
