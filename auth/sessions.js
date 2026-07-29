'use strict';

/* ---------------------------------------------------------------------------
 * Primitive crittografiche dell'autenticazione: hash delle password, token di
 * sessione UI e API key per MCP.
 *
 * Niente JWT e niente dipendenze nuove: i token sono **opachi** (byte casuali)
 * e nel control plane ne vive solo l'hash SHA-256, quindi la revoca è la
 * cancellazione di una riga ed è immediata. Le password usano scrypt del modulo
 * `crypto` nativo, coerentemente con il resto del progetto (il vault di
 * connections.ini usa già AES-GCM di `crypto`).
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = Math.max(parseInt(process.env.CODEDB_SESSION_TTL_MS, 10) || 12 * 60 * 60 * 1000, 60 * 1000);
const API_KEY_PREFIX = 'cdb_';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Token di sessione UI: 32 byte casuali; in DB va solo `hashToken(token)`. */
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** API key: prefisso riconoscibile + 32 byte casuali. Mostrata una volta sola. */
function newApiKey() {
  const raw = API_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { raw, prefix: raw.slice(0, API_KEY_PREFIX.length + 6) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

module.exports = {
  SESSION_TTL_MS,
  API_KEY_PREFIX,
  hashPassword,
  verifyPassword,
  newSessionToken,
  newApiKey,
  hashToken,
};
