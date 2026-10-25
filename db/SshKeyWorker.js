'use strict';

const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { utils } = require('ssh2');
const forge = require('node-forge');

function errore(message, code = 'SSH_KEY_INVALID') { return Object.assign(new Error(message), { code }); }
const stringa = value => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
};
const intero = value => {
  let data = Buffer.from(value, 'base64url');
  while (data.length > 1 && data[0] === 0) data = data.subarray(1);
  if (data[0] & 128) data = Buffer.concat([Buffer.from([0]), data]);
  return stringa(data);
};
const pem = (type, data) => `-----BEGIN ${type}-----\n${data.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${type}-----\n`;

function limiteKdf() {
  throw errore('La chiave richiede troppa memoria o troppi calcoli. Riesportala con parametri di protezione standard.', 'SSH_KEY_RESOURCE_LIMIT');
}

function numeroKdf(node, max) {
  if (node?.type !== 2 || typeof node.value !== 'string' || !node.value.length || node.value.length > 7 || node.value.charCodeAt(0) & 128) return limiteKdf();
  const n = BigInt('0x' + Buffer.from(node.value, 'binary').toString('hex'));
  if (n < 1n || n > BigInt(max)) return limiteKdf();
  return Number(n);
}

function limitaKdf(asn) {
  const algorithm = asn.value?.[0];
  if (algorithm?.type !== 16 || asn.value?.[1]?.type !== 4) return;
  const oid = forge.asn1.derToOid(algorithm.value[0].value), params = algorithm.value[1];
  if (oid === '1.2.840.113549.1.5.13') {
    const kdf = params.value?.[0], kind = forge.asn1.derToOid(kdf.value[0].value), values = kdf.value[1].value;
    if (values[0]?.type !== 4 || values[0].value.length > 1024) return limiteKdf();
    if (kind === '1.2.840.113549.1.5.12') {
      numeroKdf(values[1], 10000000);
      if (values[2]?.type === 2) numeroKdf(values[2], 64);
    } else if (kind === '1.3.6.1.4.1.11591.4.11') {
      const n = numeroKdf(values[1], 1048576), r = numeroKdf(values[2], 32), p = numeroKdf(values[3], 16);
      if ((n & (n - 1)) || n * r > 2097152 || n * r * p > 8388608) return limiteKdf();
      if (values[4]) numeroKdf(values[4], 64);
    } else throw errore('La derivazione della passphrase di questa chiave non è supportata.', 'SSH_KEY_UNSUPPORTED');
  } else if (/^1\.2\.840\.113549\.1\.(?:5|12\.1)\./.test(oid)) {
    if (params?.value?.[0]?.type !== 4 || params.value[0].value.length > 1024) return limiteKdf();
    numeroKdf(params?.value?.[1], 10000000);
  } else throw errore('La cifratura della chiave PKCS#8 non è supportata.', 'SSH_KEY_UNSUPPORTED');
}

function pubblica(key) {
  const pub = key.type === 'public' ? key : crypto.createPublicKey(key);
  if (pub.asymmetricKeyType === 'dsa') {
    const asn = forge.asn1.fromDer(pub.export({ format: 'der', type: 'spki' }).toString('binary'), { decodeBitStrings: false });
    const params = asn.value[0].value[1].value;
    const y = forge.asn1.fromDer(asn.value[1].value.slice(1));
    return Buffer.concat([stringa('ssh-dss'), ...[...params, y].map(n => stringa(Buffer.from(n.value, 'binary')))]);
  }
  const jwk = pub.export({ format: 'jwk' });
  if (jwk.kty === 'RSA') return Buffer.concat([stringa('ssh-rsa'), intero(jwk.e), intero(jwk.n)]);
  if (jwk.crv === 'Ed25519') return Buffer.concat([stringa('ssh-ed25519'), stringa(Buffer.from(jwk.x, 'base64url'))]);
  const curve = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[jwk.crv];
  if (curve) return Buffer.concat([stringa(`ecdsa-sha2-${curve}`), stringa(curve),
    stringa(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]))]);
  throw errore('Questo algoritmo non è utilizzabile per l’autenticazione SSH. Usa RSA, Ed25519, ECDSA NIST o DSA.', 'SSH_KEY_UNSUPPORTED');
}

