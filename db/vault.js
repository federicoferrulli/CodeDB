'use strict';

/* ---------------------------------------------------------------------------
 * CodeDB — Vault dei segreti (password DB, credenziali SSH)
 *
 * FORMATO v2: cifratura a busta (envelope encryption)
 *
 *   passphrase --scrypt(salt)--> KEK --avvolge--> DEK --cifra--> i segreti
 *
 * I segreti sono cifrati con una **chiave dati casuale (DEK)**; la passphrase
 * cifra soltanto la DEK, custodita in un file a fianco di connections.ini:
 *
 *   { "version": 2, "kdf": "scrypt", "salt": "…", "N": 16384, "r": 8, "p": 1,
 *     "dek": "ENC:iv:tag:<DEK avvolta con la KEK>", "check": "ENC:…" }
 *
 * Perché non derivare la chiave direttamente dalla passphrase (formato v1):
 *
 *  1. **Cambiare passphrase costa una riga.** Si riavvolge la DEK; i segreti
 *     non si toccano. Nel formato v1 bisognava ri-cifrare ogni segreto, cioè
 *     riscrivere l'unica copia su disco delle credenziali: un'operazione con
 *     una finestra di rischio proprio dove non te la puoi permettere.
 *  2. **Salt + KDF lento.** v1 usava `SHA256(passphrase)` senza salt: un
 *     attacco offline su un file rubato gira a miliardi di tentativi al
 *     secondo. `scrypt` — già usato in `auth/sessions.js` per le password di
 *     accesso — ne regge una manciata. Il vault protegge le credenziali di
 *     tutti i database: non aveva senso che fosse più debole delle password
 *     di login.
 *  3. **"Passphrase sbagliata" diventa una domanda esatta**: o la DEK si
 *     sbusta, o no. Prima lo si deduceva da "qualche segreto non si decifra",
 *     che confonde chiave errata e file corrotto.
 *
 * Il formato dei singoli segreti resta `ENC:iv:tag:ciphertext` (AES-256-GCM),
 * identico a v1: cambia solo QUALE chiave li cifra. I vault v1 continuano a
 * funzionare e vengono migrati una sola volta (vedi `migrateFromLegacy`).
 *
 * Questo modulo è l'UNICO punto in cui vive la crittografia del vault: lo usano
 * sia `server.js` sia la CLI di backup (`backup/lib/connstore.js`), che prima
 * ne avevano due copie destinate a divergere.
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 2;
// Parametri scrypt: costo ~100 ms su hardware da ufficio, pagato una volta
// all'avvio. `maxmem` va alzato di conseguenza (il default di Node è 32 MB e
// N=16384,r=8 ne chiede ~16 MB per blocco più margine).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const CHECK_PLAINTEXT = 'codedb-vault-ok';

/* --- Cifratura dei singoli valori ------------------------------------------ */

/** Cifra un testo con la chiave indicata. I valori già `ENC:` passano intatti. */
function encryptWith(text, key) {
  if (!text || typeof text !== 'string') return text;
  if (text.startsWith('ENC:')) return text;
  if (!key) throw new Error('Impossibile cifrare il segreto: il vault è bloccato.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return `ENC:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

/** Decifra `ENC:iv:tag:ct`. Lancia se la chiave non è quella giusta. */
function decryptWith(text, key) {
  if (!text || typeof text !== 'string') return text;
  if (!text.startsWith('ENC:')) return text;
  if (!key) throw new Error('Vault bloccato');
  const parts = text.split(':');
  if (parts.length !== 4) return text;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
  let out = decipher.update(parts[3], 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

/* --- Derivazione delle chiavi ---------------------------------------------- */

/** Chiave del formato v1: `SHA256(passphrase)`, senza salt. Solo per migrare. */
function legacyKey(passphrase) {
  return crypto.createHash('sha256').update(String(passphrase || '')).digest();
}

/** KEK del formato v2: scrypt(passphrase, salt). */
function deriveKek(passphrase, salt, params = SCRYPT) {
  return crypto.scryptSync(String(passphrase || ''), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: params.maxmem,
  });
}

/* --- Metadati del vault ----------------------------------------------------- */

/**
 * Percorso del file dei metadati, accanto al connections.ini indicato.
 * Sta a fianco e non dentro il .ini perché quel file viene esportato,
 * importato e letto da altri strumenti: una sezione speciale finirebbe per
 * essere scambiata per una connessione.
 */
function metaFileFor(connectionsFile) {
  return process.env.CODEDB_VAULT_FILE
    || path.join(path.dirname(connectionsFile), 'vault.json');
}

function readMeta(connectionsFile) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFileFor(connectionsFile), 'utf8'));
    return meta && meta.version === VERSION && meta.dek && meta.salt ? meta : null;
  } catch {
    return null; // assente o illeggibile: vault in formato v1 (o vuoto)
  }
}

