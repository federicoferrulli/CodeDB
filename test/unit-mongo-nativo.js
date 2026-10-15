'use strict';
if (process.env.CODEDB_NATIVE_MUTANT) require('./fixtures/query-native-mutant.cjs');
const assert = require('node:assert/strict');
const { guardStrategy } = require('../auth/guardStrategy');
const { ROOT_PRINCIPAL, makePrincipal } = require('../auth/principal');
const { analizza } = require('../db/mongoComando');
const { gestore, attiva } = require('../db/mongoSessioneScript');
const { eseguiScript } = require('../db/MongoScriptRunner');
module.exports = (async () => {
  const subuser = (capabilities, scope) => makePrincipal({ _id: 'u', type: 'subuser', ownerId: 'o' },
    [{ connName: 'test', capabilities, ...(scope ? { scope } : {}) }]);
  let calls = 0;
  const strategy = { type: 'mongodb', mongoCommand: async () => { calls++; return { ok: 1 }; } };
  for (const principal of [subuser(['read']), subuser(['manage'], { databases: ['d'], collections: ['*'] })]) {
    await assert.rejects(() => guardStrategy(strategy, { principal, connName: 'test' }).mongoCommand('d', { command: '{"ping":1}' }), /Permesso negato/);
  }
  assert.equal(calls, 0);
  await guardStrategy(strategy, { principal: ROOT_PRINCIPAL, connName: 'test' }).mongoCommand('d', { command: '{"ping":1}' });
  await guardStrategy(strategy, { principal: subuser(['manage']), connName: 'test' }).mongoCommand('d', { command: '{"ping":1}' });
  assert.equal(calls, 2);
  console.log('OK comandi nativi: gestore dell’intera connessione, scope e lettore protetti');
  for (const command of [{ find: 'c', filter: { $where: 'true' } }, { aggregate: 'c', pipeline: [{ $project: { n: { $function: {} } } }] },
    { mapReduce: 'c', map: 'function(){}', reduce: 'function(){}' },
    { explain: { mapReduce: 'c', map: 'function(){}', reduce: 'function(){}' } }]) assert.throws(() => analizza(command), /non.*consentit/);
  for (const field of ['lsid', 'txnNumber', 'autocommit', 'startTransaction', '$db']) assert.throws(() => analizza({ ping: 1, [field]: 1 }), /sessione/);
  console.log('OK JavaScript remoto e identità transazionali non passano dal comando raw');

  const closed = [];
  const sessions = gestore({ startSession: () => { const s = { endSession: async () => closed.push(s) }; return s; } });
  const a = sessions.start(), b = sessions.start();
  await sessions.run(a, async () => {
    const first = attiva(); assert(first);
    await sessions.run(b, async () => { assert.notEqual(attiva(), first); });
    assert.equal(attiva(), first);
  });
  assert.equal(attiva(), undefined);
  assert.throws(() => sessions.run('token-di-un-altro-run', () => {}), /sconosciuta/);
  await sessions.close(); assert.equal(closed.length, 2);
  assert.throws(() => sessions.run(a, () => {}), /sconosciuta/);
  console.log('OK contesto delle sessioni isolato e rilascio di ogni sessione');

  let sql;
  const mysql = { type: 'mysql', collectionAggregate: async (db, coll, p) => { sql = p.pipeline; return {}; } };
  const query = 'SELECT /*!80000 2 + */ 3';
  await assert.rejects(() => guardStrategy(mysql, { principal: subuser(['read']), connName: 'test' }).collectionAggregate('d', 'c', { pipeline: query }), /commenti SQL eseguibili/);
  await guardStrategy(mysql, { principal: ROOT_PRINCIPAL, connName: 'test' }).collectionAggregate('d', 'c', { pipeline: query });
  assert.equal(sql, query);
  console.log('OK MySQL: testo nativo per il gestore, commenti eseguibili negati al lettore');

  const result = await eseguiScript('async function valore() { return 42; } await valore();', {});
  assert.deepEqual(result.docs, [{ valore: 42 }]);
  const { suggerisci } = await import('../public/js/intellisense.js');
  for (const [testo, expected] of [['db.getMongo().start', 'startSession'], ['const s=db.getMongo().startSession(); s.comm', 'commitTransaction']]) {
    assert(suggerisci({ testo, cursore: testo.length, motore: 'mongo', dbms: 'mongodb' }).some(v => v.testo === expected), expected);
  }
  console.log('OK await, funzioni async e completamento delle sessioni');
})();
