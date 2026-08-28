'use strict';

// Verifica il limite HTTP del gateway sul seam pubblico: client MCP ufficiale
// -> POST /mcp -> import_database_artifact -> anteprima con confirm_token.
// La strategia e' finta perche' il primo passo valida soltanto l'artefatto e
// non deve ancora toccare il database.

const assert = require('assert');
const http = require('http');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { attachMcp } = require('../mcp/McpGateway');

console.log('--- Test payload MCP di grandi dimensioni ---');

const MIB = 1024 * 1024;
const artifactJson = JSON.stringify({
  formato: 'codedb-database',
  versione: 1,
  dbType: 'mongodb',
  db: 'origine',
  collections: [{
    name: 'documenti',
    indexes: [],
    docs: [{ _id: 'documento-grande', contenuto: 'x'.repeat(10 * MIB) }],
  }],
});

const artifactBytes = Buffer.byteLength(artifactJson, 'utf8');
assert(
  artifactBytes >= 10 * MIB && artifactBytes < 11 * MIB,
  `la fixture deve misurare circa 10 MiB, non ${artifactBytes} byte`,
);

const savedConnection = { dbType: 'mongodb', readOnly: 'false' };
const strategy = {
  async listDatabases() { return []; },
};
const deps = {
  loadConnections: () => ({ grande: savedConnection }),
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

module.exports = (async () => {
  const app = express();
  const control = attachMcp(app, deps);
  const server = http.createServer(app);
  let client;

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    client = new Client({ name: 'CodeDB-test-payload', version: '1.0.0' });
    await client.connect(transport);

    const connected = await client.callTool({ name: 'connect_database', arguments: { saved: 'grande' } });
    assert.notStrictEqual(connected.isError, true, 'la connessione finta deve aprirsi');
    const connection = JSON.parse(connected.content[0].text);

    const previewResult = await client.callTool({
      name: 'import_database_artifact',
      arguments: {
        connection_id: connection.connection_id,
        artifact_json: artifactJson,
        target_db: 'destinazione',
      },
    });
    assert.notStrictEqual(
      previewResult.isError,
      true,
      `il payload da ${artifactBytes} byte deve raggiungere la preview: ${previewResult.content[0].text}`,
    );
    const preview = JSON.parse(previewResult.content[0].text);
    assert.strictEqual(preview.requires_confirmation, true, 'l\'import deve richiedere conferma');
    assert.match(preview.confirm_token, /^[0-9a-f-]{36}$/i, 'la preview deve generare un confirm_token');
    console.log(`  OK   artefatto da ${artifactBytes} byte -> preview con confirm_token`);
  } finally {
    if (client) await client.close().catch(() => {});
    await control.shutdownMcp();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('  FAIL Payload MCP:', err.stack || err);
  process.exitCode = 1;
});
