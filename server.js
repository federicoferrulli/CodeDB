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
const { splitStatementsDetailed, stripSqlNoise } = require('./db/sqlText');
const { createScriptRun } = require('./db/ScriptRunner');
const MongoScriptRunner = require('./db/MongoScriptRunner');
const Vault = require('./db/vault');
const { spiegaErrore } = require('./db/errors');

// Versione dichiarata al client dall'evento `app:info` (guida introduttiva).
// Letta una volta sola all'avvio: non cambia mentre il processo è vivo.
const APP_VERSION = (() => {
  try { return require('./package.json').version || null; } catch { return null; }
})();

const { runBackup } = require('./backup/lib/engine');
const { runRestore } = require('./backup/lib/restore');
const { parseStorage, uploadBackupDir } = require('./backup/lib/storage');
const { createLogger, formatDuration } = require('./backup/lib/logger');
const { readCatalog, readManifest, sha256File, formatBytes } = require('./backup/lib/util');
const { notifySlack } = require('./backup/lib/notify');

const { ROOT_PRINCIPAL, rbacOn } = require('./auth/principal');
const { AppStore } = require('./auth/AppStore');
const { createEntitlementProvider } = require('./auth/EntitlementProvider');
const { guardStrategy } = require('./auth/guardStrategy');
const { isWriteSql, isWriteMongoPipeline, eventCapability } = require('./auth/capabilities');
const { can, allowedConnections, canUseConnection, canWholeConnection } = require('./auth/permissions');

const BACKUP_ROOT = process.env.CODEDB_BACKUPS_DIR || path.join(__dirname, 'backups');

// Politiche sulle destinazioni di backup richieste da un client (percorso
// locale, storage cloud, webhook): vedi backup/lib/policy.js. La CLI non le usa.
const { resolveBackupPath: confineBackupPath, resolveStorageAlias, resolveSlackWebhook } = require('./backup/lib/policy');
const resolveBackupPath = (raw, what) => confineBackupPath(raw, BACKUP_ROOT, what);

// Audit log delle operazioni critiche/di scrittura eseguite dalla Web UI, su un
// file separato da quello del gateway MCP (mcp-audit.log) ma con lo stesso
// formato/rotazione (db/AuditLog.js). CODEDB_UI_AUDIT_FILE lo sposta nella
// cartella dati utente per l'app Electron pacchettizzata e isola i test.
const UI_AUDIT_FILE = process.env.CODEDB_UI_AUDIT_FILE || path.join(__dirname, 'ui-audit.log');
const { audit: auditUi, readRecent: readUiAudit } = makeAuditor(UI_AUDIT_FILE);

const PORT = process.env.PORT || 3030;

const app = express();

// Reverse proxy davanti a CodeDB (CDB-19): senza questa impostazione `req.ip` è
// l'indirizzo del PROXY, uguale per tutti, quindi il freno ai tentativi di login
// diventa un blocco globale — cinque password sbagliate di chiunque chiudono
// l'accesso a tutti. Con essa, Express legge X-Forwarded-For.
//
// È legata a CODEDB_TRUST_PROXY_TLS=1 e non attiva per default di proposito:
// fidarsi di quell'header senza un proxy davanti è peggio del problema che
// risolve, perché l'indirizzo diventa scrivibile dal client e il rate limit si
// aggira cambiandolo a ogni tentativo. La variabile esiste già ed è esattamente
// la dichiarazione "c'è un proxy davanti" (vedi assertTransportSafe).
//
// Si dichiara il NUMERO DI HOP fidati, mai `true` (CDB-71). Con `true` Express
// risale l'intera catena di X-Forwarded-For e prende il valore più a sinistra —
// che è quello scritto dal CLIENT, non dal proxy: il freno ai tentativi di
// accesso tornerebbe aggirabile cambiando l'header a ogni richiesta, e stavolta
// di proposito. Con un numero, Express scarta esattamente quegli hop e legge
// l'indirizzo che il proxy ha inserito. Chi ha due proxy in cascata (CDN +
// ingress) alza CODEDB_TRUST_PROXY_HOPS di conseguenza.
if (String(process.env.CODEDB_TRUST_PROXY_TLS || '').trim() === '1') {
  const hops = parseInt(process.env.CODEDB_TRUST_PROXY_HOPS, 10);
  app.set('trust proxy', Number.isFinite(hops) && hops > 0 ? hops : 1);
}

const server = http.createServer(app);

/* ---------------------------------------------------------------------------
 * Gate sull'Origin dell'handshake Socket.IO (Cross-Site WebSocket Hijacking).
 *
 * Il CORS NON protegge il transport WebSocket: senza controllo, qualunque pagina
 * web aperta nel browser dell'utente poteva fare
 *
 *     io('http://127.0.0.1:3030', { transports: ['websocket'] })
 *
 * e usare l'intera API. Con CODEDB_RBAC spento (default, e sempre nell'app
 * Electron) l'handshake assegna ROOT_PRINCIPAL: lettura, scrittura e DDL su
 * tutte le connessioni salvate, export del vault, backup su percorsi scelti da
 * chi attacca. L'endpoint /mcp aveva già `guardHost`, il canale principale no.
 *
 * REGOLA
 *  · Origin assente (app Electron, client CLI, curl) → si applica lo stesso
 *    controllo anti DNS-rebinding di /mcp sull'header Host.
 *  · CODEDB_ALLOWED_ORIGINS impostata → whitelist esplicita, punto.
 *  · Altrimenti → è consentito l'Origin il cui host coincide con l'Host della
 *    richiesta. È esattamente ciò che distingue un accesso diretto ("ho aperto
 *    io questa pagina") da una richiesta cross-site, e continua a funzionare
 *    quando si raggiunge CodeDB da un'altra macchina o dietro un reverse proxy,
 *    cosa che una whitelist fissa su localhost avrebbe rotto.
 * Il rifiuto porta un messaggio che dice cosa fare, non un errore muto.
 * ------------------------------------------------------------------------- */
