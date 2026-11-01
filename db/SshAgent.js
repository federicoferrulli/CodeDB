'use strict';

const crypto = require('node:crypto');
const { BaseAgent, createAgent, utils } = require('ssh2');

const MAX_PACKET = 1024 * 1024;
const CERT_SUFFIX = '-cert-v01@openssh.com';
const TYPES = new Set(['ssh-rsa', 'ssh-dss', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']);

function uint32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function string(value) { const b = Buffer.from(value); return Buffer.concat([uint32(b.length), b]); }
function reader(buffer) {
  let p = 0;
  return {
    get position() { return p; },
    raw(n) { if (!Number.isSafeInteger(n) || n < 0 || p + n > buffer.length) throw new Error('File chiave SSH troncato o non valido.'); const b = buffer.subarray(p, p + n); p += n; return b; },
    u32() { return this.raw(4).readUInt32BE(); },
    u64() { return this.raw(8).readBigUInt64BE(); },
    str() { return this.raw(this.u32()); },
    end() { if (p !== buffer.length) throw new Error('Dati aggiuntivi non validi nel file chiave SSH.'); },
  };
}
function baseType(type) {
  if (!type.endsWith(CERT_SUFFIX)) return type;
  const base = type.slice(0, -CERT_SUFFIX.length);
  return base.startsWith('sk-') ? base + '@openssh.com' : base;
}
function fingerprint(blob) { return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''); }
function publicText(blob) { const r = reader(blob); return Buffer.from(`${r.str().toString()} ${blob.toString('base64')}\n`); }
function decode64(text) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('Codifica Base64 della chiave SSH non valida.');
  const b = Buffer.from(text, 'base64');
  if (b.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) throw new Error('Codifica Base64 della chiave SSH non valida.');
  return b;
}

function leggiBlob(blob, { now = Date.now(), checkCertificate = true } = {}) {
  const r = reader(blob), type = r.str().toString(), base = baseType(type);
  if (!TYPES.has(base)) throw new Error(`Algoritmo della chiave SSH non riconosciuto: ${type}.`);
  const certificate = type.endsWith(CERT_SUFFIX), securityKey = base.startsWith('sk-');
  if (certificate) r.str();
  const fields = [];
  if (base === 'ssh-rsa') fields.push(r.str(), r.str());
  else if (base === 'ssh-dss') fields.push(r.str(), r.str(), r.str(), r.str());
  else if (base.includes('ecdsa')) {
    const curve = r.str(), point = r.str(), expected = base.match(/nistp\d+/)[0];
    if (curve.toString() !== expected || point.length !== ({ nistp256: 65, nistp384: 97, nistp521: 133 })[expected] || point[0] !== 4) throw new Error('Punto o curva ECDSA della chiave SSH non validi.');
    fields.push(curve, point);
  } else {
    const key = r.str();
    if (key.length !== 32) throw new Error('Chiave pubblica Ed25519 non valida.');
    fields.push(key);
  }
  let application;
  if (securityKey) { application = r.str(); if (!application.length) throw new Error('Applicazione della chiave FIDO SSH vuota.'); fields.push(application); }
  const plainPublicKey = Buffer.concat([string(base), ...fields.map(string)]);
  const ordinaryType = base.replace(/^sk-/, '').replace(/@openssh\.com$/, '');
  const ordinaryBlob = Buffer.concat([string(ordinaryType), ...fields.slice(0, securityKey ? -1 : undefined).map(string)]);
  const parsed = utils.parseKey(ordinaryBlob);
  if (parsed instanceof Error) throw new Error('Chiave pubblica SSH non valida.');
  const result = { type, baseType: base, publicKey: Buffer.from(blob), plainPublicKey, certificate, securityKey,
    fingerprint: fingerprint(plainPublicKey), parsed, application };
  if (certificate) {
    r.u64();
    if (r.u32() !== 1) throw new Error('Il file contiene un certificato host SSH: per accedere serve un certificato utente.');
    const keyId = r.str().toString(), principals = [], principalBytes = r.str(), principalReader = reader(principalBytes);
    while (principalReader.position < principalBytes.length) principals.push(principalReader.str().toString());
    principalReader.end();
    const validAfter = r.u64(), validBefore = r.u64();
    for (let i = 0; i < 2; i++) {
      const options = r.str(), optionReader = reader(options);
      while (optionReader.position < options.length) { optionReader.str(); optionReader.str(); }
      optionReader.end();
    }
    r.str();
    const ca = r.str(), signed = blob.subarray(0, r.position), signature = r.str();
    r.end();
    if (checkCertificate) {
      const timestamp = BigInt(Math.floor(now / 1000));
      if (timestamp < validAfter || timestamp >= validBefore) throw new Error('Il certificato SSH è scaduto o non è ancora valido.');
      if (!verificaFirma(ca, signed, signature)) throw new Error('La firma del certificato SSH non è valida.');
    }
    Object.assign(result, { keyId, principals, validAfter: String(validAfter), validBefore: String(validBefore) });
  } else r.end();
  return result;
}

