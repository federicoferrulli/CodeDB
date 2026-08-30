'use strict';

// Contratto pubblico MCP per le operazioni di schema:
// client ufficiale -> execute_ddl -> anteprima -> conferma -> strategia/audit.

const assert = require('assert');
const http = require('http');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { guardStrategy } = require('../auth/guardStrategy');
const { attachMcp } = require('../mcp/McpGateway');

console.log('--- Test execute_ddl via MCP ---');

const savedConnections = {
  sql: { dbType: 'mysql', readOnly: 'false' },
  mongo: { dbType: 'mongodb', readOnly: 'false' },
};
const sqlEseguiti = [];
const auditEntries = [];
const sqlStrategy = {
  type: 'mysql',
  async listDatabases() { return ['app']; },
  async collectionAggregate(db, _coll, payload) {
    sqlEseguiti.push({ db, sql: payload.pipeline });
    if (/fallisce/i.test(payload.pipeline)) throw new Error('Errore DDL simulato');
    return { comando: 'DDL', righeCoinvolte: 0 };
  },
};
const mongoStrategy = {
  type: 'mongodb',
  async listDatabases() { return ['app']; },
};

function principal(id, capabilities, { read = true } = {}) {
  return {
    id, type: 'subuser', ownerId: 'tenant-test', root: false, owner: false,
    grants: [
      { connName: 'sql', capabilities: [...(read ? ['read'] : []), ...capabilities], scope: null },
      { connName: 'mongo', capabilities: [...(read ? ['read'] : []), ...capabilities], scope: null },
    ],
    connScope: null,
  };
}

const principals = {
  cdb_ddl: principal('ddl', ['ddl']),
  cdb_manage: principal('manage', ['manage']),
  cdb_write: principal('write', ['write']),
};

const deps = {
  loadConnections: () => savedConnections,
  connLabel: () => 'Strategia finta',
  connDbType: (saved) => saved.dbType,
  establishConnection: async ({ saved }, guardCtx) => {
    const effective = savedConnections[saved];
    const raw = saved === 'mongo' ? mongoStrategy : sqlStrategy;
    return {
      strategy: guardStrategy(raw, guardCtx), tunnel: null,
      dbType: effective.dbType, effective,
    };
  },
  teardownConnection: async () => {},
  maxDbSessions: 4,
  tryAcquireGlobalSession: () => true,
  releaseGlobalSession: () => {},
  rbacOn: () => true,
  resolveApiKey: async (key) => principals[key] || null,
  audit: (entry) => { auditEntries.push(entry); },
};

