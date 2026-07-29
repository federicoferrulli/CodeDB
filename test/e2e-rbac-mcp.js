'use strict';

// Test end-to-end dell'autenticazione RBAC sul gateway MCP: senza API key
// l'endpoint /mcp risponde 401, e con la chiave di un sottoutente "viewer" i
// tool sono limitati dai suoi grant (connessioni, scope, sola lettura).
// Avvia da sé un'istanza con CODEDB_RBAC=on (vedi rbac-harness.js).
// Richiede un MongoDB locale su :27017. Uso: node test/e2e-rbac-mcp.js

const { io } = require('socket.io-client');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  BASE, DATA_DB, CONN_NAME, OTHER_CONN, OWNER, VIEWER,
  assert, startRbacServer, stopRbacServer, seedData, cleanupMongo, login,
} = require('./rbac-harness');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload || {}, resolve));
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content && res.content[0] && res.content[0].text) || '';
  return { ok: !res.isError, text, data: res.isError ? null : JSON.parse(text) };
}

// Client MCP che presenta la API key su ogni richiesta HTTP.
async function newMcpClient(apiKey) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
  });
  const client = new Client({ name: 'codedb-e2e-rbac-mcp', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

(async () => {
  let server = null;
  let ownerSock = null;
  let mcp = null;
  try {
    await cleanupMongo();
    await seedData();

    console.log('1. avvio del server con RBAC attivo');
    server = await startRbacServer({ maxSubUsers: 2 });

    console.log('2. /mcp senza API key');
    const anon = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    assert(anon.status === 401, `richiesta senza API key respinta con 401 (ricevuto ${anon.status})`);

    const wrong = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer cdb_inesistente' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    assert(wrong.status === 401, `API key inesistente respinta con 401 (ricevuto ${wrong.status})`);

    console.log('3. preparazione: sottoutente viewer + API key');
    const ownerLogin = await login(OWNER.email, OWNER.password);
    assert(ownerLogin.ok, 'owner autenticato');
    ownerSock = io(BASE, { auth: { token: ownerLogin.token }, reconnection: false, forceNew: true });
    await new Promise((resolve, reject) => {
      ownerSock.once('connect', resolve);
      ownerSock.once('connect_error', reject);
    });

    const created = await emit(ownerSock, 'users:create', { email: VIEWER.email, password: VIEWER.password });
    assert(created.ok, `sottoutente creato (${created.ok ? 'ok' : created.error})`);
    const grant = await emit(ownerSock, 'grants:set', {
      subjectId: created.user.id,
      connName: CONN_NAME,
      role: 'viewer',
      scope: { databases: [DATA_DB], collections: ['orders*'] },
    });
    assert(grant.ok, 'grant viewer con scope orders*');

    const keyRes = await emit(ownerSock, 'apikeys:create', {
      subjectId: created.user.id, label: 'e2e', connScope: [CONN_NAME],
    });
    assert(keyRes.ok && typeof keyRes.key === 'string' && keyRes.key.startsWith('cdb_'),
      'API key generata e mostrata una sola volta');

    console.log('4. sessione MCP con la API key del viewer');
    mcp = await newMcpClient(keyRes.key);
    const saved = await call(mcp.client, 'list_saved_connections', {});
    const names = saved.ok ? saved.data.connections.map((c) => c.name) : [];
    assert(saved.ok && names.length === 1 && names[0] === CONN_NAME,
      `list_saved_connections limitata al connScope (${names.join(', ') || saved.text}`);

    const refused = await call(mcp.client, 'connect_database', { saved: OTHER_CONN });
    assert(!refused.ok && /permesso negato/i.test(refused.text), `connessione senza grant negata (${refused.text})`);

    const conn = await call(mcp.client, 'connect_database', { saved: CONN_NAME });
    assert(conn.ok, `connessione consentita aperta (${conn.ok ? conn.data.connection_id : conn.text})`);
    const connectionId = conn.ok ? conn.data.connection_id : null;

    console.log('5. permessi sui tool');
    const read = await call(mcp.client, 'execute_query', { connection_id: connectionId, db: DATA_DB, collection: 'orders', filter: '{}' });
    assert(read.ok, `execute_query su orders consentita (${read.ok ? 'ok' : read.text})`);

    const readOut = await call(mcp.client, 'execute_query', { connection_id: connectionId, db: DATA_DB, collection: 'customers', filter: '{}' });
    assert(!readOut.ok && /permesso negato/i.test(readOut.text), `execute_query fuori scope negata (${readOut.text})`);

    const write = await call(mcp.client, 'execute_write', {
      connection_id: connectionId, operation: 'insert', db: DATA_DB, collection: 'orders', doc: '{"code":"Z-1"}',
    });
    assert(!write.ok, `execute_write negata al viewer (${write.text})`);

    const setRo = await call(mcp.client, 'set_connection_read_only', { connection_name: CONN_NAME, read_only: true });
    assert(!setRo.ok && /permesso negato/i.test(setRo.text), `set_connection_read_only negato al viewer (${setRo.text})`);

    console.log('6. revoca della API key');
    const keys = await emit(ownerSock, 'apikeys:list');
    assert(keys.ok && keys.keys.length === 1, 'la chiave compare nell\'elenco (senza il valore in chiaro)');
    const revoked = await emit(ownerSock, 'apikeys:revoke', { id: keys.keys[0].id });
    assert(revoked.ok, 'API key revocata');

    const afterRevoke = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${keyRes.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    assert(afterRevoke.status === 401, `dopo la revoca la chiave non è più valida (${afterRevoke.status})`);

    console.log('\nTest RBAC su MCP completati.');
  } catch (err) {
    console.error('  FAIL errore inatteso:', err && err.message);
    process.exitCode = 1;
  } finally {
    if (mcp) await mcp.client.close().catch(() => {});
    if (ownerSock) ownerSock.close();
    await stopRbacServer(server);
    await cleanupMongo().catch(() => {});
  }
})();
