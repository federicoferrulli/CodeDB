'use strict';

// Database casuale posseduto dalla fixture; il server non legge il vault utente.
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const { io } = require('socket.io-client');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_query_copertura' });
const db = targets.target('mongo');
const port = Number(process.env.MONGO_PORT || 27017);
const client = new MongoClient(`mongodb://127.0.0.1:${port}`, { serverSelectionTimeoutMS: 5000 });
let server, socket, collegato = false;
const emit = (event, payload) => new Promise((resolve, reject) => {
  socket.timeout(15000).emit(event, payload, (err, result) => err ? reject(err) : resolve(result));
});
async function query(code) {
  const res = await emit('query:execute', { db, coll: 'utenti', engine: 'mongodb', code });
  assert.equal(res.ok, true, `${code}: ${res.error}`);
  return EJSON.deserialize(res.data, { relaxed: true });
}

(async () => {
  targets.assertOwned(db);
  await client.connect();
  collegato = true;
  await client.db(db).collection('utenti').insertMany([
    { _id: 1, nome: ' Ada ', eta: 30, attivo: true, prezzo: 3, quantita: 2 },
    { _id: 2, nome: 'bob', eta: 20, attivo: false, prezzo: 5, quantita: 3 },
    { _id: 3, nome: null, eta: 10, attivo: true, prezzo: 8, quantita: 1 },
  ]);
  await client.db(db).collection('ruoli').insertMany([{ codice: 'A' }, { codice: 'B' }]);
  await client.db(db).collection('legami').insertMany([{ _id: 1, eta: 20, attivo: true }, { _id: 2, eta: 30, attivo: false }, { _id: 3, eta: null }]);
  server = await startTestServer({ port: Number(process.env.E2E_PORT || 3159) });
  socket = io(server.url);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const conn = await emit('mongo:connect', { host: '127.0.0.1', port });
  assert.equal(conn.ok, true, conn.error);
  const cases = [
    ['Scalari, NULL e ordine su alias', 'SELECT UPPER(TRIM(nome)) AS nome, prezzo * quantita AS totale FROM utenti ORDER BY totale DESC',
      [{ nome: 'BOB', totale: 15 }, { nome: null, totale: 8 }, { nome: 'ADA', totale: 6 }]],
    ['Alias che coincide con un campo sorgente', 'SELECT nome AS originale, UPPER(nome) AS nome FROM utenti WHERE _id = 2',
      [{ originale: 'bob', nome: 'BOB' }]],
    ['Proiezione star insieme a una colonna calcolata', 'SELECT *, UPPER(nome) AS maiuscolo FROM utenti WHERE _id = 2',
      [{ _id: 2, nome: 'bob', eta: 20, attivo: false, prezzo: 5, quantita: 3, maiuscolo: 'BOB' }]],
    ['CTE letta dal percorso socket', 'WITH attivi AS (SELECT nome FROM utenti WHERE attivo = TRUE) SELECT nome FROM attivi',
      [{ nome: ' Ada ' }, { nome: null }]],
    ['CROSS JOIN', 'SELECT u.eta, r.codice FROM utenti u CROSS JOIN ruoli r ORDER BY u.eta, r.codice',
      [{ eta: 10, codice: 'A' }, { eta: 10, codice: 'B' }, { eta: 20, codice: 'A' }, { eta: 20, codice: 'B' }, { eta: 30, codice: 'A' }, { eta: 30, codice: 'B' }]],
    ['CASE ed espressioni', "SELECT CASE WHEN eta >= 20 THEN 'adulto' ELSE 'giovane' END AS fascia FROM utenti ORDER BY eta",
      [{ fascia: 'giovane' }, { fascia: 'adulto' }, { fascia: 'adulto' }]],
    ['DISTINCT * dopo UNION ALL', 'SELECT DISTINCT * FROM (SELECT eta FROM utenti UNION ALL SELECT eta FROM utenti) AS x ORDER BY eta LIMIT 2',
      [{ eta: 10 }, { eta: 20 }]],
    ['Predicati ed espressioni con parentesi', "SELECT eta FROM utenti WHERE (prezzo * quantita) >= 10 AND UPPER(nome) = 'BOB'", [{ eta: 20 }]],
    ['CASE con NULL e IN', "SELECT CASE WHEN nome IS NULL THEN 'assente' WHEN eta IN (20, 40) THEN 'presente' ELSE 'altro' END AS esito FROM utenti ORDER BY eta",
      [{ esito: 'assente' }, { esito: 'presente' }, { esito: 'altro' }]],
    ['NOT non trasforma un NULL in vero', "SELECT eta FROM utenti WHERE NOT nome = 'bob'", [{ eta: 30 }]],
    ['NOT IN con NULL non restituisce righe', "SELECT eta FROM utenti WHERE eta NOT IN (20, NULL)", []],
    ['Funzione scalare su colonna raggruppata', 'SELECT UPPER(nome) AS nome, COUNT(*) AS n FROM utenti GROUP BY nome ORDER BY nome',
      [{ nome: null, n: 1 }, { nome: ' ADA ', n: 1 }, { nome: 'BOB', n: 1 }]],
    ['JOIN su CTE filtrata', 'WITH l AS (SELECT eta FROM legami WHERE attivo = TRUE) SELECT u.eta FROM utenti u JOIN l ON u.eta = l.eta', [{ eta: 20 }]],
    ['JOIN con condizioni multiple', 'SELECT u.eta FROM utenti u JOIN legami l ON u.eta = l.eta AND l.attivo = TRUE', [{ eta: 20 }]],
    ['JOIN USING', 'SELECT u.eta FROM utenti u JOIN legami l USING (eta) ORDER BY u.eta', [{ eta: 20 }, { eta: 30 }]],
    ['JOIN con disuguaglianza', 'SELECT u.eta FROM utenti u JOIN legami l ON u.eta > l.eta ORDER BY u.eta', [{ eta: 30 }]],
    ['Opzione collation della shell singola', 'db.utenti.find({nome:"BOB"}, {_id:0, eta:1}).collation({locale:"en",strength:2}).maxTimeMS(1000)', [{ eta: 20 }]],
    ['Opzione collation dello script', 'const c = db.utenti.find({nome:"BOB"}, {_id:0, eta:1}); c.collation({locale:"en",strength:2}).toArray()', [{ eta: 20 }]],
  ];
  // Un esempio con risultato esplicito per OGNI funzione del registro.
  const scalari = {
    ABS: ['-2', 2], CEIL: ['1.2', 2], CEILING: ['1.2', 2], FLOOR: ['1.8', 1],
    SQRT: ['9', 3], EXP: ['0', 1], LN: ['1', 0], LOG10: ['100', 2],
    POWER: ['2,3', 8], POW: ['2,3', 8], MOD: ['8,3', 2], ROUND: ['1.234,2', 1.23],
    TRUNC: ['1.234,2', 1.23], TRUNCATE: ['1.234,2', 1.23],
    SIN: ['0', 0], COS: ['0', 1], TAN: ['0', 0], ASIN: ['0', 0], ACOS: ['1', 0], ATAN: ['0', 0], ATAN2: ['0,1', 0],
    DEGREES: ['0', 0], RADIANS: ['0', 0], UPPER: ["'ab'", 'AB'], LOWER: ["'AB'", 'ab'],
    CHAR_LENGTH: ["'è'", 1], CHARACTER_LENGTH: ["'è'", 1], OCTET_LENGTH: ["'è'", 2], LENGTH: ["'è'", 1],
    HEX: ["X'00ff'", '00FF'],
    CARDINALITY: ['ARRAY[[1,2],[3,4]]', 4], ARRAY_LENGTH: ['ARRAY[1,2],1', 2], ARRAY_LOWER: ['ARRAY[1,2],1', 1], ARRAY_UPPER: ['ARRAY[1,2],1', 2], ARRAY_NDIMS: ['ARRAY[[1,2],[3,4]]', 2],
    ARRAY_FILL: ['7,ARRAY[2]', [7,7]], ARRAY_DIMS: ['ARRAY[[1,2],[3,4]]', '[1:2][1:2]'],
    ARRAY_POSITION: ['ARRAY[1,NULL,3],NULL', 2], ARRAY_REMOVE: ['ARRAY[1,NULL,3],NULL', [1,3]], ARRAY_REPLACE: ['ARRAY[1,NULL],NULL,2', [1,2]],
    ARRAY_APPEND: ['ARRAY[1],2', [1,2]], ARRAY_PREPEND: ['1,ARRAY[2]', [1,2]], ARRAY_CAT: ['ARRAY[1],ARRAY[2]', [1,2]],
    INT4RANGE: ['1,3', {_sqlRange:'INT4RANGE',empty:false,lower:1,upper:3,lowerInc:true,upperInc:false}],
    INT8RANGE: ['1,3', {_sqlRange:'INT8RANGE',empty:false,lower:1,upper:3,lowerInc:true,upperInc:false}],
    NUMRANGE: ['1,3', {_sqlRange:'NUMRANGE',empty:false,lower:require('bson').Decimal128.fromString('1'),upper:require('bson').Decimal128.fromString('3'),lowerInc:true,upperInc:false}],
    DATERANGE: ["'2026-01-01','2026-01-03'", {_sqlRange:'DATERANGE',empty:false,lower:new Date('2026-01-01'),upper:new Date('2026-01-03'),lowerInc:true,upperInc:false}],
    TSRANGE: ["'2026-01-01','2026-01-03'", {_sqlRange:'TSRANGE',empty:false,lower:new Date('2026-01-01'),upper:new Date('2026-01-03'),lowerInc:true,upperInc:false}],
    TSTZRANGE: ["'2026-01-01','2026-01-03'", {_sqlRange:'TSTZRANGE',empty:false,lower:new Date('2026-01-01'),upper:new Date('2026-01-03'),lowerInc:true,upperInc:false}],
    LOWER_INC: ['INT4RANGE(1,3)',true], UPPER_INC: ['INT4RANGE(1,3)',false], LOWER_INF: ['INT4RANGE(NULL,3)',true], UPPER_INF: ['INT4RANGE(1,NULL)',true], ISEMPTY: ["CAST('empty' AS INT4RANGE)",true],
    INT4MULTIRANGE: ['', {_sqlMultirange:'INT4MULTIRANGE',ranges:[]}], INT8MULTIRANGE: ['', {_sqlMultirange:'INT8MULTIRANGE',ranges:[]}], NUMMULTIRANGE: ['', {_sqlMultirange:'NUMMULTIRANGE',ranges:[]}],
    DATEMULTIRANGE: ['', {_sqlMultirange:'DATEMULTIRANGE',ranges:[]}], TSMULTIRANGE: ['', {_sqlMultirange:'TSMULTIRANGE',ranges:[]}], TSTZMULTIRANGE: ['', {_sqlMultirange:'TSTZMULTIRANGE',ranges:[]}],
    MULTIRANGE: ["CAST('empty' AS INT4RANGE)", {_sqlMultirange:'INT4MULTIRANGE',ranges:[]}], RANGE_MERGE: ['INT4MULTIRANGE()', {_sqlRange:'INT4RANGE',empty:true,lower:null,upper:null,lowerInc:false,upperInc:false}],
    CONCAT: ["'a','b'", 'ab'], COALESCE: ["NULL,'a'", 'a'], IFNULL: ["NULL,'a'", 'a'], NULLIF: ['1,1', null],
    GREATEST: ['1,3,2', 3], LEAST: ['1,3,2', 1], TRIM: ["' a '", 'a'], LTRIM: ["' a '", 'a '], RTRIM: ["' a '", ' a'],
    SUBSTRING: ["'abcd',2,2", 'bc'], SUBSTR: ["'abcd',2,2", 'bc'], REPLACE: ["'abcd','bc','x'", 'axd'], IF: ["TRUE,'a','b'", 'a'],
    YEAR: ["CAST('2024-03-04T05:06:07Z' AS TIMESTAMP)", 2024], MONTH: ["CAST('2024-03-04T05:06:07Z' AS TIMESTAMP)", 3],
    DAY: ["CAST('2024-03-04T05:06:07Z' AS TIMESTAMP)", 4], HOUR: ["CAST('2024-03-04T05:06:07Z' AS TIMESTAMP)", 5],
    MINUTE: ["CAST('2024-03-04T05:06:07Z' AS TIMESTAMP)", 6], SECOND: ["CAST('2024-03-04T05:06:07Z' AS TIMESTAMP)", 7],
  };
  const { FUNZIONI_SQL_MONGO } = require('../public/js/sql-mongo-funzioni.mjs');
  assert.deepEqual([...Object.keys(scalari), 'NOW', 'CURRENT_TIMESTAMP'].sort(), Object.keys(FUNZIONI_SQL_MONGO).sort());
  for (const [fun, [args, expected]] of Object.entries(scalari)) {
    cases.push([`Funzione ${fun}`, `SELECT ${fun}(${args}) AS risultato FROM utenti WHERE _id = 2`, [{ risultato: expected }]]);
  }
  for (const [nome, sql, expected] of cases) {
    try { assert.deepEqual(await query(sql), expected); console.log(`  OK   ${nome}`); }
    catch (err) { process.exitCode = 1; console.error(`  FAIL ${nome}: ${err.message}`); }
  }
  const ora = await query('SELECT NOW() AS a, CURRENT_TIMESTAMP AS b FROM utenti LIMIT 1');
  assert(ora[0].a instanceof Date);
  assert.equal(ora[0].a.getTime(), ora[0].b.getTime());
  assert(Math.abs(Date.now() - ora[0].a.getTime()) < 10000);
  console.log('  OK   NOW e CURRENT_TIMESTAMP');
  await query('CREATE UNIQUE INDEX idx_test ON utenti (eta DESC)');
  assert((await client.db(db).collection('utenti').indexes()).some(i => i.name === 'idx_test' && i.unique));
  await query('DROP INDEX idx_test ON utenti');
  assert(!(await client.db(db).collection('utenti').indexes()).some(i => i.name === 'idx_test'));
  console.log('  OK   CREATE e DROP INDEX attraverso socket');
  await query("UPDATE utenti SET prezzo = prezzo + 2, nome = UPPER(nome) WHERE _id = 2");
  assert.equal((await client.db(db).collection('utenti').findOne({ _id: 2 })).prezzo, 7);
  console.log('  OK   UPDATE calcolato attraverso socket');
  await query('CREATE DOMAIN socket_positive AS INT CHECK(VALUE>0)');
  await query('CREATE TABLE socket_types(id INT PRIMARY KEY,a INT[],r INT4RANGE,n socket_positive)');
  await query("INSERT INTO socket_types VALUES(1,ARRAY[1,NULL,3],INT4RANGE(1,4,'(]'),2)");
  assert.deepEqual(await query('SELECT a[3] AS element,LOWER(r) AS lower_bound,UPPER(r) AS upper_bound,n FROM socket_types'),
    [{element:3,lower_bound:2,upper_bound:5,n:2}]);
  await query('CREATE TABLE socket_trigger_log(n INT)');
  await query('CREATE TRIGGER socket_statement AFTER UPDATE ON socket_types FOR EACH STATEMENT INSERT INTO socket_trigger_log VALUES(1)');
  await query('UPDATE socket_types SET n=3 WHERE id=99');
  assert.deepEqual(await query('SELECT n FROM socket_trigger_log'), [{n:1}]);
  await query(`CREATE PROCEDURE socket_exception() LANGUAGE plpgsql AS $$ BEGIN
    BEGIN UPDATE socket_types SET n=CAST('non numerico' AS INT);
    EXCEPTION WHEN invalid_text_representation THEN INSERT INTO socket_trigger_log VALUES(2); END;
  END $$`);
  await query('CALL socket_exception()');
  assert.deepEqual(await query('SELECT n FROM socket_trigger_log ORDER BY n'), [{n:1},{n:2}]);
  await query('ALTER DOMAIN socket_positive ADD CONSTRAINT max_value CHECK(VALUE<10)');
  const invalidDomain = await emit('query:execute', {db,coll:'socket_types',engine:'mongodb',code:'UPDATE socket_types SET n=11'});
  assert.equal(invalidDomain.ok, false);
  assert.deepEqual(await query('SELECT n FROM socket_types'), [{n:2}]);
  assert.deepEqual(await query('SELECT CAST(n AS socket_positive)::INT AS n FROM socket_types'),[{n:2}]);
  await query('CREATE TABLE socket_multirange(id INT PRIMARY KEY,r INT4RANGE)');
  await query("INSERT INTO socket_multirange VALUES(1,'[1,3)'),(2,'[3,5)')");
  assert.deepEqual(await query('SELECT RANGE_AGG(r)::TEXT AS r FROM socket_multirange'),[{r:'{[1,5)}'}]);
  await query('ALTER TRIGGER socket_statement ON socket_types RENAME TO socket_renamed');
  await query('DROP DOMAIN socket_positive CASCADE');
  assert.equal((await require('../db/sqlSchemaMongo').leggi(client.db(db),'socket_types')).columns.some(c=>c.name==='n'),false);
  console.log('  OK   Array, range, domini, trigger statement ed errori nativi con savepoint attraverso socket');
  await query('db.lavoro.bulkWrite([{insertOne:{document:{_id:1,n:1}}},{updateOne:{filter:{_id:1},update:[{$set:{n:{$add:["$n",2]}}}]}},{insertOne:{document:{_id:2}}},{deleteOne:{filter:{_id:2}}}])');
  assert.deepEqual(await client.db(db).collection('lavoro').find().toArray(), [{ _id: 1, n: 3 }]);
  console.log('  OK   bulkWrite e update pipeline attraverso socket');
  await query('db.lavoro.findOneAndReplace({_id:1},{n:4},{returnDocument:"after"})');
  assert.deepEqual(await client.db(db).collection('lavoro').find().toArray(), [{ _id: 1, n: 4 }]);
  console.log('  OK   findOneAndReplace attraverso interprete e socket');
  const spiegazione = await query('db.utenti.find({eta:20}).explain("queryPlanner")');
  assert(spiegazione[0].queryPlanner);
  console.log('  OK   explain restituisce il piano');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  if (server) await server.stop();
  try { if (collegato) await targets.cleanup(name => client.db(name).dropDatabase()); }
  finally { await client.close(); }
});
