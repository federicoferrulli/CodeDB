'use strict';

// Un'invocazione conserva lo stesso ID dall'avvio all'esito: il file resta
// append-only, mentre la lettura ricompone l'ultima ricevuta di ogni attività.
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SECRET = /password|passwd|passphrase|secret|token|authorization|api.?key|credential|private.?key|artifact_json/i;
const MAX_ENTRIES = 50000;
const SNAPSHOT_BYTES = 8 * 1048576;
const TOTAL_SNAPSHOT_BYTES = 32 * 1048576;
const PARAMETER_NAMES = new Set(['connection_id', 'connectionId', 'saved', 'connection_name', 'connessione', 'db', 'target_db', 'collection', 'coll', 'operation', 'operations', 'sql', 'query', 'doc', 'filter', 'filtro', 'set', 'pipeline', 'sort', 'projection', 'limit', 'skip', 'read_only', 'upsert', 'type', 'group', 'backup_id', 'drop', 'collections', 'uri', 'include_implicit', 'from', 'to', 'max_depth', 'min_confidence']);

function categoryOf(tool, args = {}) {
  if (tool.startsWith('resource:')) return 'resource';
  if (tool.startsWith('prompt:')) return 'prompt';
  if (['connect_database', 'disconnect_database', 'list_saved_connections', 'mcp:initialize', 'mcp:disconnect'].includes(tool)) return 'connection';
  if (['restore_backup', 'import_database_artifact'].includes(tool)) return 'import';
  if (['backup_database', 'list_backups', 'verify_backup'].includes(tool)) return 'backup';
  if (tool === 'set_connection_read_only' || tool === 'mcp:settings') return 'admin';
  const operations = Array.isArray(args.operations) ? args.operations : [args];
  if (tool === 'execute_ddl' || tool === 'execute_write' && operations.some(op => /^drop_/.test(op?.operation || ''))) return 'ddl';
  return tool === 'execute_write' ? 'write' : 'read';
}

function redactLiterals(value) {
  return value.replace(/(\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)[\s\S]*?(?:\1|$)/g, '[valore]')
    .replace(/'(?:''|\\.|[^'\\])*(?:'|$)/g, "'[valore]'")
    .replace(/"(?:""|\\.|[^"\\])*(?:"|$)/g, '"[valore]"');
}

function textSafe(value) {
  return String(value).replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [omesso]')
    .replace(/\bcdb_[A-Za-z0-9_-]+/g, '[chiave omessa]')
    .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[credenziali omesse]@')
    .replace(/((?:password|passwd|passphrase|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[omesso]')
    .slice(0, 8000);
}

function sanitize(value, depth = 0, field = '') {
  if (SECRET.test(field)) return '[omesso]';
  if (depth > 7) return '[profondità limitata]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    // I literal SQL e i valori dei documenti possono contenere qualsiasi segreto,
    // anche senza un nome di campo riconoscibile: nell'audit resta la struttura.
    if (/^(sql|query)$/i.test(field)) return textSafe(redactLiterals(value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '/* omesso */').replace(/--[^\r\n]*/g, '-- omesso')).replace(/\b\d+(?:\.\d+)?\b/g, '[numero]'));
    if (/error/i.test(field)) return textSafe(redactLiterals(value));
    if (/^(doc|filter|filtro|set|pipeline)$/i.test(field)) {
      try { return shape(JSON.parse(value)); } catch { return '[contenuto omesso]'; }
    }
    return textSafe(value);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 80)) {
    if (field === 'parameters' && !PARAMETER_NAMES.has(key)) { result[key] = '[omesso]'; continue; }
    if (['docs', 'rows', 'documents', 'contents', 'messages', 'content', 'data', 'schema', 'nodes', 'links'].includes(key) && typeof child === 'object') {
      result[`${key}Count`] = Array.isArray(child) ? child.length : Object.keys(child || {}).length;
    } else result[key] = /^(doc|filter|filtro|set|pipeline)$/.test(key) && typeof child === 'object'
      ? shape(child) : sanitize(child, depth + 1, key);
  }
  return result;
}

