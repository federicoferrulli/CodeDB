'use strict';

// Solo database usa-e-getta, con nomi casuali; porte richieste esplicitamente.
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { creaPianoExport } = require('../db/exportPlan');
const { leggiCatalogoExport } = require('../db/exportCatalogo');
const { esportaDatabase } = require('../db/databaseExport');
const { splitStatementsDetailed } = require('../db/sqlText');
const { normalizzaExportDatabase } = require('../db/artefatti');
const MySql = require('../db/MySqlStrategy');
const Pg = require('../db/PostgreSqlStrategy');
const Mongo = require('../db/MongoDbStrategy');
const { Long } = require('bson');

async function exportFile(strategy, db, modalita, formato, selezione, onFirstWrite) {
  const catalogo = await leggiCatalogoExport(strategy, strategy.type, db);
  const plan = creaPianoExport({ catalogo: { ...catalogo, db, dbType: strategy.type }, connection: 'test', modalita, formato, selezione });
  let text = '';
  const result = await esportaDatabase({ strategy, plan, write: async part => {
    text += part;
    if (onFirstWrite) { const action = onFirstWrite; onFirstWrite = null; await action(); }
  } });
  return { text, result, plan };
}

// Il client mysql riconosce DELIMITER prima di spedire gli statement.
function mysqlStatements(text) {
  const out = []; let delimiter = ';', buffer = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('DELIMITER ')) { delimiter = line.slice(10); continue; }
    if (!buffer && (!line.trim() || line.startsWith('--'))) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      out.push(buffer.trimEnd().slice(0, -delimiter.length)); buffer = '';
    }
  }
  assert(!buffer.trim(), 'script SQL incompleto');
  return out;
}

