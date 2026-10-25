'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const forge = require('node-forge');
const { utils } = require('ssh2');
const { normalizza } = require('../db/SshKeyWorker');

const seq = values => forge.asn1.create(0, 16, true, values);
const oid = value => forge.asn1.create(0, 6, false, forge.asn1.oidToDer(value).getBytes());
const octets = value => forge.asn1.create(0, 4, false, Buffer.from(value).toString('binary'));
const integer = value => forge.asn1.create(0, 2, false, forge.asn1.integerToDer(value).getBytes());
const explicit = value => forge.asn1.create(128, 0, true, [value]);
const der = value => Buffer.from(forge.asn1.toDer(value).getBytes(), 'binary');
const pem = (data, label = 'ENCRYPTED PRIVATE KEY') => Buffer.from(`-----BEGIN ${label}-----\n${data.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`);
const OIDS = { pbes2: '1.2.840.113549.1.5.13', pbkdf2: '1.2.840.113549.1.5.12', scrypt: '1.3.6.1.4.1.11591.4.11', aes: '2.16.840.1.101.3.4.1.42', data: '1.2.840.113549.1.7.1', encryptedData: '1.2.840.113549.1.7.6' };

function algorithm(kind = 'pbkdf2', values) {
  return seq([oid(OIDS.pbes2), seq([
    seq([oid(OIDS[kind] || kind), seq(values || [octets(Buffer.alloc(16, 7)), integer(2048)])]),
    seq([oid(OIDS.aes), octets(Buffer.alloc(16, 8))]),
  ])]);
}

function encrypted(alg, data = Buffer.alloc(16)) { return seq([alg, octets(data)]); }
function content(bytes) { return seq([oid(OIDS.data), explicit(octets(bytes))]); }
function keySafe(key) { return der(seq([seq([oid(forge.pki.oids.pkcs8ShroudedKeyBag), explicit(key)])])); }

function pfx(key, { macIterations, nested = false } = {}) {
  let keyContent = content(keySafe(key));
  if (nested) {
    const salt = Buffer.alloc(16, 7), iv = Buffer.alloc(16, 8);
    const keyBytes = crypto.pbkdf2Sync('prova', salt, 2048, 32, 'sha1');
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBytes, iv);
    const bytes = Buffer.concat([cipher.update(keySafe(key)), cipher.final()]);
    const encryptedContent = seq([oid(OIDS.data), algorithm(), forge.asn1.create(128, 0, false, bytes.toString('binary'))]);
    keyContent = seq([oid(OIDS.encryptedData), explicit(seq([integer(0), encryptedContent]))]);
  }
  const fields = [integer(3), content(der(seq([keyContent])))];
  if (macIterations !== undefined) fields.push(seq([
    seq([seq([oid(forge.pki.oids.sha256), forge.asn1.create(0, 5, false, '')]), octets(Buffer.alloc(32))]),
    octets(Buffer.alloc(16)), integer(macIterations),
  ]));
  return der(seq(fields));
}

function isolated({ nativeKey, mutate } = {}) {
  const filename = require.resolve('../db/SshKeyWorker');
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = instance.require.bind(instance);
  instance.require = name => name === 'node:crypto' && nativeKey ? { ...crypto, createPrivateKey: nativeKey } : originalRequire(name);
  const source = fs.readFileSync(filename, 'utf8');
  instance._compile(mutate ? mutate(source) : source, filename);
  return instance.exports;
}