const LOCAL_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function allowedOriginList() {
  return String(process.env.CODEDB_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkOrigin(req) {
  const origin = String((req.headers && req.headers.origin) || '').trim();
  const host = String((req.headers && req.headers.host) || '').trim();

  if (!origin) {
    // Nessun Origin: non è una richiesta partita da una pagina web. Resta però
    // il DNS-rebinding, in cui un dominio ostile risolve a 127.0.0.1: l'Host
    // continua a essere quello ostile, quindi lo si pretende locale — ma solo
    // se il server è in ascolto su loopback (altrimenti si romperebbe l'accesso
    // legittimo da un'altra macchina).
    const bindHost = String(process.env.HOST || '127.0.0.1').toLowerCase();
    const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(bindHost);
    if (!loopbackBind || LOCAL_HOST_HEADER.test(host)) return { ok: true };
    return { ok: false, reason: `header Host "${host}" non consentito su un'istanza in ascolto solo su loopback` };
  }

  const allowed = allowedOriginList();
  if (allowed.length) {
    if (allowed.includes(origin)) return { ok: true };
    return {
      ok: false,
      reason: `origine "${origin}" non consentita: aggiungila a CODEDB_ALLOWED_ORIGINS (attualmente: ${allowed.join(', ')})`,
      // Versione mostrata al browser da /handshake-check, che non richiede
      // autenticazione: dice cosa fare senza elencare le origini configurate.
      publicReason: `origine "${origin}" non consentita: va aggiunta alla variabile CODEDB_ALLOWED_ORIGINS del server`,
    };
  }

  // Senza whitelist: l'Origin deve corrispondere all'host su cui il browser ha
  // effettivamente aperto CodeDB.
  let originHost;
  try { originHost = new URL(origin).host; } catch { originHost = null; }
  if (originHost && host && originHost.toLowerCase() === host.toLowerCase()) return { ok: true };
  return {
    ok: false,
    reason: `origine "${origin}" non corrisponde all'indirizzo di CodeDB ("${host}"). ` +
      'Se l\'accesso avviene tramite un altro dominio (reverse proxy), elencalo in CODEDB_ALLOWED_ORIGINS.',
  };
}

const io = new Server(server, {
  maxHttpBufferSize: 5e6,
  // Il CORS non basta per il WebSocket: la decisione vera è in allowRequest,
  // che gira PRIMA di stabilire la connessione. `cors: { origin: false }` evita
  // in più che il polling HTTP di fallback ottenga header permissivi.
  cors: { origin: false },
  allowRequest: (req, callback) => {
    const verdict = checkOrigin(req);
    if (verdict.ok) return callback(null, true);
    console.warn(`[Sicurezza] Handshake Socket.IO rifiutato: ${verdict.reason}`);
    // NOTA: il motivo NON raggiunge il browser. Engine.IO tratta il primo
    // argomento come codice di errore e il client riceve comunque un generico
    // "xhr poll error"/"websocket error" (verificato su entrambi i transport):
    // per l'utente il rifiuto era indistinguibile da un server spento. È il
    // motivo per cui esiste /handshake-check qui sotto, che la pagina interroga
    // quando l'handshake fallisce.
    return callback(verdict.reason, false);
  },
});

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------------------
 * Diagnosi dell'handshake rifiutato
 *
 * Serve perché il motivo del rifiuto non può viaggiare sul canale Socket.IO
 * (vedi allowRequest): senza questo endpoint il browser non ha modo di
 * distinguere "il server ha rifiutato la mia origine" da "il server è spento",
 * che è esattamente la differenza fra un problema di configurazione da
 * correggere in trenta secondi e un'attesa senza fine.
 *
 * La richiesta arriva dalla pagina di CodeDB, quindi porta gli STESSI header
 * Origin/Host dell'handshake: applicare qui `checkOrigin` diagnostica il caso
 * reale, non un'approssimazione. Non richiede autenticazione — non potrebbe,
 * dato che serve proprio quando la connessione non si stabilisce — e per questo
 * riporta `publicReason`, che dice cosa fare senza rivelare la configurazione.
 * ------------------------------------------------------------------------- */
// `app: 'codedb'` è anche la FIRMA dell'istanza: la usa il processo Electron per
// riconoscere un server CodeDB già in ascolto sulla porta invece di fidarsi del
// solo fatto che qualcosa risponda (CDB-38).
app.get('/handshake-check', (req, res) => {
  const verdict = checkOrigin(req);
  if (verdict.ok) return res.json({ ok: true, app: 'codedb' });
  res.status(403).json({ ok: false, app: 'codedb', reason: verdict.publicReason || verdict.reason });
});

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

// Messaggio d'errore destinato all'utente. Passa da `spiegaErrore` (db/errors.js),
// che riconosce gli errori tipici dei driver e li riscrive come "cosa è successo
// + cosa fare", conservando in coda il testo originale. È il punto di uscita
// unico degli ack socket (safeOn/delegate) e delle risposte HTTP di /auth:
// spiegare qui vale per tutta l'applicazione. Un errore non riconosciuto — o già
// spiegato — torna indietro immutato.
function errMsg(err, ctx) {
  return spiegaErrore(err, ctx || (err && err._ctx) || {});
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
  // sshHostKey: impronta SHA256 della host key del bastion. NON è un segreto
  // (è un'impronta pubblica) ma va conservata: è ciò che rende rilevabile un
  // MITM sul tunnel. Registrata al primo collegamento riuscito.
  'ssh', 'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshKeyFile', 'sshPassphrase', 'sshHostKey',
];
// Campi segreti: mai rimandati al browser, riusati dal valore salvato se il form
// li lascia vuoti (vedi connections:get/save e mongo:connect con keepPasswordFrom).
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'];

// Chiave con cui i segreti sono cifrati. Nel formato v2 è la **DEK** casuale
// sbustata dalla passphrase (db/vault.js); nei vault v1 non ancora migrati è
// ancora `SHA256(passphrase)`. Da qui in giù il resto del codice non vede la
// differenza: cifra e decifra con questa chiave e basta.
let encryptionKey = Vault.legacyKey(process.env.GUI_MONGO_PASSPHRASE || '');
// Metadati del vault v2 (null = vault ancora in formato v1).
let vaultMeta = null;
// Il vault è protetto da una passphrase non vuota? (CDB-66)
//
// Serve solo alla modale, per sapere se sta IMPOSTANDO la prima passphrase o
// cambiandone una esistente. La risposta si ottiene provando ad aprire la DEK
// con la passphrase vuota — cioè con uno `scryptSync` da ~28 ms, durante i quali
// l'event loop è fermo per TUTTE le sessioni. Calcolarla a ogni `vault:status`
// (evento che non richiede alcuna capability) rendeva la risposta a una domanda
// di sola presentazione un modo per bloccare il server. Si calcola quindi una
// volta e si aggiorna nei soli tre punti che possono cambiarla: sblocco,
// cambio passphrase, azzeramento.
let vaultProtetto = !!process.env.GUI_MONGO_PASSPHRASE;

function aggiornaVaultProtetto(passphraseNonVuota) {
  vaultProtetto = !!passphraseNonVuota;
}
// Conta i segreti che non si decifrano: all'avvio un valore > 0 significa
// passphrase sbagliata e il server rifiuta di partire (vedi main), invece di
// proseguire e riscrivere il file coi segreti azzerati.
let decryptFailures = 0;

function encryptSecret(text, cryptoKey = encryptionKey) {
  return Vault.encryptWith(text, cryptoKey);
}

// Decifra un segreto ENC:iv:tag:testo; lancia se la chiave non è quella giusta.
function decryptRaw(text) {
  return Vault.decryptWith(text, encryptionKey);
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

/**
 * Il vault è utilizzabile con la chiave attuale?
 *
 * Serve all'avvio senza GUI_MONGO_PASSPHRASE, dove la chiave è quella derivata
 * dalla passphrase vuota. Non basta chiedersi "ci sono segreti cifrati?": chi non
 * ha mai impostato una passphrase HA segreti cifrati, ma con la chiave vuota —
 * per lui non deve cambiare nulla e nessuna modale deve comparire. La domanda
 * giusta è se i segreti presenti si decifrano davvero.
 *
 * Legge tutti i vault (quello storico condiviso e, con RBAC, quelli per owner).
 * @returns {boolean} true se non c'è nulla da decifrare o si decifra tutto.
 */
function probeVault() {
  // Vault v2: la domanda ha una risposta esatta e a costo zero — la DEK si
  // sbusta con la passphrase vuota oppure no.
  const meta = Vault.readMeta(CONNECTIONS_FILE);
  if (meta) {
    const dataKey = Vault.unwrapDataKey(meta, '');
    // Qui la domanda "il vault ha una passphrase?" è già stata posta e pagata:
    // se la chiave vuota NON apre la DEK, una passphrase c'è (CDB-66).
    aggiornaVaultProtetto(!dataKey);
    if (!dataKey) return false;
    encryptionKey = dataKey;
    vaultMeta = meta;
    return true;
  }

  const before = decryptFailures;
  decryptFailures = 0;
  try {
    loadConnections();
    // Con RBAC acceso ogni owner ha il proprio file: vanno verificati tutti,
    // altrimenti il vault sembrerebbe a posto solo perché il file condiviso lo è.
    if (rbacOn()) {
      try {
        if (fs.existsSync(CONNECTIONS_DIR)) {
          for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
            if (f.endsWith('.ini')) loadConnections(path.basename(f, '.ini'));
          }
        }
      } catch { /* nessuna cartella per-owner: resta solo il file storico */ }
    }
  } catch (err) {
    console.error(`Impossibile leggere le connessioni salvate: ${errMsg(err)}`);
  }
  const ok = decryptFailures === 0;
  decryptFailures = before;
  return ok;
}

/**
 * Apre il vault con la passphrase indicata.
 *
 * Due formati possibili:
 *  · **v2** (metadati presenti): si sbusta la DEK. Un solo tentativo, esatto —
 *    o la chiave si apre o la passphrase è sbagliata.
 *  · **v1** (nessun metadato): la chiave È la passphrase, e si verifica
 *    provando a decifrare i segreti presenti.
 *
 * Non riscrive nulla: la migrazione a v2 è un passo separato ed esplicito
 * (`migrateVaultToV2`), perché toccare l'unica copia dei segreti su disco deve
 * essere una decisione, non un effetto collaterale dell'avvio.
 */
function tryUnlockVault(passphrase) {
  if (typeof passphrase !== 'string') {
    return { ok: false, error: 'Passphrase non valida.' };
  }

  const meta = Vault.readMeta(CONNECTIONS_FILE);
  if (meta) {
    const dataKey = Vault.unwrapDataKey(meta, passphrase);
    if (!dataKey) {
      return { ok: false, error: 'Passphrase errata: la chiave del vault non si apre.' };
    }
    encryptionKey = dataKey;
    vaultMeta = meta;
    decryptFailures = 0;
    aggiornaVaultProtetto(passphrase !== '');
    return { ok: true };
  }

  // Formato v1.
  const oldKey = encryptionKey;
  const oldFailures = decryptFailures;

  encryptionKey = Vault.legacyKey(passphrase);
  decryptFailures = 0;

  loadConnections();
  if (decryptFailures > 0) {
    encryptionKey = oldKey;
    decryptFailures = oldFailures;
    return { ok: false, error: 'Passphrase errata: i segreti cifrati non si decifrano con questa chiave.' };
  }
  vaultMeta = null;
  aggiornaVaultProtetto(passphrase !== '');
  return { ok: true, legacy: true };
}

/** Elenco dei file .ini che compongono il vault (condiviso + per-owner). */
function vaultFiles() {
  const files = [];
  if (fs.existsSync(CONNECTIONS_FILE)) files.push({ file: CONNECTIONS_FILE, ownerId: null });
  try {
    if (fs.existsSync(CONNECTIONS_DIR)) {
      for (const f of fs.readdirSync(CONNECTIONS_DIR)) {
        if (f.endsWith('.ini')) files.push({ file: path.join(CONNECTIONS_DIR, f), ownerId: path.basename(f, '.ini') });
      }
    }
  } catch { /* nessuna cartella per-owner */ }
  return files;
}

/**
 * Porta il vault dal formato v1 al v2 ri-cifrando i segreti con una DEK nuova.
 *
 * È l'unico momento in cui i segreti vengono riscritti, quindi vale la pena
 * essere prudenti: si lavora su tutto in memoria, si tiene una copia
 * pre-migrazione FUORI dalla rotazione .bak (che i riavvii consumano), si
 * scrive, e si **rilegge per verificare** che ogni segreto torni identico
 * all'originale. Se qualcosa non torna, si ripristina e non si migra.
 *
 * @param {string} newPassphrase passphrase con cui avvolgere la nuova DEK
 * @returns {{ok: true, migrated: number} | {ok: false, error: string}}
 */
function migrateVaultToV2(newPassphrase) {
  if (!encryptionKey) return { ok: false, error: 'Vault bloccato: sbloccalo prima di cambiare passphrase.' };

  // 1. Tutto in chiaro in memoria, con la chiave attuale.
  const inMemoria = [];
  for (const { file, ownerId } of vaultFiles()) {
    decryptFailures = 0;
    const sezioni = loadConnections(ownerId);
    if (decryptFailures > 0) {
      return { ok: false, error: `Alcuni segreti in "${path.basename(file)}" non si decifrano: migrazione annullata.` };
    }
    inMemoria.push({ file, ownerId, sezioni });
  }

  // 2. Copia pre-migrazione, con un nome che la rotazione .bak non tocca.
  const copie = [];
  try {
    for (const { file } of inMemoria) {
      const copia = `${file}.pre-vault2`;
      if (fs.existsSync(file)) { fs.copyFileSync(file, copia); copie.push(copia); }
    }
  } catch (err) {
    return { ok: false, error: `Impossibile creare la copia di sicurezza: ${errMsg(err)}` };
  }

  // 3. Nuova DEK e riscrittura.
  const { meta, dataKey } = Vault.createMeta(newPassphrase);
  const chiavePrecedente = encryptionKey;
  try {
    encryptionKey = dataKey;
    for (const { sezioni, ownerId } of inMemoria) {
      if (Object.keys(sezioni).length) saveConnections(sezioni, ownerId);
    }
    Vault.writeMeta(CONNECTIONS_FILE, meta);

    // 4. Verifica rileggendo dal disco: i segreti devono tornare identici.
    for (const { sezioni, ownerId } of inMemoria) {
      decryptFailures = 0;
      const riletto = loadConnections(ownerId);
      if (decryptFailures > 0) throw new Error('rilettura fallita dopo la migrazione');
      for (const [nome, sec] of Object.entries(sezioni)) {
        for (const campo of SECRET_FIELDS) {
          if ((sec[campo] || '') !== ((riletto[nome] || {})[campo] || '')) {
            throw new Error(`il segreto "${campo}" di "${nome}" non corrisponde dopo la migrazione`);
          }
        }
      }
    }
  } catch (err) {
    // Ripristino: si torna al formato v1 esattamente com'era.
    encryptionKey = chiavePrecedente;
    try {
      for (const { file } of inMemoria) {
        const copia = `${file}.pre-vault2`;
        if (fs.existsSync(copia)) fs.copyFileSync(copia, file);
      }
      const metaFile = Vault.metaFileFor(CONNECTIONS_FILE);
      if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
    } catch { /* ripristino best-effort: le copie restano su disco */ }
    return { ok: false, error: `Migrazione annullata (${errMsg(err)}). I file sono stati ripristinati; la copia di sicurezza è in *.pre-vault2.` };
  }

  vaultMeta = meta;
  decryptFailures = 0;
  return { ok: true, migrated: inMemoria.length, copie };
}

/**
 * Cambia la passphrase del vault.
 *
 * Su un vault v2 è un'operazione minuscola: si riavvolge la DEK e si riscrive
 * il solo file dei metadati. I segreti non vengono toccati — nessuna finestra
 * in cui l'unica copia delle credenziali è a metà scrittura.
 * Su un vault v1 la stessa richiesta fa la migrazione (una volta sola).
 */
function changeVaultPassphrase(newPassphrase) {
  if (typeof newPassphrase !== 'string') {
    return { ok: false, error: 'Passphrase non valida.' };
  }
  if (!encryptionKey) {
    return { ok: false, error: 'Vault bloccato: sbloccalo con la passphrase attuale prima di cambiarla.' };
  }

  if (!vaultMeta) {
    const res = migrateVaultToV2(newPassphrase);
    if (!res.ok) return res;
    return { ok: true, migrated: true };
  }

  const nuovoMeta = Vault.rewrapDataKey(vaultMeta, encryptionKey, newPassphrase);
  const metaFile = Vault.metaFileFor(CONNECTIONS_FILE);
  const precedente = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : null;
  try {
    Vault.writeMeta(CONNECTIONS_FILE, nuovoMeta);
    // Verifica: la nuova passphrase deve aprire la STESSA chiave dati.
    const riletto = Vault.readMeta(CONNECTIONS_FILE);
    const prova = Vault.unwrapDataKey(riletto, newPassphrase);
    if (!prova || !prova.equals(encryptionKey)) throw new Error('verifica fallita');
    vaultMeta = riletto;
    aggiornaVaultProtetto(newPassphrase !== '');
    return { ok: true, migrated: false };
  } catch (err) {
    if (precedente !== null) {
      try { fs.writeFileSync(metaFile, precedente, 'utf8'); } catch { /* best-effort */ }
    }
    return { ok: false, error: `Cambio passphrase annullato: ${errMsg(err)}. La passphrase precedente resta valida.` };
  }
}

/**
 * Ricomincia da capo: vault nuovo con una passphrase nuova, connessioni salvate
 * messe da parte.
 *
 * È l'unica via d'uscita da una passphrase dimenticata. Senza di essa il vault
 * bloccato è un vicolo cieco: la modale di sblocco chiede l'unica cosa che
 * l'utente non ha, e l'applicazione non si apre nemmeno per creare una
 * connessione nuova (i segreti non si decifrano, e non esiste — per costruzione
 * — alcun recupero).
 *
 * I file NON vengono cancellati ma **rinominati** in `*.pre-reset-<timestamp>`:
 * sono comunque illeggibili senza la passphrase perduta, quindi non c'è nulla da
 * proteggere in più, mentre chi si ricorda la passphrase il giorno dopo (o ha
 * premuto per sbaglio) può rimetterli al loro posto. Cancellare l'unica copia
 * dei segreti su richiesta di un clic sarebbe l'unica operazione davvero
 * irreversibile di tutta l'applicazione.
 *
 * @param {string} newPassphrase passphrase del vault nuovo (vuota = nessuna)
 * @returns {{ok: true, spostati: string[], suffisso: string} | {ok: false, error: string}}
 */
function resetVault(newPassphrase) {
  if (typeof newPassphrase !== 'string') {
    return { ok: false, error: 'Passphrase non valida.' };
  }

  const suffisso = `pre-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const daSpostare = vaultFiles().map((v) => v.file);
  const metaFile = Vault.metaFileFor(CONNECTIONS_FILE);
  if (fs.existsSync(metaFile)) daSpostare.push(metaFile);

  const mosse = [];
  try {
    for (const file of daSpostare) {
      const destinazione = `${file}.${suffisso}`;
      fs.renameSync(file, destinazione);
      mosse.push({ file, destinazione });
    }
  } catch (err) {
    // Rimetti a posto quello che era già stato spostato: meglio il vault
    // bloccato di prima che un vault a metà.
    for (const { file, destinazione } of mosse) {
      try { fs.renameSync(destinazione, file); } catch { /* best-effort */ }
    }
    return { ok: false, error: `Impossibile mettere da parte i file del vault: ${errMsg(err)}` };
  }
  const spostati = mosse.map((m) => path.basename(m.destinazione));

  // Vault nuovo di zecca: DEK casuale avvolta dalla passphrase indicata.
  const { meta, dataKey } = Vault.createMeta(newPassphrase);
  try {
    Vault.writeMeta(CONNECTIONS_FILE, meta);
  } catch (err) {
    return { ok: false, error: `Vault non ricreato: ${errMsg(err)}` };
  }
  encryptionKey = dataKey;
  vaultMeta = meta;
  decryptFailures = 0;
  aggiornaVaultProtetto(newPassphrase !== '');

  return { ok: true, spostati, suffisso };
}

// Nomi che non possono essere usati come sezione o come chiave (CDB-21):
// assegnare `sections.__proto__ = {}` non crea una sezione, CAMBIA il prototipo
// dell'oggetto — e `constructor`/`prototype` sono la stessa famiglia di
// sorprese. Un nome di connessione arriva dall'utente, quindi la difesa va qui,
// nel parser, non nel chiamante.
const CHIAVI_INI_VIETATE = new Set(['__proto__', 'constructor', 'prototype']);

function parseIni(text) {
  // `Object.create(null)`: nessun prototipo da inquinare, nemmeno per sbaglio.
  const sections = Object.create(null);
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      if (CHIAVI_INI_VIETATE.has(header[1])) {
        console.warn(`[connections.ini] Sezione "${header[1]}" ignorata: nome riservato.`);
        current = null;
        continue;
      }
      current = sections[header[1]] = Object.create(null);
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) {
      const chiave = line.slice(0, eq).trim();
      if (CHIAVI_INI_VIETATE.has(chiave)) continue;
      current[chiave] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

function stringifyIni(sections) {
  // L'intestazione descrive il file com'è DAVVERO (CDB-23): i segreti sono
  // cifrati (prefisso ENC:), e dirli "in chiaro" spingeva a trattare male un
  // file che invece va conservato — mentre la cosa importante da sapere è che
  // senza la passphrase quei segreti non si recuperano.
  const lines = [
    '; Connessioni salvate di CodeDB.',
    '; Le password e i segreti SSH sono cifrati (valori con prefisso ENC:) con la',
    '; chiave del vault, custodita in vault.json accanto a questo file.',
    '; Senza la passphrase del vault NON sono recuperabili: conserva entrambi i file.',
  ];
  for (const [name, values] of Object.entries(sections)) {
    lines.push('', `[${name}]`);
    for (const [key, val] of Object.entries(values)) {
      if (val != null && String(val).trim() !== '') lines.push(`${key}=${String(val).trim()}`);
    }
  }
  return lines.join('\n') + '\n';
}

// Isolamento multi-tenant delle connessioni salvate: con RBAC attivo ogni owner
// ha il proprio file data/conns/<ownerId>.ini, così un tenant non può vedere né
// usare le connessioni (né i segreti) di un altro. Con RBAC spento — o per
// l'owner locale/root — resta il file storico condiviso CONNECTIONS_FILE, e i
// test continuano a usare l'override CODEDB_CONNECTIONS_FILE. La chiave del vault
// (passphrase) resta unica per installazione: cambia solo il file, non la chiave.
const CONNECTIONS_DIR = process.env.CODEDB_CONNECTIONS_DIR
  || path.join(path.dirname(CONNECTIONS_FILE), 'conns');

function connectionsFileFor(ownerId) {
  const id = String(ownerId == null ? '' : ownerId).trim();
  if (!rbacOn() || !id || id === 'local') return CONNECTIONS_FILE;
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(CONNECTIONS_DIR, `${safe}.ini`);
}

function loadConnections(ownerId) {
  try {
    const sections = parseIni(fs.readFileSync(connectionsFileFor(ownerId), 'utf8'));
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

function saveConnections(sections, ownerId) {
  const file = connectionsFileFor(ownerId);
  const toSave = encryptSections(sections);
  // La directory per-owner potrebbe non esistere ancora al primo salvataggio.
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* già presente */ }
  // Prima di riscrivere, conserva le due versioni precedenti (.bak e .bak2):
  // il file è l'unica copia dei segreti sul disco e la migrazione all'avvio con
  // una passphrase sbagliata li azzererebbe; due generazioni proteggono anche
  // se dopo una migrazione corrotta arriva un ulteriore salvataggio dalla UI.
  try {
    fs.copyFileSync(file + '.bak', file + '.bak2');
  } catch { /* nessun .bak precedente: niente da ruotare */ }
  try {
    fs.copyFileSync(file, file + '.bak');
  } catch { /* file ancora inesistente: nessun backup da fare */ }
  fs.writeFileSync(file, stringifyIni(toSave), 'utf8');
}

function assertConnName(name) {
  if (!name || /[\[\]\r\n]/.test(name)) {
    throw new Error(`Nome di connessione non valido: "${name}"`);
  }
  // Il nome diventa la chiave di un oggetto: `__proto__` e compagnia non
  // creerebbero una connessione ma toccherebbero il prototipo (CDB-21). Il
  // parser li scarta già in lettura; qui si evita di scriverli.
  if (CHIAVI_INI_VIETATE.has(name)) {
    throw new Error(`Nome di connessione riservato: "${name}". Scegline un altro.`);
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
function resolveEffectiveCfg(cfg, ownerId) {
  let effective = cfg;
  // Un solo caricamento del file: sia "saved" che "keepPasswordFrom" leggono
  // dalla stessa mappa in memoria, evitando due letture/decifrature ridondanti.
  const needsLookup = cfg.saved || cfg.keepPasswordFrom;
  const conns = needsLookup ? loadConnections(ownerId) : null;
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
//
// `guardCtx` = { principal, connName }: se presente (e il principal non è
// root), la strategia restituita è avvolta nel Proxy autorizzante, quindi ogni
// accesso ai dati che ne deriva — griglia, Query Engine, tool MCP — è già
// soggetto ai permessi. Con RBAC spento resta null e nulla cambia.
async function establishConnection(cfg, guardCtx = null) {
  // Il lookup delle connessioni salvate avviene nel file del tenant richiedente
  // (guardCtx.principal.ownerId); con RBAC spento resta il file condiviso.
  const effective = resolveEffectiveCfg(cfg, guardCtx && guardCtx.principal && guardCtx.principal.ownerId);
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
    return { strategy: guardStrategy(strategy, guardCtx), tunnel, effective, dbType };
  } catch (err) {
    if (tunnel) try { tunnel.close(); } catch { /* ignora */ }
    // Destinazione reale per il messaggio parlante (vedi errMsg/safeOn): è
    // l'unico punto che la conosce — "connessione rifiutata su localhost:27017"
    // invece di un ECONNREFUSED nudo. Mai l'host del tunnel, che all'utente non
    // dice nulla: quello che ha configurato è l'host del database.
    if (err && typeof err === 'object' && !err._ctx) {
      err._ctx = {
        dbType,
        host: (effective.host || '').trim() || undefined,
        port: effective.port ? String(effective.port).trim() : undefined,
      };
    }
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
        // Il contesto di autorizzazione va ripassato: senza, la riconnessione
        // automatica restituirebbe una strategia non protetta dal Proxy.
        const conn = await establishConnection(sess.effectiveCfg, sess.guardCtx || null);
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

/**
 * Identità dell'autore di un'azione, da includere in OGNI voce di audit.
 *
 * Senza questi campi lo Storico Azioni non è attribuibile e quindi non è
 * filtrabile per tenant: `ui-audit.log` è un file unico per installazione, e
 * mostrarlo intero a chiunque vanificherebbe l'isolamento per owner realizzato
 * da `connectionsFileFor()`. `ownerId` delimita il tenant, `userId` il singolo
 * soggetto (l'owner vede tutto il proprio tenant, un sottoutente solo le
 * proprie azioni), `user` è l'etichetta leggibile mostrata in tabella.
 */
function auditActor(principal) {
  const p = principal || ROOT_PRINCIPAL;
  return {
    ownerId: p.ownerId || null,
    userId: p.id || null,
    user: p.email || p.displayName || null,
  };
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

// `isWriteSql` e `isWriteMongoPipeline` vivono in auth/capabilities.js: audit e
// motore dei permessi devono classificare collection:aggregate esattamente allo
// stesso modo (SQL Raw di scrittura, pipeline con $out/$merge).

// Tetto dei risultati per il Query Engine (⚡ Query & Aggregate): più alto del
// default 500 della griglia paginata, così una query esplicita non viene
// troncata silenziosamente. Override con env CODEDB_QUERY_MAX; il ceiling
// assoluto è comunque imposto dalle strategie (DbStrategy.resultCap).
const QUERY_ENGINE_MAX_ROWS = Math.max(parseInt(process.env.CODEDB_QUERY_MAX, 10) || 10000, 1);

// --- Runner di script (⚡ Query & Aggregate) ---------------------------------
// Tetto di istruzioni per esecuzione: un file enorme va caricato col pannello a
// blocchi (sql-chunker.js), non spedito in un solo evento — dividerlo costa
// memoria proporzionale al testo e il socket ha un limite di payload.
const MAX_SCRIPT_STATEMENTS = Math.max(parseInt(process.env.CODEDB_SCRIPT_MAX_STATEMENTS, 10) || 20000, 1);
// Script contemporanei per sessione: più di così è quasi sempre un errore
// dell'utente, e ognuno tiene occupata una connessione del pool.
const MAX_SCRIPTS_PER_SESSION = 4;
// Cadenza minima fra due eventi di progresso (ms). Errori, pause e fine
// passano comunque: è solo l'avanzamento "normale" a essere diradato.
const SCRIPT_PROGRESS_MS = 150;

// Budget degli script MongoDB interpretati (db/MongoScriptRunner.js). Girano
// DENTRO il processo CodeDB, quindi un ciclo infinito o una scrittura in massa
// devono fermare sé stessi invece del server. I valori sono generosi per l'uso
// normale (migrazioni, seed) e configurabili per chi ha bisogno di più.
const SCRIPT_LIMITI = {
  tempoMs: Math.max(parseInt(process.env.CODEDB_SCRIPT_TIMEOUT_MS, 10) || 60000, 1000),
  chiamateDb: Math.max(parseInt(process.env.CODEDB_SCRIPT_MAX_DB_CALLS, 10) || 5000, 1),
};

// Campi del payload che solo il server può decidere: vengono rimossi da ogni
// evento delegato prima di raggiungere le strategie (vedi delegate()).
// `opHandle` è il descrittore dell'operazione annullabile, popolato qui: se lo
// mandasse il client potrebbe farsi annullare le query altrui.
const SERVER_ONLY_PAYLOAD_FIELDS = ['maxRows', 'opHandle'];

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
      ...auditActor(sess && sess.principal),
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
      ...auditActor(sess && sess.principal),
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
 * Host per l'interprete di script MongoDB.
 *
 * L'interprete (db/MongoScriptRunner.js) non conosce né strategie né sessioni:
 * riceve queste funzioni e null'altro. Il punto è che **passano tutte dalla
 * strategia della sessione**, che è già avvolta nel Proxy autorizzante: ogni
 * riga di script è quindi soggetta all'RBAC come qualsiasi altra operazione,
 * senza un solo controllo scritto qui dentro. Aggiungere un metodo
 * all'interprete non può aprire un buco, perché il varco resta uno solo.
 * ------------------------------------------------------------------------- */
// `run` (facoltativo) è lo script in corso: le operazioni che MODIFICANO dati o
// struttura vi lasciano un segno, così la voce di audit di chiusura può dire il
// vero sulla categoria (CDB-69). Su uno script interpretato è l'unico momento in
// cui la si conosce: il testo non lo dice, l'esecuzione sì.
function mongoScriptHost(session, runId, opHandle, run = null) {
  const esegui = (fn) => executeWithReconnect(session, fn);
  const eseguiScrivendo = (fn) => {
    if (run) run.haScritto = true;
    return esegui(fn);
  };
  // Gli operatori che eseguono JavaScript sul SERVER MongoDB restano vietati
  // anche negli script: l'interprete gira nel processo CodeDB, `$where` no.
  const controlla = (testo) => {
    if (!testo) return;
    try { assertNoServerJs(JSON.parse(testo)); } catch (err) {
      if (err && /\$where|\$function|\$accumulator/.test(err.message)) throw err;
    }
  };

  return {
    find: (db, coll, payload) => {
      controlla(payload.filter);
      return esegui((s) => s.collectionFind(db, coll, { ...payload, runId, opHandle }));
    },
    aggregate: (db, coll, payload) => {
      controlla(payload.pipeline);
      return esegui((s) => s.collectionAggregate(db, coll, { ...payload, runId, opHandle }));
    },
    count: (db, coll, payload) => esegui((s) => s.collectionCount(db, coll, payload)),
    write: (db, coll, payload) => eseguiScrivendo((s) => s.shellWrite(db, coll, payload)),
    listCollections: (db) => esegui((s) => s.listCollections(db)),
    createCollection: (db, nome) => eseguiScrivendo((s) => s.createCollection(db, nome)),
    dropCollection: (db, coll) => eseguiScrivendo((s) => s.dropCollection(db, coll)),
    dropDatabase: (db) => eseguiScrivendo((s) => s.dropDatabase(db)),
    // L'interprete parla in termini di shell (`keys`/`options`), la strategia
    // ha il suo contratto (`fields`/`unique`/`name`): l'adattamento sta qui,
    // così nessuno dei due deve conoscere l'altro.
    createIndex: (db, coll, { keys, options }) => eseguiScrivendo((s) => s.createIndex(db, coll, {
      fields: JSON.stringify(keys || {}),
      unique: !!(options && options.unique),
      name: (options && options.name) || '',
    })),
    dropIndex: (db, coll, nome) => eseguiScrivendo((s) => s.dropIndex(db, coll, nome)),
  };
}

/**
 * Il comando porta con sé il nome del database su cui agisce (CREATE/DROP
 * DATABASE o SCHEMA), quindi non richiede un database già aperto.
 */
function comandoConDbProprio(codeStr) {
  return /^\s*(CREATE|DROP)\s+(DATABASE|SCHEMA)\b/i.test(String(codeStr || ''));
}

/* ---------------------------------------------------------------------------
 * SQL di scrittura/DDL eseguito su MongoDB.
 *
 * `SqlToMql.translateWrite` produce un'operazione neutra; qui la si esegue
 * usando le STESSE funzioni dell'interprete di script (mongoScriptHost), così
 * esiste un solo percorso di scrittura verso MongoDB e un solo punto in cui
 * l'RBAC si applica.
 * ------------------------------------------------------------------------- */
async function eseguiSqlScritturaMongo(session, codeStr, targetDb, { runId, opHandle, fatto, conContesto, run }) {
  const op = 'SQL di scrittura (SQL→MongoDB)';
  let piano;
  try {
    piano = SqlToMql.translateWrite(codeStr);
  } catch (err) {
    throw conContesto(new Error(`Traduzione SQL→MongoDB non riuscita: ${err.message}`), 'write', op, targetDb, null);
  }

  const host = mongoScriptHost(session, runId, opHandle, run);
  const messaggio = (testo) => {
    const doc = { messaggio: testo, ...(piano.note ? { nota: piano.note } : {}) };
    return fatto({ docs: [doc], columns: Object.keys(doc) }, 'write', op, targetDb, piano.coll || null);
  };

  try {
    if (piano.kind === 'ddl') {
      switch (piano.op) {
        case 'createCollection':
          await host.createCollection(targetDb, piano.coll);
          return messaggio(`Collezione "${piano.coll}" creata in "${targetDb}".`);
        case 'dropCollection':
          await host.dropCollection(targetDb, piano.coll);
          return messaggio(`Collezione "${piano.coll}" eliminata da "${targetDb}".`);
        case 'createDatabase':
          // Su MongoDB il database nasce con la prima collezione: la strategia
          // lo sa fare (createDatabase crea una collezione iniziale).
          await executeWithReconnect(session, (s) => s.createDatabase(piano.db));
          return fatto(
            { docs: [{ messaggio: `Database "${piano.db}" creato.`, nota: piano.note }], columns: ['messaggio', 'nota'] },
            'write', op, piano.db, null
          );
        case 'dropDatabase':
          await host.dropDatabase(piano.db);
          return fatto(
            { docs: [{ messaggio: `Database "${piano.db}" eliminato.` }], columns: ['messaggio'] },
            'write', op, piano.db, null
          );
        default:
          throw new Error(`Operazione DDL non gestita: ${piano.op}`);
      }
    }

    // Scritture sui dati: stesso metodo `shellWrite` usato dagli script.
    const payload = { op: piano.op };
    if (piano.op === 'insertOne') payload.doc = JSON.stringify(piano.docs[0]);
    if (piano.op === 'insertMany') payload.docs = JSON.stringify(piano.docs);
    if (piano.filter !== undefined) payload.filter = JSON.stringify(piano.filter);
    if (piano.update !== undefined) payload.update = JSON.stringify(piano.update);

    const res = await host.write(targetDb, piano.coll, payload);
    const doc = { operazione: piano.op, collezione: piano.coll, ...res, ...(piano.note ? { nota: piano.note } : {}) };
    return fatto({ docs: [doc], columns: Object.keys(doc) }, 'write', op, targetDb, piano.coll);
  } catch (err) {
    throw conContesto(err, 'write', op, targetDb, piano.coll || null);
  }
}

/* ---------------------------------------------------------------------------
 * Esecuzione di UN blocco di codice del Query Engine.
 *
 * Estratta dal gestore `query:execute` perché serve a DUE chiamanti: la query
 * singola e il runner di script, che la invoca per ogni istruzione. Tenerla in
 * un solo posto è ciò che garantisce che sintassi shell, SQL→MQL, `USE`,
 * pipeline e SQL Raw si comportino IDENTICAMENTE dentro e fuori da uno script —
 * comprese le regole di sicurezza (`assertNoServerJs`, bersaglio non vuoto) e
 * il passaggio dal Proxy autorizzante, che vede una chiamata di strategia per
 * istruzione e ne decide la capability.
 *
 * Non scrive audit: restituisce categoria e descrizione dell'operazione
 * (`category`/`op`) e, in caso di errore, le allega all'eccezione in
 * `err.auditCtx`. Chi chiama decide se e come tracciare — la query singola
 * traccia sempre, lo script traccia le scritture e un riepilogo.
 *
 * @returns {Promise<{res:object, category:'read'|'write', op:string, db:string, coll:string|null, code:string}>}
 * ------------------------------------------------------------------------- */
/**
 * Un Virtual JOIN contiene scritture? (CDB-16)
 *
 * Le sorgenti possono portare una pipeline MongoDB (`$out`/`$merge`) o dell'SQL
 * grezzo: si usano le STESSE funzioni dei permessi, così audit e autorizzazione
 * non possono divergere. Ritorna 'write' oppure null.
 */
function categoriaVirtualJoin(spec) {
  const vj = spec && spec.virtualJoin;
  if (!vj) return null;
  for (const src of [vj.sourceA, vj.sourceB]) {
    if (!src || !src.query) continue;
    const q = src.query;
    if (typeof q === 'string') {
      if (isWriteSql(q)) return 'write';
      try { if (isWriteMongoPipeline(JSON.parse(q))) return 'write'; } catch { /* non è JSON */ }
    } else if (isWriteMongoPipeline(q)) {
      return 'write';
    }
  }
  return null;
}

async function executeQueryCode(session, payload) {
  let { code, engine, db, coll, runId, opHandle, run } = payload;
  const codeStr = String(code || '').trim();

  if (!codeStr) {
    throw new Error('Codice query vuoto.');
  }

  const fatto = (res, category, op, dbUsato, collUsata) => ({
    res, category, op, db: dbUsato || null, coll: collUsata || null, code: codeStr,
  });
  // L'errore porta con sé il contesto di audit: senza, il chiamante non saprebbe
  // su quale db/coll è fallita l'operazione né come classificarla.
  const conContesto = (err, category, op, dbUsato, collUsata) => {
    err.auditCtx = { category, op, db: dbUsato || null, coll: collUsata || null, code: codeStr };
    return err;
  };

  // Modalità Cross-DB (Virtual Join)
  if (engine === 'crossdb' || codeStr.includes('"virtualJoin"')) {
    let spec;
    try {
      spec = JSON.parse(codeStr);
    } catch (err) {
      throw new Error('La query Virtual Join deve essere un oggetto JSON valido: ' + err.message);
    }
    // Categoria reale anche qui (CDB-16): le due sorgenti di un Virtual JOIN
    // portano codice dell'utente (una pipeline MongoDB o dell'SQL), che può
    // benissimo essere una scrittura — `$out`/`$merge`, o un DELETE nel ramo
    // SQL. I PERMESSI erano comunque corretti, perché il Proxy autorizzante
    // classifica `collectionAggregate` guardando ciò che riceve; era l'audit a
    // registrare sempre "lettura", cioè a non lasciare traccia della modifica.
    const catJoin = categoriaVirtualJoin(spec) || 'read';
    try {
      const docs = await executeWithReconnect(session, (strat) => VirtualJoinEngine.execute(spec, strat, strat));
      return fatto({ docs }, catJoin, 'Virtual JOIN Cross-DB', db, coll);
    } catch (err) {
      throw conContesto(err, catJoin, 'Virtual JOIN Cross-DB', db, coll);
    }
  }

  // Riconoscimento ed esecuzione del comando USE <dbname> (o use <dbname>;)
  const useCmdMatch = codeStr.match(/^\s*(?:USE|use)\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?\s*;?\s*$/i);
  if (useCmdMatch) {
    const newDb = useCmdMatch[1];
    session.strategy.currentDb = newDb;
    const summaryDoc = { messaggio: `Database attivo cambiato in "${newDb}"`, activeDb: newDb };
    return fatto(
      { docs: [summaryDoc], columns: Object.keys(summaryDoc), activeDb: newDb },
      'write', 'Cambio Database (USE)', newDb, null
    );
  }

  // Se il codice inizia con USE <dbname>; seguito da ulteriori istruzioni
  const usePrefixMatch = codeStr.match(/^\s*(?:USE|use)\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?\s*;?\s*\n?/i);
  if (usePrefixMatch && codeStr.trim().length > usePrefixMatch[0].trim().length) {
    const newDb = usePrefixMatch[1];
    session.strategy.currentDb = newDb;
    db = newDb;
  }

  // Estrazione automatica della collezione/tabella dal FROM della query SQL (es. SELECT * FROM pippo)
  const sqlFromMatch = codeStr.match(/FROM\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?/i);
  const extractedColl = sqlFromMatch ? sqlFromMatch[1] : null;
  const targetColl = extractedColl || coll;
  const targetDb = db || session.strategy.currentDb || 'admin';

  // Il bersaglio deve essere un nome vero: `targetDb`/`targetColl` sono ciò
  // su cui il Proxy autorizzante confronta lo scope, e un valore vuoto
  // faceva cadere il confronto (vedi matchesAny). Meglio un errore
  // comprensibile che una query eseguita senza il controllo di ambito.
  //
  // Eccezione: i comandi che CREANO un database (o lo eliminano) portano il
  // nome con sé e non hanno bisogno di un database "corrente". Pretenderlo
  // rendeva impossibile la cosa più ovvia — creare un database da zero —
  // proprio a chi non ne aveva ancora aperto uno. Il controllo dei permessi
  // resta: lo fa il Proxy sul nome indicato nel comando.
  if (!String(targetDb || '').trim() && !comandoConDbProprio(codeStr)) {
    throw new Error('Nessun database selezionato: apri un database nella sidebar oppure usa "USE <database>" prima della query.');
  }

  // Modalità SQL (MySQL e PostgreSQL: Strategy Pattern, stesso "SQL Raw").
  if (engine === 'mysql' || engine === 'postgresql' || DbFactory.isSqlType(session.strategy.type)) {
    // Su PostgreSQL il pool è legato a `cfg.database` e nella UI il livello
    // "database" È LO SCHEMA: un CREATE DATABASE non può essere eseguito dal
    // pool (non è ammesso in transazione) e comunque il risultato non
    // comparirebbe mai nella sidebar. Meglio dirlo che lasciar fallire con un
    // errore del driver che non spiega nulla.
    if (session.strategy.type === 'postgresql' && /^\s*CREATE\s+DATABASE\b/i.test(codeStr)) {
      throw new Error('Su PostgreSQL la connessione è legata a un database e nella sidebar il livello "database" corrisponde allo SCHEMA: usa "CREATE SCHEMA <nome>" per creare un contenitore visibile qui. Per un nuovo database serve una connessione separata.');
    }

    const write = isWriteSql(codeStr);
    const cat = write ? 'write' : 'read';
    const op = write ? 'Query di scrittura (SQL)' : 'Query di lettura (SQL)';
    try {
      const res = await executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
      return fatto(res, cat, op, targetDb, targetColl);
    } catch (err) {
      throw conContesto(err, cat, op, targetDb, targetColl);
    }
  }

  // Modalità NoSQL (MongoDB)
  if (engine === 'mongodb' || session.strategy.type === 'mongodb') {
    // Esecuzione tramite l'INTERPRETE (db/MongoScriptRunner.js): l'unico
    // percorso MongoDB che sa eseguire scritture, cicli e funzioni.
    const eseguiScriptMongo = async () => {
      const op = 'Script MongoDB';
      try {
        const esito = await MongoScriptRunner.eseguiScript(
          codeStr,
          mongoScriptHost(session, runId, opHandle, run),
          {
            db: targetDb,
            interrotto: () => !!(opHandle && opHandle.interrotto),
            limiti: SCRIPT_LIMITI,
          }
        );
        // I `print()` diventano documenti, così l'output dello script è
        // visibile nella stessa griglia dei risultati invece di sparire.
        const docs = esito.output.length
          ? esito.output.map((riga, i) => ({ '#': i + 1, output: riga }))
          : esito.docs;
        return fatto(
          { docs, columns: docs.length ? Object.keys(docs[0]) : [], scriptOutput: esito.output, dbCalls: esito.chiamateDb },
          'write', op, targetDb, targetColl
        );
      } catch (err) {
        // La riga dell'errore, quando c'è, è l'informazione più utile.
        if (err && err.scriptLine && !/riga \d+/.test(err.message)) {
          err.message = `${err.message} (riga ${err.scriptLine})`;
        }
        throw conContesto(err, 'write', op, targetDb, targetColl);
      }
    };

    // SCRIPT JavaScript (var/let/const, for, if, funzioni...): non è un comando
    // shell singolo né una SELECT, va INTERPRETATO. Non passa dalla divisione
    // per `;`, che non conosce i blocchi `{ … }` e spezzerebbe un ciclo a metà.
    if (MongoScriptRunner.sembraScriptJs(codeStr)) return eseguiScriptMongo();

    // SQL di SCRITTURA o DDL su MongoDB: `INSERT INTO`, `UPDATE`, `DELETE`,
    // `CREATE TABLE`, `DROP DATABASE`… Tradotti nelle stesse operazioni che usa
    // l'interprete, quindi soggetti al Proxy autorizzante allo stesso modo.
    if (SqlToMql.looksLikeSqlWrite(codeStr)) {
      return eseguiSqlScritturaMongo(session, codeStr, targetDb, { runId, opHandle, fatto, conContesto, run });
    }

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
        res = await executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
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
        res = await executeWithReconnect(session, (strat) => strat.collectionFind(targetDb, targetColl, { filter: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
      } else {
        // Né JSON né pipeline: prova la sintassi nativa shell (db.coll.find...)
        // oppure una SELECT SQL. Entrambe producono lo stesso "plan".
        let plan = null;
        let planLabel = '';
        if (MongoShell.looksLikeShell(codeStr)) {
          try {
            plan = MongoShell.translate(codeStr);
          } catch (e) {
            // Il traduttore produce solo piani di lettura. Se il comando è una
            // SCRITTURA (o un metodo che non conosce) non è un errore: è roba
            // da interprete, che la esegue davvero. Prima era un vicolo cieco.
            if (e.scritturaShell || e.metodoSconosciuto) return eseguiScriptMongo();
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
              strat.collectionAggregate(targetDb, collName, { pipeline: JSON.stringify(plan.pipeline), maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
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
                runId,
                opHandle
              }));
          }
        } else if (targetColl && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(codeStr)) {
          // Un nome secco (la collezione aperta): mostra i suoi documenti.
          res = await executeWithReconnect(session, (strat) => strat.collectionFind(targetDb, targetColl, { filter: '', maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
        } else {
          // Non è JSON, non è una pipeline, non è shell di lettura né SQL:
          // l'ultima possibilità sensata è che sia codice da interpretare
          // (`print(...)`, una chiamata, un'espressione). Prima si finiva qui
          // con un "seleziona una collezione" che non spiegava nulla.
          return eseguiScriptMongo();
        }
      }
    } catch (err) {
      throw conContesto(err, cat, op, targetDb, queryColl);
    }
    return fatto(res, cat, op, targetDb, queryColl);
  }

  throw new Error('Target Engine non supportato.');
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
 * Serializzazione delle aperture di connessione per tab.
 *
 * `mongo:connect` è asincrono e lungo (TCP + eventuale tunnel SSH): fra il
 * controllo su `sessions` e la `sessions.set` finale c'è un await, quindi due
 * richieste concorrenti sullo stesso tabId aprivano due strategie e la seconda
 * sovrascriveva la prima, che restava aperta per sempre (client DB e tunnel SSH
 * orfani) mentre il budget globale veniva incrementato due volte e decrementato
 * una sola — deriva monotòna del contatore fino al blocco dell'intera istanza,
 * risolvibile solo col riavvio. Non è un caso di laboratorio: doppio click su
 * "Connetti", riconnessione automatica del socket e ripristino di sessione
 * possono facilmente sovrapporsi.
 *
 * `makeConnectLocks()` restituisce `withConnectLock(key, fn)`: le funzioni con
 * la stessa chiave vengono eseguite una alla volta, in ordine di arrivo. Si
 * accoda al massimo una richiesta oltre a quella in corso; oltre, si risponde
 * con un errore parlante invece di far crescere la coda (un client impazzito
 * non deve poter accumulare lavoro sul server).
 * ------------------------------------------------------------------------- */
const MAX_INFLIGHT_CONNECTS = 2; // 1 in esecuzione + 1 in attesa

function makeConnectLocks(maxInflight = MAX_INFLIGHT_CONNECTS) {
  /** @type {Map<string, { tail: Promise<void>, inflight: number }>} */
  const locks = new Map();

  return function withConnectLock(key, fn) {
    let lock = locks.get(key);
    if (!lock) {
      lock = { tail: Promise.resolve(), inflight: 0 };
      locks.set(key, lock);
    }
    if (lock.inflight >= maxInflight) {
      return Promise.reject(new Error('Una connessione è già in corso su questo tab: attendi che termini.'));
    }
    lock.inflight++;
    // La coda avanza qualunque sia l'esito del predecessore: un fallimento non
    // deve bloccare per sempre il tab.
    const result = lock.tail.then(fn, fn);
    lock.tail = result.then(() => {}, () => {}).then(() => {
      lock.inflight--;
      // Rimuovi il lock quando è scarico, così la mappa non cresce con i tab
      // effimeri (un socket può vedere passare molti tabId nel tempo).
      if (lock.inflight === 0 && locks.get(key) === lock) locks.delete(key);
    });
    return result;
  };
}

/* ---------------------------------------------------------------------------
 * Autenticazione e RBAC multi-utente (flag CODEDB_RBAC)
 *
 * Spento (default, e sempre nell'app desktop Electron): ogni richiesta viaggia
 * con ROOT_PRINCIPAL, `can()` risponde sempre true e le strategie non vengono
 * avvolte — il comportamento è identico a quello storico mono-utente.
 *
 * Acceso: serve un control plane MongoDB (CODEDB_APP_DB_URI) con utenti, ruoli,
 * grant, API key e sessioni. La UI si autentica con un token opaco
 * (POST /auth/login → handshake Socket.IO), i client MCP con una API key.
 * ------------------------------------------------------------------------- */

/** @type {import('./auth/AppStore').AppStore|null} */
let appStore = null;
let entitlements = null;

function requireStore() {
  if (!appStore) throw new Error('Control plane non disponibile: RBAC non inizializzato.');
  return appStore;
}

// Il principal di una richiesta: con RBAC spento è sempre l'owner locale.
function principalOf(carrier) {
  return (carrier && carrier.principal) || ROOT_PRINCIPAL;
}

async function resolvePrincipalFromToken(token) {
  if (!rbacOn()) return ROOT_PRINCIPAL;
  if (!appStore || !token) return null;
  return appStore.resolveSession(token).catch(() => null);
}

async function resolvePrincipalFromApiKey(key) {
  if (!rbacOn()) return ROOT_PRINCIPAL;
  if (!appStore || !key) return null;
  return appStore.resolveApiKey(key).catch(() => null);
}

/** Vista pubblica del principal per il frontend (mai segreti). */
function principalView(principal) {
  return {
    id: principal.id,
    type: principal.type,
    email: principal.email,
    displayName: principal.displayName,
    owner: !!(principal.owner || principal.root),
    rbac: rbacOn(),
    capabilities: principal.capabilities || [],
    grants: (principal.grants || []).map((g) => ({ connName: g.connName, role: g.role, capabilities: g.capabilities, scope: g.scope })),
  };
}

// Solo owner/admin possono gestire utenti, grant e API key del proprio tenant.
function assertManage(principal) {
  if (principal.root || principal.owner) return;
  if (!can(principal, { capability: 'manage' })) {
    throw new Error('Permesso negato: operazione riservata all\'amministratore dell\'account.');
  }
}

/**
 * Registra l'impronta della host key SSH sulla connessione salvata, se non era
 * ancora nota (fiducia al primo uso, come `StrictHostKeyChecking=accept-new`).
 * Da lì in poi `openSshTunnel` rifiuta qualunque chiave diversa, che è ciò che
 * rende rilevabile un man-in-the-middle sul bastion.
 *
 * Best-effort: un problema nel salvataggio non deve far fallire una connessione
 * già stabilita — al massimo l'impronta verrà registrata al tentativo successivo.
 */
function rememberSshHostKey(principal, connName, tunnel) {
  if (!connName || !tunnel || !tunnel.hostKey || tunnel.hostKeyKnown) return;
  try {
    const conns = loadConnections(principal.ownerId);
    const sec = conns[connName];
    if (!sec || String(sec.sshHostKey || '').trim()) return;
    sec.sshHostKey = tunnel.hostKey;
    saveConnections(conns, principal.ownerId);
    console.log(`[SSH] Impronta della host key registrata per "${connName}": ${tunnel.hostKey}`);
  } catch (err) {
    console.warn(`[SSH] Impossibile registrare l'impronta della host key per "${connName}": ${errMsg(err)}`);
  }
}

/**
 * Autorizza l'apertura (o il test) di una connessione al database.
 * - connessione salvata → serve un grant su quel nome;
 * - connessione "a mano" o salvataggio di una nuova (saveAs) → serve `manage`,
 *   perché significa introdurre credenziali nuove nell'istanza.
 */
function assertConnAllowed(principal, cfg, connName) {
  if (principal.root) return;
  if (String((cfg && cfg.saveAs) || '').trim()) {
    assertManage(principal);
    return;
  }
  if (!connName) {
    if (!principal.owner) {
      throw new Error('Permesso negato: puoi aprire solo le connessioni salvate assegnate al tuo utente.');
    }
    return;
  }
  if (!canUseConnection(principal, connName)) {
    throw new Error(`Permesso negato: nessun accesso alla connessione "${connName}".`);
  }
}

/**
 * Autorizza un'operazione che agisce sull'intera connessione senza passare dai
 * metodi della strategia (backup): serve la capability e nessuno scope, perché
 * su questo percorso lo scope non sarebbe applicabile.
 */
function assertWholeConnection(principal, connName, capability, what) {
  if (principal.root) return;
  if (!canWholeConnection(principal, connName, capability)) {
    throw new Error(`Permesso negato: non hai i privilegi per ${what} su questa connessione.`);
  }
}

// Freno agli attacchi a forza bruta sul login: 5 tentativi falliti per IP, poi
// un minuto di attesa. In memoria: sufficiente per un'istanza singola.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const loginAttempts = new Map();

function loginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.last > LOGIN_LOCK_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function noteLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, last: 0 };
  entry.count += 1;
  entry.last = Date.now();
  loginAttempts.set(ip, entry);
  potaLoginAttempts();
}

