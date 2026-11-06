'use strict';

// Il monitor si prova attraverso il protocollo reale: niente accesso ai log o
// alle configurazioni dell'utente, e strategie deterministiche senza database.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { attachMcp } = require('../mcp/McpGateway');
const { createActivity, sanitize, statusOf, boundedEntry } = require('../mcp/Activity');
const { makeAuditor } = require('../db/AuditLog');
const { makePrincipal } = require('../auth/principal');

module.exports = (async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-mcp-monitor-'));
  const file = path.join(directory, 'audit.log');
  const auditor = makeAuditor(file);
  let settings = {}, listener, readGate, writeGate, failInsert = false, mutations = 0, released = 0;
  const provider = { get: () => settings, subscribe(fn) { listener = fn; return () => { listener = null; }; } };
  const change = values => { settings = { ...settings, ...values }; listener(settings); };
  const strategy = {
    type: 'mongodb',
    async listDatabases() { return ['app']; },
    async dbSchema() { return { collections: [], relations: [] }; },
    async dropDatabase() { mutations++; },
    async collectionFind() { if (readGate) await readGate.promise; return { docs: [{ password: 'SEGRETO_RISULTATO' }], total: 1 }; },
    async docInsert() {
      if (writeGate) await writeGate.promise;
      mutations++;
      if (failInsert) { const error = new Error("Duplicate entry 'SEGRETO_ERRORE'"); error.auditResult = { insertedCount: 1 }; throw error; }
      return { insertedCount: 1 };
    },
  };
  const principals = Object.fromEntries(['A', 'B'].map(id => [`cdb_${id}`, makePrincipal({ _id: id, type: 'owner', ownerId: id, email: `${id}@esempio.it` })]));
  const app = express();
  const control = attachMcp(app, {
    auditStore: auditor, mcpSettings: provider,
    loadConnections: () => ({ comune: { readOnly: 'false' } }), connLabel: () => 'Test', connDbType: () => 'mongodb',
    establishConnection: async () => ({ strategy, effective: { readOnly: 'false' }, dbType: 'mongodb' }),
    teardownConnection: async () => { released++; }, tryAcquireGlobalSession: () => true, releaseGlobalSession() {},
    rbacOn: () => true, resolveApiKey: async key => principals[key] || null,
  });
  const server = http.createServer(app), clients = [];
  const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Condizione MCP non raggiunta'); await new Promise(r => setTimeout(r, 5)); }
  };
  let base;
  async function connect(tenant) {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer cdb_${tenant}` } } });
    const client = new Client({ name: `Client-${tenant}`, version: '1.0' });
    clients.push(client); await client.connect(transport);
    return { client, transport };
  }
  async function call(client, name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { ok: !result.isError, data: result.isError ? null : JSON.parse(result.content[0].text), error: result.content[0].text };
  }
  const list = filters => control.listActivity({ limit: 10000, ...filters });
  const latest = async (tool, filters = {}) => (await list({ tool, ...filters })).entries[0];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const a = await connect('A'), b = await connect('B');
    const ca = (await call(a.client, 'connect_database', { saved: 'comune' })).data.connection_id;
    const cb = (await call(b.client, 'connect_database', { saved: 'comune' })).data.connection_id;
    assert.equal(control.status().state, 'active');
    assert.equal(control.status().sessions.length, 2);
    await call(a.client, 'execute_query', { connection_id: ca, db: 'app', collection: 'persone', filter: '{"password":"SEGRETO_FILTRO"}' });
    await call(b.client, 'execute_query', { connection_id: cb, db: 'app', collection: 'persone' });
    const qa = await latest('execute_query', { ownerId: 'A' });
    assert.equal(qa.status, 'completed'); assert.equal(qa.connection, 'comune'); assert.equal(qa.db, 'app');
    assert.equal(qa.client.name, 'Client-A'); assert.equal(qa.userId, 'A'); assert.equal(qa.result.docsCount, 1);
    assert(qa.durationMs >= 0 && qa.finishedAt && qa.invocationId);
    assert.equal(await control.getActivity(qa.id, { ownerId: 'B' }), null, 'il dettaglio non deve aggirare il tenant');
    assert((await list({ ownerId: 'B' })).entries.every(e => e.ownerId === 'B'));
    assert.equal((await list({ ownerId: 'A', userId: 'B' })).total, 0);
    const page = await list({ ownerId: 'A', limit: 1 });
    await call(a.client, 'list_saved_connections');
    const frozen = await list({ ownerId: 'A', limit: 100, snapshot: page.snapshot });
    assert.equal(frozen.total, page.total); assert.equal(frozen.entries[0].id, page.entries[0].id);
    for (let i = 0; i < 24; i++) assert.equal((await list({ ownerId: 'A', transient: true })).snapshot, undefined);
    assert.equal((await list({ ownerId: 'A', snapshot: page.snapshot })).total, page.total, 'il polling non deve espellere le pagine stabili');
    await assert.rejects(list({ ownerId: 'B', snapshot: page.snapshot }), /non appartiene/);
    assert.equal((await list({ ownerId: 'A', from: new Date(Date.parse(qa.ts) - 1).toISOString(), to: new Date(Date.parse(qa.ts) + 1).toISOString(), tool: 'execute_query' })).total, 1);

    const invalid = await call(a.client, 'execute_query', { db: 'app' });
    assert.equal(invalid.ok, false); assert.equal((await latest('execute_query', { ownerId: 'A' })).status, 'rejected', 'anche il rifiuto dello schema SDK deve comparire');
    assert.match((await latest('execute_query', { ownerId: 'A' })).error, /Parametri della richiesta MCP non validi/);
    await call(a.client, 'execute_query', { connection_id: 'inesistente', db: 'app', collection: 'x' });
    assert.equal((await latest('execute_query', { ownerId: 'A' })).status, 'rejected');
    await a.client.readResource({ uri: `schema://${ca}/app` });
    assert.equal((await latest('resource:schema')).db, 'app');
    await a.client.getPrompt({ name: 'genera-report', arguments: { connessione: 'comune', db: 'app' } });
    assert.equal((await latest('prompt:genera-report')).status, 'completed');
    for (const category of ['connection', 'resource', 'prompt']) {
      const found = await list({ ownerId: 'A', category });
      assert(found.total > 0); assert(found.entries.every(e => e.category === category));
    }

    const parameters = { connection_id: ca, db: 'app', collection: 'persone', operation: 'insert', doc: '{"password":"SEGRETO_DOC","libero":"SEGRETO_LIBERO"}' };
    const preview = await call(a.client, 'execute_write', parameters);
    assert(preview.ok && preview.data.requires_confirmation); assert.equal(mutations, 0);
    const before = await latest('execute_write', { ownerId: 'A' });
    assert.equal(before.status, 'pending');
    const execution = await call(a.client, 'execute_write', { connection_id: ca, db: 'app', confirm_token: preview.data.confirm_token });
    assert(execution.ok); assert.equal(mutations, 1);
    const after = (await list({ ownerId: 'A', tool: 'execute_write' })).entries.find(e => e.id !== before.id && e.event === 'executed');
    assert(after); assert.equal(after.operationId, before.operationId); assert.notEqual(after.invocationId, before.invocationId);
    assert.equal((await control.getActivity(before.id, { ownerId: 'A' })).event, 'confirmed');
    assert.equal((await control.getActivity(before.id, { ownerId: 'A' })).status, 'confirmed', 'la conferma utilizzata non è una scrittura completata');

    failInsert = true;
    const partialPreview = await call(a.client, 'execute_write', parameters);
    await call(a.client, 'execute_write', { connection_id: ca, db: 'app', confirm_token: partialPreview.data.confirm_token });
    assert.equal((await latest('execute_write', { ownerId: 'A' })).status, 'partial');
    assert.equal((await latest('execute_write', { ownerId: 'A' })).result.insertedCount, 1);
    failInsert = false;
    assert.equal(statusOf({ rolledBack: true }, new Error('rollback')), 'rolled_back');
    assert.equal(statusOf({ status: 'intervento_richiesto' }), 'partial');
    assert.equal(statusOf({ status: 'ripristinato_dopo_errore' }), 'rolled_back');

    const ddlPreview = await call(a.client, 'execute_write', { connection_id: ca, db: 'da_eliminare', operation: 'drop_database' });
    assert.equal((await latest('execute_write', { ownerId: 'A' })).category, 'ddl');
    await call(a.client, 'execute_write', { connection_id: ca, db: 'da_eliminare', confirm_token: ddlPreview.data.confirm_token });
    assert.equal((await latest('execute_write', { ownerId: 'A' })).category, 'ddl', 'la conferma eredita la categoria dal piano');
    assert((await list({ ownerId: 'A', category: 'ddl' })).total >= 2);
    assert((await list({ ownerId: 'A', category: 'write' })).entries.some(e => e.category === 'ddl'), 'Scritture include il DDL');

    const blockedPreview = await call(a.client, 'execute_write', parameters);
    const countBeforeBlock = mutations;
    change({ readOnly: true });
    assert.equal((await call(a.client, 'execute_write', { connection_id: ca, db: 'app', confirm_token: blockedPreview.data.confirm_token })).ok, false, 'il cambio policy deve bloccare anche una conferma già emessa');
    assert.equal(mutations, countBeforeBlock);
    assert.equal((await call(a.client, 'execute_write', parameters)).ok, false);
    assert.equal((await latest('execute_write', { ownerId: 'A' })).status, 'rejected');
    change({ readOnly: false, allowDdl: false, allowBackup: false, allowImport: false });
    assert((await call(a.client, 'execute_write', { connection_id: ca, db: 'app', confirm_token: blockedPreview.data.confirm_token })).ok);
    assert.equal((await call(a.client, 'execute_write', { connection_id: ca, db: 'app', operation: 'drop_database' })).ok, false);
    assert.equal((await call(a.client, 'list_backups')).ok, false);
    assert.equal((await call(a.client, 'import_database_artifact', { connection_id: ca, target_db: 'app', artifact_json: '{}' })).ok, false);
    assert((await list({ ownerId: 'A', category: 'import' })).total > 0);
    assert((await list({ ownerId: 'A', category: 'write' })).entries.some(e => e.category === 'import'));
    assert((await list({ ownerId: 'A', category: 'backup' })).total > 0);
    change({ confirmTimeoutSeconds: 0.05, pendingPerPrincipal: 1 });
    const expire = await call(a.client, 'execute_write', parameters);
    assert.equal(expire.data.expires_in_seconds, 0.05);
    const expiring = await latest('execute_write', { ownerId: 'A' });
    assert.equal((await call(a.client, 'execute_write', parameters)).ok, false, 'la quota aggiornata vale subito');
    await new Promise(r => setTimeout(r, 80));
    assert.equal((await control.getActivity(expiring.id, { ownerId: 'A' })).status, 'expired');
    assert.equal(control.confirmQuota().global.count, 0);

    await auditor.audit({ event: 'executed', connection: 'legacy', ts: '2020-01-01T00:00:00Z' });
    assert(!(await list({ ownerId: 'A' })).entries.some(e => e.connection === 'legacy'));
    assert((await list()).entries.some(e => e.legacy));
    await auditor.audit({ id: 'interrotto', invocationId: 'interrotto', runtimeId: 'processo-precedente', ts: '2020-01-02T00:00:00Z', status: 'running', ownerId: 'A' });
    assert.equal((await control.getActivity('interrotto', { ownerId: 'A' })).status, 'unknown');

    change({ confirmTimeoutSeconds: 300 });
    readGate = pause();
    const reading = call(a.client, 'execute_query', { connection_id: ca, db: 'app', collection: 'persone' });
    await waitFor(() => control.status().sessions.some(s => s.activeRequests));
    const running = await latest('execute_query', { ownerId: 'A' }); assert.equal(running.status, 'running');
    const sessionA = control.status().sessions.find(s => s.ownerId === 'A');
    const closing = control.closeSession(sessionA.id);
    assert.equal(released, 0, 'chiudere non deve interrompere l’operazione accettata');
    await assert.rejects(call(a.client, 'list_saved_connections'), /409|chiusura/);
    readGate.resolve(); readGate = null; await reading; await closing;
    assert.equal(released, 1);

    const a2 = await connect('A');
    const ca2 = (await call(a2.client, 'connect_database', { saved: 'comune' })).data.connection_id;
    const p2 = await call(a2.client, 'execute_write', { ...parameters, connection_id: ca2 });
    writeGate = pause();
    const writing = call(a2.client, 'execute_write', { connection_id: ca2, db: 'app', confirm_token: p2.data.confirm_token });
    await waitFor(() => control.status().sessions.some(s => s.activeRequests));
    change({ enabled: false });
    assert.equal(control.status().state, 'draining'); assert.equal(released, 1);
    await assert.rejects(call(b.client, 'list_saved_connections'), /503|disattivato/);
    writeGate.resolve(); writeGate = null; assert((await writing).ok);
    await waitFor(() => control.status().state === 'disabled');
    assert.equal(control.status().sessions.length, 0); assert.equal(released, 3);
    change({ enabled: true }); assert.equal(control.status().state, 'active');
    const a3 = await connect('A'); assert((await call(a3.client, 'list_saved_connections')).ok);
    const terminatedId = a3.transport.sessionId;
    await a3.transport.terminateSession();
    assert(!control.status().sessions.some(s => s.id === terminatedId), 'DELETE senza body deve chiudere la sessione');
    assert.equal((await latest('mcp:disconnect', { ownerId: 'A' })).status, 'completed', 'la disconnessione via protocollo deve essere auditata');

    await auditor.flush();
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of ['SEGRETO_RISULTATO', 'SEGRETO_FILTRO', 'SEGRETO_DOC', 'SEGRETO_LIBERO', 'SEGRETO_ERRORE', preview.data.confirm_token, 'cdb_A']) assert(!text.includes(secret), `il log non deve contenere ${secret}`);
    const redacted = JSON.stringify(sanitize({ sql: 'SELECT $$SEGRETO_DOLLAR$$, "SEGRETO_DOUBLE", \'SEGRETO_SINGLE\' /* SEGRETO_COMMENT */', error: "Duplicate 'SEGRETO_ERROR'", token: 'SEGRETO_TOKEN' }));
    assert(!redacted.includes('SEGRETO_'));
    assert(!sanitize({ sql: "SELECT 'SEGRETO_" + 'x'.repeat(16000) }).sql.includes('SEGRETO_'), 'un literal incompleto oltre il tetto deve essere omesso prima del troncamento');
    const huge = boundedEntry({ id: 'grande', ownerId: 'A', status: 'partial', parameters: { operations: Array.from({ length: 100 }, () => ({ sql: 'SELECT ' + 'x'.repeat(8000) })) }, result: { insertedCount: 2, failedIndex: 1 } });
    assert(huge.truncated); assert(Buffer.byteLength(JSON.stringify(huge)) <= 65536);
    assert.equal(huge.result.insertedCount, 2); assert.equal(huge.ownerId, 'A'); assert.equal(huge.status, 'partial');
    const restored = createActivity(makeAuditor(file));
    assert((await restored.list({ ownerId: 'A' })).total > 0, 'lo storico deve sopravvivere a un riavvio');
    console.log('  OK   Monitor MCP: protocollo, audit completo, tenant, redazione, conferme, snapshot, chiusura e riattivazione');
  } finally {
    readGate?.resolve(); writeGate?.resolve();
    for (const client of clients) await client.close().catch(() => {});
    await control.shutdownMcp();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})();
