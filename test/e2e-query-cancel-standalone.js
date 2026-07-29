'use strict';

const { fork } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const DbFactory = require('../db/DbFactory');

const PORT = 3039;
const DB = 'gui_mongodb_e2e';
const COLL = 'cancel_test';

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('--- Test Standalone Query Cancel (Server + Socket query:cancel) ---');

  // Avvia il server aggiornato su una porta dedicata (3039)
  const serverProcess = fork(path.join(__dirname, '../server.js'), [], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
  serverProcess.stderr?.on('data', (d) => console.error(`[Server Err] ${d.toString().trim()}`));

  // Attende che il server sia pronto
  await new Promise((r) => setTimeout(r, 2500));

  const socket = io(`http://127.0.0.1:${PORT}`);
  
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });

  function emit(event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
  }

  try {
    const tabId = 'cancel-tab-1';
    const conn = await emit('mongo:connect', { host: 'localhost', port: 27017, tabId });
    assert(conn.ok, 'Connessione a MongoDB riuscita');

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
    assert(!!(cancelRes && cancelRes.ok), `Risposta query:cancel ok (ricevuto: ${JSON.stringify(cancelRes)})`);

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

    console.log('\n--- Tutti i test Query Cancel superati con successo! ---');
  } catch (err) {
    console.error('Errore durante il test standalone cancel:', err);
    process.exitCode = 1;
  } finally {
    socket.close();
    serverProcess.kill('SIGTERM');
  }
}

run();