// Potatura della mappa dei tentativi (CDB-19). Senza, `loginAttempts` cresce di
// una voce per ogni indirizzo che sbaglia una password e non la si rilascia mai:
// le voci vengono cancellate solo quando QUELLO STESSO indirizzo torna a tentare
// dopo la scadenza, cioè quasi mai per un attacco distribuito. È un consumo di
// memoria illimitato comandato dall'esterno.
const LOGIN_ATTEMPTS_MAX = 10000;

function potaLoginAttempts() {
  if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX) {
    // Potatura ordinaria: si buttano le voci ormai scadute (costa poco perché
    // scatta solo su un fallimento di login, non su ogni richiesta).
    const limite = Date.now() - LOGIN_LOCK_MS;
    for (const [k, v] of loginAttempts) {
      if (v.last < limite) loginAttempts.delete(k);
    }
    return;
  }
  // Oltre il tetto: la mappa è sotto pressione, si riparte da zero. Perdere lo
  // storico dei tentativi è meno grave che esaurire la memoria del processo, e
  // il blocco si ricostruisce in cinque tentativi.
  loginAttempts.clear();
}

// Login/logout via HTTP (non via socket): così il gate dell'handshake resta una
// regola secca — nessun evento è raggiungibile senza essere già autenticati.
app.post('/auth/login', express.json({ limit: '16kb' }), async (req, res) => {
  if (!rbacOn()) {
    res.json({ ok: true, rbac: false, token: null, user: principalView(ROOT_PRINCIPAL) });
    return;
  }
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (loginBlocked(ip)) {
    res.status(429).json({ ok: false, error: 'Troppi tentativi di accesso falliti: riprova tra un minuto.' });
    return;
  }
  const email = String((req.body && req.body.email) || '').trim();
  const password = String((req.body && req.body.password) || '');
  try {
    // Prima l'owner (identità verificata dall'Entitlement Provider, cioè dal
    // sistema di billing in SaaS), poi i sottoutenti locali del control plane.
    let user = await entitlements.verifyOwner({ email, password });
    if (!user) user = await appStore.verifySubUser(email, password);
    if (!user) {
      noteLoginFailure(ip);
      res.status(401).json({ ok: false, error: 'Email o password non validi.' });
      return;
    }
    loginAttempts.delete(ip);
    const token = await appStore.createSession(user);
    const principal = await appStore.principalFor(user);
    auditUi({ event: 'auth:login', category: 'write', status: 'ok', op: 'Accesso utente', ...auditActor(principal), client: ip });
    res.json({ ok: true, rbac: true, token, user: principalView(principal) });
  } catch (err) {
    // Email presente su più tenant con la stessa password: non è un errore
    // interno ma una richiesta ambigua, e va detto all'utente invece di
    // restituire un 500 opaco (o, peggio, farlo entrare nel tenant sbagliato).
    if (err && err.ambiguousLogin) {
      noteLoginFailure(ip);
      res.status(409).json({ ok: false, error: errMsg(err) });
      return;
    }
    res.status(500).json({ ok: false, error: errMsg(err) });
  }
});

