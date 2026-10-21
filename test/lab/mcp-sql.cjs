'use strict';

// E2E reali MCP/RBAC su MySQL e PostgreSQL: confronti tramite driver indipendenti,
// isolamento schemi, precisione dei valori e atomicità dei batch confermati.
// I nomi casuali appartengono soltanto a questa esecuzione. Non tocca i DB utente.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/mcp-sql.cjs [--mutant-sql-partial-commit]

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const { MongoClient } = require('mongodb');
const { io } = require('socket.io-client');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startTestServer, createE2eTargetRegistry } = require('../e2e-harness');

const MONGO_URI = process.env.LAB_MONGO_URI || 'mongodb://127.0.0.1:37017/?directConnection=true';
const SERVER_PORT = Number(process.env.LAB_MCP_SQL_PORT || 39032);
const mutant = process.argv.includes('--mutant-sql-partial-commit');
const isolatedContainer = process.env.CODEDB_LAB_CONTAINER === '1' && fs.existsSync('/.dockerenv');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_lab_mcp_sql' });
const APP_DB = targets.target('auth');
const report = { suite: 'mcp-sql-reale', startedAt: new Date().toISOString(), mutant, results: [] };
const clients = [];
const engines = [];
let mongo;
let server;
let socket;
let owner;
let viewer;
let ownerKey;

function must(result, label) {
  assert.ok(result && result.ok, `${label}: ${result?.text || result?.error || JSON.stringify(result)}`);
  return result.data || result;
}
async function check(engine, id, label, action) {
  const started = performance.now();
  try {
    await action();
    report.results.push({ id: `${engine.kind}-${id}`, label, status: 'passed', durationMs: Math.round(performance.now() - started) });
    console.log(`PASS ${engine.kind}-${id}: ${label}`);
  } catch (error) {
    report.results.push({ id: `${engine.kind}-${id}`, label, status: 'failed', durationMs: Math.round(performance.now() - started), error: error.stack || String(error) });
    console.error(`FAIL ${engine.kind}-${id}: ${label}\n${error.stack || error}`);
    process.exitCode = 1;
  }
}
const emit = (event, payload = {}) => new Promise((resolve, reject) => {
  socket.timeout(15000).emit(event, payload, (error, data) => error ? reject(error) : resolve(data));
});
async function newClient(key) {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'codedb-lab-mcp-sql', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return { ok: !result.isError, text, data: result.isError ? null : JSON.parse(text) };
}
const read = (engine, sql, client = owner, cid = engine.ownerCid, db = engine.db) =>
  call(client, 'execute_query', { connection_id: cid, db, sql });
const write = (engine, args) => call(owner, 'execute_write', { connection_id: engine.ownerCid, db: engine.db, ...args });
async function prepareBatch(engine, sql) {
  const data = must(await write(engine, { operations: sql.map(statement => ({ sql: statement })) }), 'anteprima batch');
  assert.equal(data.requires_confirmation, true);
  return data.confirm_token;
}

