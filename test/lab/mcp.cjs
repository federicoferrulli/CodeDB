'use strict';

// Laboratorio MCP reale: SDK ufficiale -> HTTP -> CodeDB -> MongoDB isolato.
// Ogni scrittura viene riletta con il driver indipendente. Le conferme riguardano
// soltanto i dati sintetici del laboratorio autorizzato, mai database utente.
// CODEDB_E2E_DESTRUCTIVE=1 LAB_MONGO_URI=mongodb://127.0.0.1:37017/?directConnection=true
// node test/lab/mcp.cjs [--mutant-confirmation-reuse]

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { MongoClient, Long, Decimal128, ObjectId, Binary } = require('mongodb');
const { io } = require('socket.io-client');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startTestServer, createE2eTargetRegistry } = require('../e2e-harness');

const MONGO_URI = process.env.LAB_MONGO_URI || 'mongodb://127.0.0.1:37017/?directConnection=true';
const SERVER_PORT = Number(process.env.LAB_MCP_PORT || 39031);
const mutant = process.argv.includes('--mutant-confirmation-reuse');
const isolatedContainer = process.env.CODEDB_LAB_CONTAINER === '1' && fs.existsSync('/.dockerenv');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_lab_mcp' });
const APP_DB = targets.target('auth');
const DATA_DB = targets.target('data');
const OTHER_DB = targets.target('other');
const CONN = 'lab-mongo';
const OTHER_CONN = 'lab-mongo-other';
const OWNER = { email: 'owner@codedb-lab.test', password: 'Solo-laboratorio-2026!' };
const results = [];
const mcpClients = [];
let server;
let ownerSocket;
let mongo;
let owner;
let viewer;
let editor;

function must(result, label) {
  assert.ok(result && result.ok, `${label}: ${result?.text || result?.error || JSON.stringify(result)}`);
  return result.data || result;
}

async function check(id, label, action) {
  const started = performance.now();
  try {
    await action();
    results.push({ id, label, status: 'passed', durationMs: Math.round(performance.now() - started) });
    console.log(`PASS ${id}: ${label}`);
  } catch (error) {
    results.push({ id, label, status: 'failed', durationMs: Math.round(performance.now() - started), error: error.stack || String(error) });
    console.error(`FAIL ${id}: ${label}\n${error.stack || error}`);
    process.exitCode = 1;
  }
}

async function emit(event, payload = {}) {
  return new Promise((resolve, reject) => {
    ownerSocket.timeout(15000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}

async function rpc(key, sessionId, method = 'tools/list', httpMethod = 'POST', headers = {}) {
  const response = await fetch(`${server.url}/mcp`, {
    method: httpMethod,
    headers: {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}), ...headers,
    },
    ...(httpMethod === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 701, method,
      ...(method === 'initialize' ? { params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codedb-lab', version: '1' } } } : {}),
    }) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function connectClient(key) {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'codedb-laboratorio-mcp', version: '1.0.0' });
  await client.connect(transport);
  const handle = { client, transport, key };
  mcpClients.push(handle);
  return handle;
}

async function call(handle, name, args = {}) {
  const result = await handle.client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  const text = (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  return { ok: !result.isError, text, data: result.isError ? null : JSON.parse(text) };
}

async function createPrincipal(label, role) {
  const created = must(await emit('users:create', { email: `${label}@codedb-lab.test`, password: 'Solo-laboratorio-2026!' }), `creazione ${label}`);
  const grant = { subjectId: created.user.id, connName: CONN, role, scope: { databases: [DATA_DB], collections: ['orders*'] } };
  must(await emit('grants:set', grant), `grant ${label}`);
  const api = must(await emit('apikeys:create', { subjectId: created.user.id, label, connScope: [CONN] }), `chiave ${label}`);
  const handle = await connectClient(api.key);
  handle.userId = created.user.id;
  handle.keyId = api.apiKey.id;
  handle.grant = grant;
  handle.cid = must(await call(handle, 'connect_database', { saved: CONN }), `connessione ${label}`).connection_id;
  return handle;
}

const query = (handle, args = {}) => call(handle, 'execute_query', { connection_id: handle.cid, db: DATA_DB, collection: 'orders', ...args });
const write = (handle, args = {}) => call(handle, 'execute_write', { connection_id: handle.cid, db: DATA_DB, collection: 'orders_write', ...args });

async function preview(handle, doc) {
  const response = must(await write(handle, { operation: 'insert', doc: JSON.stringify(doc) }), 'anteprima insert');
  assert.equal(response.requires_confirmation, true);
  assert.equal(typeof response.confirm_token, 'string');
  return response.confirm_token;
}

async function testConfirmationReuse() {
  const marker = `monouso-${targets.marker}`;
  const token = await preview(owner, { marker });
  assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker }), 0, 'l’anteprima non scrive');
  must(await write(owner, { confirm_token: token }), 'prima conferma');
  const replay = await write(owner, { confirm_token: token });
  const count = await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker });
  assert.deepEqual({ replayOk: replay.ok, count }, { replayOk: false, count: 1 }, 'il riuso non deve riuscire né duplicare il documento reale');
}

