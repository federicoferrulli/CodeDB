'use strict';

const crypto = require('node:crypto');
const { utils } = require('ssh2');

// Generatore di fixture indipendente dal lettore applicativo: solo chiavi usa-e-getta.
function field(bytes) {
  bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function fields(blob, start = 0) {
  let offset = start;
  return () => {
    const size = blob.readUInt32BE(offset);
    const result = blob.subarray(offset + 4, offset + 4 + size);
    offset += 4 + size;
    return result;
  };
}

function ppkParts(openSshPrivate) {
  const binary = Buffer.from(openSshPrivate.split(/\r?\n/).filter(line => !line.startsWith('---')).join(''), 'base64');
  const outer = fields(binary, 15);
  if (outer().toString() !== 'none') throw new Error('La fixture OpenSSH di origine deve essere senza passphrase.');
  outer();
  outer();
  // La conta delle chiavi è uint32, non una stringa: si riparte dopo l'header fisso.
  const rest = fields(binary, 15 + 8 + 8 + 4 + 4);
  const publicKey = rest();
  const read = fields(rest(), 8);
  const algorithm = read().toString();
  let privateKey;
  if (algorithm === 'ssh-rsa') {
    read(); read();
    const d = read(), iqmp = read(), p = read(), q = read();
    privateKey = Buffer.concat([d, p, q, iqmp].map(field));
  } else if (algorithm === 'ssh-dss') {
    read(); read(); read(); read();
    privateKey = field(read());
  } else if (algorithm === 'ssh-ed25519') {
    read();
    privateKey = field(read().subarray(0, 32));
  } else if (algorithm.startsWith('ecdsa-sha2-')) {
    read(); read();
    let scalar = read();
    while (scalar.length > 1 && scalar[0] === 0 && !(scalar[1] & 0x80)) scalar = scalar.subarray(1);
    privateKey = field(scalar);
  } else throw new Error('Algoritmo fixture non previsto.');
  return { algorithm, publicKey, privateKey };
}

async function encodePpk(parts, options = {}) {
  const version = options.version || 3;
  const passphrase = options.passphrase || '';
  const encrypted = !!passphrase;
  const encryption = encrypted ? 'aes256-cbc' : 'none';
  const comment = Buffer.isBuffer(options.comment) ? options.comment : Buffer.from(options.comment || 'CodeDB chiave usa-e-getta');
  const algorithm = parts.algorithm;
  const publicKey = parts.publicKey;
  let privateKey = parts.privateKey;
  let key, iv, macKey, kdfHeaders = [];
  if (encrypted) privateKey = Buffer.concat([privateKey, crypto.randomBytes((16 - privateKey.length % 16) % 16)]);
  if (version === 2) {
    macKey = crypto.createHash('sha1').update('putty-private-key-file-mac-key' + passphrase).digest();
    if (encrypted) {
      const a = Buffer.from([0, 0, 0, 0]), b = Buffer.from([0, 0, 0, 1]);
      key = Buffer.concat([a, b].map(prefix => crypto.createHash('sha1').update(prefix).update(passphrase).digest())).subarray(0, 32);
      iv = Buffer.alloc(16);
    }
  } else if (encrypted) {
    const argon2 = options.argon2 || 'argon2id';
    const salt = options.salt || crypto.randomBytes(16);
    const memorySize = options.memory || 32, iterations = options.passes || 2, parallelism = options.parallelism || 1;
    // hash-wasm e crypto.argon2 nativo danno implementazioni indipendenti nei test.
    const derived = Buffer.from(await require('hash-wasm')[argon2]({ password: passphrase, salt, memorySize, iterations, parallelism, hashLength: 80, outputType: 'binary' }));
    key = derived.subarray(0, 32);
    iv = derived.subarray(32, 48);
    macKey = derived.subarray(48);
    kdfHeaders = [`Key-Derivation: ${argon2.replace('argon', 'Argon')}`, `Argon2-Memory: ${memorySize}`, `Argon2-Passes: ${iterations}`, `Argon2-Parallelism: ${parallelism}`, `Argon2-Salt: ${salt.toString('hex')}`];
  } else macKey = Buffer.alloc(0);
  const mac = crypto.createHmac(version === 2 ? 'sha1' : 'sha256', macKey)
    .update(Buffer.concat([algorithm, encryption, comment, publicKey, privateKey].map(field))).digest('hex');
  if (encrypted) {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);
    privateKey = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  }
  const lines = bytes => bytes.toString('base64').match(/.{1,64}/g);
  const publicLines = lines(publicKey), privateLines = lines(privateKey);
  return Buffer.concat([
    Buffer.from(`PuTTY-User-Key-File-${version}: ${algorithm}\nEncryption: ${encryption}\nComment: `), comment,
    Buffer.from(`\nPublic-Lines: ${publicLines.length}\n${publicLines.join('\n')}\n${kdfHeaders.length ? kdfHeaders.join('\n') + '\n' : ''}Private-Lines: ${privateLines.length}\n${privateLines.join('\n')}\nPrivate-MAC: ${mac}\n`),
  ]);
}

