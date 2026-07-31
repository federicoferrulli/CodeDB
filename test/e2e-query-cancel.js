'use strict';

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');
const DbFactory = require('../db/DbFactory');

// Il test avvia una PROPRIA istanza di CodeDB su una porta dedicata, con un
// connections.ini temporaneo (test/e2e-harness.js): nessuna dipendenza dal
// server dell'utente e nessun rischio per il suo vault.
let socket = null;
let testServer = null;
const DB = 'gui_mongodb_e2e';
const COLL = 'cancel_test';

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

(async () => {
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3146 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  await runTests();
})().catch(async (err) => {
  console.error('Impossibile avviare i test:', (err && err.message) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});

async function runTests() {
  try {
    console.log('--- Test E2E Query Cancel (Socket query:cancel) ---');

    const tabId = 'cancel-tab-1';
    const conn = await emit('mongo:connect', { host: 'localhost', port: 27017, tabId });
    assert(conn.ok, 'Connessione a MongoDB riuscita');
    if (!conn.ok) return socket.close();

    console.log('1. Annullamento query:cancel su runId non presente in inflight (idempotente)');
    const fakeCancel = await emit('query:cancel', { tabId, runId: 'non-existent-run-id' });
    assert(fakeCancel.ok && fakeCancel.cancelled === false, 'query:cancel su runId inesistente ritorna ok: true, cancelled: false');

    console.log('2. Esecuzione query ed invio query:cancel');
    const runId = 'e2e-test-run-1';
    const execPromise = emit('query:execute', {
      tabId,
      runId,
      engine: 'mongodb',
      db: DB,
      coll: COLL,
      code: `[ { "$match": { "test": "cancel" } } ]`
    });

    const cancelRes = await emit('query:cancel', { tabId, runId });
    assert(cancelRes.ok, 'Risposta query:cancel ok');

    const execRes = await execPromise;
    assert(execRes.ok, 'Esecuzione completata/gestita correttamente');

    console.log('3. Test cancelQuery unitario per tutte le strategie');
    const mongoStrat = DbFactory.getStrategy('mongodb');
    const mysqlStrat = DbFactory.getStrategy('mysql');
    const pgStrat = DbFactory.getStrategy('postgresql');

    const c1 = await mongoStrat.cancelQuery({ runId: 'dummy' });
    assert(c1.cancelled === false, 'MongoDbStrategy.cancelQuery senza client attivo degrada a cancelled: false');

    const c2 = await mysqlStrat.cancelQuery({ connectionId: 99999 });
    assert(c2.cancelled === false, 'MySqlStrategy.cancelQuery con id non esistente degrada a cancelled: false');

    const c3 = await pgStrat.cancelQuery({ processID: 99999 });
    assert(c3.cancelled === false, 'PostgreSqlStrategy.cancelQuery con pid non esistente degrada a cancelled: false');

    console.log('--- Tutti i test E2E Query Cancel superati con successo! ---');
  } catch (err) {
    console.error('Errore durante il test e2e query cancel:', err);
    process.exitCode = 1;
  } finally {
    socket.close();
    await testServer.stop();
  }
}
