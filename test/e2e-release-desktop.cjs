'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

async function verifica(executablePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-release-'));
  let app;
  try {
    const env = { ...process.env, CODEDB_ELECTRON_USER_DATA_DIR: profile, CODEDB_NO_UPDATE_CHECK: '1',
      CODEDB_RBAC: 'off', HOST: '127.0.0.1', PORT: '0', GUI_MONGO_PASSPHRASE: '',
      CODEDB_CONNECTIONS_FILE: path.join(profile, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(profile, 'conns'),
      CODEDB_UI_AUDIT_FILE: path.join(profile, 'ui-audit.log'), CODEDB_MCP_AUDIT_FILE: path.join(profile, 'mcp-audit.log'),
      CODEDB_BACKUPS_DIR: path.join(profile, 'backups') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.resolve(executablePath), env, timeout: 90000 });
    const info = await app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const carica = createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'));
      for (const base of [carica, createRequire(carica.resolve('@mongosh/service-provider-node-driver'))]) {
        base('kerberos'); base('mongodb-client-encryption');
      }
      return { packaged: app.isPackaged, version: app.getVersion() };
    });
    assert.equal(info.packaged, true);
    assert.equal(info.version, require('../package.json').version);
    const page = await app.firstWindow();
    await page.waitForSelector('html[data-arc-ready="true"]', { timeout: 60000 });
    assert.equal(new URL(page.url()).hostname, '127.0.0.1');
    console.log('OK avvio del pacchetto, frontend e caricamento reale di Kerberos/CSFLE. Database e aggiornamenti non esercitati.');
  } finally {
    await app?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
module.exports = { verifica };
if (require.main === module) verifica(process.argv[2]).catch(e => { console.error(e); process.exitCode = 1; });
