'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');
const { verificaFirma, publicText } = require('../db/SshAgent');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }
function str(data) { const b = Buffer.from(data); return Buffer.concat([u32(b.length), b]); }
function read(buffer) { let p = 0; return { str() { const n = buffer.readUInt32BE(p); p += 4; const b = buffer.subarray(p, p + n); p += n; return b; }, u32() { const n = buffer.readUInt32BE(p); p += 4; return n; }, rest() { return buffer.subarray(p); } }; }
function keyPair(type = 'ed25519', bits = 256) {
  for (let i = 0; i < 10; i++) {
    const pair = utils.generateKeyPairSync(type, type === 'rsa' ? { bits: 2048 } : type === 'ecdsa' ? { bits } : undefined);
    const parsed = utils.parseKey(pair.private);
    if (!(parsed instanceof Error)) return { ...pair, parsed, blob: parsed.getPublicSSH() };
  }
  throw new Error('Generazione chiave della fixture SSH fallita.');
}
function certificate(key, ca, { validAfter = 0, validBefore = 0xffffffffffffffffn, certificateType = 1 } = {}) {
  const r = read(key.blob), type = r.str().toString();
  const certType = type.replace(/@openssh.com$/, '') + '-cert-v01@openssh.com';
  const body = Buffer.concat([str(certType), str(crypto.randomBytes(32)), r.rest(), u64(1), u32(certificateType), str('fixture'),
    str(str('fixture')), u64(validAfter), u64(validBefore), str(''), str(Buffer.concat([str('permit-port-forwarding'), str('')])), str(''), str(ca.blob)]);
  return Buffer.concat([body, str(signature(ca, body, 4))]);
}
function securityKey(key) {
  const r = read(key.blob), type = r.str().toString();
  const app = Buffer.from('ssh:fixture');
  return { ...key, blob: Buffer.concat([str(`sk-${type}@openssh.com`), r.rest(), str(app)]), app };
}
function signature(key, data, flags) {
  if (key.app) {
    const flagsCounter = Buffer.concat([Buffer.from([1]), u32(4)]);
    const signed = Buffer.concat([crypto.createHash('sha256').update(key.app).digest(), flagsCounter, crypto.createHash('sha256').update(data).digest()]);
    const inner = read(signature({ ...key, app: null }, signed, flags)); inner.str();
    return Buffer.concat([str(`sk-${key.parsed.type}@openssh.com`), str(inner.str()), flagsCounter]);
  }
  const hash = key.parsed.type === 'ssh-rsa' ? flags === 2 ? 'sha256' : flags === 4 ? 'sha512' : 'sha1' : undefined;
  const algorithm = hash === 'sha256' ? 'rsa-sha2-256' : hash === 'sha512' ? 'rsa-sha2-512' : key.parsed.type;
  if (key.parsed.type.startsWith('ecdsa-')) {
    const size = ({ 'ecdsa-sha2-nistp256': 32, 'ecdsa-sha2-nistp384': 48, 'ecdsa-sha2-nistp521': 66 })[key.parsed.type];
    const raw = crypto.sign(({ 32: 'sha256', 48: 'sha384', 66: 'sha512' })[size], data, { key: key.parsed.getPrivatePEM(), dsaEncoding: 'ieee-p1363' });
    const integer = b => { while (b.length > 1 && b[0] === 0) b = b.subarray(1); return b[0] & 128 ? Buffer.concat([Buffer.from([0]), b]) : b; };
    return Buffer.concat([str(algorithm), str(Buffer.concat([str(integer(raw.subarray(0, size))), str(integer(raw.subarray(size)))]))]);
  }
  return Buffer.concat([str(algorithm), str(key.parsed.sign(data, hash))]);
}

