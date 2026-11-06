'use strict';

// Controlli MCP reali sui soli database casuali del laboratorio Docker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const { io } = require('socket.io-client');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_mcp_panel' });
const appDb = targets.target('auth');
const mongoUri = 'mongodb://127.0.0.1:37017/?directConnection=true';
const password = 'Solo-laboratorio-2026!';
const ownerEmail = 'mcp-panel@codedb-lab.test';
const clients = [], sockets = [], engines = [];
let server, mongo;
const report = [];
const mutant = process.argv.includes('--mutant-readonly');
const must = result => { assert(result?.ok, result?.error || result?.text || JSON.stringify(result)); return result; };
const emit = (socket, event, args = {}) => new Promise((resolve, reject) => socket.timeout(20000).emit(event, args, (err, value) => err ? reject(err) : resolve(value)));
async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { ok: !response.isError, text, data: !response.isError && text ? JSON.parse(text) : null };
}
async function login(email) {
  const response = await fetch(`${server.url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const auth = must(await response.json());
  const socket = io(server.url, { auth: { token: auth.token }, reconnection: false, forceNew: true });
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
async function clientFor(key) {
  const client = new Client({ name: 'verifica-pannello-mcp', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
async function check(label, run) {
  await run(); report.push(label); console.log('  OK   ' + label);
}

(async () => {
  try {
    targets.assertOwned(appDb);
    mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
    await mongo.connect();
    engines.push({ kind: 'mongodb', cfg: { dbType: 'mongodb', uri: mongoUri, readOnly: false },
      prepare: async db => mongo.db(db).collection('ledger').insertOne({ id: 1, amount: 10 }),
      amount: async db => (await mongo.db(db).collection('ledger').findOne({ id: 1 })).amount,
      drop: db => mongo.db(db).dropDatabase(),
    });
    const my = await mysql.createConnection({ host: '127.0.0.1', port: 33306, user: 'root', password: 'lab_mysql' });
    engines.push({ kind: 'mysql', driver: my, cfg: { dbType: 'mysql', host: '127.0.0.1', port: 33306, username: 'root', password: 'lab_mysql', readOnly: false },
      prepare: async db => { await my.query(`CREATE DATABASE \`${db}\``); await my.query(`CREATE TABLE \`${db}\`.ledger (id INT PRIMARY KEY, amount INT)`); await my.query(`INSERT INTO \`${db}\`.ledger VALUES (1,10)`); },
      amount: async db => (await my.query(`SELECT amount FROM \`${db}\`.ledger WHERE id=1`))[0][0].amount,
      drop: db => my.query(`DROP DATABASE IF EXISTS \`${db}\``),
    });
    const pg = new PgClient({ host: '127.0.0.1', port: 35432, user: 'postgres', password: 'lab_postgres', database: 'postgres' });
    await pg.connect();
    engines.push({ kind: 'postgresql', driver: pg, cfg: { dbType: 'postgresql', host: '127.0.0.1', port: 35432, username: 'postgres', password: 'lab_postgres', database: 'postgres', readOnly: false },
      prepare: async db => { await pg.query(`CREATE SCHEMA "${db}"`); await pg.query(`CREATE TABLE "${db}".ledger (id INT PRIMARY KEY, amount INT)`); await pg.query(`INSERT INTO "${db}".ledger VALUES (1,10)`); },
      amount: async db => (await pg.query(`SELECT amount FROM "${db}".ledger WHERE id=1`)).rows[0].amount,
      drop: db => pg.query(`DROP SCHEMA IF EXISTS "${db}" CASCADE`),
    });
    for (const engine of engines) { engine.db = targets.target(engine.kind); engine.name = 'panel-' + engine.kind; await engine.prepare(engine.db); }
    server = await startTestServer({ port: Number(process.env.E2E_MCP_CONTROL_PORT || 39034), env: {
      CODEDB_RBAC: 'on', CODEDB_ENTITLEMENT: 'local', CODEDB_APP_DB_URI: mongoUri, CODEDB_APP_DB_NAME: appDb,
      CODEDB_OWNER_EMAIL: ownerEmail, CODEDB_OWNER_PASSWORD: password, CODEDB_MAX_SUBUSERS: '4',
      ...(mutant ? { NODE_OPTIONS: `--require "${path.join(__dirname, 'fixtures/mcp-control-mutant.cjs').replaceAll('\\', '/')}"` } : {}),
    } });
    const owner = await login(ownerEmail);
    for (const engine of engines) must(await emit(owner, 'connections:save', { name: engine.name, cfg: engine.cfg }));
    const key = must(await emit(owner, 'apikeys:create', { label: 'verifica pannello' })).key;
    const client = await clientFor(key);
    const viewerInfo = must(await emit(owner, 'users:create', { email: 'viewer-panel@codedb-lab.test', password })).user;
    for (const engine of engines) must(await emit(owner, 'grants:set', { subjectId: viewerInfo.id, connName: engine.name, role: 'viewer', scope: { databases: [engine.db], collections: ['ledger'] } }));
    const viewerKey = must(await emit(owner, 'apikeys:create', { label: 'viewer pannello', subjectId: viewerInfo.id })).key;
    const viewer = await login('viewer-panel@codedb-lab.test');
    const viewerClient = await clientFor(viewerKey);
    async function setting(values) {
      const current = must(await emit(owner, 'mcp:settings:get'));
      return must(await emit(owner, 'mcp:settings:update', { values, revision: current.revision }));
    }
    for (const engine of engines) {
      await check(`${engine.kind}: lettura, conferma e revoca MCP sulle sessioni già aperte`, async () => {
        engine.cid = must(await call(client, 'connect_database', { saved: engine.name })).data.connection_id;
        const base = { connection_id: engine.cid, db: engine.db };
        const read = engine.kind === 'mongodb' ? { ...base, collection: 'ledger', filter: '{}' } : { ...base, sql: 'SELECT * FROM ledger' };
        must(await call(client, 'execute_query', read));
        const mutation = engine.kind === 'mongodb' ? { ...base, collection: 'ledger', operation: 'update', filter: '{"id":1}', set: '{"amount":20}' } : { ...base, sql: 'UPDATE ledger SET amount=20 WHERE id=1' };
        const pending = must(await call(client, 'execute_write', mutation)).data;
        assert.equal(pending.requires_confirmation, true);
        assert.equal(await engine.amount(engine.db), 10);
        await setting({ readOnly: true });
        assert.equal((await call(client, 'execute_write', { ...mutation, confirm_token: pending.confirm_token })).ok, false);
        assert.equal(await engine.amount(engine.db), 10);
        await setting({ readOnly: false });
        const fresh = must(await call(client, 'execute_write', mutation)).data;
        must(await call(client, 'execute_write', { ...mutation, confirm_token: fresh.confirm_token }));
        assert.equal(await engine.amount(engine.db), 20);
        const activities = must(await emit(owner, 'mcp:activity:list', { connection: engine.name, limit: 100 }));
        assert(activities.entries.some(e => e.tool === 'execute_query' && e.status === 'completed'));
        assert(activities.entries.some(e => e.tool === 'execute_write' && e.status === 'completed'));
        assert(activities.entries.some(e => e.tool === 'execute_write' && ['rejected', 'failed'].includes(e.status)));
      });
    }
    await check('Attività e sessioni personali, dettagli ed export isolati', async () => {
      const cid = must(await call(viewerClient, 'connect_database', { saved: engines[0].name })).data.connection_id;
      must(await call(viewerClient, 'execute_query', { connection_id: cid, db: engines[0].db, collection: 'ledger', filter: '{}' }));
      const list = must(await emit(viewer, 'mcp:activity:list'));
      assert(list.entries.length > 0 && list.entries.every(e => e.userId === viewerInfo.id));
      const all = must(await emit(owner, 'mcp:activity:list', { limit: 100 }));
      const other = all.entries.find(e => e.userId !== viewerInfo.id);
      assert(other);
      assert.equal((await emit(viewer, 'mcp:activity:get', { id: other.id })).ok, false);
      const exported = must(await emit(viewer, 'mcp:activity:export', { format: 'json' }));
      assert(JSON.parse(exported.content).every(e => e.userId === viewerInfo.id));
      assert(!exported.content.includes(key) && !exported.content.includes(viewerKey));
      const state = must(await emit(viewer, 'mcp:status'));
      assert(state.sessions.length > 0 && state.sessions.every(s => s.userId === viewerInfo.id));
      const current = must(await emit(viewer, 'mcp:settings:get'));
      assert.equal((await emit(viewer, 'mcp:settings:update', { values: { enabled: false }, revision: current.revision })).ok, false);
      const ownerSession = must(await emit(owner, 'mcp:status')).sessions.find(s => s.userId !== viewerInfo.id);
      assert.equal((await emit(viewer, 'mcp:sessions:close', { id: ownerSession.id })).ok, false);
    });
    await check('Persistenza configurazione e riattivazione del servizio', async () => {
      await setting({ maxSessions: 16, enabled: false });
      let state;
      for (let i = 0; i < 50; i++) {
        state = must(await emit(owner, 'mcp:status'));
        if (state.state === 'disabled') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(state.state, 'disabled');
      const config = JSON.parse(fs.readFileSync(path.join(server.dir, 'mcp-settings.json'), 'utf8'));
      assert.equal(config.values.maxSessions, 16);
      assert.equal(config.values.enabled, false);
      const updates = must(await emit(owner, 'mcp:activity:list', { tool: 'mcp:settings:update' }));
      assert(updates.entries.some(e => e.result?.changes?.maxSessions?.dopo === 16), 'lo storico deve mostrare i valori effettivamente cambiati');
      await setting({ enabled: true });
      const reconnected = await clientFor(key);
      must(await call(reconnected, 'list_saved_connections'));
      assert.equal(must(await emit(owner, 'mcp:status')).state, 'active');
    });
    await check('Revoca API key valida anche dopo una sessione già inizializzata', async () => {
      const newKey = must(await emit(owner, 'apikeys:create', { label: 'revoca' }));
      const revokeClient = await clientFor(newKey.key);
      must(await call(revokeClient, 'list_saved_connections'));
      must(await emit(owner, 'apikeys:revoke', { id: newKey.apiKey.id }));
      await assert.rejects(() => call(revokeClient, 'list_saved_connections'));
    });
  } catch (err) { console.error(err); process.exitCode = 1; }
  finally {
    await Promise.allSettled(clients.map(client => client.close()));
    for (const socket of sockets) socket.close();
    await server?.stop();
    for (const engine of engines) {
      if (engine.db) await targets.drop(engine.db, engine.drop);
      await engine.driver?.end();
    }
    if (mongo) { await targets.drop(appDb, name => mongo.db(name).dropDatabase()); await mongo.close(); }
    console.log(`Pannello MCP reale: ${report.length} scenari superati.`);
  }
})();