async function makePpk(openSshPrivate, options = {}) {
  return (await encodePpk(ppkParts(openSshPrivate), options)).toString('utf8');
}

function generateKey(algorithm) {
  if (algorithm === 'dsa') {
    const { Ber } = require('asn1');
    const generated = crypto.generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 });
    const reader = new Ber.Reader(generated.privateKey.export({ type: 'pkcs8', format: 'der' }));
    reader.readSequence(); reader.readInt(); reader.readSequence(); reader.readOID(); reader.readSequence();
    const p = reader.readString(Ber.Integer, true), q = reader.readString(Ber.Integer, true), g = reader.readString(Ber.Integer, true);
    const x = new Ber.Reader(reader.readString(Ber.OctetString, true)).readString(Ber.Integer, true);
    const pub = new Ber.Reader(generated.publicKey.export({ type: 'spki', format: 'der' }));
    pub.readSequence(); pub.readSequence(); pub.readOID(); pub.readSequence();
    pub.readString(Ber.Integer, true); pub.readString(Ber.Integer, true); pub.readString(Ber.Integer, true);
    const y = new Ber.Reader(pub.readString(Ber.BitString, true).subarray(1)).readString(Ber.Integer, true);
    const publicKey = Buffer.concat(['ssh-dss', p, q, g, y].map(field));
    const secret = Buffer.concat([Buffer.alloc(8), ...['ssh-dss', p, q, g, y, x, 'fixture DSA'].map(field)]);
    const padding = Buffer.from(Array.from({ length: (8 - secret.length % 8) % 8 }, (_, i) => i + 1));
    const binary = Buffer.concat([Buffer.from('openssh-key-v1\0'), field('none'), field('none'), field(''), Buffer.from([0, 0, 0, 1]), field(publicKey), field(Buffer.concat([secret, padding]))]);
    return { private: '-----BEGIN OPENSSH PRIVATE KEY-----\n' + binary.toString('base64').match(/.{1,70}/g).join('\n') + '\n-----END OPENSSH PRIVATE KEY-----\n', public: 'ssh-dss ' + publicKey.toString('base64') };
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const pair = algorithm === 'rsa' ? utils.generateKeyPairSync('rsa', { bits: 2048 })
      : algorithm.startsWith('ecdsa') ? utils.generateKeyPairSync('ecdsa', { bits: Number(algorithm.slice(-3)) })
        : utils.generateKeyPairSync('ed25519');
    // Il generatore ssh2 tronca raramente gli zeri iniziali di Ed25519.
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error('Il generatore SSH non ha prodotto una fixture valida.');
}

module.exports = { makePpk, encodePpk, ppkParts, generateKey, field };
