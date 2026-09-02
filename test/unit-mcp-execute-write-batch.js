'use strict';

// Contratto pubblico MCP per le scritture in blocco:
// client ufficiale -> execute_write -> anteprima unica -> conferma -> strategia/audit.

const assert = require('assert');
const http = require('http');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { attachMcp } = require('../mcp/McpGateway');

console.log('--- Test batch di execute_write via MCP ---');

const savedConnections = {
  sql: { dbType: 'mysql', readOnly: 'false' },
  mongo: { dbType: 'mongodb', readOnly: 'false' },
};
const batchEseguiti = [];
const mongoEseguite = [];
const auditEntries = [];
const sqlStrategy = {
  type: 'mysql',
  async listDatabases() { return ['app']; },
  async executeWriteBatch(db, operations) {
    batchEseguiti.push({ db, operations });
    return {
      transactional: true,
      operationCount: operations.length,
      results: operations.map((_sql, index) => ({ index, righeCoinvolte: index + 1 })),
    };
  },
};
const mongoStrategy = {
  type: 'mongodb',
  async listDatabases() { return ['app']; },
  async docInsert(db, collection, payload) {
    mongoEseguite.push({ db, collection, operation: 'insert', payload });
    return { inserted: 1 };
  },
  async collectionUpdateMany(db, collection, payload) {
    mongoEseguite.push({ db, collection, operation: 'update', payload });
    return { matched: 1, modified: 1 };
  },
  async collectionDeleteMany(db, collection, payload) {
    mongoEseguite.push({ db, collection, operation: 'delete', payload });
    if (collection === 'fallisce') throw new Error('Errore MongoDB simulato');
    return { deleted: 1 };
  },
};
const deps = {
  loadConnections: () => savedConnections,
  connLabel: (saved) => saved,
  connDbType: (saved) => saved.dbType,
  establishConnection: async ({ saved }) => {
    const effective = savedConnections[saved];
    return {
      strategy: saved === 'mongo' ? mongoStrategy : sqlStrategy,
      tunnel: null,
      dbType: effective.dbType,
      effective,
    };
  },
  teardownConnection: async () => {},
  maxDbSessions: 2,
  tryAcquireGlobalSession: () => true,
  releaseGlobalSession: () => {},
  rbacOn: () => false,
  audit: (entry) => { auditEntries.push(entry); },
};

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  return { ok: result.isError !== true, text, data: result.isError ? null : JSON.parse(text) };
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
    client = new Client({ name: 'CodeDB-test-execute-write-batch', version: '1.0.0' });
    await client.connect(transport);

    const connection = await call(client, 'connect_database', { saved: 'sql' });
    assert(connection.ok, `la connessione deve aprirsi (${connection.text})`);

    const operations = [
      { sql: 'INSERT INTO persone (nome) VALUES (\'Ada\')' },
      { sql: 'UPDATE persone SET attivo = 1 WHERE nome = \'Ada\'' },
    ];
    const preview = await call(client, 'execute_write', {
      connection_id: connection.data.connection_id,
      db: 'app',
      operations,
    });
    assert(preview.ok, `il batch SQL valido deve produrre una preview (${preview.text})`);
    assert(preview.data.requires_confirmation && preview.data.confirm_token,
      'l\'intero batch deve avere un solo token di conferma');
    assert.deepStrictEqual(preview.data.preview, {
      dbType: 'mysql', db: 'app', operation: 'batch', transactional: true, operationCount: 2,
      operations: operations.map(({ sql }) => ({ dbType: 'mysql', db: 'app', sql })),
    });
    assert.strictEqual(batchEseguiti.length, 0, 'la preview non deve eseguire alcuna mutazione');

    const executed = await call(client, 'execute_write', {
      connection_id: connection.data.connection_id,
      db: 'app',
      confirm_token: preview.data.confirm_token,
    });
    assert(executed.ok && executed.data.executed, `la conferma deve eseguire il batch (${executed.text})`);
    assert.deepStrictEqual(batchEseguiti, [{
      db: 'app',
      operations: operations.map(({ sql }) => sql),
    }]);
    assert.strictEqual(executed.data.result.transactional, true,
      'l\'esito SQL deve dichiarare la transazione unica');

    const auditBatch = auditEntries.filter((entry) => entry.operation === 'batch');
    assert.deepStrictEqual(auditBatch.map((entry) => entry.event), ['requested', 'executed']);
    assert(auditBatch.every((entry) => entry.operationCount === 2 && entry.operations.length === 2),
      'audit richiesta ed esecuzione devono descrivere l\'intero blocco');
    console.log('  OK   SQL: anteprima, token, esecuzione e audit descrivono un solo batch');

    const empty = await call(client, 'execute_write', {
      connection_id: connection.data.connection_id, db: 'app', operations: [],
    });
    assert(!empty.ok, 'un batch vuoto deve essere rifiutato dallo schema pubblico');

    const mixed = await call(client, 'execute_write', {
      connection_id: connection.data.connection_id,
      db: 'app',
      operations: [
        { sql: 'INSERT INTO persone (nome) VALUES (\'Lin\')' },
        { collection: 'persone', operation: 'insert', doc: '{ "nome": "Lin" }' },
      ],
    });
    // La regex non deve accontentarsi della parola "SQL": quasi ogni errore di
    // questo tool la contiene, quindi passerebbe anche per la ragione
    // sbagliata. Si pretende il messaggio che parla davvero di batch MISTO.
    assert(!mixed.ok && /batch misto/i.test(mixed.text),
      `formati SQL/MongoDB mescolati devono essere rifiutati come batch misto (${mixed.text})`);

    // Un drop dentro un batch SQL: prima passava la validazione, compariva
    // nell'anteprima e la sua esecuzione veniva poi BUTTATA VIA dal ramo SQL,
    // che manda alla strategia solo `summary.sql`. Deve essere rifiutato al
    // primo passo, prima che un umano firmi un'anteprima che mente.
    const dropInBatch = await call(client, 'execute_write', {
      connection_id: connection.data.connection_id,
      db: 'app',
      operations: [
        { sql: 'DELETE FROM persone WHERE nome = \'Ada\'' },
        { collection: 'persone', operation: 'drop_collection' },
      ],
    });
    assert(!dropInBatch.ok && /solo statement "sql"|drop_collection/i.test(dropInBatch.text),
      `un drop non puo' far parte di un batch SQL (${dropInBatch.text})`);
    assert(!/requires_confirmation/.test(dropInBatch.text),
      'il rifiuto deve arrivare PRIMA di emettere un token di conferma');

    const singularAndBatch = await call(client, 'execute_write', {
      connection_id: connection.data.connection_id,
      db: 'app',
      sql: 'INSERT INTO persone (nome) VALUES (\'Grace\')',
      operations: [{ sql: 'INSERT INTO persone (nome) VALUES (\'Ada\')' }],
    });
    assert(!singularAndBatch.ok && /non mescolare/i.test(singularAndBatch.text),
      `forma singola e batch devono essere alternative (${singularAndBatch.text})`);
    console.log('  OK   formati vuoti, misti o incompatibili vengono rifiutati');

    const mongoConnection = await call(client, 'connect_database', { saved: 'mongo' });
    assert(mongoConnection.ok, `la connessione MongoDB deve aprirsi (${mongoConnection.text})`);
    const mongoOperations = [
      { collection: 'persone', operation: 'insert', doc: '{ "nome": "Ada" }' },
      { collection: 'persone', operation: 'update', filter: '{ "nome": "Ada" }', set: '{ "attivo": true }', upsert: true },
      { collection: 'obsolete', operation: 'delete', filter: '{ "archiviato": true }' },
    ];
    const mongoPreview = await call(client, 'execute_write', {
      connection_id: mongoConnection.data.connection_id,
      db: 'app',
      operations: mongoOperations,
    });
    assert(mongoPreview.ok && mongoPreview.data.preview.operationCount === 3,
      `tutte le mutazioni MongoDB devono comparire in anteprima (${mongoPreview.text})`);
    // L'assenza di atomicita' va dichiarata PRIMA della firma, non solo nel
    // risultato: chi conferma deve sapere che un errore a meta' lascia
    // applicate le mutazioni gia' eseguite.
    assert.strictEqual(mongoPreview.data.preview.transactional, false,
      'l\'anteprima MongoDB deve dichiarare che il blocco non e transazionale');
    assert(/atomicit/i.test(JSON.stringify(mongoPreview.data.preview)),
      'l\'anteprima deve spiegare che cosa comporta l\'assenza di rollback');
    assert.strictEqual(mongoEseguite.length, 0, 'MongoDB non deve mutare durante la preview');

    const mongoExecuted = await call(client, 'execute_write', {
      connection_id: mongoConnection.data.connection_id,
      db: 'app',
      confirm_token: mongoPreview.data.confirm_token,
    });
    assert(mongoExecuted.ok, `il batch MongoDB deve essere eseguito (${mongoExecuted.text})`);
    assert.deepStrictEqual(mongoEseguite.map((entry) => entry.operation), ['insert', 'update', 'delete'],
      'MongoDB deve rispettare l\'ordine dei descrittori');
    assert.strictEqual(mongoExecuted.data.result.transactional, false,
      'l\'esito deve dichiarare che il batch MongoDB sequenziale non e transazionale');
    assert.strictEqual(mongoExecuted.data.result.completed, 3);
    console.log('  OK   MongoDB applica sequenzialmente tutte le mutazioni dopo la conferma');

    const failingPreview = await call(client, 'execute_write', {
      connection_id: mongoConnection.data.connection_id,
      db: 'app',
      operations: [
        { collection: 'prima', operation: 'insert', doc: '{ "n": 1 }' },
        { collection: 'fallisce', operation: 'delete', filter: '{ "n": 2 }' },
        { collection: 'mai_eseguita', operation: 'insert', doc: '{ "n": 3 }' },
      ],
    });
    const beforeFailure = mongoEseguite.length;
    const failingExecution = await call(client, 'execute_write', {
      connection_id: mongoConnection.data.connection_id,
      db: 'app',
      confirm_token: failingPreview.data.confirm_token,
    });
    assert(!failingExecution.ok && /Errore MongoDB simulato/.test(failingExecution.text),
      'l\'errore della mutazione deve risalire al client');
    // Che cosa resta applicato finiva SOLO nell'audit, che il chiamante non
    // legge: senza questo, chi ha confermato tre mutazioni e ne vede fallire
    // la seconda non sa che la prima e' gia' scritta, e ripetere duplica.
    assert(/1 operazioni su 3/.test(failingExecution.text)
      && /NON sono state annullate/.test(failingExecution.text),
      `il client deve sapere che cosa resta applicato (${failingExecution.text})`);
    assert(/posizione 2/.test(failingExecution.text),
      `il client deve sapere da dove riprendere (${failingExecution.text})`);
    assert.deepStrictEqual(
      mongoEseguite.slice(beforeFailure).map((entry) => entry.collection),
      ['prima', 'fallisce'],
      'dopo il primo errore le operazioni successive non devono partire',
    );
    const failedAudit = auditEntries.filter((entry) =>
      entry.operation === 'batch' && entry.event === 'failed').at(-1);
    assert(failedAudit && failedAudit.result.completed === 1 && failedAudit.result.failedIndex === 1,
      'l\'audit del blocco fallito deve registrare avanzamento e indice del guasto');
    console.log('  OK   un errore MongoDB arresta il blocco ed e tracciato nell\'audit');
  } finally {
    if (client) await client.close().catch(() => {});
    await control.shutdownMcp();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('  FAIL batch execute_write MCP:', err.stack || err);
  process.exitCode = 1;
});
