'use strict';

const { allowedConnections, can, canAdminTenant, isInstallAdmin } = require('../auth/permissions');
const { rigaCsv } = require('../db/csv');

const EXPORT_LIMIT = 10000;
const EXPORT_BYTES = 10 * 1024 * 1024;

function visibility(principal) {
  if (principal.root) return {};
  if (!principal.ownerId || !principal.id) throw new Error('Identità MCP non valida: accedi nuovamente.');
  return { ownerId: principal.ownerId, ...(principal.owner ? {} : { userId: principal.id }) };
}

function visible(entry, principal) {
  const scope = visibility(principal);
  return (!scope.ownerId || entry.ownerId === scope.ownerId) && (!scope.userId || entry.userId === scope.userId);
}

function filters(payload = {}) {
  const result = {};
  if (payload.transient !== undefined) {
    if (typeof payload.transient !== 'boolean') throw new Error('Modalità di aggiornamento MCP non valida.');
    result.transient = payload.transient;
  }
  for (const key of ['from', 'to', 'tool', 'connection', 'db', 'status', 'user', 'category', 'search', 'snapshot']) {
    if (payload[key] == null || payload[key] === '') continue;
    if (typeof payload[key] !== 'string' || payload[key].length > 512) throw new Error(`Filtro MCP non valido: ${key}.`);
    result[key] = payload[key];
  }
  for (const key of ['from', 'to']) if (result[key] && !Number.isFinite(Date.parse(result[key]))) throw new Error(`Data non valida: ${key}.`);
  if (result.from && result.to && Date.parse(result.from) > Date.parse(result.to)) throw new Error('La data iniziale deve precedere la data finale.');
  for (const [key, max, fallback] of [['limit', 500, 50], ['offset', 1000000, 0]]) {
    const value = payload[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) throw new Error(`Paginazione MCP non valida: ${key}.`);
    result[key] = value;
  }
  return result;
}

