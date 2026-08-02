'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario del vault a busta (db/vault.js). Nessun server, nessun DB.
 *
 * Qui si protegge la proprietà che conta: **cambiare passphrase non deve
 * toccare i segreti**, e una passphrase sbagliata non deve mai restituire una
 * chiave utilizzabile.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../db/vault');

let falliti = 0;
function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

console.log('--- Test unitari vault (cifratura a busta) ---');

prova('Cifratura e decifratura di un segreto', () => {
  const { dataKey } = V.createMeta('pass');
  const enc = V.encryptWith('p4ssw0rd', dataKey);
  assert.ok(enc.startsWith('ENC:'), 'formato ENC: atteso');
  assert.ok(!enc.includes('p4ssw0rd'), 'il testo in chiaro non deve comparire');
  assert.strictEqual(V.decryptWith(enc, dataKey), 'p4ssw0rd');
});

prova('Un valore già cifrato non viene cifrato due volte', () => {
  const { dataKey } = V.createMeta('pass');
  const enc = V.encryptWith('x', dataKey);
  assert.strictEqual(V.encryptWith(enc, dataKey), enc);
});

prova('IV casuale: due cifrature dello stesso testo differiscono', () => {
  const { dataKey } = V.createMeta('pass');
  assert.notStrictEqual(V.encryptWith('uguale', dataKey), V.encryptWith('uguale', dataKey));
});

prova('La passphrase corretta sbusta la DEK', () => {
  const { meta, dataKey } = V.createMeta('segreta');
  const aperta = V.unwrapDataKey(meta, 'segreta');
  assert.ok(aperta, 'la chiave doveva essere sbustata');
  assert.strictEqual(aperta.toString('hex'), dataKey.toString('hex'));
});

prova('La passphrase sbagliata NON restituisce una chiave', () => {
  const { meta } = V.createMeta('segreta');
  assert.strictEqual(V.unwrapDataKey(meta, 'sbagliata'), null);
  assert.strictEqual(V.unwrapDataKey(meta, ''), null);
});

prova('Salt diverso a ogni vault: due vault con la stessa passphrase differiscono', () => {
  const a = V.createMeta('uguale');
  const b = V.createMeta('uguale');
  assert.notStrictEqual(a.meta.salt, b.meta.salt, 'il salt deve essere casuale');
  assert.notStrictEqual(a.meta.dek, b.meta.dek);
  // La DEK di uno non deve aprirsi con i metadati dell'altro.
  assert.strictEqual(V.unwrapDataKey(a.meta, 'uguale').toString('hex') === b.dataKey.toString('hex'), false);
});

prova('CAMBIO PASSPHRASE: i segreti restano intatti', () => {
  const { meta, dataKey } = V.createMeta('vecchia');
  const segreto = V.encryptWith('credenziale-db', dataKey);

  const nuovoMeta = V.rewrapDataKey(meta, dataKey, 'nuova');

  // Il segreto non è stato riscritto: è lo stesso identico testo di prima.
  assert.strictEqual(V.decryptWith(segreto, V.unwrapDataKey(nuovoMeta, 'nuova')), 'credenziale-db');
  // E la vecchia passphrase non apre più nulla.
  assert.strictEqual(V.unwrapDataKey(nuovoMeta, 'vecchia'), null);
});

prova('Il cambio passphrase rigenera il salt', () => {
  const { meta, dataKey } = V.createMeta('a');
  const dopo = V.rewrapDataKey(meta, dataKey, 'b');
  assert.notStrictEqual(dopo.salt, meta.salt);
});

prova('Il testimone smaschera una DEK non corrispondente', () => {
  const { meta } = V.createMeta('pass');
  const alterato = { ...meta, check: V.encryptWith('codedb-vault-ok', require('crypto').randomBytes(32)) };
  assert.strictEqual(V.unwrapDataKey(alterato, 'pass'), null, 'un check che non torna deve invalidare');
});

prova('Chiave legacy (v1) riproducibile per la migrazione', () => {
  const k = V.legacyKey('vecchia-pass');
  assert.strictEqual(k.length, 32);
  assert.strictEqual(k.toString('hex'), V.legacyKey('vecchia-pass').toString('hex'));
  assert.notStrictEqual(k.toString('hex'), V.legacyKey('altra').toString('hex'));
});

prova('scrypt è più lento di SHA-256 (è il punto della modifica)', () => {
  const salt = Buffer.alloc(16, 7);
  const t0 = Date.now();
  V.deriveKek('prova', salt);
  const scrypt = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 1000; i++) V.legacyKey('prova');
  const sha = Date.now() - t1;
  assert.ok(scrypt > sha / 100, `scrypt (${scrypt}ms) deve costare molto più di SHA-256 (${sha}ms per 1000)`);
});

prova('Metadati: scrittura atomica e rilettura', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-vault-'));
  const ini = path.join(dir, 'connections.ini');
  try {
    assert.strictEqual(V.readMeta(ini), null, 'senza file i metadati non esistono');

    const { meta, dataKey } = V.createMeta('p');
    V.writeMeta(ini, meta);

    const file = V.metaFileFor(ini);
    assert.ok(fs.existsSync(file), 'il file dei metadati deve esistere');
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), 'nessun temporaneo lasciato indietro');

    const riletto = V.readMeta(ini);
    assert.ok(riletto, 'i metadati devono rileggersi');
    assert.strictEqual(V.unwrapDataKey(riletto, 'p').toString('hex'), dataKey.toString('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

prova('Metadati di versione sconosciuta vengono ignorati', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-vault-'));
  const ini = path.join(dir, 'connections.ini');
  try {
    fs.writeFileSync(V.metaFileFor(ini), JSON.stringify({ version: 99, dek: 'x', salt: 'y' }), 'utf8');
    assert.strictEqual(V.readMeta(ini), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (falliti) {
  console.error(`\n${falliti} test falliti.`);
  process.exitCode = 1;
} else {
  console.log('\nTutti i test del vault superati!');
}
