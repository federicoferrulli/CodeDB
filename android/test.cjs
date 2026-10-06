'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { fileApplicazione, estraiZip } = require('./prepare.cjs');
const { proteggi } = require('./mobile.cjs');
const secret = 'a'.repeat(64);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verificaGate(gate) {
  const server = http.createServer((req, res) => res.end('privato'));
  gate(server, secret);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { cookie: 'codedb_mobile=errato' } })).status, 403);
    assert.equal(await (await fetch(url, { headers: { cookie: `altro=1; codedb_mobile=${secret}` } })).text(), 'privato');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function verificaDownload() {
  const sent = [];
  const alerts = [];
  function Anchor() {}
  Anchor.prototype.click = function () { throw new Error('Click non intercettato'); };
  const bridge = { postMessage(raw) {
    sent.push(JSON.parse(raw));
    queueMicrotask(() => bridge.onmessage({ data: 'ok' }));
  } };
  const context = { window: {}, CodeDBFiles: bridge, HTMLAnchorElement: Anchor,
    document: { addEventListener() {} }, alert: text => alerts.push(text),
    fetch: async () => new Response('x'.repeat(100000)), btoa, Uint8Array };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'app/src/main/assets/download.js'), 'utf8'), context);
  await context.window.__codedbDownload('blob:test', 'prova.csv');
  assert.deepEqual(alerts, []);
  assert.equal(sent[0].op, 'start');
  assert.equal(sent[0].name, 'prova.csv');
  assert.equal(sent.at(-1).op, 'end');
  assert.equal(Buffer.concat(sent.filter(c => c.op === 'chunk').map(c => Buffer.from(c.data, 'base64'))).toString(), 'x'.repeat(100000));
}

async function main() {
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-zip-'));
  try {
    // Piccolo ZIP reale, senza dipendere da librerie npm o tar.
    const zip = path.join(zipDir, 'prova.zip');
    fs.writeFileSync(zip, Buffer.from('UEsDBBQAAAAAALChNVuGphA2BQAAAAUAAAAJAAAAcHJvdmEudHh0aGVsbG9QSwECFAMUAAAAAACwoTVbhqYQNgUAAAAFAAAACQAAAAAAAAAAAAAAgAEAAAAAcHJvdmEudHh0UEsFBgAAAAABAAEANwAAACwAAAAAAA==', 'base64'));
    const dest = path.join(zipDir, 'estratto');
    estraiZip(zip, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'prova.txt'), 'utf8'), 'hello');
  } finally { fs.rmSync(zipDir, { recursive: true, force: true }); }
  for (const name of ['vault.json', '.env', 'connections.ini', 'data/conns/a.ini', 'android/secret.jks']) {
    assert.equal(fileApplicazione(name), false, name);
  }
  for (const name of ['server/createServer.js', 'db/vault.js', 'public/index.html', 'LICENSE.md', 'EULA.md']) {
    assert.equal(fileApplicazione(name), true, name);
  }
  await verificaGate(proteggi);
  // Sensibilità: la stessa prova deve fallire se viene eliminato il controllo cookie.
  const source = fs.readFileSync(path.join(__dirname, 'mobile.cjs'), 'utf8')
    .replace('actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)', 'false');
  const context = { require, module: { exports: {} }, Buffer };
  vm.runInNewContext(source, context);
  await assert.rejects(verificaGate(context.module.exports.proteggi), { code: 'ERR_ASSERTION' });
  await verificaDownload();

  const project = path.join(__dirname, 'build/node-project');
  assert.ok(fs.existsSync(path.join(project, 'mobile.cjs')), 'Esegui npm run prepare:android prima del test');
  for (const name of ['vault.json', '.env', 'connections.ini', 'electron-main.js']) {
    assert.equal(fs.existsSync(path.join(project, name)), false, name);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-android-'));
  const data = path.join(temp, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'persistenza.txt'), 'dati precedenti');
  const ready = path.join(temp, 'ready.json');
  let child, stopped, output = '';
  const start = async () => {
    fs.rmSync(ready, { force: true });
    output = '';
    child = spawn(process.execPath, [path.join(project, 'mobile.cjs'), data, ready, secret, '[]'], { stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = once(child, 'exit');
    child.stdout.on('data', text => { output += text; });
    child.stderr.on('data', text => { output += text; });
    for (let i = 0; i < 200 && !fs.existsSync(ready) && child.exitCode === null; i++) await delay(100);
    assert.ok(fs.existsSync(ready), output || 'Il server non è partito');
    return JSON.parse(fs.readFileSync(ready));
  };
  try {
    const state = await start();
    assert.equal(state.error, undefined, output);
    const headers = { cookie: `codedb_mobile=${secret}` };
    assert.equal((await fetch(state.url + '/handshake-check')).status, 403);
    assert.equal((await fetch(state.url + '/socket.io/?EIO=4&transport=polling')).status, 403);
    assert.equal((await fetch(state.url + '/mcp')).status, 403);
    assert.equal((await (await fetch(state.url + '/handshake-check', { headers })).json()).app, 'codedb');
    assert.equal((await fetch(state.url, { headers })).status, 200);
    assert.match(await (await fetch(state.url + '/socket.io/?EIO=4&transport=polling', { headers })).text(), /^0\{"sid":/);
    const WebSocket = require(path.join(project, 'node_modules/ws'));
    const socket = new WebSocket(state.url.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket', { headers });
    const message = await once(socket, 'message');
    assert.match(String(message[0]), /^0\{"sid":/);
    socket.close();
    const refused = new WebSocket(state.url.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    await once(refused, 'error');
    assert.ok(fs.existsSync(data));
    assert.equal(fs.readFileSync(path.join(data, 'persistenza.txt'), 'utf8'), 'dati precedenti');
    assert.equal(fs.existsSync(path.join(project, 'vault.json')), false);
    child.kill(); await stopped;
    const restarted = await start();
    assert.equal(restarted.error, undefined, output);
    assert.equal(restarted.url, state.url, 'cronologia e IndexedDB devono conservare la stessa origine fra processi');
    assert.equal((await fetch(restarted.url, { headers })).status, 200);
    child.kill(); await stopped;
    // Un'altra app non deve causare il passaggio silenzioso a un'origine vuota.
    const occupied = http.createServer();
    await new Promise(resolve => occupied.listen(Number(new URL(state.url).port), '127.0.0.1', resolve));
    try { assert.match((await start()).error, /porta.*occupata/i); }
    finally { await new Promise(resolve => occupied.close(resolve)); }
    console.log('OK Android: ZIP, backend reale, origine persistente, porta occupata, cookie HTTP/WebSocket, download e sensibilità del test.');
  } finally {
    if (child) { child.kill(); await stopped; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[2]) {
  const jar = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar') : 'jar';
  const entries = execFileSync(jar, ['tf', path.resolve(process.argv[2])], { encoding: 'utf8' }).split(/\r?\n/);
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
    for (const library of ['libnode.so', 'libcodedb.so', 'libc++_shared.so']) assert.ok(entries.includes(`lib/${abi}/${library}`), `${abi}: manca ${library}`);
  }
  for (const asset of ['runtime.zip', 'download.js', 'LICENSE-nodejs-mobile.txt']) assert.ok(entries.includes(`assets/${asset}`), asset);
  console.log('OK APK: runtime, ponte, libreria C++ e asset presenti per tutte le architetture.');
} else main().catch(error => { console.error(error); process.exitCode = 1; });
