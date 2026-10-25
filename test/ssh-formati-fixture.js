'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { utils } = require('ssh2');
const forge = require('node-forge');

// Il writer PKCS#12 di forge accetta solo RSA: qui il SafeBag contiene PKCS#8
// generico, eventualmente cifrato da OpenSSL tramite node:crypto.
function pfxPkcs8(privateKey, passphrase = null) {
  const { asn1, pki } = forge;
  const sequence = value => asn1.create(0, 16, true, value);
  const oid = value => asn1.create(0, 6, false, asn1.oidToDer(value).getBytes());
  const octets = value => asn1.create(0, 4, false, value);
  const integer = value => asn1.create(0, 2, false, asn1.integerToDer(value).getBytes());
  const explicit = value => asn1.create(128, 0, true, [value]);
  const der = value => asn1.toDer(value).getBytes();
  const content = value => sequence([oid(pki.oids.data), explicit(octets(value))]);
  const encrypted = passphrase !== null;
  const key = privateKey.export({ format: 'der', type: 'pkcs8', ...(encrypted ? { cipher: 'aes-256-cbc', passphrase } : {}) });
  const bag = sequence([oid(encrypted ? pki.oids.pkcs8ShroudedKeyBag : pki.oids.keyBag), explicit(asn1.fromDer(key.toString('binary')))]);
  const safe = der(sequence([content(der(sequence([bag])))]));
  const salt = crypto.randomBytes(16).toString('binary'), iterations = 2048;
  const macKey = forge.pkcs12.generateKey(passphrase || '', forge.util.createBuffer(salt), 3, iterations, 32, forge.md.sha256.create());
  const mac = forge.hmac.create();
  mac.start('sha256', macKey); mac.update(safe);
  const digest = sequence([sequence([oid(pki.oids.sha256), asn1.create(0, 5, false, '')]), octets(mac.digest().getBytes())]);
  return Buffer.from(der(sequence([integer(3), content(safe), sequence([digest, octets(salt), integer(iterations)])])), 'binary');
}

// Solo chiavi usa-e-getta e fixture pubbliche della libreria; nessun file dell'utente.
function generaFormati() {
  const result = [];
  const fixtures = path.join(path.dirname(require.resolve('ssh2/package.json')), 'test/fixtures/keyParser');
  for (const name of fs.readdirSync(fixtures).filter(name => !name.includes('.') && /^(openssh|ppk)_/.test(name))) {
    const data = fs.readFileSync(path.join(fixtures, name));
    const passphrase = name.includes('_enc') ? (name.startsWith('ppk_') ? 'node.js' : 'password') : undefined;
    let key = utils.parseKey(data, passphrase);
    if (Array.isArray(key)) key = key[0];
    if (key instanceof Error || !key.getPrivatePEM()) continue;
    result.push({ name, data, passphrase, publicKey: key });
  }
  for (const type of ['rsa', 'dsa', 'ed25519', 'ec']) {
    const original = result.find(row => row.name === (type === 'ec' ? 'openssh_old_ecdsa' : type === 'ed25519' ? 'openssh_new_ed25519' : `openssh_old_${type}`));
    const privateKey = crypto.createPrivateKey(original.publicKey.getPrivatePEM());
    for (const format of ['pem', 'der']) for (const encrypted of [false, true]) {
      const passphrase = encrypted ? ' frase con spazi è 🔑 ' : undefined;
      const data = Buffer.from(privateKey.export({ format, type: 'pkcs8', ...(encrypted ? { cipher: 'aes-256-cbc', passphrase } : {}) }));
      result.push({ name: `PKCS8-${type}-${format}-${encrypted ? 'protetta' : 'libera'}`, data, passphrase, publicKey: original.publicKey });
    }
    if (type !== 'rsa') for (const passphrase of [null, '', 'password-contenitore-è']) {
      result.push({ name: `PKCS12-${type}-${passphrase === null ? 'libera' : passphrase ? 'protetta' : 'passphrase-vuota'}`,
        data: pfxPkcs8(privateKey, passphrase), passphrase: passphrase || undefined, publicKey: original.publicKey });
    }
  }
  const rsa = result.find(row => row.name === 'openssh_old_rsa');
  const key = forge.pki.privateKeyFromPem(rsa.publicKey.getPrivatePEM());
  for (const passphrase of ['', 'password-contenitore']) {
    const asn = forge.pkcs12.toPkcs12Asn1(key, null, passphrase, { algorithm: 'aes256', count: 10000 });
    result.push({ name: `PKCS12-PFX-${passphrase ? 'protetto' : 'vuoto'}`, data: Buffer.from(forge.asn1.toDer(asn).getBytes(), 'binary'), passphrase, publicKey: rsa.publicKey });
  }
  return result;
}

module.exports = { generaFormati, pfxPkcs8 };