function verificaFirma(publicKey, data, signature) {
  try {
    const info = leggiBlob(publicKey, { checkCertificate: false });
    if (info.certificate) return false;
    const r = reader(signature), algorithm = r.str().toString();
    let raw = r.str(), signed = data;
    let expected = info.baseType, hash;
    if (expected === 'ssh-rsa') {
      hash = { 'ssh-rsa': 'sha1', 'rsa-sha2-256': 'sha256', 'rsa-sha2-512': 'sha512' }[algorithm];
      if (!hash) return false;
    } else if (algorithm !== expected) return false;
    if (info.securityKey) {
      const flagsCounter = r.raw(5);
      signed = Buffer.concat([crypto.createHash('sha256').update(info.application).digest(), flagsCounter,
        crypto.createHash('sha256').update(data).digest()]);
      expected = expected.replace(/^sk-/, '').replace(/@openssh\.com$/, '');
    }
    r.end();
    if (expected.includes('ecdsa')) {
      const size = ({ 'ecdsa-sha2-nistp256': 32, 'ecdsa-sha2-nistp384': 48, 'ecdsa-sha2-nistp521': 66 })[expected];
      hash = ({ 32: 'sha256', 48: 'sha384', 66: 'sha512' })[size];
      const rs = reader(raw), parts = [rs.str(), rs.str()]; rs.end();
      raw = Buffer.concat(parts.map(part => {
        if (part.length === size + 1 && part[0] === 0) part = part.subarray(1);
        if (part.length > size) throw new Error('Firma ECDSA non valida.');
        return Buffer.concat([Buffer.alloc(size - part.length), part]);
      }));
      return crypto.verify(hash, signed, { key: info.parsed.getPublicPEM(), dsaEncoding: 'ieee-p1363' }, raw);
    }
    if (expected === 'ssh-dss') return crypto.verify('sha1', signed, { key: info.parsed.getPublicPEM(), dsaEncoding: 'ieee-p1363' }, raw);
    return info.parsed.verify(signed, raw, hash) === true;
  } catch { return false; }
}

