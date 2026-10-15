'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { io } = require('socket.io-client');
const image = 'codedb:0.2.1-beta.1-verifica';
const env = { ...process.env, CODEDB_TEST_PASSWORD: randomBytes(24).toString('hex') };
const config = ['compose', '-f', path.join(__dirname, 'docker-verifica.yml')];
function docker(args, expected = 0) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 240000, windowsHide: true });
  assert.equal(result.status, expected, result.stderr || result.error?.message);
  return result.stdout + result.stderr;
}
let ca, socket;
function request(route, data, headers = {}) {
  const body = data === undefined ? undefined : JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: 33090, servername: 'localhost', ca,
      path: route, method: body ? 'POST' : 'GET', headers: { Host: 'localhost:33090',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Timeout HTTPS')));
    req.on('error', reject); req.end(body);
  });
}
async function login() {
  const result = await request('/auth/login', { email: 'release@codedb.test', password: env.CODEDB_TEST_PASSWORD });
  assert.equal(result.status, 200, result.body);
  const { token } = JSON.parse(result.body); assert(token);
  socket = io('https://localhost:33090', { auth: { token }, ca, transports: ['websocket'],
    reconnection: false, extraHeaders: { Origin: 'https://localhost:33090' }, timeout: 10000 });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
}
function emit(event, payload = {}) {
  return new Promise((resolve, reject) => socket.timeout(10000).emit(event, payload, (err, data) => err ? reject(err) : resolve(data)));
}
(async () => {
  try {
    assert.match(docker(['run', '--rm', image], 1), /CODEDB_TRUST_PROXY_TLS/);
    assert.match(docker(['run', '--rm', '-e', 'CODEDB_TRUST_PROXY_TLS=1', image], 1), /CODEDB_RBAC/);
    console.log('OK immagine: avvio di rete rifiutato senza TLS o autenticazione');
    const smoke = docker(['run', '--rm', '-v', path.resolve('test/smoke-distribuzione.cjs') + ':/tmp/smoke.cjs:ro', image, 'node', '/tmp/smoke.cjs', '/app']);
    assert.match(smoke, /"http":"ok"/);
    console.log('OK immagine: runtime, HTTP, asset, licenze e filtro Origin');
    docker([...config, 'up', '-d', '--wait']);
    const proxy = docker([...config, 'ps', '-q', 'proxy']).trim();
    docker(['cp', proxy + ':/data/caddy/pki/authorities/local/root.crt', path.join(__dirname, 'caddy-test-ca.crt')]);
    ca = fs.readFileSync(path.join(__dirname, 'caddy-test-ca.crt'));
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/mcp', {})).status, 401);
    assert.equal((await request('/handshake-check', undefined, { Origin: 'https://estraneo.invalid' })).status, 403);
    await login();
    const save = await emit('connections:save', { name: 'persistenza-release', cfg: { dbType: 'mongodb', host: 'control', port: 27017 } });
    assert.equal(save.ok, true, save.error);
    socket.close(); socket = null;
    console.log('OK HTTPS verificato con CA locale, login, WebSocket autenticato e MCP anonimo respinto');
    docker([...config, 'up', '-d', '--no-deps', '--force-recreate', '--wait', 'codedb']);
    await login();
    const list = await emit('connections:list');
    assert(list.ok && list.connections.some(c => c.name === 'persistenza-release'), 'Connessione persa dopo ricreazione');
    const app = JSON.parse(docker(['inspect', docker([...config, 'ps', '-q', 'codedb']).trim()]))[0];
    assert.equal(app.Config.User, 'node');
    assert.equal(app.State.Health.Status, 'healthy');
    assert.equal(app.HostConfig.ReadonlyRootfs, true);
    assert(!Object.values(app.NetworkSettings.Ports || {}).some(Boolean));
    console.log('OK ricreazione container: dati e account conservati, utente non root, filesystem in sola lettura, backend non pubblicato');
    fs.writeFileSync(path.join(__dirname, 'docker-immagine.json'), docker(['image', 'inspect', image]));
  } finally {
    socket?.close();
    docker([...config, 'down', '-v']);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