function privateHandle(key, passphrase) {
  const r = read(key.blob), type = r.str(), publicFields = r.rest();
  let secret = Buffer.concat([u32(12345), u32(12345), str(type), publicFields, Buffer.from([1]), str(crypto.randomBytes(32)), str(''), str('fixture')]);
  const block = passphrase ? 16 : 8, padding = block - secret.length % block;
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  let cipher = 'none', kdf = 'none', kdfOptions = Buffer.alloc(0);
  if (passphrase) {
    const salt = crypto.randomBytes(16), derived = Buffer.alloc(48), password = Buffer.from(passphrase);
    require('bcrypt-pbkdf').pbkdf(password, password.length, salt, salt.length, derived, derived.length, 16);
    const encrypt = crypto.createCipheriv('aes-256-ctr', derived.subarray(0, 32), derived.subarray(32)); encrypt.setAutoPadding(false);
    secret = Buffer.concat([encrypt.update(secret), encrypt.final()]); derived.fill(0);
    cipher = 'aes256-ctr'; kdf = 'bcrypt'; kdfOptions = Buffer.concat([str(salt), u32(16)]);
  }
  const payload = Buffer.concat([Buffer.from('openssh-key-v1\0'), str(cipher), str(kdf), str(kdfOptions), u32(1), str(key.blob), str(secret)]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${payload.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function multipleKeys(keys) {
  const bodies = keys.map(key => {
    const payload = Buffer.from(key.private.split('\n').filter(line => !line.startsWith('---')).join(''), 'base64');
    const r = read(payload.subarray(15)); r.str(); r.str(); r.str(); r.u32(); r.str();
    const secret = r.str(); return secret.subarray(8, secret.length - secret.at(-1));
  });
  let secret = Buffer.concat([u32(123), u32(123), ...bodies]);
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: 8 - secret.length % 8 }, (_, i) => i + 1))]);
  const payload = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(keys.length), ...keys.map(key => str(key.blob)), str(secret)]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${payload.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
async function agentFixture(keys, { corruptSignature = false, oversized = false, idle = false } = {}) {
  const sockets = new Set(), stats = { requests: 0, signatures: 0, signedBlobs: [] };
  const agentPath = process.platform === 'win32' ? '\\\\.\\pipe\\codedb-test-agent-' + crypto.randomBytes(12).toString('hex') : path.join(os.tmpdir(), 'cdb-agent-' + crypto.randomBytes(12).toString('hex'));
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE() + 4) {
        const size = pending.readUInt32BE(), request = pending.subarray(4, size + 4); pending = pending.subarray(size + 4);
        stats.requests++;
        if (idle) continue;
        if (oversized) { socket.write(u32(16 * 1024 * 1024)); continue; }
        let reply = Buffer.from([5]);
        if (request[0] === 11) reply = Buffer.concat([Buffer.from([12]), u32(keys.length), ...keys.flatMap(k => [str(k.blob), str('fixture')])]);
        else if (request[0] === 13) {
          const r = read(request.subarray(1)), blob = r.str(), payload = r.str(), flags = r.u32();
          const key = keys.find(k => k.blob.equals(blob) || k.cert?.equals(blob));
          if (key) {
            stats.signatures++; stats.signedBlobs.push(blob);
            const sig = signature(key, payload, flags);
            if (corruptSignature) sig[sig.length - 1] ^= 0xff;
            reply = Buffer.concat([Buffer.from([14]), str(sig)]);
          }
        }
        socket.write(Buffer.concat([u32(reply.length), reply]));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(agentPath, resolve); });
  return { agentPath, stats, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

async function sshServerFixture(allowed) {
  const host = keyPair(), sockets = new Set(), clients = new Set(), stats = { authentications: 0, attempts: [], forwarded: 0 };
  const echo = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const server = new Server({ hostKeys: [host.private] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      stats.attempts.push(ctx.key.algo);
      const key = allowed.find(k => (k.cert || k.blob).equals(ctx.key.data));
      if (!key || ctx.username !== 'fixture') return ctx.reject(['publickey']);
      if (ctx.signature) {
        // ssh2 conserva il contenitore della firma per i tipi certificato/FIDO non nativi.
        const signatureBlob = ctx.key.algo.includes('-cert-') ? ctx.signature : ctx.key.algo.startsWith('sk-')
          ? Buffer.concat([str(ctx.key.algo), str(ctx.signature.subarray(0, -5)), ctx.signature.subarray(-5)])
          : Buffer.concat([str(ctx.key.algo), str(ctx.signature)]);
        const valid = ctx.key.algo.includes('-cert-') || ctx.key.algo.startsWith('sk-')
          ? verificaFirma(key.blob, ctx.blob, signatureBlob) : key.parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true;
        if (!valid) return ctx.reject(['publickey']);
        stats.authentications++;
      }
      ctx.accept();
    });
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== echo.address().port) return reject();
      const upstream = net.connect(echo.address().port, '127.0.0.1'); sockets.add(upstream);
      let channel;
      upstream.on('connect', () => { channel = accept(); stats.forwarded++; channel.on('error', () => upstream.destroy()); channel.on('close', () => upstream.destroy()); channel.pipe(upstream).pipe(channel); });
      upstream.on('error', () => channel ? channel.destroy() : reject());
      upstream.on('close', () => { sockets.delete(upstream); channel?.destroy(); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { stats, hostKey: host.blob, host: '127.0.0.1', port: server.address().port, username: 'fixture', target: { host: '127.0.0.1', port: echo.address().port },
    disconnect() { for (const client of clients) client.end(); },
    async close() { for (const socket of sockets) socket.destroy(); for (const client of clients) client.end(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => echo.close(resolve))]); } };
}

module.exports = { keyPair, certificate, securityKey, privateHandle, multipleKeys, agentFixture, sshServerFixture, publicText, str, u32, read };
