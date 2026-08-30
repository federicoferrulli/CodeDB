'use strict';

// Contratto pubblico MCP per l'upsert MongoDB:
// client ufficiale -> execute_write -> anteprima -> conferma -> strategia.

const assert = require('assert');
const http = require('http');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { attachMcp } = require('../mcp/McpGateway');

console.log('--- Test upsert MongoDB via MCP ---');

const savedConnection = { dbType: 'mongodb', readOnly: 'false' };
const updatePayloads = [];
const strategy = {
  async listDatabases() { return []; },
  async collectionFind() { return { total: 0, rows: [] }; },
  async collectionUpdateMany(_db, _coll, payload) {
    updatePayloads.push(payload);
    return { matched: 0, modified: 0, upserted: payload.upsert ? 1 : 0 };
  },
};
const deps = {
  loadConnections: () => ({ scrivibile: savedConnection }),
  connLabel: () => 'MongoDB finto',
  connDbType: () => 'mongodb',
  establishConnection: async () => ({
    strategy, tunnel: null, dbType: 'mongodb', effective: savedConnection,
  }),
  teardownConnection: async () => {},
  maxDbSessions: 1,
  tryAcquireGlobalSession: () => true,
  releaseGlobalSession: () => {},
  rbacOn: () => false,
};

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  assert.notStrictEqual(result.isError, true, `${name} non deve fallire: ${text}`);
  return JSON.parse(text);
}

module.exports = (async () => {
  const app = express();
  const control = attachMcp(app, deps);
  const server = http.createServer(app);
  let client;

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    client = new Client({ name: 'CodeDB-test-mongodb-upsert', version: '1.0.0' });
    await client.connect(transport);

    const connection = await call(client, 'connect_database', { saved: 'scrivibile' });
    const preview = await call(client, 'execute_write', {
      connection_id: connection.connection_id,
      db: 'rubrica',
      collection: 'persone',
      operation: 'update',
      filter: '{ "email": "ada@example.test" }',
      set: '{ "nome": "Ada" }',
      upsert: true,
    });

    assert.strictEqual(preview.preview.upsert, true, 'l\'anteprima deve dichiarare upsert=true');

    const executed = await call(client, 'execute_write', {
      connection_id: connection.connection_id,
      db: 'rubrica',
      confirm_token: preview.confirm_token,
    });
    assert.strictEqual(updatePayloads[0].upsert, true, 'il flag deve raggiungere la strategia MongoDB');
    assert.strictEqual(executed.result.upserted, 1, 'l\'esito deve riportare il documento creato via upsert');
    console.log('  OK   upsert visibile in anteprima e inoltrato alla strategia');

    const defaultPreview = await call(client, 'execute_write', {
      connection_id: connection.connection_id,
      db: 'rubrica',
      collection: 'persone',
      operation: 'update',
      filter: '{ "email": "lin@example.test" }',
      set: '{ "nome": "Lin" }',
    });
    assert.strictEqual(defaultPreview.preview.upsert, false, 'l\'anteprima deve dichiarare il default upsert=false');

    await call(client, 'execute_write', {
      connection_id: connection.connection_id,
      db: 'rubrica',
      confirm_token: defaultPreview.confirm_token,
    });
    assert.strictEqual(updatePayloads[1].upsert, false, 'senza flag la strategia deve ricevere upsert=false');
    console.log('  OK   senza flag l\'upsert resta disattivato');
  } finally {
    if (client) await client.close().catch(() => {});
    await control.shutdownMcp();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('  FAIL Upsert MongoDB MCP:', err.stack || err);
  process.exitCode = 1;
});
