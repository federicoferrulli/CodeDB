'use strict';

const assert = require('assert');
const { registraEventi } = require('../server');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { createImportOperationRegistry } = require('../db/importOperations');
const { createImportUploadRegistry } = require('../db/importUploads');

module.exports = (async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createImportOperationRegistry({
    id: () => 'import-op-finta',
    execute: async (_plan, { onProgress }) => {
      onProgress({ phase: 'applicazione', status: 'in_corso' });
      await gate;
      return { status: 'completato', recovery: { id: 'recupero-finto' } };
    },
  });
  let disconnects = 0;
  const sess = sessioneFinta({
    tabId: 'tab-a', connName: 'locale', dbType: 'mongodb',
    strategy: { type: 'mongodb', async disconnect() { disconnects++; } },
  });
  const ctx = contestoFinto({ sessioni: [['tab-a', sess]] });
  ctx.importRegistry = registry;
  ctx.importUploads = createImportUploadRegistry({ id: () => 'upload-finto' });
  ctx.createImportAdapter = () => ({});
  registraEventi(ctx);

  const artifact = {
      formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
      collections: [{ name: 'clienti', indexes: [], docs: [{ _id: 1 }] }],
  };
  const openedUpload = await ctx.socket.chiama('database:import:upload:start', { tabId: 'tab-a' });
  assert.strictEqual(openedUpload.ok, true);
  await ctx.socket.chiama('database:import:upload:chunk', {
    tabId: 'tab-a', uploadId: openedUpload.uploadId, index: 0, chunk: JSON.stringify(artifact),
  });
  const finishedUpload = await ctx.socket.chiama('database:import:upload:finish', {
    tabId: 'tab-a', uploadId: openedUpload.uploadId,
  });
  assert.strictEqual(finishedUpload.artifact.collections[0].rows, 1);
  const request = {
    tabId: 'tab-a', targetDb: 'destinazione', drop: true, uploadId: openedUpload.uploadId,
  };
  const preview = await ctx.socket.chiama('database:import:start', { ...request, previewOnly: true });
  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.preview, true);
  const withoutConfirmation = await ctx.socket.chiama('database:import:start', request);
  assert.strictEqual(withoutConfirmation.ok, false, 'senza impronta confermata il piano non parte');
  const response = await ctx.socket.chiama('database:import:start', {
    ...request, expectedFingerprint: preview.plan.fingerprint,
  });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.accepted.operationId, 'import-op-finta');
  assert.strictEqual(response.accepted.status, 'in_corso', 'l’evento risponde prima della fine');
  assert.strictEqual(response.plan.connection, 'locale', 'connessione congelata nel piano');
  assert.strictEqual(response.plan.targetDb, 'destinazione', 'destinazione congelata nel piano');

  await ctx.socket.chiama('mongo:disconnect', { tabId: 'tab-a' });
  assert.strictEqual(disconnects, 0, 'chiudere il tab non spegne la sessione posseduta dall’operazione');

  const reopened = contestoFinto();
  reopened.importRegistry = registry;
  reopened.createImportAdapter = () => ({});
  registraEventi(reopened);
  const running = await reopened.socket.chiama('database:import:state', { operationId: 'import-op-finta' });
  assert.strictEqual(running.operation.status, 'in_corso', 'un tab riaperto recupera lo stato senza retry');

  release();
  await registry.wait('import-op-finta');
  assert.strictEqual(disconnects, 1, 'la sessione viene chiusa soltanto dopo la fine dell’operazione');
  const completed = await reopened.socket.chiama('database:import:state', { operationId: 'import-op-finta' });
  assert.strictEqual(completed.operation.status, 'completato');
  assert(ctx.socket.inviati.some((e) => e.evento === 'database:import:progress'));

  let starts = 0;
  const sqlSession = sessioneFinta({
    tabId: 'sql', connName: 'sql-locale', dbType: 'mysql', strategy: { type: 'mysql' },
  });
  const hostile = contestoFinto({ sessioni: [['sql', sqlSession]] });
  hostile.importRegistry = { start() { starts++; } };
  hostile.createImportAdapter = () => ({});
  registraEventi(hostile);
  const rejected = await hostile.socket.chiama('database:import:start', {
    tabId: 'sql', targetDb: 'dest', drop: true, previewOnly: true,
    artifact: {
      formato: 'codedb-database', versione: 1, dbType: 'mysql', db: 'origine',
      collections: [{
        name: 'clienti', docs: [], indexes: null, postDdl: null,
        ddl: 'CREATE TABLE altra (id INT PRIMARY KEY);',
      }],
    },
  });
  assert.strictEqual(rejected.ok, false);
  assert.match(rejected.error, /altra|un'altra tabella/i);
  assert.strictEqual(starts, 0, 'la DDL estranea è rifiutata sull’evento reale prima del piano');

  console.log('  OK   Evento reale import: ack, lease e stato recuperabile passed');
})().catch((err) => {
  console.error('  FAIL Evento reale import:', err.stack || err);
  process.exitCode = 1;
});
