'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { io } = require('socket.io-client');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_native' });
const schema = registry.target('pg'), database = registry.target('my'), extraDb = registry.target('database');
const ports = { postgresql: Number(process.env.PGPORT || 55439), mysql: Number(process.env.MYSQL_PORT || 33339) };
const pg = new Client({ host: '127.0.0.1', port: ports.postgresql, user: 'postgres', database: 'postgres' });
let server, socket, my, pgConnected = false, queries = 0;
const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(20000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res)));
const payload = (type, code) => ({ tabId: type, engine: type, db: type === 'mysql' ? database : schema, code });
async function q(type, code, expected) {
  const res = await emit('query:execute', payload(type, code));
  assert.equal(res.ok, true, `${type}: ${code}\n${res.error}`);
  if (expected !== undefined) assert.deepEqual(res.data, expected, code);
  queries++;
  return res.data;
}
async function errore(type, code) {
  const res = await emit('query:execute', payload(type, code));
  assert.equal(res.ok, false, `Errore atteso: ${code}`);
  queries++;
}
async function script(type, code) {
  const runId = `native-${type}-${queries}`;
  let onProgress;
  const fine = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('script:progress', onProgress); reject(new Error('Script sospeso')); }, 20000);
    onProgress = ev => {
      if (ev.runId === runId && ['done', 'paused', 'aborted'].includes(ev.tipo)) {
        clearTimeout(timer); socket.off('script:progress', onProgress); resolve(ev);
      }
    };
    socket.on('script:progress', onProgress);
  });
  const ack = await emit('script:execute', { ...payload(type, code), runId, stopOnError: false });
  assert.equal(ack.ok, true, ack.error);
  const result = await fine;
  assert.equal(result.tipo, 'done', JSON.stringify(result));
  assert.equal(result.stato.falliti, type === 'postgresql' ? 1 : 0, JSON.stringify(result));
  queries += ack.total;
  return result;
}

