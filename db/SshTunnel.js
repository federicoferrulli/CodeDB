'use strict';

const net = require('net');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { preparaChiaveSsh, MAX_SSH_KEY_BYTES } = require('./SshKey');

function portaLocaleSsh(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return 0;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value).trim())
    || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('La porta locale SSH deve essere un numero intero da 1 a 65535, oppure vuota per disattivare il forwarding locale.');
  }
  return Number(value);
}

function sshAuthMode(ssh) {
  if (ssh.sshAuth) {
    if (!['password', 'upload', 'path'].includes(ssh.sshAuth)) throw new Error('Modalità di autenticazione SSH non valida.');
    return ssh.sshAuth;
  }
  return ssh.sshPrivateKey ? 'upload' : ssh.sshKeyFile ? 'path' : 'password';
}

/* ---------------------------------------------------------------------------
 * Tunnel SSH condiviso tra le strategie: ortogonale al tipo di database.
 *
 * Apre una connessione SSH e una porta su 127.0.0.1 che inoltra verso
 * target.host:target.port. Senza sshLocalPort la porta è effimera, altrimenti
 * quella scelta è utilizzabile anche dagli altri programmi locali.
 *
 * VERIFICA DELLA HOST KEY (`hostVerifier`)
 * Senza, ssh2 accetta qualunque chiave presentata dal server: un attaccante in
 * posizione di rete si sostituisce al bastion e riceve in chiaro le credenziali
 * del database trasportate dal tunnel, senza alcun avviso. Si applica quindi lo
 * stesso modello di OpenSSH con `StrictHostKeyChecking=accept-new`:
 *
 *  · connessione con `sshHostKey` già noto  → l'impronta DEVE corrispondere,
 *    altrimenti si rifiuta con un messaggio esplicito di possibile MITM;
 *  · connessione senza impronta nota        → la si accetta soltanto se il
 *    chiamante la persiste SINCRONAMENTE in connections.ini prima di inviare
 *    le credenziali; se non può farlo, espone l'impronta da approvare;
 *  · CODEDB_SSH_STRICT_HOST_KEY=on          → niente fiducia al primo uso:
 *    l'impronta va configurata prima, altrimenti la connessione è rifiutata.
 *
 * L'impronta è nel formato di OpenSSH (`SHA256:base64`), così è confrontabile
 * con `ssh-keygen -lf <chiave>` o `ssh-keyscan`.
 * ------------------------------------------------------------------------- */

function errText(err) {
  return (err && err.message) || String(err);
}

