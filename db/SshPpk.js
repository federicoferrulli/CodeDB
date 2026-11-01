'use strict';

const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { utils } = require('ssh2');

// Specifica: https://www.puttyssh.org/0.83/htmldoc/AppendixC.html
// I costi arrivano dal file: limiti e coda impediscono di saturare il server.
const MAX_BYTES = 64 * 1024;
const MAX_MEMORY = 256 * 1024;
const MAX_WORK = 1024 * 1024;
let active = 0;
const queue = [];

function error(message, code = 'SSH_KEY_INVALID') {
  return Object.assign(new Error(message), { code });
}

function invalid() {
  return error('Il file PuTTY PPK è incompleto, alterato o non valido. Seleziona il file originale della chiave privata.');
}

function uint32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function string(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function reader(bytes) {
  let offset = 0;
  return {
    read(integer = false) {
      if (offset + 4 > bytes.length) throw invalid();
      const length = bytes.readUInt32BE(offset);
      offset += 4;
      if (length > bytes.length - offset) throw invalid();
      const value = bytes.subarray(offset, offset += length);
      if (integer && (!length || length > 2049 || value[0] & 0x80
        || (value[0] === 0 && (length === 1 || !(value[1] & 0x80))))) throw invalid();
      return value;
    },
    get remaining() { return bytes.length - offset; },
  };
}

function readFile(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw invalid();
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!bytes.length || bytes.length > MAX_BYTES) throw invalid();
  // Si tollerano gli spazi esterni storici senza ricodificare i byte del commento.
  const text = bytes.toString('utf8');
  const start = Buffer.byteLength(text.match(/^\s*/u)[0]);
  const end = bytes.length - Buffer.byteLength(text.match(/\s*$/u)[0]);
  const lines = bytes.subarray(start, end).toString('latin1').split(/\r\n|\n|\r/);
  while (lines.at(-1) === '') lines.pop();
  let index = 0;
  const first = /^PuTTY-User-Key-File-([23]): ([a-z0-9@.-]+)$/.exec(lines[index++] || '');
  if (!first) throw invalid();
  const version = Number(first[1]), algorithm = first[2];
  if (!/^(?:ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521))$/.test(algorithm)) {
    throw error('Questo algoritmo di chiave PuTTY non è supportato dal protocollo SSH disponibile. Usa RSA, DSA, Ed25519 o ECDSA NIST.', 'SSH_KEY_UNSUPPORTED');
  }
  function header(name) {
    const line = lines[index++];
    if (!line?.startsWith(name + ': ')) throw invalid();
    return line.slice(name.length + 2);
  }
  function integer(name) {
    const value = header(name);
    if (!/^[1-9]\d{0,9}$/.test(value)) throw invalid();
    return Number(value);
  }
  function blob(name) {
    const count = integer(name + '-Lines');
    if (count > 2048 || index + count > lines.length) throw invalid();
    const encodedLines = lines.slice(index, index += count);
    if (encodedLines.some(line => !/^[A-Za-z0-9+/]+={0,2}$/.test(line))) throw invalid();
    const encoded = encodedLines.join('');
    const decoded = Buffer.from(encoded, 'base64');
    if (!decoded.length || decoded.toString('base64') !== encoded) throw invalid();
    return decoded;
  }
  const encryption = header('Encryption');
  if (!['none', 'aes256-cbc'].includes(encryption)) throw invalid();
  const comment = Buffer.from(header('Comment'), 'latin1');
  const publicKey = blob('Public');
  let kdf;
  if (version === 3 && encryption !== 'none') {
    const algorithm = header('Key-Derivation').toLowerCase();
    if (!['argon2d', 'argon2i', 'argon2id'].includes(algorithm)) throw invalid();
    const memory = integer('Argon2-Memory');
    const passes = integer('Argon2-Passes');
    const parallelism = integer('Argon2-Parallelism');
    const salt = header('Argon2-Salt');
    if (!/^(?:[a-fA-F0-9]{2}){8,64}$/.test(salt) || memory < 8 * parallelism) throw invalid();
    if (memory > MAX_MEMORY || passes > 256 || parallelism > 16 || memory * passes > MAX_WORK) {
      throw error('La chiave PPK richiede troppa memoria o tempo per essere aperta in sicurezza. Riesportala con i parametri predefiniti di PuTTYgen.', 'SSH_KEY_RESOURCE_LIMIT');
    }
    kdf = { algorithm, memory, passes, parallelism, salt: Buffer.from(salt, 'hex') };
  }
  const privateKey = blob('Private');
  const mac = header('Private-MAC');
  if (!(version === 2 ? /^[a-fA-F0-9]{40}$/ : /^[a-fA-F0-9]{64}$/).test(mac)
    || index !== lines.length || (encryption !== 'none' && privateKey.length % 16)) throw invalid();
  return { version, algorithm, encryption, comment, publicKey, privateKey, mac: Buffer.from(mac, 'hex'), kdf };
}

