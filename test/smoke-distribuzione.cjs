'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const rootDir = path.resolve(process.argv[2] || process.cwd());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-release-smoke-'));
const { createServer } = require(path.join(rootDir, 'server/createServer.js'));
const server = createServer({ config: { rootDir, env: {
  HOST: '127.0.0.1', PORT: '0', CODEDB_PUBLIC_BIND: '127.0.0.1', CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '',
  CODEDB_CONNECTIONS_FILE: path.join(dir, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(dir, 'conns'),
  CODEDB_BACKUPS_DIR: path.join(dir, 'backups'), CODEDB_SCRIPT_RESULTS_DIR: path.join(dir, 'scripts'),
  CODEDB_UI_AUDIT_FILE: path.join(dir, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(dir, 'mcp.log'),
} } });
(async () => {
  try {
    await server.start();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert((await response.text()).includes('CodeDB'));
    for (const file of ['js/query-tab.js', 'js/onboarding-stato.js', 'arc/ui.js']) {
      const asset = await fetch(`${base}/${file}`);
      assert.equal(asset.status, 200);
      assert((await asset.arrayBuffer()).byteLength > 0);
    }
    for (const file of ['LICENSE.md', 'MANLEVA.md', 'EULA.md']) assert(fs.statSync(path.join(rootDir, file)).size > 0);
    const estraneo = await fetch(`${base}/handshake-check`, { headers: { Origin: 'https://origine-estranea.invalid' } });
    assert.equal(estraneo.status, 403);
    await estraneo.arrayBuffer();
    console.log(JSON.stringify({ runtime: process.version, electron: process.versions.electron || null, http: 'ok', assets: 'ok', origin: 'rifiutata' }));
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