function shape(value, depth = 0) {
  if (depth > 5) return '[profondità limitata]';
  if (Array.isArray(value)) return value.slice(0, 8).map(v => shape(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).slice(0, 40)
    .map(key => [key, SECRET.test(key) ? '[omesso]' : shape(value[key], depth + 1)]));
  return '[valore]';
}

function statusOf(result, error, rejected = false) {
  if (result?.status === 'intervento_richiesto') return 'partial';
  if (result?.status === 'ripristinato_dopo_errore' || result?.rolledBack) return 'rolled_back';
  if (result?.transactional === false && (result.completed > 0 || result.failedOperationResult?.insertedCount > 0)) return error ? 'partial' : 'completed';
  if (error && (result?.insertedCount > 0 || result?.modifiedCount > 0 || result?.deletedCount > 0)) return 'partial';
  if (error) return rejected ? 'rejected' : 'failed';
  if (result?.requires_confirmation) return 'pending';
  return 'completed';
}

function boundedEntry(entry) {
  const safe = sanitize(entry);
  const bytes = Buffer.byteLength(JSON.stringify(safe));
  if (bytes <= 65536) return safe;
  const reduced = { truncated: true, originalBytes: bytes };
  for (const key of ['id', 'invocationId', 'operationId', 'runtimeId', 'sessionId', 'ts', 'startedAt', 'finishedAt', 'expiresAt', 'durationMs', 'tool', 'category', 'status', 'event', 'connection', 'db', 'coll', 'dbType', 'ownerId', 'userId', 'user', 'summary', 'error', 'legacy']) {
    if (safe[key] !== undefined) reduced[key] = safe[key] == null || typeof safe[key] === 'number' || typeof safe[key] === 'boolean' ? safe[key] : String(safe[key]).slice(0, 1024);
  }
  reduced.client = safe.client ? { name: String(safe.client.name || '').slice(0, 256), version: String(safe.client.version || '').slice(0, 256) } : null;
  reduced.parameters = { truncated: true, note: 'Parametri omessi: superano il limite di 64 KiB della ricevuta.' };
  reduced.result = { truncated: true };
  const counts = ['status', 'insertedCount', 'modifiedCount', 'deletedCount', 'matchedCount', 'completed', 'operationCount', 'failedIndex', 'transactional', 'rolledBack', 'affectedRows', 'rowsCount', 'docsCount'];
  for (const key of counts) if (safe.result?.[key] != null && ['number', 'boolean', 'string'].includes(typeof safe.result[key])) reduced.result[key] = typeof safe.result[key] === 'string' ? safe.result[key].slice(0, 256) : safe.result[key];
  if (safe.result?.failedOperationResult) reduced.result.failedOperationResult = Object.fromEntries(counts.filter(k => typeof safe.result.failedOperationResult[k] === 'number' || typeof safe.result.failedOperationResult[k] === 'boolean').map(k => [k, safe.result.failedOperationResult[k]]));
  reduced.events = (safe.events || []).slice(-10).map(event => ({ event: String(event.event || '').slice(0, 256), ts: String(event.ts || '').slice(0, 40) }));
  return reduced;
}