(async () => {
  registry.assertOwned(schema);
  await pg.connect(); pgConnected = true;
  my = await mysql.createConnection({ host: '127.0.0.1', port: ports.mysql, user: 'root' });
  await pg.query(`CREATE SCHEMA "${schema}"`);
  await my.query(`CREATE DATABASE \`${database}\``);
  const versions = { postgresql: (await pg.query('SHOW server_version')).rows[0].server_version, mysql: (await my.query('SELECT VERSION() v'))[0][0].v };
  server = await startTestServer({ port: Number(process.env.E2E_PORT || 3181), env: {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${path.join(__dirname, 'fixtures/sql-native-mutant.cjs').replaceAll('\\', '/')}"`,
  } });
  socket = io(server.url);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const type of ['postgresql', 'mysql']) {
    const conn = await emit('mongo:connect', { tabId: type, dbType: type, host: '127.0.0.1', port: ports[type], username: type === 'mysql' ? 'root' : 'postgres', database: type === 'mysql' ? database : 'postgres' });
    assert.equal(conn.ok, true, conn.error);
  }
  console.log('Motori reali:', versions);
  const p = (sql, expected) => q('postgresql', sql, expected);
  const m = (sql, expected) => q('mysql', sql, expected);

  const mismatch = await emit('query:execute', { ...payload('postgresql', 'SELECT 1'), engine: 'mysql' });
  assert.equal(mismatch.ok, false, 'Il dialetto deve corrispondere alla connessione');
  await p(`CREATE DATABASE "${extraDb}"`);
  assert.equal((await pg.query('SELECT 1 FROM pg_database WHERE datname=$1', [extraDb])).rowCount, 1);
  await p(`DROP DATABASE "${extraDb}"`);
  await p('CREATE TABLE dati(id INT PRIMARY KEY,n INT NOT NULL CHECK(n>0))');
  await p('INSERT INTO dati VALUES(1,10),(2,20) RETURNING id', [{ id: 1 }, { id: 2 }]);
  await p('SET application_name = \'codedb_native_prova\'');
  await p('SHOW application_name', [{ application_name: 'codedb_native_prova' }]);
  const separata = await emit('collection:aggregate', { tabId: 'postgresql', db: schema, coll: 'dati', pipeline: 'SHOW application_name' });
  assert.equal(separata.ok, true, separata.error);
  assert.notEqual((separata.docs || separata.data)[0].application_name, 'codedb_native_prova', 'La sessione editor non deve essere restituita al pool della griglia');
  await p('CREATE TEMP TABLE temporanea(x INT)');
  await p('INSERT INTO temporanea VALUES(7)');
  await p('SELECT * FROM temporanea', [{ x: 7 }]);

  await p('BEGIN');
  await p('SAVEPOINT prima');
  await p('UPDATE dati SET n=30 WHERE id=1');
  await errore('postgresql', 'INSERT INTO dati VALUES(1,99)');
  // Anche cambiando bersaglio il recupero deve precedere qualsiasi SET.
  const recovered = await emit('query:execute', { ...payload('postgresql', '/* recupero */ ROLLBACK TO SAVEPOINT prima'), db: 'public' });
  assert.equal(recovered.ok, true, recovered.error);
  await p('SELECT n FROM dati WHERE id=1', [{ n: 10 }]);
  await p('INSERT INTO dati VALUES(3,30)');
  await p('COMMIT');
  await p('BEGIN');
  await errore('postgresql', 'SELECT 1/0');
  await p('ROLLBACK');
  await p('SELECT count(*)::int n FROM dati', [{ n: 3 }]);
  console.log('OK sessione, tabelle temporanee, errore nativo, savepoint e rollback PostgreSQL');

  await p("CREATE TYPE umore AS ENUM('calmo','felice')");
  await p('CREATE DOMAIN positivo AS NUMERIC(70,6) CHECK(VALUE>0)');
  await p('CREATE TYPE coppia AS (x INT,y TEXT)');
  await p('CREATE TABLE tipi(v positivo, a INT[], r INT4MULTIRANGE, t TIMESTAMP(6), j JSONB, u UUID, e umore, c coppia)');
  const numero = '123456789012345678901234567890123456789012345678901234567890.123456';
  await p(`INSERT INTO tipi VALUES('${numero}','[0:2]={1,2,3}','{[1,3),[5,8)}','2026-10-14 12:13:14.123456','{"n":9007199254740993}','12345678-1234-1234-1234-123456789abc','calmo',ROW(4,'ciao'))`);
  const tipi = (await p('SELECT * FROM tipi'))[0];
  assert.equal(tipi.v, numero); assert.equal(tipi.a, '[0:2]={1,2,3}'); assert.equal(tipi.t, '2026-10-14 12:13:14.123456');
  assert.equal(tipi.j, '{"n": 9007199254740993}'); assert.equal(tipi.r, '{[1,3),[5,8)}'); assert.equal(tipi.c, '(4,ciao)');
  await p("SELECT 'null'::jsonb j, NULL::jsonb n, '{\"t\":\"caffè\"}'::jsonb u", [{ j: 'null', n: null, u: '{"t": "caffè"}' }]);
  await p("SELECT CAST('felice' AS umore) e, a[0:1] s, array_lower(a,1) l, CAST('infinity' AS TIMESTAMP) t FROM tipi", [{ e: 'felice', s: '{1,2}', l: 0, t: 'infinity' }]);
  await p('ALTER DOMAIN positivo ADD CONSTRAINT max_num CHECK(VALUE<1e65)');
  await p('ALTER DOMAIN positivo RENAME TO positivo_nuovo');
  await errore('postgresql', 'DROP TYPE coppia');
  await p('DROP TYPE coppia CASCADE');
  await p('SELECT range_agg(r) r FROM (VALUES (int4range(1,3)),(int4range(3,5))) t(r)', [{ r: '{[1,5)}' }]);
  console.log('OK CAST, domini, precisione, array, multirange, compositi e dipendenze ALTER native');

  await p('CREATE TABLE registro(n INT)');
  await p(`CREATE FUNCTION filtra() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=99 THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await p('CREATE TRIGGER filtra BEFORE INSERT ON dati FOR EACH ROW EXECUTE FUNCTION filtra()');
  await p('INSERT INTO dati VALUES(99,99) RETURNING id', []);
  await p(`CREATE FUNCTION transizione() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN INSERT INTO registro SELECT count(*)::int FROM nuove; RETURN NULL; END $$`);
  await p('CREATE TRIGGER insieme AFTER INSERT ON dati REFERENCING NEW TABLE AS nuove FOR EACH STATEMENT EXECUTE FUNCTION transizione()');
  await p('INSERT INTO dati VALUES(4,40),(5,50)');
  await p('SELECT n FROM registro', [{ n: 2 }]);
  await p('CREATE VIEW vista AS SELECT * FROM dati');
  await p(`CREATE FUNCTION inserisci_vista() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dati VALUES(NEW.id,NEW.n); RETURN NEW; END $$`);
  await p('CREATE TRIGGER sulla_vista INSTEAD OF INSERT ON vista FOR EACH ROW EXECUTE FUNCTION inserisci_vista()');
  await p('INSERT INTO vista VALUES(6,60) RETURNING id', [{ id: 6 }]);
  await p('CREATE TABLE padre(id INT PRIMARY KEY)');
  await p('CREATE TABLE figlio(id INT REFERENCES padre DEFERRABLE INITIALLY DEFERRED)');
  await p('BEGIN'); await p('INSERT INTO figlio VALUES(1)'); await p('INSERT INTO padre VALUES(1)'); await p('COMMIT');
  await p('ALTER TRIGGER insieme ON dati RENAME TO insieme_nuovo');
  await p(`CREATE PROCEDURE diagnostica(INOUT risultato INT) LANGUAGE plpgsql AS $$ DECLARE quanti INT; BEGIN EXECUTE 'UPDATE dati SET n=n+1'; GET DIAGNOSTICS quanti=ROW_COUNT; risultato:=quanti; END $$`);
  await p('CALL diagnostica(0)', [{ risultato: 6 }]);
  await p('BEGIN'); await p('DECLARE c SCROLL CURSOR FOR SELECT id FROM dati ORDER BY id');
  await p('FETCH LAST FROM c', [{ id: 6 }]); await p('FETCH BACKWARD FROM c', [{ id: 5 }]); await p('CLOSE c'); await p('COMMIT');
  await p('WITH RECURSIVE t(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM t WHERE n<4) SELECT sum(n)::int s FROM t', [{ s: 10 }]);
  await p('WITH inseriti AS (INSERT INTO dati VALUES(7,70) RETURNING id) SELECT id FROM inseriti', [{ id: 7 }]);
  await p('SELECT a.id a,b.id b FROM (VALUES(1),(2)) a(id) FULL JOIN (VALUES(2),(3)) b(id) USING(id) ORDER BY COALESCE(a.id,b.id)', [{ a: 1, b: null }, { a: 2, b: 2 }, { a: null, b: 3 }]);
  await p('SELECT id, sum(id) OVER(ORDER BY id ROWS UNBOUNDED PRECEDING)::int s FROM dati WHERE id<3', [{ id: 1, s: 1 }, { id: 2, s: 3 }]);
  console.log('OK trigger RETURN NULL, transizioni, INSTEAD OF, FK differite, procedure dinamiche, diagnostica, cursori e SQL relazionale');

  await m('CREATE TABLE dati(id INT PRIMARY KEY,n INT CHECK(n>0),d DECIMAL(65,6), t DATETIME(6), j JSON,e ENUM(\'calmo\',\'felice\'))');
  const numeroMysql = numero.slice(1); // MySQL ammette al massimo 65 cifre, scala compresa.
  await m(`INSERT INTO dati VALUES(1,10,'${numeroMysql}','2026-10-14 12:13:14.123456','{"n":9007199254740993}','calmo')`);
  const myTipi = (await m('SELECT d,t,j,e FROM dati'))[0];
  assert.equal(myTipi.d, numeroMysql); assert.equal(myTipi.t, '2026-10-14 12:13:14.123456'); assert.equal(myTipi.j, '{"n": 9007199254740993}');
  await m("SELECT CAST('null' AS JSON) j, CAST(NULL AS JSON) n, CAST('{\"t\":\"caffè\"}' AS JSON) u", [{ j: 'null', n: null, u: '{"t": "caffè"}' }]);
  await m('SET @valore = 8'); await m('SELECT @valore n', [{ n: 8 }]);
  await errore('mysql', 'USE codedb_database_inesistente_per_test');
  await m('CREATE TEMPORARY TABLE temporanea(x INT)'); await m('INSERT INTO temporanea VALUES(9)'); await m('SELECT * FROM temporanea', [{ x: 9 }]);
  await m('CREATE TABLE registro(n INT)');
  await m('CREATE TRIGGER prima BEFORE INSERT ON dati FOR EACH ROW SET NEW.n=NEW.n+1');
  await m('CREATE TRIGGER dopo BEFORE INSERT ON dati FOR EACH ROW FOLLOWS prima SET NEW.n=NEW.n*2');
  await m('INSERT INTO dati(id,n) VALUES(2,2)'); await m('SELECT n FROM dati WHERE id=2', [{ n: 6 }]);
  await m(`CREATE PROCEDURE handler_prova(OUT risultato INT) BEGIN DECLARE valore INT; DECLARE codice INT; DECLARE c CURSOR FOR SELECT id FROM dati ORDER BY id; DECLARE CONTINUE HANDLER FOR 1062 BEGIN GET DIAGNOSTICS CONDITION 1 codice=MYSQL_ERRNO; SET risultato=codice; END; OPEN c; FETCH c INTO valore; CLOSE c; INSERT INTO dati(id,n) VALUES(valore,20); END`);
  await m('CALL handler_prova(@risultato)'); await m('SELECT @risultato n', [{ n: 1062 }]);
  await m("SET @sql='SELECT COUNT(*) n FROM dati'"); await m('PREPARE stmt FROM @sql'); await m('EXECUTE stmt', [{ n: 2 }]); await m('DEALLOCATE PREPARE stmt');
  await m('START TRANSACTION'); await m('SAVEPOINT prima'); await m('UPDATE dati SET n=100 WHERE id=1');
  await errore('mysql', 'INSERT INTO dati(id,n) VALUES(1,22)'); await m('ROLLBACK TO SAVEPOINT prima'); await m('SELECT n FROM dati WHERE id=1', [{ n: 10 }]); await m('COMMIT');
  await m('ALTER TABLE dati ADD COLUMN generato INT GENERATED ALWAYS AS (n*2) STORED');
  await m('UPDATE dati d JOIN (SELECT 1 id,12 n) s ON s.id=d.id SET d.n=s.n'); await m('SELECT generato FROM dati WHERE id=1', [{ generato: 24 }]);
  console.log('OK tipi MySQL, trigger ordinati, handler numerico, OUT, cursore, SQL dinamico, scritture JOIN e savepoint');
  for (const type of ['postgresql', 'mysql']) {
    await q(type, 'SELECT id FROM dati WHERE id<3 INTERSECT SELECT id FROM dati WHERE id>1', [{ id: 2 }]);
    await q(type, 'SELECT id FROM dati WHERE id<3 EXCEPT SELECT id FROM dati WHERE id>1', [{ id: 1 }]);
    await q(type, 'CREATE TABLE copia(id INT)');
    await q(type, 'INSERT INTO copia SELECT id FROM dati WHERE id<3');
    await q(type, 'SELECT id FROM copia ORDER BY id', [{ id: 1 }, { id: 2 }]);
  }
  await script('postgresql', `BEGIN; SAVEPOINT s; INSERT INTO copia VALUES(8); SELECT 1/0; ROLLBACK TO s; INSERT INTO copia VALUES(9); COMMIT;`);
  await p('SELECT id FROM copia ORDER BY id', [{ id: 1 }, { id: 2 }, { id: 9 }]);
  await script('mysql', `DELIMITER $$\nCREATE PROCEDURE script_prova() BEGIN INSERT INTO copia VALUES(9); INSERT INTO copia VALUES(CHAR_LENGTH("a\\\";x")); END$$\nDELIMITER ;\nCALL script_prova();`);
  await m('SELECT id FROM copia ORDER BY id', [{ id: 1 }, { id: 2 }, { id: 4 }, { id: 9 }]);
  console.log('OK script reali PostgreSQL e DELIMITER MySQL');
  if (!process.env.CODEDB_SQL_MUTANT) {
    fs.mkdirSync('test-reports/query-languages', { recursive: true });
    fs.writeFileSync('test-reports/query-languages/native-risultati.json', JSON.stringify({ data: new Date().toISOString(), versions, queries, esito: 'ok' }, null, 2));
  }
  console.log(`OK ${queries} istruzioni native verificate attraverso Socket.IO`);
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  if (socket) { await Promise.allSettled(['postgresql', 'mysql'].map(tabId => emit('mongo:disconnect', { tabId }))); socket.disconnect(); }
  await server?.stop();
  if (pgConnected) { await registry.drop(schema, name => pg.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)); await registry.drop(extraDb, name => pg.query(`DROP DATABASE IF EXISTS "${name}"`)); }
  if (my) await registry.drop(database, name => my.query(`DROP DATABASE IF EXISTS \`${name}\``));
  await Promise.allSettled([pg.end(), my?.end()]);
});
