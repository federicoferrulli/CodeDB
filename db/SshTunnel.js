'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client, utils } = require('ssh2');

const MAX_SSH_KEY_BYTES = 64 * 1024;

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
 * Apre una connessione SSH e mette in ascolto una porta locale effimera
 * (127.0.0.1:<random>) che inoltra ogni connessione verso target.host:target.port
 * sul lato remoto. La strategia DB si connette poi al capo locale del tunnel.
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

function openSshTunnel(ssh, target, options = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let server = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (server) try { server.close(); } catch { /* ignora */ }
      conn.end();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    // Stato del tunnel dopo l'apertura: se la connessione SSH cade a runtime
    // (rete, timeout, chiusura remota), 'error'/'close' arrivano con
    // settled già true, quindi `fail` non fa nulla — senza questo flag la
    // strategia DB vedrebbe solo un ECONNREFUSED generico sulla porta locale
    // ormai orfana, invece di un messaggio che spieghi che è il tunnel a
    // essere caduto.
    const tunnelState = { alive: true, lastError: null };

    conn.on('error', (err) => {
      if (settled) {
        tunnelState.alive = false;
        tunnelState.lastError = errText(err);
        return;
      }
      // Se l'handshake è stato interrotto da hostVerifier, ssh2 riporta un
      // errore generico di protocollo: si sostituisce con il motivo vero.
      fail(hostKeyCheck.error || (err.level === 'client-authentication'
        ? new Error('Autenticazione SSH rifiutata. Verifica l’utente SSH e la password, oppure che la chiave pubblica corrispondente sia autorizzata sul server.') : err));
    });
    conn.on('close', () => {
      tunnelState.alive = false;
    });

    conn.on('ready', () => {
      server = net.createServer((socket) => {
        if (!tunnelState.alive) {
          socket.destroy();
          return;
        }
        conn.forwardOut('127.0.0.1', socket.remotePort || 0, target.host, target.port, (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
      server.on('error', fail);
      server.listen(0, '127.0.0.1', () => {
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
          close() {
            try { server.close(); } catch { /* ignora */ }
            conn.end();
          },
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

    const authMode = sshAuthMode(ssh);
    if (authMode !== 'password') {
      let key = ssh.sshPrivateKey;
      if (authMode === 'path') {
        let keyFile = String(ssh.sshKeyFile || '').trim().replace(/^(["'])(.*)\1$/, '$2');
        if (/^~(?:[/\\]|$)/.test(keyFile)) keyFile = path.join(os.homedir(), keyFile.slice(2));
        let fd;
        try {
          fd = fs.openSync(keyFile, 'r');
          if (!fs.fstatSync(fd).isFile()) throw new Error('Non è un file');
          const data = Buffer.alloc(MAX_SSH_KEY_BYTES + 1);
          key = data.subarray(0, fs.readSync(fd, data, 0, data.length, 0));
        } catch {
          return fail(new Error('Impossibile leggere la chiave privata dal percorso sul server CodeDB. Controlla percorso e permessi oppure scegli il file dal tuo dispositivo.'));
        } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
      if (typeof key !== 'string' && !Buffer.isBuffer(key)) return fail(new Error('Seleziona un file di chiave privata SSH.'));
      if (Buffer.byteLength(key) > MAX_SSH_KEY_BYTES) return fail(new Error('La chiave privata SSH supera il limite di 64 KB.'));
      key = key.toString().replace(/^\uFEFF/, '').trim();
      if (!key) return fail(new Error('Il file di chiave privata SSH è vuoto.'));
      if (/^PuTTY-User-Key-File-3:/.test(key)) return fail(new Error('Chiave PuTTY PPK v3 non supportata. Esportala in formato OpenSSH con PuTTYgen e seleziona il file esportato.'));
      try {
        if (/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(key)) {
          const parsed = crypto.createPrivateKey({ key, passphrase: ssh.sshPassphrase || undefined });
          if (!['rsa', 'ec'].includes(parsed.asymmetricKeyType)) throw new Error('Esporta questa chiave in formato OpenSSH.');
          key = parsed.export({ format: 'pem', type: parsed.asymmetricKeyType === 'rsa' ? 'pkcs1' : 'sec1' });
        }
        const parsed = utils.parseKey(key, ssh.sshPassphrase || undefined);
        if (parsed instanceof Error) throw parsed;
        const privateKey = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!privateKey?.getPrivatePEM()) return fail(new Error('Il file contiene una chiave pubblica. Seleziona la chiave privata, non il file .pub.'));
      } catch {
        return fail(new Error(ssh.sshPassphrase
          ? 'Impossibile aprire la chiave privata SSH. Verifica la passphrase e che il file sia una chiave privata OpenSSH o PEM valida.'
          : 'Impossibile aprire la chiave privata SSH. Se è protetta, inserisci la passphrase; altrimenti verifica il formato OpenSSH o PEM.'));
      }
      params.privateKey = key;
      if (ssh.sshPassphrase) params.passphrase = ssh.sshPassphrase;
    } else if (ssh.sshPassword) {
      params.password = ssh.sshPassword;
    } else {
      return fail(new Error('Indica una password SSH oppure scegli un file di chiave privata.'));
    }

    try { conn.connect(params); } catch (err) { fail(err); }
  });
}

module.exports = { openSshTunnel, hostKeyFingerprint, sameFingerprint, creaVerificaHostKey, sshAuthMode, MAX_SSH_KEY_BYTES };
