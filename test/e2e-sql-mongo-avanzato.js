'use strict';
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const { Client: PgClient, types: pgTypes } = require('pg');
const mysql = require('mysql2/promise');
const { io } = require('socket.io-client');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_avanzato' });
const db = targets.target('mongo'), port = Number(process.env.MONGO_PORT || 27039);
const client = new MongoClient(`mongodb://127.0.0.1:${port}`, { serverSelectionTimeoutMS: 5000 });
const pg = process.env.PGPORT ? new PgClient({ host: '127.0.0.1', port: Number(process.env.PGPORT), user: 'postgres', database: 'postgres' }) : null;
let server, socket, my, connected = false, pgConnected = false, count = 0, confronti = 0, confrontiMysql = 0;
const ordina = rows => rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).sort()))).sort();
const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(20000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res)));
async function query(code, error) {
  const res = await emit('query:execute', { db, coll: 'a', engine: 'mongodb', code });
  if (error) { assert.equal(res.ok, false, code); assert.match(res.error, error); return; }
  assert.equal(res.ok, true, `${code}: ${res.error}`);
  return EJSON.deserialize(res.data, { relaxed: true });
}
async function prova(nome, sql, expected) {
  const actual = await query(sql);
  assert.deepEqual(actual, expected, nome);
  if (pg) {
    const result = (await pg.query(sql)).rows;
    assert.deepEqual(ordina(actual), ordina(result), `${nome}: confronto PostgreSQL`);
    confronti++;
  }
  if (my && !/\b(FULL|RETURNING|NULLS|GROUPS|EXCLUDE|FILTER)\b/i.test(sql) && !/ORDER BY SUM\(/i.test(sql)) {
    const [rows] = await my.query(sql);
    assert.deepEqual(ordina(actual), ordina(rows), `${nome}: confronto MySQL`);
    confrontiMysql++;
  }
  count++; console.log(`  OK   ${nome}`);
}
(async () => {
  targets.assertOwned(db); await client.connect(); connected = true;
  const database = client.db(db);
  await database.collection('a').insertMany([{ id: 1, k: 1 }, { id: 2, k: 2 }, { id: 3, k: null }, { id: 4, k: 1 }]);
  await database.collection('b').insertMany([{ id: 10, k: 1 }, { id: 11, k: 3 }, { id: 12, k: null }]);
  await database.collection('t').insertMany([{ id: 1, g: 'a', n: 10 }, { id: 2, g: 'a', n: 10 }, { id: 3, g: 'a', n: 20 }, { id: 4, g: 'b', n: null }]);
  await database.collection('archi').insertMany([{ da: 1, a: 2 }, { da: 2, a: 3 }, { da: 3, a: 1 }]);
  await database.collection('scritture').insertMany([{ _id: 1, n: 1 }, { _id: 2, n: 2 }]);
  if (pg) {
    pgTypes.setTypeParser(20, Number); pgTypes.setTypeParser(1700, Number);
    await pg.connect(); pgConnected = true;
    await pg.query(`CREATE SCHEMA "${db}"`);
    await pg.query(`SET search_path TO "${db}"`);
    await pg.query('CREATE TABLE a(id int,k int); CREATE TABLE b(id int,k int); CREATE TABLE t(id int,g text,n int); CREATE TABLE archi(da int,a int); CREATE TABLE scritture(_id int PRIMARY KEY,n int)');
    await pg.query("INSERT INTO a VALUES(1,1),(2,2),(3,NULL),(4,1); INSERT INTO b VALUES(10,1),(11,3),(12,NULL); INSERT INTO t VALUES(1,'a',10),(2,'a',10),(3,'a',20),(4,'b',NULL); INSERT INTO archi VALUES(1,2),(2,3),(3,1); INSERT INTO scritture VALUES(1,1),(2,2)");
  }
  if (process.env.MYSQL_PORT) {
    my = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MYSQL_PORT), user: 'root', password: '', multipleStatements: true, decimalNumbers: true });
    await my.query(`CREATE DATABASE \`${db}\``);
    await my.query(`USE \`${db}\``);
    await my.query('CREATE TABLE a(id int,k int); CREATE TABLE b(id int,k int); CREATE TABLE t(id int,g text,n int); CREATE TABLE archi(da int,a int); CREATE TABLE scritture(_id int PRIMARY KEY,n int)');
    await my.query("INSERT INTO a VALUES(1,1),(2,2),(3,NULL),(4,1); INSERT INTO b VALUES(10,1),(11,3),(12,NULL); INSERT INTO t VALUES(1,'a',10),(2,'a',10),(3,'a',20),(4,'b',NULL); INSERT INTO archi VALUES(1,2),(2,3),(3,1); INSERT INTO scritture VALUES(1,1),(2,2)");
  }
  server = await startTestServer({ port: Number(process.env.E2E_PORT || 3162), env: { CODEDB_SQL_RECURSION_LIMIT: '12' } });
  socket = io(server.url);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const conn = await emit('mongo:connect', { host: '127.0.0.1', port }); assert.equal(conn.ok, true, conn.error);
  await prova('SELECT senza FROM e letterale protetto', "SELECT 1 AS n, UPPER('ciao') AS saluto, '$nome' AS testo", [{ n: 1, saluto: 'CIAO', testo: '$nome' }]);
  await prova('Stringhe con parentesi e keyword restano valori', "SELECT '(' AS apertura,'NULL' AS parola,CASE WHEN 'ALL'='ALL' THEN 1 ELSE 0 END AS uguale", [{ apertura: '(', parola: 'NULL', uguale: 1 }]);
  await prova('RIGHT JOIN: duplicati e NULL', 'SELECT a.id AS l, b.id AS r FROM a RIGHT JOIN b ON a.k=b.k ORDER BY r,l', [{ l: 1, r: 10 }, { l: 4, r: 10 }, { l: null, r: 11 }, { l: null, r: 12 }]);
  await prova('FULL JOIN: entrambi i lati senza corrispondenza', 'SELECT a.id AS l, b.id AS r FROM a FULL OUTER JOIN b ON a.k=b.k ORDER BY r,l', [{ l: 2, r: null }, { l: 3, r: null }, { l: 1, r: 10 }, { l: 4, r: 10 }, { l: null, r: 11 }, { l: null, r: 12 }]);
  await prova('FULL JOIN con predicato complesso e CTE', 'WITH x AS (SELECT id,k FROM a WHERE id=1) SELECT x.id AS l,b.id AS r FROM x FULL JOIN b ON x.k=b.k AND b.id>10 ORDER BY r', [{ l: 1, r: null }, { l: null, r: 10 }, { l: null, r: 11 }, { l: null, r: 12 }]);
  await prova('RIGHT JOIN USING coalescente', 'SELECT k,b.id FROM a RIGHT JOIN b USING(k) ORDER BY b.id', [{ k: 1, id: 10 }, { k: 1, id: 10 }, { k: 3, id: 11 }, { k: null, id: 12 }]);
  await prova('USING distingue colonna coalescente e colonne qualificate', 'SELECT k,a.k AS ka,b.k AS kb FROM a FULL JOIN b USING(k) WHERE b.id=11', [{ k: 3, ka: null, kb: 3 }]);
  await prova('JOIN concatenati conservano il lato precedente completo', 'SELECT a.id AS a_id,b.id AS b_id,c.id AS c_id FROM a LEFT JOIN b ON a.k=b.k FULL JOIN b c ON b.k=c.k WHERE c.id=11', [{ a_id: null, b_id: null, c_id: 11 }]);
  await prova('Proiezione mista conserva colonne assenti come NULL', 'SELECT a.id AS l,b.id AS r,1 AS costante FROM a RIGHT JOIN b ON a.k=b.k WHERE b.id=11', [{ l: null, r: 11, costante: 1 }]);
  await prova('ON con predicato soltanto sul lato sinistro', 'SELECT x.id AS l,b.id AS r FROM (SELECT id,k FROM a WHERE id=1) x RIGHT JOIN b ON x.id=x.k ORDER BY r', [{ l: 1, r: 10 }, { l: 1, r: 11 }, { l: 1, r: 12 }]);
  await prova('Finestre: ranghi e peer', 'SELECT id,ROW_NUMBER() OVER (PARTITION BY g ORDER BY n,id) AS rn,RANK() OVER(PARTITION BY g ORDER BY n) AS r,DENSE_RANK() OVER(PARTITION BY g ORDER BY n) AS d,SUM(n) OVER(PARTITION BY g ORDER BY n) AS s FROM t ORDER BY id', [
    { id: 1, rn: 1, r: 1, d: 1, s: 20 }, { id: 2, rn: 2, r: 1, d: 1, s: 20 }, { id: 3, rn: 3, r: 3, d: 2, s: 40 }, { id: 4, rn: 1, r: 1, d: 1, s: null },
  ]);
  await prova('ROWS e frame vuoto: SUM NULL, COUNT zero', 'SELECT id,SUM(n) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s,COUNT(n) OVER(ORDER BY id ROWS BETWEEN 1 FOLLOWING AND 2 FOLLOWING) AS c FROM t ORDER BY id', [{ id: 1, s: 10, c: 2 }, { id: 2, s: 20, c: 1 }, { id: 3, s: 30, c: 0 }, { id: 4, s: 20, c: 0 }]);
  await prova('LAG/LEAD: default fuori partizione e NULL conservato', 'SELECT id,LAG(n,1,-1) OVER(PARTITION BY g ORDER BY id) AS p,LEAD(n) OVER(PARTITION BY g ORDER BY id) AS s FROM t ORDER BY id', [{ id: 1, p: -1, s: 10 }, { id: 2, p: 10, s: 20 }, { id: 3, p: 10, s: null }, { id: 4, p: -1, s: null }]);
  await prova('FIRST/LAST/NTH_VALUE', 'SELECT id,FIRST_VALUE(n) OVER(ORDER BY id) AS f,LAST_VALUE(n) OVER(ORDER BY id) AS l,NTH_VALUE(n,2) OVER(ORDER BY id) AS s FROM t ORDER BY id', [{ id: 1, f: 10, l: 10, s: null }, { id: 2, f: 10, l: 10, s: 10 }, { id: 3, f: 10, l: 20, s: 10 }, { id: 4, f: 10, l: null, s: 10 }]);
  await prova('NTILE, PERCENT_RANK, CUME_DIST', 'SELECT id,NTILE(3) OVER(ORDER BY id) AS nt,PERCENT_RANK() OVER(PARTITION BY g ORDER BY n) AS pr,CUME_DIST() OVER(PARTITION BY g ORDER BY n) AS cd FROM t ORDER BY id', [{ id: 1, nt: 1, pr: 0, cd: 2 / 3 }, { id: 2, nt: 1, pr: 0, cd: 2 / 3 }, { id: 3, nt: 2, pr: 1, cd: 1 }, { id: 4, nt: 3, pr: 0, cd: 1 }]);
  await prova('MIN/MAX/AVG e RANGE con offset', 'SELECT id,MIN(n) OVER(ORDER BY n RANGE BETWEEN 5 PRECEDING AND 5 FOLLOWING) AS mi,MAX(n) OVER(ORDER BY n RANGE BETWEEN 5 PRECEDING AND 5 FOLLOWING) AS ma,AVG(n) OVER(ORDER BY n RANGE BETWEEN 5 PRECEDING AND 5 FOLLOWING) AS av FROM t ORDER BY id', [{ id: 1, mi: 10, ma: 10, av: 10 }, { id: 2, mi: 10, ma: 10, av: 10 }, { id: 3, mi: 20, ma: 20, av: 20 }, { id: 4, mi: null, ma: null, av: null }]);
  await prova('Finestra dentro espressione e ordinamento esterno', 'SELECT id,ROW_NUMBER() OVER(ORDER BY id)+10 AS pos FROM t ORDER BY pos DESC LIMIT 1', [{ id: 4, pos: 14 }]);
  await prova('Finestre nominate, eredità e NULLS LAST', 'SELECT id,RANK() OVER w AS r,SUM(n) OVER(w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM t WINDOW w AS (ORDER BY n NULLS LAST,id) ORDER BY n NULLS LAST,id', [{ id: 1, r: 1, s: 10 }, { id: 2, r: 2, s: 20 }, { id: 3, r: 3, s: 40 }, { id: 4, r: 4, s: 40 }]);
  await prova('GROUPS ed EXCLUDE GROUP', 'SELECT id,SUM(n) OVER(ORDER BY n NULLS FIRST GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE GROUP) AS s FROM t ORDER BY id', [{ id: 1, s: null }, { id: 2, s: null }, { id: 3, s: 20 }, { id: 4, s: null }]);
  await prova('EXCLUDE CURRENT ROW e TIES', 'SELECT id,COUNT(*) OVER(ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE CURRENT ROW) AS c,COUNT(*) OVER(ORDER BY n NULLS FIRST RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES) AS d FROM t ORDER BY id', [{ id: 1, c: 3, d: 2 }, { id: 2, c: 3, d: 2 }, { id: 3, c: 3, d: 4 }, { id: 4, c: 3, d: 1 }]);
  await prova('Aggregati, HAVING e finestre rispettano le fasi SQL', 'SELECT g,SUM(n) AS s,SUM(SUM(n)) OVER() AS totale,RANK() OVER(ORDER BY SUM(n) DESC) AS r FROM t GROUP BY g HAVING COUNT(*)>1 ORDER BY g', [{ g: 'a', s: 40, totale: 40, r: 1 }]);
  await prova('SUM su gruppo nullo prima della finestra', 'SELECT g,SUM(n) AS s,SUM(SUM(n)) OVER() AS totale FROM t GROUP BY g ORDER BY g', [{ g: 'a', s: 40, totale: 40 }, { g: 'b', s: null, totale: 40 }]);
  await prova('Aggregati su insieme vuoto restituiscono una riga SQL', 'SELECT COUNT(*) AS c,SUM(n) AS s,ROW_NUMBER() OVER() AS r FROM t WHERE id=999', [{ c: 0, s: null, r: 1 }]);
  for (const caso of require('./sql-mongo-casi-relazionali')) await prova(...caso);
  for (const caso of require('./sql-mongo-casi-insiemi')) await prova(...caso);
  const cardinalita = 'SELECT (SELECT n FROM t) AS n';
  await query(cardinalita, /Sottoquery scalare|più di una riga/i);
  if (pg) await assert.rejects(pg.query(cardinalita), /more than one row/);
  if (my) await assert.rejects(my.query(cardinalita), /more than 1 row/);
  count++;
  await prova('Non ricorsiva dentro WITH RECURSIVE conserva i duplicati', 'WITH RECURSIVE x AS (SELECT n FROM t) SELECT n FROM x ORDER BY n', [{ n: null }, { n: 10 }, { n: 10 }, { n: 20 }]);
  await prova('CTE ricorsiva numerica', 'WITH RECURSIVE numeri(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numeri WHERE n<4) SELECT n FROM numeri ORDER BY n', [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  await prova('CTE ricorsiva UNION termina sui cicli', 'WITH RECURSIVE raggiunti(n) AS (SELECT 1 UNION SELECT e.a FROM raggiunti r JOIN archi e ON r.n=e.da) SELECT n FROM raggiunti ORDER BY n', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  await prova('CTE successive, UNION ALL e nomi posizionali', 'WITH RECURSIVE numeri(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numeri WHERE n<3), doppi(x) AS (SELECT n*2 FROM numeri) SELECT x FROM doppi UNION ALL SELECT 9 AS altro ORDER BY x DESC', [{ x: 9 }, { x: 6 }, { x: 4 }, { x: 2 }]);
  await query('WITH RECURSIVE infinito(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM infinito) SELECT n FROM infinito', /iterazioni/); count++;
  await prova('RETURNING INSERT multiplo', 'INSERT INTO scritture (_id,n) VALUES (3,3),(4,4) RETURNING _id,n*2 AS doppio', [{ _id: 3, doppio: 6 }, { _id: 4, doppio: 8 }]);
  await prova('RETURNING UPDATE multiplo restituisce valori nuovi', 'UPDATE scritture SET n=n+10 WHERE _id<=2 RETURNING _id,n', [{ _id: 1, n: 11 }, { _id: 2, n: 12 }]);
  await prova('RETURNING DELETE restituisce valori precedenti', 'DELETE FROM scritture WHERE _id>=3 RETURNING _id,n', [{ _id: 3, n: 3 }, { _id: 4, n: 4 }]);
  await prova('RETURNING senza righe', 'UPDATE scritture SET n=0 WHERE _id=999 RETURNING n', []);
  await query('UPDATE scritture SET n=999 RETURNING 1/0 AS errore', /zero|divide/i);
  assert.deepEqual(await database.collection('scritture').find({}, { projection: { _id: 1, n: 1 } }).sort({ _id: 1 }).toArray(), [{ _id: 1, n: 11 }, { _id: 2, n: 12 }]); count++;
  await query('INSERT INTO scritture (_id,n) VALUES (5,5),(1,1) RETURNING n', /duplic|E11000/i);
  assert.equal(await database.collection('scritture').countDocuments({ _id: 5 }), 0); count++;
  for (const file of ['./sql-mongo-scritture-limitate', './sql-mongo-conflitti', './sql-mongo-scritture-relazionali', './sql-mongo-schema', './sql-mongo-procedure', './sql-mongo-vincoli-referenziali', './sql-mongo-alter', './sql-mongo-trigger', './sql-mongo-cursori', './sql-mongo-varianti']) {
    const result = await require(file)({ query, database, pg, my });
    count += result.count; confronti += result.pg; confrontiMysql += result.mysql;
  }
  console.log(`PASS: ${count} verifiche SQL avanzato su MongoDB reale, comprese prove di rollback; ${confronti} confronti con PostgreSQL e ${confrontiMysql} con MySQL.`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.disconnect();
  if (server) await server.stop();
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  if (pgConnected) { targets.assertOwned(db); await pg.query(`DROP SCHEMA "${db}" CASCADE`); await pg.end(); }
  if (my) { targets.assertOwned(db); await my.query(`DROP DATABASE \`${db}\``); await my.end(); }
  await client.close();
});
