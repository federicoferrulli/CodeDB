'use strict';
// Prova opzionale con chiave usa-e-getta: nessuna chiave viene salvata nel repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { firmaManifest, verificaManifest, percorsoGpg, verificaFirmaPubblica } = require('../tools/release-assets.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-gpg-test-'));
const home = path.join(root, 'keyring'), assets = path.join(root, 'assets');
fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(assets);
const binary = process.env.GPG_BINARY || 'gpg';
const gpgPath = p => percorsoGpg(p, binary);
const gpg = (args, input) => spawnSync(binary, ['--homedir', gpgPath(home), '--batch', '--no-tty', ...args.map(gpgPath)], { input, encoding: 'utf8', windowsHide: true });
try {
  const gen = gpg(['--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'CodeDB prova <fixture@example.test>', 'rsa2048', 'sign', '1d']);
  assert.equal(gen.status, 0, `Generazione della chiave di prova fallita: ${gen.stderr}`);
  const fingerprint = gpg(['--with-colons', '--list-secret-keys']).stdout.split('\n').find(l => l.startsWith('fpr:')).split(':')[9];
  const exported = gpg(['--armor', '--export-secret-keys', fingerprint]);
  assert.equal(exported.status, 0);
  const env = { ...process.env, CODEDB_RELEASE: 'true', CODEDB_REQUIRE_GPG: 'true', GPG_PRIVATE_KEY: exported.stdout, GPG_KEY_FINGERPRINT: fingerprint };
  fs.writeFileSync(path.join(assets, 'prova.bin'), 'contenuto definitivo');
  assert.throws(() => verificaFirmaPubblica(assets, { CODEDB_REQUIRE_GPG: 'true' }), /obbligatoria assente/);
  firmaManifest(assets, env); verificaManifest(assets); verificaFirmaPubblica(assets, env);
  assert.throws(() => verificaFirmaPubblica(assets, { ...env, GPG_KEY_FINGERPRINT: '0'.repeat(40) }), /fingerprint fidato/);
  assert.equal(gpg(['--verify', path.join(assets, 'SHA256SUMS.asc'), path.join(assets, 'SHA256SUMS')]).status, 0);
  fs.appendFileSync(path.join(assets, 'SHA256SUMS'), 'alterazione controllata\n');
  assert.throws(() => verificaFirmaPubblica(assets, env), /GPG fallita/);
  assert.notEqual(gpg(['--verify', path.join(assets, 'SHA256SUMS.asc'), path.join(assets, 'SHA256SUMS')]).status, 0);
  assert.throws(() => firmaManifest(assets, { ...env, GPG_PRIVATE_KEY: 'chiave non valida' }), /GPG fallita/);
  console.log('OK GPG reale: import temporaneo, firma, fingerprint, verifica e rifiuto di manifest/chiave alterati.');
} finally {
  spawnSync(process.env.GPGCONF_BINARY || 'gpgconf', ['--homedir', gpgPath(home), '--kill', 'all'], { windowsHide: true });
  fs.rmSync(root, { recursive: true, force: true });
}