async function sql(type, port) {
  const strategy = type === 'mysql' ? new MySql() : new Pg();
  const db = 'codedb_export_' + crypto.randomBytes(6).toString('hex');
  const mysql = type === 'mysql';
  await strategy.connect({ host: '127.0.0.1', port, username: mysql ? 'root' : 'postgres', password: '', database: mysql ? '' : 'postgres' });
  const conn = mysql ? await strategy.pool.getConnection() : await strategy.pool.connect();
  const q = async s => { const r = await conn.query(s); return mysql ? r[0] : r.rows; };
  try {
    await q(mysql ? `CREATE DATABASE ${db}` : `CREATE SCHEMA ${db}`);
    await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
    await q(`CREATE TABLE padre (id INT PRIMARY KEY)`);
    await q(`CREATE TABLE t (id ${mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'}, parent_id INT, n DECIMAL(30,10), testo TEXT, bin ${mysql ? 'BLOB' : 'BYTEA'}, dt ${mysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'}, calcolata INT GENERATED ALWAYS AS (parent_id+1) ${mysql ? 'STORED' : 'STORED'}, CONSTRAINT fk_padre FOREIGN KEY (parent_id) REFERENCES padre(id))`);
    await q('INSERT INTO padre VALUES (1)');
    await q(`INSERT INTO t (parent_id,n,testo,bin,dt) VALUES (1,12345678901234567890.1234567890,'test',${mysql ? "X'00FF7F'" : "decode('00ff7f','hex')"},'2026-09-25 12:34:56.123456')`);
    await conn.query(mysql ? 'UPDATE t SET testo=?' : 'UPDATE t SET testo=$1', ["apice ' backslash \\ newline\n emoji 🦊 $&"]);
    await q(`ALTER TABLE t ADD COLUMN g ${mysql ? 'GEOMETRY' : 'POINT'}`);
    await q(`ALTER TABLE t ADD COLUMN j ${mysql ? 'JSON' : 'JSONB'}`);
    await q(`UPDATE t SET g=${mysql ? "ST_GeomFromText('POINT(12 41)',0)" : "'(12,41)'::point"}, j='{"n":9007199254740993}'`);
    await q('CREATE VIEW v AS SELECT parent_id FROM t');
    if (!mysql) {
      await q('CREATE MATERIALIZED VIEW mv AS SELECT parent_id FROM t');
      await q('CREATE VIEW v_mv AS SELECT * FROM mv');
      await q('CREATE MATERIALIZED VIEW mv_seconda AS SELECT * FROM v_mv');
    }
    if (mysql) {
      await q('CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END');
      const { guardStrategy } = require('../auth/guardStrategy');
      const { ROOT_PRINCIPAL, makePrincipal } = require('../auth/principal');
      const guarded = guardStrategy(strategy, { principal: ROOT_PRINCIPAL, connName: 'test' });
      await assert.rejects(guarded.collectionAggregate(db, null, {
        pipeline: 'CREATE PROCEDURE p_extra() BEGIN SELECT 1; END; DROP TABLE padre',
      }), /syntax/i, 'il driver rifiuta comandi accodati al corpo');
      assert.strictEqual((await q('SELECT * FROM padre')).length, 1);
      const scoped = makePrincipal({ _id: 'test', ownerId: 'owner', type: 'subuser' },
        [{ connName: 'test', capabilities: ['read', 'ddl', 'manage'], scope: { databases: [db], collections: ['*'] } }]);
      await assert.rejects(guardStrategy(strategy, { principal: scoped, connName: 'test' }).collectionAggregate(db, null, {
        pipeline: 'CREATE PROCEDURE p_scoped() BEGIN SELECT 1; SELECT 2; END',
      }), /istruzioni SQL|ambito|Permesso negato/i);
    } else {
      await q('ALTER TABLE t ADD COLUMN numeri NUMERIC[]');
      await q("UPDATE t SET numeri=ARRAY[12345678901234567890.1234567890::numeric]");
      const { pgColonneDaSalvare } = require('../db/pg-ddl');
      const { select } = await pgColonneDaSalvare((s, p) => conn.query(s, p), db, 't');
      const [saved] = await q(`SELECT ${select} FROM t`);
      assert.strictEqual(saved.j, '{"n": 9007199254740993}', 'backup PG: JSON senza conversioni');
      assert.strictEqual(saved.numeri, '{12345678901234567890.1234567890}', 'backup PG: array senza arrotondamenti');
    }
    const compare = mysql
      ? 'SELECT id,parent_id,CAST(n AS CHAR) AS n,testo,HEX(bin) AS bin,CAST(dt AS CHAR) AS dt,calcolata,ST_AsText(g) AS g,CAST(j AS CHAR) AS j FROM t'
      : "SELECT id,parent_id,n::text AS n,testo,encode(bin,'hex') AS bin,dt::text AS dt,calcolata,g::text AS g,j::text AS j,numeri::text AS numeri FROM t";
    const expected = await q(compare);
    const copy = db + '_copy';
    try {
      await roundtripJson(type, port, db, copy);
      await q(mysql ? `USE ${copy}` : `SET search_path TO ${copy}, public`);
      assert.deepStrictEqual(await q(compare), expected, 'roundtrip CodeDB: valori esatti e tipi');
      assert.strictEqual((await q('SELECT * FROM v')).length, 1);
      if (mysql) await q('CALL p()');
      await q('INSERT INTO t(parent_id) VALUES(1)');
    } finally {
      await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
      await q(mysql ? `DROP DATABASE IF EXISTS ${copy}` : `DROP SCHEMA IF EXISTS ${copy} CASCADE`);
    }
    const structure = JSON.parse((await exportFile(strategy, db, 'solo-struttura', 'codedb-json')).text);
    assert.strictEqual(structure.collections.length, 2);
    assert(structure.collections.every(c => c.ddl && c.docs.length === 0));
    normalizzaExportDatabase(structure);
    const data = JSON.parse((await exportFile(strategy, db, 'solo-dati', 'codedb-json')).text);
    assert(data.collections.every(c => !c.ddl && !c.postDdl.length));
    assert(!data.objects.views.length && !data.objects.routines.length);
    const selected = JSON.parse((await exportFile(strategy, db, 'personalizzata', 'codedb-json', { 'tabella:t': { struttura: true, dati: true } })).text);
    assert(!selected.objects.views.length);
    assert(!selected.collections[0].postDdl.some(s => /REFERENCES/i.test(s)), 'FK fuori perimetro omessa');
    normalizzaExportDatabase(selected);
    if (!mysql) await q("CREATE FUNCTION f_mv() RETURNS TABLE(parent_id integer) LANGUAGE SQL AS 'SELECT parent_id FROM v_mv'");
    const full = await exportFile(strategy, db, 'struttura-e-dati', 'sql', null, async () => {
      // Scrittura concorrente DOPO l'apertura della snapshot: non deve entrare
      // a metà export, neppure nel conteggio verificato alla fine.
      await q('INSERT INTO padre VALUES (2)');
      await q('INSERT INTO t(parent_id) VALUES (2)');
    });
    await q(mysql ? `DROP DATABASE ${db}` : `DROP SCHEMA ${db} CASCADE`);
    const container = process.env[mysql ? 'EXPORT_MYSQL_CONTAINER' : 'EXPORT_PG_CONTAINER'];
    if (container) {
      const args = mysql ? ['mysql', '-uroot', '--default-character-set=utf8mb4'] : ['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'];
      const native = spawnSync('docker', ['exec', '-i', container, ...args], { input: full.text, encoding: 'utf8', windowsHide: true });
      assert.strictEqual(native.status, 0, native.stderr || native.error?.message);
      await q(mysql ? `USE ${db}` : `SET search_path TO ${db}, public`);
    } else {
      for (const statement of mysql ? mysqlStatements(full.text) : splitStatementsDetailed(full.text).map(s => s.sql)) {
        try { await q(statement); } catch (err) { err.message += '\nSQL della fixture: ' + statement; throw err; }
      }
    }
    assert.deepStrictEqual(await q(compare), expected, 'roundtrip SQL: valori esatti, tipi e colonne generate');
    assert.strictEqual((await q('SELECT * FROM v')).length, 1);
    if (!mysql) {
      for (const view of ['mv', 'v_mv', 'mv_seconda']) {
        assert.deepStrictEqual(await q(`SELECT * FROM ${view}`), [{ parent_id: 1 }], `vista ${view} popolata dopo il ripristino dei dati`);
      }
      assert.deepStrictEqual(await q('SELECT * FROM f_mv()'), [{ parent_id: 1 }], 'la routine trova la vista già definita e poi popolata');
    }
    if (mysql) await q('CALL p()');
    await q(`INSERT INTO t(parent_id) VALUES(1)`);
    console.log(`  OK ${type}: quattro modalità, SQL reimportabile, precisione, binari, date, FK, view e identità`);
  } finally {
    try { await q(mysql ? `DROP DATABASE IF EXISTS ${db}` : `DROP SCHEMA IF EXISTS ${db} CASCADE`); }
    finally { conn.release(); await strategy.disconnect(); }
  }
}