module.exports = (async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const plain = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const passphrase = 'prova';
  let checks = 0;

  const pbkdf2 = pair.privateKey.export({ format: 'der', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase });
  const salt = Buffer.alloc(16, 7), iv = Buffer.alloc(16, 8);
  const scryptKey = crypto.scryptSync(passphrase, salt, 32, { N: 1024, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-cbc', scryptKey, iv);
  const scrypt = der(encrypted(algorithm('scrypt', [octets(salt), integer(1024), integer(8), integer(1), integer(32)]), Buffer.concat([cipher.update(plain), cipher.final()])));
  const legacy = der(forge.pki.encryptPrivateKeyInfo(forge.asn1.fromDer(plain.toString('binary')), passphrase, { algorithm: '3des', count: 1024 }));
  for (const [name, data] of [['PBKDF2', pbkdf2], ['scrypt', scrypt], ['PBE PKCS#12 legacy', legacy]]) {
    for (const input of [data, pem(data), pem(data, 'PRIVATE KEY')]) {
      const result = await normalizza(input, passphrase);
      assert.equal(result.encrypted, true);
      const parsed = utils.parseKey(result.privateKey);
      const message = Buffer.from('CodeDB: controllo KDF reale');
      assert.equal(crypto.verify('sha1', message, pair.publicKey, parsed.sign(message)), true);
      checks++;
    }
    console.log(`  OK   KDF: ${name} reale in DER e PEM con entrambe le etichette`);
  }

  let nativeCalls = 0;
  const guarded = isolated({ nativeKey() { nativeCalls++; return pair.privateKey; } });
  const saltNode = () => octets(salt);
  const invalidCases = [
    ['PBKDF2 iterazioni', algorithm('pbkdf2', [saltNode(), integer(10000001)])],
    ['PBKDF2 zero', algorithm('pbkdf2', [saltNode(), integer(0)])],
    ['PBKDF2 negativo', algorithm('pbkdf2', [saltNode(), integer(-1)])],
    ['PBKDF2 intero enorme', algorithm('pbkdf2', [saltNode(), forge.asn1.create(0, 2, false, '\x01' + '\x00'.repeat(8))])],
    ['PBKDF2 chiave derivata', algorithm('pbkdf2', [saltNode(), integer(1), integer(65)])],
    ['PBKDF2 salt', algorithm('pbkdf2', [octets(Buffer.alloc(1025)), integer(1)])],
    ['scrypt N', algorithm('scrypt', [saltNode(), integer(1048577), integer(1), integer(1)])],
    ['scrypt N non potenza di due', algorithm('scrypt', [saltNode(), integer(3), integer(1), integer(1)])],
    ['scrypt r', algorithm('scrypt', [saltNode(), integer(16), integer(33), integer(1)])],
    ['scrypt p', algorithm('scrypt', [saltNode(), integer(16), integer(1), integer(17)])],
    ['scrypt memoria', algorithm('scrypt', [saltNode(), integer(1048576), integer(4), integer(1)])],
    ['scrypt lavoro', algorithm('scrypt', [saltNode(), integer(262144), integer(8), integer(8)])],
    ['scrypt chiave derivata', algorithm('scrypt', [saltNode(), integer(16), integer(1), integer(1), integer(65)])],
    ['PBE legacy iterazioni', seq([oid('1.2.840.113549.1.12.1.3'), seq([saltNode(), integer(10000001)])])],
    ['PBE legacy salt', seq([oid('1.2.840.113549.1.5.3'), seq([octets(Buffer.alloc(1025)), integer(1)])])],
  ];
  async function beforeNative(worker, input) {
    nativeCalls = 0;
    await assert.rejects(worker.normalizza(input, passphrase), { code: 'SSH_KEY_RESOURCE_LIMIT' });
    assert.equal(nativeCalls, 0, 'Il KDF deve essere rifiutato prima di entrare in crypto nativo');
  }
  for (const [name, alg] of invalidCases) for (const encode of [der, asn => pem(der(asn)), asn => pem(der(asn), 'PRIVATE KEY')]) {
    await beforeNative(guarded, encode(encrypted(alg)));
    checks++;
  }
  for (const alg of [algorithm('pbkdf2', [saltNode(), integer(10000000), integer(64)]), algorithm('scrypt', [saltNode(), integer(1048576), integer(2), integer(4), integer(64)]), seq([oid('1.2.840.113549.1.12.1.3'), seq([saltNode(), integer(10000000)])])]) {
    nativeCalls = 0;
    await guarded.normalizza(der(encrypted(alg)), passphrase);
    assert.equal(nativeCalls, 1, 'Il confine consentito non deve essere rifiutato; il KDF è simulato nel test');
    checks++;
  }
  for (const alg of [algorithm('1.2.3.4'), seq([oid('1.2.3.5'), seq([saltNode(), integer(1)])])]) {
    nativeCalls = 0;
    await assert.rejects(guarded.normalizza(der(encrypted(alg)), passphrase), { code: 'SSH_KEY_UNSUPPORTED' });
    assert.equal(nativeCalls, 0);
    checks++;
  }
  console.log('  OK   KDF: parametri eccessivi, zero/negativi, confini e algoritmi sconosciuti prima del codice nativo');

  const highCost = encrypted(invalidCases[0][1]);
  const actualCipher = forge.pki.pbe.getCipher, actualMac = forge.pkcs12.generateKey;
  async function beforePfx(worker, input, expectedCipherCalls = 0, spyMac = false) {
    let calls = 0;
    const target = spyMac ? forge.pkcs12 : forge.pki.pbe;
    const method = spyMac ? 'generateKey' : 'getCipher';
    const original = target[method];
    try {
      target[method] = (...args) => {
        calls++;
        if (calls > expectedCipherCalls) throw new Error('Test: vietato eseguire un KDF costoso');
        return original(...args);
      };
      // La parte PKCS#12 è sincrona: ripristina gli hook prima di cedere il turno.
      const promise = worker.normalizza(input, passphrase);
      target[method] = original;
      await assert.rejects(promise, { code: 'SSH_KEY_RESOURCE_LIMIT' });
      assert.equal(calls, expectedCipherCalls, 'Il KDF interno deve essere fermato prima della derivazione');
    } finally { target[method] = original; }
  }
  for (const entry of invalidCases.filter(([name]) => /iterazioni|scrypt N$/.test(name))) {
    await beforePfx(guarded, pfx(encrypted(entry[1])));
    checks++;
  }
  await beforePfx(guarded, pfx(highCost, { nested: true }), 1);
  await beforePfx(guarded, pfx(highCost, { macIterations: 10000001 }), 0, true);
  await beforePfx(guarded, pfx(highCost, { macIterations: 0 }), 0, true);
  checks += 3;
  for (const nested of [false, true]) {
    const result = await normalizza(pfx(forge.asn1.fromDer(pbkdf2.toString('binary')), { nested }), passphrase);
    assert.equal(utils.parseKey(result.privateKey).getPublicSSH().toString('base64'), utils.parseKey(pair.privateKey.export({ format: 'pem', type: 'pkcs1' })).getPublicSSH().toString('base64'));
    checks++;
  }
  assert.equal(forge.pki.pbe.getCipher, actualCipher);
  assert.equal(forge.pkcs12.generateKey, actualMac);
  console.log('  OK   KDF: PFX, MAC e SafeBag dentro SafeContents cifrati; ripristino degli hook');

  const mutant = isolated({ nativeKey() { nativeCalls++; return pair.privateKey; }, mutate: source => {
    const changed = source.replace('function limitaKdf(asn) {', 'function limitaKdf(asn) { return;');
    assert.notEqual(changed, source);
    return changed;
  } });
  await assert.rejects(beforeNative(mutant, pem(der(highCost), 'PRIVATE KEY')), { code: 'ERR_ASSERTION' });
  await assert.rejects(beforePfx(mutant, pfx(highCost)), { code: 'ERR_ASSERTION' });
  const mutantMac = isolated({ mutate: source => {
    const changed = source.replace('if (mac) {', 'if (false && mac) {');
    assert.notEqual(changed, source);
    return changed;
  } });
  await assert.rejects(beforePfx(mutantMac, pfx(highCost, { macIterations: 10000001 }), 0, true), { code: 'ERR_ASSERTION' });
  console.log(`  OK   KDF: ${checks} scenari e sensibilità confermata disattivando le guardie PKCS#8, PFX e MAC`);
})();
