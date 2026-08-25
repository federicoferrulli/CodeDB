'use strict';

/* ---------------------------------------------------------------------------
 * Istanza CodeDB usa e getta per i test end-to-end.
 *
 * PERCHÉ ESISTE
 * I test e2e si collegavano al server che l'utente aveva già avviato su :3030 e
 * usavano `connections:save`/`saveAs`/`connections:delete`: scrivevano quindi nel
 * connections.ini DI PRODUZIONE. Ogni salvataggio fa ruotare i backup
 * (file → .bak → .bak2), quindi due esecuzioni consecutive dei test consumavano
 * entrambe le generazioni di sicurezza; e se il server era stato avviato con la
 * passphrase sbagliata, la riscrittura propagava il danno dopo che le copie
 * buone erano già sparite. I test di backup e RBAC erano già isolati, questi no.
 *
 * COSA FA
 * Avvia `server.js` come processo figlio su una porta dedicata, con:
 *  · un `connections.ini` temporaneo (CODEDB_CONNECTIONS_FILE),
 *  · audit e backup in una cartella temporanea,
 *  · RBAC spento (i test e2e provano il comportamento mono-utente).
 * Alla fine il processo viene terminato e la cartella rimossa: il vault reale
 * dell'utente non viene mai né letto né scritto.
 *
 * Se una porta viene indicata a mano (env `E2E_PORT`) e su quella porta risponde
 * già qualcosa, l'avvio fallisce con un messaggio esplicito invece di riusare
 * un'istanza sconosciuta.
 * ------------------------------------------------------------------------- */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = parseInt(process.env.E2E_PORT, 10) || 3141;

/**
 * Registro di proprieta dei bersagli distruttivi della singola fixture.
 * `destructive: true` e' il flag esplicito: senza, il primo drop e' rifiutato.
 */
function createE2eTargetRegistry({ destructive = false, prefix = 'codedb_e2e' } = {}) {
  const environmentAllowsDestruction = process.env.CODEDB_E2E_DESTRUCTIVE === '1';
  const marker = crypto.randomBytes(6).toString('hex');
  const owned = new Set();
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'codedb_e2e';
  return {
    marker,
    target(label) {
      const safeLabel = String(label).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 20) || 'target';
      const name = `${safePrefix}_${safeLabel}_${marker}`;
      owned.add(name);
      return name;
    },
    assertOwned(name) {
      if (!destructive || !environmentAllowsDestruction) {
        throw new Error(
          'Comando distruttivo E2E rifiutato: servono destructive: true e CODEDB_E2E_DESTRUCTIVE=1.'
        );
      }
      if (!owned.has(String(name)) || !String(name).endsWith(`_${marker}`)) {
        throw new Error(`Bersaglio distruttivo E2E non posseduto dalla fixture corrente: "${name}".`);
      }
      return true;
    },
    async drop(name, action) {
      this.assertOwned(name);
      return action(name);
    },
    targets() { return [...owned]; },
    async cleanup(action) {
      for (const name of [...owned].reverse()) {
        this.assertOwned(name);
        await action(name);
      }
      owned.clear();
    },
  };
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Il server di test non ha risposto su 127.0.0.1:${port} entro ${timeoutMs} ms.`);
}

/**
 * Avvia l'istanza di test.
 * @param {{ port?: number, verbose?: boolean, env?: Record<string,string> }} opts
 * @returns {Promise<{ port: number, url: string, dir: string, stop: () => Promise<void> }>}
 */
async function startTestServer({ port = DEFAULT_PORT, verbose = false, env = {} } = {}) {
  if (await ping(port)) {
    throw new Error(
      `La porta ${port} è già occupata: i test e2e devono avviare una PROPRIA istanza, ` +
      'per non scrivere nel connections.ini reale. Libera la porta oppure indicane un\'altra con E2E_PORT.'
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-e2e-'));
  const iniPath = path.join(dir, 'connections.ini');
  fs.writeFileSync(iniPath, '', 'utf8');

  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEDB_RBAC: 'off',
      // Vault isolato: nessun segreto reale viene letto o riscritto.
      CODEDB_CONNECTIONS_FILE: iniPath,
      CODEDB_CONNECTIONS_DIR: path.join(dir, 'conns'),
      CODEDB_UI_AUDIT_FILE: path.join(dir, 'ui-audit.log'),
      CODEDB_MCP_AUDIT_FILE: path.join(dir, 'mcp-audit.log'),
      CODEDB_BACKUPS_DIR: path.join(dir, 'backups'),
      // La passphrase del vault reale non deve mai arrivare all'istanza di test.
      GUI_MONGO_PASSPHRASE: '',
      ...env,
    },
    stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (!verbose) {
    proc.stderr.on('data', (b) => process.stderr.write(`[server-e2e] ${b}`));
  }

  let exited = false;
  proc.on('exit', (code) => {
    exited = true;
    if (code && code !== 0) console.error(`[server-e2e] terminato con codice ${code}`);
  });

  try {
    await waitForServer(port);
  } catch (err) {
    try { proc.kill(); } catch { /* ignora */ }
    throw err;
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    dir,
    async stop() {
      if (!exited) {
        proc.kill();
        // Piccola attesa per lasciar chiudere socket e connessioni DB.
        await new Promise((r) => setTimeout(r, 300));
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignora */ }
    },
  };
}

module.exports = { startTestServer, DEFAULT_PORT, createE2eTargetRegistry };
