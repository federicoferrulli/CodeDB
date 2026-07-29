'use strict';

const assert = require('assert');
const express = require('express');
const { attachMcp } = require('../mcp/McpGateway');
const { registerGlobalExceptionHandlers } = require('../server');

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

    console.log('\nTutti i test unitari di Lifecycle & Shutdown superati con successo!');
  } catch (err) {
    console.error('FAIL:', err);
    process.exitCode = 1;
  }
})();
