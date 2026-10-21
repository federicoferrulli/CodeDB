'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { roundtripJson } = require('./e2e-export-formati');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');
const quiet = { info() {}, error() {} };
if(process.argv.includes('--mutant')) { process.env.CODEDB_TEST_TYPE_FAULT='sql'; process.env.NODE_OPTIONS=`--require "${path.join(__dirname,'fault-tipi.cjs').replace(/\\/g,'/')}"`; }
if(process.argv.includes('--mutant-enum')) { process.env.CODEDB_TEST_TYPE_FAULT='enum'; process.env.NODE_OPTIONS=`--require "${path.join(__dirname,'fault-tipi.cjs').replace(/\\/g,'/')}"`; }

const { mysqlTypes, pgTypes } = require('./fixture-tipi-sql');

(async () => {
  for (const type of ['mysql', 'postgresql']) {
    if (process.env.TYPE_ONLY && process.env.TYPE_ONLY !== type) continue;
    const mysql = type === 'mysql', port = Number(process.env[mysql ? 'EXPORT_MYSQL_PORT' : 'EXPORT_PG_PORT']); assert(port, 'Porte usa-e-getta obbligatorie.');
    const st = new (require(`../db/${mysql ? 'MySql' : 'PostgreSql'}Strategy`))();
    await st.connect({ host: '127.0.0.1', port, username: mysql ? 'root' : 'postgres', password: require('./lab/credenziali.cjs')(mysql ? 'mysql' : 'postgresql'), database: mysql ? '' : 'postgres' });
    const conn = mysql ? await st.pool.getConnection() : await st.pool.connect();
    const query = async (s,p) => { const r=await conn.query(s,p); return mysql?r[0]:r.rows; };
    const source = 'codedb_types_' + crypto.randomBytes(5).toString('hex'), target = source + '_copy';
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'codedb-types-'));
    const qid=n=>(mysql?'`':'"')+n+(mysql?'`':'"');
    const drop = name => query(mysql?`DROP DATABASE IF EXISTS ${qid(name)}`:`DROP SCHEMA IF EXISTS ${qid(name)} CASCADE`);
    const use = name => query(mysql?`USE ${qid(name)}`:`SET search_path TO ${qid(name)}, public`);
    const types = mysql?mysqlTypes:pgTypes;
    const snapshot = async name => {
      await use(name);
      return query('SELECT id,'+types.map(([t],i)=> `${mysql ? /BINARY|BLOB|BIT|GEOMETRY/i.test(t)?`HEX(CAST(c${i} AS BINARY))`:`CAST(c${i} AS CHAR CHARACTER SET utf8mb4)` : /^regproc(?:\[\])?$/.test(t)?`c${i}::oid${t.endsWith('[]')?'[]':''}::regprocedure${t.endsWith('[]')?'[]':''}::text`:/^regoper(?:\[\])?$/.test(t)?`c${i}::oid${t.endsWith('[]')?'[]':''}::regoperator${t.endsWith('[]')?'[]':''}::text`:`c${i}::text`} AS c${i}`).join(',')+' FROM tipi ORDER BY id');
    };
    try {
      await query(mysql?`CREATE DATABASE ${qid(source)} CHARACTER SET utf8mb4`:`CREATE SCHEMA ${qid(source)}`); await use(source);
      if(mysql) await query("SET SESSION sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO', SESSION time_zone='+00:00'");
      else {
        await query("CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public");
        await query("SET TimeZone='UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET extra_float_digits=3");
        await query("CREATE TYPE mood AS ENUM('a','b,🦊'); CREATE DOMAIN amount AS numeric(38,9) CHECK(VALUE>=0); CREATE TYPE pair AS (m mood, n amount); CREATE TYPE price_range AS RANGE(SUBTYPE=numeric,MULTIRANGE_TYPE_NAME=price_multirange)");
        await query("CREATE TYPE myint; CREATE FUNCTION myint_in(cstring) RETURNS myint AS 'int4in' LANGUAGE internal IMMUTABLE STRICT; CREATE FUNCTION myint_out(myint) RETURNS cstring AS 'int4out' LANGUAGE internal IMMUTABLE STRICT; CREATE TYPE myint(INPUT=myint_in,OUTPUT=myint_out,INTERNALLENGTH=4,PASSEDBYVALUE,ALIGNMENT=int4,STORAGE=plain,CATEGORY='N')");
        await query("CREATE TYPE normalized_range; CREATE FUNCTION canonicalize(normalized_range) RETURNS normalized_range AS 'int4range_canonical' LANGUAGE internal IMMUTABLE STRICT; CREATE TYPE normalized_range AS RANGE(SUBTYPE=integer,CANONICAL=canonicalize)");
        await query("CREATE FUNCTION canonicalize(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1'; CREATE COLLATION locale_test(provider=icu,locale='und-u-ks-level2',deterministic=false); CREATE DOMAIN collated_text AS text COLLATE locale_test");
      }
      await query(`CREATE TABLE tipi(id INT PRIMARY KEY,${types.map(([t],i)=>`c${i} ${t}`).join(',')})`);
      await query(`INSERT INTO tipi VALUES(1,${types.map(([,v])=>v).join(',')})`);
      await query(`INSERT INTO tipi(id) VALUES(2)`);
      if (mysql) {
        await query("SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'");
        await query(`INSERT INTO tipi(id,c${types.length-2}) VALUES(3,0)`);
        await query("SET SESSION sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO'");
      }
      const expected=await snapshot(source);
      for(const format of ['codedb-json','sql', ...(!mysql && process.env.EXPORT_PG_CONTAINER ? ['pg_dump'] : [])]) {
        let external;
        if(format==='pg_dump') {
          // pg_dump usa il solo nome per regproc/regoper: con overload quel
          // testo è ambiguo già nel file. Si prova la variante univoca nativa;
          // gli overload restano coperti da entrambi i formati CodeDB e backup.
          await query("UPDATE tipi SET c96='int4in'::regproc, c98='|/'::regoper,c101=ARRAY['int4in'::regproc],c102=ARRAY['|/'::regoper] WHERE id=1");
          Object.assign(expected[0],(await snapshot(source))[0]);
          const dump=require('node:child_process').spawnSync('docker',['exec',process.env.EXPORT_PG_CONTAINER,'pg_dump','-U','postgres','--no-owner','--no-privileges','--schema='+source,'postgres'],{encoding:'utf8',windowsHide:true});
          assert.equal(dump.status,0,dump.stderr);external=dump.stdout;
        }
        await roundtripJson(type,port,source,target,format==='pg_dump'?'sql':format,external);
        assert.deepEqual(await snapshot(target),expected, `${type} ${format}: valori server di ogni tipo`);
        if(mysql) {
          const compare=types.map(([t],i)=>/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT|BOOLEAN|DECIMAL|FLOAT|DOUBLE|BIT)/i.test(t)?`a.c${i}<=>b.c${i}`:'1').join(' AND ');
          assert.equal((await query(`SELECT COUNT(*) AS n FROM ${qid(source)}.tipi a JOIN ${qid(target)}.tipi b USING(id) WHERE NOT(${compare})`))[0].n,0,'uguaglianza numerica sul server, prima di formattare i valori');
          assert.deepEqual(await query(`SELECT id,CAST(c${types.length-2} AS UNSIGNED) AS ordinal FROM ${qid(target)}.tipi ORDER BY id`),await query(`SELECT id,CAST(c${types.length-2} AS UNSIGNED) AS ordinal FROM ${qid(source)}.tipi ORDER BY id`),'ENUM vuoto valido e indice zero restano distinti');
        }
        await use(source); await drop(target);
        if(format==='pg_dump') {
          await query("UPDATE tipi SET c96='canonicalize(integer)'::regprocedure::oid,c98='+(integer,integer)'::regoperator::oid,c101=ARRAY[ARRAY['canonicalize(integer)'::regprocedure::oid,NULL],ARRAY['abs(integer)'::regprocedure::oid,0]]::oid[]::regproc[],c102=ARRAY['+(integer,integer)'::regoperator::oid,NULL]::oid[]::regoper[] WHERE id=1");
          Object.assign(expected[0],(await snapshot(source))[0]);
        }
        console.log(`OK ${type} ${format}: ${types.length} casi con valori estremi e NULL`);
      }
      const b=await runBackup({session:{strategy:st,dbType:type},connName:'tipi',db:source,type:'full',destRoot:root,compress:true,log:quiet});
      await runRestore({session:{strategy:st,dbType:type},backupDir:b.backupDir,targetDb:target,drop:true,log:quiet});
      assert.deepEqual(await snapshot(target),expected, `${type} backup: valori server di ogni tipo`);
      if(mysql) assert.equal((await query(`SELECT COUNT(*) AS n FROM ${qid(source)}.tipi a JOIN ${qid(target)}.tipi b USING(id) WHERE NOT(a.c12<=>b.c12)`))[0].n,0,'FLOAT esatto dopo il backup');
      console.log(`OK ${type} backup: ${types.length} casi`);
      fs.mkdirSync('test-reports/import-export-2026-10-12',{recursive:true});
      fs.writeFileSync(`test-reports/import-export-2026-10-12/tipi-${type}.json`,JSON.stringify({type,casi:types.map(([tipo,valore])=>({tipo,valore})),percorsi:['codedb-json','sql','backup',...(!mysql && process.env.EXPORT_PG_CONTAINER?['pg_dump']:[])],valoriIdentici:true},null,2));
    } finally { await drop(target); await drop(source); conn.release(); await st.disconnect(); fs.rmSync(root,{recursive:true,force:true}); }
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
