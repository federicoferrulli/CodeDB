'use strict';

const assert = require('assert');
const express = require('express');
const { attachMcp } = require('../mcp/McpGateway');
const { registerGlobalExceptionHandlers, makeConnectLocks } = require('../server');

console.log('--- Test Unitari Lifecycle & Graceful Shutdown ---');

(async () => {
  try {
    // Registra gli handler di processo da server.js
    registerGlobalExceptionHandlers();
    // Test 1: attachMcp restituisce shutdownMcp e mcpSessions
    let teardownCalled = false;
    let releasedGlobalSession = false;
    const fakeDeps = {
      loadConnections: () => ({}),
      connLabel: () => 'test',
      connDbType: () => 'mongodb',
      establishConnection: async () => ({ strategy: {}, tunnel: null }),
      teardownConnection: async () => { teardownCalled = true; },
      tryAcquireGlobalSession: () => true,
      releaseGlobalSession: () => { releasedGlobalSession = true; },
      maxDbSessions: 5,
    };

    const app = express();
    const mcpControl = attachMcp(app, fakeDeps);

    assert.ok(mcpControl, 'attachMcp deve restituire un oggetto di controllo');
    assert.strictEqual(typeof mcpControl.shutdownMcp, 'function', 'shutdownMcp deve essere una funzione');
    assert.ok(mcpControl.mcpSessions instanceof Map, 'mcpSessions deve essere un istanza di Map');

    // Simula una sessione MCP fittizia con una connessione DB
    const fakeSession = {
      id: 'test-session-id',
      destroyed: false,
      lastActivity: Date.now(),
      dbSessions: new Map([['conn-1', { strategy: {} }]]),
      transport: { close: async () => {} },
    };
    mcpControl.mcpSessions.set('test-session-id', fakeSession);

    // Esegui shutdownMcp
    await mcpControl.shutdownMcp();

    assert.strictEqual(teardownCalled, true, 'teardownConnection deve essere stato chiamato per chiudere le risorse');
    assert.strictEqual(releasedGlobalSession, true, 'releaseGlobalSession deve essere stato chiamato');
    assert.strictEqual(mcpControl.mcpSessions.size, 0, 'La mappa delle sessioni MCP deve essere svuotata dopo lo shutdown');
    console.log('  OK   attachMcp e shutdownMcp superato');

    // Test 2: verifica presenza dei listener di processo per SIGINT, SIGTERM, uncaughtException e unhandledRejection
    const sigintListeners = process.listeners('SIGINT');
    const sigtermListeners = process.listeners('SIGTERM');
    const uncaughtListeners = process.listeners('uncaughtException');
    const rejectionListeners = process.listeners('unhandledRejection');

    assert.ok(sigintListeners.length > 0, 'Almeno un listener per SIGINT deve essere presente');
    assert.ok(sigtermListeners.length > 0, 'Almeno un listener per SIGTERM deve essere presente');
    assert.ok(uncaughtListeners.length > 0, 'Almeno un listener per uncaughtException deve essere presente');
    assert.ok(rejectionListeners.length > 0, 'Almeno un listener per unhandledRejection deve essere presente');

    console.log('  OK   Registrazione globale handler eccezioni e segnali superata');

    // Test 3 (CDB-08): serializzazione delle aperture di connessione per tab.
    // Due mongo:connect concorrenti sullo stesso tabId non devono mai eseguire
    // in parallelo (aprivano due strategie, di cui una orfana per sempre).
    {
      const withLock = makeConnectLocks();
      let concurrent = 0;
      let maxConcurrent = 0;
      const order = [];
      const task = (name, ms) => async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, ms));
        order.push(name);
        concurrent--;
      };

      await Promise.all([
        withLock('tab-1', task('a', 30)),
        withLock('tab-1', task('b', 1)),
      ]);
      assert.strictEqual(maxConcurrent, 1, 'due aperture sullo stesso tab non devono sovrapporsi');
      assert.deepStrictEqual(order, ['a', 'b'], 'le aperture devono rispettare l\'ordine di arrivo');

      // Tab diversi restano indipendenti: la serializzazione non deve
      // trasformarsi in un collo di bottiglia globale.
      concurrent = 0; maxConcurrent = 0;
      await Promise.all([
        withLock('tab-A', task('a', 20)),
        withLock('tab-B', task('b', 20)),
      ]);
      assert.strictEqual(maxConcurrent, 2, 'tab diversi devono poter connettersi in parallelo');

      // Un fallimento non deve bloccare la coda del tab.
      const failing = withLock('tab-2', async () => { throw new Error('boom'); });
      await assert.rejects(failing, /boom/, 'l\'errore deve arrivare al chiamante');
      let ranAfterFailure = false;
      await withLock('tab-2', async () => { ranAfterFailure = true; });
      assert.strictEqual(ranAfterFailure, true, 'la coda deve proseguire dopo un fallimento');

      // Oltre una richiesta in attesa si rifiuta invece di accodare all'infinito.
      const slow = withLock('tab-3', task('slow', 40));
      const queued = withLock('tab-3', task('queued', 1));
      await assert.rejects(
        withLock('tab-3', task('extra', 1)),
        /già in corso/,
        'la terza richiesta concorrente deve essere rifiutata con un messaggio parlante'
      );
      await Promise.all([slow, queued]);
      console.log('  OK   Serializzazione delle aperture di connessione per tab (CDB-08) superata');
    }

    console.log('\nTutti i test unitari di Lifecycle & Shutdown superati con successo!');
  } catch (err) {
    console.error('FAIL:', err);
    process.exitCode = 1;
  }
})();