async function nuovoClient(baseUrl, apiKey) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: `CodeDB-test-ddl-${apiKey}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  return { ok: result.isError !== true, text, data: result.isError ? null : JSON.parse(text) };
}

module.exports = (async () => {
  const app = express();
  const control = attachMcp(app, deps);
  const server = http.createServer(app);
  const clients = [];

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const ddlClient = await nuovoClient(baseUrl, 'cdb_ddl');
    clients.push(ddlClient);
    const tools = await ddlClient.listTools();
    assert(tools.tools.some((tool) => tool.name === 'execute_ddl'), 'execute_ddl deve essere registrato');

    const sqlConn = await call(ddlClient, 'connect_database', { saved: 'sql' });
    assert(sqlConn.ok, `connessione SQL aperta (${sqlConn.text})`);
    const connectionId = sqlConn.data.connection_id;

    const dml = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', sql: 'UPDATE persone SET attivo = 1',
    });
    assert(!dml.ok && /solo.*DDL|DDL/i.test(dml.text), `il DML deve essere rifiutato (${dml.text})`);

    const multipla = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', sql: 'CREATE TABLE a (id INT); DROP TABLE a',
    });
    assert(!multipla.ok && /un solo statement/i.test(multipla.text), `la DDL multipla deve essere rifiutata (${multipla.text})`);

    for (const amministrativo of [
      'CREATE USER agente IDENTIFIED BY \'segreto\'',
      'ALTER SYSTEM SET max_connections = 500',
      'DROP ROLE agente',
    ]) {
      const refused = await call(ddlClient, 'execute_ddl', {
        connection_id: connectionId, db: 'app', sql: amministrativo,
      });
      assert(!refused.ok && /DDL|schema|struttur/i.test(refused.text),
        `il comando amministrativo non e' DDL di schema: ${amministrativo}`);
    }

    const preview = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', sql: 'CREATE TABLE persone (id INT PRIMARY KEY)',
    });
    assert(preview.ok && preview.data.requires_confirmation && preview.data.confirm_token,
      `la DDL valida deve produrre anteprima e token (${preview.text})`);
    assert.strictEqual(sqlEseguiti.length, 0, 'la preview non deve eseguire la DDL');
    assert.deepStrictEqual(preview.data.preview, {
      dbType: 'mysql', db: 'app', operation: 'ddl',
      sql: 'CREATE TABLE persone (id INT PRIMARY KEY)',
    });

    const crossTool = await call(ddlClient, 'execute_write', {
      connection_id: connectionId, db: 'app', confirm_token: preview.data.confirm_token,
    });
    assert(!crossTool.ok && /confirm_token/i.test(crossTool.text), 'il token DDL non deve valere per execute_write');

    // La connessione e' stata aperta con read, ma una revoca a caldo lascia
    // solo ddl prima della conferma: l'esecuzione strutturale deve restare
    // autorizzata dalla capability dichiarata dal tool.
    principals.cdb_ddl = principal('ddl', ['ddl'], { read: false });
    const executed = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', confirm_token: preview.data.confirm_token,
    });
    principals.cdb_ddl = principal('ddl', ['ddl']);
    assert(executed.ok && executed.data.executed, `la conferma deve eseguire la DDL (${executed.text})`);
    assert.deepStrictEqual(sqlEseguiti[0], {
      db: 'app', sql: 'CREATE TABLE persone (id INT PRIMARY KEY)',
    });

    const reuse = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', confirm_token: preview.data.confirm_token,
    });
    assert(!reuse.ok && /confirm_token/i.test(reuse.text), 'il token DDL deve essere monouso');

    const ddlConLiteral = 'COMMENT ON TABLE `persone` IS \'Anagrafica persone\'';
    const literalPreview = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', sql: ddlConLiteral,
    });
    assert(literalPreview.ok, `la DDL con identificatori e literal deve essere valida (${literalPreview.text})`);
    await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', confirm_token: literalPreview.data.confirm_token,
    });
    assert.strictEqual(sqlEseguiti[1].sql, ddlConLiteral,
      'la strategia deve ricevere esattamente il SQL mostrato in anteprima');

    const ddlTrigger = [
      'CREATE TRIGGER aggiorna_totale BEFORE UPDATE ON persone',
      'FOR EACH ROW SET NEW.nome = NEW.nome',
    ].join(' ');
    const triggerPreview = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', sql: ddlTrigger,
    });
    assert(triggerPreview.ok, `CREATE TRIGGER resta un DDL anche se contiene UPDATE (${triggerPreview.text})`);
    const triggerExecution = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', confirm_token: triggerPreview.data.confirm_token,
    });
    assert(triggerExecution.ok, `CREATE TRIGGER deve raggiungere la strategia (${triggerExecution.text})`);
    assert.strictEqual(sqlEseguiti[2].sql, ddlTrigger, 'il corpo del trigger deve restare intatto');

    const databasePreview = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', sql: 'CREATE DATABASE archivio',
    });
    assert(databasePreview.ok, `CREATE DATABASE deve essere ammesso (${databasePreview.text})`);
    const databaseExecution = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', confirm_token: databasePreview.data.confirm_token,
    });
    assert(databaseExecution.ok, `CREATE DATABASE deve raggiungere la strategia (${databaseExecution.text})`);
    assert.strictEqual(sqlEseguiti[3].sql, 'CREATE DATABASE archivio');

    const failedPreview = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', sql: 'DROP TABLE fallisce',
    });
    const failedExecution = await call(ddlClient, 'execute_ddl', {
      connection_id: connectionId, db: 'app', confirm_token: failedPreview.data.confirm_token,
    });
    assert(!failedExecution.ok && /Errore DDL simulato/i.test(failedExecution.text),
      'un errore della strategia deve risalire al client');

    const ddlAudit = auditEntries.filter((entry) => entry.tool === 'execute_ddl');
    assert.deepStrictEqual(
      ddlAudit.map((entry) => entry.event),
      [
        'requested', 'executed',
        'requested', 'executed',
        'requested', 'executed',
        'requested', 'executed',
        'requested', 'failed',
      ],
    );
    assert(ddlAudit.every((entry) => entry.category === 'write' && entry.destructive === true),
      'preview ed esecuzione DDL devono essere marcate come eventi distruttivi');
    console.log('  OK   DDL: validazione, anteprima, token monouso, esecuzione e audit');

    const mongoConn = await call(ddlClient, 'connect_database', { saved: 'mongo' });
    const mongoDdl = await call(ddlClient, 'execute_ddl', {
      connection_id: mongoConn.data.connection_id, db: 'app', sql: 'CREATE TABLE x (id INT)',
    });
    assert(!mongoDdl.ok && /MySQL|PostgreSQL|relazional/i.test(mongoDdl.text),
      `MongoDB deve essere rifiutato (${mongoDdl.text})`);

    const manageClient = await nuovoClient(baseUrl, 'cdb_manage');
    clients.push(manageClient);
    const manageConn = await call(manageClient, 'connect_database', { saved: 'sql' });
    const managePreview = await call(manageClient, 'execute_ddl', {
      connection_id: manageConn.data.connection_id, db: 'app', sql: 'ALTER TABLE persone ADD nome VARCHAR(100)',
    });
    assert(managePreview.ok, `la capability manage deve autorizzare la preview (${managePreview.text})`);
    const manageExecuted = await call(manageClient, 'execute_ddl', {
      connection_id: manageConn.data.connection_id, db: 'app', confirm_token: managePreview.data.confirm_token,
    });
    assert(manageExecuted.ok, `la capability manage deve autorizzare l'esecuzione (${manageExecuted.text})`);

    const writeClient = await nuovoClient(baseUrl, 'cdb_write');
    clients.push(writeClient);
    const writeConn = await call(writeClient, 'connect_database', { saved: 'sql' });
    const denied = await call(writeClient, 'execute_ddl', {
      connection_id: writeConn.data.connection_id, db: 'app', sql: 'DROP TABLE persone',
    });
    assert(!denied.ok && /permesso negato/i.test(denied.text),
      `la sola capability write non deve ricevere un token (${denied.text})`);
    console.log('  OK   RBAC: ddl/manage consentite, write negata; MongoDB escluso');
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await control.shutdownMcp();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('  FAIL execute_ddl MCP:', err.stack || err);
  process.exitCode = 1;
});
