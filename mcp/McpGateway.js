'use strict';

/* Gateway MCP (Streamable HTTP su /mcp): autenticazione API key, ciclo di vita sessioni,
 * orchestrazione di strumenti (lettura, scrittura, artefatti), risorse e prompt. */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { hostConsentito } = require('../server/esposizione');

const { makeAuditor } = require('../db/AuditLog');
const { ConfirmQuota } = require('./ConfirmQuota');
const { DEFAULTS: MCP_DEFAULTS } = require('./Settings');
const { createActivity, sanitize: sanitizeActivity, categoryOf } = require('./Activity');
const { backupRootFor } = require('../backup/lib/policy');
const { ROOT_PRINCIPAL, rbacOn } = require('../auth/principal');

const {
  errMsg, errorResult,
  assertReadOnlySql, hasTopLevelSqlKeyword, assertWriteSql, assertDdlSql, assertReadOnlyPipeline,
} = require('./guardie');

// SDK MCP e moduli strumenti caricati pigramente alla prima sessione /mcp.
let _mcpRuntime = null;
const caricaRuntimeMcp = () => (_mcpRuntime ||= {
  McpServer: require('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  StreamableHTTPServerTransport: require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport,
  isInitializeRequest: require('@modelcontextprotocol/sdk/types.js').isInitializeRequest,
  ...require('./conferma'), ...require('./risorse-e-prompt'), ...require('./strumenti-lettura'),
  ...require('./strumenti-scrittura'), ...require('./strumenti-artefatti'),
});
const resolveBackupSelection = (...a) => require('./strumenti-artefatti').resolveBackupSelection(...a);
const backupVerificationPayload = (...a) => require('./strumenti-artefatti').backupVerificationPayload(...a);

const MCP_PATH = '/mcp';
const SWEEP_INTERVAL_MS = 60 * 1000;

function sessionPrincipal(session) {
  return (session && session.principal) || ROOT_PRINCIPAL;
}

function credentialFingerprint(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey || ''), 'utf8').digest();
}

