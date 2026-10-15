'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  async function all(sql, pgSql = sql, mySql = sql) {
    await query(sql);
    if (pg) { await pg.query(pgSql); npg++; }
    if (my) { await my.query(mySql); nmy++; }
    count++;
  }
  const ddl = 'CREATE TABLE tipizzata (id INT PRIMARY KEY, codice VARCHAR(8) UNIQUE, n SMALLINT NOT NULL DEFAULT 7, prezzo DECIMAL(8,2), CONSTRAINT positivo CHECK (n>0), CONSTRAINT tetto CHECK(prezzo>=0))';
  await all(ddl);
  await all("INSERT INTO tipizzata(id,codice,prezzo) VALUES(1,'uno',12.25),(2,NULL,NULL),(3,NULL,3.50)");
  const rows = await query('SELECT id,codice,n,prezzo FROM tipizzata ORDER BY id');
  const normalize = rr => rr.map(r => ({ ...r, prezzo: r.prezzo == null ? null : Number(r.prezzo?.$numberDecimal || r.prezzo) }));
  if (pg) { assert.deepEqual(normalize(rows), (await pg.query('SELECT id,codice,n,prezzo FROM tipizzata ORDER BY id')).rows); npg++; }
  if (my) { assert.deepEqual(normalize(rows), (await my.query('SELECT id,codice,n,prezzo FROM tipizzata ORDER BY id'))[0]); nmy++; }
  assert.equal(rows[0].n, 7); count++;
  for (const sql of [
    "INSERT INTO tipizzata(id,codice) VALUES(4,'due'),(1,'tre')",
    "INSERT INTO tipizzata(id,codice) VALUES(4,'uno')",
    'INSERT INTO tipizzata(id,n) VALUES(4,NULL)',
    'INSERT INTO tipizzata(id,n) VALUES(4,-1)',
    'INSERT INTO tipizzata(id,n) VALUES(4,32768)',
    "INSERT INTO tipizzata(id,codice) VALUES(4,'troppo lungo')",
    'INSERT INTO tipizzata(id,prezzo) VALUES(4,1000000)',
    'UPDATE tipizzata SET n=-1 WHERE id=1',
    'UPDATE tipizzata SET id=1 WHERE id=2',
    'INSERT INTO tipizzata(id,sconosciuta) VALUES(4,1)',
  ]) {
    await query(sql, /valid|vincol|duplic|E11000|schema/i);
    if (pg) { await assert.rejects(pg.query(sql)); npg++; }
    if (my) { await assert.rejects(my.query(sql)); nmy++; }
    assert.deepEqual(await query('SELECT id,codice,n,prezzo FROM tipizzata ORDER BY id'), rows, `Rollback: ${sql}`);
    count++;
  }
  for (const doc of [{ id: 4, n: -1 }, { id: 4, n: 1.5 }, { id: 4, n: 1, codice: 'troppo lungo' }, { id: 4 }, { id: 4, n: 1, extra: true }]) {
    await assert.rejects(database.collection('tipizzata').insertOne(doc), err => err.code === 121); count++;
  }
  await query('INSERT INTO tipizzata(id,codice) VALUES(4,NULL) ON CONFLICT(codice) DO NOTHING');
  assert.equal(await database.collection('tipizzata').countDocuments({ id: 4 }), 1); count++;
  await query("INSERT INTO tipizzata(id,codice) VALUES(5,'uno') ON CONFLICT(codice) DO UPDATE SET n=9 RETURNING id,n");
  assert.equal((await database.collection('tipizzata').findOne({ id: 1 })).n, 9); count++;
  await all('CREATE TABLE composta (a INT, b INT, CONSTRAINT pk_composta PRIMARY KEY(a,b))');
  await all('INSERT INTO composta(a,b) VALUES(1,1),(1,2)');
  await query('INSERT INTO composta(a,b) VALUES(1,1)', /duplic|E11000/i); count++;
  await all('CREATE TABLE IF NOT EXISTS composta (altro INT)');
  assert.equal(await database.collection('composta').countDocuments(), 2); count++;
  await all('CREATE TABLE chiave_nativa (_id INT PRIMARY KEY, n INT)');
  await all('INSERT INTO chiave_nativa VALUES(1,7)');
  assert.deepEqual(await query('SELECT _id,n FROM chiave_nativa'), [{ _id: 1, n: 7 }]); count++;
  await all('CREATE TABLE precisi (id INT PRIMARY KEY, n BIGINT, d DECIMAL(28,6))');
  await all('INSERT INTO precisi(id,n,d) VALUES(1,9223372036854775807,1234567890123456789012.123456)');
  const exact = await query('SELECT CAST(n AS TEXT) AS n,CAST(d AS TEXT) AS d FROM precisi');
  assert.deepEqual(exact, [{ n: '9223372036854775807', d: '1234567890123456789012.123456' }]);
  if (pg) { assert.deepEqual(exact, (await pg.query('SELECT CAST(n AS TEXT) AS n,CAST(d AS TEXT) AS d FROM precisi')).rows); npg++; }
  if (my) { assert.deepEqual(exact, (await my.query('SELECT CAST(n AS CHAR) AS n,CAST(d AS CHAR) AS d FROM precisi'))[0]); nmy++; }
  count++;
  await all('CREATE TABLE predefiniti (n INT DEFAULT 5, testo VARCHAR(20) DEFAULT \'ciao\')');
  await all('INSERT INTO predefiniti VALUES(1,DEFAULT)');
  await all('INSERT INTO predefiniti DEFAULT VALUES', undefined, 'INSERT INTO predefiniti() VALUES()');
  await all("INSERT INTO predefiniti SELECT 3,'tre'");
  const defaults = await query('SELECT n,testo FROM predefiniti ORDER BY n');
  if (pg) { assert.deepEqual(defaults, (await pg.query('SELECT n,testo FROM predefiniti ORDER BY n')).rows); npg++; }
  if (my) { assert.deepEqual(defaults, (await my.query('SELECT n,testo FROM predefiniti ORDER BY n'))[0]); nmy++; }
  count++;
  await all('CREATE TABLE arrotondati (n INT, d DECIMAL(8,2))');
  await all('INSERT INTO arrotondati(n,d) VALUES(2.5,2.345),(-2.5,-2.345)');
  const rounded = normalize(await query('SELECT n,d AS prezzo FROM arrotondati ORDER BY n'));
  if (pg) { assert.deepEqual(rounded, (await pg.query('SELECT n,d AS prezzo FROM arrotondati ORDER BY n')).rows); npg++; }
  if (my) { assert.deepEqual(rounded, (await my.query('SELECT n,d AS prezzo FROM arrotondati ORDER BY n'))[0]); nmy++; }
  count++;
  await all('CREATE TABLE altri_tipi (id INT PRIMARY KEY, f REAL, d DOUBLE PRECISION, b BOOLEAN, giorno DATE, istante TIMESTAMP, testo TEXT, c CHAR(3), u UUID, j JSON)', undefined,
    'CREATE TABLE altri_tipi (id INT PRIMARY KEY, f REAL, d DOUBLE PRECISION, b BOOLEAN, giorno DATE, istante TIMESTAMP, testo TEXT, c CHAR(3), u CHAR(36), j JSON)');
  await all(`INSERT INTO altri_tipi VALUES(1,1.5,2.5,TRUE,'2026-10-14','2026-10-14 12:34:56','testo','abc','123e4567-e89b-12d3-a456-426614174000','{"x":[1,2]}')`);
  const other = await query('SELECT f,d,b,testo,c,u,j FROM altri_tipi');
  if (pg) { assert.deepEqual(other, (await pg.query('SELECT f,d,b,testo,c,u,j FROM altri_tipi')).rows); npg++; }
  if (my) { assert.deepEqual(other, (await my.query('SELECT f,d,b,testo,c,u,j FROM altri_tipi'))[0].map(r => ({ ...r, b: !!r.b }))); nmy++; }
  count++;
  const dates = await query('SELECT YEAR(giorno) AS y,MONTH(istante) AS m FROM altri_tipi');
  if (pg) { assert.deepEqual(dates, (await pg.query('SELECT EXTRACT(YEAR FROM giorno)::int AS y,EXTRACT(MONTH FROM istante)::int AS m FROM altri_tipi')).rows); npg++; }
  if (my) { assert.deepEqual(dates, (await my.query('SELECT YEAR(giorno) AS y,MONTH(istante) AS m FROM altri_tipi'))[0]); nmy++; }
  count++;
  await all(`UPDATE altri_tipi SET j='{"nuovo":true}' WHERE id=1`);
  assert.deepEqual(await query('SELECT j FROM altri_tipi'), [{ j: { nuovo: true } }]); count++;
  await all(`UPDATE altri_tipi SET j='{"esatto":9007199254740993}' WHERE id=1`);
  const jsonExact = (await database.collection('altri_tipi').findOne({ id: 1 })).j.esatto.toString();
  assert.equal(jsonExact, '9007199254740993');
  if (pg) { assert.equal(jsonExact, (await pg.query("SELECT j->>'esatto' AS n FROM altri_tipi")).rows[0].n); npg++; }
  if (my) { assert.equal(jsonExact, (await my.query("SELECT JSON_UNQUOTE(JSON_EXTRACT(j,'$.esatto')) AS n FROM altri_tipi"))[0][0].n); nmy++; }
  count++;
  await query("UPDATE altri_tipi SET j='non json' WHERE id=1", /JSON non valido/);
  if (pg) { await assert.rejects(pg.query("UPDATE altri_tipi SET j='non json' WHERE id=1")); npg++; }
  if (my) { await assert.rejects(my.query("UPDATE altri_tipi SET j='non json' WHERE id=1")); nmy++; }
  assert.equal((await database.collection('altri_tipi').findOne({ id: 1 })).j.esatto.toString(), jsonExact); count++;
  await all("CREATE TABLE tipi_estesi(id INT PRIMARY KEY, stato ENUM('aperto','chiuso') NOT NULL, piccolo TINYINT UNSIGNED, grande BIGINT UNSIGNED)",
    "CREATE TYPE stato_sql AS ENUM('aperto','chiuso'); CREATE TABLE tipi_estesi(id INT PRIMARY KEY,stato stato_sql NOT NULL,piccolo SMALLINT CHECK(piccolo BETWEEN 0 AND 255),grande NUMERIC(20,0) CHECK(grande BETWEEN 0 AND 18446744073709551615))");
  await all("INSERT INTO tipi_estesi VALUES(1,'aperto',255,18446744073709551615)");
  const extended = await query('SELECT stato,piccolo,CAST(grande AS TEXT) AS grande FROM tipi_estesi');
  assert.deepEqual(extended, [{ stato: 'aperto', piccolo: 255, grande: '18446744073709551615' }]); count++;
  if (pg) { assert.deepEqual(extended, (await pg.query('SELECT stato,piccolo,CAST(grande AS TEXT) AS grande FROM tipi_estesi')).rows); npg++; }
  if (my) { assert.deepEqual(extended, (await my.query('SELECT stato,piccolo,CAST(grande AS CHAR) AS grande FROM tipi_estesi'))[0]); nmy++; }
  for (const text of ["INSERT INTO tipi_estesi VALUES(2,'errato',0,0)", "INSERT INTO tipi_estesi VALUES(2,'aperto',256,0)",
    "INSERT INTO tipi_estesi VALUES(2,'aperto',-1,0)", "INSERT INTO tipi_estesi VALUES(2,'aperto',1,18446744073709551616)"]) {
    await query(text, /valid|schema/i); count++;
    if (pg) { await assert.rejects(pg.query(text)); npg++; }
    if (my) { await assert.rejects(my.query(text)); nmy++; }
  }
  await query("CREATE TABLE default_invalido(n INT DEFAULT 'impossibile')", /convert|parse|number/i); count++;
  assert.equal(await database.listCollections({ name: 'default_invalido' }).hasNext(), false);
  console.log('  OK   Tipi, default, PK/UNIQUE composte e nullable, CHECK, rollback e validazione delle scritture esterne');
  return { count, pg: npg, mysql: nmy };
};
