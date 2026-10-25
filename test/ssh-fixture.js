'use strict';

const net = require('net');
const crypto = require('crypto');
const { Server, utils } = require('ssh2');
const { hostKeyFingerprint } = require('../db/SshTunnel');

// Chiavi usa-e-getta e solo traffico loopback: nessuna credenziale dell'utente.
async function sshFixture({ additionalKeys = [] } = {}) {
  // ssh2 1.17 tronca gli zeri iniziali della chiave pubblica Ed25519 generata.
  // Si rigenera solo la fixture malformata, senza cambiare la validazione dell'app.
  const generaEd25519 = () => {
    for (let i = 0; i < 8; i++) {
      const candidate = utils.generateKeyPairSync('ed25519');
      if (!(utils.parseKey(candidate.private) instanceof Error)) return candidate;
    }
    throw new Error('Il generatore SSH non ha prodotto una fixture Ed25519 valida.');
  };
  const host = generaEd25519();
  const key = generaEd25519();
  const encrypted = utils.generateKeyPairSync('rsa', { bits: 2048, passphrase: 'passphrase-fixture', cipher: 'aes256-cbc' });
  const pem = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const allowed = [key, encrypted].map(value => utils.parseKey(value.public));
  allowed.push(utils.parseKey(crypto.createPrivateKey(pem.privateKey).export({ format: 'pem', type: 'sec1' })));
  allowed.push(...additionalKeys);
  const clients = new Set(), sockets = new Set();
  const stats = { authenticationRequests: 0, authentications: 0, forwarded: 0 };
  const echo = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const server = new Server({ hostKeys: [host.private] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      stats.authenticationRequests++;
      if (ctx.method !== 'publickey' || ctx.username !== 'fixture') return ctx.reject();
      const match = allowed.find(k => k.getPublicSSH().equals(ctx.key.data));
      if (!match || (ctx.signature && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)) return ctx.reject();
      if (ctx.signature) stats.authentications++;
      ctx.accept();
    });
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== echo.address().port) return reject();
      const upstream = net.connect(echo.address().port, '127.0.0.1');
      sockets.add(upstream);
      let channel;
      upstream.on('connect', () => {
        stats.forwarded++;
        channel = accept();
        channel.on('error', () => upstream.destroy());
        channel.on('close', () => upstream.destroy());
        channel.pipe(upstream).pipe(channel);
      });
      upstream.on('error', () => channel ? channel.destroy() : reject());
      upstream.on('close', () => { sockets.delete(upstream); channel?.destroy(); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    key, encrypted, pem, stats,
    ssh: { ssh: 'true', sshHost: '127.0.0.1', sshPort: String(server.address().port), sshUser: 'fixture',
      sshHostKey: hostKeyFingerprint(utils.parseKey(host.private).getPublicSSH()) },
    target: { host: '127.0.0.1', port: echo.address().port },
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const client of clients) client.end();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => echo.close(resolve))]);
    },
  };
}

function roundTrip({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(3000, () => socket.destroy(new Error('Timeout del tunnel di prova')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write('codedb-tunnel-fixture'));
    socket.on('data', data => { socket.destroy(); resolve(data.toString()); });
  });
}

module.exports = { sshFixture, roundTrip };