async function setup() {
  targets.assertOwned(APP_DB);
  const mongoUri = new URL(MONGO_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(mongoUri.hostname) && (Number(mongoUri.port) !== 27017 || isolatedContainer));
  assert.equal(mongoUri.searchParams.get('directConnection'), 'true');
  mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  await mongo.connect();
  const mysqlPort = Number(process.env.LAB_MYSQL_PORT || 33306);
  const pgPort = Number(process.env.LAB_PG_PORT || 35432);
  assert.ok(isolatedContainer || (mysqlPort !== 3306 && pgPort !== 5432), 'Le porte ordinarie dei database utente non sono ammesse.');
  const my = await mysql.createConnection({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: process.env.LAB_MYSQL_PASSWORD || 'lab_mysql', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  engines.push({ kind: 'mysql', driver: my, query: async sql => (await my.query(sql))[0], q: value => `\`${value.replaceAll('`', '``')}\``,
    config: { dbType: 'mysql', host: '127.0.0.1', port: mysqlPort, username: 'root', password: process.env.LAB_MYSQL_PASSWORD || 'lab_mysql', readOnly: false } });
  const pg = new PgClient({ host: '127.0.0.1', port: pgPort, user: 'postgres', password: process.env.LAB_PG_PASSWORD || 'lab_postgres', database: 'postgres', connectionTimeoutMillis: 10000 });
  await pg.connect();
  engines.push({ kind: 'postgresql', driver: pg, query: async sql => (await pg.query(sql)).rows, q: value => `"${value.replaceAll('"', '""')}"`,
    config: { dbType: 'postgresql', host: '127.0.0.1', port: pgPort, username: 'postgres', password: process.env.LAB_PG_PASSWORD || 'lab_postgres', database: 'postgres', readOnly: false } });
  for (const engine of engines) {
    engine.db = targets.target(`${engine.kind}_a`);
    engine.otherDb = targets.target(`${engine.kind}_b`);
    engine.connName = `lab-${engine.kind}`;
    engine.table = (table, db = engine.db) => `${engine.q(db)}.${engine.q(table)}`;
    engine.drop = name => engine.query(engine.kind === 'mysql' ? `DROP DATABASE IF EXISTS ${engine.q(name)}` : `DROP SCHEMA IF EXISTS ${engine.q(name)} CASCADE`);
    for (const db of [engine.db, engine.otherDb]) {
      await engine.query(engine.kind === 'mysql' ? `CREATE DATABASE ${engine.q(db)} CHARACTER SET utf8mb4` : `CREATE SCHEMA ${engine.q(db)}`);
      await engine.query(`CREATE TABLE ${engine.table('ledger', db)} (id INT PRIMARY KEY, amount INT NOT NULL, label VARCHAR(120) NOT NULL)`);
    }
    await engine.query(`INSERT INTO ${engine.table('ledger')} VALUES (1, 100, 'conto A'), (2, 200, 'conto B')`);
    await engine.query(`INSERT INTO ${engine.table('ledger', engine.otherDb)} VALUES (1, 999, 'schema privato')`);
    await engine.query(`CREATE TABLE ${engine.table('private_data')} (id INT PRIMARY KEY, secret VARCHAR(100))`);
    await engine.query(`INSERT INTO ${engine.table('private_data')} VALUES (1, 'SEGRETO-${targets.marker}')`);
    await engine.query(`CREATE TABLE ${engine.table('typed')} (id INT PRIMARY KEY, bigint_value BIGINT, decimal_value DECIMAL(38,9), local_time ${engine.kind === 'mysql' ? 'DATETIME(6)' : 'TIMESTAMP(6)'}, date_value DATE, text_value VARCHAR(160), json_value ${engine.kind === 'mysql' ? 'JSON' : 'JSONB'}, binary_value ${engine.kind === 'mysql' ? 'VARBINARY(10)' : 'BYTEA'})`);
    const binary = engine.kind === 'mysql' ? "UNHEX('0001feff')" : "decode('0001feff', 'hex')";
    await engine.query(`INSERT INTO ${engine.table('typed')} VALUES (1, 9223372036854775806, 12345678901234567890.123456789, '2024-02-29 23:59:59.123456', '2024-02-29', 'È già città 東京 🚀', '{"nested":{"active":true},"items":[1,null,"x"]}', ${binary})`);
  }
  const env = { CODEDB_RBAC: 'on', CODEDB_ENTITLEMENT: 'local', CODEDB_APP_DB_URI: MONGO_URI,
    CODEDB_APP_DB_NAME: APP_DB, CODEDB_OWNER_EMAIL: 'owner@codedb-lab.test', CODEDB_OWNER_PASSWORD: 'Solo-laboratorio-2026!', CODEDB_MAX_SUBUSERS: '4' };
  if (mutant) {
    env.CODEDB_LAB_MCP_MUTANT = 'sql-partial-commit';
    env.NODE_OPTIONS = `--require "${path.join(__dirname, 'mcp-mutant.cjs').replaceAll('\\', '/')}"`;
  }
  server = await startTestServer({ port: SERVER_PORT, env });
  const response = await fetch(`${server.url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@codedb-lab.test', password: 'Solo-laboratorio-2026!' }), signal: AbortSignal.timeout(15000) });
  const login = must(await response.json(), 'login owner');
  socket = io(server.url, { auth: { token: login.token }, reconnection: false, forceNew: true, timeout: 15000 });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const engine of engines) must(await emit('connections:save', { name: engine.connName, cfg: engine.config }), 'salvataggio connessione SQL');
  ownerKey = must(await emit('apikeys:create', { label: 'owner-sql' }), 'chiave owner').key;
  owner = await newClient(ownerKey);
  const user = must(await emit('users:create', { email: 'viewer-sql@codedb-lab.test', password: 'Solo-laboratorio-2026!' }), 'viewer');
  for (const engine of engines) {
    must(await emit('grants:set', { subjectId: user.user.id, connName: engine.connName, role: 'viewer', scope: { databases: [engine.db], collections: ['ledger'] } }), 'grant viewer');
  }
  const key = must(await emit('apikeys:create', { subjectId: user.user.id, label: 'viewer-sql', connScope: engines.map(e => e.connName) }), 'chiave viewer').key;
  viewer = await newClient(key);
  for (const engine of engines) {
    engine.ownerCid = must(await call(owner, 'connect_database', { saved: engine.connName }), 'connessione owner').connection_id;
    engine.viewerCid = must(await call(viewer, 'connect_database', { saved: engine.connName }), 'connessione viewer').connection_id;
  }
}

async function rollbackCase(engine) {
  const before = await engine.query(`SELECT id, amount, label FROM ${engine.table('ledger')} ORDER BY id`);
  const token = await prepareBatch(engine, [
    `UPDATE ${engine.table('ledger')} SET amount = amount - 40 WHERE id = 1`,
    `INSERT INTO ${engine.table('ledger')} (id, amount, label) VALUES (1, 40, 'duplicato')`,
    `UPDATE ${engine.table('ledger')} SET amount = amount + 40 WHERE id = 2`,
  ]);
  const response = await write(engine, { confirm_token: token });
  assert.equal(response.ok, false);
  const after = await engine.query(`SELECT id, amount, label FROM ${engine.table('ledger')} ORDER BY id`);
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)), 'un errore al secondo statement deve annullare anche il primo UPDATE reale');
  assert.match(response.text, /annullata per intero|rollback/i);
  assert.equal((await write(engine, { confirm_token: token })).ok, false, 'anche un batch fallito consuma il token');
}

async function runEngine(engine) {
  await check(engine, 'SQL-001', 'Batch fallito: rollback completo osservato da un’altra connessione', () => rollbackCase(engine));
  if (mutant) return;
  await check(engine, 'SQL-002', 'Batch riuscito: anteprima inerte, commit atomico e riepilogo corretto', async () => {
    const token = await prepareBatch(engine, [
      `UPDATE ${engine.table('ledger')} SET amount = amount - 25 WHERE id = 1`,
      `UPDATE ${engine.table('ledger')} SET amount = amount + 25 WHERE id = 2`,
    ]);
    const before = await engine.query(`SELECT amount FROM ${engine.table('ledger')} ORDER BY id`);
    assert.deepEqual(before.map(row => row.amount), [100, 200]);
    const confirmed = must(await write(engine, { confirm_token: token }), 'commit batch');
    assert.equal(confirmed.executed, true);
    assert.equal(confirmed.result.transactional, true);
    assert.equal(confirmed.result.completed, 2);
    assert.equal(confirmed.result.results.length, 2);
    const after = await engine.query(`SELECT amount FROM ${engine.table('ledger')} ORDER BY id`);
    assert.deepEqual(after.map(row => row.amount), [75, 225]);
    assert.equal((await write(engine, { confirm_token: token })).ok, false);
  });
  await check(engine, 'SQL-003', 'Precisione BIGINT e DECIMAL verificata contro il driver nativo', async () => {
    const actual = must(await read(engine, `SELECT bigint_value, decimal_value FROM ${engine.table('typed')} WHERE id = 1`), 'lettura numeri').docs[0];
    const expected = (await engine.query(`SELECT bigint_value, decimal_value FROM ${engine.table('typed')} WHERE id = 1`))[0];
    const scalar = value => value && typeof value === 'object' ? value.$numberLong || value.$numberDecimal : value;
    assert.equal(String(scalar(actual.bigint_value)), String(expected.bigint_value));
    assert.equal(String(scalar(actual.decimal_value)), String(expected.decimal_value));
  });
  await check(engine, 'SQL-004', 'Data e timestamp locale mantengono giorno e sei microsecondi', async () => {
    const row = must(await read(engine, `SELECT local_time, date_value FROM ${engine.table('typed')} WHERE id = 1`), 'lettura date').docs[0];
    assert.equal(row.local_time, '2024-02-29 23:59:59.123456');
    assert.equal(row.date_value, '2024-02-29');
  });
  await check(engine, 'SQL-005', 'Unicode, JSON annidato e bytes non vengono corrotti dal trasporto MCP', async () => {
    const row = must(await read(engine, `SELECT text_value, json_value, binary_value FROM ${engine.table('typed')} WHERE id = 1`), 'lettura tipi').docs[0];
    assert.equal(row.text_value, 'È già città 東京 🚀');
    const json = typeof row.json_value === 'string' ? JSON.parse(row.json_value) : row.json_value;
    assert.deepEqual(json, { nested: { active: true }, items: [1, null, 'x'] });
    const native = (await engine.query(`SELECT binary_value FROM ${engine.table('typed')} WHERE id = 1`))[0].binary_value;
    assert.equal(native.toString('base64'), 'AAH+/w==');
    assert.deepEqual(row.binary_value, { $binary: { base64: native.toString('base64'), subType: '00' } }, 'i bytes SQL devono arrivare in EJSON binario, riutilizzabile senza perdere il tipo');
  });
  await check(engine, 'SQL-006', 'Schema e topologia filtrati per database e tabella del viewer', async () => {
    const data = must(await call(viewer, 'get_databases_and_collections', { connection_id: engine.viewerCid }), 'database');
    assert.deepEqual(data.databases.map(d => d.name), [engine.db]);
    const schema = must(await call(viewer, 'get_schema', { connection_id: engine.viewerCid, db: engine.db }), 'schema');
    assert.deepEqual(schema.collections.map(c => c.name), ['ledger']);
    assert.ok(!JSON.stringify(schema).includes('private_data'));
  });
  await check(engine, 'SQL-007', 'Lo scope SQL richiede filtri strutturati: il percorso consentito restituisce i dati corretti', async () => {
    // SQL Raw è esplicitamente vietato agli scope limitati: view e funzioni
    // possono avere dipendenze invisibili al parser. Va provata la via prevista.
    assert.equal((await read(engine, 'SELECT id, amount, label FROM ledger ORDER BY id', viewer, engine.viewerCid)).ok, false);
    const structured = must(await call(viewer, 'execute_query', { connection_id: engine.viewerCid, db: engine.db, collection: 'ledger',
      filtro: JSON.stringify({ condizioni: [{ campo: 'id', operatore: 'uguale', valore: 1 }], unione: 'e' }) }), 'filtro strutturato');
    assert.equal(structured.docs[0].label, 'conto A');
    assert.equal(structured.total, 1);
  });
  const hidden = [
    `SELECT * FROM ${engine.table('private_data')}`,
    `SELECT l.id, p.secret FROM ${engine.table('ledger')} l JOIN ${engine.table('private_data')} p ON p.id = l.id`,
    `SELECT secret FROM ${engine.table('private_data')} UNION ALL SELECT label FROM ${engine.table('ledger')}`,
    `SELECT id, (SELECT secret FROM ${engine.table('private_data')} WHERE id = 1) AS secret FROM ${engine.table('ledger')}`,
    `SELECT * FROM ${engine.table('ledger', engine.otherDb)}`,
  ];
  for (const [index, sql] of hidden.entries()) {
    await check(engine, `SQL-008-${index + 1}`, 'SQL libero negato con scope limitato anche per subquery e schemi omonimi', async () => {
      const denied = await read(engine, sql, viewer, engine.viewerCid);
      assert.equal(denied.ok, false, denied.text);
      assert.ok(!denied.text.includes(`SEGRETO-${targets.marker}`));
    });
  }
  await check(engine, 'SQL-009', 'Filtro strutturato con apici e SQL apparente resta un valore letterale', async () => {
    const result = must(await call(viewer, 'execute_query', { connection_id: engine.viewerCid, db: engine.db, collection: 'ledger',
      filtro: JSON.stringify({ condizioni: [{ campo: 'label', operatore: 'uguale', valore: "x' OR 1=1 --" }], unione: 'e' }) }), 'valore letterale');
    assert.equal(result.total, 0);
    assert.deepEqual(result.docs, []);
  });
  await check(engine, 'SQL-010', 'Il tool di lettura rifiuta scritture, multi-statement e CTE mutanti; dati invariati', async () => {
    const table = engine.table('ledger');
    const attempts = [`UPDATE ${table} SET amount = 0 WHERE id = 1`, `SELECT 1; DELETE FROM ${table} WHERE id = 1`,
      engine.kind === 'postgresql'
        ? `WITH d AS (DELETE FROM ${table} WHERE id = 1 RETURNING *) SELECT * FROM d`
        : `WITH x AS (SELECT 1) DELETE FROM ${table} WHERE id = 1`];
    for (const sql of attempts) assert.equal((await read(engine, sql)).ok, false, sql);
    const after = await engine.query(`SELECT amount FROM ${table} ORDER BY id`);
    assert.deepEqual(after.map(row => row.amount), [75, 225]);
  });
  await check(engine, 'SQL-011', 'Parole SQL in stringhe e commenti non bloccano letture lecite', async () => {
    const result = must(await read(engine, "/* DELETE FROM nulla */ SELECT 'UPDATE; DROP TABLE x' AS literal, 123 AS n"), 'SELECT con stringa');
    assert.equal(result.docs[0].literal, 'UPDATE; DROP TABLE x');
    assert.equal(Number(result.docs[0].n), 123);
  });
  await check(engine, 'SQL-012', 'DELETE senza filtro, DDL nel DML e scritture viewer non ricevono token', async () => {
    assert.equal((await write(engine, { sql: `DELETE FROM ${engine.table('ledger')}` })).ok, false);
    assert.equal((await write(engine, { sql: `DROP TABLE ${engine.table('ledger')}` })).ok, false);
    assert.equal((await call(viewer, 'execute_write', { connection_id: engine.viewerCid, db: engine.db, sql: `UPDATE ${engine.table('ledger')} SET amount = 0 WHERE id = 1` })).ok, false);
    assert.equal((await call(viewer, 'execute_ddl', { connection_id: engine.viewerCid, db: engine.db, sql: 'CREATE TABLE illegal_ddl (id INT)' })).ok, false);
  });
  await check(engine, 'SQL-013', 'Dodici letture concorrenti alternano schemi omonimi senza contaminazione del pool', async () => {
    await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const other = index % 2 === 1;
      const result = must(await read(engine, 'SELECT amount, label FROM ledger WHERE id = 1', owner, engine.ownerCid, other ? engine.otherDb : engine.db), 'lettura concorrente schema');
      assert.equal(result.docs[0].amount, other ? 999 : 75);
      assert.equal(result.docs[0].label, other ? 'schema privato' : 'conto A');
    }));
  });
  await check(engine, 'SQL-014', 'DDL confermato crea, altera e rimuove solo la tabella nello schema scelto', async () => {
    const table = engine.table('ddl_probe');
    for (const sql of [`CREATE TABLE ${table} (id INT PRIMARY KEY)`, `ALTER TABLE ${table} ADD note VARCHAR(40)`, `DROP TABLE ${table}`]) {
      const data = must(await call(owner, 'execute_ddl', { connection_id: engine.ownerCid, db: engine.db, sql }), 'anteprima DDL');
      assert.equal(data.requires_confirmation, true);
      must(await call(owner, 'execute_ddl', { connection_id: engine.ownerCid, db: engine.db, confirm_token: data.confirm_token }), 'conferma DDL');
      const catalog = await engine.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${engine.db}' AND table_name = 'ddl_probe' ORDER BY ordinal_position`);
      assert.deepEqual(catalog.map(row => row.column_name || row.COLUMN_NAME), sql.startsWith('CREATE') ? ['id'] : sql.startsWith('ALTER') ? ['id', 'note'] : []);
    }
    assert.equal((await engine.query(`SELECT amount FROM ${engine.table('ledger', engine.otherDb)} WHERE id = 1`))[0].amount, 999);
  });
  await check(engine, 'SQL-015', 'Una query fallita non lascia il pool in transazione abortita o nello schema sbagliato', async () => {
    assert.equal((await read(engine, 'SELECT * FROM tabella_che_non_esiste')).ok, false);
    const recovered = must(await read(engine, 'SELECT amount FROM ledger WHERE id = 1'), 'query successiva');
    assert.equal(recovered.docs[0].amount, 75);
  });
  await check(engine, 'SQL-016', 'Il filtro strutturato rispetta scope di tabella e database, senza negare la lettura consentita', async () => {
    const base = { connection_id: engine.viewerCid, db: engine.db, collection: 'ledger',
      filtro: JSON.stringify({ condizioni: [{ campo: 'id', operatore: 'uguale', valore: 1 }], unione: 'e' }) };
    for (const changes of [{ collection: 'private_data' }, { db: engine.otherDb }]) {
      const denied = await call(viewer, 'execute_query', { ...base, ...changes });
      assert.equal(denied.ok, false);
      assert.ok(!denied.text.includes(`SEGRETO-${targets.marker}`));
    }
    const allowed = must(await call(viewer, 'execute_query', base), 'filtro ancora consentito');
    assert.equal(allowed.docs[0].amount, 75);
  });
  await check(engine, 'SQL-017', 'SELECT di funzione mutante bloccata dalla transazione READ ONLY del DBMS', async () => {
    const routine = `${engine.q(engine.db)}.${engine.q('lab_attempt_write')}`;
    const body = `BEGIN UPDATE ${engine.table('ledger')} SET amount = amount + 500 WHERE id = 1; RETURN 1; END`;
    await engine.query(engine.kind === 'mysql'
      ? `CREATE FUNCTION ${routine}() RETURNS INT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY INVOKER ${body}`
      : `CREATE FUNCTION ${routine}() RETURNS INT LANGUAGE plpgsql AS '${body}'`);
    // Prima dimostriamo che la funzione esegue davvero UPDATE sul DBMS. Il
    // driver indipendente annulla poi questa prova nella propria transazione.
    await engine.query('START TRANSACTION');
    try {
      await engine.query(`SELECT ${routine}() AS result`);
      assert.equal((await engine.query(`SELECT amount FROM ${engine.table('ledger')} WHERE id = 1`))[0].amount, 575);
    } finally { await engine.query('ROLLBACK'); }
    const rejected = await read(engine, `SELECT ${routine}() AS result`);
    assert.equal(rejected.ok, false, 'La query è SELECT, ma la funzione modifica dati e il DBMS deve impedirlo.');
    assert.equal((await engine.query(`SELECT amount FROM ${engine.table('ledger')} WHERE id = 1`))[0].amount, 75);
    const recovered = must(await read(engine, 'SELECT amount FROM ledger WHERE id = 1'), 'pool dopo errore READ ONLY');
    assert.equal(recovered.docs[0].amount, 75);
  });
}