/**
 * Scrittura ATOMICA E DUREVOLE del meta del vault.
 *
 * Il rename è atomico rispetto a chi legge, ma non basta (CDB-68): senza `fsync`
 * il contenuto può essere ancora nella cache di pagina, e dopo un'interruzione
 * di corrente il file può ritrovarsi di lunghezza zero. Qui la differenza è
 * definitiva — `vault.json` è l'unico posto in cui la DEK esiste, e senza DEK i
 * segreti in connections.ini non sono più decifrabili da NESSUNA passphrase.
 *
 * Per lo stesso motivo la generazione precedente viene conservata in `.bak`
 * prima di essere sostituita: costa una copia di poche centinaia di byte e
 * trasforma uno scenario irreversibile in un ripristino manuale.
 */
function writeMeta(connectionsFile, meta) {
  const file = metaFileFor(connectionsFile);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Copia di sicurezza della generazione attuale (se c'è).
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch { /* la copia è un di più: non deve impedire la scrittura */ }

  const dati = JSON.stringify(meta, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, dati, 'utf8');
    fs.fsyncSync(fd); // il contenuto è sul supporto PRIMA che il rename lo renda visibile
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);

  // Anche il rename va reso durevole: su alcuni filesystem la voce di directory
  // sopravvive senza il file. Non tutti i sistemi permettono di aprire una
  // directory in lettura (Windows non lo consente), quindi è best-effort.
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* non supportato su questa piattaforma: il file è comunque già su disco */ }
}

/* --- Creazione, apertura, cambio passphrase --------------------------------- */

/** Nuovo vault: DEK casuale avvolta dalla passphrase indicata. */
function createMeta(passphrase) {
  const salt = crypto.randomBytes(16);
  const dataKey = crypto.randomBytes(32);
  const kek = deriveKek(passphrase, salt);
  return {
    meta: {
      version: VERSION,
      kdf: 'scrypt',
      salt: salt.toString('hex'),
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      dek: encryptWith(dataKey.toString('hex'), kek),
      // Valore noto cifrato con la DEK: permette di verificare che la chiave
      // sbustata sia davvero quella dei segreti, senza doverne aprire uno.
      check: encryptWith(CHECK_PLAINTEXT, dataKey),
    },
    dataKey,
  };
}

/**
 * Sbusta la DEK con la passphrase indicata.
 * @returns {Buffer|null} la chiave dati, oppure null se la passphrase è errata.
 */
function unwrapDataKey(meta, passphrase) {
  if (!meta) return null;
  try {
    const kek = deriveKek(passphrase, Buffer.from(meta.salt, 'hex'), {
      N: meta.N || SCRYPT.N, r: meta.r || SCRYPT.r, p: meta.p || SCRYPT.p,
      keylen: SCRYPT.keylen, maxmem: SCRYPT.maxmem,
    });
    const dataKey = Buffer.from(decryptWith(meta.dek, kek), 'hex');
    if (dataKey.length !== 32) return null;
    // Doppio controllo con il testimone: se anche questo torna, la chiave è
    // quella con cui i segreti sono stati cifrati.
    if (meta.check && decryptWith(meta.check, dataKey) !== CHECK_PLAINTEXT) return null;
    return dataKey;
  } catch {
    return null; // tag GCM non valido = passphrase sbagliata
  }
}

/**
 * Riavvolge la STESSA DEK con una nuova passphrase. È tutto ciò che serve per
 * cambiare passphrase: i segreti restano dove sono, cifrati come prima.
 */
function rewrapDataKey(meta, dataKey, newPassphrase) {
  const salt = crypto.randomBytes(16); // salt nuovo a ogni cambio
  const kek = deriveKek(newPassphrase, salt);
  return {
    ...meta,
    version: VERSION,
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    dek: encryptWith(dataKey.toString('hex'), kek),
    check: encryptWith(CHECK_PLAINTEXT, dataKey),
  };
}

module.exports = {
  VERSION,
  SCRYPT,
  encryptWith,
  decryptWith,
  legacyKey,
  deriveKek,
  metaFileFor,
  readMeta,
  writeMeta,
  createMeta,
  unwrapDataKey,
  rewrapDataKey,
};