async function mongo(port) {
  const strategy = new Mongo();
  const db = 'codedb_export_' + crypto.randomBytes(6).toString('hex');
  await strategy.connect({ host: '127.0.0.1', port });
  try {
    const collection = strategy.client.db(db).collection('t');
    await collection.insertOne({ n: Long.fromString('9007199254740993') });
    await collection.createIndex({ n: 1 }, { unique: true, name: 'n_unico' });
    const artifact = JSON.parse((await exportFile(strategy, db, 'struttura-e-dati', 'codedb-json')).text);
    normalizzaExportDatabase(artifact);
    assert.strictEqual(artifact.collections[0].docs[0].n.$numberLong, '9007199254740993');
    assert(artifact.collections[0].indexes.some(i => i.name === 'n_unico' && i.unique));
    const copy = db + '_copy';
    try {
      await roundtripJson('mongodb', port, db, copy);
      const restored = strategy.client.db(copy).collection('t');
      assert.strictEqual((await restored.findOne({}, { promoteLongs: false })).n.toString(), '9007199254740993');
      assert((await restored.indexes()).some(i => i.name === 'n_unico' && i.unique));
    } finally { await strategy.client.db(copy).dropDatabase(); }
    console.log('  OK mongodb: EJSON canonico e indici completi');
  } finally { await strategy.client.db(db).dropDatabase(); await strategy.disconnect(); }
}

