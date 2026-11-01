'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { utils } = require('ssh2');
const { parsePpk } = require('../db/SshPpk');
const { makePpk, encodePpk, ppkParts, generateKey, field } = require('./ssh-ppk-fixture');

// Vettori pubblici della suite PuTTY (licenza MIT), non credenziali reali.
// https://git.tartarus.org/?p=simon/putty.git;a=blob;f=test/cryptsuite.py
const PUTTY_PUBLIC = 'AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6FJH1W';
const PUTTY_CLEAR = `PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Private-Lines: 1
AAAAIGvvIpl8jyqn8Xufkw6v3FnEGtXF3KWw55AP3/AGEBpY
Private-MAC: 816c84093fc4877e8411b8e5139c5ce35d8387a2630ff087214911d67417a54d
`;
const PUTTY_ENCRYPTED = `PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 13
Argon2-Parallelism: 1
Argon2-Salt: 37c3911bfefc8c1d11ec579627d2b3d9
Private-Lines: 1
amviz4sVUBN64jLO3gt4HGXJosUArghc4Soi7aVVLb2Tir5Baj0OQClorycuaPRd
Private-MAC: 6f5e588e475e55434106ec2c3569695b03f423228b44993a9e97d52ffe7be5a8
`;

function parsed(text) {
  const result = utils.parseKey(text);
  assert(!(result instanceof Error), result?.message);
  return Array.isArray(result) ? result[0] : result;
}

function coherent(text, publicKey) {
  const key = parsed(text);
  assert.equal(key.getPublicSSH().toString('base64'), publicKey);
  const challenge = crypto.randomBytes(64);
  const signature = key.sign(challenge);
  assert(!(signature instanceof Error));
  assert.equal(parsed(key.type + ' ' + publicKey).verify(challenge, signature), true);
}

function isolated({ cryptoOverride, mutate } = {}) {
  const filename = require.resolve('../db/SshPpk');
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = instance.require.bind(instance);
  instance.require = name => name === 'node:crypto' && cryptoOverride ? cryptoOverride : originalRequire(name);
  const source = fs.readFileSync(filename, 'utf8');
  instance._compile(mutate ? mutate(source) : source, filename);
  return instance.exports;
}