function endpointOf(trasporto, config) {
  if (config.env.CODEDB_PUBLIC_URL) {
    const url = new URL(config.env.CODEDB_PUBLIC_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('CODEDB_PUBLIC_URL deve essere un URL HTTP(S) senza credenziali, query o frammenti.');
    return url.href.replace(/\/$/, '') + '/mcp';
  }
  if (String(config.env.CODEDB_TRUST_PROXY_TLS || '') === '1') return null;
  const address = trasporto.server.address();
  if (!address || typeof address === 'string' || ['0.0.0.0', '::'].includes(address.address)) return null;
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}/mcp`;
}

function csv(entries) {
  const fields = ['id', 'ts', 'tool', 'category', 'status', 'connection', 'db', 'user', 'client', 'durationMs', 'summary', 'error'];
  const row = values => rigaCsv(values.map(value => value && typeof value === 'object' ? JSON.stringify(value) : value));
  return '\uFEFF' + [row(fields), ...entries.map(entry => row(fields.map(key => entry[key])))].join('\r\n');
}

function createModule({ mcpControl, mcpSettings, config, identita, vault, trasporto }) {
  function registra(ctx, lifecycle) {
    const actor = () => ({ ownerId: ctx.principal.ownerId, userId: ctx.principal.id, user: ctx.principal.email || ctx.principal.displayName || null });
    const permissions = () => ({ manageSettings: isInstallAdmin(ctx.principal, config.env), manageAccess: canAdminTenant(ctx.principal) });
    const sessions = () => mcpControl.status().sessions.filter(entry => visible(entry, ctx.principal)).map(entry => ({
      id: entry.id, ownerId: entry.ownerId, userId: entry.userId, user: entry.user, client: entry.client,
      startedAt: entry.startedAt, lastActivity: entry.lastActivity, activeRequests: entry.activeRequests,
      connections: (entry.connections || []).map(connection => ({ name: connection.name, dbType: connection.dbType })), canClose: true,
    }));

    lifecycle.amministrativo('mcp:status', async (_payload, cb) => {
      const state = mcpControl.status();
      cb({ ok: true, state: state.state, endpoint: endpointOf(trasporto, config), rbac: config.rbacOn(), permissions: permissions(),
        sessions: sessions(), auditHealth: permissions().manageSettings ? state.auditHealth : { ok: !!state.auditHealth?.ok },
      });
    });

    lifecycle.amministrativo('mcp:settings:get', (_payload, cb) => {
      const result = mcpSettings.snapshot();
      if (!permissions().manageSettings && result.applyError) result.applyError = 'Applicazione delle impostazioni MCP incompleta: contatta l’amministratore dell’installazione.';
      cb({ ok: true, ...result });
    });

    lifecycle.amministrativo('mcp:settings:update', async ({ values, revision }, cb) => {
      if (!permissions().manageSettings) throw new Error('Le impostazioni MCP riguardano l’intera installazione: solo il suo amministratore può modificarle.');
      const before = mcpSettings.get();
      const result = await mcpSettings.update(values, revision);
      const changes = Object.fromEntries(Object.keys(result.values).filter(key => before[key] !== result.values[key]).map(key => [key, { prima: before[key], dopo: result.values[key] }]));
      await mcpControl.recordAdmin({ ...actor(), tool: 'mcp:settings:update', category: 'admin', status: result.applied === false ? 'partial' : 'completed',
        summary: result.applied === false ? 'Impostazioni MCP salvate con applicazione incompleta' : 'Impostazioni MCP aggiornate', result: { changes }, error: result.applyError || undefined });
      cb({ ok: true, ...result });
    });

    lifecycle.amministrativo('mcp:activity:list', async (payload, cb) => {
      const result = await mcpControl.listActivity({ ...filters(payload), ...visibility(ctx.principal) });
      if (result.entries.some(entry => !visible(entry, ctx.principal))) throw new Error('Registro MCP non disponibile: isolamento delle attività non verificato.');
      cb({ ok: true, ...result });
    });

    lifecycle.amministrativo('mcp:activity:get', async ({ id }, cb) => {
      if (typeof id !== 'string' || id.length > 512) throw new Error('Identificativo dell’attività non valido.');
      const entry = await mcpControl.getActivity(id, visibility(ctx.principal));
      if (!entry || !visible(entry, ctx.principal)) throw new Error('Attività non disponibile o non autorizzata.');
      cb({ ok: true, entry });
    });

    lifecycle.amministrativo('mcp:activity:export', async (payload, cb) => {
      const format = payload.format || 'json';
      if (!['json', 'csv'].includes(format)) throw new Error('Formato non valido: scegli JSON o CSV.');
      const result = await mcpControl.listActivity({ ...filters(payload), ...visibility(ctx.principal), offset: 0, limit: EXPORT_LIMIT, transient: false });
      if (result.entries.some(entry => !visible(entry, ctx.principal))) throw new Error('Esportazione MCP non autorizzata.');
      const content = format === 'csv' ? csv(result.entries) : JSON.stringify(result.entries, null, 2);
      if (Buffer.byteLength(content, 'utf8') > EXPORT_BYTES) throw new Error('Esportazione oltre 10 MiB: restringi il periodo o i filtri e riprova.');
      cb({ ok: true, content, filename: `attivita-mcp-${new Date().toISOString().slice(0, 10)}.${format}`,
        mimeType: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
        total: result.total, exported: result.entries.length, truncated: !!result.truncated || result.total > result.entries.length, snapshot: result.snapshot,
      });
    });

    lifecycle.amministrativo('mcp:sessions:close', async ({ id }, cb) => {
      if (typeof id !== 'string' || !sessions().some(entry => entry.id === id)) throw new Error('Sessione MCP non disponibile o non autorizzata.');
      const result = await mcpControl.closeSession(id);
      await mcpControl.recordAdmin({ ...actor(), tool: 'mcp:sessions:close', sessionId: id, category: 'admin', status: 'completed', summary: 'Sessione MCP chiusa', result: { closed: true } });
      cb({ ok: true, ...result });
    });

    lifecycle.amministrativo('mcp:connections:list', (_payload, cb) => {
      const all = vault.loadConnections(ctx.principal.ownerId);
      const settings = mcpSettings.get();
      const connections = allowedConnections(ctx.principal, Object.keys(all)).map(name => {
        const readOnly = String(all[name].readOnly ?? '').trim().toLowerCase() !== 'false';
        return { name, label: vault.connLabel(all[name]), dbType: vault.connDbType(all[name]), readOnly,
          canManage: !!(ctx.principal.root || ctx.principal.owner),
          permissions: { read: can(ctx.principal, { connName: name, capability: 'read' }),
            write: !settings.readOnly && !readOnly && can(ctx.principal, { connName: name, capability: 'write' }),
            ddl: !settings.readOnly && !readOnly && settings.allowDdl && can(ctx.principal, { connName: name, capability: 'ddl' }),
          },
        };
      });
      cb({ ok: true, connections });
    });

    lifecycle.amministrativo('mcp:connections:readonly', async ({ name, readOnly }, cb) => {
      identita.assertManage(ctx.principal);
      if (typeof name !== 'string' || !name.trim() || typeof readOnly !== 'boolean') throw new Error('Indica una connessione e un valore di sola lettura valido.');
      await identita.withConnectionAclLock(ctx.principal.ownerId, async () => {
        const all = vault.loadConnections(ctx.principal.ownerId);
        if (!Object.hasOwn(all, name) || !allowedConnections(ctx.principal, [name]).includes(name)) throw new Error('Connessione non disponibile o non autorizzata.');
        all[name].readOnly = String(readOnly);
        await vault.saveConnections(all, ctx.principal.ownerId);
      });
      await mcpControl.recordAdmin({ ...actor(), tool: 'mcp:connections:readonly', connection: name, category: 'admin', status: 'completed',
        summary: readOnly ? 'Connessione impostata in sola lettura' : 'Scritture abilitate sulla connessione', result: { readOnly } });
      cb({ ok: true, name, readOnly });
    });
  }
  return registra;
}

module.exports = { createModule, visibility, filters, endpointOf, csv };
