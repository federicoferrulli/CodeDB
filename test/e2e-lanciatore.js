'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-launcher-'));
  const sentinella = http.createServer((_req, res) => res.end('sentinella'));
  const ascolta = port => new Promise(resolve => sentinella.listen(port, '127.0.0.1', resolve));
  const chiudi = () => new Promise(resolve => sentinella.close(resolve));
  await ascolta(0);
  const port = sentinella.address().port;
  const env = { ...process.env, GUI_MONGO_PASSPHRASE: '', PORT: String(port), HOST: '127.0.0.1', CODEDB_RBAC: 'off',
    CODEDB_LAUNCHER_DIR: dir, CODEDB_CONNECTIONS_FILE: path.join(dir, 'connections.ini'),
    CODEDB_UI_AUDIT_FILE: path.join(dir, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(dir, 'mcp.log'),
    CODEDB_BACKUPS_DIR: path.join(dir, 'backups'), CODEDB_MCP_SETTINGS_FILE: path.join(dir, 'mcp.json') };
  const lancia = comando => execFile(process.execPath, [path.join(__dirname, '../tools/lanciatore.js'), comando], { env, timeout: 30000 });
  const radice = path.resolve(__dirname, '..');
  const arrestaDaScript = () => process.platform === 'win32'
    ? execFile(process.env.ComSpec, ['/d', '/c', '.\\CodeDB.cmd', 'stop'], { env, cwd: radice, timeout: 30000 })
    : execFile('/bin/bash', [path.join(radice, 'codedb.sh'), 'stop'], { env, timeout: 30000 });
  try {
    await assert.rejects(lancia('start'), /occupata/);
    await assert.rejects(arrestaDaScript(), /occupata/);
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'sentinella');
    await chiudi();
    await lancia('start');
    assert.match((await lancia('start')).stdout, /già/);
    await arrestaDaScript();
    await ascolta(port);
    await assert.rejects(arrestaDaScript(), /occupata/);
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'sentinella');
    console.log('OK riuso, arresto e porta riassegnata');
  } finally {
    if (sentinella.listening) await chiudi();
    else await lancia('stop').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
