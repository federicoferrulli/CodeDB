'use strict';

// Percorso reale Query Engine → traduttori → strategia, con cursore in memoria.
const assert = require('node:assert/strict');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { payloadEsecuzione } = require('../db/payloadEsecuzione');
const righe = Array.from({ length: 100123 }, (_, _id) => ({ _id }));

function cursore() {
  let salto = 0, limite = Infinity;
  return {
    sort() { return this; },
    skip(n) { salto = n; return this; },
    limit(n) { assert(Number.isFinite(n)); limite = Math.abs(n) || Infinity; return this; },
    async *[Symbol.asyncIterator]() { yield* righe.slice(salto, salto + limite); },
  };
}

module.exports = (async () => {
  const strategy = require('../db/tetti').conTetti(new MongoDbStrategy({ env: {} }));
  strategy.client = { db: () => ({ collection: () => ({
    find: cursore,
    aggregate: cursore,
    estimatedDocumentCount: async () => righe.length,
  }) }) };
  const query = require('../server/query').createModule({
    config: { env: {} },
    connessioni: { executeWithReconnect: (session, fn) => fn(session.strategy) },
    dependencies: { DbFactory: { isSqlType: () => false } },
  });
  async function esegui(code) {
    return (await query.executeQueryCode({ strategy }, payloadEsecuzione({
      engine: 'mongodb', db: 'prova', coll: 'meteo', code,
    }))).res;
  }
  for (const code of ['SELECT * FROM meteo', 'db.meteo.find({})', 'db.meteo.find({}).limit(0)', '{}', 'meteo', '[]']) {
    const res = await esegui(code);
    assert.equal(res.docs.length, righe.length, code);
    assert(!res.truncated, code);
  }
  assert.equal((await esegui('SELECT * FROM meteo LIMIT 73 OFFSET 10')).docs[0]._id, 10);
  assert.equal((await esegui('SELECT * FROM meteo LIMIT 73')).docs.length, 73);
  assert.equal((await esegui('SELECT * FROM meteo LIMIT 0')).docs.length, 0);
  assert.equal((await esegui('db.meteo.find({}).limit(73)')).docs.length, 73);
  assert.equal((await esegui('db.meteo.find({}).limit(-1)')).docs.length, 1);
  assert.equal((await esegui('db.meteo.find({}).limit(-73)')).docs.length, 73);
  assert.equal((await strategy.collectionFind('prova', 'meteo', {})).docs.length, 50);
  assert.equal((await strategy.collectionFind('prova', 'meteo', { limit: 1000 })).docs.length, 500);
  strategy.env = { CODEDB_MAX_RESULT_BYTES: '100' };
  await assert.rejects(esegui('SELECT * FROM meteo'), /Risultato incompleto.*memoria/);
  console.log('OK: query senza limiti impliciti, LIMIT/OFFSET espliciti e griglia paginata.');
})().catch(err => { process.exitCode = 1; console.error(err); });