module.exports = (async () => {
  let checks = 0;
  for (const algorithm of ['rsa', 'dsa', 'ed25519', 'ecdsa256', 'ecdsa384', 'ecdsa521']) {
    const pair = generateKey(algorithm);
    const publicKey = parsed(pair.private).getPublicSSH().toString('base64');
    for (const version of [2, 3]) {
      for (const passphrase of ['', '  segreto è 🔑  ']) {
        const ppk = await makePpk(pair.private, { version, passphrase, comment: '  prova è 🔑  ' });
        const output = await parsePpk(ppk, passphrase);
        const key = parsed(output);
        assert.equal(key.getPublicSSH().toString('base64'), publicKey);
        const message = crypto.randomBytes(64);
        assert.equal(parsed(pair.public).verify(message, key.sign(message)), true, `${algorithm} v${version} firma valida`);
        if (passphrase) {
          await assert.rejects(parsePpk(ppk), { code: 'SSH_KEY_PASSPHRASE_REQUIRED' });
          await assert.rejects(parsePpk(ppk, 'errata'), { code: 'SSH_KEY_PASSPHRASE_INVALID' });
          checks += 2;
        }
        checks++;
      }
    }
  }
  console.log('  OK   PPK: 24 combinazioni algoritmo/versione/cifratura e passphrase Unicode');

  for (const [text, password] of [[PUTTY_CLEAR, undefined], [PUTTY_ENCRYPTED, 'test-passphrase']]) {
    coherent(await parsePpk(text, password), PUTTY_PUBLIC);
    checks++;
  }
  const fixtureRoot = path.join(path.dirname(require.resolve('ssh2/package.json')), 'test/fixtures/keyParser');
  for (const name of ['ppk_rsa', 'ppk_rsa_enc', 'ppk_dsa_enc']) {
    const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, name + '.result'), 'utf8'));
    const output = await parsePpk(fs.readFileSync(path.join(fixtureRoot, name)), name.endsWith('_enc') ? 'node.js' : undefined);
    coherent(output, expected.publicSSH);
    checks++;
  }
  console.log('  OK   PPK: vettori indipendenti PuTTY v3 e regressioni PuTTY v2 di ssh2');

  const pair = generateKey('ed25519');
  for (const argon2 of ['argon2d', 'argon2i', 'argon2id']) {
    const ppk = await makePpk(pair.private, { passphrase: 'prova', argon2, parallelism: 2 });
    await parsePpk(ppk, 'prova');
    const fallback = isolated({ cryptoOverride: { ...crypto, argon2: undefined } });
    await fallback.parsePpk(ppk, 'prova');
    checks += 2;
  }
  const fallback = isolated({ cryptoOverride: { ...crypto, argon2: undefined } });
  let ticks = 0;
  const interval = setInterval(() => ticks++, 5);
  try { coherent(await fallback.parsePpk(PUTTY_ENCRYPTED, 'test-passphrase'), PUTTY_PUBLIC); }
  finally { clearInterval(interval); }
  assert(ticks >= 2, 'Il fallback Argon2 non deve bloccare il ciclo eventi del server');
  console.log('  OK   PPK: Argon2d/i/id nativo e fallback WASM in worker, server reattivo');

  const unsupportedKey = await makePpk(pair.private, { passphrase: 'prova' });
  const nativeFailure = (mode, code) => ({ ...crypto, argon2(algorithm, options, callback) {
    const failure = Object.assign(new Error('Algoritmo non disponibile nel runtime di prova'), { code });
    if (mode === 'sync') throw failure;
    process.nextTick(() => callback(failure));
  } });
  const usableFallback = parser => assert.doesNotReject(async () => {
    const output = await parser(unsupportedKey, 'prova');
    coherent(output, parsed(pair.private).getPublicSSH().toString('base64'));
  });
  for (const mode of ['sync', 'callback']) {
    const unavailable = nativeFailure(mode, 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED');
    const fallback = isolated({ cryptoOverride: unavailable });
    await usableFallback(fallback.parsePpk);
    await assert.rejects(fallback.parsePpk(unsupportedKey, 'errata'), { code: 'SSH_KEY_PASSPHRASE_INVALID' });
    const failed = isolated({ cryptoOverride: nativeFailure(mode, 'ERR_CRYPTO_OPERATION_FAILED') });
    await assert.rejects(failed.parsePpk(unsupportedKey, 'prova'), { code: 'SSH_KEY_INVALID' });
    const noFallback = isolated({ cryptoOverride: unavailable, mutate: source => {
      const changed = source.replace("if (err.code !== 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED') throw err;", 'throw err;');
      assert.notEqual(changed, source);
      return changed;
    } });
    await assert.rejects(usableFallback(noFallback.parsePpk), { code: 'ERR_ASSERTION' });
    checks += 4;
  }
  console.log('  OK   PPK: API Argon2 presente ma non supportata, fallback sincrono/callback e sensibilità confermati');

  for (const ending of ['\r\n', '\r']) {
    coherent(await parsePpk(PUTTY_CLEAR.replace(/\n/g, ending)), PUTTY_PUBLIC);
    checks++;
  }
  coherent(await parsePpk('\uFEFF' + PUTTY_CLEAR), PUTTY_PUBLIC);
  coherent(await parsePpk(' \n\uFEFF\u2003' + PUTTY_CLEAR + '\u2003\n '), PUTTY_PUBLIC);
  const parts = ppkParts(pair.private);
  const binaryComment = await encodePpk(parts, { comment: Buffer.from([32, 0, 0x80, 0xff, 32]) });
  await parsePpk(Buffer.concat([Buffer.from(' \n'), binaryComment, Buffer.from('\n ')]));
  checks += 3;

  const negatives = [
    PUTTY_CLEAR.replace('Comment: ed25519', 'Comment: alterato-ed25519'),
    PUTTY_CLEAR.replace('Public-Lines: 2', 'Public-Lines: 9999999999'),
    PUTTY_CLEAR.replace('Private-Lines: 1', 'Private-Lines: 0'),
    PUTTY_CLEAR.replace('AAAAIGvv', '!!!!IGvv'),
    PUTTY_CLEAR.replace('JH1W', 'JH1X'),
    PUTTY_CLEAR.replace(/Private-MAC:.*/, 'Private-MAC: 1234'),
    PUTTY_CLEAR + 'Encryption: none\n',
    PUTTY_CLEAR.replace('PuTTY-User-Key-File-3', 'PuTTY-User-Key-File-1'),
    PUTTY_ENCRYPTED.replace('Argon2-Memory: 8192', 'Argon2-Memory: 7'),
    PUTTY_ENCRYPTED.replace('Argon2-Passes: 13', 'Argon2-Passes: 0'),
    PUTTY_ENCRYPTED.replace('Argon2-Salt: 37c3911bfefc8c1d11ec579627d2b3d9', 'Argon2-Salt: aa'),
    Buffer.alloc(65537),
  ];
  for (const text of negatives) {
    await assert.rejects(parsePpk(text, 'test-passphrase'), { code: 'SSH_KEY_INVALID' });
    checks++;
  }
  for (const [before, after] of [['Argon2-Memory: 8192', 'Argon2-Memory: 262145'], ['Argon2-Passes: 13', 'Argon2-Passes: 257'], ['Argon2-Parallelism: 1', 'Argon2-Parallelism: 17'], ['Argon2-Memory: 8192', 'Argon2-Memory: 262144']]) {
    await assert.rejects(parsePpk(PUTTY_ENCRYPTED.replace(before, after), 'test-passphrase'), { code: 'SSH_KEY_RESOURCE_LIMIT' });
    checks++;
  }
  await assert.rejects(parsePpk(PUTTY_ENCRYPTED.replace('JH1W', 'JH1X'), 'test-passphrase'), { code: 'SSH_KEY_PASSPHRASE_INVALID' });
  for (const changed of [
    { ...parts, privateKey: field(Buffer.alloc(31)) },
    { ...parts, privateKey: field(Buffer.alloc(32)) },
    { ...parts, privateKey: Buffer.concat([parts.privateKey, Buffer.from([1])]) },
    { ...parts, publicKey: Buffer.concat([parts.publicKey, Buffer.from([1])]) },
    { ...parts, publicKey: Buffer.from(parts.publicKey).fill(0, 0, 4) },
  ]) {
    await assert.rejects(parsePpk(await encodePpk(changed)), { code: 'SSH_KEY_INVALID' });
    checks++;
  }
  console.log('  OK   PPK: integrità MAC, file troncati, chiavi incoerenti, limiti memoria e costo');

  let running = 0, maximum = 0;
  const limited = isolated({ cryptoOverride: { ...crypto, argon2(algorithm, options, callback) {
    maximum = Math.max(maximum, ++running);
    setTimeout(async () => {
      try {
        const result = await require('hash-wasm')[algorithm]({ password: options.message, salt: options.nonce, memorySize: options.memory, iterations: options.passes, parallelism: options.parallelism, hashLength: 80, outputType: 'binary' });
        running--;
        callback(null, Buffer.from(result));
      } catch (err) { running--; callback(err); }
    }, 10);
  } } });
  const queuedKey = await makePpk(pair.private, { passphrase: 'prova' });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => limited.parsePpk(queuedKey, 'prova')));
  assert.equal(maximum, 2);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'SSH_KEY_RESOURCE_LIMIT').length, 2);
  checks++;

  // La stessa asserzione deve fallire se si spegne di proposito il controllo MAC.
  const integrity = parser => assert.rejects(parser(PUTTY_CLEAR.replace('ed25519-key-', 'commento-alterato-')), { code: 'SSH_KEY_INVALID' });
  await integrity(parsePpk);
  const mutant = isolated({ mutate: source => {
    const changed = source.replace('if (!crypto.timingSafeEqual(file.mac, mac.digest()))', 'if (false && !crypto.timingSafeEqual(file.mac, mac.digest()))');
    assert.notEqual(changed, source);
    return changed;
  } });
  await assert.rejects(integrity(mutant.parsePpk), { code: 'ERR_ASSERTION' });
  console.log(`  OK   PPK: ${checks} verifiche, coda limitata e sensibilità del test MAC confermata`);
})();