function identificaChiaveAgente(input) {
  const original = Buffer.isBuffer(input) ? input : Buffer.from(input), text = original.toString('utf8').trim();
  let blob, privateHandle = false, encrypted = false;
  if (text.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    const match = /^-----BEGIN OPENSSH PRIVATE KEY-----\s+([\s\S]+?)\s+-----END OPENSSH PRIVATE KEY-----$/.exec(text);
    if (!match) return null;
    const payload = decode64(match[1].replace(/\s/g, '')), r = reader(payload);
    if (r.raw(15).toString() !== 'openssh-key-v1\0') throw new Error('Intestazione OpenSSH non valida.');
    const cipher = r.str().toString(); r.str(); r.str();
    encrypted = cipher !== 'none';
    // ssh2 sa leggere anche i contenitori ordinari con più chiavi: conserva quel percorso.
    if (r.u32() !== 1) return null;
    blob = r.str();
    const pub = reader(blob).str().toString();
    if (!pub.startsWith('sk-')) return null;
    r.str();
    if (cipher === 'aes128-gcm@openssh.com' || cipher === 'aes256-gcm@openssh.com' || cipher === 'chacha20-poly1305@openssh.com') r.raw(16);
    r.end();
    privateHandle = true;
  } else if (/^(?:ssh-|ecdsa-|sk-)/.test(text)) {
    const match = /^(\S+)[ \t]+([A-Za-z0-9+/=]+)(?:[ \t]+[^\r\n]*)?$/.exec(text);
    if (!match) throw new Error('Il file deve contenere una sola chiave pubblica o un solo certificato SSH.');
    blob = decode64(match[2]);
    if (reader(blob).str().toString() !== match[1]) throw new Error('L’algoritmo indicato non corrisponde al contenuto della chiave SSH.');
  } else if (text.startsWith('---- BEGIN SSH2 PUBLIC KEY ----')) {
    const lines = text.split(/\r\n|\r|\n/), chunks = [];
    if (lines[0] !== '---- BEGIN SSH2 PUBLIC KEY ----' || lines.at(-1) !== '---- END SSH2 PUBLIC KEY ----') throw new Error('Intestazione della chiave pubblica SSH2 non valida.');
    let headers = true;
    for (let i = 1; i < lines.length - 1; i++) {
      let line = lines[i].trim();
      if (headers && /^[A-Za-z][A-Za-z0-9-]{0,63}:/.test(line)) {
        // RFC 4716: una barra inversa finale continua il valore dell'intestazione.
        while (line.endsWith('\\')) {
          if (++i >= lines.length - 1) throw new Error('Intestazione SSH2 incompleta.');
          line = lines[i].trim();
        }
        continue;
      }
      if (!line) continue;
      headers = false;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) throw new Error('Codifica della chiave pubblica SSH2 non valida.');
      chunks.push(line);
    }
    blob = decode64(chunks.join(''));
  } else if (Buffer.isBuffer(input) && input.length >= 4 && input.readUInt32BE(0) < 128) {
    blob = input;
  } else return null;
  return { ...leggiBlob(blob), privateHandle, encrypted, native: privateHandle || reader(blob).str().toString().startsWith('sk-') || reader(blob).str().toString().endsWith(CERT_SUFFIX),
    identity: privateHandle ? original : publicText(blob) };
}

function richiestaAgente(source, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stream, done = false, chunks = Buffer.alloc(0);
    const finish = (err, value) => {
      if (done) return; done = true; clearTimeout(timer); stream?.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('L’agente SSH non risponde entro il tempo previsto.')), timeoutMs);
    source.getStream((err, connected) => {
      if (done) { connected?.destroy(); return; }
      if (err) return finish(err);
      stream = connected;
      stream.on('error', finish);
      stream.on('close', () => finish(new Error('L’agente SSH ha chiuso la connessione.')));
      stream.on('end', () => finish(new Error('Risposta incompleta dell’agente SSH.')));
      stream.on('data', chunk => {
        if (chunks.length + chunk.length > MAX_PACKET + 4) return finish(new Error('Risposta dell’agente SSH troppo grande.'));
        chunks = Buffer.concat([chunks, chunk]);
        if (chunks.length < 4) return;
        const size = chunks.readUInt32BE();
        if (size < 1 || size > MAX_PACKET) return finish(new Error('Lunghezza della risposta dell’agente SSH non valida.'));
        if (chunks.length === size + 4) finish(null, chunks.subarray(4));
        else if (chunks.length > size + 4) finish(new Error('Risposta aggiuntiva inattesa dall’agente SSH.'));
      });
      stream.write(Buffer.concat([uint32(payload.length), payload]));
    });
  });
}