async function setup() {
  targets.assertOwned(APP_DB);
  const uri = new URL(MONGO_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname) && (Number(uri.port) !== 27017 || isolatedContainer),
    'Il laboratorio accetta solo MongoDB locale su porta dedicata diversa da 27017.');
  assert.equal(uri.searchParams.get('directConnection'), 'true', 'Mongo replica set deve restare sulla porta esplicita del laboratorio.');
  mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000, promoteLongs: false });
  await mongo.connect();
  const orders = Array.from({ length: 137 }, (_, i) => ({
    _id: `order-${i}`, index: i, group: `g${i % 7}`, amount: i * 3,
    customer_id: 'private-customer', note: `Ordine ${i} – città 東京 🚀`,
    nested: { flags: [true, false], nullable: null },
  }));
  await mongo.db(DATA_DB).collection('orders').insertMany(orders);
  await mongo.db(DATA_DB).collection('orders_history').insertOne({ _id: 'history', order_id: 'order-1' });
  await mongo.db(DATA_DB).collection('private_customers').insertOne({ _id: 'private-customer', secret: `SEGRETO-${targets.marker}` });
  await mongo.db(OTHER_DB).collection('orders').insertOne({ _id: 'other-db', secret: 'fuori scope database' });
  const env = {
    CODEDB_RBAC: 'on', CODEDB_ENTITLEMENT: 'local', CODEDB_APP_DB_URI: MONGO_URI,
    CODEDB_APP_DB_NAME: APP_DB, CODEDB_OWNER_EMAIL: OWNER.email, CODEDB_OWNER_PASSWORD: OWNER.password,
    CODEDB_MAX_SUBUSERS: '6', CODEDB_REVALIDATE_PRINCIPAL_MS: '200',
  };
  if (mutant) {
    env.CODEDB_LAB_MCP_MUTANT = 'confirmation-reuse';
    env.NODE_OPTIONS = `--require "${path.join(__dirname, 'mcp-mutant.cjs').replaceAll('\\', '/')}"`;
  }
  server = await startTestServer({ port: SERVER_PORT, env });
  const login = await fetch(`${server.url}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(OWNER), signal: AbortSignal.timeout(15000),
  });
  const session = must(await login.json(), 'login owner');
  ownerSocket = io(server.url, { auth: { token: session.token }, reconnection: false, forceNew: true, timeout: 15000 });
  await new Promise((resolve, reject) => { ownerSocket.once('connect', resolve); ownerSocket.once('connect_error', reject); });
  for (const name of [CONN, OTHER_CONN]) {
    must(await emit('connections:save', { name, cfg: { dbType: 'mongodb', uri: MONGO_URI, host: uri.hostname, port: Number(uri.port), directConnection: true, readOnly: false } }), `salvataggio ${name}`);
  }
  const ownerKey = must(await emit('apikeys:create', { label: 'owner-laboratorio', connScope: [CONN, OTHER_CONN] }), 'chiave owner');
  owner = await connectClient(ownerKey.key);
  owner.cid = must(await call(owner, 'connect_database', { saved: CONN }), 'connessione owner').connection_id;
  if (!mutant) {
    viewer = await createPrincipal('viewer', 'viewer');
    editor = await createPrincipal('editor', 'editor');
  }
}

async function run() {
  await setup();
  await check('MCP-001', 'Conferma monouso: nessuna scrittura in anteprima, nessuna duplicazione al retry', testConfirmationReuse);
  if (mutant) return;

  await check('MCP-002', 'Autenticazione HTTP obbligatoria su POST, GET e DELETE', async () => {
    for (const method of ['POST', 'GET', 'DELETE']) {
      for (const key of [null, 'cdb_chiave_inesistente']) {
        assert.equal((await rpc(key, owner.transport.sessionId, 'tools/list', method)).status, 401, `${method}: chiave ${key ? 'invalida' : 'assente'}`);
      }
    }
  });
  await check('MCP-003', 'Sessione vincolata alla chiave: anche un’altra chiave dello stesso owner è respinta', async () => {
    const other = must(await emit('apikeys:create', { label: 'seconda-owner', connScope: [CONN] }), 'seconda chiave');
    for (const method of ['POST', 'GET', 'DELETE']) {
      assert.equal((await rpc(other.key, owner.transport.sessionId, 'tools/list', method)).status, 403, method);
      assert.equal((await rpc(viewer.key, owner.transport.sessionId, 'tools/list', method)).status, 403, method);
    }
    assert.equal((await rpc(owner.key, owner.transport.sessionId)).status, 200);
  });
  await check('MCP-004', 'Elenco connessioni e apertura rispettano il connScope della chiave', async () => {
    const list = must(await call(viewer, 'list_saved_connections'), 'elenco connessioni');
    assert.deepEqual(list.connections.map(c => c.name), [CONN]);
    assert.equal((await call(viewer, 'connect_database', { saved: OTHER_CONN })).ok, false);
  });
  await check('MCP-005', 'Topologia e schema non rivelano database, collezioni o relazioni fuori scope', async () => {
    const dbs = must(await call(viewer, 'get_databases_and_collections', { connection_id: viewer.cid }), 'database');
    assert.deepEqual(dbs.databases.map(d => d.name), [DATA_DB]);
    const colls = must(await call(viewer, 'get_databases_and_collections', { connection_id: viewer.cid, db: DATA_DB }), 'collezioni');
    assert.ok(colls.collections.length >= 2);
    assert.ok(colls.collections.every(c => c.name.startsWith('orders')));
    const schema = must(await call(viewer, 'get_schema', { connection_id: viewer.cid, db: DATA_DB }), 'schema');
    assert.ok(schema.collections.every(c => c.name.startsWith('orders')));
    assert.ok(schema.relations.every(r => r.from.startsWith('orders') && r.to.startsWith('orders')));
  });
  await check('MCP-006', 'Risorse MCP schema e grafo rispettano lo scope', async () => {
    for (const scheme of ['schema', 'graph']) {
      const result = await viewer.client.readResource({ uri: `${scheme}://${viewer.cid}/${DATA_DB}` });
      const text = result.contents.map(c => c.text || '').join('');
      assert.ok(text.includes('orders'), `${scheme}: contenuto utile presente`);
      assert.ok(!text.includes('private_customers'), `${scheme}: collezione privata assente`);
    }
  });
  await check('MCP-007', 'Letture dirette fuori scope rifiutate senza risultati parziali', async () => {
    for (const args of [{ collection: 'private_customers' }, { db: OTHER_DB }]) {
      assert.equal((await query(viewer, args)).ok, false, JSON.stringify(args));
    }
  });
  const prohibitedPipelines = [
    [{ $lookup: { from: 'private_customers', localField: 'customer_id', foreignField: '_id', as: 'leak' } }],
    [{ $unionWith: 'private_customers' }],
    [{ $graphLookup: { from: 'private_customers', startWith: '$customer_id', connectFromField: '_id', connectToField: '_id', as: 'leak' } }],
    [{ $facet: { nested: [{ $lookup: { from: 'private_customers', localField: 'customer_id', foreignField: '_id', as: 'leak' } }] } }],
  ];
  for (const [index, pipeline] of prohibitedPipelines.entries()) {
    await check(`MCP-008-${index + 1}`, 'Scope di tutte le sorgenti Mongo, incluse pipeline annidate', async () => {
      const result = await query(viewer, { pipeline: JSON.stringify(pipeline) });
      assert.equal(result.ok, false, result.text);
      assert.ok(!result.text.includes(`SEGRETO-${targets.marker}`));
    });
  }
  await check('MCP-009', 'Lookup consentito restituisce i valori attesi: la protezione non blocca tutte le aggregazioni', async () => {
    const result = must(await query(viewer, { pipeline: JSON.stringify([
      { $match: { _id: 'order-1' } },
      { $lookup: { from: 'orders_history', localField: '_id', foreignField: 'order_id', as: 'history' } },
    ]) }), 'lookup autorizzato');
    assert.equal(result.docs.length, 1);
    assert.equal(result.docs[0].history[0]._id, 'history');
  });
  await check('MCP-010', 'Paginazione completa: 137 identità una volta sola, ordine stabile e totale esatto', async () => {
    const ids = [];
    for (let skip = 0; skip < 137; skip += 17) {
      const result = must(await query(viewer, { skip, limit: 17, sort: '{"index":1}' }), 'pagina');
      assert.equal(result.total, 137);
      assert.ok(result.docs.length <= 17);
      ids.push(...result.docs.map(row => row._id));
    }
    assert.deepEqual(ids, Array.from({ length: 137 }, (_, i) => `order-${i}`));
  });
  await check('MCP-011', 'Dodici query simultanee mantengono filtri e risultati separati', async () => {
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const result = must(await query(viewer, { filter: JSON.stringify({ _id: `order-${i}` }) }), 'query concorrente');
      assert.equal(result.total, 1);
      assert.equal(result.docs[0]._id, `order-${i}`);
      assert.equal(result.docs[0].note, `Ordine ${i} – città 東京 🚀`);
    }));
  });
  await check('MCP-012', 'Query di sola lettura non possono materializzare risultati né eseguire JavaScript server', async () => {
    for (const args of [
      { pipeline: '[{"$out":"orders_forbidden"}]' },
      { pipeline: '[{"$merge":"orders_forbidden"}]' },
      { filter: '{"$where":"return true"}' },
    ]) assert.equal((await query(viewer, args)).ok, false, JSON.stringify(args));
    assert.equal(await mongo.db(DATA_DB).collection('orders_forbidden').countDocuments(), 0);
  });
  await check('MCP-013', 'Viewer non ottiene token di scrittura; editor non ottiene delete o DDL', async () => {
    assert.equal((await write(viewer, { operation: 'insert', doc: '{"marker":"viewer-vietato"}' })).ok, false);
    assert.equal((await write(editor, { operation: 'delete', filter: '{"marker":"x"}' })).ok, false);
    assert.equal((await write(editor, { operation: 'drop_collection' })).ok, false);
    assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'viewer-vietato' }), 0);
  });
  await check('MCP-014', 'Token non trasferibili tra sessioni e connessioni dello stesso owner', async () => {
    const token = await preview(owner, { marker: 'session-bound' });
    const other = await connectClient(owner.key);
    other.cid = must(await call(other, 'connect_database', { saved: CONN }), 'altra sessione').connection_id;
    assert.equal((await write(other, { confirm_token: token })).ok, false);
    const otherCid = must(await call(owner, 'connect_database', { saved: CONN }), 'altra connessione').connection_id;
    assert.equal((await write(owner, { connection_id: otherCid, confirm_token: token })).ok, false);
    must(await write(owner, { confirm_token: token }), 'token originale ancora valido');
    assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'session-bound' }), 1);
  });
  await check('MCP-015', 'Otto conferme concorrenti dello stesso token applicano una sola scrittura', async () => {
    const token = await preview(owner, { marker: 'concurrent-confirm' });
    const responses = await Promise.all(Array.from({ length: 8 }, () => write(owner, { confirm_token: token })));
    assert.equal(responses.filter(result => result.ok).length, 1);
    assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'concurrent-confirm' }), 1);
  });
  await check('MCP-016', 'La conferma esegue esattamente l’anteprima anche se il secondo payload viene alterato', async () => {
    const token = await preview(owner, { marker: 'approved', value: 'originale' });
    must(await write(owner, { confirm_token: token, db: OTHER_DB, collection: 'orders', operation: 'insert', doc: '{"marker":"tampered"}' }), 'conferma anteprima immutabile');
    const expected = await mongo.db(DATA_DB).collection('orders_write').findOne({ marker: 'approved' });
    assert.equal(expected?.value, 'originale');
    assert.equal(await mongo.db(OTHER_DB).collection('orders').countDocuments({ marker: 'tampered' }), 0);
  });
  await check('MCP-017', 'Tipi BSON e precisione numerica sopravvivono a scrittura e lettura MCP', async () => {
    const oid = new ObjectId();
    const doc = {
      _id: { $oid: oid.toHexString() }, marker: 'typed',
      large: { $numberLong: '9223372036854775806' },
      decimal: { $numberDecimal: '12345678901234567890.123456789' },
      date: { $date: '2024-02-29T23:59:59.123Z' },
      bytes: { $binary: { base64: 'AAH+/w==', subType: '00' } },
      text: 'È già città 東京 🚀\nseconda riga', nested: { array: [null, true, 'x'] },
    };
    const token = await preview(editor, doc);
    must(await write(editor, { confirm_token: token }), 'scrittura tipi');
    const raw = await mongo.db(DATA_DB).collection('orders_write').findOne({ _id: oid });
    assert.ok(raw.large instanceof Long);
    assert.equal(raw.large.toString(), doc.large.$numberLong);
    assert.ok(raw.decimal instanceof Decimal128);
    assert.equal(raw.decimal.toString(), doc.decimal.$numberDecimal);
    assert.equal(raw.date.toISOString(), doc.date.$date);
    assert.ok(raw.bytes instanceof Binary);
    assert.equal(raw.bytes.buffer.toString('base64'), doc.bytes.$binary.base64);
    assert.equal(raw.text, doc.text);
    const response = must(await query(editor, { collection: 'orders_write', filter: JSON.stringify({ _id: doc._id }) }), 'rilettura tipi');
    assert.equal(response.docs[0].large.$numberLong, doc.large.$numberLong);
    assert.equal(response.docs[0].decimal.$numberDecimal, doc.decimal.$numberDecimal);
    assert.equal(response.docs[0].bytes.$binary.base64, doc.bytes.$binary.base64);
  });
  await check('MCP-018', 'Errore a metà bulk rende osservabili quantità applicate e impedisce il replay', async () => {
    const token = await preview(owner, [
      { _id: 'partial-a', marker: 'partial' }, { _id: 'partial-b', marker: 'partial' },
      { _id: 'partial-b', marker: 'partial' }, { _id: 'partial-c', marker: 'partial' },
    ]);
    const response = await write(owner, { confirm_token: token });
    assert.equal(response.ok, false);
    assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'partial' }), 2);
    assert.match(response.text, /2/);
    assert.match(response.text, /parzial|inserit|applicat/i);
    assert.equal((await write(owner, { confirm_token: token })).ok, false);
    const batch = must(await write(owner, { collection: undefined, operations: [
      { collection: 'orders_write', operation: 'insert', doc: [{ _id: 'batch-partial-first', marker: 'batch-partial' }] },
      { collection: 'orders_write', operation: 'insert', doc: [
        { _id: 'batch-partial-a', marker: 'batch-partial' }, { _id: 'batch-partial-b', marker: 'batch-partial' },
        { _id: 'batch-partial-b', marker: 'batch-partial' }, { _id: 'batch-partial-c', marker: 'batch-partial' },
      ] },
    ] }), 'anteprima bulk nel batch');
    const partialBatch = await write(owner, { confirm_token: batch.confirm_token });
    assert.equal(partialBatch.ok, false);
    assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'batch-partial' }), 3);
    assert.match(partialBatch.text, /1 operazioni su 2/);
    assert.match(partialBatch.text, /2 documenti/);
    assert.equal((await write(owner, { confirm_token: batch.confirm_token })).ok, false);
  });
  await check('MCP-019', 'Revoca capability tra anteprima e conferma impedisce la scrittura reale', async () => {
    const token = await preview(editor, { marker: 'revoked-grant' });
    try {
      must(await emit('grants:set', { ...editor.grant, role: 'viewer' }), 'riduzione grant');
      assert.equal((await write(editor, { confirm_token: token })).ok, false);
      assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'revoked-grant' }), 0);
      must(await query(editor, { filter: '{"_id":"order-1"}' }), 'lettura ancora autorizzata');
    } finally { must(await emit('grants:set', editor.grant), 'ripristino grant'); }
  });
  await check('MCP-020', 'Restrizione scope a caldo invalida una scrittura già preparata', async () => {
    const token = await preview(editor, { marker: 'revoked-scope' });
    try {
      must(await emit('grants:set', { ...editor.grant, scope: { databases: [DATA_DB], collections: ['orders_history'] } }), 'restrizione scope');
      assert.equal((await write(editor, { confirm_token: token })).ok, false);
      assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'revoked-scope' }), 0);
    } finally { must(await emit('grants:set', editor.grant), 'ripristino scope'); }
  });
  await check('MCP-021', 'Sola lettura della connessione applicata alle sessioni già aperte', async () => {
    const token = await preview(owner, { marker: 'revoked-readonly' });
    try {
      const ro = must(await call(owner, 'set_connection_read_only', { connection_name: CONN, read_only: true }), 'anteprima readonly');
      must(await call(owner, 'set_connection_read_only', { connection_name: CONN, confirm_token: ro.confirm_token }), 'conferma readonly');
      assert.equal((await write(owner, { confirm_token: token })).ok, false);
      assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'revoked-readonly' }), 0);
    } finally {
      const rw = must(await call(owner, 'set_connection_read_only', { connection_name: CONN, read_only: false }), 'anteprima scrivibile');
      must(await call(owner, 'set_connection_read_only', { connection_name: CONN, confirm_token: rw.confirm_token }), 'ripristino scrivibile');
    }
  });
  await check('MCP-022', 'Revoca API key rifiuta richieste sulla sessione esistente', async () => {
    must(await emit('apikeys:revoke', { id: viewer.keyId }), 'revoca chiave');
    for (const method of ['POST', 'GET', 'DELETE']) {
      assert.equal((await rpc(viewer.key, viewer.transport.sessionId, 'tools/list', method)).status, 401, method);
    }
  });
  await check('MCP-023', 'Sospensione utente invalida chiave e token in sospeso', async () => {
    const token = await preview(editor, { marker: 'suspended-user' });
    must(await emit('users:update', { id: editor.userId, status: 'suspended' }), 'sospensione');
    assert.equal((await rpc(editor.key, editor.transport.sessionId)).status, 401);
    await assert.rejects(() => write(editor, { confirm_token: token }), /401|non valida/i);
    assert.equal(await mongo.db(DATA_DB).collection('orders_write').countDocuments({ marker: 'suspended-user' }), 0);
  });
  await check('MCP-024', 'Chiavi API non persistono in chiaro né compaiono negli elenchi amministrativi', async () => {
    const keys = must(await emit('apikeys:list'), 'elenco chiavi');
    const stored = await mongo.db(APP_DB).collection('api_keys').find({}).toArray();
    for (const key of [owner.key, viewer.key, editor.key]) {
      assert.ok(!JSON.stringify(keys).includes(key));
      assert.ok(!JSON.stringify(stored).includes(key));
    }
  });
  await check('MCP-025', 'Terminazione esplicita invalida sessione e connessioni', async () => {
    const disposable = await connectClient(owner.key);
    disposable.cid = must(await call(disposable, 'connect_database', { saved: CONN }), 'connessione temporanea').connection_id;
    const sid = disposable.transport.sessionId;
    await disposable.transport.terminateSession();
    assert.equal((await rpc(owner.key, sid)).status, 400);
    assert.equal((await query(owner, { connection_id: disposable.cid })).ok, false);
  });
}

