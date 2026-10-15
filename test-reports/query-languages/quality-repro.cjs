'use strict';
// Riproduzioni del controllo qualità: non modificano il codice del prodotto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { startTestServer, createE2eTargetRegistry } = require('../../test/e2e-harness');
const root = path.resolve(__dirname, '../..');
const settings = Object.fromEntries(fs.readFileSync(path.join(root, '.env.sql-native'), 'utf8').trim().split(/\r?\n/).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_quality' });
const names = { pgA: registry.target('pg_a'), pgB: registry.target('pg_b'), myA: registry.target('my_a'), myB: registry.target('my_b') };
const pgCfg = { host: '127.0.0.1', port: Number(settings.CODEDB_NATIVE_PG_PORT || 55432), user: 'codedb', password: settings.CODEDB_NATIVE_PG_PASSWORD, database: 'codedb' };
const myCfg = { host: '127.0.0.1', port: Number(settings.CODEDB_NATIVE_MY_PORT || 53306), user: 'root', password: settings.CODEDB_NATIVE_MY_ROOT_PASSWORD };
let server, socket, pg, my;
const findings = [];
const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(10000).emit(event, payload, (err, result) => err ? reject(err) : resolve(result)));
async function q(type, db, code) {
  const result = await emit('query:execute', { tabId: type, engine: type, db, code });
  assert.equal(result.ok, true, `${code}: ${result.error}`);
  return result.data;
}
const log = (id, expected, actual) => { findings.push({ id, expected, actual }); console.log(JSON.stringify(findings.at(-1))); };
async function alive() { try { return (await fetch(server.url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }
(async () => {
  Object.values(names).forEach(n => registry.assertOwned(n));
  pg = new Client(pgCfg); await pg.connect();
  my = await mysql.createConnection(myCfg);
  console.log('Versioni:', (await pg.query('SHOW server_version')).rows[0].server_version, (await my.query('SELECT VERSION() v'))[0][0].v);
  for (const schema of [names.pgA, names.pgB]) {
    await pg.query(`CREATE SCHEMA "${schema}"`);
    await pg.query(`CREATE TABLE "${schema}".prova(id INT)`);
  }
  for (const db of [names.myA, names.myB]) {
    await my.query(`CREATE DATABASE \`${db}\``);
    await my.query(`CREATE TABLE \`${db}\`.prova(id INT)`);
  }
  server = await startTestServer({ port: 3184 });
  socket = io(server.url, { reconnection: false });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const [type, cfg] of [['postgresql', pgCfg], ['mysql', { ...myCfg, database: names.myA }]]) {
    const res = await emit('mongo:connect', { tabId: type, dbType: type, host: cfg.host, port: cfg.port, username: cfg.user, password: cfg.password, database: cfg.database });
    assert.equal(res.ok, true, res.error);
  }
  const p = (db, sql) => q('postgresql', db, sql);
  const m = (db, sql) => q('mysql', db, sql);
  // Controllo positivo: il normale cambio di contesto funziona prima del rollback.
  assert.deepEqual(await p(names.pgA, 'SELECT current_schema() s'), [{ s: names.pgA }]);
  assert.deepEqual(await p(names.pgB, 'SELECT current_schema() s'), [{ s: names.pgB }]);
  await p(names.pgA, 'BEGIN');
  await p(names.pgA, 'SAVEPOINT prima');
  await p(names.pgB, 'INSERT INTO prova VALUES(1)');
  await p(names.pgB, 'ROLLBACK TO SAVEPOINT prima');
  await p(names.pgB, 'INSERT INTO prova VALUES(2)');
  await p(names.pgB, 'COMMIT');
  log('postgresql-savepoint-destinazione', { A: [], B: [{ id: 2 }] }, {
    A: (await pg.query(`SELECT * FROM "${names.pgA}".prova`)).rows,
    B: (await pg.query(`SELECT * FROM "${names.pgB}".prova`)).rows,
  });
  await p(names.pgA, 'BEGIN');
  await p(names.pgB, 'SELECT 1');
  await p(names.pgB, 'ROLLBACK');
  await p(names.pgB, 'INSERT INTO prova VALUES(3)');
  log('postgresql-rollback-destinazione', { A: [{ id: 2 }], B: [{ id: 3 }] }, {
    A: (await pg.query(`SELECT * FROM "${names.pgA}".prova ORDER BY id`)).rows,
    B: (await pg.query(`SELECT * FROM "${names.pgB}".prova ORDER BY id`)).rows,
  });
  assert.deepEqual(await m(names.myA, 'SELECT DATABASE() db'), [{ db: names.myA }]);
  await m(names.myA, `USE \`${names.myB}\``);
  await m(names.myA, 'INSERT INTO prova VALUES(4)');
  log('mysql-use-destinazione', { A: [{ id: 4 }], B: [] }, {
    A: (await my.query(`SELECT * FROM \`${names.myA}\`.prova`))[0],
    B: (await my.query(`SELECT * FROM \`${names.myB}\`.prova`))[0],
  });
  // Termina esclusivamente il backend ottenuto dalla connessione del server usa e getta.
  const marker = registry.target('connessione');
  await p(names.pgA, `SET application_name = '${marker}'`);
  const [{ pid }] = await p(names.pgA, 'SELECT pg_backend_pid() pid');
  const target = await pg.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND usename=$3', [pid, marker, pgCfg.user]);
  assert.equal(target.rowCount, 1);
  assert.equal(await alive(), true);
  await pg.query('SELECT pg_terminate_backend($1)', [pid]);
  await new Promise(resolve => setTimeout(resolve, 1500));
  log('postgresql-connessione-inattiva-interrotta', { serverDisponibile: true }, { serverDisponibile: await alive(), socketConnesso: socket.connected });
  const tentativi = [];
  for (let i = 0; i < 2; i++) {
    const result = await emit('query:execute', { tabId: 'postgresql', engine: 'postgresql', db: names.pgA, code: 'SELECT 1 n' });
    tentativi.push({ ok: result.ok, data: result.data, error: result.error });
  }
  log('postgresql-recupero-connessione', { secondoTentativo: { ok: true, data: [{ n: 1 }] } }, { tentativi });
  assert.deepEqual(await m(names.myA, 'SELECT 1 n'), [{ n: 1 }]);
})().catch(err => { console.error(err.stack); process.exitCode = 1; }).finally(async () => {
  socket?.disconnect();
  if (server) await server.stop();
  if (pg) {
    for (const n of [names.pgA, names.pgB]) await registry.drop(n, name => pg.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
    await pg.end();
  }
  if (my) {
    for (const n of [names.myA, names.myB]) await registry.drop(n, name => my.query(`DROP DATABASE IF EXISTS \`${name}\``));
    await my.end();
  }
  fs.writeFileSync(path.join(__dirname, 'quality-results.json'), JSON.stringify({ date: new Date().toISOString(), findings }, null, 2) + '\n');
});