async function identitaAgente(source, timeoutMs) {
  const payload = await richiestaAgente(source, Buffer.from([11]), timeoutMs), r = reader(payload);
  if (r.raw(1)[0] !== 12) throw new Error('L’agente SSH non consente di leggere le identità.');
  const count = r.u32();
  if (count > 1024) throw new Error('L’agente SSH espone troppe identità.');
  const keys = [];
  for (let i = 0; i < count; i++) { keys.push(r.str()); r.str(); }
  r.end();
  return keys;
}

class AgenteSelezionato extends BaseAgent {
  constructor(source, info, timeoutMs) { super(); this.source = source; this.info = info; this.timeoutMs = timeoutMs; }
  getIdentities(callback) { callback(null, [this.info.parsed]); }
  sign(key, data, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const supplied = utils.parseKey(key);
    if (supplied instanceof Error || !supplied.getPublicSSH().equals(this.info.publicKey)) return callback(new Error('L’agente può firmare soltanto con la chiave selezionata.'));
    const flags = this.info.type === 'ssh-rsa' ? ({ sha256: 2, sha512: 4 })[options?.hash] || 0 : 0;
    const payload = Buffer.concat([Buffer.from([13]), string(this.info.publicKey), string(data), uint32(flags)]);
    richiestaAgente(this.source, payload, this.timeoutMs).then(response => {
      const r = reader(response);
      if (r.raw(1)[0] !== 14) throw new Error('Firma rifiutata dall’agente SSH: sblocca la chiave e riprova.');
      const signature = r.str(); r.end();
      if (!verificaFirma(this.info.publicKey, data, signature)) throw new Error('L’agente SSH ha restituito una firma non valida.');
      const sr = reader(signature); sr.str(); const raw = sr.str(); sr.end();
      // ssh2 accetta direttamente le firme SSH ECDSA (con prefisso mpint).
      return raw;
    }).then(signature => callback(null, signature), callback);
  }
}

async function preparaAgente(input, options = {}) {
  const info = identificaChiaveAgente(input);
  if (!info) throw new Error('Il file non contiene una chiave pubblica, un certificato o un riferimento FIDO SSH.');
  if (info.privateHandle) {
    if (info.encrypted && !options.passphrase) throw Object.assign(new Error('Inserisci la passphrase della chiave FIDO SSH.'), { code: 'SSH_KEY_PASSPHRASE_REQUIRED' });
    await require('./SshNativeTunnel').validaIdentitaNativa(info.identity, options.passphrase);
    return { ...info, passphrase: options.passphrase, securityKeyPin: options.securityKeyPin };
  }
  const env = options.env || process.env, platform = options.platform || process.platform;
  const paths = options.agentPath ? [options.agentPath] : [...new Set([env.SSH_AUTH_SOCK, ...(platform === 'win32' ? ['\\\\.\\pipe\\openssh-ssh-agent', 'pageant'] : [])].filter(Boolean))];
  let reached = false;
  for (const agentPath of paths) {
    const source = createAgent(agentPath);
    let keys;
    try { keys = await identitaAgente(source, options.timeoutMs || 5000); reached = true; } catch { continue; }
    const matching = keys.find(key => key.equals(info.publicKey) || (info.certificate && key.equals(info.plainPublicKey)));
    if (!matching) continue;
    if (info.native) return { ...info, identity: publicText(info.publicKey), certificate: info.certificate ? publicText(info.publicKey) : undefined, agentPath, agentSource: source, agentKey: matching };
    return { ...info, agent: new AgenteSelezionato(source, info, options.timeoutMs || 15000), agentPath };
  }
  throw new Error(reached
    ? 'La chiave pubblica selezionata non è presente nell’agente SSH di CodeDB. Carica la chiave privata corrispondente nell’agente (ssh-add o Pageant), quindi riprova.'
    : 'Il file contiene una chiave pubblica o un certificato: per firmare serve la chiave privata nell’agente SSH della macchina che esegue CodeDB. Avvia OpenSSH Agent o Pageant, carica la chiave e riprova.');
}

module.exports = { identificaChiaveAgente, preparaAgente, verificaFirma, richiestaAgente, publicText };
