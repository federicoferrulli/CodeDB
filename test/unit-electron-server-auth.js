'use strict';

const assert = require('assert');
const http = require('http');
const {
  nuovoSegretoIstanza, provaClient, provaServer, stessaProva, probeServer,
} = require('../electron-server-auth');

module.exports = (async () => {
  console.log('--- Test autenticazione server Electron ---');
  const secret = nuovoSegretoIstanza();
  const server = http.createServer((req, res) => {
    const challenge = req.headers['x-codedb-instance-challenge'];
    const clientProof = req.headers['x-codedb-instance-client-proof'];
    const contesto = `porta:${req.socket.localPort}`;
    res.setHeader('content-type', 'application/json');
    const clientAutentico = stessaProva(provaClient(secret, challenge, contesto), clientProof);
    if (req.url === '/autentico') return res.end(JSON.stringify({
      app: 'codedb', ...(clientAutentico ? { instanceProof: provaServer(secret, challenge, contesto) } : {}),
    }));
    if (req.url === '/sbagliato') return res.end(JSON.stringify({
      app: 'codedb', instanceProof: provaServer('altro-segreto', challenge, contesto),
    }));
    return res.end(JSON.stringify({ app: 'codedb' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const adapter = {
    get(options, callback) {
      const mapped = { ...options, path: options.testPath || options.path };
      return http.get(mapped, callback);
    },
  };
  const probe = (testPath, candidate = secret) => probeServer({
    port, secret: candidate,
    httpModule: { get(options, callback) { return adapter.get({ ...options, testPath }, callback); } },
  });
  assert.strictEqual(await probe('/autentico'), true, 'server autentico');
  assert.strictEqual(await probe('/marker'), false, 'il solo marker pubblico non basta');
  assert.strictEqual(await probe('/sbagliato'), false, 'una prova legata a un’altra istanza viene rifiutata');
  assert.strictEqual(await probe('/autentico', nuovoSegretoIstanza()), false, 'un’altra istanza non può riusare il server');
  const senzaConoscenza = await new Promise((resolve) => {
    const challenge = 'a'.repeat(48);
    http.get({ host: '127.0.0.1', port, path: '/autentico', headers: {
      'x-codedb-instance-challenge': challenge,
    } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
  });
  assert.strictEqual(senzaConoscenza.instanceProof, undefined,
    'nessun oracolo di firma per processi che non conoscono il segreto');
  await new Promise((resolve) => server.close(resolve));
  console.log('  OK   server autentico, marker estraneo, prova errata e identità diversa');
})();