async function derive(kdf, password) {
  if (active >= 2) {
    if (queue.length >= 8) throw error('Sono già in corso diverse verifiche di chiavi SSH. Riprova tra qualche secondo.', 'SSH_KEY_RESOURCE_LIMIT');
    await new Promise(resolve => queue.push(resolve));
  } else active++;
  try {
    if (typeof crypto.argon2 === 'function') {
      try {
        return await new Promise((resolve, reject) => crypto.argon2(kdf.algorithm, {
          message: password, nonce: kdf.salt, memory: kdf.memory,
          passes: kdf.passes, parallelism: kdf.parallelism, tagLength: 80,
        }, (err, result) => err ? reject(err) : resolve(result)));
      } catch (err) {
        // Electron espone l'API anche quando BoringSSL non implementa Argon2.
        if (err.code !== 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED') throw err;
      }
    }
    if (!isMainThread) return Buffer.from(await deriveWasm(kdf, password));
    // La Promise di hash-wasm esegue il calcolo sul chiamante: serve un worker.
    return await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { codedbPpkArgon2: true, kdf, password } });
      let done = false;
      const finish = (err, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        if (err) reject(err); else resolve(Buffer.from(result));
      };
      const timer = setTimeout(() => finish(error('La verifica della chiave PPK ha superato il tempo disponibile. Riprova o riesporta la chiave con i parametri predefiniti di PuTTYgen.', 'SSH_KEY_RESOURCE_LIMIT')), 30000);
      worker.once('message', result => finish(result.error ? invalid() : null, result.key));
      worker.once('error', () => finish(invalid()));
      worker.once('exit', () => { if (!done) finish(invalid()); });
    });
  } finally {
    if (queue.length) queue.shift()(); else active--;
  }
}

function openssh(file, privateBytes) {
  const pub = reader(file.publicKey), priv = reader(privateBytes);
  if (pub.read().toString() !== file.algorithm) throw invalid();
  let fields;
  switch (file.algorithm) {
    case 'ssh-rsa': {
      const e = pub.read(true), n = pub.read(true);
      const d = priv.read(true), p = priv.read(true), q = priv.read(true), iqmp = priv.read(true);
      fields = [n, e, d, iqmp, p, q];
      break;
    }
    case 'ssh-dss':
      fields = [pub.read(true), pub.read(true), pub.read(true), pub.read(true), priv.read(true)];
      break;
    case 'ssh-ed25519': {
      const point = pub.read(), seed = priv.read();
      // PuTTY usa una stringa di 32 byte little-endian, non un mpint con segno.
      if (point.length !== 32 || seed.length !== 32) throw invalid();
      fields = [point, Buffer.concat([seed, point])];
      break;
    }
    default: {
      const curve = pub.read(), point = pub.read(), scalar = priv.read(true);
      const bits = Number(file.algorithm.slice(-3));
      if (curve.toString() !== 'nistp' + bits || point[0] !== 4 || point.length !== 1 + 2 * Math.ceil(bits / 8)) throw invalid();
      fields = [curve, point, scalar];
    }
  }
  if (pub.remaining || priv.remaining > (file.encryption === 'none' ? 0 : 15)) throw invalid();
  const check = crypto.randomBytes(4);
  const secret = Buffer.concat([check, check, string(file.algorithm), ...fields.map(string), string(file.comment)]);
  const padding = Buffer.from(Array.from({ length: (8 - secret.length % 8) % 8 }, (_, i) => i + 1));
  const binary = Buffer.concat([Buffer.from('openssh-key-v1\0'), string('none'), string('none'), string(''), uint32(1), string(file.publicKey), string(Buffer.concat([secret, padding]))]);
  const text = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + binary.toString('base64').match(/.{1,70}/g).join('\n') + '\n-----END OPENSSH PRIVATE KEY-----\n';
  secret.fill(0);
  binary.fill(0);
  const parsed = utils.parseKey(text);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error || !key?.getPrivatePEM() || !key.getPublicSSH().equals(file.publicKey)) throw invalid();
  // Anche un file non cifrato con MAC ricalcolato deve contenere una coppia coerente.
  const challenge = Buffer.from('CodeDB verifica coerenza chiave PPK');
  const signature = key.sign(challenge);
  if (signature instanceof Error || key.verify(challenge, signature) !== true) throw invalid();
  return text;
}

