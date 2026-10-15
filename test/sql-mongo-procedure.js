'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  async function all(sql, pgSql = sql, mySql = sql) {
    await query(sql);
    if (pg && pgSql) { await pg.query(pgSql); npg++; }
    if (my && mySql) { await my.query(mySql); nmy++; }
    count++;
  }
  await all('CREATE TABLE procedurali (id INT PRIMARY KEY, n INT, testo VARCHAR(80))');
  await all("INSERT INTO procedurali(id,n,testo) VALUES(1,10,'inizio')");
  const body = 'UPDATE procedurali SET n=n+p_delta WHERE id=1; INSERT INTO procedurali(id,n,testo) VALUES(p_id,p_delta,p_testo);';
  const params = '(IN p_delta INT, IN p_id INT, IN p_testo VARCHAR(80))';
  await all(`CREATE PROCEDURE aumenta${params} BEGIN ${body} END`,
    `CREATE PROCEDURE aumenta${params} LANGUAGE SQL BEGIN ATOMIC ${body} END`,
    `CREATE PROCEDURE aumenta${params} SQL SECURITY INVOKER BEGIN ${body} END`);
  await all("CALL aumenta(2,2,'l''isola; DROP TABLE procedurali; --')");
  const rows = await query('SELECT id,n,testo FROM procedurali ORDER BY id');
  if (pg) { assert.deepEqual(rows, (await pg.query('SELECT id,n,testo FROM procedurali ORDER BY id')).rows); npg++; }
  if (my) { assert.deepEqual(rows, (await my.query('SELECT id,n,testo FROM procedurali ORDER BY id'))[0]); nmy++; }
  count++;
  await query("CALL aumenta(20,2,'duplicato')", /duplic|E11000/i);
  assert.deepEqual(await query('SELECT id,n,testo FROM procedurali ORDER BY id'), rows); count++;
  if (pg) { await assert.rejects(pg.query("CALL aumenta(20,2,'duplicato')")); npg++; }
  // MySQL non rende atomica l'intera CALL: il confronto qui usa la transazione
  // esplicita che il chiamante deve aprire nel DBMS di riferimento.
  if (my) { await my.beginTransaction(); await assert.rejects(my.query("CALL aumenta(20,2,'duplicato')")); await my.rollback(); nmy++; }
  const ciclo = 'DECLARE i INT DEFAULT 0; WHILE i<p_volte DO IF i<2 THEN UPDATE procedurali SET n=n+1 WHERE id=1; ELSE UPDATE procedurali SET n=n+2 WHERE id=1; END IF; SET i=i+1; END WHILE;';
  await all(`CREATE PROCEDURE ciclo(IN p_volte INT) BEGIN ${ciclo} END`, null);
  await all('CALL ciclo(3)', null);
  if (my) { assert.deepEqual(await query('SELECT id,n,testo FROM procedurali ORDER BY id'), (await my.query('SELECT id,n,testo FROM procedurali ORDER BY id'))[0]); nmy++; }
  await all('CREATE PROCEDURE pg_sql(IN p_n INT) LANGUAGE SQL AS $$UPDATE procedurali SET n=p_n WHERE id=1;$$', undefined,
    'CREATE PROCEDURE pg_sql(IN p_n INT) BEGIN UPDATE procedurali SET n=p_n WHERE id=1; END');
  await all('CALL pg_sql(30)');
  await all('CREATE PROCEDURE pg_ciclo(IN p_n INT) LANGUAGE PLPGSQL AS $$DECLARE i INT := 0; BEGIN WHILE i<p_n LOOP UPDATE procedurali SET n=n+1 WHERE id=1; i:=i+1; END LOOP; END;$$', undefined,
    'CREATE PROCEDURE pg_ciclo(IN p_n INT) BEGIN DECLARE i INT DEFAULT 0; WHILE i<p_n DO UPDATE procedurali SET n=n+1 WHERE id=1; SET i=i+1; END WHILE; END');
  await all('CALL pg_ciclo(2)');
  const after = await query('SELECT id,n,testo FROM procedurali ORDER BY id');
  if (pg) { assert.deepEqual(after, (await pg.query('SELECT id,n,testo FROM procedurali ORDER BY id')).rows); npg++; }
  if (my) { assert.deepEqual(after, (await my.query('SELECT id,n,testo FROM procedurali ORDER BY id'))[0]); nmy++; }
  count++;
  await query('CALL aumenta(1)', /argomenti/); count++;
  await query("CALL pg_ciclo('non numerico')", /convert|Conversion|tipo|number|parse/i); count++;
  await query('DROP PROCEDURE aumenta');
  await query("CALL aumenta(1,3,'x')", /inesistente/); count++;
  // Nemmeno una definizione alterata direttamente può introdurre SQL dinamico.
  await database.collection('_codedb_sql_procedures').insertOne({ _id: 'alterata', sql: 'CREATE PROCEDURE alterata() BEGIN DROP TABLE procedurali; END' });
  await query('CALL alterata()', /corpo della procedura/);
  assert.deepEqual(await query('SELECT id,n,testo FROM procedurali ORDER BY id'), after); count++;
  await all('CREATE PROCEDURE annidata(IN p_n INT) BEGIN CALL pg_sql(p_n); END',
    'CREATE PROCEDURE annidata(IN p_n INT) LANGUAGE PLPGSQL AS $$BEGIN CALL pg_sql(p_n); END;$$');
  await all('CALL annidata(42)');
  assert.equal((await query('SELECT n FROM procedurali WHERE id=1'))[0].n, 42); count++;
  await all("CREATE PROCEDURE fallisce() BEGIN CALL pg_sql(99); SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='annulla tutto'; END",
    "CREATE PROCEDURE fallisce() LANGUAGE PLPGSQL AS $$BEGIN CALL pg_sql(99); RAISE EXCEPTION 'annulla tutto'; END;$$");
  await query('CALL fallisce()', /annulla tutto/); count++;
  if (pg) { await assert.rejects(pg.query('CALL fallisce()'), /annulla tutto/); npg++; }
  if (my) { await my.beginTransaction(); await assert.rejects(my.query('CALL fallisce()'), /annulla tutto/); await my.rollback(); nmy++; }
  assert.equal((await query('SELECT n FROM procedurali WHERE id=1'))[0].n, 42);
  const repeat = 'DECLARE i INT DEFAULT 0; REPEAT SET i=i+1; IF i=1 THEN CALL pg_sql(1); ELSEIF i=2 THEN CALL pg_sql(2); ELSE CALL pg_sql(3); END IF; UNTIL i=3 END REPEAT;';
  await all(`CREATE PROCEDURE ripeti() BEGIN ${repeat} END`,
    'CREATE PROCEDURE ripeti() LANGUAGE PLPGSQL AS $$DECLARE i INT:=0; BEGIN LOOP i:=i+1; IF i=1 THEN CALL pg_sql(1); ELSIF i=2 THEN CALL pg_sql(2); ELSE CALL pg_sql(3); END IF; EXIT WHEN i=3; END LOOP; END;$$');
  await all('CALL ripeti()');
  assert.equal((await query('SELECT n FROM procedurali WHERE id=1'))[0].n, 3); count++;
  const pgLoop = 'CREATE PROCEDURE salti() LANGUAGE PLPGSQL AS $$DECLARE i INT:=0; BEGIN LOOP i:=i+1; CONTINUE WHEN i=1; EXIT WHEN i>2; CALL pg_sql(i); END LOOP; RETURN; CALL pg_sql(99); END;$$';
  await all(pgLoop, undefined, null); await all('CALL salti()', undefined, null);
  assert.equal((await query('SELECT n FROM procedurali WHERE id=1'))[0].n, 2); count++;
  await query('CREATE PROCEDURE ricorsiva() BEGIN CALL ricorsiva(); END');
  await query('CALL ricorsiva()', /32 chiamate/); count++;
  console.log('  OK   Procedure persistite, parametri, IF/WHILE, corpo PostgreSQL SQL, invocazione e rollback');
  return { count, pg: npg, mysql: nmy };
};