app.post('/auth/logout', express.json({ limit: '16kb' }), async (req, res) => {
  const token = String((req.body && req.body.token) || '') || bearerToken(req);
  if (rbacOn() && appStore) await appStore.deleteSession(token).catch(() => {});
  res.json({ ok: true });
});

function bearerToken(req) {
  const raw = String(req.headers.authorization || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Gate dell'handshake Socket.IO: nessun evento viene registrato prima che il
// principal sia noto. È l'unico punto d'ingresso della UI.
io.use(async (socket, next) => {
  if (!rbacOn()) {
    socket.principal = ROOT_PRINCIPAL;
    next();
    return;
  }
  const auth = socket.handshake.auth || {};
  const principal = auth.apiKey
    ? await resolvePrincipalFromApiKey(auth.apiKey)
    : await resolvePrincipalFromToken(auth.token);
  if (!principal) {
    next(new Error('auth_required'));
    return;
  }
  socket.principal = principal;
  next();
});

/* ---------------------------------------------------------------------------
 * Gateway MCP: espone i tools di sola lettura per i client AI sull'endpoint
 * /mcp (Streamable HTTP). Riusa le connessioni salvate e il ciclo di vita
 * delle sessioni di questo file; il budget globale è condiviso coi socket.
 * ------------------------------------------------------------------------- */

const mcpControl = attachMcp(app, {
  loadConnections,
  connLabel,
  connDbType,
  // Unica scrittura su connections.ini concessa al gateway MCP: il flag
  // readOnly di una connessione salvata (mai gli altri campi, mai i segreti).
  // La conferma umana a due passaggi è responsabilità del gateway.
  setConnectionReadOnly: (name, readOnly, ownerId) => {
    const sections = loadConnections(ownerId);
    const key = String(name || '').trim();
    if (!sections[key]) throw new Error(`Connessione salvata "${key}" inesistente.`);
    sections[key].readOnly = readOnly ? 'true' : 'false';
    saveConnections(sections, ownerId);
  },
  establishConnection,
  teardownConnection,
  // Autenticazione dei client MCP: con RBAC acceso ogni richiesta deve portare
  // una API key valida (Authorization: Bearer …), che risolve nel principal i
  // cui grant limitano poi connessioni, database e operazioni.
  rbacOn,
  resolveApiKey: resolvePrincipalFromApiKey,
  allowedConnections,
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

  // Chi è l'utente di questo socket: risolto dal gate dell'handshake (io.use).
  // Con RBAC spento è l'owner locale e nessun controllo ha effetto.
  const principal = principalOf(socket);

  /** @type {Map<string, { strategy: import('./db/DbStrategy'), tunnel: { close: () => void }|null }>} */
  const sessions = new Map();

  async function closeSession(tabId) {
    const sess = sessions.get(tabId);
    if (!sess) return;
    // Rimuovi prima di await: evita doppie chiusure su chiamate concorrenti.
    sessions.delete(tabId);
    activeGlobalSessions--;
    // Script ancora in corso su questa sessione: senza `abort` il ciclo
    // continuerebbe a eseguire istruzioni su una strategia che stiamo
    // chiudendo, e ogni passo fallirebbe rumorosamente dopo la disconnessione.
    if (sess.scripts) {
      for (const run of sess.scripts.values()) run.abort();
      sess.scripts.clear();
    }
    await teardownConnection(sess);
  }

  async function closeAllSessions() {
    for (const tabId of [...sessions.keys()]) await closeSession(tabId);
  }

  socket.closeAllSessions = closeAllSessions;

  // Serializzazione delle aperture/chiusure di connessione per tab (vedi
  // makeConnectLocks): una mappa di lock privata per ogni socket.
  const withConnectLock = makeConnectLocks();

  // Il socket può cadere mentre una connessione è ancora in apertura: in quel
  // caso `closeAllSessions()` non la vede (non è ancora nella mappa) e resterebbe
  // orfana. Il flag permette a `mongo:connect` di accorgersene e smontarla.
  let socketClosed = false;
  socket.on('disconnect', () => { socketClosed = true; });

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
        // `_ctx` (letto da errMsg): contesto attaccato all'errore da chi lo
        // conosce — `establishConnection` per host e porta, `delegate` per il
        // tipo di database — così la spiegazione nomina la destinazione reale
        // invece di restare generica.
        cb({ ok: false, error: errMsg(err) });
      }
    });
  }

  // Registra un evento che delega alla strategia della sessione indicata dal
  // tabId nel payload e adatta il risultato (o l'errore) al formato di
  // risposta { ok, ... } usato dal frontend.
  function delegate(event, fn) {
    safeOn(event, async (payload, cb) => {
      // Campi che SOLO il server può impostare: arrivano fino alle strategie
      // insieme al resto del payload, quindi vanno rimossi da ciò che manda il
      // client. `maxRows` alza il tetto dei risultati fino a 100.000 documenti
      // (DbStrategy.resultCap): pensato per il Query Engine, che lo imposta lato
      // server, ma nulla impediva a un client di metterlo in una normale
      // collection:find e farsi serializzare centinaia di MB per socket e per
      // tab — memoria del processo esaurita in poche richieste.
      for (const serverOnly of SERVER_ONLY_PAYLOAD_FIELDS) delete payload[serverOnly];

      const sess = sessions.get(normTabId(payload.tabId));
      if (!sess) {
        cb({ ok: false, error: errMsg('Nessuna connessione attiva al database.') });
        return;
      }
      // Classificazione (scrittura/lettura/non tracciato) per l'audit: dipende
      // da evento, payload e strategia (vedi collection:aggregate).
      const cls = classifyAudit(event, payload, sess);
      // Pre-check dei permessi: il Proxy autorizzante sulla strategia coprirebbe
      // comunque l'operazione, ma qui l'errore arriva prima di toccare il DB e
      // nomina l'evento richiesto.
      const capability = eventCapability(event, payload, sess);
      if (!can(principal, { connName: sess.connName, capability, db: payload.db, coll: payload.coll })) {
        cb({ ok: false, error: `Permesso negato: non hai i privilegi per l'operazione "${event}" su questa connessione.` });
        return;
      }
      // Query annullabili della griglia: se il payload porta un runId, registra
      // un opHandle in sess.inflight così `query:cancel` può fermare la lettura
      // in corso (killOp / KILL QUERY / pg_cancel_backend — nessuna modifica ai
      // dati). La strategia vi scrive connectionId/processID/comment.
      const runId = payload.runId;
      if (runId) {
        if (!sess.inflight) sess.inflight = new Map();
        payload.opHandle = { runId };
        sess.inflight.set(runId, payload.opHandle);
      }
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
        // Contesto per il messaggio parlante (vedi errMsg): lo stesso codice ha
        // spiegazioni diverse a seconda del DBMS.
        if (err && typeof err === 'object' && !err._ctx) {
          err._ctx = { dbType: sess.dbType, db: payload.db, coll: payload.coll };
        }
        throw err;
      } finally {
        if (runId && sess.inflight) sess.inflight.delete(runId);
      }
    });
  }

  // --- Connection -----------------------------------------------------------

  safeOn('mongo:connect', async (cfg, cb) => {
    if (cfg.tabId != null && String(cfg.tabId).length > 100) {
      throw new Error('tabId non valido.');
    }
    const tabId = normTabId(cfg.tabId);
    // Tutto il corpo (controllo dei limiti compreso) gira dentro il lock: i
    // controlli devono vedere lo stato lasciato dall'apertura precedente.
    await withConnectLock(tabId, async () => {
      if (!sessions.has(tabId) && sessions.size >= MAX_SESSIONS_PER_SOCKET) {
        throw new Error(`Raggiunto il limite di ${MAX_SESSIONS_PER_SOCKET} connessioni contemporanee: chiudi un tab.`);
      }
      // Nome della connessione salvata: è la chiave su cui poggiano i permessi,
      // quindi va risolto PRIMA di aprire qualsiasi cosa.
      const connName = String(cfg.saved || cfg.saveAs || '').trim() || null;
      assertConnAllowed(principal, cfg, connName);
      const guardCtx = { principal, connName };

      // Riconnessione sullo stesso tab: chiudi prima la sessione precedente
      // (libera anche il posto nel budget globale, verificato subito dopo).
      await closeSession(tabId);
      if (activeGlobalSessions >= MAX_GLOBAL_SESSIONS) {
        throw new Error(`Raggiunto il limite globale di ${MAX_GLOBAL_SESSIONS} connessioni al database.`);
      }

      // Il posto nel budget si prenota PRIMA di aprire e si rilascia se
      // l'apertura fallisce: incrementare a cose fatte lasciava una finestra in
      // cui più aperture concorrenti superavano il limite, e ogni errore dopo
      // l'incremento faceva divergere il contatore dalle sessioni reali.
      activeGlobalSessions++;
      let conn;
      try {
        conn = await establishConnection(cfg, guardCtx);
      } catch (err) {
        activeGlobalSessions--;
        throw err;
      }
      // Socket caduto durante l'apertura: la sessione non entrerà mai nella
      // mappa, quindi va smontata qui o resterebbe orfana con il suo tunnel.
      if (socketClosed) {
        activeGlobalSessions--;
        await teardownConnection(conn).catch(() => {});
        throw new Error('Connessione annullata: sessione chiusa.');
      }

      sessions.set(tabId, {
        tabId,
        strategy: conn.strategy,
        tunnel: conn.tunnel,
        dbType: conn.dbType,
        effectiveCfg: conn.effective,
        principal,
        guardCtx,
        // Metadati per l'audit delle scritture (mai segreti): etichetta mostrata
        // in UI, nome della connessione salvata (se noto) e IP del client.
        label: connLabel(conn.effective),
        connName,
        ip,
      });
      // Da qui in poi il rilascio del posto spetta a closeSession.
      try {
        // cfg.saveAs = salva (o aggiorna) la connessione, solo se funzionante.
        const saveAs = String(cfg.saveAs || '').trim();
        if (saveAs) {
          assertConnName(saveAs);
          const conns = loadConnections(principal.ownerId);
          conns[saveAs] = sanitizeConnCfg(conn.effective);
          saveConnections(conns, principal.ownerId);
        }
        // Fiducia al primo uso sulla host key del bastion: registrata sulla
        // connessione salvata, così dal collegamento successivo un cambio di
        // chiave (possibile MITM) viene rilevato e rifiutato.
        rememberSshHostKey(principal, saveAs || connName, conn.tunnel);
        cb({
          ok: true,
          tabId,
          label: connLabel(conn.effective),
          dbType: conn.dbType,
          databases: await conn.strategy.listDatabases(),
          sshHostKey: conn.tunnel ? conn.tunnel.hostKey : undefined,
          sshHostKeyNew: conn.tunnel ? !conn.tunnel.hostKeyKnown : undefined,
        });
      } catch (err) {
        await closeSession(tabId);
        throw err;
      }
    });
  });

  safeOn('mongo:disconnect', async (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    // Anche la chiusura passa dal lock: un disconnect che scavalcasse una
    // apertura ancora in corso non troverebbe nulla da chiudere e la sessione
    // comparirebbe subito dopo, viva sul server ma non più nella UI.
    await withConnectLock(tabId, () => closeSession(tabId));
    cb({ ok: true });
  });

  // Prova una configurazione (o una connessione salvata) senza tenere aperto
  // nulla: connect + listDatabases + disconnect. Serve al pulsante "Testa".
  safeOn('connections:test', async (cfg, cb) => {
    const connName = String(cfg.saved || cfg.saveAs || '').trim() || null;
    assertConnAllowed(principal, cfg, connName);
    if (activeGlobalSessions >= MAX_GLOBAL_SESSIONS) {
      throw new Error(`Raggiunto il limite globale di ${MAX_GLOBAL_SESSIONS} connessioni al database.`);
    }
    activeGlobalSessions++;
    let conn = null;
    try {
      conn = await establishConnection(cfg, { principal, connName });
      const databases = await conn.strategy.listDatabases();
      cb({ ok: true, dbType: conn.dbType, label: connLabel(conn.effective), databases: databases.length });
    } finally {
      if (conn) await teardownConnection(conn);
      activeGlobalSessions--;
    }
  });

  // --- Informazioni sull'installazione ---------------------------------------

  /**
   * Versione dell'applicazione, letta dal `package.json` del server.
   *
   * Serve alla guida introduttiva (`public/js/onboarding.js`) per due decisioni:
   * se mostrare le novità dopo un aggiornamento e cosa scriverci. Passa dal
   * SOCKET, non da `/handshake-check`: quell'endpoint risponde anche a chi non
   * ha superato il gate sull'Origin e non ha alcuna sessione, e la versione
   * esatta di un'installazione raggiungibile in rete è un'informazione che non
   * c'è motivo di regalare a chi non è ancora entrato.
   */
  safeOn('app:info', (_payload, cb) => {
    cb({ ok: true, version: APP_VERSION });
  });

  // --- Vault & Password ------------------------------------------------------

  safeOn('vault:status', (_payload, cb) => {
    cb({
      ok: true,
      locked: encryptionKey === null,
      // `formato` distingue il vault a busta (v2, con salt e scrypt) da quello
      // storico: la UI lo usa per dire che il primo cambio passphrase comporta
      // una migrazione dei segreti.
      formato: vaultMeta ? Vault.VERSION : 1,
      // Valore già noto: NON si deriva la chiave a ogni richiesta (CDB-66).
      // Serve alla modale per capire se sta IMPOSTANDO la prima passphrase o
      // ne sta cambiando una esistente. Non rivela nulla del segreto.
      protetto: vaultProtetto,
    });
  });

  safeOn('vault:unlock', ({ passphrase }, cb) => {
    // Sbloccare il vault significa provare una passphrase globale dell'istanza:
    // riservato all'amministratore dell'account.
    assertManage(principal);

    // Stesso freno del login (CDB-66): ogni tentativo costa uno scrypt da ~28 ms
    // durante i quali l'event loop è fermo per tutte le sessioni, e senza limite
    // questo è insieme un oracolo per la passphrase e un modo per bloccare il
    // server. La chiave è l'indirizzo del client, come per /auth/login.
    const ipClient = socket.handshake.address || 'unknown';
    if (loginBlocked(ipClient)) {
      throw new Error('Troppi tentativi di sblocco falliti: riprova tra un minuto.');
    }

    const esito = tryUnlockVault(passphrase || '');
    if (!esito.ok) noteLoginFailure(ipClient);
    else loginAttempts.delete(ipClient);
    cb(esito);
  });

  /**
   * Ricomincia da capo dopo una passphrase dimenticata: connessioni salvate
   * messe da parte e vault nuovo con la passphrase indicata.
   *
   * È l'unico modo di uscire da un vault bloccato senza conoscere la
   * passphrase, quindi non chiede (e non può chiedere) alcun segreto: la
   * barriera è l'accesso stesso all'applicazione — con RBAC acceso serve la
   * capability `manage`, con RBAC spento chi apre la UI è già l'amministratore
   * della macchina. Cosa distrugge va detto senza giri di parole, ed è per
   * questo che il client deve dichiararlo esplicitamente con `confirm: true`.
   */
  safeOn('vault:reset', ({ passphrase, confirm } = {}, cb) => {
    assertManage(principal);

    if (confirm !== true) {
      throw new Error('Conferma mancante: l\'operazione elimina le connessioni salvate.');
    }
    if (typeof passphrase !== 'string') {
      throw new Error('Passphrase non valida.');
    }

    const res = resetVault(passphrase);
    if (!res.ok) throw new Error(res.error);

    try {
      auditUi({
        event: 'vault:reset',
        category: 'write',
        op: 'Azzeramento del vault (connessioni eliminate, nuova passphrase)',
        status: 'ok',
        details: { spostati: res.spostati },
        ...auditActor(principal),
        client: socket.handshake.address || null,
      });
    } catch { /* audit best-effort */ }

    cb({
      ok: true,
      spostati: res.spostati,
      avviso: res.spostati.length
        ? `Le connessioni precedenti non sono state cancellate: i file sono accanto a connections.ini con suffisso .${res.suffisso} (restano illeggibili senza la vecchia passphrase). Da ora il server va avviato con la nuova passphrase (GUI_MONGO_PASSPHRASE) oppure sbloccato dall'interfaccia.`
        : 'Vault ricreato. Da ora il server va avviato con la nuova passphrase (GUI_MONGO_PASSPHRASE) oppure sbloccato dall\'interfaccia.',
    });
  });

  /**
   * Cambia (o imposta) la passphrase del vault.
   *
   * Il vault è unico per installazione, quindi l'operazione tocca TUTTI i
   * tenant: è riservata a chi ha `manage`. Si pretende la passphrase attuale
   * anche a vault già sbloccato — chi si siede a una sessione lasciata aperta
   * non deve poter cambiare la chiave dei segreti altrui.
   */
  safeOn('vault:setPassphrase', ({ current, next } = {}, cb) => {
    assertManage(principal);

    if (encryptionKey === null) {
      throw new Error('Vault bloccato: sbloccalo con la passphrase attuale prima di cambiarla.');
    }
    if (typeof next !== 'string' || next.length < 1) {
      throw new Error('La nuova passphrase non può essere vuota.');
    }

    // Verifica della passphrase attuale, senza toccare lo stato del vault.
    const attuale = String(current == null ? '' : current);
    const valida = vaultMeta
      ? !!Vault.unwrapDataKey(vaultMeta, attuale)
      : Vault.legacyKey(attuale).equals(encryptionKey);
    if (!valida) {
      throw new Error('La passphrase attuale non è corretta.');
    }

    const res = changeVaultPassphrase(next);
    if (!res.ok) throw new Error(res.error);

    try {
      auditUi({
        event: 'vault:setPassphrase',
        category: 'write',
        op: res.migrated ? 'Cambio passphrase (con migrazione del vault)' : 'Cambio passphrase del vault',
        status: 'ok',
        ...auditActor(principal),
        client: socket.handshake.address || null,
      });
    } catch { /* audit best-effort */ }

    cb({
      ok: true,
      migrated: !!res.migrated,
      // La nuova passphrase vale da SUBITO in memoria, ma i prossimi avvii la
      // pretendono: senza dirlo, un riavvio troverebbe il vault bloccato e
      // sembrerebbe un guasto.
      avviso: 'Da ora il server va avviato con la nuova passphrase (GUI_MONGO_PASSPHRASE) oppure sbloccato dall\'interfaccia.',
    });
  });

  // --- Connessioni salvate ----------------------------------------------------
  // Non richiedono una connessione DB attiva: servono proprio prima di averla.

  safeOn('connections:list', (_payload, cb) => {
    const all = loadConnections(principal.ownerId);
    // Un sottoutente vede soltanto le connessioni su cui ha un grant.
    const visible = allowedConnections(principal, Object.keys(all));
    const connections = visible
      .map((name) => ({ name, label: connLabel(all[name]), dbType: connDbType(all[name]), folder: all[name].folder || '' }));
    cb({ ok: true, connections });
  });

  // Storico delle operazioni critiche/di scrittura via Web UI. Non richiede una
  // connessione DB attiva: legge il file di audit lato server (ui-audit.log).
  //
  // `ui-audit.log` è unico per installazione e contiene nomi di connessione,
  // database, filtri e query di TUTTI i tenant: va quindi filtrato, non negato
  // (negarlo toglierebbe lo Storico Azioni ai sottoutenti, che è una funzione
  // legittima e utile). Il criterio è lo stesso già applicato dal Proxy alle
  // liste di navigazione — si mostra solo il consentito:
  //   · root (RBAC spento o owner locale) → tutto;
  //   · owner                             → le azioni del proprio tenant;
  //   · sottoutente                       → soltanto le proprie.
  safeOn('audit:list', (payload, cb) => {
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(payload.offset, 10) || 0, 0);
    const visibility = principal.root
      ? {}
      : { ownerId: principal.ownerId, ...(principal.owner ? {} : { userId: principal.id }) };
    const { entries, total } = readUiAudit({
      limit,
      offset,
      ...visibility,
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
    assertManage(principal);
    const conns = loadConnections(principal.ownerId);
    if (!conns[name]) throw new Error(`Connessione salvata "${name}" non trovata.`);
    delete conns[name];
    saveConnections(conns, principal.ownerId);
    cb({ ok: true });
  });

  // Campi di una connessione salvata per popolarne il form di modifica.
  // La password non viene mai rimandata al browser: si segnala solo se esiste.
  safeOn('connections:get', ({ name }, cb) => {
    if (!canUseConnection(principal, String(name || ''))) {
      throw new Error(`Permesso negato: nessun accesso alla connessione "${name}".`);
    }
    const conn = loadConnections(principal.ownerId)[name];
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
    assertManage(principal);
    name = String(name || '').trim();
    assertConnName(name);
    const conns = loadConnections(principal.ownerId);
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
    saveConnections(conns, principal.ownerId);
    cb({ ok: true });
  });

  // Esporta il file .ini completo (password incluse, ma cifrate). Con
  // `passphrase` i segreti vengono ri-cifrati con la sua chiave (SHA256), così
  // il file è importabile su un'installazione che gira con QUELLA passphrase —
  // senza mai esporre i segreti in chiaro. Vuota = passphrase di questa
  // installazione (comportamento storico). I segreti sono comunque decifrati in
  // memoria da loadConnections e ri-cifrati qui, mai trasmessi in chiaro.
  safeOn('connections:export', ({ passphrase } = {}, cb) => {
    assertManage(principal);
    const conns = loadConnections(principal.ownerId);
    if (!Object.keys(conns).length) throw new Error('Nessuna connessione salvata da esportare.');
    const pass = passphrase == null ? '' : String(passphrase);
    const cryptoKey = pass !== '' ? crypto.createHash('sha256').update(pass).digest() : encryptionKey;
    const toSave = encryptSections(conns, cryptoKey);
    cb({ ok: true, ini: stringifyIni(toSave) });
  });

  // Importa connessioni da un file .ini: le sezioni con lo stesso nome di una
  // connessione esistente vengono sovrascritte, le altre aggiunte.
  safeOn('connections:import', ({ ini }, cb) => {
    assertManage(principal);
    const incoming = parseIni(String(ini || ''));
    const names = Object.keys(incoming);
    if (!names.length) throw new Error('Nessuna connessione trovata nel file importato.');
    const conns = loadConnections(principal.ownerId);
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
    saveConnections(conns, principal.ownerId);
    cb({ ok: true, imported, overwritten });
  });

  // --- Utenti, permessi e API key (solo con RBAC attivo) ---------------------
  // Riservati a owner/admin del tenant; i limiti del piano (quanti sottoutenti)
  // arrivano dall'Entitlement Provider, cioè dal billing in modalità SaaS.

  function requireRbac() {
    if (!rbacOn()) throw new Error('Gestione utenti non disponibile: CODEDB_RBAC non è attivo su questa istanza.');
    return requireStore();
  }

  safeOn('auth:me', (_payload, cb) => {
    cb({ ok: true, user: principalView(principal) });
  });

  safeOn('roles:list', async (_payload, cb) => {
    const store = requireRbac();
    assertManage(principal);
    const roles = await store.listRoles(principal.ownerId);
    cb({ ok: true, roles: roles.map((r) => ({ name: r.name, capabilities: r.capabilities, builtIn: !!r.builtIn })) });
  });

  safeOn('users:list', async (_payload, cb) => {
    const store = requireRbac();
    assertManage(principal);
    const [users, limits] = await Promise.all([
      store.listSubUsers(principal.ownerId),
      entitlements.getLimits(principal.ownerId),
    ]);
    cb({
      ok: true,
      users: users.map((u) => ({ id: u._id, email: u.email, displayName: u.displayName, status: u.status, createdAt: u.createdAt })),
      limits: { maxSubUsers: limits.maxSubUsers === Infinity ? null : limits.maxSubUsers, plan: limits.plan },
    });
  });

  safeOn('users:create', async ({ email, password, displayName }, cb) => {
    const store = requireRbac();
    assertManage(principal);
    const limits = await entitlements.getLimits(principal.ownerId);
    const current = await store.countSubUsers(principal.ownerId);
    if (current >= limits.maxSubUsers) {
      throw new Error(`Il tuo piano consente al massimo ${limits.maxSubUsers} sottoutenti: elimina un utente esistente o passa a un piano superiore.`);
    }
    const user = await store.createSubUser({ ownerId: principal.ownerId, email, password, displayName });
    await entitlements.reportUsage(principal.ownerId, 'subusers', current + 1).catch(() => {});
    auditUi({ event: 'users:create', category: 'write', status: 'ok', op: 'Creazione sottoutente', ...auditActor(principal), target: user.email });
    cb({ ok: true, user: { id: user._id, email: user.email, displayName: user.displayName, status: user.status } });
  });

  safeOn('users:update', async ({ id, status, displayName, password }, cb) => {
    const store = requireRbac();
    assertManage(principal);
    await store.updateSubUser(principal.ownerId, id, { status, displayName, password });
    auditUi({ event: 'users:update', category: 'write', status: 'ok', op: 'Modifica sottoutente', ...auditActor(principal), target: String(id) });
    cb({ ok: true });
  });

  safeOn('users:delete', async ({ id }, cb) => {
    const store = requireRbac();
    assertManage(principal);
    await store.deleteSubUser(principal.ownerId, id);
    auditUi({ event: 'users:delete', category: 'write', status: 'ok', op: 'Eliminazione sottoutente', ...auditActor(principal), target: String(id) });
    cb({ ok: true });
  });

  safeOn('grants:list', async (_payload, cb) => {
    const store = requireRbac();
    assertManage(principal);
    const grants = await store.listGrants(principal.ownerId);
    cb({ ok: true, grants: grants.map((g) => ({ subjectId: g.subjectId, connName: g.connName, role: g.role, scope: g.scope || null })) });
  });

  safeOn('grants:set', async ({ subjectId, connName, role, scope }, cb) => {
    const store = requireRbac();
    assertManage(principal);
    // Non si può concedere l'accesso a una connessione che non esiste: sarebbe
    // un permesso silenziosamente inefficace.
    if (!loadConnections(principal.ownerId)[String(connName || '').trim()]) {
      throw new Error(`Connessione salvata "${connName}" non trovata.`);
    }
    const grant = await store.setGrant({ ownerId: principal.ownerId, subjectId, connName, role, scope });
    auditUi({ event: 'grants:set', category: 'write', status: 'ok', op: 'Assegnazione permessi', ...auditActor(principal), target: String(subjectId), connection: grant.connName, role: grant.role });
    cb({ ok: true, grant: { subjectId: grant.subjectId, connName: grant.connName, role: grant.role, scope: grant.scope } });
  });

  safeOn('grants:revoke', async ({ subjectId, connName }, cb) => {
    const store = requireRbac();
    assertManage(principal);
    const res = await store.revokeGrant(principal.ownerId, subjectId, connName);
    auditUi({ event: 'grants:revoke', category: 'write', status: 'ok', op: 'Revoca permessi', ...auditActor(principal), target: String(subjectId), connection: String(connName) });
    cb({ ok: true, ...res });
  });

  safeOn('apikeys:list', async (_payload, cb) => {
    const store = requireRbac();
    assertManage(principal);
    const keys = await store.listApiKeys(principal.ownerId);
    cb({
      ok: true,
      keys: keys.map((k) => ({ id: k._id, subjectId: k.subjectId, label: k.label, prefix: k.prefix, connScope: k.connScope, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
    });
  });

  // La chiave in chiaro esiste solo in questa risposta: in DB ne resta l'hash.
  safeOn('apikeys:create', async ({ subjectId, label, connScope }, cb) => {
    const store = requireRbac();
    assertManage(principal);
    const created = await store.createApiKey({
      ownerId: principal.ownerId,
      subjectId: subjectId || principal.id,
      label,
      connScope,
    });
    auditUi({ event: 'apikeys:create', category: 'write', status: 'ok', op: 'Creazione API key', ...auditActor(principal), target: created.subjectId, label: created.label });
    cb({ ok: true, key: created.key, apiKey: { id: created._id, subjectId: created.subjectId, label: created.label, prefix: created.prefix, connScope: created.connScope } });
  });

  safeOn('apikeys:revoke', async ({ id }, cb) => {
    const store = requireRbac();
    assertManage(principal);
    await store.revokeApiKey(principal.ownerId, id);
    auditUi({ event: 'apikeys:revoke', category: 'write', status: 'ok', op: 'Revoca API key', ...auditActor(principal), target: String(id) });
    cb({ ok: true });
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

    if (!session.inflight) session.inflight = new Map();

    const runId = payload.runId;
    const opHandle = { runId };
    if (runId) session.inflight.set(runId, opHandle);

    try {
      const esito = await executeQueryCode(session, { ...payload, runId, opHandle });
      auditQuery(session, esito.db, esito.coll, esito.code, esito.category, esito.op, 'ok', esito.res, null);
      return cb({ ok: true, ...esito.res, data: esito.res.docs });
    } catch (err) {
      const ctx = err.auditCtx;
      if (ctx) auditQuery(session, ctx.db, ctx.coll, ctx.code, ctx.category, ctx.op, 'error', null, err);
      throw err;
    } finally {
      if (runId && session.inflight) {
        session.inflight.delete(runId);
      }
    }
  });

  /* --- Esecuzione di SCRIPT (più istruzioni) ---------------------------------
   * Uno script non viene mandato in blocco al driver: viene diviso e ESEGUITO
   * UN'ISTRUZIONE ALLA VOLTA (vedi db/ScriptRunner.js per il perché). Il run
   * vive nella sessione, quindi sopravvive all'ack: il client riceve subito
   * `{ ok, total }` e poi segue l'avanzamento con gli eventi push
   * `script:progress`, potendo mettere in pausa e riprendere dal punto esatto.
   * ------------------------------------------------------------------------- */

  // Registro dei run per sessione, con l'esito da mostrare (l'ULTIMO result set
  // prodotto: in uno script di 500 righe è quello che l'utente si aspetta di
  // vedere nella griglia dei risultati).
  function scriptsOf(session) {
    if (!session.scripts) session.scripts = new Map();
    return session.scripts;
  }

  // Il progresso è informativo e ad altissima frequenza: mandarlo per ogni
  // istruzione intaserebbe il socket su uno script da decine di migliaia di
  // righe. Si spedisce a intervalli, ma ERRORI, pause e fine passano sempre.
  function makeProgressSender(tab, run, holder) {
    let ultimoInvio = 0;
    return (ev) => {
      const importante = ev.tipo !== 'statement' || (ev.result && !ev.result.ok);
      const adesso = Date.now();
      if (!importante && adesso - ultimoInvio < SCRIPT_PROGRESS_MS) return;
      ultimoInvio = adesso;
      socket.emit('script:progress', {
        tabId: tab,
        ...ev,
        stato: run.state(),
        ...(ev.tipo === 'done' || ev.tipo === 'paused' ? { ultimoRisultato: holder.last } : {}),
      });
    };
  }

  // Esecutore di una singola istruzione dello script: passa dallo STESSO
  // percorso della query singola (`executeQueryCode`), quindi shell MongoDB,
  // SQL→MQL, `USE` e SQL Raw si comportano identicamente dentro e fuori da uno
  // script — e ogni istruzione attraversa il Proxy autorizzante, che decide la
  // capability guardando QUELLA istruzione.
  function makeScriptExecutor(session, ctx, holder, run) {
    return async (stmt) => {
      const opHandle = { runId: run.id };
      run.setOpHandle(opHandle);
      const esito = await executeQueryCode(session, {
        code: stmt.sql,
        engine: ctx.engine,
        db: ctx.db,
        coll: ctx.coll,
        opHandle,
        // Lo script in corso: le operazioni di scrittura vi lasciano un segno,
        // usato dalla voce di audit di chiusura (CDB-69).
        run,
      });
      // Il bersaglio può cambiare in corsa (`USE altro_db`): le istruzioni
      // successive devono seguirlo, come farebbe un client SQL.
      if (esito.res && esito.res.activeDb) ctx.db = esito.res.activeDb;
      if (esito.res && Array.isArray(esito.res.docs) && esito.res.docs.length) {
        holder.last = { docs: esito.res.docs, columns: esito.res.columns || null };
      }
      // Audit: una voce per ogni istruzione di SCRITTURA (sono quelle che
      // lasciano traccia sui dati), non per ogni lettura di uno script lungo —
      // il riepilogo finale copre l'esecuzione nel suo insieme.
      if (esito.category === 'write') {
        auditQuery(session, esito.db, esito.coll, esito.code, 'write', `${esito.op} [script]`, 'ok', esito.res, null);
      }
      return esito.res;
    };
  }

  safeOn('script:execute', async (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    const session = sessions.get(tabId);
    if (!session || !session.strategy) {
      throw new Error('Nessuna connessione attiva al database per questo tab.');
    }

    const runId = String(payload.runId || '').trim();
    if (!runId) throw new Error('runId mancante: impossibile seguire e mettere in pausa lo script.');

    const runs = scriptsOf(session);
    if (runs.has(runId)) throw new Error('Uno script con questo identificativo è già in corso.');
    // I run terminati restano consultabili, ma non all'infinito.
    for (const [id, r] of runs) {
      if (r.status === 'done' || r.status === 'aborted') runs.delete(id);
    }
    if (runs.size >= MAX_SCRIPTS_PER_SESSION) {
      throw new Error(`Troppi script attivi su questa connessione (max ${MAX_SCRIPTS_PER_SESSION}): mettine in pausa o chiudine uno.`);
    }

    const codeStr = String(payload.code || '').trim();
    if (!codeStr) throw new Error('Script vuoto.');

    // Uno SCRIPT JavaScript su MongoDB non si divide per `;`: il separatore
    // sta anche dentro i blocchi `{ … }` di cicli e funzioni, e spezzarlo
    // produrrebbe frammenti privi di senso. Lo si tratta come un'unica unità e
    // sarà l'interprete ad analizzarlo (executeQueryCode → MongoScriptRunner).
    const jsMongo = session.strategy.type === 'mongodb'
      && MongoScriptRunner.sembraScriptJs(codeStr);

    // Le porzioni fatte di soli commenti non sono istruzioni: un file .sql
    // finisce spesso con un commento di chiusura, e mandarlo al database
    // produrrebbe un errore di sintassi per qualcosa che l'utente non ha
    // nemmeno scritto come comando.
    const statements = jsMongo
      ? [{ sql: codeStr, line: 1 }]
      : splitStatementsDetailed(codeStr).filter((st) => stripSqlNoise(st.sql).trim().length > 0);
    if (!statements.length) throw new Error('Lo script non contiene istruzioni eseguibili.');
    if (statements.length > MAX_SCRIPT_STATEMENTS) {
      throw new Error(`Lo script contiene ${statements.length} istruzioni: il massimo per esecuzione è ${MAX_SCRIPT_STATEMENTS}. Caricalo come file per eseguirlo a blocchi.`);
    }

    const ctx = { engine: payload.engine, db: payload.db, coll: payload.coll };
    const holder = { last: null };
    const run = createScriptRun({
      id: runId,
      statements,
      stopOnError: !!payload.stopOnError,
    });
    run.onProgress = makeProgressSender(tabId, run, holder);
    run.ctx = ctx;
    run.holder = holder;
    runs.set(runId, run);

    // Categoria REALE dello script (CDB-69): registrarlo sempre come scrittura
    // riempiva lo Storico Azioni di finte modifiche, e chi filtra per
    // "scrittura" per ricostruire chi ha toccato i dati trovava rumore proprio
    // quando serve precisione. Su SQL la risposta si legge dalle istruzioni con
    // la stessa funzione usata dai permessi; su uno script MongoDB interpretato
    // si sa solo a fine esecuzione, quindi l'avvio è una lettura e sarà la voce
    // di chiusura a dire se ha scritto.
    const scritturaNota = !jsMongo && statements.some((st) => isWriteSql(st.sql));
    run.categoria = scritturaNota ? 'write' : 'read';
    auditQuery(
      session, ctx.db || null, ctx.coll || null, codeStr,
      run.categoria,
      `Avvio script (${statements.length} istruzioni)`,
      'ok', null, null
    );

    // L'ack torna SUBITO: lo script può durare minuti e l'utente deve poter
    // interagire (pausa, chiusura del pannello) mentre gira.
    cb({ ok: true, runId, total: statements.length });

    run.start(makeScriptExecutor(session, ctx, holder, run))
      .then((stato) => finalizzaScript(session, run, stato))
      .catch((err) => {
        console.error('[script] errore imprevisto nel ciclo:', err && err.message);
        // Il run va portato a uno stato TERMINALE e annunciato (CDB-67):
        // altrimenti il client, che ricava la fine solo dai push, resta con un
        // pannello "in esecuzione" che non si chiude e non risponde ai comandi.
        try {
          const stato = run.fail(err);
          finalizzaScript(session, run, stato);
        } catch (e2) {
          console.error('[script] impossibile chiudere il run:', e2 && e2.message);
        }
        // Un run concluso non deve restare nella mappa della sessione.
        try { scriptsOf(session).delete(run.id); } catch { /* sessione già chiusa */ }
      });
  });

  function finalizzaScript(session, run, stato) {
    if (stato.status !== 'done' && stato.status !== 'aborted') return;
    auditQuery(
      session,
      (run.ctx && run.ctx.db) || null,
      (run.ctx && run.ctx.coll) || null,
      `script ${run.id}`,
      // Categoria vera (CDB-69): quella decisa all'avvio per gli script SQL,
      // oppure quella che l'esecuzione ha rivelato per gli script MongoDB
      // interpretati (il Proxy autorizzante ha già visto ogni scrittura).
      run.categoria === 'write' || run.haScritto ? 'write' : 'read',
      `Fine script: ${stato.eseguiti} eseguite, ${stato.falliti} fallite`,
      stato.falliti ? 'error' : 'ok',
      null,
      stato.falliti ? new Error(`${stato.falliti} istruzioni fallite`) : null
    );
  }

  safeOn('script:pause', async (payload, cb) => {
    const session = sessions.get(normTabId(payload.tabId));
    const run = session && session.scripts && session.scripts.get(String(payload.runId || ''));
    if (!run) return cb({ ok: true, paused: false });

    // `pause()` risponde `false` se non c'era nulla da fermare (script già
    // finito o già in pausa): va riportato com'è, altrimenti la UI mostrerebbe
    // "in pausa" su uno script concluso e offrirebbe una ripresa impossibile.
    const paused = run.pause();
    // La pausa si ferma DOPO l'istruzione in corso: troncarla d'ufficio
    // significherebbe interrompere a metà una possibile scrittura, cioè proprio
    // lo stato incoerente che si vuole evitare. Con `force` (l'utente insiste
    // perché l'istruzione è lunga) la si tronca sul database e la si segna come
    // interrotta: non conta come fallimento e la ripresa la rilancia.
    const corrente = run.currentStatement;
    let cancelled = false;
    if (paused && payload.force && corrente && corrente.opHandle && session.strategy) {
      run.markCurrentInterrupted();
      corrente.opHandle.interrotto = true; // ferma anche uno script interpretato
      try {
        const res = await session.strategy.cancelQuery(corrente.opHandle);
        cancelled = !!(res && res.cancelled);
      } catch (_) { /* annullamento best-effort */ }
    }
    cb({ ok: true, paused, cancelled, stato: run.state() });
  });

  safeOn('script:resume', async (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    const session = sessions.get(tabId);
    if (!session || !session.strategy) {
      throw new Error('Nessuna connessione attiva al database per questo tab.');
    }
    const run = session.scripts && session.scripts.get(String(payload.runId || ''));
    if (!run) throw new Error('Script non trovato: potrebbe essere scaduto o la connessione è stata riaperta.');
    if (run.status === 'running') return cb({ ok: true, stato: run.state() });

    const fromIndex = Number.isInteger(payload.fromIndex) ? payload.fromIndex : undefined;
    cb({ ok: true, stato: run.state() });

    run.resume(makeScriptExecutor(session, run.ctx, run.holder, run), fromIndex)
      .then((stato) => finalizzaScript(session, run, stato))
      .catch((err) => {
        console.error('[script] errore imprevisto alla ripresa:', err && err.message);
      });
  });

  // Stato di un run (ripristino della UI dopo un F5 o un cambio di tab).
  safeOn('script:state', async (payload, cb) => {
    const session = sessions.get(normTabId(payload.tabId));
    const runs = session && session.scripts;
    if (!runs) return cb({ ok: true, scripts: [] });

    const runId = payload.runId ? String(payload.runId) : null;
    if (runId) {
      const run = runs.get(runId);
      return cb({ ok: true, stato: run ? run.state() : null, ultimoRisultato: run ? run.holder.last : null });
    }
    cb({ ok: true, scripts: [...runs.values()].map((r) => r.state()) });
  });

  safeOn('script:abort', async (payload, cb) => {
    const session = sessions.get(normTabId(payload.tabId));
    const runs = session && session.scripts;
    const run = runs && runs.get(String(payload.runId || ''));
    if (!run) return cb({ ok: true, aborted: false });
    run.abort();
    const corrente = run.currentStatement;
    if (corrente && corrente.opHandle && session.strategy) {
      corrente.opHandle.interrotto = true;
      try { await session.strategy.cancelQuery(corrente.opHandle); } catch (_) {}
    }
    runs.delete(run.id);
    cb({ ok: true, aborted: true });
  });


  safeOn('query:cancel', async (payload, cb) => {
    const tabId = normTabId(payload.tabId);
    const session = sessions.get(tabId);
    if (!session || !session.strategy || !session.inflight) {
      if (cb) cb({ ok: true, cancelled: false });
      return;
    }

    const runId = payload.runId;
    if (!runId) {
      if (cb) cb({ ok: true, cancelled: false });
      return;
    }

    const opHandle = session.inflight.get(runId);
    if (!opHandle) {
      if (cb) cb({ ok: true, cancelled: false });
      return;
    }

    try {
      // Uno script MongoDB interpretato non è un'operazione del database che
      // si possa uccidere con killOp: gira nel processo CodeDB. Il flag è il
      // suo canale di interruzione, controllato insieme agli altri budget.
      opHandle.interrotto = true;
      const res = await session.strategy.cancelQuery(opHandle);
      // Gli annullamenti del single-flight della griglia (superamento di una
      // pagina da parte della successiva) sono marcati `_bg`: sono housekeeping
      // interno, non un'azione utente, e intaserebbero lo Storico Azioni
      // (peggio col refresh live). Solo gli annullamenti espliciti sono tracciati.
      if (!payload._bg) {
        try {
          auditUi({
            event: 'query:cancel',
            category: 'write',
            op: 'Annullamento query',
            status: 'ok',
            ...auditActor(session && session.principal),
            connection: (session && (session.connName || session.label)) || null,
            dbType: (session && (session.dbType || (session.strategy && session.strategy.type))) || null,
            client: (session && session.ip) || null,
            runId,
            cancelled: res.cancelled
          });
        } catch (_) {}
      }
      if (cb) cb({ ok: true, cancelled: res.cancelled });
    } catch (err) {
      try {
        auditUi({
          event: 'query:cancel',
          category: 'write',
          op: 'Annullamento query',
          status: 'error',
          ...auditActor(session && session.principal),
          connection: (session && (session.connName || session.label)) || null,
          dbType: (session && (session.dbType || (session.strategy && session.strategy.type))) || null,
          client: (session && session.ip) || null,
          runId,
          error: errMsg(err)
        });
      } catch (_) {}
      if (cb) cb({ ok: true, cancelled: false, error: err.message });
    }
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
      cb({ ok: false, error: errMsg('Nessuna connessione attiva al database.') });
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
      cb({ ok: false, error: errMsg('Nessuna connessione attiva al database.') });
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
    // Il motore di backup legge dal driver nativo (strategy.client/pool), fuori
    // dalla portata del Proxy autorizzante: qui si pretende quindi la lettura
    // sull'INTERA connessione, senza scope db/collezione.
    assertWholeConnection(principal, sess.connName, 'read', 'eseguire un backup');
    const db = String(payload.db || '').trim();
    if (!db) throw new Error('Nome database mancante.');
    const type = String(payload.type || 'full').toLowerCase();
    if (!['full', 'incremental', 'differential'].includes(type)) {
      throw new Error(`Tipo backup non valido: ${type}`);
    }
    const onlyCollections = payload.collections
      ? String(payload.collections).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const destRoot = resolveBackupPath(payload.dest, 'destinazione');
    // La destinazione cloud non arriva mai dal client: solo alias pre-approvati.
    const storageUrl = resolveStorageAlias(payload.storage);
    // Portare una copia integrale del database fuori dal perimetro è un atto
    // amministrativo, non una lettura: la sola capability `read` non basta.
    if (storageUrl) {
      assertWholeConnection(principal, sess.connName, 'manage', 'inviare un backup su storage remoto');
    }
    const storage = parseStorage(storageUrl);
    const webhook = resolveSlackWebhook(payload.slackWebhook);
    const log = createLogger(path.join(destRoot, 'backup.log'), { quiet: true });
    // Stesso valore predefinito della CLI (CDB-54): quando il client non lo
    // indica vale 6, non 1. Prima i due canali comprimevano in modo diverso a
    // parità di richiesta, quindi due backup "uguali" avevano dimensioni molto
    // diverse a seconda di chi li avesse lanciati, senza che nulla lo dicesse.
    const level = Math.min(Math.max(parseInt(payload.compressLevel, 10) || 6, 1), 9);
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
    assertManage(principal);
    const destRoot = resolveBackupPath(dest, 'elenco');
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
    // Il restore riscrive interi database: operazione da amministratore.
    assertManage(principal);

    let backupDir = payload.from ? resolveBackupPath(payload.from, 'origine') : null;
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

    const destRoot = resolveBackupPath(payload.dest, 'destinazione');
    const webhook = resolveSlackWebhook(payload.slackWebhook);
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
          // Il DDL del backup viene eseguito sul database: dall'interfaccia non
          // si può scavalcare la validazione, la deroga resta solo nella CLI.
          onlyCollections, drop: !!payload.drop, log, allowUnsafeSchema: false,
        });
      });
      await notifySlack(webhook, `✅ CodeDB restore di \`${summary.targetDb}\` (${connName}, via UI) riuscito in ${formatDuration(Date.now() - t0)}: ${summary.totalDocs} documenti/righe.`, log);
      auditWrite(sess, 'backup:restore', { db: summary.targetDb }, { op: 'Ripristino backup', backupId: String(payload.backupId || '').trim() || undefined }, 'ok', summary, null);
      cb({ ok: true, summary });
    } catch (err) {
      await notifySlack(webhook, `❌ CodeDB restore (${connName}, via UI) FALLITO dopo ${formatDuration(Date.now() - t0)}: ${errMsg(err)}`, log);
      // Un ripristino incompleto porta con sé il riepilogo parziale (quante righe
      // erano state applicate prima di fermarsi): va nell'audit, serve a capire
      // in che stato è rimasto il database di destinazione.
      auditWrite(sess, 'backup:restore', { db: (err.summary && err.summary.targetDb) || payload.targetDb || null }, { op: 'Ripristino backup', backupId: String(payload.backupId || '').trim() || undefined }, 'error', err.summary || null, err);
      throw err;
    }
  });

  safeOn('backup:verify', async (payload, cb) => {
    assertManage(principal);
    let backupDir = payload.from ? resolveBackupPath(payload.from, 'origine') : null;
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
    // Il gestore è sincrono, quindi la chiusura non si può attendere; ciò che
    // NON deve mancare è il `.catch` (CDB-18): senza, un errore nella chiusura
    // di una strategia (rete già caduta, tunnel morto) diventa un unhandled
    // rejection, e in un processo che lo tratta come fatale basta una
    // disconnessione sfortunata per farlo terminare — cioè per far cadere le
    // sessioni di tutti gli altri utenti.
    closeAllSessions().catch((err) => {
      console.error('[Sessioni] Errore chiudendo le sessioni del socket:', errMsg(err));
    });

    const count = ipConnections.get(ip);
    if (count > 1) {
      ipConnections.set(ip, count - 1);
    } else {
      ipConnections.delete(ip);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Lifecycle del Processo, Graceful Shutdown & Gestione Eccezioni Globali
 * ------------------------------------------------------------------------- */

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Shutdown] Ricevuto segnale (${signal}). Avvio chiusura ordinata...`);

  const forceExitTimer = setTimeout(() => {
    console.error('[Shutdown] Timeout di sicurezza (5s) superato: forzatura uscita dal processo.');
    process.exit(signal === 'uncaughtException' ? 1 : 1);
  }, 5000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  try {
    if (mcpControl && typeof mcpControl.shutdownMcp === 'function') {
      console.log('[Shutdown] Chiusura gateway MCP e sessioni MCP attive...');
      await mcpControl.shutdownMcp().catch((err) => {
        console.error('[Shutdown] Errore durante la chiusura MCP:', err.message);
      });
    }

    if (appStore) {
      console.log('[Shutdown] Chiusura connessione al control plane RBAC...');
      await appStore.close().catch(() => {});
    }

    if (io && io.sockets && io.sockets.sockets) {
      console.log('[Shutdown] Chiusura sessioni DB/SSH nei socket WebSocket attivi...');
      for (const socket of io.sockets.sockets.values()) {
        if (typeof socket.closeAllSessions === 'function') {
          await socket.closeAllSessions().catch((err) => {
            console.error('[Shutdown] Errore chiusura sessione socket:', err.message);
          });
        }
      }
    }

    if (io) {
      console.log('[Shutdown] Chiusura server Socket.IO...');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 800);
        try {
          io.close(() => {
            clearTimeout(timer);
            resolve();
          });
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }

    if (server) {
      console.log('[Shutdown] Chiusura server HTTP...');
      if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch { /* ignora */ }
      }
      if (server.listening) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 800);
          try {
            server.close(() => {
              clearTimeout(timer);
              resolve();
            });
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    }

    console.log('[Shutdown] Chiusura pulita completata con successo.');
    clearTimeout(forceExitTimer);
    process.exit(signal === 'uncaughtException' ? 1 : 0);
  } catch (err) {
    console.error('[Shutdown] Errore imprevisto durante lo shutdown:', err);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

function registerGlobalExceptionHandlers() {
  process.on('uncaughtException', (err, origin) => {
    console.error(`[Process] Uncaught Exception (${origin}):`, err);
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Rejection in Promise:', promise, 'motivo:', reason);
  });

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

/* ---------------------------------------------------------------------------
 * Sicurezza del trasporto.
 *
 * Il server è solo `http.createServer`: su HTTP viaggiano in chiaro la password
 * di accesso (POST /auth/login), il token di sessione (handshake Socket.IO e
 * ogni riconnessione), la passphrase del vault (vault:unlock) e le credenziali
 * complete dei database digitate nel form — password SSH e passphrase delle
 * chiavi private comprese. Finché tutto resta su 127.0.0.1 il rischio è teorico;
 * appena si esce dal loopback (il Dockerfile imposta HOST=0.0.0.0) chiunque sia
 * sul percorso legge la chiave di tutti i segreti dell'installazione.
 *
 * Implementare TLS nell'app non è la scelta giusta — un reverse proxy fa il
 * lavoro meglio — ma l'errore va reso impossibile: se si esce dal loopback senza
 * dichiarare di essere dietro un proxy TLS, il server NON parte e spiega come
 * configurarlo. `CODEDB_TRUST_PROXY_TLS=1` è la dichiarazione esplicita.
 * ------------------------------------------------------------------------- */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function assertTransportSafe(host) {
  const h = String(host || '').trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return;
  if (String(process.env.CODEDB_TRUST_PROXY_TLS || '').trim() === '1') {
    console.log('[TLS] HOST non di loopback con CODEDB_TRUST_PROXY_TLS=1: si assume un reverse proxy che termina HTTPS.');
    if (!rbacOn()) {
      console.warn('[Sicurezza] ATTENZIONE: CODEDB_RBAC è spento e il server è raggiungibile dalla rete:');
      console.warn('            chiunque arrivi alla porta ottiene lettura, scrittura e DDL su tutte le connessioni salvate.');
    }
    return;
  }
  console.error(`Avvio rifiutato: HOST="${host}" espone CodeDB oltre il loopback, ma il server parla solo HTTP.`);
  console.error('Su HTTP viaggiano in chiaro password di accesso, token di sessione, passphrase del vault e credenziali dei database.');
  console.error('');
  console.error('Mettilo dietro un reverse proxy che termina HTTPS (nginx, Caddy, Traefik) e poi riavvia con:');
  console.error('  CODEDB_TRUST_PROXY_TLS=1');
  console.error('Esempio minimo con Caddy:   codedb.example.com { reverse_proxy 127.0.0.1:' + PORT + ' }');
  console.error('Per un uso locale, lascia HOST=127.0.0.1 (default).');
  process.exit(1);
}

/**
 * Cifra i segreti rimasti in chiaro nei file del vault, e SOLO quelli.
 *
 * Prima questa migrazione avveniva riscrivendo l'intero vault a ogni avvio
 * riuscito: il file veniva ri-cifrato con IV nuovi e la rotazione consumava una
 * generazione di backup (`.bak` → `.bak2`) ogni volta, così due riavvii
 * bruciavano entrambe le copie di sicurezza. Ora si riscrive solo se c'è
 * davvero qualcosa da cifrare.
 */
function encryptPlaintextSecretsOnce() {
  if (!encryptionKey) return;
  for (const { file, ownerId } of vaultFiles()) {
    let grezzo;
    try { grezzo = parseIni(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const daCifrare = Object.values(grezzo).some((sec) =>
      SECRET_FIELDS.some((f) => sec[f] && !String(sec[f]).startsWith('ENC:')));
    if (!daCifrare) continue;
    try {
      saveConnections(loadConnections(ownerId), ownerId);
      console.log(`Segreti in chiaro cifrati in "${path.basename(file)}".`);
    } catch (err) {
      console.error(`Impossibile cifrare i segreti in chiaro di "${path.basename(file)}": ${errMsg(err)}`);
    }
  }
}

async function startServer() {
  registerGlobalExceptionHandlers();

  const passphrase = process.env.GUI_MONGO_PASSPHRASE;
  if (passphrase) {
    const res = tryUnlockVault(passphrase);
    if (!res.ok) {
      console.error('Passphrase errata fornita via GUI_MONGO_PASSPHRASE: i segreti non si decifrano.');
      process.exit(1);
    }
    encryptPlaintextSecretsOnce();
  } else if (!probeVault()) {
    // Nessuna passphrase nell'ambiente e i segreti cifrati NON si decifrano con
    // la chiave di default: il vault resta BLOCCATO e la passphrase verrà
    // chiesta dall'interfaccia (vault:status → modale di sblocco). Prima si
    // proseguiva con la chiave sbagliata: `decryptSecret` falliva, restituiva il
    // testo "ENC:…" e quel testo finiva come password verso il DBMS, con errori
    // di autenticazione incomprensibili e nessun modo di sbloccare dalla UI.
    // È anche il comportamento che tools/avvio-nascosto.ps1 già documentava.
    encryptionKey = null;
    decryptFailures = 0;
    console.warn('Vault BLOCCATO: connections.ini contiene segreti cifrati e non è stata fornita GUI_MONGO_PASSPHRASE.');
    console.warn('Le connessioni salvate non saranno utilizzabili finché non sblocchi il vault dall\'interfaccia web.');
  }

  // Control plane RBAC: obbligatorio quando il flag è acceso. Un fallimento qui
  // è fatale (come la passphrase errata): meglio non partire che partire senza
  // il livello di autorizzazione che ci si aspetta.
  if (rbacOn()) {
    try {
      appStore = await new AppStore().connect();
      entitlements = createEntitlementProvider(appStore);
      const owner = await entitlements.bootstrap();
      console.log(`[RBAC] Control plane pronto (${appStore.dbName}); owner: ${owner.email} (provider: ${entitlements.name}).`);
    } catch (err) {
      console.error(`[RBAC] Impossibile inizializzare il control plane: ${errMsg(err)}`);
      process.exit(1);
    }
  }

  const HOST = process.env.HOST || '127.0.0.1';
  assertTransportSafe(HOST);
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

if (require.main === module) {
  startServer();
}

module.exports = { app, server, io, gracefulShutdown, registerGlobalExceptionHandlers, startServer, makeConnectLocks };
