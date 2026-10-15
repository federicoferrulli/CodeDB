'use strict';
// Prova esplicita dello stack locale: stop/avvio preservano i volumi e le credenziali.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { createE2eTargetRegistry } = require('./e2e-harness');
if (process.env.CODEDB_E2E_NATIVE_PROVISIONING !== '1') throw new Error('Imposta CODEDB_E2E_NATIVE_PROVISIONING=1: questa prova riavvia lo stack SQL locale.');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_volume_test' });
const table = registry.target('persistenza');
registry.assertOwned(table);
const before = fs.readFileSync('.env.sql-native', 'utf8');
const env = Object.fromEntries(before.trim().split(/\r?\n/).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
for (const key of ['PG', 'MY', 'MY_ROOT']) assert.match(env[`CODEDB_NATIVE_${key}_PASSWORD`], /^[a-f0-9]{48}$/);
let pg, my;
async function connect() {
  pg = new Client({ host: '127.0.0.1', port: Number(env.CODEDB_NATIVE_PG_PORT || 55432), user: 'codedb', password: env.CODEDB_NATIVE_PG_PASSWORD, database: 'codedb' });
  await pg.connect();
  my = await mysql.createConnection({ host: '127.0.0.1', port: Number(env.CODEDB_NATIVE_MY_PORT || 53306), user: 'codedb', password: env.CODEDB_NATIVE_MY_PASSWORD, database: 'codedb' });
}
(async () => {
  await connect();
  await pg.query(`CREATE TABLE "${table}"(n INT)`); await pg.query(`INSERT INTO "${table}" VALUES(42)`);
  await my.query(`CREATE TABLE \`${table}\`(n INT)`); await my.query(`INSERT INTO \`${table}\` VALUES(42)`);
  await pg.end(); pg = null; await my.end(); my = null;
  for (const action of ['stop', 'up']) {
    const r = spawnSync(process.execPath, ['tools/sql-native.js', action], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert(!Object.values(env).some(v => v && (r.stdout + r.stderr).includes(v)), 'Password esposta nel log');
  }
  assert.equal(fs.readFileSync('.env.sql-native', 'utf8'), before, 'Le password devono sopravvivere al riavvio');
  await connect();
  assert.deepEqual((await pg.query(`SELECT n FROM "${table}"`)).rows, [{ n: 42 }]);
  assert.deepEqual((await my.query(`SELECT n FROM \`${table}\``))[0], [{ n: 42 }]);
  console.log('OK stack nativo: autenticazione, stop/avvio, password conservate, dati persistenti su entrambi i motori');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (pg) { await registry.drop(table, n => pg.query(`DROP TABLE IF EXISTS "${n}"`)); await pg.end(); }
  if (my) { await registry.drop(table, n => my.query(`DROP TABLE IF EXISTS \`${n}\``)); await my.end(); }
});
