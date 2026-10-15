'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, strategy, base, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  const all = async (text, ptext = text, mtext = null) => {
    await query(text); count++;
    if (pg && ptext) { await pg.query(ptext); npg++; }
    if (my && mtext) { await my.query(mtext); nmy++; }
  };
  const rows = async (text, expected, ptext = text, mtext = null) => {
    assert.deepEqual(await query(text), expected); count++;
    if (pg && ptext) { assert.deepEqual((await pg.query(ptext)).rows, expected); npg++; }
    if (my && mtext) { assert.deepEqual((await my.query(mtext))[0], expected); nmy++; }
  };
  await all('CREATE TABLE native_input(id INT PRIMARY KEY,n TEXT,zero INT)');
  await all('CREATE TABLE native_log(id INT,n INT)');
  await all("INSERT INTO native_input VALUES(1,'bad',0),(2,'20',2)");
  await all(`CREATE PROCEDURE native_errors() LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO native_log VALUES(1,1);
    BEGIN
      INSERT INTO native_log VALUES(2,2);
      INSERT INTO native_log SELECT id,10/zero FROM native_input;
    EXCEPTION WHEN division_by_zero THEN INSERT INTO native_log VALUES(3,3);
    END;
    BEGIN
      INSERT INTO native_log SELECT id,CAST(n AS INT) FROM native_input;
    EXCEPTION WHEN invalid_text_representation THEN INSERT INTO native_log VALUES(4,4);
    END;
    INSERT INTO native_log VALUES(5,5);
  END $$`);
  await all('CALL native_errors()');
  await rows('SELECT id,n FROM native_log ORDER BY id', [{id:1,n:1},{id:3,n:3},{id:4,n:4},{id:5,n:5}]);
  await all(`CREATE PROCEDURE native_state() LANGUAGE plpgsql AS $$ BEGIN
    BEGIN INSERT INTO native_log SELECT id,CAST(n AS INT) FROM native_input;
    EXCEPTION WHEN SQLSTATE '22P02' THEN INSERT INTO native_log VALUES(20,20); END;
    BEGIN INSERT INTO native_log VALUES(21,CARDINALITY(ARRAY[ARRAY[1],ARRAY[2,3]]));
    EXCEPTION WHEN array_subscript_error THEN INSERT INTO native_log VALUES(22,22); END;
    BEGIN RAISE EXCEPTION USING ERRCODE='numeric_value_out_of_range', MESSAGE='numero fuori intervallo';
    EXCEPTION WHEN data_exception THEN INSERT INTO native_log VALUES(23,23); END;
    BEGIN RAISE null_value_not_allowed USING MESSAGE='valore richiesto';
    EXCEPTION WHEN SQLSTATE '22004' THEN INSERT INTO native_log VALUES(24,24); END;
  END $$`);
  await all('CALL native_state()');
  await rows('SELECT id FROM native_log WHERE id>=20 ORDER BY id', [{id:20},{id:22},{id:23},{id:24}]);
  await all('CREATE TABLE condition_log(id INT PRIMARY KEY,name TEXT,state TEXT)');
  const catalog = require('../db/sqlCondizioniPostgres.json').conditions;
  const conditions = Object.entries(catalog).flatMap(([name, states]) => states.map(state => ({name,state})));
  assert.equal(conditions.length, 251);
  const expectedConditions = [];
  for (let start = 0; start < conditions.length; start += 16) {
    const batch = conditions.slice(start, start + 16);
    const body = batch.map(({name,state}, i) => {
      const id = start + i;
      expectedConditions.push({id,name,state});
      return `BEGIN RAISE SQLSTATE '${state}'; EXCEPTION WHEN ${name} THEN INSERT INTO condition_log VALUES(${id},'${name}','${state}'); END;`;
    }).join('\n');
    await all(`CREATE PROCEDURE condition_${start}() LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
    await all(`CALL condition_${start}()`);
  }
  await rows('SELECT id,name,state FROM condition_log ORDER BY id', expectedConditions);
  console.log('PASS condizioni PostgreSQL: 247 nomi, 251 SQLSTATE eseguiti in handler su entrambi i motori disponibili');
  await all(`CREATE PROCEDURE native_join() BEGIN
    DECLARE CONTINUE HANDLER FOR SQLSTATE '22012' INSERT INTO native_log VALUES(6,6);
    UPDATE native_log l SET n=10/i.zero FROM native_input i WHERE l.id=i.id;
    INSERT INTO native_log SELECT i.id+10,l.n FROM native_input i JOIN native_log l ON i.id=l.id;
  END`, null);
  await all('CALL native_join()', null);
  await rows('SELECT n FROM native_log WHERE id=11', [{n:1}], null);
  await rows('SELECT n FROM native_log WHERE id=6', [{n:6}], null);
  await rows("SELECT CAST('abcdef' AS VARCHAR(3)) AS short_text,CAST(NULL AS VARCHAR(3)) AS absent,CAST('a' AS CHAR(3)) AS padded,CAST('false' AS BOOLEAN) AS boolean_value,CAST(1.5 AS INT) AS rounded", [{short_text:'abc',absent:null,padded:'a  ',boolean_value:false,rounded:2}]);
  await rows('SELECT CAST(ARRAY[1,2] AS TEXT[]) AS text_array', [{text_array:['1','2']}]);
  const binaryCast = "SELECT HEX(CAST('abcd' AS BINARY(2))) AS truncated,HEX(CAST('a' AS BINARY(2))) AS padded,CAST(NULL AS BINARY(2)) AS absent";
  await rows(binaryCast, [{truncated:'6162',padded:'6100',absent:null}], null, binaryCast);
  await query('SELECT CAST(32768 AS SMALLINT) AS invalid_number', /overflow/i); count++;
  await query('SELECT CAST(999.995 AS DECIMAL(5,2)) AS invalid_number', /overflow/i); count++;
  await all(`CREATE PROCEDURE native_cursor() BEGIN
    DECLARE x INT;
    DECLARE c CURSOR FOR SELECT 10/zero FROM native_input;
    DECLARE CONTINUE HANDLER FOR SQLSTATE '22012' INSERT INTO native_log VALUES(7,7);
    OPEN c;
    INSERT INTO native_log VALUES(8,8);
  END`, null);
  await all('CALL native_cursor()', null);
  await rows('SELECT id FROM native_log WHERE id IN (7,8) ORDER BY id', [{id:7},{id:8}], null);
  await all('CREATE TABLE arr(id INT PRIMARY KEY,a INT[] UNIQUE,t VARCHAR(3)[],m INT[][])');
  await all("INSERT INTO arr VALUES(1,ARRAY[1,NULL,3],ARRAY['ab',NULL],ARRAY[[1,2],[3,4]]),(2,ARRAY[1,4],ARRAY[]::VARCHAR[],ARRAY[]::INT[])");
  await rows('SELECT id,a,t,m FROM arr ORDER BY id', [{id:1,a:[1,null,3],t:['ab',null],m:[[1,2],[3,4]]},{id:2,a:[1,4],t:[],m:[]}]);
  await rows('SELECT a[1] AS a,a[0] AS z,a[20] AS missing,CARDINALITY(m) AS n,ARRAY_LENGTH(m,2) AS dim FROM arr WHERE id=1', [{a:1,z:null,missing:null,n:4,dim:2}]);
  await rows('SELECT 1=ANY(a) AS yes,2=ANY(a) AS maybe,2=ALL(ARRAY[]) AS empty,2=ANY(NULL) AS absent FROM arr WHERE id=1', [{yes:true,maybe:null,empty:true,absent:null}], 'SELECT 1=ANY(a) AS yes,2=ANY(a) AS maybe,2=ALL(ARRAY[]::INT[]) AS empty,2=ANY(NULL::INT[]) AS absent FROM arr WHERE id=1');
  await rows('SELECT a @> ARRAY[1] AS contains,a && ARRAY[4] AS overlaps FROM arr ORDER BY id', [{contains:true,overlaps:false},{contains:true,overlaps:true}]);
  await query('INSERT INTO arr(id,a) VALUES(3,ARRAY[1,4])', /duplicata/i); count++;
  await query("INSERT INTO arr(id,t) VALUES(3,ARRAY['long'])", /validation/i); count++;
  await query('INSERT INTO arr(id,m) VALUES(3,ARRAY[[1],[2,3]])', /validation|Dimensioni/i); count++;
  await rows('SELECT m[1] AS incomplete,m[1][2] AS element,3=ANY(m) AS present,m @> ARRAY[3] AS contained FROM arr WHERE id=1', [{incomplete:null,element:2,present:true,contained:true}]);
  await query('SELECT ARRAY[[1],[2,3]] AS malformed', /Dimensioni/i); count++;
  await assert.rejects(database.collection('arr').insertOne({id:3,a:[1.5]}), /validation/i); count++;
  await all('CREATE PROCEDURE arr_call(IN p INT[]) BEGIN INSERT INTO arr(id,a) VALUES(3,p); END', 'CREATE PROCEDURE arr_call(IN p INT[]) LANGUAGE SQL BEGIN ATOMIC INSERT INTO arr(id,a) VALUES(3,p); END');
  await all('CALL arr_call(ARRAY[7,8])');
  await rows('SELECT a FROM arr WHERE id=3', [{a:[7,8]}]);
  if (pg) await pg.query('DROP PROCEDURE arr_call(INT[])');
  await query('DROP PROCEDURE arr_call()'); count++;
  await all('ALTER TABLE arr ALTER COLUMN a TYPE BIGINT[]');
  await rows('SELECT a FROM arr WHERE id=3', [{a:[7,8]}], 'SELECT a::INT[] AS a FROM arr WHERE id=3');
  await rows('SELECT ARRAY[NULL]::INT[] @> ARRAY[NULL]::INT[] AS contains,ARRAY[NULL]::INT[] && ARRAY[NULL]::INT[] AS overlaps', [{contains:false,overlaps:false}]);
  await rows('SELECT ARRAY_CAT(ARRAY[1,2],ARRAY[[3,4],[5,6]]) AS a,ARRAY_CAT(ARRAY[[1,2],[3,4]],ARRAY[5,6]) AS b,ARRAY_CAT(NULL::INT[],NULL::INT[]) AS absent',
    [{a:[[1,2],[3,4],[5,6]],b:[[1,2],[3,4],[5,6]],absent:null}]);
  await rows('SELECT ARRAY_REPLACE(ARRAY[[1,2],[3,1]],1,9) AS a,ARRAY_REPLACE(ARRAY[[1,NULL],[NULL,2]],NULL,9) AS b', [{a:[[9,2],[3,9]],b:[[1,9],[9,2]]}]);
  await rows('SELECT ARRAY[1,2] || ARRAY[[3,4],[5,6]] AS a,ARRAY[1,2] || 3 AS b,0 || ARRAY[1,2] AS c,ARRAY[1,2] || NULL AS d',
    [{a:[[1,2],[3,4],[5,6]],b:[1,2,3],c:[0,1,2],d:[1,2]}]);
  await all(`CREATE PROCEDURE array_errors() LANGUAGE plpgsql AS $$ BEGIN
    BEGIN INSERT INTO native_log VALUES(30,ARRAY_POSITION(ARRAY[1,2],1,NULL));
    EXCEPTION WHEN null_value_not_allowed THEN INSERT INTO native_log VALUES(31,31); END;
    BEGIN INSERT INTO native_log VALUES(32,ARRAY_POSITION(ARRAY[[1,2],[3,4]],3));
    EXCEPTION WHEN feature_not_supported THEN INSERT INTO native_log VALUES(33,33); END;
    BEGIN INSERT INTO native_log VALUES(34,CARDINALITY(ARRAY_REMOVE(ARRAY[[1,2],[3,4]],3)));
    EXCEPTION WHEN feature_not_supported THEN INSERT INTO native_log VALUES(35,35); END;
    BEGIN INSERT INTO native_log VALUES(36,CARDINALITY(ARRAY_APPEND(ARRAY[[1,2],[3,4]],5)));
    EXCEPTION WHEN data_exception THEN INSERT INTO native_log VALUES(37,37); END;
    BEGIN INSERT INTO native_log VALUES(38,CARDINALITY(ARRAY_CAT(ARRAY[[1,2]],ARRAY[[3,4,5]])));
    EXCEPTION WHEN array_subscript_error THEN INSERT INTO native_log VALUES(39,39); END;
  END $$`);
  await all('CALL array_errors()');
  await rows('SELECT id FROM native_log WHERE id>=30 ORDER BY id', [{id:31},{id:33},{id:35},{id:37},{id:39}]);
  await query('CREATE TRIGGER arr_before BEFORE INSERT ON arr FOR EACH ROW SET NEW.a=ARRAY_APPEND(NEW.a,10)');
  await query('INSERT INTO arr(id,a) VALUES(4,ARRAY[9])');
  await rows('SELECT a FROM arr WHERE id=4', [{a:[9,10]}], null);
  await all('CREATE TABLE array_parent(k INT[] PRIMARY KEY)');
  await all('CREATE TABLE array_child(id INT PRIMARY KEY,k INT[] REFERENCES array_parent(k) ON DELETE CASCADE)');
  await all('INSERT INTO array_parent VALUES(ARRAY[1]),(ARRAY[[1]])');
  await all('INSERT INTO array_child VALUES(1,ARRAY[1]),(2,ARRAY[[1]])');
  await rows('SELECT c.id FROM array_parent p JOIN array_child c ON p.k=c.k ORDER BY c.id', [{id:1},{id:2}]);
  await all('DELETE FROM array_parent WHERE k=ARRAY[1]');
  await rows('SELECT id FROM array_child', [{id:2}]);
  await all('CREATE DOMAIN positive_int AS INT DEFAULT 2 CONSTRAINT positive_check CHECK(VALUE>0)');
  await all('CREATE DOMAIN small_positive AS positive_int CONSTRAINT small_check CHECK(VALUE<100)');
  await all('CREATE TABLE dom_a(id INT PRIMARY KEY,n positive_int)');
  await all('CREATE TABLE dom_b(id INT PRIMARY KEY,n small_positive DEFAULT 3)');
  await all('INSERT INTO dom_a(id) VALUES(1)');
  await all('INSERT INTO dom_b(id) VALUES(1)');
  await rows('SELECT n FROM dom_a', [{n:2}]);
  await rows('SELECT n FROM dom_b', [{n:3}]);
  await query('INSERT INTO dom_a VALUES(2,-1)', /validation/i); count++;
  await assert.rejects(database.collection('dom_a').insertOne({id:2,n:-1}), /validation/i); count++;
  await query('ALTER DOMAIN positive_int ADD CONSTRAINT above_ten CHECK(VALUE>10)', /violano|compatibile/i); count++;
  if (pg) { await assert.rejects(pg.query('ALTER DOMAIN positive_int ADD CONSTRAINT above_ten CHECK(VALUE>10)')); npg++; }
  await all('INSERT INTO dom_a VALUES(2,4)');
  await query('ALTER DOMAIN positive_int ADD CONSTRAINT no_four CHECK(VALUE<>4)', /violano/i); count++;
  if (pg) { await assert.rejects(pg.query('ALTER DOMAIN positive_int ADD CONSTRAINT no_four CHECK(VALUE<>4)')); npg++; }
  await assert.rejects(database.collection('dom_a').insertOne({id:99,n:-2}), /validation/i); count++;
  await all('ALTER DOMAIN positive_int ADD CONSTRAINT below_ten CHECK(VALUE<10)');
  await query('ALTER DOMAIN positive_int ADD CONSTRAINT no_three CHECK(VALUE<>3)', /violano/i); count++;
  if (pg) { await assert.rejects(pg.query('ALTER DOMAIN positive_int ADD CONSTRAINT no_three CHECK(VALUE<>3)')); npg++; }
  await query('INSERT INTO dom_b VALUES(2,20)', /validation/i); count++;
  await assert.rejects(database.collection('dom_b').insertOne({id:2,n:20}), /validation/i); count++;
  await all('ALTER DOMAIN positive_int SET DEFAULT 5');
  await all('INSERT INTO dom_a(id) VALUES(3)');
  await all('INSERT INTO dom_b(id) VALUES(3)');
  await rows('SELECT n FROM dom_a WHERE id=3', [{n:5}]);
  await rows('SELECT n FROM dom_b WHERE id=3', [{n:3}]);
  await all('ALTER DOMAIN positive_int SET NOT NULL');
  await query('INSERT INTO dom_a VALUES(4,NULL)', /validation/i); count++;
  await all('ALTER DOMAIN positive_int DROP CONSTRAINT below_ten');
  await all('INSERT INTO dom_a VALUES(4,20)');
  await query('DROP DOMAIN positive_int', /dipendenza/i); count++;
  await all('CREATE PROCEDURE dom_call(IN p positive_int) BEGIN INSERT INTO dom_a VALUES(5,p); END', 'CREATE PROCEDURE dom_call(IN p positive_int) LANGUAGE SQL BEGIN ATOMIC INSERT INTO dom_a VALUES(5,p); END');
  await query('CALL dom_call(-1)', /compatibile/i); count++;
  await all('CALL dom_call(7)');
  await rows('SELECT n FROM dom_a WHERE id=5', [{n:7}]);
  await all('ALTER TABLE dom_a ALTER COLUMN n SET NOT NULL');
  await all('ALTER DOMAIN positive_int DROP NOT NULL');
  await query('INSERT INTO dom_a VALUES(6,NULL)', /validation/i); count++;
  await all('CREATE TABLE dom_conversion(id INT PRIMARY KEY,n INT)');
  await all('INSERT INTO dom_conversion VALUES(1,4)');
  await all('ALTER TABLE dom_conversion ALTER COLUMN n TYPE positive_int');
  await query('UPDATE dom_conversion SET n=-1', /validation/i); count++;
  await all('ALTER TABLE dom_conversion ALTER COLUMN n TYPE INT');
  await all('UPDATE dom_conversion SET n=-1');
  await all('CREATE DOMAIN invalid_default AS INT DEFAULT -1 CHECK(VALUE>0)');
  await all('CREATE TABLE dom_default(n invalid_default)');
  await query('INSERT INTO dom_default DEFAULT VALUES', /validation/i); count++;
  if (pg) { await assert.rejects(pg.query('INSERT INTO dom_default DEFAULT VALUES')); npg++; }
  await all('ALTER DOMAIN invalid_default SET DEFAULT 2');
  await all('INSERT INTO dom_default DEFAULT VALUES');
  await rows('SELECT n FROM dom_default', [{n:2}]);
  await all(`CREATE PROCEDURE dom_error() LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO dom_default VALUES(3);
    BEGIN INSERT INTO dom_default VALUES(-1);
    EXCEPTION WHEN check_violation THEN INSERT INTO dom_default VALUES(4); END;
  END $$`);
  await all('CALL dom_error()');
  await rows('SELECT n FROM dom_default ORDER BY n', [{n:2},{n:3},{n:4}]);
  await all('CREATE DOMAIN item_value AS INT DEFAULT 7 NOT NULL CHECK(VALUE>0)');
  await all('CREATE TABLE dom_array(id INT DEFAULT 1 NOT NULL PRIMARY KEY,a item_value[])');
  await all('INSERT INTO dom_array(id) VALUES(1)');
  await rows('SELECT a FROM dom_array', [{a:null}]);
  await all('INSERT INTO dom_array VALUES(2,ARRAY[1,2])');
  await query('INSERT INTO dom_array VALUES(3,ARRAY[1,NULL])', /validation/i); count++;
  if (pg) { await assert.rejects(pg.query('INSERT INTO dom_array VALUES(3,ARRAY[1,NULL])'), {code:'23502'}); npg++; }
  await query('INSERT INTO dom_array VALUES(3,ARRAY[1,-1])', /validation/i); count++;
  if (pg) { await assert.rejects(pg.query('INSERT INTO dom_array VALUES(3,ARRAY[1,-1])'), {code:'23514'}); npg++; }
  await query('ALTER DOMAIN item_value ADD CHECK(VALUE>1)', /violano/i); count++;
  if (pg) { await assert.rejects(pg.query('ALTER DOMAIN item_value ADD CHECK(VALUE>1)')); npg++; }
  await all('ALTER DOMAIN item_value SET DEFAULT 8');
  await all('INSERT INTO dom_array(id) VALUES(3)');
  await rows('SELECT a FROM dom_array ORDER BY id', [{a:null},{a:[1,2]},{a:null}], 'SELECT a::INT[] AS a FROM dom_array ORDER BY id');
  await assert.rejects(database.collection('dom_array').insertOne({id:4,a:[1,-1]}), /validation/i); count++;
  const { guardStrategy } = require('../auth/guardStrategy'), { makePrincipal } = require('../auth/principal');
  const scoped = guardStrategy(base, {connName:'test',principal:makePrincipal({_id:'domain-test',type:'subuser',ownerId:'owner'},
    [{connName:'test',capabilities:['ddl'],scope:{databases:[database.databaseName],collections:['item_value']}}])});
  await assert.rejects(scoped.mongoSqlSchema(database.databaseName,'item_value',{sql:'ALTER DOMAIN item_value DROP NOT NULL'}), /autorizzat|consentit|permess/i); count++;
  await assert.rejects(database.collection('dom_array').insertOne({id:4,a:[null]}), /validation/i); count++;
  await all('CREATE TABLE ranges(id INT PRIMARY KEY,r INT4RANGE UNIQUE,n NUMRANGE,d DATERANGE)');
  await all("INSERT INTO ranges VALUES(1,INT4RANGE(1,5,'(]'),NUMRANGE(1,2,'[]'),DATERANGE('2026-01-01','2026-01-03','[]'))");
  await all("INSERT INTO ranges(id,r) VALUES(2,'empty'),(3,'(,10)'),(4,'[20,)')");
  await rows('SELECT LOWER(r) AS lo,UPPER(r) AS hi,LOWER_INC(r) AS li,UPPER_INC(r) AS ui FROM ranges WHERE id=1', [{lo:2,hi:6,li:true,ui:false}]);
  await rows('SELECT id,ISEMPTY(r) AS empty,LOWER_INF(r) AS li,UPPER_INF(r) AS ui FROM ranges ORDER BY id', [{id:1,empty:false,li:false,ui:false},{id:2,empty:true,li:false,ui:false},{id:3,empty:false,li:true,ui:false},{id:4,empty:false,li:false,ui:true}]);
  await rows('SELECT r @> 2 AS c,r @> 6 AS outside,r && INT4RANGE(6,10) AS overlap,INT4RANGE(2,4) <@ r AS subset FROM ranges WHERE id=1', [{c:true,outside:false,overlap:false,subset:true}]);
  await rows("SELECT r @> 'empty'::INT4RANGE AS c,ISEMPTY(INT4RANGE(1,2,'()')) AS empty FROM ranges WHERE id=2", [{c:true,empty:true}]);
  await query('INSERT INTO ranges(id,r) VALUES(5,INT4RANGE(2,6))', /duplicat/i); count++;
  await query("INSERT INTO ranges(id,r) VALUES(5,'[9,2)')", /Intervallo|convert/i); count++;
  await query('INSERT INTO ranges(id,r) VALUES(5,42)', /Intervallo|convert/i); count++;
  await query('SELECT INT4RANGE(1,2,NULL) AS invalid_range', /Intervallo|convert/i); count++;
  const invalidRange = { _sqlRange:'INT4RANGE',empty:false,lower:1,upper:4,lowerInc:false,upperInc:true };
  await assert.rejects(database.collection('ranges').insertOne({id:5,r:invalidRange}), /validation/i); count++;
  await all('CREATE PROCEDURE range_call(IN p INT4RANGE) BEGIN INSERT INTO ranges(id,r) VALUES(5,p); END', 'CREATE PROCEDURE range_call(IN p INT4RANGE) LANGUAGE SQL BEGIN ATOMIC INSERT INTO ranges(id,r) VALUES(5,p); END');
  await all('CALL range_call(INT4RANGE(10,12))');
  await rows('SELECT LOWER(r) AS lo,UPPER(r) AS hi FROM ranges WHERE id=5', [{lo:10,hi:12}]);
  await rows("SELECT CAST(LOWER(INT8RANGE(9007199254740993,9007199254740995,'[]')) AS TEXT) AS lo,CAST(UPPER(INT8RANGE(9007199254740993,9007199254740995,'[]')) AS TEXT) AS hi", [{lo:'9007199254740993',hi:'9007199254740996'}]);
  await rows("SELECT CAST(LOWER(NUMRANGE(9007199254740993.125,9007199254740994.125)) AS TEXT) AS lo", [{lo:'9007199254740993.125'}]);
  await rows('SELECT DAY(UPPER(d)) AS day_number FROM ranges WHERE id=1', [{day_number:4}], 'SELECT EXTRACT(DAY FROM UPPER(d))::INT AS day_number FROM ranges WHERE id=1');
  await all('CREATE TABLE stmt(id INT PRIMARY KEY,n INT)');
  await all('CREATE TABLE stmt_log(event TEXT)');
  for (const timing of ['BEFORE','AFTER']) for (const event of ['INSERT','UPDATE','DELETE','TRUNCATE']) {
    const name = `stmt_${timing.toLowerCase()}_${event.toLowerCase()}`, body = `INSERT INTO stmt_log VALUES('${timing} ${event}');`;
    if (pg) { await pg.query(`CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NULL; END $$`); npg++; }
    await all(`CREATE TRIGGER ${name} ${timing} ${event} ON stmt FOR EACH STATEMENT BEGIN ${body} END`, `CREATE TRIGGER ${name} ${timing} ${event} ON stmt FOR EACH STATEMENT EXECUTE FUNCTION ${name}_fn()`);
  }
  await all('INSERT INTO stmt VALUES(1,1),(2,2)');
  await all('UPDATE stmt SET n=n WHERE id=99');
  await all('DELETE FROM stmt WHERE id=99');
  await all('TRUNCATE TABLE stmt');
  await rows('SELECT event FROM stmt_log', ['BEFORE INSERT','AFTER INSERT','BEFORE UPDATE','AFTER UPDATE','BEFORE DELETE','AFTER DELETE','BEFORE TRUNCATE','AFTER TRUNCATE'].map(event=>({event})));
  await query('DELETE FROM stmt_log');
  await strategy.shellWrite(database.databaseName,'stmt',{op:'updateMany',filter:'{"id":99}',update:'{"$set":{"n":1}}'});
  await rows('SELECT event FROM stmt_log', [{event:'BEFORE UPDATE'},{event:'AFTER UPDATE'}], null);
  await query('DELETE FROM stmt_log');
  await strategy.docInsert(database.databaseName,'stmt',{doc:'[{"id":1,"n":1},{"id":2,"n":2}]'});
  await rows('SELECT event FROM stmt_log', [{event:'BEFORE INSERT'},{event:'AFTER INSERT'}], null);
  await all('CREATE TABLE stmt_conflict(id INT PRIMARY KEY,n INT)');
  await all('DELETE FROM stmt_log');
  for (const timing of ['BEFORE','AFTER']) {
    const name = `conflict_${timing.toLowerCase()}`, body = `INSERT INTO stmt_log VALUES('${timing} UPDATE n');`;
    if (pg) { await pg.query(`CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NULL; END $$`); npg++; }
    await all(`CREATE TRIGGER ${name} ${timing} UPDATE OF n ON stmt_conflict FOR EACH STATEMENT BEGIN ${body} END`,
      `CREATE TRIGGER ${name} ${timing} UPDATE OF n ON stmt_conflict FOR EACH STATEMENT EXECUTE FUNCTION ${name}_fn()`);
  }
  await all('INSERT INTO stmt_conflict VALUES(1,1) ON CONFLICT(id) DO UPDATE SET n=EXCLUDED.n');
  await all('INSERT INTO stmt_conflict VALUES(1,2) ON CONFLICT(id) DO UPDATE SET n=EXCLUDED.n WHERE stmt_conflict.n<ExClUdEd.n');
  await all('INSERT INTO stmt_conflict VALUES(1,3) ON CONFLICT(id) DO NOTHING');
  await all('INSERT INTO stmt_conflict VALUES(1,4) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id');
  await rows('SELECT event FROM stmt_log', ['BEFORE UPDATE n','AFTER UPDATE n','BEFORE UPDATE n','AFTER UPDATE n'].map(event=>({event})));
  await rows('SELECT id,n FROM stmt_conflict', [{id:1,n:2}]);
  await all('CREATE TABLE dep_routine(id INT PRIMARY KEY,n INT,x INT)');
  await all('CREATE PROCEDURE dep_leaf() LANGUAGE SQL BEGIN ATOMIC INSERT INTO dep_routine(id,n) VALUES(1,2); END');
  await all('CREATE PROCEDURE dep_parent() LANGUAGE SQL BEGIN ATOMIC CALL dep_leaf(); END', null);
  await query('ALTER TABLE dep_routine ALTER COLUMN n TYPE BIGINT', /dipendenza/i); count++;
  if (pg) { await assert.rejects(pg.query('ALTER TABLE dep_routine ALTER COLUMN n TYPE BIGINT')); npg++; }
  await all('ALTER TABLE dep_routine ALTER COLUMN x TYPE BIGINT');
  await query('DROP TABLE dep_routine', /dipendenza/i); count++;
  await query('DROP PROCEDURE dep_leaf()', /dipendenza/i); count++;
  await all('ALTER TABLE dep_routine RENAME COLUMN n TO num');
  await all('CALL dep_parent()', 'CALL dep_leaf()');
  await rows('SELECT id,num FROM dep_routine', [{id:1,num:2}]);
  await query('ALTER TABLE dep_routine DROP COLUMN num', /dipendenza/i); count++;
  await all('ALTER TABLE dep_routine DROP COLUMN num CASCADE');
  await query('CALL dep_parent()', /inesistente/i); count++;
  const { formatCode, minifyCode } = await import('../public/js/query-formatter.js');
  for (const text of ['SELECT ARRAY[[1,2],[3,4]] AS a', 'SELECT (ARRAY[1,2]::INT[])[2] AS n', 'SELECT LOWER(INT4RANGE(1,4)) AS n', 'SELECT 2=ANY(ARRAY[1,NULL]) AS n']) {
    const expected = await query(text);
    for (const transform of [formatCode, minifyCode]) { assert.deepEqual(await query(transform(text,'mongodb')), expected); count++; }
  }
  return { mongo: count, postgres: npg, mysql: nmy };
};