async function parsePpk(input, passphrase) {
  let password, derived, plain, macKey;
  try {
    const file = readFile(input);
    const encrypted = file.encryption !== 'none';
    if (encrypted && (passphrase === undefined || passphrase === null || passphrase === '')) {
      throw error('La chiave PuTTY PPK è protetta. Inserisci la passphrase della chiave.', 'SSH_KEY_PASSPHRASE_REQUIRED');
    }
    if (passphrase != null && typeof passphrase !== 'string') throw invalid();
    password = Buffer.from(encrypted ? passphrase : '');
    let cipherKey, iv;
    if (file.version === 2) {
      macKey = crypto.createHash('sha1').update('putty-private-key-file-mac-key').update(password).digest();
      if (encrypted) {
        derived = Buffer.concat([0, 1].map(n => crypto.createHash('sha1').update(uint32(n)).update(password).digest()));
        cipherKey = derived.subarray(0, 32);
        iv = Buffer.alloc(16);
      }
    } else if (encrypted) {
      derived = await derive(file.kdf, password);
      cipherKey = derived.subarray(0, 32);
      iv = derived.subarray(32, 48);
      macKey = derived.subarray(48);
    } else macKey = Buffer.alloc(0);
    if (encrypted) {
      const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
      decipher.setAutoPadding(false);
      plain = Buffer.concat([decipher.update(file.privateKey), decipher.final()]);
    } else plain = file.privateKey;
    const mac = crypto.createHmac(file.version === 2 ? 'sha1' : 'sha256', macKey);
    for (const value of [file.algorithm, file.encryption, file.comment, file.publicKey, plain]) mac.update(string(value));
    if (!crypto.timingSafeEqual(file.mac, mac.digest())) {
      if (encrypted) throw error('Passphrase della chiave PuTTY PPK errata oppure file alterato. Verifica la passphrase e seleziona il file originale.', 'SSH_KEY_PASSPHRASE_INVALID');
      throw invalid();
    }
    return openssh(file, plain);
  } catch (err) {
    if (String(err.code || '').startsWith('SSH_KEY_')) throw err;
    throw invalid();
  } finally {
    password?.fill(0);
    derived?.fill(0);
    macKey?.fill(0);
    plain?.fill(0);
  }
}

function deriveWasm(kdf, password) {
  return require('hash-wasm')[kdf.algorithm]({
    password, salt: kdf.salt, memorySize: kdf.memory, iterations: kdf.passes,
    parallelism: kdf.parallelism, hashLength: 80, outputType: 'binary',
  });
}

if (!isMainThread && workerData?.codedbPpkArgon2) {
  const { kdf, password } = workerData;
  deriveWasm(kdf, password).then(key => { parentPort.postMessage({ key }); key.fill(0); }, () => parentPort.postMessage({ error: true }))
    .finally(() => password.fill(0));
}

module.exports = { parsePpk };
