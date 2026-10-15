'use strict';
if (process.env.CODEDB_SQL_MUTANT) require('./fixtures/sql-native-mutant.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { io } = require('socket.io-client');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sessioni' });
const a = registry.target('a'), b = registry.target('b');
const pgPort = Number(process.env.PGPORT || 55439), myPort = Number(process.env.MYSQL_PORT || 33339);
const pg = new Client({ host: '127.0.0.1', port: pgPort, user: 'postgres', database: 'postgres' });
let pgConnected = false, my, server, socket, count = 0;
const emit = (event, payload) => new Promise((resolve, reject) => socket.timeout(15000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res)));
const raw = (type, db, code) => emit('query:execute', { tabId: type, engine: type, db, code });
async function q(type, db, code, expected) {
  const res = await raw(type, db, code);
  assert.equal(res.ok, true, `${type}: ${code}\n${res.error}`);
  if (expected !== undefined) assert.deepEqual(res.data, expected, code);
  return res.data;
}
const p = (db, sql, expected) => q('postgresql', db, sql, expected);
const m = (db, sql, expected) => q('mysql', db, sql, expected);
async function prova(nome, fn) { await fn(); count++; console.log(`OK ${nome}`); }
async function pgRows(schema) { return (await pg.query(`SELECT id FROM "${schema}".prova ORDER BY id`)).rows; }
async function svuotaPg() { for (const n of [a, b]) await pg.query(`TRUNCATE "${n}".prova`); }
async function terminaPg(pid) {
  const own = await pg.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND application_name=$2', [pid, a]);
  assert.equal(own.rowCount, 1, 'Terminare esclusivamente la connessione della fixture');
  await pg.query('SELECT pg_terminate_backend($1)', [pid]);
  await delay(100);
}
async function pidPg() {
  await p(a, `SET application_name='${a}'`);
  return (await p(a, 'SELECT pg_backend_pid() pid'))[0].pid;
}
(async () => {
  registry.assertOwned(a); registry.assertOwned(b);
  fs.mkdirSync(path.join(__dirname, '../test-reports/query-languages'), { recursive: true });
  await pg.connect(); pgConnected = true;
  my = await mysql.createConnection({ host: '127.0.0.1', port: myPort, user: 'root' });
  for (const n of [a, b]) {
    await pg.query(`CREATE SCHEMA "${n}"`); await pg.query(`CREATE TABLE "${n}".prova(id INT PRIMARY KEY)`);
    await my.query(`CREATE DATABASE \`${n}\``); await my.query(`CREATE TABLE \`${n}\`.prova(id INT PRIMARY KEY)`);
  }
  server = await startTestServer({ port: Number(process.env.E2E_PORT || 3184), env: {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${path.join(__dirname, 'fixtures/sql-native-mutant.cjs').replaceAll('\\', '/')}"`,
    CODEDB_SQL_ERROR_LOG: path.join(__dirname, '../test-reports/query-languages', `${a}-errors.log`),
  } });
  socket = io(server.url, { reconnection: false });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const [type, port, user, database] of [['postgresql', pgPort, 'postgres', 'postgres'], ['mysql', myPort, 'root', a]]) {
    const res = await emit('mongo:connect', { tabId: type, dbType: type, host: '127.0.0.1', port, username: user, database });
    assert.equal(res.ok, true, res.error);
  }
  console.log('Versioni:', (await pg.query('SHOW server_version')).rows[0].server_version, (await my.query('SELECT VERSION() v'))[0][0].v);
  await prova('PostgreSQL: rollback al savepoint ripristina il bersaglio richiesto', async () => {
    await p(a, 'BEGIN'); await p(a, 'SAVEPOINT prima');
    await p(b, 'INSERT INTO prova VALUES(1)'); await p(b, 'ROLLBACK TO SAVEPOINT prima');
    await p(b, 'INSERT INTO prova VALUES(2)'); await p(b, 'COMMIT');
    assert.deepEqual(await pgRows(a), [], 'Scrittura deviata nello schema A dopo savepoint');
    assert.deepEqual(await pgRows(b), [{ id: 2 }]);
    await svuotaPg();
  });
  await prova('PostgreSQL: rollback completo e errore nativo mantengono il bersaglio', async () => {
    await p(a, 'BEGIN'); await p(b, 'INSERT INTO prova VALUES(1)');
    assert.equal((await raw('postgresql', b, 'SELECT 1/0')).ok, false);
    await p(b, '/* recupero */ ROLLBACK'); await p(b, 'INSERT INTO prova VALUES(3)');
    assert.deepEqual(await pgRows(a), []); assert.deepEqual(await pgRows(b), [{ id: 3 }]);
    await svuotaPg();
  });
  await prova('PostgreSQL: savepoint annidati e SET LOCAL con COMMIT', async () => {
    await p(a, 'BEGIN'); await p(a, 'SAVEPOINT esterno');
    await p(b, 'SAVEPOINT interno'); await p(a, 'SELECT 1'); await p(b, 'ROLLBACK TO interno');
    await p(b, 'INSERT INTO prova VALUES(4)');
    await p(b, `SET LOCAL search_path TO "${a}"`); await p(b, 'INSERT INTO prova VALUES(5)'); await p(b, 'COMMIT');
    await p(b, 'INSERT INTO prova VALUES(6)');
    assert.deepEqual(await pgRows(a), []); assert.deepEqual(await pgRows(b), [{ id: 4 }, { id: 5 }, { id: 6 }]);
    await svuotaPg();
  });
  await prova('PostgreSQL: set_config, RESET ALL e DISCARD ALL non deviano le scritture', async () => {
    const timeout = await p(a, 'SHOW statement_timeout');
    for (const sql of [`SELECT set_config('search_path','${b}',false)`, 'RESET ALL', 'DISCARD ALL']) {
      await p(a, sql); await p(a, 'INSERT INTO prova VALUES(7)');
      assert.deepEqual(await pgRows(a), [{ id: 7 }]); assert.deepEqual(await pgRows(b), []); await svuotaPg();
      assert.deepEqual(await p(a, 'SHOW statement_timeout'), timeout, 'Il limite configurato non deve sparire');
    }
  });
  await prova('MySQL: USE seguito da ritorno al database iniziale', async () => {
    await m(a, 'SELECT DATABASE() db', [{ db: a }]); await m(a, `USE \`${b}\``);
    await m(a, 'INSERT INTO prova VALUES(8)');
    assert.deepEqual((await my.query(`SELECT * FROM \`${a}\`.prova`))[0], [{ id: 8 }], 'Scrittura deviata nel database B dopo USE');
    assert.deepEqual((await my.query(`SELECT * FROM \`${b}\`.prova`))[0], []);
  });
  await prova('MySQL: USE con commento passa attraverso SQL diretto', async () => {
    await m(a, `USE /* destinazione */ \`${b}\``); await m(a, 'INSERT INTO prova VALUES(9)');
    assert.deepEqual((await my.query(`SELECT * FROM \`${a}\`.prova ORDER BY id`))[0], [{ id: 8 }, { id: 9 }]);
    assert.deepEqual((await my.query(`SELECT * FROM \`${b}\`.prova`))[0], []);
  });
  await prova('PostgreSQL: rollback con commenti annidati chiude anche lo stato locale della transazione', async () => {
    const strategy = require('../db/DbFactory').getStrategy('postgresql');
    const { conSessioneSql } = require('../db/sqlSessione');
    const scope = {};
    const execute = (sql, extra = {}) => conSessioneSql(scope, () => strategy.collectionAggregate(a, null, { pipeline: sql, ...extra }), true);
    try {
      await strategy.connect({ host: '127.0.0.1', port: pgPort, username: 'postgres', database: 'postgres' });
      await execute('BEGIN');
      await assert.rejects(() => execute('SELECT 1/0'), /division by zero/);
      await assert.doesNotReject(() => execute('/* esterno /* interno */ fine */ ROLLBACK'),
        'Il recupero con commenti annidati deve raggiungere il server anche dopo un errore nativo');
      let lettura;
      await assert.doesNotReject(async () => { lettura = await execute('SELECT 1 n', { readOnly: true }); }, 'Il rollback deve chiudere anche lo stato locale');
      assert.deepEqual(lettura.docs, [{ n: 1 }]);
    } finally { await strategy.disconnect(); }
  });
  await prova('PostgreSQL: perdita inattiva, riconnessione e nessuna ripetizione automatica', async () => {
    for (let i = 0; i < 3; i++) {
      const pid = await pidPg(); await terminaPg(pid);
      const res = await raw('postgresql', a, 'INSERT INTO prova VALUES(10)');
      assert.equal(res.ok, false);
      await p(a, 'SELECT 1 n', [{ n: 1 }]);
      assert.match(res.error, /non è stata ripetuta/);
      assert.notEqual((await p(a, 'SELECT pg_backend_pid() pid'))[0].pid, pid);
      assert.deepEqual(await pgRows(a), [], 'La scrittura fallita non deve essere ripetuta');
    }
  });
  await prova('PostgreSQL: la transazione persa è segnalata e non viene confermata', async () => {
    const pid = await pidPg(); await p(a, 'BEGIN'); await p(a, 'INSERT INTO prova VALUES(11)');
    await terminaPg(pid);
    const res = await raw('postgresql', a, 'COMMIT');
    assert.equal(res.ok, false); assert.match(res.error, /sessione SQL.*non.*ripristinat/i);
    await p(a, 'SELECT 1 n', [{ n: 1 }]); assert.deepEqual(await pgRows(a), []);
  });
  await prova('PostgreSQL: connessione interrotta durante una scrittura, senza replay', async () => {
    const pid = await pidPg();
    const sql = 'INSERT INTO prova SELECT 12 FROM pg_sleep(20)';
    const pending = raw('postgresql', a, sql);
    const deadline = Date.now() + 5000;
    let attiva = false;
    while (Date.now() < deadline) {
      const res = await pg.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND query=$2 AND wait_event=$3', [pid, sql, 'PgSleep']);
      if (res.rowCount) { attiva = true; break; }
      await delay(20);
    }
    assert(attiva, 'Scrittura effettivamente in corso prima di interromperla');
    await terminaPg(pid);
    const res = await pending; assert.equal(res.ok, false); assert.match(res.error, /non è stata ripetuta/);
    await p(a, 'SELECT 1 n', [{ n: 1 }]); assert.deepEqual(await pgRows(a), []);
  });
  await prova('MySQL: perdita inattiva della connessione e recupero senza replay', async () => {
    const [{ cid }] = await m(a, 'SELECT CONNECTION_ID() cid');
    const [[own]] = await my.query('SELECT ID FROM information_schema.PROCESSLIST WHERE ID=? AND DB=?', [cid, a]);
    assert.equal(own.ID, cid, 'Terminare solo la connessione MySQL della fixture');
    await my.query(`KILL CONNECTION ${Number(cid)}`); await delay(100);
    const res = await raw('mysql', a, 'INSERT INTO prova VALUES(10)');
    assert.equal(res.ok, false); assert.match(res.error, /non è stata ripetuta/);
    await m(a, 'SELECT id FROM prova ORDER BY id', [{ id: 8 }, { id: 9 }]);
  });
  await m(a, 'SELECT 1 n', [{ n: 1 }]);
  assert.equal((await fetch(server.url)).ok, true);
  await prova('Disconnessione: rollback e rilascio delle sessioni persistenti attraverso i proxy', async () => {
    const pid = await pidPg();
    await p(a, 'BEGIN'); await p(a, 'INSERT INTO prova VALUES(13)');
    await m(a, 'START TRANSACTION'); await m(a, 'INSERT INTO prova VALUES(13)');
    for (const tabId of ['postgresql', 'mysql']) assert.equal((await emit('mongo:disconnect', { tabId })).ok, true);
    assert.deepEqual(await pgRows(a), []);
    assert.deepEqual((await my.query(`SELECT id FROM \`${a}\`.prova ORDER BY id`))[0], [{ id: 8 }, { id: 9 }]);
    assert.equal((await pg.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid])).rowCount, 0);
  });
  const errorLog = path.join(__dirname, '../test-reports/query-languages', `${a}-errors.log`);
  assert.equal(fs.existsSync(errorLog), false, 'Nessuna eccezione SQL deve raggiungere il gestore globale');
  console.log(`OK ${count} regressioni di sessione sui motori reali`);
})().catch(err => { console.error(err.stack); process.exitCode = 1; }).finally(async () => {
  socket?.disconnect(); if (server) await server.stop();
  if (pgConnected) { for (const n of [a, b]) await registry.drop(n, name => pg.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)); await pg.end(); }
  if (my) { for (const n of [a, b]) await registry.drop(n, name => my.query(`DROP DATABASE IF EXISTS \`${name}\``)); await my.end(); }
});
