'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { nuovoSegretoIstanza, probeServer } = require('../electron-server-auth');

function portaLibera() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function avvia(script, env, { readyText = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    const onError = (err) => reject(err);
    child.once('error', onError);
    child.once('spawn', () => {
      if (readyText == null) {
        child.off('error', onError);
        resolve({ child, stderr: () => stderr });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      if (readyText == null || !String(chunk).includes(readyText)) return;
      child.off('error', onError);
      resolve({ child, stderr: () => stderr });
    });
    child.once('exit', (code) => reject(new Error(`Processo di test terminato prima del READY (${code}): ${stderr}`)));
  });
}

async function attendiServer(port, secret, child, stderr) {
  for (let i = 0; i < 80; i++) {
    if (await probeServer({ port, secret, timeout: 100 })) return;
    if (child.exitCode != null) throw new Error(`server.js terminato (${child.exitCode}): ${stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server.js non autentico sulla porta ${port}: ${stderr()}`);
}

function attendiMarker(port) {
  return new Promise((resolve, reject) => {
    let tentativi = 0;
    const prova = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/handshake-check', timeout: 100 }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', () => (++tentativi < 80 ? setTimeout(prova, 50) : reject(new Error('Marker non avviato'))));
      req.on('timeout', () => req.destroy());
    };
    prova();
  });
}

function ferma(proc) {
  if (!proc || proc.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill('SIGTERM');
  });
}

function provaDaSecondoProcesso(port, secret) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixture-electron-probe-client.js')], {
      cwd: path.join(__dirname, '..'), windowsHide: true,
      env: {
        ...process.env,
        CODEDB_TEST_SERVER_PORT: String(port),
        CODEDB_ELECTRON_INSTANCE_SECRET: secret,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`Il secondo client non ha autenticato il server (${code}): ${stderr}`));
    });
  });
}

module.exports = (async () => {
  console.log('--- Test di processo autenticazione Electron/server.js ---');
  const secret = nuovoSegretoIstanza();
  const realPort = await portaLibera();
  const markerPort = await portaLibera();
  const auditFile = path.join(os.tmpdir(), `codedb-electron-auth-${process.pid}.log`);
  let reale;
  let marker;
  try {
    reale = await avvia(path.join(__dirname, '..', 'server.js'), {
      PORT: String(realPort), HOST: '127.0.0.1',
      CODEDB_ELECTRON_INSTANCE_SECRET: secret,
      CODEDB_UI_AUDIT_FILE: auditFile,
    });
    await attendiServer(realPort, secret, reale.child, reale.stderr);
    assert.strictEqual(await probeServer({ port: realPort, secret }), true, 'primo collegamento autentico');
    assert.strictEqual(await provaDaSecondoProcesso(realPort, secret), true,
      'riuso valido da un secondo processo con la stessa identità ricevuta');
    assert.strictEqual(await probeServer({ port: realPort, secret: nuovoSegretoIstanza() }), false,
      'un processo con identità diversa viene rifiutato');

    marker = await avvia(path.join(__dirname, 'fixture-electron-marker-server.js'), {
      CODEDB_TEST_MARKER_PORT: String(markerPort),
    }, { readyText: 'READY' });
    await attendiMarker(markerPort);
    assert.strictEqual(await probeServer({ port: markerPort, secret }), false,
      'un processo estraneo col solo marker pubblico viene rifiutato');
    console.log('  OK   server reale, processo estraneo e riuso autenticato fra processi');
  } finally {
    await Promise.all([ferma(reale && reale.child), ferma(marker && marker.child)]);
    try { fs.rmSync(auditFile, { force: true }); } catch { /* file mai creato */ }
  }
})();