/** Impronta della host key nel formato OpenSSH: `SHA256:<base64 senza padding>`. */
function hostKeyFingerprint(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function strictHostKey() {
  return String(process.env.CODEDB_SSH_STRICT_HOST_KEY || '').trim().toLowerCase() === 'on';
}

/** Confronto a tempo costante fra impronte (stringhe ASCII di pari lunghezza). */
function sameFingerprint(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

// ssh contiene la password, una chiave caricata o il percorso sul server.
// target = { host, port } endpoint del DB raggiungibile dal server SSH.
// Ritorna { host, port, close } dove host:port è il capo locale del tunnel.
function creaVerificaHostKey(ssh, { persistNewHostKey } = {}) {
  const knownFingerprint = String(ssh.sshHostKey || '').trim();
  let seenFingerprint = null;
  let hostKeyError = null;
  let persisted = false;
  return {
    verify(key, host) {
      seenFingerprint = hostKeyFingerprint(key);
      if (knownFingerprint) {
        if (sameFingerprint(knownFingerprint, seenFingerprint)) return true;
        hostKeyError = new Error(
          `La chiave del server SSH "${host}" NON corrisponde a quella registrata.\n`
          + `  attesa:    ${knownFingerprint}\n  presentata: ${seenFingerprint}\n`
          + 'Connessione interrotta prima dell’autenticazione: possibile attacco man-in-the-middle.',
        );
        return false;
      }
      if (strictHostKey() || typeof persistNewHostKey !== 'function') {
        hostKeyError = new Error(
          `Chiave del server SSH "${host}" non ancora approvata. Impronta presentata: ${seenFingerprint}. `
          + 'Registrala nella connessione e riprova; nessuna credenziale è stata inviata.',
        );
        if (!strictHostKey()) {
          hostKeyError.code = 'SSH_HOST_KEY_UNKNOWN';
          hostKeyError.sshHostKey = seenFingerprint;
        }
        return false;
      }
      try {
        persistNewHostKey(seenFingerprint);
        persisted = true;
        return true;
      } catch (err) {
        hostKeyError = new Error(`Impossibile persistere il pin SSH ${seenFingerprint}: ${errText(err)}. Connessione interrotta.`);
        return false;
      }
    },
    get seenFingerprint() { return seenFingerprint; },
    get known() { return !!knownFingerprint || persisted; },
    get newlyPersisted() { return persisted; },
    get error() { return hostKeyError; },
  };
}

async function openSshTunnel(ssh, target, options = {}) {
  if (!String(ssh.sshHost || '').trim()) throw new Error('Host SSH mancante.');
  if (!String(ssh.sshUser || '').trim()) throw new Error('Utente SSH mancante.');
  const localPort = portaLocaleSsh(ssh.sshLocalPort);
  const authMode = sshAuthMode(ssh);
  const credentials = authMode === 'password' ? null : await preparaChiaveSsh(ssh, options);
  if (credentials?.native) {
    const check = creaVerificaHostKey(ssh, options);
    const hostKey = await verificaHostNativo(ssh, check);
    const tunnel = await require('./SshNativeTunnel').apriTunnelNativo(credentials, {
      host: String(ssh.sshHost).trim(), port: parseInt(ssh.sshPort, 10) || 22,
      username: String(ssh.sshUser).trim(), localPort, target, hostKey,
    });
    return Object.assign(tunnel, { hostKey: check.seenFingerprint, hostKeyKnown: check.known, hostKeyNew: check.newlyPersisted });
  }
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let server = null;
    let settled = false;
    let closing = null;
    const sockets = new Set();
    const tunnelState = { alive: true, lastError: null };

    const close = () => {
      if (closing) return closing;
      tunnelState.alive = false;
      for (const socket of sockets) socket.destroy();
      conn.end();
      closing = new Promise(resolve => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      return closing;
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      close();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    // Stato del tunnel dopo l'apertura: se la connessione SSH cade a runtime
    // (rete, timeout, chiusura remota), 'error'/'close' arrivano con
    // settled già true, quindi `fail` non fa nulla — senza questo flag la
    // strategia DB vedrebbe solo un ECONNREFUSED generico sulla porta locale
    // ormai orfana, invece di un messaggio che spieghi che è il tunnel a
    // essere caduto.
    conn.on('error', (err) => {
      if (settled) {
        tunnelState.lastError = errText(err);
        close();
        return;
      }
      // Se l'handshake è stato interrotto da hostVerifier, ssh2 riporta un
      // errore generico di protocollo: si sostituisce con il motivo vero.
      fail(hostKeyCheck.error || (err.level === 'client-authentication'
        ? new Error('Autenticazione SSH rifiutata. Verifica l’utente SSH e la password, oppure che la chiave pubblica corrispondente sia autorizzata sul server.') : err));
    });
    conn.on('close', () => {
      close();
      if (!settled) fail(hostKeyCheck.error || new Error('Il server SSH ha chiuso la connessione prima di aprire il tunnel.'));
    });

    conn.on('ready', () => {
      server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        if (!tunnelState.alive) {
          socket.destroy();
          return;
        }
        conn.forwardOut('127.0.0.1', socket.remotePort || 0, target.host, target.port, (err, stream) => {
          if (err || socket.destroyed || !tunnelState.alive) {
            stream?.destroy();
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          stream.on('close', () => socket.destroy());
          socket.on('error', () => stream.destroy());
          socket.on('close', () => stream.destroy());
        });
      });
      server.on('error', err => {
        if (localPort && ['EADDRINUSE', 'EACCES'].includes(err.code)) {
          fail(new Error(`La porta locale 127.0.0.1:${localPort} ${err.code === 'EADDRINUSE' ? 'è già in uso' : 'non è disponibile per questo utente'}. Scegli un’altra porta oppure lascia vuoto il forwarding locale.`));
        } else fail(err);
      });
      server.listen(localPort, '127.0.0.1', () => {
        if (!tunnelState.alive) { server.close(); return; }
        settled = true;
        const { port } = server.address();
        resolve({
          host: '127.0.0.1',
          port,
          // Impronta della host key vista in questa connessione e se era già
          // registrata: il chiamante la salva al primo uso (vedi server.js).
          hostKey: hostKeyCheck.seenFingerprint,
          hostKeyKnown: hostKeyCheck.known,
          hostKeyNew: hostKeyCheck.newlyPersisted,
          get alive() { return tunnelState.alive; },
          get lastError() { return tunnelState.lastError; },
          close,
        });
      });
    });

    // Impronta attesa (se già nota) e impronta effettivamente presentata dal
    // server: la seconda viene restituita al chiamante, che la registra alla
    // prima connessione.
    const hostKeyCheck = creaVerificaHostKey(ssh, options);

    const params = {
      host: String(ssh.sshHost || '').trim(),
      port: parseInt(ssh.sshPort, 10) || 22,
      username: String(ssh.sshUser || '').trim(),
      readyTimeout: 8000,
      // Chiamata da ssh2 PRIMA di autenticarsi: qui si decide se il server è
      // quello atteso. Restituire false interrompe l'handshake, quindi nessuna
      // credenziale viene inviata a un server non riconosciuto.
      hostVerifier: (key) => {
        return hostKeyCheck.verify(key, params.host);
      },
    };
    if (!params.host) return fail(new Error('Host SSH mancante.'));
    if (!params.username) return fail(new Error('Utente SSH mancante.'));

    if (authMode !== 'password') {
      if (credentials.agent) params.agent = credentials.agent;
      else params.privateKey = credentials.privateKey;
    } else if (ssh.sshPassword) {
      params.password = ssh.sshPassword;
    } else {
      return fail(new Error('Indica una password SSH oppure scegli un file di chiave privata.'));
    }

    try { conn.connect(params); } catch (err) { fail(err); }
  });
}

function verificaHostNativo(ssh, check) {
  return new Promise((resolve, reject) => {
    const probe = new Client();
    let hostKey, done = false;
    const finish = err => {
      if (done) return;
      done = true;
      probe.destroy();
      if (check.error || !hostKey) reject(check.error || err || new Error('Impossibile verificare la chiave del server SSH.'));
      else resolve(hostKey);
    };
    probe.on('error', finish);
    probe.on('close', () => finish());
    probe.connect({ host: String(ssh.sshHost).trim(), port: parseInt(ssh.sshPort, 10) || 22,
      username: String(ssh.sshUser).trim(), readyTimeout: 8000, authHandler: [],
      hostVerifier(key) {
        if (check.verify(key, String(ssh.sshHost).trim())) hostKey = Buffer.from(key);
        // Il primo collegamento termina prima dell’autenticazione; OpenSSH riusa il pin verificato.
        return false;
      },
    });
  });
}

module.exports = { openSshTunnel, hostKeyFingerprint, sameFingerprint, creaVerificaHostKey, sshAuthMode, portaLocaleSsh, MAX_SSH_KEY_BYTES };
