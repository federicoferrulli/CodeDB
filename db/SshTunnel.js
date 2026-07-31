'use strict';

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');

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
 *  · connessione senza impronta nota        → la si registra (il chiamante la
 *    salva in connections.ini, campo NON segreto `sshHostKey`) e da quel momento
 *    ogni cambiamento diventa un errore;
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

// ssh = { sshHost, sshPort, sshUser, sshPassword, sshKeyFile, sshPassphrase }
// target = { host, port } endpoint del DB raggiungibile dal server SSH.
// Ritorna { host, port, close } dove host:port è il capo locale del tunnel.
function openSshTunnel(ssh, target) {
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
      fail(hostKeyError || err);
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
          hostKey: seenFingerprint,
          hostKeyKnown: !!knownFingerprint,
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
    const knownFingerprint = String(ssh.sshHostKey || '').trim();
    let seenFingerprint = null;
    let hostKeyError = null;

    const params = {
      host: String(ssh.sshHost || '').trim(),
      port: parseInt(ssh.sshPort, 10) || 22,
      username: String(ssh.sshUser || '').trim(),
      readyTimeout: 8000,
      // Chiamata da ssh2 PRIMA di autenticarsi: qui si decide se il server è
      // quello atteso. Restituire false interrompe l'handshake, quindi nessuna
      // credenziale viene inviata a un server non riconosciuto.
      hostVerifier: (key) => {
        seenFingerprint = hostKeyFingerprint(key);
        if (knownFingerprint) {
          if (sameFingerprint(knownFingerprint, seenFingerprint)) return true;
          hostKeyError = new Error(
            `La chiave del server SSH "${params.host}" NON corrisponde a quella registrata.\n` +
            `  attesa:    ${knownFingerprint}\n` +
            `  presentata: ${seenFingerprint}\n` +
            'Connessione interrotta: potrebbe trattarsi di un attacco man-in-the-middle. ' +
            'Se il server è stato reinstallato o la chiave è cambiata legittimamente, aggiorna il campo "Impronta host SSH" della connessione.'
          );
          return false;
        }
        if (strictHostKey()) {
          hostKeyError = new Error(
            `Chiave del server SSH "${params.host}" non registrata e CODEDB_SSH_STRICT_HOST_KEY=on: ` +
            `configura l'impronta attesa nella connessione prima di collegarti.\n  impronta presentata: ${seenFingerprint}`
          );
          return false;
        }
        // Fiducia al primo uso: si accetta e si registra (il chiamante la salva).
        return true;
      },
    };
    if (!params.host) return fail(new Error('Host SSH mancante.'));
    if (!params.username) return fail(new Error('Utente SSH mancante.'));

    const keyFile = String(ssh.sshKeyFile || '').trim();
    if (keyFile) {
      try {
        params.privateKey = fs.readFileSync(keyFile);
      } catch {
        return fail(new Error(`Impossibile leggere la chiave privata SSH: "${keyFile}".`));
      }
      if (ssh.sshPassphrase) params.passphrase = ssh.sshPassphrase;
    } else if (ssh.sshPassword) {
      params.password = ssh.sshPassword;
    } else {
      return fail(new Error('Indica una password SSH oppure il percorso di una chiave privata.'));
    }

    conn.connect(params);
  });
}

module.exports = { openSshTunnel, hostKeyFingerprint, sameFingerprint };
