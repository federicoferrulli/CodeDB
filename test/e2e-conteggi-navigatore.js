'use strict';

// Database usa e getta in container dedicati: nessun accesso ai database dell’utente.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');

const owned = [], closers = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
function avvia(engine, image, env, port) {
  const name = `codedb-count-${engine}-${randomUUID().slice(0, 8)}`;
  docker('run', '--pull=never', '--rm', '-d', '--name', name, '-p', `127.0.0.1::${port}`, ...env.flatMap(e => ['-e', e]), image);
  owned.push(name);
  return Number(docker('port', name, `${port}/tcp`).split(':').pop());
}
async function pronto(action) {
  const end = Date.now() + 60000;
  for (;;) {
    try { return await action(); }
    catch (e) { if (Date.now() >= end) throw e; await new Promise(r => setTimeout(r, 400)); }
  }
}
async function elenco(s, db) {
  const start = performance.now();
  const rows = await s.listCollections(db);
  console.log(`${s.type}: ${rows.length} tabelle in ${Math.round(performance.now() - start)} ms`);
  return new Map(rows.map(c => [c.name, c]));
}

(async () => {
  try {
    const pgPort = avvia('pg', 'postgres:17', ['POSTGRES_HOST_AUTH_METHOD=trust'], 5432);
    const sqlPort = avvia('mysql', 'mysql:8.4', ['MYSQL_ALLOW_EMPTY_PASSWORD=yes'], 3306);
    const mongoPort = avvia('mongo', 'mongo:8.0', [], 27017);
    const pg = new PostgreSqlStrategy();
    pg.pool = new Pool({ host: '127.0.0.1', port: pgPort, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 1000 });
    closers.push(() => pg.pool.end());
    await pronto(() => pg.pool.query('SELECT 1'));
    await pg.pool.query('CREATE SCHEMA diego; CREATE SCHEMA altro');
    await pg.pool.query('CREATE TABLE diego."Prova" (id int); INSERT INTO diego."Prova" VALUES (1),(2),(3); CREATE TABLE altro."Prova" (id int)');
    await pg.pool.query('CREATE TABLE diego.vuota (id int); CREATE TABLE diego.grande AS SELECT generate_series(1, 100000) AS id; ANALYZE diego.grande');
    await pg.pool.query('CREATE TABLE diego.nuova_grande AS SELECT generate_series(1, 20000) AS id; CREATE VIEW diego.vista AS SELECT * FROM diego.grande');
    let rows = await elenco(pg, 'diego');
    assert.equal(rows.get('Prova').count, 3); assert.equal(rows.get('Prova').countApprox, false);
    assert.equal(rows.get('vuota').count, 0);
    assert.equal(rows.get('grande').countApprox, true);
    assert(rows.get('grande').count >= 90000);
    assert.equal(rows.get('vista').count, null);
    assert.equal((await elenco(pg, 'altro')).get('Prova').count, 0, 'Omonimi isolati per schema');
    await pg.pool.query('INSERT INTO diego."Prova" VALUES (4),(5)');
    assert.equal((await elenco(pg, 'diego')).get('Prova').count, 5, 'Statistiche stale dopo INSERT');
    const locked = await pg.pool.connect();
    try {
      await locked.query('BEGIN; LOCK TABLE diego."Prova" IN ACCESS EXCLUSIVE MODE');
      const start = performance.now();
      rows = await elenco(pg, 'diego');
      assert.equal(rows.get('Prova').count, null, 'Timeout senza falso zero');
      assert(performance.now() - start < 1500, 'La tabella bloccata non ferma la navigazione');
    } finally { await locked.query('ROLLBACK'); locked.release(); }
    assert.equal((await elenco(pg, 'diego')).get('Prova').count, 5, 'Pool riutilizzabile dopo timeout');
    console.log('OK PostgreSQL reale: statistiche assenti/vecchie, grandi, viste, omonimi, lock e recupero');

    const sql = new MySqlStrategy();
    sql.pool = mysql.createPool({ host: '127.0.0.1', port: sqlPort, user: 'root', password: '', connectionLimit: 5, connectTimeout: 1000 });
    closers.push(() => sql.pool.end());
    await pronto(() => sql.pool.query('SELECT 1'));
    await sql.pool.query('CREATE DATABASE diego');
    await sql.pool.query('CREATE TABLE diego.Prova (id int)');
    await sql.pool.query('INSERT INTO diego.Prova VALUES (1),(2),(3)');
    await sql.pool.query('CREATE TABLE diego.grande (id int)');
    for (let i = 0; i < 10; i++) await sql.pool.query('INSERT INTO diego.grande VALUES ?', [Array.from({ length: 1000 }, (_, j) => [i * 1000 + j])]);
    await sql.pool.query('ANALYZE TABLE diego.grande');
    rows = await elenco(sql, 'diego');
    assert.equal(rows.get('Prova').count, 3); assert.equal(rows.get('Prova').countApprox, false);
    assert.equal(rows.get('grande').countApprox, true);
    console.log('OK MySQL reale: conteggio esatto immediato e stima InnoDB');

    const mongo = new MongoDbStrategy();
    mongo.client = new MongoClient(`mongodb://127.0.0.1:${mongoPort}`, { serverSelectionTimeoutMS: 1500 });
    closers.push(() => mongo.client.close());
    await pronto(() => mongo.client.connect());
    await mongo.client.db('diego').collection('Prova').insertMany([{ i: 1 }, { i: 2 }, { i: 3 }]);
    await mongo.client.db('diego').collection('grande').insertMany(Array.from({ length: 10000 }, (_, i) => ({ i })));
    await mongo.client.db('diego').createCollection('vuota');
    await mongo.client.db('diego').createCollection('vista', { viewOn: 'grande', pipeline: [] });
    rows = await elenco(mongo, 'diego');
    assert.equal(rows.get('Prova').count, 3); assert.equal(rows.get('Prova').countApprox, false);
    assert.equal(rows.get('grande').countApprox, true); assert.equal(rows.get('grande').count, 10000);
    assert.equal(rows.get('vuota').count, 0); assert.equal(rows.get('vista').count, null);
    console.log('OK MongoDB reale: conteggio esatto, metadati stimati, vuote e viste');
  } finally {
    for (const close of closers) await close();
    for (const name of owned.reverse()) docker('rm', '-f', '-v', name);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
