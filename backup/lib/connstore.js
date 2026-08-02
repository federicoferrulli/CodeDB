'use strict';

/* ---------------------------------------------------------------------------
 * Lettura in SOLA LETTURA delle connessioni salvate (connections.ini).
 *
 * La CLI di backup non deve MAI riscrivere connections.ini (una passphrase
 * sbagliata durante la migrazione azzererebbe i segreti), quindi qui esiste
 * solo il percorso di lettura/decifratura e ogni errore è fatale.
 *
 * La crittografia NON è replicata: viene da `db/vault.js`, lo stesso modulo che
 * usa il server. Prima qui c'era una seconda copia di `decryptSecret` e della
 * derivazione della chiave: due implementazioni della stessa cosa che al primo
 * cambio di formato sarebbero divergute, lasciando la CLI incapace di leggere
 * un vault che la UI apre senza problemi.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Vault = require('../../db/vault');

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

// true se il file contiene almeno un segreto cifrato: solo in quel caso
// serve chiedere la passphrase all'utente.
function hasEncryptedSecrets() {
  try {
    return fs.readFileSync(CONNECTIONS_FILE, 'utf8').includes('ENC:');
  } catch {
    return false;
  }
}

/**
 * Chiave con cui sono cifrati i segreti, per la passphrase indicata.
 *
 * Vault v2 (metadati presenti): si sbusta la DEK — e una passphrase sbagliata
 * si riconosce subito, con un messaggio chiaro, invece di far fallire la prima
 * decifratura più avanti. Vault v1: la chiave è derivata dalla passphrase.
 */
function resolveKey(passphrase) {
  const meta = Vault.readMeta(CONNECTIONS_FILE);
  if (meta) {
    const dataKey = Vault.unwrapDataKey(meta, passphrase || '');
    if (!dataKey) {
      throw new Error('Passphrase errata: la chiave del vault non si apre.');
    }
    return dataKey;
  }
  return passphrase ? Vault.legacyKey(passphrase) : null;
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
  const key = resolveKey(passphrase);
  for (const [name, sec] of Object.entries(sections)) {
    for (const f of SECRET_FIELDS) {
      if (sec[f] && sec[f].startsWith('ENC:')) {
        if (!key) {
          throw new Error(`La connessione "${name}" ha segreti cifrati: serve la passphrase (GUI_MONGO_PASSPHRASE o prompt).`);
        }
        try {
          sec[f] = Vault.decryptWith(sec[f], key);
        } catch {
          throw new Error(`Passphrase errata: il segreto "${f}" della connessione "${name}" non si decifra.`);
        }
      }
    }
  }
  return sections;
}

module.exports = { loadConnections, hasEncryptedSecrets, promptPassphrase, CONNECTIONS_FILE };
