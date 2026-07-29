/**
 * CodeDB
 * Copyright (c) 2026 Federico Ferrulli
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const crypto = require('crypto');
const readline = require('readline');
const DbFactory = require('./db/DbFactory');
const { makeAuditor } = require('./db/AuditLog');
const { openSshTunnel } = require('./db/SshTunnel');
const { attachMcp } = require('./mcp/McpGateway');
const VirtualJoinEngine = require('./db/VirtualJoinEngine');
const SqlToMql = require('./db/SqlToMql');
const MongoShell = require('./db/MongoShell');

const { runBackup } = require('./backup/lib/engine');
const { runRestore } = require('./backup/lib/restore');
const { parseStorage, uploadBackupDir } = require('./backup/lib/storage');
const { createLogger, formatDuration } = require('./backup/lib/logger');
const { readCatalog, readManifest, sha256File, formatBytes } = require('./backup/lib/util');
const { notifySlack } = require('./backup/lib/notify');

const BACKUP_ROOT = process.env.CODEDB_BACKUPS_DIR || path.join(__dirname, 'backups');

// Audit log delle operazioni critiche/di scrittura eseguite dalla Web UI, su un
// file separato da quello del gateway MCP (mcp-audit.log) ma con lo stesso
// formato/rotazione (db/AuditLog.js). CODEDB_UI_AUDIT_FILE lo sposta nella
// cartella dati utente per l'app Electron pacchettizzata e isola i test.
const UI_AUDIT_FILE = process.env.CODEDB_UI_AUDIT_FILE || path.join(__dirname, 'ui-audit.log');
const { audit: auditUi, readRecent: readUiAudit } = makeAuditor(UI_AUDIT_FILE);

const PORT = process.env.PORT || 3030;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function errMsg(err) {
  return (err && err.message) || String(err);
}

// Corsa contro un timeout: se `promise` non si risolve entro `ms`, rigetta con
// un errore leggibile. Usato dal pannello di salute per non restare appeso su
// una connessione morta (es. tunnel SSH caduto) oltre qualche secondo.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'Operazione'} scaduta dopo ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ---------------------------------------------------------------------------
 * Connessioni salvate (connections.ini)
 * ------------------------------------------------------------------------- */

// CODEDB_CONNECTIONS_FILE: override usato dai test per lavorare su un file
// temporaneo senza mai toccare il connections.ini reale (stesso env della CLI
// di backup, vedi backup/lib/connstore.js).
const CONNECTIONS_FILE = process.env.CODEDB_CONNECTIONS_FILE || path.join(__dirname, 'connections.ini');
const CONN_FIELDS = [
  'dbType', 'uri', 'host', 'port', 'username', 'password', 'authSource', 'database',
  // Cartella/gruppo di appartenenza nella sidebar del connection manager.
  'folder',
  // Fase 3 MCP: le scritture via execute_write sono consentite solo se la
  // connessione dichiara esplicitamente readOnly=false (default: sola lettura).
  'readOnly',
  // Tunnel SSH (ortogonale al dbType): 'ssh' = "true" per abilitarlo.
  'ssh', 'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshKeyFile', 'sshPassphrase',
];
// Campi segreti: mai rimandati al browser, riusati dal valore salvato se il form
// li lascia vuoti (vedi connections:get/save e mongo:connect con keepPasswordFrom).
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'];

let encryptionKey = crypto.createHash('sha256').update(process.env.GUI_MONGO_PASSPHRASE || '').digest();
// Conta i segreti che non si decifrano: all'avvio un valore > 0 significa
// passphrase sbagliata e il server rifiuta di partire (vedi main), invece di
// proseguire e riscrivere il file coi segreti azzerati.
let decryptFailures = 0;