(async () => {
  const startedAt = new Date().toISOString();
  try { await run(); }
  catch (error) {
    results.push({ id: 'MCP-SETUP', label: 'Preparazione o esecuzione laboratorio', status: 'failed', error: error.stack || String(error) });
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(mcpClients.map(handle => handle.client.close()));
    ownerSocket?.close();
    await server?.stop();
    if (mongo) {
      try { await targets.cleanup(name => mongo.db(name).dropDatabase()); }
      catch (error) {
        results.push({ id: 'MCP-CLEANUP', label: 'Pulizia database del laboratorio', status: 'failed', error: error.stack || String(error) });
        process.exitCode = 1;
      }
      await mongo.close();
    }
    const report = { suite: 'mcp-rbac-reale', startedAt, finishedAt: new Date().toISOString(), mutant,
      environment: { mongo: MONGO_URI, serverPort: SERVER_PORT, databases: [APP_DB, DATA_DB, OTHER_DB] },
      passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, results };
    const reportPath = process.env.LAB_MCP_REPORT || path.join(process.env.LAB_REPORT_DIR || path.join(__dirname, '../../.scratch/lab-reports'), mutant ? 'mcp-mutant.json' : 'mcp.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`MCP laboratorio: ${report.passed} superati, ${report.failed} falliti. Report: ${reportPath}`);
  }
})();
