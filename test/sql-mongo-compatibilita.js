'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, base }) => {
  let mongo = 0, postgres = 0;
  const all = async (text, ptext = text) => { await query(text); mongo++; if (pg && ptext) { await pg.query(ptext); postgres++; } };
  const rows = async (text, expected, ptext = text) => {
    assert.deepEqual(await query(text), expected, text); mongo++;
    if (pg && ptext) { assert.deepEqual((await pg.query(ptext)).rows, expected, ptext); postgres++; }
  };
  await all('CREATE TABLE sort_arrays(id INT PRIMARY KEY, a INT[])');
  await all("INSERT INTO sort_arrays VALUES(1,ARRAY[2,0]),(2,ARRAY[1,8]),(3,ARRAY[1,9]),(4,ARRAY[1,NULL]),(5,'[0:1]={1,8}'),(6,NULL),(7,ARRAY[]::INT[])");
  await rows('SELECT id FROM sort_arrays ORDER BY a ASC NULLS LAST', [7,5,2,3,4,1,6].map(id => ({id})));
  await rows('SELECT id FROM sort_arrays ORDER BY a DESC NULLS FIRST', [6,1,4,3,2,5,7].map(id => ({id})));
  await rows('SELECT id FROM sort_arrays ORDER BY a NULLS LAST LIMIT 3 OFFSET 1', [5,2,3].map(id => ({id})));
  await rows('SELECT ARRAY_DIMS(MIN(a)) AS lo,MAX(a) AS hi FROM sort_arrays', [{lo:null,hi:[2,0]}]);
  await rows('SELECT MIN(DISTINCT a) AS lo,MAX(a) FILTER(WHERE id<5) AS hi FROM sort_arrays WHERE id<5', [{lo:[1,8],hi:[2,0]}]);
  await rows('SELECT id,ROW_NUMBER() OVER(ORDER BY a NULLS LAST) AS n,RANK() OVER(ORDER BY a NULLS LAST) AS r FROM sort_arrays ORDER BY id',
    [6,3,4,5,2,7,1].map((n,i)=>({id:i+1,n,r:n})));
  await rows('SELECT id,MAX(a) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS hi FROM sort_arrays WHERE id<=3 ORDER BY id', [{id:1,hi:[2,0]},{id:2,hi:[2,0]},{id:3,hi:[1,9]}]);
  await all('CREATE TABLE sort_ranges(id INT PRIMARY KEY,r NUMRANGE,m INT4MULTIRANGE)');
  await all("INSERT INTO sort_ranges VALUES(1,'[1,2)','{[1,3),[8,10)}'),(2,'(,3)','{}'),(3,'empty','{[1,3),[6,9)}'),(4,'[1,2]','{[1,3)}'),(5,'(1,2]','{(,)}'),(6,NULL,NULL)");
  await rows('SELECT id FROM sort_ranges ORDER BY r NULLS LAST', [3,2,1,4,5,6].map(id=>({id})));
  await rows('SELECT id FROM sort_ranges ORDER BY m NULLS LAST', [2,5,4,3,1,6].map(id=>({id})));
  await all('CREATE TABLE intervals(id INT PRIMARY KEY,g INT,r INT4RANGE,m INT4MULTIRANGE)');
  await all("INSERT INTO intervals VALUES(1,1,'[1,5)','{[1,5),[8,10)}'),(2,1,'[3,8)','{[3,9)}'),(3,1,NULL,NULL),(4,2,'empty','{}')");
  await rows("SELECT RANGE_AGG(r) = '{[1,8)}'::INT4MULTIRANGE AS u, RANGE_INTERSECT_AGG(r) = '[3,5)'::INT4RANGE AS i FROM intervals WHERE g=1",[{u:true,i:true}]);
  await rows("SELECT RANGE_AGG(m) = '{[1,10)}'::INT4MULTIRANGE AS u, RANGE_INTERSECT_AGG(m) = '{[3,5),[8,9)}'::INT4MULTIRANGE AS i FROM intervals WHERE g=1",[{u:true,i:true}]);
  await rows('SELECT RANGE_AGG(r) AS u,RANGE_INTERSECT_AGG(m) AS i FROM intervals WHERE id<0',[{u:null,i:null}]);
  await rows('SELECT RANGE_AGG(r) AS u,RANGE_INTERSECT_AGG(m) AS i FROM intervals WHERE id=3',[{u:null,i:null}]);
  await query('SELECT RANGE_AGG(id) FROM intervals',/intervalli/i);mongo++;
  if(pg){await assert.rejects(pg.query('SELECT RANGE_AGG(id) FROM intervals'),e=>e.code==='42883');postgres++;}
  await rows("SELECT RANGE_AGG(DISTINCT r) FILTER(WHERE id=1) = '{[1,5)}'::INT4MULTIRANGE AS u,ISEMPTY(RANGE_INTERSECT_AGG(r)) AS e FROM intervals",[{u:true,e:true}]);
  await rows('SELECT g,ISEMPTY(RANGE_AGG(r)) AS e FROM intervals GROUP BY g HAVING ISEMPTY(RANGE_AGG(r)) ORDER BY g',[{g:2,e:true}]);
  await rows("SELECT id,RANGE_AGG(r) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) = '{[1,8)}'::INT4MULTIRANGE AS u FROM intervals WHERE id<=2 ORDER BY id",[{id:1,u:false},{id:2,u:true}]);
  await rows("SELECT id,RANGE_INTERSECT_AGG(m) OVER(ORDER BY id) = '{[3,5),[8,9)}'::INT4MULTIRANGE AS i FROM intervals WHERE id<=2 ORDER BY id",[{id:1,i:false},{id:2,i:true}]);
  await all('CREATE TABLE text_arrays(id INT PRIMARY KEY,t TEXT)');
  await all("INSERT INTO text_arrays VALUES(1,'[-2:0]={1,NULL,3}'),(2,'{{1,2},{3,4}}'),(3,'{}'),(4,NULL)");
  await rows('SELECT id,ARRAY_DIMS(CAST(t AS INT[])) AS d,(t::INT[])[-2] AS n FROM text_arrays ORDER BY id', [{id:1,d:'[-2:0]',n:1},{id:2,d:'[1:2][1:2]',n:null},{id:3,d:null,n:null},{id:4,d:null,n:null}]);
  await rows('SELECT (CAST(t AS INT[]))[:] AS a FROM text_arrays WHERE id=2',[{a:[[1,2],[3,4]]}]);
  await all('CREATE DOMAIN positive_cast AS INT NOT NULL CHECK(VALUE>0)');
  await all('CREATE DOMAIN small_cast AS positive_cast CHECK(VALUE<10)');
  await rows("SELECT CAST('7' AS small_cast)::INT AS n,CAST(ARRAY[1,3] AS small_cast[])::INT[] AS a",[{n:7,a:[1,3]}]);
  await rows('SELECT CAST(NULL AS small_cast[])::INT[] AS a',[{a:null}]);
  for (const text of ['SELECT CAST(0 AS positive_cast)', 'SELECT CAST(NULL AS positive_cast)', 'SELECT CAST(10 AS small_cast)', 'SELECT CAST(ARRAY[1,NULL] AS small_cast[])', 'SELECT CAST(ARRAY[1,11] AS small_cast[])']) {
    await query(text,/dominio|CHECK|NULL/i); mongo++;
    if(pg) { await assert.rejects(pg.query(text),e=>['23502','23514'].includes(e.code)); postgres++; }
  }
  await all('CREATE DOMAIN list_cast AS INT[] CHECK(CARDINALITY(VALUE)>1)');
  await rows("SELECT CAST('{2,4}' AS list_cast)::INT[] AS a",[{a:[2,4]}]);
  await query('SELECT CAST(ARRAY[1] AS list_cast)',/CHECK/i);mongo++;
  if(pg){await assert.rejects(pg.query('SELECT CAST(ARRAY[1] AS list_cast)'),e=>e.code==='23514');postgres++;}
  await all('CREATE TABLE cast_log(n INT)');
  await all(`CREATE PROCEDURE cast_handler() LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO cast_log VALUES(1);
    BEGIN INSERT INTO cast_log VALUES(CAST(0 AS positive_cast));
    EXCEPTION WHEN check_violation THEN INSERT INTO cast_log VALUES(2); END;
    INSERT INTO cast_log VALUES(CAST(3 AS positive_cast)); END $$`);
  await all('CALL cast_handler()');
  await rows('SELECT n FROM cast_log ORDER BY n',[{n:1},{n:2},{n:3}]);
  await all('CREATE DOMAIN cascade_root AS INT CHECK(VALUE>0)');
  await all('CREATE DOMAIN cascade_child AS cascade_root');
  await all('CREATE DOMAIN cascade_check AS INT CONSTRAINT ref_root CHECK(CAST(VALUE AS cascade_root)>0)');
  await all('CREATE DOMAIN cascade_check_child AS cascade_check');
  await all('CREATE DOMAIN cascade_default AS INT DEFAULT CAST(1 AS cascade_root)');
  await all('CREATE DOMAIN cascade_default_child AS cascade_default');
  await all('CREATE TABLE cascade_default_table(n cascade_default_child,keep INT)');
  await all('INSERT INTO cascade_default_table VALUES(2,7)');
  await all('CREATE TABLE cascade_survivor(n cascade_check_child)');
  await all('INSERT INTO cascade_survivor VALUES(4)');
  await all('CREATE TABLE cascade_a(id INT PRIMARY KEY,n cascade_child UNIQUE,keep TEXT)');
  await all('CREATE TABLE cascade_b(id INT PRIMARY KEY,n cascade_root[],keep INT)');
  await all('CREATE TABLE cascade_fk(id INT PRIMARY KEY,n INT REFERENCES cascade_a(n))');
  await all('CREATE TABLE cascade_empty(n cascade_root)');
  await all('CREATE TABLE cascade_expr(id INT DEFAULT CAST(1 AS cascade_root),CHECK(CAST(id AS cascade_root)>0))');
  await all("INSERT INTO cascade_a VALUES(1,2,'rimane')");
  await all('INSERT INTO cascade_b VALUES(1,ARRAY[3,4],8)');
  await all('INSERT INTO cascade_fk VALUES(1,2)');
  await all('INSERT INTO cascade_empty VALUES(1)');
  await all('CREATE PROCEDURE cascade_signature(p cascade_child) LANGUAGE SQL BEGIN ATOMIC INSERT INTO cast_log VALUES(p); END');
  await all('CREATE PROCEDURE cascade_expression() LANGUAGE SQL BEGIN ATOMIC INSERT INTO cast_log VALUES(CAST(1 AS cascade_root)); END');
  await all('CREATE PROCEDURE cascade_nested() LANGUAGE SQL BEGIN ATOMIC INSERT INTO cast_log SELECT CAST(d.n AS cascade_root) FROM (SELECT 2 AS n) d; END');
  await all('CREATE PROCEDURE cascade_caller() LANGUAGE SQL BEGIN ATOMIC CALL cascade_expression(); END',null);
  await query('DROP DOMAIN cascade_root',/dipenden/i);mongo++;
  if(pg){await assert.rejects(pg.query('DROP DOMAIN cascade_root'),e=>e.code==='2BP01');postgres++;}
  await all('DROP DOMAIN cascade_root CASCADE');
  await rows('SELECT n FROM cascade_survivor',[{n:4}]);
  await all('INSERT INTO cascade_survivor VALUES(-2)');
  await rows('SELECT CAST(-3 AS cascade_check_child)::INT AS n',[{n:-3}]);
  await rows('SELECT keep FROM cascade_default_table',[{keep:7}]);
  assert.equal(Object.hasOwn(await database.collection('cascade_default_table').findOne({keep:7}),'n'),false);mongo++;
  if(pg){await assert.rejects(pg.query('SELECT n FROM cascade_default_table'),e=>e.code==='42703');postgres++;}
  await rows('SELECT id,keep FROM cascade_a',[{id:1,keep:'rimane'}]);
  await rows('SELECT id,keep FROM cascade_b',[{id:1,keep:8}]);
  await rows('SELECT COUNT(*) AS n FROM cascade_empty',[{n:1}]);
  await all('INSERT INTO cascade_fk VALUES(2,999)');
  await all('INSERT INTO cascade_expr(id) VALUES(-1)');
  for(const name of ['cascade_signature','cascade_expression','cascade_nested','cascade_caller']) {
    const text=`CALL ${name}(${name==='cascade_signature'?'1':''})`;
    await query(text,/inesistente/i);mongo++;
    if(pg && name!=='cascade_caller'){await assert.rejects(pg.query(text),e=>e.code==='42883');postgres++;}
  }
  assert.equal(await database.collection('_codedb_sql_domains').countDocuments({_id:{$in:['cascade_root','cascade_child','cascade_default','cascade_default_child']}}),0);mongo++;
  assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(),0);mongo++;
  assert.equal(Object.hasOwn(await database.collection('cascade_a').findOne({id:1}),'n'),false);mongo++;
  assert.equal(Object.hasOwn(await database.collection('cascade_b').findOne({id:1}),'n'),false);mongo++;
  assert.equal((await database.collection('cascade_a').listIndexes().toArray()).some(i=>Object.hasOwn(i.key,'n')),false);mongo++;
  assert.equal(await database.collection('_codedb_sql_procedures').countDocuments({_id:{$in:['cascade_signature','cascade_expression','cascade_nested','cascade_caller']}}),0);mongo++;
  await all('CREATE TABLE trigger_rename(id INT PRIMARY KEY)');
  await all('CREATE TABLE trigger_rename_log(id INT)');
  await all('CREATE TRIGGER old_name AFTER INSERT ON trigger_rename FOR EACH ROW INSERT INTO trigger_rename_log VALUES(NEW.id)',
    `CREATE FUNCTION rename_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN INSERT INTO trigger_rename_log VALUES(NEW.id); RETURN NEW; END $$; CREATE TRIGGER old_name AFTER INSERT ON trigger_rename FOR EACH ROW EXECUTE FUNCTION rename_fn()`);
  await all('ALTER TABLE trigger_rename DISABLE TRIGGER old_name');
  await all('ALTER TRIGGER old_name ON trigger_rename RENAME TO new_name');
  await all('INSERT INTO trigger_rename VALUES(1)');
  await rows('SELECT id FROM trigger_rename_log',[]);
  await all('ALTER TABLE trigger_rename ENABLE TRIGGER new_name');
  await all('INSERT INTO trigger_rename VALUES(2)');
  await rows('SELECT id FROM trigger_rename_log',[{id:2}]);
  await all('DROP TRIGGER new_name ON trigger_rename');
  await all('CREATE DOMAIN trigger_domain AS INT CHECK(VALUE>0)');
  await all('CREATE TRIGGER domain_when AFTER INSERT ON trigger_rename FOR EACH ROW WHEN(CAST(NEW.id AS trigger_domain)>0) INSERT INTO trigger_rename_log VALUES(NEW.id)',
    'CREATE TRIGGER domain_when AFTER INSERT ON trigger_rename FOR EACH ROW WHEN(CAST(NEW.id AS trigger_domain)>0) EXECUTE FUNCTION rename_fn()');
  await query('DROP DOMAIN trigger_domain',/dipenden/i);mongo++;
  if(pg){await assert.rejects(pg.query('DROP DOMAIN trigger_domain'),e=>e.code==='2BP01');postgres++;}
  await all('DROP DOMAIN trigger_domain CASCADE');
  await all('INSERT INTO trigger_rename VALUES(-1)');
  await rows('SELECT id FROM trigger_rename_log',[{id:2}]);
  assert.equal(await database.collection('_codedb_sql_triggers').countDocuments({_id:'domain_when'}),0);mongo++;
  await query('CREATE TABLE native_geo(id INT PRIMARY KEY,g JSON)');mongo++;
  await database.collection('native_geo').createIndex({g:'2dsphere'});
  await query(`CREATE PROCEDURE native_geo_handler() LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO native_geo VALUES(1,'{"type":"Point","coordinates":[0,0]}');
    BEGIN INSERT INTO native_geo VALUES(2,'{"type":"Point","coordinates":[300,300]}');
    EXCEPTION WHEN data_exception THEN INSERT INTO native_geo VALUES(3,NULL); END;
    INSERT INTO native_geo VALUES(4,NULL); END $$`);mongo++;
  await query('CALL native_geo_handler()');mongo++;
  await rows('SELECT id FROM native_geo ORDER BY id',[{id:1},{id:3},{id:4}],null);
  await query('CREATE TABLE native_parallel(id INT PRIMARY KEY,a INT[],b INT[])');mongo++;
  await database.collection('native_parallel').createIndex({a:1,b:1});
  await query(`CREATE PROCEDURE native_parallel_handler() LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO native_parallel VALUES(1,NULL,ARRAY[1]);
    BEGIN INSERT INTO native_parallel VALUES(2,ARRAY[2],ARRAY[3]);
    EXCEPTION WHEN data_exception THEN INSERT INTO native_parallel VALUES(3,NULL,ARRAY[4]); END;
    INSERT INTO native_parallel VALUES(4,NULL,ARRAY[5]); END $$`);mongo++;
  await query('CALL native_parallel_handler()');mongo++;
  await rows('SELECT id FROM native_parallel ORDER BY id',[{id:1},{id:3},{id:4}],null);
  await query('CREATE TABLE native_immutable(_id INT PRIMARY KEY,n INT)');mongo++;
  await query('INSERT INTO native_immutable VALUES(1,1)');mongo++;
  await query(`CREATE PROCEDURE native_immutable_handler() LANGUAGE plpgsql AS $$ BEGIN
    BEGIN UPDATE native_immutable SET _id=2 WHERE _id=1;
    EXCEPTION WHEN data_exception THEN UPDATE native_immutable SET n=2 WHERE _id=1; END;
    INSERT INTO native_immutable VALUES(3,3); END $$`);mongo++;
  await query('CALL native_immutable_handler()');mongo++;
  await rows('SELECT _id,n FROM native_immutable ORDER BY _id',[{_id:1,n:2},{_id:3,n:3}],null);
  await rows("SELECT ('[-2:0]={1,NULL,3}'::INT[])::TEXT AS t,ARRAY[true,false,NULL]::TEXT AS b,ARRAY[[1,2],[3,4]]::TEXT AS m",[{t:'[-2:0]={1,NULL,3}',b:'{t,f,NULL}',m:'{{1,2},{3,4}}'}]);
  await rows("SELECT ('{[1,3),[3,8)}'::INT4MULTIRANGE)::TEXT AS t,('empty'::INT4RANGE)::TEXT AS e,('[1,3]'::INT4RANGE)::TEXT AS r",[{t:'{[1,8)}',e:'empty',r:'[1,4)'}]);
  await rows("SELECT ('[2026-01-01,2026-01-03)'::DATERANGE)::TEXT AS d,('[2026-01-01 01:02:03.100,2026-01-01 01:02:04)'::TSRANGE)::TEXT AS t",[{d:'[2026-01-01,2026-01-03)',t:'["2026-01-01 01:02:03.1","2026-01-01 01:02:04")'}]);
  const text = String.raw`{a\ ,\ b,"a,b","x\"y","x\\y",NULL,"NULL"}`;
  await database.collection('text_arrays').insertOne({id:5,t:text});
  if(pg) await pg.query('INSERT INTO text_arrays VALUES(5,$1)',[text]);
  await rows('SELECT t::TEXT[] AS a FROM text_arrays WHERE id=5',[{a:['a ',' b','a,b','x"y','x\\y',null,'NULL']}]);
  await rows('SELECT (t::TEXT[])::TEXT AS t FROM text_arrays WHERE id=5',[{t:'{"a "," b","a,b","x\\"y","x\\\\y",NULL,"NULL"}'}]);
  assert.deepEqual(require('../db/sqlArrayValore').parse(text),['a ',' b','a,b','x"y','x\\y',null,'NULL']);mongo++;
  for (const invalid of ['{1,}', '{,1}', '{{1},{2,3}}', '[0:2]={1,2}', '[0:0]={}', '{"unterminated}', '{1}suffix', '[[1,2]]']) {
    await database.collection('text_arrays').updateOne({id:5},{$set:{t:invalid}});
    await query('SELECT t::INT[] FROM text_arrays WHERE id=5',/array|convert/i);mongo++;
    if(pg){await pg.query('UPDATE text_arrays SET t=$1 WHERE id=5',[invalid]);await assert.rejects(pg.query('SELECT t::INT[] FROM text_arrays WHERE id=5'));postgres++;}
  }
  await all('CREATE DOMAIN dynamic_cast AS INT CHECK(VALUE>0)');
  await all('CREATE TABLE dynamic_check(id INT,CHECK(CAST(id AS dynamic_cast)>0))');
  await all('INSERT INTO dynamic_check VALUES(5)');
  await all('ALTER DOMAIN dynamic_cast ADD CONSTRAINT below_ten CHECK(VALUE<10)');
  await query('INSERT INTO dynamic_check VALUES(12)',/CHECK|validation/i);mongo++;
  if(pg){await assert.rejects(pg.query('INSERT INTO dynamic_check VALUES(12)'),e=>e.code==='23514');postgres++;}
  await all('ALTER DOMAIN dynamic_cast DROP CONSTRAINT below_ten');
  await all('INSERT INTO dynamic_check VALUES(12)');
  await rows('SELECT GREATEST(ARRAY[2,0],ARRAY[1,8]) AS a,LEAST(ARRAY[2,0],ARRAY[1,8]) AS b',[{a:[2,0],b:[1,8]}]);
  await rows("SELECT '[1,2]'::NUMRANGE BETWEEN '[1,2)'::NUMRANGE AND '(1,3]'::NUMRANGE AS r",[{r:true}]);
  await rows('SELECT (ARRAY[1,2,3])[1.5] AS n,(ARRAY[1,2,3])[1.5:2.5] AS s',[{n:2,s:[2,3]}]);
  await all("UPDATE sort_arrays SET a[1.5:2.5]='{4,5}' WHERE id=1");
  await rows('SELECT a FROM sort_arrays WHERE id=1',[{a:[2,4,5]}]);
  await database.collection('_codedb_sql_domains').insertOne({_id:'broken_external',definition:{domain:'missing_external'}});
  await rows('SELECT 1 AS n',[{n:1}]);
  await query('SELECT CAST(1 AS broken_external)',/inesistente/i);mongo++;
  await database.collection('_codedb_sql_domains').deleteOne({_id:'broken_external'});
  await all('CREATE DOMAIN rollback_domain AS INT');
  await all('CREATE TABLE rollback_domain_a(id INT PRIMARY KEY,n rollback_domain UNIQUE)');
  await all('CREATE TABLE rollback_domain_b(id INT PRIMARY KEY,n rollback_domain UNIQUE)');
  await all('INSERT INTO rollback_domain_a VALUES(1,2)');
  await all('INSERT INTO rollback_domain_b VALUES(1,3)');
  const originalDb=base.client.db.bind(base.client);let injected=false;
  base.client.db=(...args)=>{
    const d=originalDb(...args),collection=d.collection.bind(d);
    d.collection=(name,...options)=>{
      const c=collection(name,...options),replace=c.replaceOne.bind(c);
      if(name==='rollback_domain_b') c.replaceOne=async(...args)=>{
        const result=await replace(...args);
        if(args[2]?.bypassDocumentValidation&&!injected){injected=true;throw new Error('Guasto intenzionale dopo seconda tabella');}
        return result;
      };
      return c;
    };
    return d;
  };
  try{await query('DROP DOMAIN rollback_domain CASCADE',/Guasto intenzionale/);mongo++;}
  finally{base.client.db=originalDb;}
  assert.ok(injected);mongo++;
  await rows('SELECT id,n FROM rollback_domain_a',[{id:1,n:2}]);
  await rows('SELECT id,n FROM rollback_domain_b',[{id:1,n:3}]);
  assert.equal(await database.collection('_codedb_sql_domains').countDocuments({_id:'rollback_domain'}),1);mongo++;
  assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(),0);mongo++;
  await query('INSERT INTO rollback_domain_b VALUES(2,3)',/duplic|E11000/i);mongo++;
  await assert.rejects(database.collection('rollback_domain_b').insertOne({id:2,n:3}),e=>e.code===11000);mongo++;
  const {guardStrategy}=require('../auth/guardStrategy'),{makePrincipal}=require('../auth/principal');
  const limited=guardStrategy(base,{connName:'test',principal:makePrincipal({_id:'limited',type:'subuser',ownerId:'owner'},
    [{connName:'test',capabilities:['ddl'],scope:{databases:[database.databaseName],collections:['rollback_domain','rollback_domain_a']}}])});
  await assert.rejects(limited.mongoSqlSchema(database.databaseName,'rollback_domain',{sql:'DROP DOMAIN rollback_domain CASCADE'}),/Permesso negato/i);mongo++;
  await rows('SELECT id,n FROM rollback_domain_b',[{id:1,n:3}]);
  await all('DROP DOMAIN rollback_domain CASCADE');
  await query('CREATE PROCEDURE native_cleanup_retry() BEGIN INSERT INTO native_geo VALUES(8,NULL); END');mongo++;
  let interruptedCleanup=false;
  base.client.db=(...args)=>{
    const d=originalDb(...args),collection=d.collection.bind(d);
    d.collection=(name,...options)=>{
      const c=collection(name,...options),drop=c.drop.bind(c);
      if(name.startsWith('_codedb_sql_probe_')) c.drop=async(...args)=>{
        const result=await drop(...args);
        if(!interruptedCleanup){interruptedCleanup=true;throw new (require('mongodb').MongoServerError)({code:11602,errmsg:'Cambio primario dopo DROP applicato'});}
        return result;
      };
      return c;
    };
    return d;
  };
  try{await query('CALL native_cleanup_retry()');mongo++;}finally{base.client.db=originalDb;}
  assert.ok(interruptedCleanup);mongo++;
  await rows('SELECT id FROM native_geo WHERE id=8',[{id:8}],null);
  assert.equal(await database.listCollections({name:/^_codedb_sql_probe_/}).hasNext(),false);mongo++;
  return {mongo,postgres,mysql:0};
};
