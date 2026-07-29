'use strict';

// Verifica del gate di autenticazione del gateway MCP: con RBAC attivo
// l'endpoint /mcp deve rispondere 401 senza una API key valida, e restare
// aperto come prima quando l'RBAC è spento.
//
// Monta il gateway su un'app Express reale e la interroga via HTTP: non
// richiede alcun database. Gira in un processo dedicato (non dentro
// test/unit.js) perché apre una porta di ascolto.
// Uso: node test/unit-mcp-auth.js

const assert = require('assert');
const http = require('http');
const express = require('express');

const { makePrincipal } = require('../auth/principal');
const { allowedConnections } = require('../auth/permissions');
const { attachMcp, MCP_PATH } = require('../mcp/McpGateway');

console.log('--- Test Gate Autenticazione MCP ---');

const owner = makePrincipal({ _id: 'o1', type: 'owner', ownerId: 'o1', email: 'o@x.it' }, []);

const deps = {
  loadConnections: () => ({}),
  connLabel: () => '',
  connDbType: () => 'mongodb',
  setConnectionReadOnly: () => {},
  establishConnection: async () => { throw new Error('non usato in questo test'); },
  teardownConnection: async () => {},
  maxDbSessions: 1,
  tryAcquireGlobalSession: () => true,
  releaseGlobalSession: () => {},
  allowedConnections,
  rbacOn: () => true,
  resolveApiKey: async (key) => (key === 'cdb_valida' ? owner : null),
};

(async () => {
  const app = express();
  const control = attachMcp(app, deps);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const initBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'unit', version: '1' } },
  });

  const post = (headers) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: MCP_PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(initBody),
        ...headers,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(initBody);
  });

  try {
    assert.strictEqual((await post({})).status, 401, 'MCP senza API key → 401');
    assert.strictEqual((await post({ Authorization: 'Bearer cdb_sbagliata' })).status, 401, 'API key non valida → 401');
    assert.notStrictEqual((await post({ Authorization: 'Bearer cdb_valida' })).status, 401, 'API key valida accettata');
    console.log('  OK   /mcp protetto dalla API key con RBAC attivo');

    // Con RBAC spento l'endpoint resta accessibile come prima.
    deps.rbacOn = () => false;
    assert.notStrictEqual((await post({})).status, 401, 'con RBAC spento /mcp non richiede API key');
    console.log('  OK   /mcp invariato con RBAC spento');

    console.log('\nTest del gate MCP superati!');
  } catch (err) {
    console.error('  FAIL', err && err.message);
    process.exitCode = 1;
  } finally {
    await control.shutdownMcp();
    await new Promise((r) => server.close(r));
  }
})();
