'use strict';

// Infrastruttura condivisa dai test RBAC (e2e-rbac.js ed e2e-rbac-mcp.js).
//
// A differenza degli altri e2e, questi NON usano il server già avviato su :3030:
// l'RBAC va provato su un'istanza con un ambiente preciso (control plane,
// owner, limiti di piano), quindi il server viene avviato qui come processo
// figlio su una porta dedicata, con un connections.ini temporaneo.
//
// Richiede un MongoDB locale (control plane + database di prova).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoClient } = require('mongodb');

const PORT = parseInt(process.env.RBAC_PORT, 10) || 3131;
const BASE = `http://127.0.0.1:${PORT}`;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';

const APP_DB = 'codedb_rbac_e2e';        // control plane (utenti, ruoli, grant)
const DATA_DB = 'gui_mongodb_e2e_rbac';  // database "dell'utente" su cui provare i permessi
const CONN_NAME = 'e2e-rbac';            // connessione salvata nel .ini temporaneo
const OTHER_CONN = 'e2e-rbac-negata';    // connessione senza grant per il sottoutente

const OWNER = { email: 'owner@e2e.local', password: 'owner-password-123' };
const VIEWER = { email: 'viewer@e2e.local', password: 'viewer-password-123' };

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return true;
    } catch { /* non ancora in ascolto */ }
    await sleep(200);
  }
  throw new Error(`Il server RBAC non è partito su ${BASE} entro il timeout.`);
}

/**
 * Avvia un'istanza di CodeDB con RBAC attivo e un connections.ini temporaneo.
 * @returns {Promise<{ proc: import('child_process').ChildProcess, dir: string }>}
 */
async function startRbacServer({ maxSubUsers = 1, verbose = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-rbac-'));
  const iniPath = path.join(dir, 'connections.ini');
  fs.writeFileSync(iniPath, [
    `[${CONN_NAME}]`,
    'dbType=mongodb',
    'host=localhost',
    'port=27017',
    'readOnly=false',
    '',
    `[${OTHER_CONN}]`,
    'dbType=mongodb',
    'host=localhost',
    'port=27017',
    '',
  ].join('\n'), 'utf8');

  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CODEDB_RBAC: 'on',
      CODEDB_ENTITLEMENT: 'local',
      CODEDB_APP_DB_URI: MONGO_URI,
      CODEDB_APP_DB_NAME: APP_DB,
      CODEDB_OWNER_EMAIL: OWNER.email,
      CODEDB_OWNER_PASSWORD: OWNER.password,
      CODEDB_MAX_SUBUSERS: String(maxSubUsers),
      CODEDB_CONNECTIONS_FILE: iniPath,
      CODEDB_UI_AUDIT_FILE: path.join(dir, 'ui-audit.log'),
      CODEDB_MCP_AUDIT_FILE: path.join(dir, 'mcp-audit.log'),
      CODEDB_BACKUPS_DIR: path.join(dir, 'backups'),
    },
    stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (!verbose) {
    // Utile quando il server rifiuta di partire (control plane irraggiungibile).
    proc.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  }
  proc.on('exit', (code) => {
    if (code && code !== 0) console.error(`[server] terminato con codice ${code}`);
  });

  await waitForServer();
  return { proc, dir };
}

async function stopRbacServer(handle) {
  if (!handle) return;
  if (handle.proc && !handle.proc.killed) {
    handle.proc.kill('SIGTERM');
    // Il graceful shutdown chiude MCP, socket e control plane.
    await Promise.race([
      new Promise((r) => handle.proc.once('exit', r)),
      sleep(6000).then(() => handle.proc.kill('SIGKILL')),
    ]);
  }
  if (handle.dir) fs.rmSync(handle.dir, { recursive: true, force: true });
}

/** Popola il database di prova: `orders` (in scope) e `customers` (fuori scope). */
async function seedData() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DATA_DB);
  await db.collection('orders').deleteMany({});
  await db.collection('customers').deleteMany({});
  await db.collection('orders').insertMany([{ code: 'A-1', total: 10 }, { code: 'A-2', total: 20 }]);
  await db.collection('customers').insertMany([{ name: 'Ada' }]);
  await client.close();
}

/** Rimuove control plane e database di prova. */
async function cleanupMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  await client.db(APP_DB).dropDatabase().catch(() => {});
  await client.db(DATA_DB).dropDatabase().catch(() => {});
  await client.close();
}

/** POST /auth/login → { ok, token, user } (non lancia sui 401: li verifichiamo). */
async function login(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}

module.exports = {
  PORT, BASE, MONGO_URI, APP_DB, DATA_DB, CONN_NAME, OTHER_CONN, OWNER, VIEWER,
  assert, sleep, startRbacServer, stopRbacServer, seedData, cleanupMongo, login,
};
