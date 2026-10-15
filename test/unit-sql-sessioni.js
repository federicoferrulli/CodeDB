'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getStrategy } = require('../db/DbFactory');
const { conSessioneSql } = require('../db/sqlSessione');
const connessioni = require('../server/connessioni').createModule({});

module.exports = (async () => {
  for (const type of ['postgresql', 'mysql']) {
    const strategy = getStrategy(type, { env: { CODEDB_AGGREGATE_TIMEOUT_MS: '0' } });
    let occupate = 0, rilasci = 0, eseguite = 0;
    const clients = [];
    const apri = async () => {
      occupate++;
      const conn = new EventEmitter();
      const release = () => { occupate--; rilasci++; };
      Object.assign(conn, { release, destroy: release, async query(input) {
        const sql = typeof input === 'string' ? input : input.text || input.sql;
        if (sql === 'SELECT 1') eseguite++;
        return type === 'postgresql' ? { rows: [], fields: [] } : [[], []];
      } });
      clients.push(conn); return conn;
    };
    strategy.pool = { connect: apri, getConnection: apri, async end() { assert.equal(occupate, 0, 'La chiusura deve rilasciare anche le sessioni aperte attraverso conTetti'); } };
    const scope = {};
    const q = persistente => conSessioneSql(scope, () => strategy.collectionAggregate('public', null, { pipeline: 'SELECT 1' }), persistente);
    await q(true);
    assert.equal(occupate, 1);
    const conn = clients[0];
    assert.equal(conn.listenerCount('error'), 1);
    conn.emit('error', Object.assign(new Error('Connessione interrotta'), { code: '57P01' }));
    await assert.rejects(() => q(true), err => connessioni.isConnectionError(err));
    assert.equal(eseguite, 1, 'Non inviare altre query al client guasto');
    await strategy.disconnect();
    assert.equal(occupate, 0); assert.equal(rilasci, 1);
    assert.equal(conn.listenerCount('error'), 0, 'Il listener appartiene solo al lease corrente');
  }
  for (const code of ['08000', '08006', '57P01', '57P02', '57P03']) assert(connessioni.isConnectionError({ code }));
  for (const code of ['23505', '40001', '57014']) assert(!connessioni.isConnectionError({ code }), 'Gli errori SQL ordinari non devono ricreare la sessione');
  console.log('OK sessioni SQL: identità attraverso i proxy, client guasto, nessun replay, rilascio unico e listener rimossi');
})();
module.exports.catch(err => { console.error(err); process.exitCode = 1; });
