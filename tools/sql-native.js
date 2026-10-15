'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.sql-native');
const azione = process.argv[2] || 'up';
if (!['up', 'stop', 'status'].includes(azione)) throw new Error('Usa up, stop oppure status.');
if (azione === 'up' && !fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, ['PG', 'MY', 'MY_ROOT'].map(k => `CODEDB_NATIVE_${k}_PASSWORD=${randomBytes(24).toString('hex')}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
}
if (!fs.existsSync(envFile)) throw new Error('Avvia prima i motori con npm run sql:native:up.');
const args = ['compose', '--env-file', envFile, '-f', 'docker-compose.sql-native.yml',
  ...(azione === 'up' ? ['up', '-d', '--wait'] : azione === 'stop' ? ['stop'] : ['ps'])];
const r = spawnSync('docker', args, { cwd: root, stdio: 'inherit', windowsHide: true });
if (r.error) throw r.error;
process.exitCode = r.status || 0;
if (r.status === 0 && azione === 'up') {
  console.log('Motori pronti: PostgreSQL 127.0.0.1:55432, MySQL 127.0.0.1:53306 (porte predefinite).');
  console.log('Collega utente/database codedb. Le password sono in .env.sql-native; lo stop conserva i dati.');
}