function createActivity(store, { audit, now = () => Date.now() } = {}) {
  const local = new AsyncLocalStorage();
  const running = new Map();
  const snapshots = new Map();
  const runtimeId = crypto.randomUUID();
  function persist(entry) {
    const safe = boundedEntry(entry);
    Promise.resolve(store.audit(safe)).catch(() => {});
    // Seam storico dei test: riceve la stessa ricevuta pubblica, già ripulita.
    if (audit) { try { audit(safe); } catch { /* l'audit non annulla un'operazione */ } }
    return safe;
  }
  function actor(entry, session) {
    const p = session?.principal;
    Object.assign(entry, {
      sessionId: session?.id || null, ownerId: p?.ownerId || null, userId: p?.id || null,
      user: p?.email || p?.displayName || null, client: session?.client || null,
    });
  }
  function context() { return local.getStore(); }
  function describe(session, args = {}) {
    const ctx = context();
    if (!ctx) return;
    actor(ctx.entry, session);
    const conn = session?.dbSessions?.get(String(args.connection_id || args.connectionId || ''));
    Object.assign(ctx.entry, {
      connection: conn?.name || args.saved || args.connection_name || args.connessione || null,
      dbType: conn?.dbType || null, db: args.db || args.target_db || null,
      coll: args.collection || args.coll || null,
    });
  }
  function legacy(entry) {
    const ctx = context();
    if (!ctx) return;
    ctx.details.push(sanitize(entry));
    for (const key of ['connection', 'dbType', 'db', 'collection', 'operation', 'event']) {
      if (entry[key] != null) ctx.entry[key === 'collection' ? 'coll' : key] = entry[key];
    }
    // Conserva i riepiloghi storici già consumati dai verificatori di backup e
    // dai test d'integrazione; i payload restano soggetti alla stessa redazione.
    for (const key of ['collection', 'documentCount', 'operationCount', 'operations', 'upsert', 'readOnly', 'backupId', 'targetDb', 'group', 'affectedEstimate', 'destructive']) {
      if (entry[key] != null) ctx.entry[key] = sanitize(entry[key], 0, key);
    }
    if (entry.result) ctx.partialResult = entry.result;
  }
  function outcome(result, error) {
    const ctx = context();
    if (!ctx) return;
    ctx.outcome = result;
    ctx.error = error;
  }
  async function request(req, res, handler) {
    const method = req.method === 'DELETE' ? 'session/close' : req.body?.method;
    if (!['tools/call', 'resources/read', 'prompts/get', 'initialize', 'session/close'].includes(method)) return handler();
    const args = req.body?.params?.arguments || {};
    const tool = method === 'resources/read' ? `resource:${String(req.body.params?.uri || '').split(':')[0]}`
      : method === 'prompts/get' ? `prompt:${req.body.params?.name || ''}`
      : method === 'initialize' ? 'mcp:initialize' : method === 'session/close' ? 'mcp:disconnect' : String(req.body.params?.name || 'sconosciuto');
    const start = now(), id = crypto.randomUUID();
    const entry = {
      id, invocationId: id, operationId: id, runtimeId, ts: new Date(start).toISOString(),
      startedAt: new Date(start).toISOString(), finishedAt: null, durationMs: null,
      tool, category: categoryOf(tool, args),
      status: 'running', connection: null, db: null, coll: null, dbType: null,
      ownerId: null, userId: null, user: null, client: null,
      summary: tool, parameters: sanitize(method === 'resources/read' ? { uri: req.body.params?.uri } : args, 0, 'parameters'),
    };
    const ctx = { entry, details: [], error: null, outcome: undefined, captured: '', invoked: false };
    // L'SDK valida lo schema prima degli handler. La risposta catturata consente
    // di registrare anche quel rifiuto, senza memorizzare i dati restituiti.
    const originalWrite = res.write, originalEnd = res.end;
    const capture = chunk => {
      if (chunk != null && ctx.captured.length < 16384) ctx.captured += ArrayBuffer.isView(chunk)
        ? Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, 16384)).toString('utf8') : String(chunk).slice(0, 16384);
    };
    res.write = function(chunk, ...rest) { capture(chunk); return originalWrite.call(this, chunk, ...rest); };
    res.end = function(chunk, ...rest) { capture(chunk); return originalEnd.call(this, chunk, ...rest); };
    running.set(id, entry);
    return local.run(ctx, async () => {
      try { return await handler(); }
      catch (error) { ctx.error = error; throw error; }
      finally {
        res.write = originalWrite; res.end = originalEnd;
        let reply;
        try { reply = JSON.parse(ctx.captured); } catch { /* risposta grande: l'handler ha già fornito l'esito */ }
        const protocolError = reply?.error || (reply?.result?.isError ? { message: reply.result.content?.[0]?.text } : null);
        let error = ctx.error || protocolError || (res.statusCode >= 400 ? { message: `Richiesta rifiutata (HTTP ${res.statusCode}).` } : null);
        if (!ctx.invoked && error && (error.code === -32602 || /-32602|Input validation|Invalid arguments/i.test(error.message || ''))) {
          entry.technicalError = textSafe(redactLiterals(String(error.message || error)));
          error = { message: 'Parametri della richiesta MCP non validi. Controlla i campi obbligatori e i tipi indicati dallo strumento.' };
        } else if (!ctx.invoked && error?.code === -32601) {
          error = { message: 'Strumento o metodo MCP non disponibile. Aggiorna l’elenco degli strumenti nel client.' };
        }
        const result = ctx.partialResult || ctx.outcome;
        const rejected = !ctx.invoked || (!ctx.details.some(e => ['failed', 'executed'].includes(e.event)) && error && /permesso|sola lettura|disabilitat|confirm_token|quota|sconosciuto|non valid|mancant|ammette|vietat|non consent/i.test(error.message || ''));
        Object.assign(entry, {
          status: statusOf(result, error, rejected), finishedAt: new Date(now()).toISOString(), durationMs: Math.max(0, now() - start),
          result: sanitize(result), error: error ? textSafe(redactLiterals(String(error.message || error))) : null,
          events: [{ event: 'started', ts: entry.startedAt }, ...ctx.details, { event: 'finished', ts: new Date(now()).toISOString() }], event: entry.event || (error ? 'failed' : 'executed'),
        });
        running.delete(id);
        persist(entry);
      }
    });
  }
  function started(session, args) {
    describe(session, args);
    const ctx = context();
    const pending = args?.confirm_token && session.pendingWrites?.get(args.confirm_token);
    if (ctx && pending?.operationId) {
      ctx.entry.operationId = pending.operationId;
      ctx.entry.category = categoryOf(ctx.entry.tool, pending.summary || args);
    }
    if (ctx && !ctx.persistedStart) { ctx.persistedStart = true; persist(ctx.entry); }
  }
  function pending(data) {
    const ctx = context();
    if (!ctx) return;
    data.activityId = ctx.entry.id;
    data.operationId = ctx.entry.operationId;
    ctx.entry.expiresAt = new Date(data.expiresAt).toISOString();
    data.activityEntry = ctx.entry;
  }
  function settlePending(data, status, event) {
    if (!data?.activityEntry) return;
    persist({ ...data.activityEntry, status, event, events: [...(data.activityEntry.events || []), { event, ts: new Date(now()).toISOString() }] });
  }
  function consume(data) {
    const ctx = context();
    if (ctx && data.operationId) ctx.entry.operationId = data.operationId;
    if (data.activityEntry) data.activityEntry = { ...data.activityEntry, summary: `${data.activityEntry.summary} — anteprima confermata; esecuzione nella chiamata collegata` };
    settlePending(data, 'confirmed', 'confirmed');
  }
  function visible(entry, filters) {
    return (!filters.ownerId || entry.ownerId === filters.ownerId) && (!filters.userId || entry.userId === filters.userId);
  }
  async function entries() {
    await store.flush();
    const loaded = store.readRecent({ limit: MAX_ENTRIES });
    const recent = loaded.entries;
    const values = new Map();
    for (let i = 0; i < recent.length; i++) {
      const raw = recent[i];
      const id = raw.id || `legacy-${crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 24)}`;
      if (values.has(id)) continue;
      const entry = { ...raw, id };
      if (!entry.invocationId) Object.assign(entry, {
        legacy: true, invocationId: id, operationId: null, tool: raw.tool || raw.operation || 'legacy',
        status: raw.event === 'executed' || raw.event === 'completato' ? 'completed' : raw.event === 'failed' ? 'failed' : 'unknown',
        summary: 'Evento storico: identità e correlazione disponibili solo se registrate.',
      });
      if (entry.status === 'running' && !running.has(id) || entry.status === 'pending' && entry.runtimeId !== runtimeId) {
        entry.status = 'unknown'; entry.error = 'Il processo è terminato senza una ricevuta finale; l’esito non è verificato.';
      }
      values.set(id, boundedEntry(entry));
    }
    for (const entry of running.values()) values.set(entry.id, boundedEntry(entry));
    return { entries: [...values.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || b.id.localeCompare(a.id)), truncated: !!loaded.truncated || recent.length >= MAX_ENTRIES };
  }
  async function list(filters = {}) {
    const offset = Math.max(0, Number(filters.offset) || 0), limit = Math.max(1, Math.min(10000, Number(filters.limit) || 50));
    for (const [key, snap] of snapshots) if (snap.expiresAt < now()) snapshots.delete(key);
    let snapshot = filters.snapshot, saved;
    const identity = JSON.stringify([filters.ownerId || null, filters.userId || null]);
    if (snapshot) {
      saved = snapshots.get(snapshot);
      if (!saved || saved.identity !== identity) throw new Error('La consultazione MCP è scaduta o non appartiene all’utente: aggiorna l’elenco.');
    } else {
      const all = await entries();
      const filtered = all.entries.filter(e => visible(e, filters)
        && ['tool', 'connection', 'db', 'status', 'user'].every(k => !filters[k] || e[k] === filters[k])
        // La scorciatoia Scritture comprende anche modifiche allo schema e import.
        && (!filters.category || (filters.category === 'write' ? ['write', 'ddl', 'import'].includes(e.category) : e.category === filters.category))
        && (!filters.from || Date.parse(e.ts) >= Date.parse(filters.from)) && (!filters.to || Date.parse(e.ts) <= Date.parse(filters.to))
        && (!filters.search || JSON.stringify(e).toLocaleLowerCase('it').includes(String(filters.search).toLocaleLowerCase('it'))));
      snapshot = filters.transient ? undefined : crypto.randomUUID();
      const bounded = [];
      let bytes = 0;
      for (const entry of filtered) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > SNAPSHOT_BYTES) break;
        bounded.push(entry); bytes += size;
      }
      saved = { entries: bounded, bytes, truncated: all.truncated || bounded.length < filtered.length, identity, expiresAt: now() + 5 * 60000 };
      const usedBytes = () => [...snapshots.values()].reduce((n, s) => n + s.bytes, 0);
      if (!filters.transient) {
        while (snapshots.size && (snapshots.size >= 20 || usedBytes() + bytes > TOTAL_SNAPSHOT_BYTES)) snapshots.delete(snapshots.keys().next().value);
        snapshots.set(snapshot, saved);
      }
    }
    return { entries: saved.entries.slice(offset, offset + limit), total: saved.entries.length, offset, limit, snapshot, truncated: saved.truncated };
  }
  async function get(id, visibility = {}) {
    const all = await entries();
    return all.entries.find(e => e.id === id && visible(e, visibility)) || null;
  }
  function admin(entry) {
    const id = crypto.randomUUID(), ts = new Date(now()).toISOString();
    return persist({ id, invocationId: id, operationId: id, runtimeId, ts, startedAt: ts, finishedAt: ts, durationMs: 0, tool: 'mcp:settings', category: 'admin', status: 'completed', ...entry });
  }
  return { request, context, describe, started, legacy, outcome, pending, consume, expire: data => settlePending(data, 'expired', 'expired'), list, get, admin };
}

module.exports = { createActivity, sanitize, statusOf, boundedEntry, categoryOf };
