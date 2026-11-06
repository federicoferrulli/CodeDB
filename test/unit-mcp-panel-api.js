'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createModule, endpointOf, csv } = require('../server/eventi-mcp');
const { createSettings } = require('../mcp/Settings');
const { ROOT_PRINCIPAL } = require('../auth/principal');

module.exports = (async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-mcp-api-'));
  try {
    const settings = createSettings({ filePath: path.join(directory, 'settings.json') });
    const owner = { id: 'a', ownerId: 'a', owner: true, email: 'owner@tenant.test' };
    const sub = { id: 'sub', ownerId: 'a', grants: [{ connName: 'main', capabilities: ['read'] }] };
    const delegated = { id: 'admin', ownerId: 'a', tenantCapabilities: ['admin'], grants: [{ connName: 'main', capabilities: ['read'] }] };
    const ctx = { principal: owner };
    let entries = [
      { id: 'one', ownerId: 'a', userId: 'a', tool: 'execute_query', summary: '=HYPERLINK("untrusted")' },
      { id: 'two', ownerId: 'a', userId: 'sub', tool: 'list_databases' },
      { id: 'three', ownerId: 'b', userId: 'b', tool: 'execute_write' },
      { id: 'legacy', tool: 'execute_write' },
    ];
    const audit = [], closed = [], saved = [];
    let lastFilters;
    const control = {
      status: () => ({ state: 'active', auditHealth: { ok: true, lastError: 'private/path' },
        sessions: entries.map(entry => ({ ...entry, credentialFingerprint: 'segreto', connections: [{ name: 'main', dbType: 'mongodb', password: 'segreto' }] })),
      }),
      listActivity: async options => {
        lastFilters = options;
        const selected = entries.filter(entry => (!options.ownerId || entry.ownerId === options.ownerId) && (!options.userId || entry.userId === options.userId));
        return { entries: selected.slice(options.offset, options.offset + options.limit), total: selected.length, snapshot: 'snapshot', offset: options.offset, limit: options.limit };
      },
      getActivity: async id => entries.find(entry => entry.id === id),
      closeSession: async id => { closed.push(id); return { id, closed: true }; },
      recordAdmin: async entry => audit.push(entry),
    };
    const configs = {
      a: { main: { readOnly: 'true', dbType: 'mongodb' } },
      b: { private: { readOnly: 'false', dbType: 'mysql' } },
      local: { main: { readOnly: 'true', dbType: 'postgresql' } },
    };
    const registry = new Map();
    const config = { env: { CODEDB_OWNER_EMAIL: 'install@server.test' }, rbacOn: () => true };
    const transport = { server: { address: () => ({ address: '127.0.0.1', port: 41234 }) } };
    const identity = {
      assertManage(principal) { if (!principal.root && !principal.owner) throw new Error('Permesso negato'); },
      withConnectionAclLock: async (_ownerId, fn) => fn(),
    };
    createModule({ mcpControl: control, mcpSettings: settings, config, identita: identity, trasporto: transport,
      vault: {
        loadConnections: ownerId => JSON.parse(JSON.stringify(configs[ownerId] || {})),
        saveConnections: (value, ownerId) => { configs[ownerId] = value; saved.push(ownerId); },
        connLabel: () => 'Connessione', connDbType: value => value.dbType,
      },
    })(ctx, { amministrativo: (name, fn) => registry.set(name, fn) });
    const call = async (name, payload = {}) => {
      let result;
      await registry.get(name)(payload, value => { result = value; });
      return result;
    };

    let status = await call('mcp:status');
    assert.deepStrictEqual(status.sessions.map(entry => entry.id), ['one', 'two'], 'owner vede il proprio tenant');
    assert.strictEqual(status.endpoint, 'http://127.0.0.1:41234/mcp', 'porta effettiva del server');
    assert.strictEqual(status.permissions.manageSettings, false);
    assert.strictEqual(status.permissions.manageAccess, true);
    assert.strictEqual(status.auditHealth.lastError, undefined, 'percorsi globali riservati all’install admin');
    assert(!JSON.stringify(status.sessions).includes('segreto'), 'le sessioni non espongono credenziali');
    await assert.rejects(call('mcp:settings:update', { values: { enabled: false }, revision: 0 }), /amministratore/);

    let listed = await call('mcp:activity:list', { ownerId: 'b', userId: 'b' });
    assert.strictEqual(listed.total, 2, 'il tenant del payload non può sostituire quello autenticato');
    assert.strictEqual(lastFilters.ownerId, 'a');
    await call('mcp:activity:list', { transient: true });
    assert.strictEqual(lastFilters.transient, true, 'il polling non consuma snapshot dello storico');
    await assert.rejects(call('mcp:activity:list', { transient: 'true' }), /aggiornamento/);
    await assert.rejects(call('mcp:activity:get', { id: 'three' }), /non autorizzata/);
    await assert.rejects(call('mcp:activity:get', { id: 'legacy' }), /non autorizzata/);
    const exported = await call('mcp:activity:export', { format: 'json', ownerId: 'b', transient: true });
    assert.strictEqual(lastFilters.transient, false, 'l’export mantiene una fotografia stabile');
    assert.deepStrictEqual(JSON.parse(exported.content).map(entry => entry.id), ['one', 'two']);
    assert.strictEqual(exported.mimeType, 'application/json;charset=utf-8');
    assert((await call('mcp:activity:export', { format: 'csv' })).content.includes("'=HYPERLINK"), 'le formule CSV restano testo');
    await assert.rejects(call('mcp:activity:list', { limit: 1000000 }), /Paginazione/);
    await assert.rejects(call('mcp:activity:list', { from: 'invalid' }), /Data non valida/);
    await assert.rejects(call('mcp:activity:list', { from: '2026-12-01', to: '2026-01-01' }), /precedere/);

    let connections = await call('mcp:connections:list');
    assert.strictEqual(connections.connections[0].canManage, true);
    await call('mcp:connections:readonly', { name: 'main', readOnly: false });
    assert.deepStrictEqual(saved, ['a']);
    assert.strictEqual(configs.a.main.readOnly, 'false');
    await assert.rejects(call('mcp:connections:readonly', { name: 'private', readOnly: false }), /non autorizzata/);
    await assert.rejects(call('mcp:connections:readonly', { name: 'main', readOnly: 'false' }), /valido/);
    await assert.rejects(call('mcp:sessions:close', { id: 'three' }), /non autorizzata/);
    await call('mcp:sessions:close', { id: 'two' });
    assert.deepStrictEqual(closed, ['two']);
    let finishDrain, acknowledged = false;
    const immediateClose = control.closeSession;
    control.closeSession = async id => {
      await new Promise(resolve => { finishDrain = resolve; });
      return { closed: true, id };
    };
    const draining = call('mcp:sessions:close', { id: 'two' }).then(value => { acknowledged = true; return value; });
    await Promise.resolve();
    assert.strictEqual(acknowledged, false, 'la sessione occupata non è dichiarata chiusa prima del drenaggio');
    finishDrain();
    assert.strictEqual((await draining).closed, true);
    control.closeSession = immediateClose;

    ctx.principal = sub;
    status = await call('mcp:status');
    assert.deepStrictEqual(status.sessions.map(entry => entry.id), ['two']);
    assert.strictEqual(status.permissions.manageAccess, false);
    assert.strictEqual((await call('mcp:activity:list')).total, 1);
    await assert.rejects(call('mcp:activity:get', { id: 'one' }), /non autorizzata/);
    await assert.rejects(call('mcp:sessions:close', { id: 'one' }), /non autorizzata/);
    await assert.rejects(call('mcp:connections:readonly', { name: 'main', readOnly: false }), /Permesso negato/);
    connections = await call('mcp:connections:list');
    assert.strictEqual(connections.connections[0].permissions.write, false, 'il flag sola lettura non concede la capability write');

    ctx.principal = delegated;
    assert.strictEqual((await call('mcp:status')).permissions.manageAccess, true);
    await assert.rejects(call('mcp:settings:update', { values: { enabled: false }, revision: 0 }), /amministratore/);
    await assert.rejects(call('mcp:connections:readonly', { name: 'main', readOnly: false }), /Permesso negato/);

    ctx.principal = ROOT_PRINCIPAL;
    assert.strictEqual((await call('mcp:activity:list')).total, 4, 'root conserva accesso agli eventi legacy');
    const updated = await call('mcp:settings:update', { values: { enabled: false }, revision: 0 });
    assert.strictEqual(updated.values.enabled, false);
    assert.strictEqual(audit.at(-1).tool, 'mcp:settings:update');
    assert.strictEqual(audit.at(-1).ownerId, 'local');
    await assert.rejects(call('mcp:settings:update', { values: { enabled: true }, revision: 0 }), /modificate/);
    entries = [{ id: 'oversize', summary: 'a'.repeat(11 * 1024 * 1024) }];
    await assert.rejects(call('mcp:activity:export'), /oltre 10 MiB/);
    ctx.principal = {};
    await assert.rejects(call('mcp:activity:list'), /Identità MCP non valida/);

    assert.strictEqual(endpointOf(transport, { env: { CODEDB_TRUST_PROXY_TLS: '1' } }), null);
    assert.strictEqual(endpointOf(transport, { env: { CODEDB_PUBLIC_URL: 'https://example.test/codedb/' } }), 'https://example.test/codedb/mcp');
    assert.throws(() => endpointOf(transport, { env: { CODEDB_PUBLIC_URL: 'https://user:secret@example.test/' } }), /senza credenziali/);
    const { configurazione } = require('../server/configurazione');
    assert.throws(() => configurazione({ rootDir: directory, env: { CODEDB_PUBLIC_URL: 'file:///private' } }), /HTTP\(S\)/, 'URL pubblico validato prima dell’avvio');
    assert.throws(() => configurazione({ rootDir: directory, env: { CODEDB_PUBLIC_URL: 'not-a-url' } }), /valido/);
    assert(csv([{ summary: '\t=1+1' }]).includes("'\t=1+1"));
    console.log('  OK   MCP API: isolamento tenant/utente/legacy, gate amministrativi, export, sessioni, connessioni ed endpoint');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})();

if (require.main === module && process.argv.includes('--sensitivity')) {
  module.exports = module.exports.then(() => {
    const modulePath = require.resolve('../server/eventi-mcp');
    const original = fs.readFileSync(modulePath, 'utf8');
    const mutated = original.replace('if (principal.root) return {};', 'if (true) return {};');
    assert.notStrictEqual(original, mutated);
    const script = `const Module=require('module');const m=new Module(${JSON.stringify(modulePath)});m.filename=${JSON.stringify(modulePath)};m.paths=Module._nodeModulePaths(require('path').dirname(m.filename));require.cache[m.filename]=m;m._compile(${JSON.stringify(mutated)},m.filename);require(${JSON.stringify(__filename)});`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(child.status, 0, 'il test deve fallire rimuovendo il filtro tenant');
    assert.match(child.stderr, /AssertionError/, child.stderr);
    console.log('  OK   Sensibilità MCP API: mutante senza isolamento tenant rilevato');
  });
}
