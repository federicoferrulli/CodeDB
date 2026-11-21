'use strict';

// Richiede entrambi i motori di prova. Le password arrivano dall'ambiente.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const MySql = require('../db/MySqlStrategy');
const Postgres = require('../db/PostgreSqlStrategy');

async function verifica(pg) {
  const prefisso = pg ? 'PG' : 'MYSQL';
  const port = process.env['E2E_' + prefisso + '_PORT'];
  if (!port) throw new Error('Imposta E2E_' + prefisso + '_PORT per il motore di prova.');
  const strategia = new (pg ? Postgres : MySql)({ env: { CODEDB_MAX_RESULT_BYTES: '220' } });
  const nome = 'e2e_budget_' + randomUUID().replaceAll('-', '');
  const oggetto = pg ? 'SCHEMA' : 'DATABASE';
  await strategia.connect({ host: process.env['E2E_' + prefisso + '_HOST'] || '127.0.0.1', port, username: process.env['E2E_' + prefisso + '_USER'] || (pg ? 'postgres' : 'root'), password: process.env['E2E_' + prefisso + '_PASSWORD'] });
  let proprio = false;
  let righeNelDriver;
  const pool = pg ? strategia.pool : strategia.pool.pool;
  const osservate = new WeakSet();
  pool.on('acquire', conn => {
    if (osservate.has(conn)) return;
    osservate.add(conn);
    const query = conn.query;
    conn.query = function (config, ...args) {
      const esito = query.call(this, config, ...args);
      if ((config.text || config.sql || '').includes('verifica_buffer')) {
        if (pg) {
          const misura = r => { righeNelDriver = r.rows.length; };
          if (esito.once) esito.once('end', misura);
          else esito.then(misura);
        } else esito.once('end', () => { righeNelDriver = esito._rows[0].length; });
      }
      return esito;
    };
  });
  const esegui = (pipeline, maxRows = Infinity) => strategia.collectionAggregate(nome, null, { pipeline, maxRows });
  try {
    await strategia.pool.query('CREATE ' + oggetto + ' ' + nome);
    proprio = true;
    await esegui('CREATE TABLE prova(id INT PRIMARY KEY, v VARCHAR(100))');
    const valori = Array.from({ length: 80 }, (_, i) => '(' + i + ", 'abcdefghijk')").join(',');
    const inserito = await esegui('INSERT INTO prova VALUES ' + valori + (pg ? ' RETURNING *' : ''));
    if (pg) { assert.equal(inserito.truncated, true); assert.equal(inserito.total, 80); }
    const parziale = await esegui('SELECT id, v FROM prova ORDER BY id /* verifica_buffer */');
    assert.equal(righeNelDriver, 0, 'Il driver conserva un intero result set oltre al prefisso mostrato');
    assert.equal(parziale.truncated, true);
    assert.equal(parziale.total, 80);
    assert(parziale.docs.length > 0 && parziale.docs.length < 80);
    assert(Buffer.byteLength(JSON.stringify(parziale.docs)) <= 220);
    assert.equal((await esegui('SELECT id FROM prova ORDER BY id', 2)).docs.length, 2);
    const enorme = await esegui("SELECT REPEAT('x', 65536) AS v");
    assert.equal(enorme.truncated, true);
    assert.equal(enorme.docs.length, 0);
    const multiplo = pg ? 'SELECT * FROM prova; SELECT id FROM prova WHERE id = 79'
      : 'CALL ultima()';
    if (!pg) await esegui('CREATE PROCEDURE ultima() BEGIN UPDATE prova SET v = CONCAT(v, v) WHERE id = 79; SELECT * FROM prova; SELECT id FROM prova WHERE id = 79; END');
    const ultimo = await esegui(multiplo);
    assert.deepEqual(ultimo.docs, [{ id: 79 }]);
    assert.equal(ultimo.truncated, false);
    if (!pg) assert.equal((await esegui('SELECT v FROM prova WHERE id = 79')).docs[0].v.length, 22);
    await assert.rejects(esegui('SELECT campo_assente FROM prova'));
    assert.equal((await esegui('SELECT 42 AS v')).docs[0].v, 42);
    console.log('OK ' + prefisso + ': lettura progressiva, scrittura singola, più result set, riuso dopo errore.');
  } finally {
    try { if (proprio) await strategia.pool.query('DROP ' + oggetto + ' ' + nome + (pg ? ' CASCADE' : '')); }
    finally { await strategia.disconnect(); }
  }
}
Promise.allSettled([verifica(true), verifica(false)]).then(esiti => {
  for (const esito of esiti) if (esito.status === 'rejected') { console.error(esito.reason); process.exitCode = 1; }
});