async function roundtripJson(type, port, db, targetDb) {
    const { startTestServer } = require('./e2e-harness');
    const { io } = require('socket.io-client');
    const server = await startTestServer({ port: 3159 });
    const socket = io(server.url);
    const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(15000).emit(event, payload, (err, result) => {
      if (err) reject(err); else if (!result.ok) reject(new Error(result.error)); else resolve(result);
    }));
    try {
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      await emit('mongo:connect', { tabId: 'export', host: '127.0.0.1', port, dbType: type,
        username: type === 'mysql' ? 'root' : type === 'postgresql' ? 'postgres' : '', password: '', database: type === 'postgresql' ? 'postgres' : undefined });
      const { plan } = await emit('database:export:plan', { tabId: 'export', db, formato: 'codedb-json' });
      await assert.rejects(emit('database:export:start', { tabId: 'export', fingerprint: 'diversa' }), /piano.*cambiato/i);
      const { operation: start } = await emit('database:export:start', { tabId: 'export', fingerprint: plan.fingerprint });
      let operation;
      do {
        await new Promise(resolve => setTimeout(resolve, 30));
        ({ operation } = await emit('database:export:status', { tabId: 'export', db, operationId: start.id }));
      } while (operation.status === 'in_corso');
      assert.strictEqual(operation.status, 'completato', operation.error);
      const download = await fetch(server.url + operation.url);
      assert.strictEqual(download.status, 200);
      assert(download.headers.get('etag'));
      const content = await download.text();
      normalizzaExportDatabase(JSON.parse(content));
      const denied = await fetch(server.url + operation.url.split('?')[0]);
      assert.strictEqual(denied.status, 403, 'il download richiede il ticket');
      const { uploadId } = await emit('database:import:upload:start', { tabId: 'export' });
      await emit('database:import:upload:chunk', { tabId: 'export', uploadId, index: 0, chunk: content });
      await emit('database:import:upload:finish', { tabId: 'export', uploadId });
      const request = { tabId: 'export', uploadId, targetDb, drop: true };
      const preview = await emit('database:import:start', { ...request, previewOnly: true });
      const { accepted } = await emit('database:import:start', { ...request, expectedFingerprint: preview.plan.fingerprint });
      const deadline = Date.now() + 120000;
      do {
        assert(Date.now() < deadline, 'import non terminato entro due minuti');
        await new Promise(resolve => setTimeout(resolve, 50));
        ({ operation } = await emit('database:import:state', { tabId: 'export', operationId: accepted.operationId }));
      } while (operation.status === 'in_corso');
      assert.strictEqual(operation.status, 'completato', JSON.stringify(operation));
      await emit('database:import:cleanup', { tabId: 'export', operationId: accepted.operationId });
      console.log(`  OK ${type}: export HTTP, ticket, upload e import CodeDB con staging`);
    } finally { socket.close(); await server.stop(); }
}

(async () => {
  assert(process.env.EXPORT_MYSQL_PORT && process.env.EXPORT_PG_PORT && process.env.EXPORT_MONGO_PORT, 'Indicare le tre porte dei database usa-e-getta.');
  await sql('mysql', Number(process.env.EXPORT_MYSQL_PORT));
  await sql('postgresql', Number(process.env.EXPORT_PG_PORT));
  await mongo(Number(process.env.EXPORT_MONGO_PORT));
})().catch(err => { console.error(err); process.exitCode = 1; });