function encryptSecret(text, cryptoKey = encryptionKey) {
  if (!text || typeof text !== 'string') return text;
  if (text.startsWith('ENC:')) return text; // già cifrato
  if (!cryptoKey) throw new Error('Impossibile cifrare il segreto: il vault è bloccato.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `ENC:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

// Decifra un segreto ENC:iv:tag:testo; lancia se la chiave non è quella giusta.
function decryptRaw(text) {
  if (!encryptionKey) throw new Error('Vault bloccato');
  const parts = text.split(':');
  if (parts.length !== 4) return text;
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(parts[1], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
  let decrypted = decipher.update(parts[3], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function decryptSecret(text) {
  if (!text || typeof text !== 'string') return text;
  if (!text.startsWith('ENC:')) return text; // non cifrato (plain text)
  if (!encryptionKey) return text; // vault bloccato: restituisci il cifrato intatto
  try {
    return decryptRaw(text);
  } catch (e) {
    console.error('Errore decrittazione segreto:', e.message);
    decryptFailures += 1;
    // Conserva il testo cifrato: così un eventuale salvataggio successivo
    // riscrive il file col cifrato originale intatto, mai col segreto azzerato
    // (encryptSecret lascia passare i valori già "ENC:").
    return text;
  }
}

function tryUnlockVault(passphrase) {
  if (typeof passphrase !== 'string') {
    return { ok: false, error: 'Passphrase non valida.' };
  }
  const key = crypto.createHash('sha256').update(passphrase).digest();
  const oldKey = encryptionKey;
  const oldFailures = decryptFailures;

  encryptionKey = key;
  decryptFailures = 0;

  const conns = loadConnections();
  if (decryptFailures > 0) {
    encryptionKey = oldKey;
    decryptFailures = oldFailures;
    return { ok: false, error: 'Passphrase errata: i segreti cifrati non si decifrano con questa chiave.' };
  }

  if (Object.keys(conns).length > 0) {
    saveConnections(conns);
  }
  return { ok: true };
}

function parseIni(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = sections[header[1]] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) {
      current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

function stringifyIni(sections) {
  const lines = ['; Connessioni salvate da Mongo Web GUI. Attenzione: le password sono in chiaro.'];
  for (const [name, values] of Object.entries(sections)) {
    lines.push('', `[${name}]`);
    for (const [key, val] of Object.entries(values)) {
      if (val != null && String(val).trim() !== '') lines.push(`${key}=${String(val).trim()}`);
    }
  }
  return lines.join('\n') + '\n';
}

function loadConnections() {
  try {
    const sections = parseIni(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
    for (const sec of Object.values(sections)) {
      for (const f of SECRET_FIELDS) {
        if (sec[f]) sec[f] = decryptSecret(sec[f]);
      }
    }
    return sections;
  } catch {
    return {}; // file assente o illeggibile: nessuna connessione salvata
  }
}

// Cifra i segreti (password, credenziali SSH) di una copia profonda delle
// sezioni, senza toccare l'originale: usata sia prima di riscrivere il file
// sia prima di esportarlo, così i due percorsi restano un solo punto di verità.
// `cryptoKey` permette all'export di cifrare con una passphrase diversa da
// quella dell'installazione corrente (default: la chiave del vault attivo).
function encryptSections(sections, cryptoKey = encryptionKey) {
  const copy = {};
  for (const name in sections) {
    const secCopy = { ...sections[name] };
    for (const f of SECRET_FIELDS) {
      if (secCopy[f]) secCopy[f] = encryptSecret(secCopy[f], cryptoKey);
    }
    copy[name] = secCopy;
  }
  return copy;
}

function saveConnections(sections) {
  const toSave = encryptSections(sections);
  // Prima di riscrivere, conserva le due versioni precedenti (.bak e .bak2):
  // il file è l'unica copia dei segreti sul disco e la migrazione all'avvio con
  // una passphrase sbagliata li azzererebbe; due generazioni proteggono anche
  // se dopo una migrazione corrotta arriva un ulteriore salvataggio dalla UI.
  try {
    fs.copyFileSync(CONNECTIONS_FILE + '.bak', CONNECTIONS_FILE + '.bak2');
  } catch { /* nessun .bak precedente: niente da ruotare */ }
  try {
    fs.copyFileSync(CONNECTIONS_FILE, CONNECTIONS_FILE + '.bak');
  } catch { /* file ancora inesistente: nessun backup da fare */ }
  fs.writeFileSync(CONNECTIONS_FILE, stringifyIni(toSave), 'utf8');
}

function assertConnName(name) {
  if (!name || /[\[\]\r\n]/.test(name)) {
    throw new Error(`Nome di connessione non valido: "${name}"`);
  }
}

// Tiene solo i campi noti e non vuoti di una configurazione di connessione.
function sanitizeConnCfg(cfg) {
  return Object.fromEntries(
    CONN_FIELDS
      .filter((f) => cfg[f] != null && String(cfg[f]).trim() !== '')
      .map((f) => [f, String(cfg[f]).trim()])
  );
}

// dbType assente nelle connessioni salvate prima del supporto multi-db.
function connDbType(cfg) {
  return String(cfg.dbType || 'mongodb').trim().toLowerCase();
}

function sshEnabled(cfg) {
  return String(cfg.ssh || '').trim().toLowerCase() === 'true';
}

// Etichetta mostrata in UI: eventuali credenziali nella URI vengono mascherate.
function connLabel(cfg) {
  let base;
  if (cfg.uri && cfg.uri.trim()) {
    base = cfg.uri.trim().replace(/\/\/[^@]+@/, '//***@');
  } else {
    const type = connDbType(cfg);
    base = `${(cfg.host || 'localhost').trim()}:${String(cfg.port || DbFactory.defaultPort(type)).trim()}`;
  }
  return sshEnabled(cfg) ? `${base} (via SSH)` : base;
}

/* ---------------------------------------------------------------------------
 * Apertura di una connessione DB (comune a mongo:connect e connections:test)
 * ------------------------------------------------------------------------- */

// Risolve la configurazione effettiva: cfg.saved = usa una connessione salvata
// (i parametri, password inclusa, restano lato server); cfg.keepPasswordFrom =
// riusa i segreti di una connessione salvata quando il form li lascia vuoti
// (non vengono mai rimandati al browser, quindi il client non può reinviarli).
function resolveEffectiveCfg(cfg) {
  let effective = cfg;
  // Un solo caricamento del file: sia "saved" che "keepPasswordFrom" leggono
  // dalla stessa mappa in memoria, evitando due letture/decifrature ridondanti.
  const needsLookup = cfg.saved || cfg.keepPasswordFrom;
  const conns = needsLookup ? loadConnections() : null;
  if (cfg.saved) {
    const saved = conns[cfg.saved];
    if (!saved) throw new Error(`Connessione salvata "${cfg.saved}" non trovata.`);
    effective = saved;
  }
  if (cfg.keepPasswordFrom) {
    const prev = conns[cfg.keepPasswordFrom];
    if (prev) {
      const merged = { ...effective };
      for (const f of SECRET_FIELDS) {
        if (!merged[f] && prev[f]) merged[f] = prev[f];
      }
      effective = merged;
    }
  }
  return effective;
}

// Apre tunnel SSH (se richiesto) e connette la strategia. In caso di errore
// chiude quanto già aperto e rilancia; altrimenti restituisce le risorse
// aperte, la cui chiusura è a carico del chiamante (teardownConnection).
async function establishConnection(cfg) {
  const effective = resolveEffectiveCfg(cfg);
  const dbType = connDbType(effective);
  let tunnel = null;
  try {
    // Tunnel SSH (solo in modalità "Parametri"): la strategia si connette al
    // capo locale del tunnel anziché direttamente all'host del database.
    let connectCfg = effective;
    if (sshEnabled(effective)) {
      if (effective.uri && effective.uri.trim()) {
        throw new Error('Il tunnel SSH è disponibile solo in modalità "Parametri", non con URI completa.');
      }
      const target = {
        host: (effective.host || 'localhost').trim(),
        port: parseInt(effective.port, 10) || DbFactory.defaultPort(dbType),
      };
      tunnel = await openSshTunnel(effective, target);
      connectCfg = { ...effective, host: tunnel.host, port: String(tunnel.port) };
      // Per MongoDB dietro tunnel: evita la topology discovery verso host del
      // replica set non raggiungibili attraverso il tunnel.
      if (dbType === 'mongodb') connectCfg.directConnection = true;
    }
    const strategy = DbFactory.getStrategy(dbType);
    await strategy.connect(connectCfg);
    return { strategy, tunnel, effective, dbType };
  } catch (err) {
    if (tunnel) try { tunnel.close(); } catch { /* ignora */ }
    throw err;
  }
}

async function teardownConnection({ strategy, tunnel }) {
  await strategy.disconnect().catch(() => {});
  // Il tunnel va chiuso dopo la strategia, che lo usa per il traffico DB.
  if (tunnel) {
    try { tunnel.close(); } catch { /* ignora */ }
  }
}

/* ---------------------------------------------------------------------------
 * Riconnessione automatica in caso di perdita di connessione DB / tunnel SSH
 * ------------------------------------------------------------------------- */

function isConnectionError(err, sess) {
  if (!err) return false;
  if (sess && sess.tunnel && !sess.tunnel.alive) return true;

  const msg = (err.message || String(err)).toLowerCase();
  const name = (err.name || '').toLowerCase();
  const code = String(err.code || '').toLowerCase();

  const connTerms = [
    'nessuna connessione attiva',
    'topology was destroyed',
    'client is closed',
    'pool is closed',
    'pool closed',
    'socket closed',
    'socket disconnected',
    'socket hang up',
    'connection closed',
    'connection terminated',
    'connection reset',
    'connection lost',
    'tunnel ssh caduto',
    'client has already been dismantled',
    'server shutdown',
    'econnreset',
    'econnrefused',
    'etimedout',
    'epipe',
    'enotfound',
    'protocol_connection_lost',
    'protocol_enqueue_after_fatal_error',
    'mongonetworkerror',
    'mongoserverselectionerror',
  ];

  return connTerms.some((term) => msg.includes(term) || name.includes(term) || code.includes(term));
}

async function reconnectSession(sess, maxAttempts = 14) {
  if (!sess || !sess.effectiveCfg) {
    throw new Error('Impossibile riconnettersi: configurazione di connessione non disponibile.');
  }
  if (sess.reconnecting) {
    return sess.reconnectPromise;
  }
  sess.reconnecting = true;
  sess.reconnectPromise = (async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const delayMs = Math.min(attempt * 5000, 60000);
      if (delayMs > 0) {
        console.log(`[Auto-Reconnect] Attesa di ${delayMs / 1000}s prima del tentativo ${attempt + 1}/${maxAttempts} per ${sess.label || 'sessione'}...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.log(`[Auto-Reconnect] Tentativo immediato (1/${maxAttempts}) di riconnessione automatica al DB per ${sess.label || 'sessione'}...`);
      }

      try {
        await teardownConnection(sess).catch(() => {});
        const conn = await establishConnection(sess.effectiveCfg);
        sess.strategy = conn.strategy;
        sess.tunnel = conn.tunnel;
        sess.dbType = conn.dbType;
        sess.label = connLabel(conn.effective);
        console.log(`[Auto-Reconnect] Riconnessione automatica al DB riuscita al tentativo ${attempt + 1} per ${sess.label}!`);
        return true;
      } catch (err) {
        lastErr = err;
        console.warn(`[Auto-Reconnect] Tentativo ${attempt + 1}/${maxAttempts} fallito per ${sess.label || 'sessione'}: ${err.message}`);
      }
    }

    console.error(`[Auto-Reconnect] Tutti i ${maxAttempts} tentativi di riconnessione automatica sono falliti per ${sess.label || 'sessione'}.`);
    throw new Error(`Connessione al database persa. Tentativo di riconnessione automatico fallito dopo ${maxAttempts} tentativi: ${lastErr ? lastErr.message : 'Errore sconosciuto'}`);
  })().finally(() => {
    sess.reconnecting = false;
    sess.reconnectPromise = null;
  });

  return sess.reconnectPromise;
}

async function executeWithReconnect(sess, actionFn) {
  try {
    return await actionFn(sess.strategy);
  } catch (err) {
    if (isConnectionError(err, sess) && sess.effectiveCfg) {
      console.warn(`[Auto-Reconnect] Rilevata perdita di connessione DB. Avvio ripristino connessione...`);
      await reconnectSession(sess);
      return await actionFn(sess.strategy);
    }
    throw err;
  }
}


/* ---------------------------------------------------------------------------
 * Audit delle scritture via Web UI
 * ------------------------------------------------------------------------- */

// Tronca un valore (stringa o oggetto) a n caratteri per non gonfiare il log.
function cutStr(v, n = 200) {
  if (v == null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Estrae i contatori "quante righe" dal risultato di una scrittura, qualunque
// sia la strategia (Mongo/MySQL/PostgreSQL usano nomi diversi): entra nel log
// solo ciò che è effettivamente presente.
function auditCounts(r) {
  if (!r || typeof r !== 'object') return {};
  const out = {};
  for (const k of ['deletedCount', 'modifiedCount', 'matchedCount', 'insertedCount',
    'upsertedCount', 'inserted', 'imported', 'count', 'affectedRows']) {
    if (r[k] != null) out[k] = r[k];
  }
  return out;
}

// Descrittori delle operazioni di scrittura tracciate: (payload, result) →
// campi aggiuntivi da registrare (op = etichetta italiana per la UI). Solo gli
// eventi qui presenti vengono registrati; i restanti delegate restano di sola
// lettura e non producono voci di audit.
const AUDIT_WRITES = {
  'db:create':             (p) => ({ coll: p.coll, op: 'Creazione database' }),
  'db:rename':             (p) => ({ newName: p.newName, op: 'Rinomina database' }),
  'db:drop':               () => ({ op: 'Eliminazione database' }),
  'collection:create':     (p) => ({ coll: p.name, op: 'Creazione collection/tabella' }),
  'collection:rename':     (p) => ({ coll: p.coll, newName: p.newName, op: 'Rinomina collection/tabella' }),
  'collection:drop':       (p) => ({ coll: p.coll, op: 'Eliminazione collection/tabella' }),
  'column:add':            (p) => ({ coll: p.coll, op: 'Aggiunta colonna' }),
  'column:alter':          (p) => ({ coll: p.coll, op: 'Modifica colonna' }),
  'column:drop':           (p) => ({ coll: p.coll, column: p.name, op: 'Eliminazione colonna' }),
  'index:create':          (p) => ({ coll: p.coll, op: 'Creazione indice' }),
  'index:drop':            (p) => ({ coll: p.coll, index: p.name, op: 'Eliminazione indice' }),
  'doc:insert':            (p) => ({ coll: p.coll, op: 'Inserimento documento/riga' }),
  'doc:update':            (p) => ({ coll: p.coll, docId: cutStr(p.id, 120), op: 'Aggiornamento documento/riga' }),
  'doc:replace':           (p) => ({ coll: p.coll, docId: cutStr(p.id, 120), op: 'Sostituzione documento/riga' }),
  'doc:delete':            (p) => ({ coll: p.coll, docId: cutStr(p.id, 120), op: 'Eliminazione documento/riga' }),
  'collection:deleteMany': (p) => ({ coll: p.coll, filter: cutStr(p.filter), op: 'Eliminazione massiva' }),
  'collection:import':     (p) => ({ coll: p.coll, op: 'Import batch' }),
};

// Descrittori delle operazioni di sola lettura tracciate (find, aggregate,
// explain, export). Le letture di navigazione/chrome (db:list, db:collections,
// db:schema, db:search, collection:stats) restano fuori: sono ad altissimo
// volume (polling, render della sidebar) e non rappresentano un'azione utente.
const AUDIT_READS = {
  'collection:find':      (p) => ({ coll: p.coll, op: 'Lettura documenti/righe (find)', filter: cutStr(p.filter), sort: cutStr(p.sort, 80) }),
  'collection:aggregate': (p) => ({ coll: p.coll, op: 'Aggregazione', pipeline: cutStr(p.pipeline, 300) }),
  'collection:explain':   (p) => ({ coll: p.coll, op: 'Piano di esecuzione (explain)' }),
  'collection:export':    (p) => ({ coll: p.coll, op: 'Export collection/tabella' }),
};

// Prima parola SQL: riconosce se una query è una scrittura (le letture SELECT
// restano categorizzate come read).
const SQL_WRITE_KEYWORDS = /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|MERGE|GRANT|REVOKE|RENAME|CALL)\b/i;
function isWriteSql(code) {
  return SQL_WRITE_KEYWORDS.test(String(code || '').trim());
}
// Pipeline MongoDB che materializza dati (unica forma di scrittura via pipeline).
function isWriteMongoPipeline(code) {
  return /"\$out"|"\$merge"/.test(String(code || ''));
}

// Tetto dei risultati per il Query Engine (⚡ Query & Aggregate): più alto del
// default 500 della griglia paginata, così una query esplicita non viene
// troncata silenziosamente. Override con env CODEDB_QUERY_MAX; il ceiling
// assoluto è comunque imposto dalle strategie (DbStrategy.resultCap).
const QUERY_ENGINE_MAX_ROWS = Math.max(parseInt(process.env.CODEDB_QUERY_MAX, 10) || 10000, 1);

// Operatori MongoDB che eseguono JavaScript lato server: vietati nel Query
// Engine della UI (coerente col gateway MCP) per non trasformare una query in
// esecuzione di codice arbitrario sul server del database. Scansione ricorsiva
// della struttura già parsata (filtro o pipeline).
const FORBIDDEN_MONGO_OPS = new Set(['$where', '$function', '$accumulator']);
function assertNoServerJs(node) {
  if (Array.isArray(node)) { for (const el of node) assertNoServerJs(el); return; }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_MONGO_OPS.has(key)) {
        throw new Error(`Operatore "${key}" non consentito nel Query Engine: l'esecuzione di JavaScript lato server è disabilitata.`);
      }
      assertNoServerJs(node[key]);
    }
  }
}

// Parse permissivo (solo per la scansione di sicurezza): non deve far fallire
// l'operazione se il testo non è JSON puro (la strategia lo ri-parsa comunque).
function safeParseForScan(text) {
  try { return JSON.parse(String(text)); } catch { return null; }
}

// Classifica un evento delegato: scrittura, lettura o non tracciato. Il ramo
// collection:aggregate è ambiguo (nella griglia "SQL Raw"/pipeline può essere
// una scrittura): si guarda la strategia e il codice per decidere.
function classifyAudit(event, payload, sess) {
  if (AUDIT_WRITES[event]) return { category: 'write', describe: AUDIT_WRITES[event] };
  if (event === 'collection:aggregate') {
    const isSql = sess && sess.strategy && sess.strategy.type && sess.strategy.type !== 'mongodb';
    if (isSql && isWriteSql(payload.pipeline)) {
      return { category: 'write', describe: (p) => ({ coll: p.coll, op: 'Query di scrittura (SQL Raw)', query: cutStr(p.pipeline, 500) }) };
    }
    if (!isSql && isWriteMongoPipeline(payload.pipeline)) {
      return { category: 'write', describe: (p) => ({ coll: p.coll, op: 'Pipeline di scrittura ($out/$merge)', pipeline: cutStr(p.pipeline, 500) }) };
    }
    return { category: 'read', describe: AUDIT_READS['collection:aggregate'] };
  }
  if (AUDIT_READS[event]) return { category: 'read', describe: AUDIT_READS[event] };
  return null;
}

// Scrive una voce di audit per un'operazione delegata. Best-effort assoluto:
// qualsiasi errore qui non deve mai disturbare l'operazione già completata.
function auditWrite(sess, event, payload, extra, status, result, error, category) {
  try {
    auditUi({
      event,
      category: category || 'write',
      status,
      connection: (sess && (sess.connName || sess.label)) || null,
      dbType: (sess && (sess.dbType || (sess.strategy && sess.strategy.type))) || null,
      db: payload.db || null,
      client: (sess && sess.ip) || null,
      ...(extra || {}),
      ...auditCounts(result),
      ...(Array.isArray(result && result.docs) ? { rows: result.docs.length } : {}),
      ...(error ? { error: errMsg(error) } : {}),
    });
  } catch { /* audit best-effort */ }
}

// Registra la voce di audit per un evento delegato, saltando le letture
// automatiche (polling/live/refresh post-scrittura marcate _bg dal client).
function auditDelegate(cls, sess, event, payload, status, result, error) {
  if (!cls) return;
  if (cls.category === 'read' && payload._bg) return;
  auditWrite(sess, event, payload, cls.describe(payload, result), status, result, error, cls.category);
}

// Voce di audit per una query eseguita dal Query Engine (query:execute): db/coll
// sono quelli risolti localmente, non nel payload. Il Query Engine è sempre
// avviato dall'utente (nessun polling): letture e scritture vengono entrambe
// tracciate, distinte da `category`.
function auditQuery(sess, db, coll, code, category, op, status, result, error) {
  try {
    auditUi({
      event: 'query:execute',
      category,
      status,
      op,
      connection: (sess && (sess.connName || sess.label)) || null,
      dbType: (sess && (sess.dbType || (sess.strategy && sess.strategy.type))) || null,
      db: db || null,
      coll: coll || null,
      client: (sess && sess.ip) || null,
      query: cutStr(code, 500),
      ...auditCounts(result),
      ...(Array.isArray(result && result.docs) ? { rows: result.docs.length } : {}),
      ...(error ? { error: errMsg(error) } : {}),
    });
  } catch { /* audit best-effort */ }
}

/* ---------------------------------------------------------------------------
 * Socket handling — una sessione (strategia + eventuale tunnel) per ogni tab
 * aperto nel browser; il tabId viaggia in ogni payload. Client storici senza
 * tabId ricadono sulla sessione "default" (stesso comportamento di prima).
 * ------------------------------------------------------------------------- */

// Limiti di sicurezza e prevenzione esaurimento risorse
const MAX_SESSIONS_PER_SOCKET = 8;
const MAX_GLOBAL_SESSIONS = 100;
const MAX_GLOBAL_SOCKETS = 500;
const MAX_SOCKETS_PER_IP = 20;

let activeGlobalSessions = 0;
const ipConnections = new Map();

/* ---------------------------------------------------------------------------
 * Gateway MCP: espone i tools di sola lettura per i client AI sull'endpoint
 * /mcp (Streamable HTTP). Riusa le connessioni salvate e il ciclo di vita
 * delle sessioni di questo file; il budget globale è condiviso coi socket.
 * ------------------------------------------------------------------------- */

attachMcp(app, {
  loadConnections,
  connLabel,
  connDbType,
  // Unica scrittura su connections.ini concessa al gateway MCP: il flag
  // readOnly di una connessione salvata (mai gli altri campi, mai i segreti).
  // La conferma umana a due passaggi è responsabilità del gateway.
  setConnectionReadOnly: (name, readOnly) => {
    const sections = loadConnections();
    const key = String(name || '').trim();
    if (!sections[key]) throw new Error(`Connessione salvata "${key}" inesistente.`);
    sections[key].readOnly = readOnly ? 'true' : 'false';
    saveConnections(sections);
  },
  establishConnection,
  teardownConnection,
  maxDbSessions: MAX_SESSIONS_PER_SOCKET,
  tryAcquireGlobalSession: () => {
    if (activeGlobalSessions >= MAX_GLOBAL_SESSIONS) return false;
    activeGlobalSessions += 1;
    return true;
  },
  releaseGlobalSession: () => { activeGlobalSessions -= 1; },
});

// Normalizza il tabId ricevuto dal client (input non fidato): è solo la chiave
// della mappa di sessioni del proprio socket, mai usato per accedere ad altro.
function normTabId(tabId) {
  const id = String(tabId == null ? '' : tabId).trim();
  return id || 'default';
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const currentSocketsForIp = ipConnections.get(ip) || 0;

  // Controllo limiti connessioni WebSocket
  if (io.engine.clientsCount > MAX_GLOBAL_SOCKETS) {
    console.warn(`Rifiutata connessione WebSocket: raggiunto limite globale di ${MAX_GLOBAL_SOCKETS}.`);
    socket.disconnect(true);
    return;
  }
  if (currentSocketsForIp >= MAX_SOCKETS_PER_IP) {
    console.warn(`Rifiutata connessione WebSocket da IP ${ip}: raggiunto limite per IP di ${MAX_SOCKETS_PER_IP}.`);
    socket.disconnect(true);
    return;
  }
  ipConnections.set(ip, currentSocketsForIp + 1);

  /** @type {Map<string, { strategy: import('./db/DbStrategy'), tunnel: { close: () => void }|null }>} */
  const sessions = new Map();

  async function closeSession(tabId) {
    const sess = sessions.get(tabId);
    if (!sess) return;
    // Rimuovi prima di await: evita doppie chiusure su chiamate concorrenti.
    sessions.delete(tabId);
    activeGlobalSessions--;
    await teardownConnection(sess);
  }

  async function closeAllSessions() {
    for (const tabId of [...sessions.keys()]) await closeSession(tabId);
  }

  // Registrazione sicura di un evento: payload sempre oggetto e ack sempre
  // funzione monouso — un client senza callback o con payload malformato non
  // deve mai abbattere il processo. Gli errori del handler, sincroni o async,
  // diventano la risposta { ok: false, error }.
  function safeOn(event, fn) {
    socket.on(event, async (payload, ack) => {
      let done = false;
      const cb = (res) => {
        if (!done && typeof ack === 'function') ack(res);
        done = true;
      };
      try {
        await fn(payload || {}, cb);
      } catch (err) {
        cb({ ok: false, error: errMsg(err) });
      }
    });
  }

  // Registra un evento che delega alla strategia della sessione indicata dal
  // tabId nel payload e adatta il risultato (o l'errore) al formato di
  // risposta { ok, ... } usato dal frontend.
  function delegate(event, fn) {
    safeOn(event, async (payload, cb) => {
      const sess = sessions.get(normTabId(payload.tabId));
      if (!sess) {
        cb({ ok: false, error: 'Nessuna connessione attiva al database.' });
        return;
      }
      // Classificazione (scrittura/lettura/non tracciato) per l'audit: dipende
      // da evento, payload e strategia (vedi collection:aggregate).
      const cls = classifyAudit(event, payload, sess);
      try {
        const result = await executeWithReconnect(sess, (strat) => fn(strat, payload));
        cb({ ok: true, ...result });
        auditDelegate(cls, sess, event, payload, 'ok', result, null);
      } catch (err) {
        auditDelegate(cls, sess, event, payload, 'error', null, err);
        // Se il tunnel SSH è caduto dopo l'apertura, la strategia vede solo
        // un errore di rete generico verso la porta locale ormai orfana:
        // qui lo si riconosce e si dà un messaggio chiaro invece di quello
        // del driver DB.
        if (sess.tunnel && !sess.tunnel.alive) {
          throw new Error(`Tunnel SSH caduto${sess.tunnel.lastError ? `: ${sess.tunnel.lastError}` : '.'}`);
        }
        throw err;
      }
    });
  }

  // --- Connection -----------------------------------------------------------

  safeOn('mongo:connect', async (cfg, cb) => {
    if (cfg.tabId != null && String(cfg.tabId).length > 100) {
      throw new Error('tabId non valido.');
    }
    const tabId = normTabId(cfg.tabId);
    if (!sessions.has(tabId) && sessions.size >= MAX_SESSIONS_PER_SOCKET) {
      throw new Error(`Raggiunto il limite di ${MAX_SESSIONS_PER_SOCKET} connessioni contemporanee: chiudi un tab.`);
    }
    if (!sessions.has(tabId) && activeGlobalSessions >= MAX_GLOBAL_SESSIONS) {
      throw new Error(`Raggiunto il limite globale di ${MAX_GLOBAL_SESSIONS} connessioni al database.`);
    }
    // Riconnessione sullo stesso tab: chiudi prima la sessione precedente.
    await closeSession(tabId);
    const conn = await establishConnection(cfg);
    sessions.set(tabId, {
      tabId,
      strategy: conn.strategy,
      tunnel: conn.tunnel,
      dbType: conn.dbType,
      effectiveCfg: conn.effective,
      // Metadati per l'audit delle scritture (mai segreti): etichetta mostrata
      // in UI, nome della connessione salvata (se noto) e IP del client.
      label: connLabel(conn.effective),
      connName: String(cfg.saved || cfg.saveAs || '').trim() || null,
      ip,
    });
    activeGlobalSessions++;
    try {
      // cfg.saveAs = salva (o aggiorna) la connessione, solo se funzionante.
      const saveAs = String(cfg.saveAs || '').trim();
      if (saveAs) {
        assertConnName(saveAs);
        const conns = loadConnections();
        conns[saveAs] = sanitizeConnCfg(conn.effective);
        saveConnections(conns);
      }
      cb({
        ok: true,
        tabId,
        label: connLabel(conn.effective),
        dbType: conn.dbType,
        databases: await conn.strategy.listDatabases(),
      });
    } catch (err) {
      await closeSession(tabId);
      throw err;
    }
  });

  safeOn('mongo:disconnect', async (payload, cb) => {
    await closeSession(normTabId(payload.tabId));
    cb({ ok: true });
  });

  // Prova una configurazione (o una connessione salvata) senza tenere aperto
  // nulla: connect + listDatabases + disconnect. Serve al pulsante "Testa".
  safeOn('connections:test', async (cfg, cb) => {
    if (activeGlobalSessions >= MAX_GLOBAL_SESSIONS) {
      throw new Error(`Raggiunto il limite globale di ${MAX_GLOBAL_SESSIONS} connessioni al database.`);
    }
    activeGlobalSessions++;
    let conn = null;
    try {
      conn = await establishConnection(cfg);
      const databases = await conn.strategy.listDatabases();
      cb({ ok: true, dbType: conn.dbType, label: connLabel(conn.effective), databases: databases.length });
    } finally {
      if (conn) await teardownConnection(conn);
      activeGlobalSessions--;
    }
  });

  // --- Vault & Password ------------------------------------------------------

  safeOn('vault:status', (_payload, cb) => {
    cb({ ok: true, locked: encryptionKey === null });
  });

  safeOn('vault:unlock', ({ passphrase }, cb) => {
    cb(tryUnlockVault(passphrase || ''));
  });

  // --- Connessioni salvate ----------------------------------------------------
  // Non richiedono una connessione DB attiva: servono proprio prima di averla.

  safeOn('connections:list', (_payload, cb) => {
    const connections = Object.entries(loadConnections())
      .map(([name, c]) => ({ name, label: connLabel(c), dbType: connDbType(c), folder: c.folder || '' }));
    cb({ ok: true, connections });
  });

  // Storico delle operazioni critiche/di scrittura via Web UI. Non richiede una
  // connessione DB attiva: legge il file di audit lato server (ui-audit.log).
  safeOn('audit:list', (payload, cb) => {
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(payload.offset, 10) || 0, 0);
    const { entries, total } = readUiAudit({
      limit,
      offset,
      event: payload.event ? String(payload.event) : undefined,
      db: payload.db ? String(payload.db) : undefined,
      connection: payload.connection ? String(payload.connection) : undefined,
      dbType: payload.dbType ? String(payload.dbType) : undefined,
      status: payload.status ? String(payload.status) : undefined,
      category: payload.category ? String(payload.category) : undefined,
    });
    cb({ ok: true, entries, total, offset, limit });
  });

  // Stato di salute delle connessioni attive di questo socket (una per tab):
  // latenza di ping, stato del tunnel SSH e statistiche del pool. I ping vanno
  // in parallelo con un timeout, così una connessione morta non blocca il resto.
  safeOn('health:connections', async (_payload, cb) => {
    const entries = await Promise.all([...sessions.entries()].map(async ([tabId, sess]) => {
      const entry = {
        tabId,
        label: sess.label || null,
        connName: sess.connName || null,
        dbType: sess.dbType || (sess.strategy && sess.strategy.type) || null,
        ssh: sess.tunnel
          ? { active: true, alive: !!sess.tunnel.alive, host: sess.tunnel.host, port: sess.tunnel.port, lastError: sess.tunnel.lastError || null }
          : { active: false },
      };
      const checkPing = async () => {
        const h = await withTimeout(sess.strategy.health(), 5000, 'Ping');
        entry.status = 'ok';
        entry.latencyMs = h.latencyMs;
        entry.pool = h.pool || null;
        if (h.extra) entry.extra = h.extra;
      };

      if (sess.tunnel && !sess.tunnel.alive) {
        if (sess.effectiveCfg) {
          try {
            await reconnectSession(sess);
            await checkPing();
            entry.ssh = sess.tunnel
              ? { active: true, alive: !!sess.tunnel.alive, host: sess.tunnel.host, port: sess.tunnel.port }
              : { active: false };
            return entry;
          } catch (recErr) {
            entry.status = 'error';
            entry.error = errMsg(recErr);
            return entry;
          }
        } else {
          entry.status = 'error';
          entry.error = `Tunnel SSH caduto${sess.tunnel.lastError ? `: ${sess.tunnel.lastError}` : '.'}`;
          return entry;
        }
      }

      try {
        await checkPing();
      } catch (err) {
        if (isConnectionError(err, sess) && sess.effectiveCfg) {
          try {
            await reconnectSession(sess);
            await checkPing();
          } catch (recErr) {
            entry.status = 'error';
            entry.error = errMsg(recErr);
          }
        } else {
          entry.status = 'error';
          entry.error = errMsg(err);
        }
      }
      return entry;
    }));
    cb({ ok: true, connections: entries });
  });

  safeOn('connections:delete', ({ name }, cb) => {
    const conns = loadConnections();
    if (!conns[name]) throw new Error(`Connessione salvata "${name}" non trovata.`);
    delete conns[name];
    saveConnections(conns);
    cb({ ok: true });
  });

  // Campi di una connessione salvata per popolarne il form di modifica.
  // La password non viene mai rimandata al browser: si segnala solo se esiste.
  safeOn('connections:get', ({ name }, cb) => {
    const conn = loadConnections()[name];
    if (!conn) throw new Error(`Connessione salvata "${name}" non trovata.`);
    const fields = { ...conn };
    const has = (f) => conn[f] != null && conn[f] !== '';
    const flags = { hasPassword: has('password'), hasSshPassword: has('sshPassword'), hasSshPassphrase: has('sshPassphrase') };
    for (const f of SECRET_FIELDS) delete fields[f];
    cb({ ok: true, fields, ...flags });
  });

  // Crea o aggiorna una connessione salvata senza connettersi. oldName, se
  // diverso da name, rinomina la connessione. Password vuota nel form =
  // mantieni quella già salvata.
  safeOn('connections:save', ({ name, oldName, cfg }, cb) => {
    name = String(name || '').trim();
    assertConnName(name);
    const conns = loadConnections();
    const previous = oldName ? conns[oldName] : conns[name];
    if (oldName && !previous) throw new Error(`Connessione salvata "${oldName}" non trovata.`);
    // Il nome è la chiave della sezione .ini: due connessioni con lo stesso nome
    // si sovrascriverebbero. Rifiuta se il nome è già in uso da un'ALTRA
    // connessione (nuova connessione, o modifica che rinomina su un nome occupato).
    if (conns[name] && name !== oldName) {
      throw new Error(`Esiste già una connessione chiamata "${name}". Scegli un nome diverso.`);
    }
    const next = sanitizeConnCfg(cfg || {});
    if (previous) {
      for (const f of SECRET_FIELDS) {
        if (!next[f] && previous[f]) next[f] = previous[f];
      }
    }
    if (oldName && oldName !== name) delete conns[oldName];
    conns[name] = next;
    saveConnections(conns);
    cb({ ok: true });
  });

  // Esporta il file .ini completo (password incluse, ma cifrate). Con
  // `passphrase` i segreti vengono ri-cifrati con la sua chiave (SHA256), così
  // il file è importabile su un'installazione che gira con QUELLA passphrase —
  // senza mai esporre i segreti in chiaro. Vuota = passphrase di questa
  // installazione (comportamento storico). I segreti sono comunque decifrati in
  // memoria da loadConnections e ri-cifrati qui, mai trasmessi in chiaro.
  safeOn('connections:export', ({ passphrase } = {}, cb) => {
    const conns = loadConnections();
    if (!Object.keys(conns).length) throw new Error('Nessuna connessione salvata da esportare.');
    const pass = passphrase == null ? '' : String(passphrase);
    const cryptoKey = pass !== '' ? crypto.createHash('sha256').update(pass).digest() : encryptionKey;
    const toSave = encryptSections(conns, cryptoKey);
    cb({ ok: true, ini: stringifyIni(toSave) });
  });

  // Importa connessioni da un file .ini: le sezioni con lo stesso nome di una
  // connessione esistente vengono sovrascritte, le altre aggiunte.
  safeOn('connections:import', ({ ini }, cb) => {
    const incoming = parseIni(String(ini || ''));
    const names = Object.keys(incoming);
    if (!names.length) throw new Error('Nessuna connessione trovata nel file importato.');
    const conns = loadConnections();
    let imported = 0;
    let overwritten = 0;
    for (const name of names) {
      assertConnName(name);
      const cfg = sanitizeConnCfg(incoming[name]);
      if (!Object.keys(cfg).length) continue; // sezione senza campi utili
      // I segreti cifrati devono decifrarsi con la passphrase corrente: un
      // "ENC:" estraneo verrebbe scoperto solo al riavvio, e con
      // decryptFailures > 0 il server rifiuterebbe di partire.
      for (const f of SECRET_FIELDS) {
        if (cfg[f] && cfg[f].startsWith('ENC:')) {
          try {
            decryptRaw(cfg[f]);
          } catch {
            throw new Error(`Il segreto "${f}" della connessione "${name}" è cifrato con un'altra passphrase: esporta/importa con la stessa passphrase, oppure rimuovi i segreti dal file e reinseriscili dopo l'import.`);
          }
        }
      }
      if (conns[name]) overwritten += 1; else imported += 1;
      conns[name] = cfg;
    }
    if (!imported && !overwritten) throw new Error('Il file non contiene connessioni valide.');
    saveConnections(conns);
    cb({ ok: true, imported, overwritten });
  });

  // --- Esplorazione e gestione database (delegati alla strategia) ------------

  delegate('db:list', async (strategy) => ({ databases: await strategy.listDatabases() }));
  delegate('db:search', async (strategy, { query }) => ({ databases: await strategy.search(query) }));
  delegate('db:collections', async (strategy, { db }) => ({ collections: await strategy.listCollections(db) }));
  delegate('db:create', async (strategy, { db, coll }) => { await strategy.createDatabase(db, coll); return {}; });
  delegate('db:rename', async (strategy, { db, newName }) => { await strategy.renameDatabase(db, newName); return {}; });
  delegate('db:drop', async (strategy, { db }) => { await strategy.dropDatabase(db); return {}; });
  delegate('db:schema', (strategy, { db }) => strategy.dbSchema(db));

  // --- Gestione collection/tabelle, colonne e indici ---------------------------

  delegate('collection:create', async (strategy, p) => { await strategy.createCollection(p.db, p.name, p); return {}; });
  delegate('collection:rename', async (strategy, p) => { await strategy.renameCollection(p.db, p.coll, p.newName); return {}; });
  delegate('collection:drop', async (strategy, p) => { await strategy.dropCollection(p.db, p.coll); return {}; });
  delegate('column:add', (strategy, p) => strategy.addColumn(p.db, p.coll, p.column));
  delegate('column:alter', (strategy, p) => strategy.alterColumn(p.db, p.coll, p));
  delegate('column:drop', (strategy, p) => strategy.dropColumn(p.db, p.coll, p.name));
  delegate('index:create', (strategy, p) => strategy.createIndex(p.db, p.coll, p));
  delegate('index:drop', async (strategy, p) => { await strategy.dropIndex(p.db, p.coll, p.name); return {}; });

  // --- Query, dettagli e mutazioni --------------------------------------------

  delegate('collection:stats', (strategy, { db, coll }) => strategy.collectionStats(db, coll));
  delegate('collection:find', (strategy, p) => strategy.collectionFind(p.db, p.coll, p));
  // Conteggio totale disaccoppiato: la griglia carica prima i documenti
  // (total = null) e chiede il conteggio a parte, così non aspetta la scansione
  // completa su collection/tabelle enormi. Lettura di chrome: non tracciata.
  delegate('collection:count', (strategy, p) => strategy.collectionCount(p.db, p.coll, p));
  delegate('collection:aggregate', (strategy, p) => strategy.collectionAggregate(p.db, p.coll, p));
  delegate('collection:explain', (strategy, p) => strategy.collectionExplain(p.db, p.coll, p));
  delegate('doc:insert', (strategy, p) => strategy.docInsert(p.db, p.coll, p));
  delegate('doc:update', (strategy, p) => strategy.docUpdate(p.db, p.coll, p));
  delegate('doc:replace', (strategy, p) => strategy.docReplace(p.db, p.coll, p));
  delegate('doc:delete', (strategy, p) => strategy.docDelete(p.db, p.coll, p));
  delegate('collection:deleteMany', (strategy, p) => strategy.collectionDeleteMany(p.db, p.coll, p));

  // --- Esecutore dinamico Query & Virtual JOINs -------------------------------
  safeOn('query:execute', async (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    const session = sessions.get(tabId);
    if (!session || !session.strategy) {
      throw new Error('Nessuna connessione attiva al database per questo tab.');
    }

    let { code, engine, db, coll } = payload;
    const codeStr = String(code || '').trim();

    if (!codeStr) {
      throw new Error('Codice query vuoto.');
    }

    // Modalità Cross-DB (Virtual Join)
    if (engine === 'crossdb' || codeStr.includes('"virtualJoin"')) {
      let spec;
      try {
        spec = JSON.parse(codeStr);
      } catch (err) {
        throw new Error('La query Virtual Join deve essere un oggetto JSON valido: ' + err.message);
      }
      try {
        const docs = await executeWithReconnect(session, (strat) => VirtualJoinEngine.execute(spec, strat, strat));
        auditQuery(session, db || null, coll || null, codeStr, 'read', 'Virtual JOIN Cross-DB', 'ok', { docs }, null);
        return cb({ ok: true, docs, data: docs });
      } catch (err) {
        auditQuery(session, db || null, coll || null, codeStr, 'read', 'Virtual JOIN Cross-DB', 'error', null, err);
        throw err;
      }
    }

    // Estrazione automatica della collezione/tabella dal FROM della query SQL (es. SELECT * FROM pippo)
    const sqlFromMatch = codeStr.match(/FROM\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?/i);
    const extractedColl = sqlFromMatch ? sqlFromMatch[1] : null;
    const targetColl = extractedColl || coll;
    const targetDb = db || session.strategy.currentDb || 'admin';

    // Modalità SQL (MySQL e PostgreSQL: Strategy Pattern, stesso "SQL Raw").
    if (engine === 'mysql' || engine === 'postgresql' || DbFactory.isSqlType(session.strategy.type)) {
      const write = isWriteSql(codeStr);
      const cat = write ? 'write' : 'read';
      const op = write ? 'Query di scrittura (SQL)' : 'Query di lettura (SQL)';
      try {
        const res = await executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS }));
        auditQuery(session, targetDb, targetColl, codeStr, cat, op, 'ok', res, null);
        return cb({ ok: true, ...res, data: res.docs });
      } catch (err) {
        auditQuery(session, targetDb, targetColl, codeStr, cat, op, 'error', null, err);
        throw err;
      }
    }

    // Modalità NoSQL (MongoDB)
    if (engine === 'mongodb' || session.strategy.type === 'mongodb') {
      let res;
      let cat = 'read';
      let op = 'Query di lettura (MQL)';
      // Collection effettivamente interrogata: shell/SQL possono indicarne una
      // diversa da quella attiva (plan.coll); l'audit deve registrare questa.
      let queryColl = targetColl;
      try {
        if (codeStr.startsWith('[')) {
          // Pipeline MQL EJSON (scrittura solo con $out/$merge)
          if (!targetColl) throw new Error('Seleziona una collezione dallo Schema Browser o apri un tab collezione.');
          assertNoServerJs(safeParseForScan(codeStr));
          if (isWriteMongoPipeline(codeStr)) { cat = 'write'; op = 'Pipeline di scrittura ($out/$merge)'; }
          else { op = 'Aggregazione (pipeline)'; }
          res = await executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS }));
        } else if (codeStr.startsWith('{')) {
          // MQL Filter JSON: il filtro va passato come payload.filter (stringa),
          // non come intero payload, altrimenti collectionFind lo ignorerebbe.
          let parsed;
          try {
            parsed = JSON.parse(codeStr);
          } catch (e) {
            throw new Error('Filtro JSON MongoDB non valido: ' + e.message);
          }
          if (!targetColl) throw new Error('Seleziona una collezione dallo Schema Browser o apri un tab collezione.');
          assertNoServerJs(parsed);
          op = 'Query di lettura (filtro MQL)';
          res = await executeWithReconnect(session, (strat) => strat.collectionFind(targetDb, targetColl, { filter: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS }));
        } else {
          // Né JSON né pipeline: prova la sintassi nativa shell (db.coll.find...)
          // oppure una SELECT SQL. Entrambe producono lo stesso "plan".
          let plan = null;
          let planLabel = '';
          if (MongoShell.looksLikeShell(codeStr)) {
            try {
              plan = MongoShell.translate(codeStr);
            } catch (e) {
              throw new Error('Comando shell MongoDB non valido: ' + e.message);
            }
            planLabel = 'shell';
          } else if (SqlToMql.looksLikeSql(codeStr)) {
            try {
              plan = SqlToMql.translate(codeStr);
            } catch (e) {
              throw new Error('Traduzione SQL→MongoDB non riuscita: ' + e.message);
            }
            planLabel = 'SQL→MQL';
          }

          if (plan) {
            const collName = plan.coll || targetColl;
            if (!collName) throw new Error('Collezione non specificata nel comando.');
            queryColl = collName;
            if (plan.kind === 'aggregate') {
              assertNoServerJs(plan.pipeline);
              op = `Query di lettura (${planLabel} aggregate)`;
              res = await executeWithReconnect(session, (strat) =>
                strat.collectionAggregate(targetDb, collName, { pipeline: JSON.stringify(plan.pipeline), maxRows: QUERY_ENGINE_MAX_ROWS }));
            } else {
              assertNoServerJs(plan.filter);
              op = `Query di lettura (${planLabel})`;
              res = await executeWithReconnect(session, (strat) =>
                strat.collectionFind(targetDb, collName, {
                  filter: JSON.stringify(plan.filter),
                  projection: JSON.stringify(plan.projection),
                  sort: JSON.stringify(plan.sort),
                  limit: plan.limit,
                  skip: plan.skip,
                  maxRows: QUERY_ENGINE_MAX_ROWS,
                }));
            }
          } else {
            if (!targetColl) throw new Error('Seleziona una collezione dallo Schema Browser o specifica una query valida.');
            res = await executeWithReconnect(session, (strat) => strat.collectionFind(targetDb, targetColl, { filter: '', maxRows: QUERY_ENGINE_MAX_ROWS }));
          }
        }
      } catch (err) {
        auditQuery(session, targetDb, queryColl, codeStr, cat, op, 'error', null, err);
        throw err;
      }
      auditQuery(session, targetDb, queryColl, codeStr, cat, op, 'ok', res, null);
      return cb({ ok: true, ...res, data: res.docs });
    }

    throw new Error('Target Engine non supportato.');
  });

  // --- Export / import di collection e tabelle ---------------------------------
  // Export: il client richiede blocchi successivi (skip/limit) e assembla il
  // file; import: il client invia batch di documenti/righe in Extended JSON.

  delegate('collection:export', (strategy, p) => strategy.collectionExport(p.db, p.coll, p));
  delegate('collection:import', (strategy, p) => strategy.collectionImport(p.db, p.coll, p));
  // DDL della tabella (CREATE TABLE, solo MySQL; null per MongoDB): usato
  // dall'export di interi database per rendere il file auto-contenuto.
  delegate('collection:ddl', async (strategy, p) => ({ ddl: await strategy.tableDdl(p.db, p.coll) }));

  // --- Aggiornamenti in tempo reale -------------------------------------------
  // I DBMS senza change stream (MySQL) falliscono qui: il frontend nasconde
  // semplicemente il badge LIVE.

  safeOn('collection:watch', ({ db, coll, tabId }, cb) => {
    const tab = normTabId(tabId);
    const sess = sessions.get(tab);
    if (!sess) {
      cb({ ok: false, error: 'Nessuna connessione attiva al database.' });
      return;
    }
    // Gli eventi push sono taggati col tabId: il frontend li instrada al tab.
    sess.strategy.watch(db, coll, {
      onChange: (change) => socket.emit('collection:changed', { tabId: tab, db, coll, ...change }),
      onUnavailable: () => socket.emit('watch:unavailable', { tabId: tab, db, coll }),
    });
    cb({ ok: true });
  });

  safeOn('collection:unwatch', (payload) => {
    const sess = sessions.get(normTabId(payload.tabId));
    if (sess) sess.strategy.unwatch();
  });

  // Watch dello schema (database/collection creati, rinominati o eliminati):
  // dove il change stream non c'è (MySQL, Mongo standalone) arriva subito
  // schema:unavailable e il frontend ripiega sul polling della sidebar.
  safeOn('schema:watch', (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    const sess = sessions.get(tabId);
    if (!sess) {
      cb({ ok: false, error: 'Nessuna connessione attiva al database.' });
      return;
    }
    sess.strategy.watchSchema({
      onChange: (change) => socket.emit('schema:changed', { tabId, ...change }),
      onUnavailable: () => socket.emit('schema:unavailable', { tabId }),
    });
    cb({ ok: true });
  });

  safeOn('schema:unwatch', (payload) => {
    const sess = sessions.get(normTabId(payload.tabId));
    if (sess) sess.strategy.unwatchSchema();
  });

  // --- Operazioni Backup & Restore -------------------------------------------

  safeOn('backup:run', async (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    const sess = sessions.get(tabId);
    if (!sess) throw new Error('Nessuna connessione attiva per questo tab.');
    const db = String(payload.db || '').trim();
    if (!db) throw new Error('Nome database mancante.');
    const type = String(payload.type || 'full').toLowerCase();
    if (!['full', 'incremental', 'differential'].includes(type)) {
      throw new Error(`Tipo backup non valido: ${type}`);
    }
    const onlyCollections = payload.collections
      ? String(payload.collections).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const destRoot = path.resolve(payload.dest || BACKUP_ROOT);
    const storage = parseStorage(payload.storage);
    const webhook = payload.slackWebhook || process.env.SLACK_WEBHOOK_URL;
    const log = createLogger(path.join(destRoot, 'backup.log'), { quiet: true });
    const level = Math.min(Math.max(parseInt(payload.compressLevel, 10) || 1, 1), 9);
    const compress = payload.noCompress !== true;

    const t0 = Date.now();
    const connName = payload.connName || payload.label || 'ui-session';
    try {
      const summary = await log.run(`backup ${type} conn=${connName} db=${db} (via UI)`, async () => {
        const result = await runBackup({
          session: { strategy: sess.strategy, dbType: sess.dbType || sess.strategy.type }, connName, db, type, onlyCollections,
          sinceField: payload.sinceField ? String(payload.sinceField).trim() : null,
          destRoot, compress, level, log,
        });
        if (storage) await uploadBackupDir(storage, result.backupDir, log);
        return result;
      });
      await notifySlack(webhook, `✅ CodeDB backup *${type}* di \`${db}\` (${connName}, via UI) riuscito in ${formatDuration(Date.now() - t0)}: ${summary.totalDocs} documenti/righe, ${formatBytes(summary.totalBytes)}.`, log);
      auditWrite(sess, 'backup:run', { db }, { op: 'Backup', backupType: type, backupId: summary.id }, 'ok', summary, null);
      cb({ ok: true, summary });
    } catch (err) {
      await notifySlack(webhook, `❌ CodeDB backup *${type}* di \`${db}\` (${connName}, via UI) FALLITO dopo ${formatDuration(Date.now() - t0)}: ${errMsg(err)}`, log);
      auditWrite(sess, 'backup:run', { db }, { op: 'Backup', backupType: type }, 'error', null, err);
      throw err;
    }
  });

  safeOn('backup:list', ({ dest }, cb) => {
    const destRoot = path.resolve(dest || BACKUP_ROOT);
    const groups = {};
    if (fs.existsSync(destRoot)) {
      for (const entry of fs.readdirSync(destRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const { backups } = readCatalog(path.join(destRoot, entry.name));
        if (backups.length) groups[entry.name] = backups;
      }
    }
    cb({ ok: true, groups });
  });

  safeOn('backup:restore', async (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    const sess = sessions.get(tabId);
    if (!sess) throw new Error('Nessuna connessione attiva per questo tab.');

    let backupDir = payload.from ? path.resolve(payload.from) : null;
    if (!backupDir && payload.group && payload.backupId) {
      const group = String(payload.group).trim();
      const backupId = String(payload.backupId).trim();
      if (!/^[\w.-]+$/.test(group) || !/^[\w.-]+$/.test(backupId)) {
        throw new Error('Parametri "group" o "backupId" non validi.');
      }
      backupDir = path.join(BACKUP_ROOT, group, backupId);
    }
    if (!backupDir || !fs.existsSync(path.join(backupDir, 'manifest.json'))) {
      throw new Error('Cartella backup non valida o manifest.json mancante.');
    }

    const destRoot = path.resolve(payload.dest || BACKUP_ROOT);
    const webhook = payload.slackWebhook || process.env.SLACK_WEBHOOK_URL;
    const log = createLogger(path.join(destRoot, 'backup.log'), { quiet: true });
    const onlyCollections = payload.collections
      ? String(payload.collections).split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    const t0 = Date.now();
    const connName = payload.connName || 'ui-session';
    try {
      const summary = await log.run(`restore conn=${connName} da=${path.basename(backupDir)} (via UI)`, async () => {
        return await runRestore({
          session: { strategy: sess.strategy, dbType: sess.dbType || sess.strategy.type }, backupDir,
          targetDb: payload.targetDb || null,
          onlyCollections, drop: !!payload.drop, log,
        });
      });
      await notifySlack(webhook, `✅ CodeDB restore di \`${summary.targetDb}\` (${connName}, via UI) riuscito in ${formatDuration(Date.now() - t0)}: ${summary.totalDocs} documenti/righe.`, log);
      auditWrite(sess, 'backup:restore', { db: summary.targetDb }, { op: 'Ripristino backup', backupId: String(payload.backupId || '').trim() || undefined }, 'ok', summary, null);
      cb({ ok: true, summary });
    } catch (err) {
      await notifySlack(webhook, `❌ CodeDB restore (${connName}, via UI) FALLITO dopo ${formatDuration(Date.now() - t0)}: ${errMsg(err)}`, log);
      auditWrite(sess, 'backup:restore', { db: payload.targetDb || null }, { op: 'Ripristino backup', backupId: String(payload.backupId || '').trim() || undefined }, 'error', null, err);
      throw err;
    }
  });

  safeOn('backup:verify', async (payload, cb) => {
    let backupDir = payload.from ? path.resolve(payload.from) : null;
    if (!backupDir && payload.group && payload.backupId) {
      const group = String(payload.group).trim();
      const backupId = String(payload.backupId).trim();
      if (!/^[\w.-]+$/.test(group) || !/^[\w.-]+$/.test(backupId)) {
        throw new Error('Parametri "group" o "backupId" non validi.');
      }
      backupDir = path.join(BACKUP_ROOT, group, backupId);
    }
    if (!backupDir || !fs.existsSync(path.join(backupDir, 'manifest.json'))) {
      throw new Error('Cartella backup non trovata o manifest.json mancante.');
    }
    const manifest = readManifest(backupDir);
    let ok = 0;
    let failed = 0;
    const details = [];
    for (const f of manifest.files) {
      if (!f.sha256) continue;
      const full = path.join(backupDir, f.path);
      if (!fs.existsSync(full)) {
        details.push({ file: f.path, status: 'MISSING' });
        failed++;
        continue;
      }
      const actual = await sha256File(full);
      if (actual === f.sha256) {
        details.push({ file: f.path, status: 'OK' });
        ok++;
      } else {
        details.push({ file: f.path, status: 'CORRUPTED', expected: f.sha256, actual });
        failed++;
      }
    }
    cb({
      ok: true,
      backupId: manifest.id,
      okCount: ok,
      failedCount: failed,
      valid: failed === 0,
      details,
    });
  });

  socket.on('disconnect', () => {
    closeAllSessions();

    const count = ipConnections.get(ip);
    if (count > 1) {
      ipConnections.set(ip, count - 1);
    } else {
      ipConnections.delete(ip);
    }
  });
});

async function startServer() {
  const passphrase = process.env.GUI_MONGO_PASSPHRASE;
  if (passphrase) {
    const res = tryUnlockVault(passphrase);
    if (!res.ok) {
      console.error('Passphrase errata fornita via GUI_MONGO_PASSPHRASE: i segreti non si decifrano.');
      process.exit(1);
    }
  }

  const HOST = process.env.HOST || '127.0.0.1';
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`La porta ${PORT} è già in uso: probabilmente CodeDB è già in esecuzione.`);
      console.error(`Apri http://localhost:${PORT} nel browser, oppure avvia una seconda istanza con PORT=<altra porta>.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, HOST, () => {
    console.log(`CodeDB in ascolto su http://${HOST}:${PORT}`);
    console.log(`Endpoint MCP (Streamable HTTP) su http://${HOST}:${PORT}/mcp`);
  });
}

startServer();