(async () => {
  try {
    await setup();
    for (const engine of engines) await runEngine(engine);
  } catch (error) {
    report.results.push({ id: 'SQL-SETUP', label: 'Preparazione o esecuzione laboratorio SQL', status: 'failed', error: error.stack || String(error) });
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    socket?.close();
    await server?.stop();
    for (const engine of engines) {
      try {
        for (const name of [engine.otherDb, engine.db].filter(Boolean)) await targets.drop(name, engine.drop);
      } catch (error) {
        report.results.push({ id: `${engine.kind}-CLEANUP`, label: 'Pulizia schemi del laboratorio', status: 'failed', error: error.stack || String(error) });
        process.exitCode = 1;
      }
      await engine.driver.end().catch(() => {});
    }
    if (mongo) {
      try { await targets.drop(APP_DB, name => mongo.db(name).dropDatabase()); }
      catch (error) { report.results.push({ id: 'AUTH-CLEANUP', status: 'failed', error: String(error) }); process.exitCode = 1; }
      await mongo.close();
    }
    report.finishedAt = new Date().toISOString();
    report.passed = report.results.filter(r => r.status === 'passed').length;
    report.failed = report.results.filter(r => r.status === 'failed').length;
    const output = path.join(process.env.LAB_REPORT_DIR || path.join(__dirname, '../../.scratch/lab-reports'), mutant ? 'mcp-sql-mutant.json' : 'mcp-sql.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`MCP SQL: ${report.passed} superati, ${report.failed} falliti. Report: ${output}`);
  }
})();
