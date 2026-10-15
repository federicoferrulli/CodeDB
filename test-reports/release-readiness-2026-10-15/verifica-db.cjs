'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const env = { ...process.env, CODEDB_E2E_DESTRUCTIVE: '1',
  PGPORT: '55439', PG_PORT: '55439', MYSQL_PORT: '33339', MONGO_PORT: '27039',
  MONGO_URI: 'mongodb://127.0.0.1:27039', EXPORT_MONGO_PORT: '27039',
  EXPORT_MYSQL_PORT: '33339', EXPORT_PG_PORT: '55449',
  EXPORT_PG_CONTAINER: 'codedb-release-types-20261015', CODEDB_E2E_FAILOVER_NODES: '1',
  NODE_OPTIONS: '--require=./test/fixtures/sql-native-dns.cjs' };
const suites = [
  'e2e-preproduzione', 'e2e-sql-native', 'e2e-sql-native-sessioni', 'e2e-query-audit',
  'e2e-sql-native-ui', 'e2e-sql-mongo-avanzato', 'e2e-sql-mongo-completamento',
  'e2e-sql-mongo-tipi', 'e2e-sql-mongo-estesi', 'e2e-sql-mongo-varianti',
  'e2e-sql-mongo-eventi', 'e2e-sql-mongo-atomicita', 'e2e-sql-mongo-integrita',
  'e2e-sql-mongo-migrazioni', 'e2e-backup', 'e2e-backup-mysql', 'e2e-dbexport',
  'e2e-tipi-bson', 'e2e-tipi-sql', 'e2e-rbac', 'e2e-rbac-mcp', 'e2e-sql-mongo-failover',
];
const results = [];
for (const name of suites) {
  const start = Date.now();
  const log = fs.openSync(path.join(__dirname, name + '.log'), 'w');
  console.log('Avvio ' + name);
  const result = spawnSync(process.execPath, ['test/' + name + '.js'], {
    cwd: root, env, stdio: ['ignore', log, log], windowsHide: true, timeout: 900000,
  });
  fs.closeSync(log);
  results.push({ nome: name, codice: result.status, errore: result.error?.message,
    secondi: Math.round((Date.now() - start) / 1000), log: name + '.log' });
  fs.writeFileSync(path.join(__dirname, 'database-risultati.json'), JSON.stringify(results, null, 2));
  console.log(`${result.status === 0 ? 'OK' : 'FAIL'} ${name} (${results.at(-1).secondi}s)`);
}
process.exitCode = results.every(r => r.codice === 0) ? 0 : 1;