function sameCredentialFingerprint(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sameMcpIdentity(session, principal, fingerprint) {
  return !!session && !!principal
    && sessionPrincipal(session).id === principal.id
    && sameCredentialFingerprint(session.credentialFingerprint, fingerprint);
}

// Propaga il principal risolto a ogni richiesta HTTP ai guardCtx già aperti,
// rendendo immediate revoche di grant e cambi di scope senza riconnessione DB.
function refreshSessionPrincipal(session, principal) {
  if (!session || !principal) return;
  session.principal = principal;
  if (!session.dbSessions || typeof session.dbSessions.values !== 'function') return;
  for (const dbSess of session.dbSessions.values()) {
    if (dbSess && dbSess.guardCtx) dbSess.guardCtx.principal = principal;
  }
}

function scrittureConsentiteDaConfig(cfg, deps) {
  const flag = cfg && cfg.readOnly;
  return !deps.mcpSettings?.get().readOnly && !!cfg && String(flag == null ? '' : flag).trim().toLowerCase() === 'false';
}

// Rilegge `readOnly` dal file connessioni prima di ogni operazione distruttiva,
// così la revoca è effettiva subito anche sulle dbSession MCP già aperte.
function refreshWritesAllowed(session, dbSess, deps) {
  if (!dbSess || !deps || typeof deps.loadConnections !== 'function') return false;
  const all = deps.loadConnections(sessionPrincipal(session).ownerId) || {};
  const allowed = scrittureConsentiteDaConfig(all[dbSess.name], deps);
  dbSess.writesAllowed = allowed;
  return allowed;
}

function buildMcpServer(session, deps) {
  const { McpServer, creaFlussoConferma, registraRisorseEPrompt, registraStrumentiLettura, registraStrumentiScrittura, registraStrumentiArtefatti } = caricaRuntimeMcp();
  const env = deps.env || process.env;
  const backupRootOf = current => backupRootFor(
    env.CODEDB_BACKUPS_DIR || path.join(__dirname, '..', 'backups'),
    sessionPrincipal(current).ownerId, { rbac: deps.rbacOn ? deps.rbacOn() : rbacOn() },
  );
  const audit = deps.activity ? entry => {
    deps.activity.legacy(entry);
    deps.audit?.(sanitizeActivity(entry));
  } : deps.audit || makeAuditor(env.CODEDB_MCP_AUDIT_FILE || path.join(__dirname, '..', 'mcp-audit.log')).audit;

  const server = new McpServer(
    { name: 'CodeDB-mcp', version: require('../package.json').version },
    {
      instructions:
        'Gateway verso i database (MongoDB, MySQL e PostgreSQL) gestiti da CodeDB. ' +
        'Flusso tipico: list_saved_connections → connect_database → get_databases_and_collections ' +
        '→ get_schema → execute_query. Chiudi le connessioni con disconnect_database quando hai finito. ' +
        'Strumenti analitici avanzati: get_shortest_path (cammino di relazioni tra tabelle), analyze_dependencies (matrice dipendenze e seeding order), ' +
        'analyze_pii (scansione privacy GDPR), audit_schema (diagnostica salute e tabelle orfane), filter_empty_tables (tabelle vuote). ' +
        'La risorsa schema://{connection_id}/{db} fornisce UML Mermaid e dizionario dati sempre aggiornati; ' +
        'i prompt genera-report, esplora-database, analizza-gdpr e diagnostica-schema guidano i flussi ricorrenti. ' +
        'Backup e ripristino: backup_database (full/incremental/differential), list_backups e restore_backup ' +
        '(il restore richiede una connessione con readOnly=false e la conferma esplicita dell\'utente umano).',
    }
  );

  const tool = (name, config, handler) => {
    server.registerTool(name, config, async (args = {}) => {
      try {
        const ctx = deps.activity?.context();
        if (ctx) { ctx.invoked = true; ctx.entry.summary = config.title || name; }
        deps.activity?.describe(session, args);
        const settings = { ...MCP_DEFAULTS, ...deps.mcpSettings?.get() };
        const pending = args.confirm_token && session.pendingWrites.get(args.confirm_token);
        if (ctx) ctx.entry.category = categoryOf(name, pending?.summary || args);
        const operations = pending?.summary?.operations || args.operations || [pending?.summary || args];
        const ddl = name === 'execute_ddl' || name === 'execute_write' && operations.some(op => /^drop_/.test(op.operation || ''));
        const mutates = ['execute_write', 'execute_ddl', 'restore_backup', 'import_database_artifact'].includes(name)
          || name === 'set_connection_read_only' && (pending ? !pending.readOnly : args.read_only === false);
        if (settings.readOnly && mutates) throw new Error('Il gateway MCP è in sola lettura: questa operazione non è consentita.');
        if (ddl && !settings.allowDdl) throw new Error('Le operazioni DDL sono disabilitate nelle impostazioni MCP.');
        if (['backup_database', 'list_backups', 'verify_backup', 'restore_backup'].includes(name) && !settings.allowBackup) throw new Error('Backup e ripristino sono disabilitati nelle impostazioni MCP.');
        if (['restore_backup', 'import_database_artifact'].includes(name) && !settings.allowImport) throw new Error('Importazione e ripristino sono disabilitati nelle impostazioni MCP.');
        const result = await handler(args);
        let payload;
        try { payload = JSON.parse(result?.content?.[0]?.text); } catch { payload = result; }
        deps.activity?.outcome(payload);
        return result;
      } catch (err) {
        deps.activity?.outcome(err.auditResult, { message: errMsg(err) });
        return errorResult(err);
      }
    });
  };

  const requireDbSession = (connectionId) => {
    const sess = session.dbSessions.get(String(connectionId || ''));
    if (!sess) throw new Error('connection_id sconosciuto o connessione già chiusa: apri prima una connessione con connect_database.');
    return sess;
  };

  const confirmFlow = creaFlussoConferma({ session, deps, sessionPrincipal });
  const sharedCtx = {
    server, tool, session, deps, env, audit, confirmFlow, backupRootOf,
    requireDbSession, sessionPrincipal, refreshWritesAllowed, scrittureConsentiteDaConfig,
  };

  registraStrumentiLettura(sharedCtx);
  registraStrumentiScrittura(sharedCtx);
  registraStrumentiArtefatti(sharedCtx);
  registraRisorseEPrompt(sharedCtx);

  return server;
}

/**
 * Monta l'endpoint MCP su `app`. `deps` arriva da server.js:
 * { loadConnections, connLabel, connDbType, establishConnection,
 *   teardownConnection, tryAcquireGlobalSession, releaseGlobalSession }
 */
function attachMcp(app, deps) {
  const env = deps.env || process.env;
  const memory = [], memorySizes = [];
  let memoryBytes = 0;
  const auditStore = deps.auditStore || (deps.audit ? {
    audit: entry => {
      const sz = Buffer.byteLength(JSON.stringify(entry) || '');
      memory.push(entry); memorySizes.push(sz); memoryBytes += sz;
      while (memory.length > 50000 || (memoryBytes > 16 * 1024 * 1024 && memory.length > 1)) { memory.shift(); memoryBytes -= memorySizes.shift(); }
    },
    flush: async () => {}, statoSalute: () => ({ ok: true, pending: 0 }),
    readRecent: ({ limit }) => ({ entries: memory.slice(-limit).reverse(), total: memory.length }),
  } : makeAuditor(env.CODEDB_MCP_AUDIT_FILE || path.join(__dirname, '..', 'mcp-audit.log')));
  const activity = createActivity(auditStore);
  let settings = { ...MCP_DEFAULTS, ...deps.mcpSettings?.get() };
  const settingsProvider = { get: () => settings };
  const pendingRequests = new Set();
  let closing = false;
  let shutdown;
  let drain;
  let runtimeState = settings.enabled ? 'active' : 'disabled';

  /** @type {Map<string, any>} */
  const mcpSessions = new Map();
  const confirmQuota = deps.confirmQuota || new ConfirmQuota();
  const runtimeDeps = { ...deps, activity, mcpSettings: settingsProvider, confirmQuota };

  function rpcError(code, message) {
    return { jsonrpc: '2.0', error: { code, message }, id: null };
  }

  function beginShutdown() {
    closing = true;
    runtimeState = 'draining';
    for (const session of mcpSessions.values()) session.transport.closeStandaloneSSEStream?.();
  }

  function tracked(handler) {
    return (req, res) => {
      if (closing || runtimeState !== 'active') return activity.request(req, res, () => {
        res.status(503).json(rpcError(-32000, closing ? 'Server in arresto.' : 'Gateway MCP disattivato o in fase di arresto.'));
      });
      const work = Promise.resolve().then(() => activity.request(req, res, async () => {
        try { await handler(req, res); }
        catch (err) {
          activity.outcome(undefined, err);
          if (!res.headersSent) res.status(500).json(rpcError(-32603, errMsg(err)));
        }
      }));
      pendingRequests.add(work);
      work.then(() => pendingRequests.delete(work), () => pendingRequests.delete(work));
      return work;
    };
  }

  async function destroyMcpSession(session, { closeTransport = true } = {}) {
    if (session.destroyed) return;
    session.destroyed = true;
    if (session.id) mcpSessions.delete(session.id);
    if (session.pendingWrites) {
      for (const pending of session.pendingWrites.values()) {
        if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
        confirmQuota.release(pending.reservation);
        activity.expire(pending);
      }
      session.pendingWrites.clear();
    }
    for (const [connId, dbSess] of [...session.dbSessions]) {
      session.dbSessions.delete(connId);
      deps.releaseGlobalSession();
      await Promise.resolve(deps.teardownConnection(dbSess)).catch(() => {});
    }
    if (closeTransport) {
      await Promise.resolve(session.transport.close()).catch(() => {});
    }
  }

  async function closeSession(id) {
    const session = mcpSessions.get(String(id));
    if (!session) return { closed: true, id };
    session.closing = true;
    session.transport.closeStandaloneSSEStream?.();
    if (!session.closePromise) session.closePromise = (async () => {
      if (session.activeRequests) await new Promise(resolve => session.idleWaiters.push(resolve));
      await destroyMcpSession(session);
      return { closed: true, id };
    })();
    return session.closePromise;
  }

  async function serveSession(session, req, res) {
    if (session.closing) return res.status(409).json(rpcError(-32000, 'La sessione MCP è in chiusura.'));
    session.lastActivity = Date.now();
    session.activeRequests += 1;
    let args = req.body?.params?.arguments || {};
    if (req.body?.method === 'resources/read') {
      try { const uri = new URL(req.body.params.uri); args = { connectionId: uri.hostname, db: decodeURIComponent(uri.pathname.slice(1)) }; } catch { /* la validazione resta all'SDK */ }
    }
    activity.started(session, args);
    try { await session.transport.handleRequest(req, res, req.body); }
    finally {
      if (activity.context()) activity.context().entry.sessionId = session.id;
      session.activeRequests -= 1;
      session.lastActivity = Date.now();
      if (!session.activeRequests) for (const resolve of session.idleWaiters.splice(0)) resolve();
    }
  }

  function startDrain() {
    runtimeState = 'draining';
    for (const session of mcpSessions.values()) session.transport.closeStandaloneSSEStream?.();
    if (!drain) drain = (async () => {
      while (pendingRequests.size) await Promise.allSettled([...pendingRequests]);
      await Promise.all([...mcpSessions.keys()].map(closeSession));
      await auditStore.flush();
    })().finally(() => { drain = null; runtimeState = !closing && settings.enabled ? 'active' : 'disabled'; });
    return drain;
  }

  function applySettings(value) {
    settings = { ...MCP_DEFAULTS, ...value };
    confirmQuota.updateLimits({
      principalCount: settings.pendingPerPrincipal, globalCount: settings.pendingGlobal,
      principalBytes: settings.pendingBytesPerPrincipalMiB * 1048576, globalBytes: settings.pendingBytesGlobalMiB * 1048576,
    });
    auditStore.updateOptions?.({ maxBytes: settings.auditMaxMiB * 1048576, maxGenerations: settings.auditGenerations });
    if (!settings.enabled && runtimeState === 'active') startDrain().catch(() => {});
    else if (settings.enabled && runtimeState === 'disabled' && !closing) runtimeState = 'active';
  }
  applySettings(settings);
  const unsubscribe = deps.mcpSettings?.subscribe(applySettings);

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const session of [...mcpSessions.values()]) {
      if (!session.activeRequests && now - session.lastActivity > settings.idleTimeoutMinutes * 60000) closeSession(session.id).catch(() => {});
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  function shutdownMcp() {
    beginShutdown();
    return shutdown ||= (async () => {
      clearInterval(sweepTimer);
      unsubscribe?.();
      await startDrain();
    })();
  }

  // Anti DNS-rebinding sul bind locale.
  function guardHost(req, res) {
    if (hostConsentito(env, String(req.headers.host || ''))) return true;
    res.status(403).json(rpcError(-32000, 'Host header non consentito.'));
    return false;
  }

  function apiKeyFromRequest(req) {
    const auth = String(req.headers.authorization || '');
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    return String(req.headers['x-api-key'] || '').trim();
  }

  async function authenticate(req, res) {
    if (!deps.rbacOn || !deps.rbacOn()) {
      return { principal: ROOT_PRINCIPAL, credentialFingerprint: null };
    }
    const rawKey = apiKeyFromRequest(req);
    const principal = await deps.resolveApiKey(rawKey);
    if (!principal) {
      res.status(401).json(rpcError(-32000, 'API key mancante o non valida: passa "Authorization: Bearer <api key>" (creala dal pannello di amministrazione di CodeDB).'));
      return null;
    }
    return { principal, credentialFingerprint: credentialFingerprint(rawKey) };
  }

  const mcpBodyLimit = String(env.CODEDB_MCP_MAX_BODY || '50mb').trim() || '50mb';
  const parseMcpJson = express.json({ limit: mcpBodyLimit });

  // Controllo stato, Host e autenticazione PRIMA di leggere o parsare il body JSON
  // (limite 50 MB): evita che client non autenticati impegnino RAM/CPU prima del 401/403.
  function preAuthPostMcp(req, res, next) {
    if (closing || runtimeState !== 'active') {
      res.status(503).json(rpcError(-32000, closing ? 'Server in arresto.' : 'Gateway MCP disattivato o in fase di arresto.'));
      return;
    }
    const work = Promise.resolve().then(async () => {
      try {
        if (!guardHost(req, res)) return;
        const auth = await authenticate(req, res);
        if (!auth) return;
        req.mcpAuth = auth;
        next();
      } catch (err) {
        if (!res.headersSent) res.status(500).json(rpcError(-32603, errMsg(err)));
      }
    });
    pendingRequests.add(work);
    work.then(() => pendingRequests.delete(work), () => pendingRequests.delete(work));
  }

  function parsePostBodyMcp(req, res, next) {
    parseMcpJson(req, res, (err) => {
      if (!err) return next();
      const status = (err.status || err.statusCode) === 413 ? 413 : 400;
      const msg = status === 413
        ? 'Payload MCP oltre il limite consentito (50 MB).'
        : 'Corpo JSON MCP non valido.';
      if (!res.headersSent) res.status(status).json(rpcError(-32700, msg));
    });
  }

  app.post(MCP_PATH, preAuthPostMcp, parsePostBodyMcp, tracked(async (req, res) => {
    const auth = req.mcpAuth || await authenticate(req, res);
    if (!auth) return;
    const { principal, credentialFingerprint: requestFingerprint } = auth;
    activity.describe({ principal }, req.body?.params?.arguments || {});
    try {
      const sid = req.headers['mcp-session-id'];
      const existing = sid ? mcpSessions.get(String(sid)) : undefined;
      if (existing) {
        if (!sameMcpIdentity(existing, principal, requestFingerprint)) {
          res.status(403).json(rpcError(-32000, 'Questa sessione MCP appartiene a un altro utente o a un’altra API key: reinizializza la connessione.'));
          return;
        }
        refreshSessionPrincipal(existing, principal);
        await serveSession(existing, req, res);
        return;
      }
      const { isInitializeRequest, StreamableHTTPServerTransport } = caricaRuntimeMcp();
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json(rpcError(-32000, 'Sessione MCP assente o scaduta: reinizializza la connessione.'));
        return;
      }
      if (mcpSessions.size >= settings.maxSessions) {
        res.status(503).json(rpcError(-32000, `Raggiunto il limite di ${settings.maxSessions} sessioni MCP contemporanee.`));
        return;
      }

      const session = {
        id: null,
        transport: null,
        principal,
        credentialFingerprint: requestFingerprint,
        dbSessions: new Map(),
        pendingWrites: new Map(),
        client: sanitizeActivity(req.body?.params?.clientInfo || null),
        startedAt: new Date().toISOString(), activeRequests: 0, idleWaiters: [],
        lastActivity: Date.now(),
        destroyed: false,
      };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSid) => {
          session.id = newSid;
          mcpSessions.set(newSid, session);
        },
      });
      session.transport = transport;
      transport.onclose = () => { closeSession(session.id).catch(() => {}); };
      await buildMcpServer(session, runtimeDeps).connect(transport);
      await serveSession(session, req, res);
    } catch (err) {
      activity.outcome(undefined, err);
      if (!res.headersSent) res.status(500).json(rpcError(-32603, errMsg(err)));
    }
  }));

  const handleSessionRequest = async (req, res) => {
    if (!guardHost(req, res)) return;
    const auth = await authenticate(req, res);
    if (!auth) return;
    if (closing && req.method === 'GET') return res.status(503).json(rpcError(-32000, 'Server in arresto.'));
    const { principal, credentialFingerprint: requestFingerprint } = auth;
    const sid = req.headers['mcp-session-id'];
    const session = sid ? mcpSessions.get(String(sid)) : undefined;
    if (!session) {
      res.status(400).json(rpcError(-32000, 'Sessione MCP non valida o scaduta.'));
      return;
    }
    if (!sameMcpIdentity(session, principal, requestFingerprint)) {
      res.status(403).json(rpcError(-32000, 'Questa sessione MCP appartiene a un altro utente o a un’altra API key.'));
      return;
    }
    refreshSessionPrincipal(session, principal);
    session.lastActivity = Date.now();
    activity.started(session, {});
    if (req.method === 'DELETE') {
      await closeSession(session.id);
      res.status(200).end();
      return;
    }
    if (session.closing) return res.status(409).json(rpcError(-32000, 'La sessione MCP è in chiusura.'));
    try {
      await session.transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json(rpcError(-32603, errMsg(err)));
    }
  };
  app.get(MCP_PATH, tracked(handleSessionRequest));
  app.delete(MCP_PATH, tracked(handleSessionRequest));

  return {
    beginShutdown, shutdownMcp, mcpSessions, auditHealth: auditStore.statoSalute,
    confirmQuota: () => confirmQuota.snapshot(),
    status: () => ({ state: runtimeState, auditHealth: auditStore.statoSalute(), sessions: [...mcpSessions.values()].map(session => ({
      id: session.id, ownerId: session.principal?.ownerId, userId: session.principal?.id,
      user: session.principal?.email || session.principal?.displayName || null,
      client: session.client, startedAt: session.startedAt, lastActivity: new Date(session.lastActivity).toISOString(),
      activeRequests: session.activeRequests, closing: !!session.closing,
      connections: [...session.dbSessions.values()].map(conn => ({ name: conn.name, dbType: conn.dbType })),
    })) }),
    listActivity: activity.list, getActivity: activity.get, recordAdmin: activity.admin, closeSession,
  };
}

module.exports = {
  attachMcp, assertReadOnlySql, assertWriteSql, assertDdlSql, assertReadOnlyPipeline,
  refreshSessionPrincipal, refreshWritesAllowed, credentialFingerprint, sameMcpIdentity,
  backupVerificationPayload, resolveBackupSelection, hasTopLevelSqlKeyword, MCP_PATH,
};
