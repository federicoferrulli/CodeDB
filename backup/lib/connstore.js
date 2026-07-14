'use strict';

/* ---------------------------------------------------------------------------
 * Lettura in SOLA LETTURA delle connessioni salvate (connections.ini).
 *
 * Replica volutamente parseIni/decryptSecret di server.js: la CLI di backup
 * non deve MAI riscrivere connections.ini (una passphrase sbagliata durante
 * la migrazione azzererebbe i segreti), quindi qui esiste solo il percorso
 * di lettura/decifratura e ogni errore di decifratura è fatale.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// CODEDB_CONNECTIONS_FILE: override usato dai test e2e per non toccare mai
// il connections.ini reale (che contiene i segreti dell'utente).
const CONNECTIONS_FILE = process.env.CODEDB_CONNECTIONS_FILE
  || path.join(__dirname, '..', '..', 'connections.ini');
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'];

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

function decryptSecret(text, encryptionKey) {
  if (!text || typeof text !== 'string') return text;
  if (!text.startsWith('ENC:')) return text; // segreto in chiaro (mai migrato)
  const parts = text.split(':');
  if (parts.length !== 4) return text;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(parts[1], 'hex')
  );
  decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
  let decrypted = decipher.update(parts[3], 'hex', 'utf8');
  decrypted += decipher.final('utf8'); // lancia se la passphrase è sbagliata
  return decrypted;
}

// true se il file contiene almeno un segreto cifrato: solo in quel caso
// serve chiedere la passphrase all'utente.
function hasEncryptedSecrets() {
  try {
    return fs.readFileSync(CONNECTIONS_FILE, 'utf8').includes('ENC:');
  } catch {
    return false;
  }
}

// Prompt mascherato (gli asterischi coprono l'input), come il launcher desktop.
function promptPassphrase(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (s.includes(question)) write(s);
      else write('*');
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Carica e decifra le connessioni salvate. passphrase può essere null se il
// file non contiene segreti cifrati. Una decifratura fallita interrompe tutto:
// meglio fermarsi che tentare un backup con credenziali vuote.
function loadConnections(passphrase) {
  let text;
  try {
    text = fs.readFileSync(CONNECTIONS_FILE, 'utf8');
  } catch {
    return {}; // file assente: nessuna connessione salvata
  }
  const sections = parseIni(text);
  const key = passphrase ? crypto.createHash('sha256').update(passphrase).digest() : null;
  for (const [name, sec] of Object.entries(sections)) {
    for (const f of SECRET_FIELDS) {
      if (sec[f] && sec[f].startsWith('ENC:')) {
        if (!key) {
          throw new Error(`La connessione "${name}" ha segreti cifrati: serve la passphrase (GUI_MONGO_PASSPHRASE o prompt).`);
        }
        try {
          sec[f] = decryptSecret(sec[f], key);
        } catch {
          throw new Error(`Passphrase errata: il segreto "${f}" della connessione "${name}" non si decifra.`);
        }
      }
    }
  }
  return sections;
}

module.exports = { loadConnections, hasEncryptedSecrets, promptPassphrase, CONNECTIONS_FILE };
