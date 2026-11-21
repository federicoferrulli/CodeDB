'use strict';

// Eseguire dopo docker build: node test/e2e-dati-docker.js <immagine>.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const image = process.argv[2] || process.env.CODEDB_E2E_DOCKER_IMAGE;
if (!image || image.startsWith('-')) throw new Error('Indica l’immagine CodeDB da verificare.');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

async function verificaNelContainer(fase) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { env } = require('./server/configurazione').configurazione();
  const settings = require('./mcp/Settings').createSettings({ filePath: env.CODEDB_MCP_SETTINGS_FILE });
  const log = [env.CODEDB_UI_AUDIT_FILE, env.CODEDB_MCP_AUDIT_FILE];
  if (fase === 'vecchio') {
    await settings.update({ readOnly: true }, 0);
    for (const file of log) for (const ext of ['', '.1']) {
      fs.writeFileSync(file + ext, JSON.stringify({ event: 'migrazione' + ext }) + '\n');
    }
  } else {
    assert.equal(settings.get().readOnly, true);
    for (const file of log) {
      const auditor = require('./db/AuditLog').makeAuditor(file);
      assert.deepEqual(auditor.readRecent().entries.map(e => e.event), ['migrazione', 'migrazione.1']);
    }
    if (fase === 'aggiorna') await settings.update({ allowDdl: false }, 1);
    else assert.equal(settings.get().allowDdl, false);
  }
}

function codice(fase) {
  return '(' + verificaNelContainer.toString() + ')(' + JSON.stringify(fase) + ').catch(err => { console.error(err); process.exitCode = 1; });';
}

const vecchio = docker('create', '--network', 'none', '-v', '/app/data',
  '-e', 'CODEDB_MCP_SETTINGS_FILE=/app/mcp-settings.json', '-e', 'CODEDB_UI_AUDIT_FILE=/app/ui-audit.log',
  '-e', 'CODEDB_MCP_AUDIT_FILE=/app/mcp-audit.log', '--entrypoint', 'node', image, '-e', codice('vecchio'));
try {
  docker('start', '-a', vecchio);
  const migra = () => execFileSync(process.execPath, [path.join(__dirname, '../tools/migra-dati-docker.js'), vecchio], { encoding: 'utf8' });
  assert.match(migra(), /Copiati: 5\./);
  assert.match(migra(), /Copiati: 0\./);
  for (const fase of ['aggiorna', 'rileggi']) {
    docker('run', '--rm', '--network', 'none', '--volumes-from', vecchio, '--entrypoint', 'node', image, '-e', codice(fase));
  }
  const conflitto = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '../tools/migra-dati-docker.js'), vecchio], { encoding: 'utf8' });
  assert.notEqual(conflitto.status, 0);
  assert.match(conflitto.stderr, /due versioni diverse/);
  console.log('OK Docker: migrazione ripetibile, ricreazione, storico audit e conflitto preservato.');
} finally { docker('rm', '-v', vecchio); }
