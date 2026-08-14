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
// Deve restare allineato ai campi segreti del server: una URI può contenere
// username e password e viene quindi cifrata integralmente nel file INI.
// Senza il campo uri qui la UI salvava correttamente ENC:..., ma la CLI passava
// il ciphertext al driver e ogni backup pianificato falliva all'avvio.
const SECRET_FIELDS = ['password', 'uri', 'sshPassword', 'sshPassphrase'];

// Connessioni per tenant (CDB-50). Con RBAC attivo il server non scrive più nel
// file condiviso: ogni owner ha `data/conns/<ownerId>.ini`. La CLI leggeva solo
// il file storico, quindi su un'installazione multi-tenant non trovava NESSUNA
// connessione e i backup da riga di comando (cioè quelli pianificati) erano
// semplicemente impossibili. Stessa risoluzione del server, stessa variabile
// d'ambiente per la cartella.
const CONNECTIONS_DIR = process.env.CODEDB_CONNECTIONS_DIR
  || path.join(path.dirname(CONNECTIONS_FILE), 'conns');

function connectionsFileFor(ownerId) {
  const id = String(ownerId == null ? '' : ownerId).trim();
  if (!id || id === 'local') return CONNECTIONS_FILE;
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(CONNECTIONS_DIR, `${safe}.ini`);
}

// Owner richiesto: `--owner` della CLI oppure CODEDB_OWNER_ID.
function ownerCorrente(ownerId) {
  return ownerId != null && String(ownerId).trim() !== ''
    ? String(ownerId).trim()
    : (process.env.CODEDB_OWNER_ID || '').trim();
}

// Elenco dei tenant disponibili: serve al messaggio d'errore quando l'owner
// indicato non esiste, così chi lancia un backup pianificato capisce cosa
// scrivere invece di vedere "nessuna connessione".
function tenantDisponibili() {
  try {
    return fs.readdirSync(CONNECTIONS_DIR)
      .filter((f) => f.endsWith('.ini'))
      .map((f) => path.basename(f, '.ini'));
  } catch {
    return [];
  }
}

// Nomi che non possono essere sezioni: `sections.__proto__ = {}` cambierebbe il
// prototipo dell'oggetto invece di aggiungere una connessione (CDB-21). Stessa
// regola del parser del server.
const CHIAVI_VIETATE = new Set(['__proto__', 'constructor', 'prototype']);

function parseIni(text) {
  const sections = Object.create(null);
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      if (CHIAVI_VIETATE.has(header[1])) { current = null; continue; }
      current = sections[header[1]] = Object.create(null);
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) {
      const chiave = line.slice(0, eq).trim();
      if (CHIAVI_VIETATE.has(chiave)) continue;
      current[chiave] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

// true se il file contiene almeno un segreto cifrato: solo in quel caso
// serve chiedere la passphrase all'utente.
function hasEncryptedSecrets(ownerId) {
  try {
    return fs.readFileSync(connectionsFileFor(ownerCorrente(ownerId)), 'utf8').includes('ENC:');
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
function loadConnections(passphrase, ownerId) {
  const owner = ownerCorrente(ownerId);
  const file = connectionsFileFor(owner);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // Owner indicato ma file assente: è un errore di configurazione, non
    // "nessuna connessione". Dirlo, ed elencare i tenant che esistono.
    if (owner) {
      const disponibili = tenantDisponibili();
      throw new Error(
        `Nessun file di connessioni per l'owner "${owner}" (${file}).`
        + (disponibili.length ? ` Owner disponibili: ${disponibili.join(', ')}.` : '')
      );
    }
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
