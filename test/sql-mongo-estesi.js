'use strict';
const assert = require('node:assert/strict');
module.exports = async ({query,database,pg,my,strategy,base}) => {
  let mongo=0,postgres=0,mysql=0;
  const all=async (text,ptext=text) => { await query(text); mongo++; if(pg && ptext){await pg.query(ptext);postgres++;} };
  const rows=async (text,expected,ptext=text) => { assert.deepEqual(await query(text),expected,text);mongo++; if(pg && ptext){assert.deepEqual((await pg.query(ptext)).rows,expected,ptext);postgres++;} };
  await rows('SELECT (ARRAY[1,2,3])[2] AS n', [{n:2}]);
  await rows('SELECT (ARRAY[1,2,3])[2:3] AS a,(ARRAY[1,2,3])[:2] AS b,(ARRAY[1,2,3])[20:] AS c', [{a:[2,3],b:[1,2],c:[]}]);
  await rows('SELECT (ARRAY[[1,2],[3,4]])[1:2][2] AS a,(ARRAY[[1,2],[3,4]])[:][2:] AS b', [{a:[[1,2],[3,4]],b:[[2],[4]]}]);
  await rows('SELECT ARRAY_DIMS(ARRAY_FILL(7,ARRAY[2,3],ARRAY[-2,0])) AS d,ARRAY_LOWER(ARRAY_FILL(7,ARRAY[2,3],ARRAY[-2,0]),1) AS lo,ARRAY_UPPER(ARRAY_FILL(7,ARRAY[2,3],ARRAY[-2,0]),2) AS hi', [{d:'[-2:-1][0:2]',lo:-2,hi:2}]);
  await rows('SELECT (ARRAY_FILL(7,ARRAY[2,3],ARRAY[-2,0]))[-1][2] AS n,(ARRAY_FILL(7,ARRAY[2,3],ARRAY[-2,0]))[-4:-1][1:2] AS s', [{n:7,s:[[7,7],[7,7]]}]);
  await rows("SELECT ('[-2:0]={1,NULL,3}'::INT[])[-2] AS n,ARRAY_POSITION('[-2:0]={1,NULL,3}'::INT[],NULL) AS p", [{n:1,p:-1}]);
  await all('CREATE TABLE bounds(id INT PRIMARY KEY,a INT[])');
  await all("INSERT INTO bounds VALUES(1,'[-2:0]={1,NULL,3}'),(2,ARRAY_FILL(5,ARRAY[3],ARRAY[0]))");
  await rows('SELECT id,ARRAY_DIMS(a) AS d,a[-2:3] AS values FROM bounds ORDER BY id', [{id:1,d:'[-2:0]',values:[1,null,3]},{id:2,d:'[0:2]',values:[5,5,5]}]);
  await rows("SELECT ARRAY_DIMS(ARRAY['[-2:0]={1,2,3}'::INT[],'[-2:0]={4,5,6}'::INT[]]) AS d", [{d:'[1:2][-2:0]'}]);
  await rows("SELECT ARRAY_DIMS(ARRAY_CAT('[-2:0]={1,2,3}'::INT[],ARRAY[4,5])) AS d,ARRAY_DIMS(ARRAY_PREPEND(0,'[-2:0]={1,2,3}'::INT[])) AS p", [{d:'[-2:2]',p:'[-2:1]'}]);
  await rows("SELECT ARRAY_DIMS(ARRAY_REMOVE('[-2:0]={1,2,3}'::INT[],2)) AS d,ARRAY_DIMS(ARRAY_REPLACE('[-2:0]={1,2,3}'::INT[],2,9)) AS r", [{d:'[-2:-1]',r:'[-2:0]'}]);
  await rows('SELECT ARRAY_CAT(ARRAY[]::INT[],NULL::INT[]) AS a,ARRAY_CAT(NULL::INT[],ARRAY[]::INT[]) AS b', [{a:[],b:[]}]);
  await rows('SELECT (ARRAY[1,2])[1:2][1:2] AS a,(ARRAY[1,2])[NULL:2] AS b', [{a:[],b:null}]);
  await all("CREATE TABLE defbounds(id INT PRIMARY KEY,a INT[] DEFAULT '[-1:0]={8,9}')");
  await all('INSERT INTO defbounds(id) VALUES(1)');
  await all("UPDATE defbounds SET a='[0:1]={4,5}' WHERE id=1");
  await rows('SELECT ARRAY_DIMS(a) AS d,a[0] AS n FROM defbounds', [{d:'[0:1]',n:4}]);
  await all('CREATE PROCEDURE keep_bounds(IN p INT[]) BEGIN INSERT INTO bounds VALUES(3,p); END', 'CREATE PROCEDURE keep_bounds(IN p INT[]) LANGUAGE SQL BEGIN ATOMIC INSERT INTO bounds VALUES(3,p); END');
  await all("CALL keep_bounds('[-5:-4]={8,9}'::INT[])");
  await rows('SELECT ARRAY_DIMS(a) AS d,a[-4] AS n FROM bounds WHERE id=3', [{d:'[-5:-4]',n:9}]);
  await query('SELECT ARRAY_FILL(1,ARRAY[2],ARRAY[2147483647])', /54000/); mongo++;
  if(pg){await assert.rejects(pg.query('SELECT ARRAY_FILL(1,ARRAY[2],ARRAY[2147483647])'),e=>e.code==='54000');postgres++;}
  await assert.rejects(database.collection('bounds').insertOne({id:4,a:{_sqlArray:true,lower:[1],values:[8,9]}}),/validation/i);mongo++;
  await rows("SELECT ISEMPTY(INT4MULTIRANGE()) AS e,LOWER(INT4MULTIRANGE(INT4RANGE(5,8),INT4RANGE(1,3),INT4RANGE(3,5))) AS lo,UPPER(INT4MULTIRANGE(INT4RANGE(1,3))) AS hi", [{e:true,lo:1,hi:3}]);
  await rows("SELECT '{[1,3),[5,8)}'::INT4MULTIRANGE @> 6 AS a,'{[1,3),[5,8)}'::INT4MULTIRANGE @> INT4RANGE(2,6) AS b,INT4RANGE(0,9) @> '{[1,3),[5,8)}'::INT4MULTIRANGE AS c", [{a:true,b:false,c:true}]);
  await rows("SELECT ('{[1,3),[5,8)}'::INT4MULTIRANGE - '{[2,6)}'::INT4MULTIRANGE) = '{[1,2),[6,8)}'::INT4MULTIRANGE AS d,('{[1,3),[5,8)}'::INT4MULTIRANGE * '{[2,6)}'::INT4MULTIRANGE) = '{[2,3),[5,6)}'::INT4MULTIRANGE AS i", [{d:true,i:true}]);
  await rows("SELECT ('{[1,3),[5,8)}'::INT4MULTIRANGE + '{[3,5)}'::INT4MULTIRANGE) = '{[1,8)}'::INT4MULTIRANGE AS u,LOWER(RANGE_MERGE('{[1,3),[5,8)}'::INT4MULTIRANGE)) AS lo,UPPER(RANGE_MERGE(INT4RANGE(1,3),INT4RANGE(5,8))) AS hi", [{u:true,lo:1,hi:8}]);
  await rows("SELECT ('{(,3),[5,)}'::INT4MULTIRANGE - '{[2,6)}'::INT4MULTIRANGE) = '{(,2),[6,)}'::INT4MULTIRANGE AS d,ISEMPTY(RANGE_MERGE(INT4MULTIRANGE())) AS e", [{d:true,e:true}]);
  await all('CREATE TABLE multiranges(id INT PRIMARY KEY,r INT4MULTIRANGE UNIQUE)');
  await all("INSERT INTO multiranges VALUES(1,'{[5,8),[1,3),[3,5)}')");
  await rows("SELECT r = '{[1,8)}'::INT4MULTIRANGE AS canonical,r @> INT4RANGE(2,7) AS contained FROM multiranges", [{canonical:true,contained:true}]);
  await query("INSERT INTO multiranges VALUES(2,'{[1,8)}')",/duplicat/i);mongo++;
  if(pg){await assert.rejects(pg.query("INSERT INTO multiranges VALUES(2,'{[1,8)}')"),e=>e.code==='23505');postgres++;}
  await all('CREATE DOMAIN bounded AS INT CONSTRAINT positive CHECK(VALUE>0)');
  await all('CREATE DOMAIN nested_bound AS bounded');
  await all('CREATE TABLE domain_deps(id INT PRIMARY KEY,n nested_bound,a bounded[])');
  await all('INSERT INTO domain_deps VALUES(1,2,ARRAY[3,4])');
  await all('ALTER DOMAIN bounded ADD CONSTRAINT high CHECK(VALUE>10) NOT VALID');
  await all('CREATE TABLE domain_conversion(n INT)');
  await all('INSERT INTO domain_conversion VALUES(2)');
  await query('ALTER TABLE domain_conversion ALTER COLUMN n TYPE bounded',/violano/i);mongo++;
  if(pg){await assert.rejects(pg.query('ALTER TABLE domain_conversion ALTER COLUMN n TYPE bounded'),e=>e.code==='23514');postgres++;}
  await rows('SELECT n,a FROM domain_deps', [{n:2,a:[3,4]}], 'SELECT n,a::INT[] AS a FROM domain_deps');
  await query('INSERT INTO domain_deps VALUES(2,12,ARRAY[4])', /validation|CHECK/i);mongo++;
  if(pg){await assert.rejects(pg.query('INSERT INTO domain_deps VALUES(2,12,ARRAY[4])'),e=>e.code==='23514');postgres++;}
  await all('ALTER TABLE domain_deps ALTER COLUMN a TYPE INT[]');
  await query('ALTER DOMAIN bounded VALIDATE CONSTRAINT high', /violano/i);mongo++;
  if(pg){await assert.rejects(pg.query('ALTER DOMAIN bounded VALIDATE CONSTRAINT high'),e=>e.code==='23514');postgres++;}
  await all('ALTER DOMAIN bounded RENAME CONSTRAINT high TO larger');
  await all('UPDATE domain_deps SET n=12,a=ARRAY[13,14]');
  await all('ALTER DOMAIN bounded VALIDATE CONSTRAINT larger');
  await all('ALTER DOMAIN bounded DROP CONSTRAINT larger');
  await all('CREATE TABLE trigger_bounds(id INT PRIMARY KEY,a INT[])');
  await all('CREATE TABLE trigger_bounds_log(id INT,d TEXT)');
  await all('CREATE TRIGGER record_bounds AFTER INSERT ON trigger_bounds FOR EACH ROW INSERT INTO trigger_bounds_log VALUES(NEW.id,ARRAY_DIMS(NEW.a))',
    `CREATE FUNCTION record_bounds_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN INSERT INTO trigger_bounds_log VALUES(NEW.id,ARRAY_DIMS(NEW.a)); RETURN NEW; END $$; CREATE TRIGGER record_bounds AFTER INSERT ON trigger_bounds FOR EACH ROW EXECUTE FUNCTION record_bounds_fn()`);
  await all("INSERT INTO trigger_bounds VALUES(1,'[-2:0]={1,2,3}')");
  await all('ALTER TABLE trigger_bounds DISABLE TRIGGER record_bounds');
  await all("INSERT INTO trigger_bounds VALUES(2,'[-2:0]={1,2,3}')");
  await all('CREATE OR REPLACE TRIGGER record_bounds AFTER INSERT ON trigger_bounds FOR EACH ROW INSERT INTO trigger_bounds_log VALUES(NEW.id,ARRAY_DIMS(NEW.a))',
    'CREATE OR REPLACE TRIGGER record_bounds AFTER INSERT ON trigger_bounds FOR EACH ROW EXECUTE FUNCTION record_bounds_fn()');
  await all("INSERT INTO trigger_bounds VALUES(3,'[-2:0]={1,2,3}')");
  await all('ALTER TABLE trigger_bounds DISABLE TRIGGER USER');
  await all("INSERT INTO trigger_bounds VALUES(4,'[-2:0]={1,2,3}')");
  await all('ALTER TABLE trigger_bounds ENABLE TRIGGER USER');
  await all("INSERT INTO trigger_bounds VALUES(5,'[-2:0]={1,2,3}')");
  await rows('SELECT id,d FROM trigger_bounds_log ORDER BY id',[{id:1,d:'[-2:0]'},{id:3,d:'[-2:0]'},{id:5,d:'[-2:0]'}]);
  await query('CREATE TABLE native_keys(id INT PRIMARY KEY,a INT[])');mongo++;
  await database.collection('native_keys').createIndex({a:1},{unique:true,name:'native_multikey'});
  await query('INSERT INTO native_keys VALUES(1,ARRAY[1,2])');mongo++;
  await query(`CREATE PROCEDURE native_keys_handler() LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO native_keys VALUES(2,ARRAY[3,4]);
    BEGIN INSERT INTO native_keys VALUES(3,ARRAY[5,6]); INSERT INTO native_keys VALUES(4,ARRAY[2,7]);
    EXCEPTION WHEN unique_violation THEN INSERT INTO native_keys VALUES(5,ARRAY[8,9]); END;
    INSERT INTO native_keys VALUES(6,ARRAY[10,11]);
  END $$`);mongo++;
  await query('CALL native_keys_handler()');mongo++;
  await rows('SELECT id,a FROM native_keys ORDER BY id',[{id:1,a:[1,2]},{id:2,a:[3,4]},{id:5,a:[8,9]},{id:6,a:[10,11]}],null);
  assert.equal(await database.listCollections({name:/^_codedb_sql_probe_/}).hasNext(),false);mongo++;
  await query('CREATE TABLE native_text(id INT PRIMARY KEY,a TEXT[])');mongo++;
  await database.collection('native_text').createIndex({a:1},{unique:true,name:'native_casefold',collation:{locale:'en',strength:2}});
  await query("INSERT INTO native_text VALUES(1,ARRAY['AA'])");mongo++;
  await query(`CREATE PROCEDURE native_collation_handler() LANGUAGE plpgsql AS $$ BEGIN
    BEGIN INSERT INTO native_text VALUES(2,ARRAY['aa']); EXCEPTION WHEN unique_violation THEN INSERT INTO native_text VALUES(3,ARRAY['BB']); END;
  END $$`);mongo++;
  await query('CALL native_collation_handler()');mongo++;
  await rows('SELECT id,a FROM native_text ORDER BY id',[{id:1,a:['AA']},{id:3,a:['BB']}],null);
  await all('CREATE TABLE array_write(id INT PRIMARY KEY,a INT[])');
  await all("INSERT INTO array_write VALUES(1,'[-1:1]={1,2,3}'),(2,ARRAY[[1,2],[3,4]]),(3,NULL),(4,ARRAY[]::INT[])");
  await all('UPDATE array_write SET a[-3]=9,a[3]=8 WHERE id=1');
  await rows('SELECT ARRAY_DIMS(a) AS d,a[:] AS a FROM array_write WHERE id=1',[{d:'[-3:3]',a:[9,null,1,2,3,null,8]}]);
  await all('UPDATE array_write SET a[-2:0]=ARRAY[5,6,7,8] WHERE id=1');
  await rows('SELECT a[:] AS a FROM array_write WHERE id=1',[{a:[9,5,6,7,3,null,8]}]);
  await all('UPDATE array_write SET a[1:2][2:2]=ARRAY[8,9] WHERE id=2');
  await rows('SELECT a FROM array_write WHERE id=2',[{a:[[1,8],[3,9]]}]);
  await all('CREATE TABLE nested_source(id INT PRIMARY KEY,n INT,unused INT)');
  await all('CREATE TABLE nested_log(n INT)');
  await all('INSERT INTO nested_source VALUES(1,8,1),(2,9,2)');
  await all('CREATE PROCEDURE nested_cte() LANGUAGE SQL BEGIN ATOMIC INSERT INTO nested_log WITH c AS (SELECT n FROM nested_source WHERE id=1) SELECT n FROM c; END');
  await all('CREATE PROCEDURE nested_derived() LANGUAGE SQL BEGIN ATOMIC INSERT INTO nested_log SELECT d.n FROM (SELECT n FROM nested_source WHERE id=2) AS d; END');
  await all('CREATE PROCEDURE nested_correlated() LANGUAGE SQL BEGIN ATOMIC INSERT INTO nested_log SELECT x.n FROM nested_source x WHERE EXISTS(SELECT 1 FROM nested_source y WHERE y.id=x.id AND y.n=8); END');
  await all('ALTER TABLE nested_source ALTER COLUMN unused TYPE BIGINT');
  await all('CREATE PROCEDURE nested_star() LANGUAGE SQL BEGIN ATOMIC INSERT INTO nested_log SELECT d.n FROM (SELECT * FROM nested_source WHERE id=1) d; END');
  await all('CREATE TABLE nested_other(id INT,n INT)');
  await all('INSERT INTO nested_other VALUES(1,30)');
  await all('CREATE PROCEDURE nested_shadow() LANGUAGE SQL BEGIN ATOMIC INSERT INTO nested_log SELECT (SELECT x.n FROM nested_other x WHERE x.id=1) AS n FROM nested_source x WHERE x.n=8; END');
  await all('ALTER TABLE nested_source RENAME COLUMN n TO amount');
  await all('CALL nested_cte()');await all('CALL nested_derived()');await all('CALL nested_correlated()');
  await rows('SELECT n FROM nested_log ORDER BY n',[{n:8},{n:8},{n:9}]);
  await all('CALL nested_star()');await all('CALL nested_shadow()');
  await rows('SELECT n FROM nested_log ORDER BY n',[{n:8},{n:8},{n:8},{n:9},{n:30}]);
  await query('ALTER TABLE nested_source DROP COLUMN amount',/dipendenza/i);mongo++;
  if(pg){await assert.rejects(pg.query('ALTER TABLE nested_source DROP COLUMN amount'),e=>e.code==='2BP01');postgres++;}
  await all('ALTER TABLE nested_source DROP COLUMN amount CASCADE');
  await query('CALL nested_cte()',/inesistente/i);mongo++;
  if(pg){await assert.rejects(pg.query('CALL nested_cte()'),e=>e.code==='42883');postgres++;}
  await rows("SELECT '{[1,3),[8,10)}'::INT4MULTIRANGE -|- '{[3,5)}'::INT4MULTIRANGE AS gap,'{[1,3)}'::INT4MULTIRANGE -|- '{[3,5)}'::INT4MULTIRANGE AS adjacent,INT4RANGE(1,3) << INT4RANGE(3,5) AS leftward",[{gap:false,adjacent:true,leftward:true}]);
  await rows("SELECT INT4RANGE(1,3) &< INT4RANGE(2,3) AS a,INT4RANGE(1,3) &> INT4RANGE(2,3) AS b,INT4RANGE(3,5) >> INT4RANGE(1,3) AS c",[{a:true,b:false,c:true}]);
  await rows("SELECT '[1,2)'::NUMRANGE < '[1,2]'::NUMRANGE AS a,'empty'::INT4RANGE < '(,)'::INT4RANGE AS b,'{[1,3),[5,8)}'::INT4MULTIRANGE < '{[1,3),[5,9)}'::INT4MULTIRANGE AS c",[{a:true,b:true,c:true}]);
  await rows("SELECT ARRAY[NULL]::INT[] > ARRAY[1] AS a,'[0:1]={1,2}'::INT[] < '[1:2]={1,2}'::INT[] AS b",[{a:true,b:true}]);
  for(const type of ['INT4MULTIRANGE','INT8MULTIRANGE','NUMMULTIRANGE','DATEMULTIRANGE','TSMULTIRANGE','TSTZMULTIRANGE']) {
    const date=type.includes('DATE')||type.startsWith('TS'),lower=date?'2026-01-01':'1',upper=date?'2026-01-04':'4',mid=date?'2026-01-02':'2';
    await rows(`SELECT ('{[${lower},${mid}),[${mid},${upper})}'::${type}) = '{[${lower},${upper})}'::${type} AS n, ISEMPTY('{}'::${type}) AS e`,[{n:true,e:true}]);
  }
  await all('UPDATE array_write SET a[0][2]=7 WHERE id IN(3,4)');
  await rows('SELECT ARRAY_DIMS(a) AS d,a[0][2] AS n FROM array_write WHERE id IN(3,4)',[{d:'[0:0][2:2]',n:7},{d:'[0:0][2:2]',n:7}]);
  await all('UPDATE array_write SET a[:][:]=NULL WHERE id=2');
  await rows('SELECT a FROM array_write WHERE id=2',[{a:[[1,8],[3,9]]}]);
  return {mongo,postgres,mysql};
};