function privata(key) {
  if (key.asymmetricKeyType === 'rsa') return key.export({ format: 'pem', type: 'pkcs1' });
  if (key.asymmetricKeyType === 'ec') return key.export({ format: 'pem', type: 'sec1' });
  if (key.asymmetricKeyType === 'dsa') {
    const asn = forge.asn1.fromDer(key.export({ format: 'der', type: 'pkcs8' }).toString('binary'));
    const params = asn.value[1].value[1].value;
    const pub = forge.asn1.fromDer(crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('binary'), { decodeBitStrings: false });
    const y = forge.asn1.fromDer(pub.value[1].value.slice(1));
    const x = forge.asn1.fromDer(asn.value[2].value);
    const seq = forge.asn1.create(0, 16, true, [forge.asn1.create(0, 2, false, '\x00'), ...params, y, x]);
    return pem('DSA PRIVATE KEY', Buffer.from(forge.asn1.toDer(seq).getBytes(), 'binary'));
  }
  if (key.asymmetricKeyType === 'ed25519') {
    const jwk = key.export({ format: 'jwk' });
    const pub = Buffer.from(jwk.x, 'base64url');
    const check = crypto.randomBytes(4);
    let body = Buffer.concat([check, check, stringa('ssh-ed25519'), stringa(pub),
      stringa(Buffer.concat([Buffer.from(jwk.d, 'base64url'), pub])), stringa('')]);
    const padding = 8 - body.length % 8;
    body = Buffer.concat([body, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
    return pem('OPENSSH PRIVATE KEY', Buffer.concat([Buffer.from('openssh-key-v1\0'), stringa('none'), stringa('none'),
      stringa(''), Buffer.from([0, 0, 0, 1]), stringa(pubblica(key)), stringa(body)]));
  }
  throw errore('Questo algoritmo non è utilizzabile per l’autenticazione SSH. Usa RSA, Ed25519, ECDSA NIST o DSA.', 'SSH_KEY_UNSUPPORTED');
}

function pfx(data, passphrase) {
  let container;
  const asn = forge.asn1.fromDer(data.toString('binary'));
  const mac = asn.value?.[2];
  if (mac) {
    if (mac.value?.[1]?.type !== 4 || mac.value[1].value.length > 1024) limiteKdf();
    if (mac.value?.[2]) numeroKdf(mac.value[2], 10000000);
  }
  const original = forge.pki.pbe.getCipherForPBES2;
  const originalCipher = forge.pki.pbe.getCipher;
  try {
    // I SafeBag possono essere dentro SafeContents cifrati: controlla ogni KDF
    // quando emerge, prima che forge o OpenSSL comincino la derivazione.
    forge.pki.pbe.getCipher = (oid, params, password) => {
      limitaKdf({ value: [{ type: 16, value: [{ type: 6, value: forge.asn1.oidToDer(oid).getBytes() }, params] }, { type: 4 }] });
      return originalCipher(oid, params, password);
    };
    // PBES2 usa UTF-8, mentre il MAC PKCS#12 usa UTF-16. Non ricodificare la passphrase globale.
    forge.pki.pbe.getCipherForPBES2 = (oid, params, password) => original(oid, params, forge.util.encodeUtf8(password));
    try { container = forge.pkcs12.pkcs12FromAsn1(asn, true, passphrase || ''); }
    catch (err) {
      if (err.code?.startsWith('SSH_KEY_')) throw err;
      if (!/[^\x00-\x7f]/.test(passphrase || '')) throw err;
      // Alcuni vecchi esportatori JS hanno usato Latin-1: manteniamo anche quella lettura.
      forge.pki.pbe.getCipherForPBES2 = original;
      container = forge.pkcs12.pkcs12FromAsn1(asn, true, passphrase || '');
    }
  } catch (err) {
    if (err.code?.startsWith('SSH_KEY_')) throw err;
    throw errore(passphrase ? 'Impossibile aprire il contenitore PKCS#12. Verifica la passphrase e l’integrità del file.'
      : 'Inserisci la passphrase del contenitore PKCS#12.', passphrase ? 'SSH_KEY_PASSPHRASE_INVALID' : 'SSH_KEY_PASSPHRASE_REQUIRED');
  } finally { forge.pki.pbe.getCipherForPBES2 = original; forge.pki.pbe.getCipher = originalCipher; }
  const all = container.safeContents.flatMap(safe => safe.safeBags);
  const bags = all
    .filter(bag => [forge.pki.oids.keyBag, forge.pki.oids.pkcs8ShroudedKeyBag].includes(bag.type));
  if (!bags.length) {
    const certificates = all.filter(bag => bag.type === forge.pki.oids.certBag).map(bag => new crypto.X509Certificate(Buffer.from(
      forge.asn1.toDer(bag.cert ? forge.pki.certificateToAsn1(bag.cert) : bag.asn1).getBytes(), 'binary')));
    const candidates = certificates.length === 1 ? certificates : certificates.filter(cert => !cert.ca);
    const unique = new Map(candidates.map(cert => { const pub = pubblica(cert.publicKey); return [pub.toString('base64'), pub]; }));
    if (unique.size === 1) return { publicKey: unique.values().next().value.toString('base64'), format: 'PKCS#12 (certificato)' };
    throw errore(unique.size ? 'Il contenitore contiene più identità pubbliche. Esporta il certificato da usare per SSH.' : 'Il contenitore PKCS#12 non contiene una chiave o un certificato utilizzabile per SSH.');
  }
  if (bags.length > 1) throw errore('Il contenitore contiene più chiavi private. Esporta quella da usare per SSH.');
  const bag = bags[0];
  return bag.key ? crypto.createPrivateKey(forge.pki.privateKeyToPem(bag.key))
    : crypto.createPrivateKey({ key: Buffer.from(forge.asn1.toDer(bag.asn1).getBytes(), 'binary'), format: 'der', type: 'pkcs8' });
}

async function normalizza(data, passphrase) {
  const text = data.toString('utf8').replace(/^\uFEFF/, '').trim();
  let key, format, encrypted = false;
  if (/^PuTTY-User-Key-File-[23]:/.test(text)) {
    key = await require('./SshPpk').parsePpk(data, passphrase);
    format = text.startsWith('PuTTY-User-Key-File-3:') ? 'PuTTY PPK v3' : 'PuTTY PPK v2';
    encrypted = /(?:\r\n|\r|\n)Encryption: (?!none)/.test(text);
  } else if (/^-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
    const asn = forge.asn1.fromDer(forge.pem.decode(text)[0].body);
    // OpenSSL accetta una struttura cifrata anche sotto l'etichetta PRIVATE KEY.
    encrypted = text.includes('BEGIN ENCRYPTED PRIVATE KEY') || (asn.value?.[0]?.type === 16 && asn.value?.[1]?.type === 4);
    if (encrypted && !passphrase) throw errore('Inserisci la passphrase della chiave privata.', 'SSH_KEY_PASSPHRASE_REQUIRED');
    limitaKdf(asn);
    try { key = privata(crypto.createPrivateKey({ key: text, passphrase: passphrase || undefined })); }
    catch (err) { if (err.code?.startsWith('SSH_KEY_')) throw err; throw errore('Impossibile aprire la chiave PKCS#8. Verifica la passphrase e l’integrità del file.', encrypted ? 'SSH_KEY_PASSPHRASE_INVALID' : 'SSH_KEY_INVALID'); }
    format = 'PEM PKCS#8';
  } else if (/^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(text) || /^-----BEGIN CERTIFICATE-----/.test(text)) {
    const cert = text.includes('BEGIN CERTIFICATE');
    const pub = pubblica(cert ? new crypto.X509Certificate(text).publicKey : crypto.createPublicKey(text));
    return { publicKey: pub.toString('base64'), format: cert ? 'Certificato X.509' : 'Chiave pubblica PEM' };
  } else if (data[0] === 0x30) {
    // PKCS#12 ha ContentInfo come secondo elemento; una chiave DER contiene interi o AlgorithmIdentifier.
    let asn;
    try { asn = forge.asn1.fromDer(data.toString('binary')); } catch { throw errore('Il file binario ASN.1 è incompleto o non valido.'); }
    limitaKdf(asn);
    const contentOid = asn.value?.[1]?.value?.[0];
    const isPfx = asn.value?.[0]?.type === 2 && contentOid?.type === 6
      && forge.asn1.derToOid(contentOid.value) === forge.pki.oids.data;
    if (isPfx) {
      const loaded = pfx(data, passphrase);
      if (loaded.publicKey) return loaded;
      key = privata(loaded); format = 'PKCS#12 (PFX/P12)'; encrypted = true;
    }
    else {
      let parsed;
      for (const type of ['pkcs8', 'pkcs1', 'sec1']) {
        try { parsed = crypto.createPrivateKey({ key: data, format: 'der', type, passphrase: passphrase || undefined }); break; } catch { /* Prova la prossima struttura DER. */ }
      }
      if (!parsed) {
        for (const type of ['spki', 'pkcs1']) {
          try { const pub = pubblica(crypto.createPublicKey({ key: data, format: 'der', type }));
            return { publicKey: pub.toString('base64'), format: 'Chiave pubblica DER' }; } catch { /* Prova la prossima struttura pubblica. */ }
        }
        if (asn.value?.length === 6 && asn.value.every(item => item.type === 2)) {
          const dsa = utils.parseKey(pem('DSA PRIVATE KEY', data));
          if (!(dsa instanceof Error)) parsed = crypto.createPrivateKey(dsa.getPrivatePEM());
        }
      }
      if (!parsed) {
        try { const pub = pubblica(new crypto.X509Certificate(data).publicKey);
          return { publicKey: pub.toString('base64'), format: 'Certificato X.509 DER' }; } catch { /* Non è un certificato. */ }
        const protetta = asn.value?.[0]?.type === 16 && asn.value?.[1]?.type === 4;
        throw errore(protetta ? 'Impossibile aprire la chiave DER. Inserisci o verifica la passphrase.' : 'Il file DER non contiene una chiave SSH valida.',
          protetta ? (passphrase ? 'SSH_KEY_PASSPHRASE_INVALID' : 'SSH_KEY_PASSPHRASE_REQUIRED') : 'SSH_KEY_INVALID');
      }
      key = privata(parsed); format = 'DER';
      encrypted = asn.value?.[0]?.type === 16 && asn.value?.[1]?.type === 4;
    }
  } else {
    key = text;
    format = text.includes('BEGIN OPENSSH PRIVATE KEY') ? 'OpenSSH' : 'PEM';
    encrypted = /ENCRYPTED/.test(text);
    if (format === 'OpenSSH') {
      const raw = Buffer.from(text.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''), 'base64');
      if (raw.length >= 19) {
        const size = raw.readUInt32BE(15);
        encrypted = size <= raw.length - 19 && raw.subarray(19, 19 + size).toString() !== 'none';
      }
    }
  }
  const result = utils.parseKey(key, format === 'OpenSSH' || format === 'PEM' ? passphrase || undefined : undefined);
  if (result instanceof Error) {
    if (/no passphrase/.test(result.message)) throw errore('Inserisci la passphrase della chiave privata.', 'SSH_KEY_PASSPHRASE_REQUIRED');
    throw errore(passphrase ? 'Impossibile aprire la chiave SSH. Verifica la passphrase e l’integrità del file.'
      : 'Il file non contiene una chiave SSH riconosciuta. Scegli OpenSSH, PEM, PPK, DER o PKCS#12.', passphrase ? 'SSH_KEY_PASSPHRASE_INVALID' : 'SSH_KEY_INVALID');
  }
  const parsed = Array.isArray(result) ? result[0] : result;
  if (!parsed.getPrivatePEM()) return { publicKey: parsed.getPublicSSH().toString('base64'), format: 'Chiave pubblica SSH' };
  // Riemette il materiale già decifrato: ssh2 non ripete bcrypt/Argon2 sul thread del server.
  let privateKey = parsed.getPrivatePEM();
  if (parsed.type === 'ssh-ed25519') privateKey = privata(crypto.createPrivateKey(privateKey));
  return { privateKey, format, algorithm: parsed.type, encrypted,
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '') };
}

if (parentPort) {
  normalizza(Buffer.from(workerData.data), workerData.passphrase).then(value => parentPort.postMessage({ value }), err => {
    parentPort.postMessage({ error: err.code?.startsWith('SSH_KEY_') ? err.message : 'Il file della chiave SSH è danneggiato o non riconosciuto.', code: err.code?.startsWith('SSH_KEY_') ? err.code : 'SSH_KEY_INVALID' });
  });
}

module.exports = { normalizza, privata, pubblica };
