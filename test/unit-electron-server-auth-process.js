'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
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

function avvia(script, env, readyText = 'CodeDB in ascolto su ') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Avvio scaduto per ${path.basename(script)}: ${stderr}`));
    }, 30000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes(readyText)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Processo di test terminato prima del READY (${code}): ${stderr}`));
    });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-launcher-'));
  const isolatedEnv = {
    CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '',
    CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'),
    CODEDB_CONNECTIONS_DIR: path.join(root, 'conns'),
    CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: auditFile,
    CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  };
  let reale;
  let marker;
  let cli;
  try {
    execFileSync(process.execPath, ['-e', `
      const assert = require('assert');
      const before = process.eventNames().map(n => [n, process.listenerCount(n)]);
      const fs = require('fs');
      const root = process.env.CODEDB_TEST_IMPORT_ROOT;
      const files = fs.readdirSync(root);
      require('./server');
      assert.deepStrictEqual(process.eventNames().map(n => [n, process.listenerCount(n)]), before);
      assert.deepStrictEqual(fs.readdirSync(root), files);
    `], { cwd: path.join(__dirname, '..'), windowsHide: true, timeout: 30000,
      env: { ...process.env, ...isolatedEnv, CODEDB_TEST_IMPORT_ROOT: root } });
    reale = await avvia(path.join(__dirname, '..', 'server.js'), {
      ...isolatedEnv,
      PORT: String(realPort), HOST: '127.0.0.1',
      CODEDB_ELECTRON_INSTANCE_SECRET: secret,
      CODEDB_UI_AUDIT_FILE: auditFile,
    });
    assert.strictEqual(await probeServer({ port: realPort, secret }), true, 'primo collegamento autentico');
    assert.strictEqual(await provaDaSecondoProcesso(realPort, secret), true,
      'riuso valido da un secondo processo con la stessa identità ricevuta');
    assert.strictEqual(await probeServer({ port: realPort, secret: nuovoSegretoIstanza() }), false,
      'un processo con identità diversa viene rifiutato');

    const cliPort = await portaLibera();
    cli = await avvia(path.join(__dirname, '..', 'bin', 'codedb.js'), {
      ...isolatedEnv, PORT: String(cliPort), HOST: '127.0.0.1', CODEDB_ELECTRON_INSTANCE_SECRET: secret,
    });
    assert.strictEqual(await probeServer({ port: cliPort, secret }), true, 'il launcher bin avvia davvero il server');

    marker = await avvia(path.join(__dirname, 'fixture-electron-marker-server.js'), {
      CODEDB_TEST_MARKER_PORT: String(markerPort),
    }, 'READY');
    assert.strictEqual(await probeServer({ port: markerPort, secret }), false,
      'un processo estraneo col solo marker pubblico viene rifiutato');
    console.log('  OK   server reale, processo estraneo e riuso autenticato fra processi');
  } finally {
    await Promise.all([ferma(reale), ferma(marker), ferma(cli)]);
    try { fs.rmSync(auditFile, { force: true }); } catch { /* file mai creato */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
