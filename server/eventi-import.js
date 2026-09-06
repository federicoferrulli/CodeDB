'use strict';

// CodeDB — eventi-import. Stato e dipendenze appartengono alla singola istanza.
const { normalizzaExportDatabase } = require('../db/artefatti');
const { creaPianoImport } = require('../db/importPlan');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');
const path = require('path');

function createModule({ operazioni, lock, identita, audit }) {
  function registra(socketContext, lifecycle) {
    // Un file `.codedb.json` attraversa lo stesso confine server-side usato dal
    // restore. L'evento non legge ne' muta il database; il client dichiara il
    // motore della connessione corrente, che deve coincidere con l'artefatto.
    lifecycle.amministrativo('artifact:validate', (payload, cb) => cb({
      ok: true,
      artifact: normalizzaExportDatabase(payload.artifact, { expectedDbType: payload.expectedDbType }),
    }));

    lifecycle.delegate('database:import:upload:start', async () => {
      const registry = socketContext.importUploads || operazioni.importUploads;
      return registry.start(socketContext.principal.ownerId, socketContext.principal.id);
    });

    lifecycle.delegate('database:import:upload:chunk', async (_strategy, payload) => {
      const registry = socketContext.importUploads || operazioni.importUploads;
      return registry.append(payload.uploadId, socketContext.principal.ownerId, payload.index, payload.chunk, socketContext.principal.id);
    });

    lifecycle.delegate('database:import:upload:finish', async (strategy, payload) => {
      const registry = socketContext.importUploads || operazioni.importUploads;
      const artifact = registry.finish(payload.uploadId, socketContext.principal.ownerId, (raw) => (
        normalizzaExportDatabase(raw, { expectedDbType: strategy.type })
      ), socketContext.principal.id);
      return {
        artifact: {
          db: artifact.db, dbType: artifact.dbType,
          collections: artifact.collections.map((collection) => ({
            name: collection.name, rows: collection.docs.length, identity: collection.identity || null,
          })),
        },
      };
    });

    // --- Import database come operazione lunga ---------------------------------

    lifecycle.operazioneLunga('database:import:start', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const sess = socketContext.sessions.get(tabId);
      if (!sess) throw new Error('Nessuna connessione attiva per questo tab.');
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'manage', 'importare un database');
      const uploadRegistry = socketContext.importUploads || operazioni.importUploads;
      const artifact = payload.uploadId
        ? uploadRegistry.get(payload.uploadId, socketContext.principal.ownerId, socketContext.principal.id)
        : payload.artifact;
      const plan = creaPianoImport({
        artifact,
        expectedDbType: sess.dbType || sess.strategy.type,
        connection: sess.connName || sess.label || 'ui-session',
        targetDb: payload.targetDb,
        drop: !!payload.drop,
      });
      const publicPlan = {
        fingerprint: plan.fingerprint, connection: plan.connection, targetDb: plan.targetDb,
        collections: plan.collections, promotion: plan.promotion, drop: plan.drop,
      };
      if (payload.previewOnly) {
        cb({ ok: true, preview: true, plan: publicPlan });
        return;
      }
      if (payload.expectedFingerprint !== plan.fingerprint) {
        throw new Error('Il piano e cambiato dopo la conferma: rileggi l’anteprima prima di eseguire.');
      }
      const registry = socketContext.importRegistry || operazioni.importOperations;
      const adapterFactory = socketContext.createImportAdapter || createImportArtifactAdapter;
      const adapter = adapterFactory({
        strategy: sess.strategy,
        dbType: sess.dbType || sess.strategy.type,
        connName: plan.connection,
        recoveryRoot: path.join(operazioni.backupRootOf(socketContext.principal), 'import-recovery'),
        signal: null,
      });
      lifecycle.acquisisciLeaseOperazione(sess);
      const accepted = registry.start({
        plan, adapter, ownerId: socketContext.principal.ownerId, actorId: socketContext.principal.id, tabId,
        onProgress: (state) => socketContext.socket.emit('database:import:progress', state),
        onSettled: async (state) => {
          await lifecycle.rilasciaLeaseOperazione(sess);
          audit.auditWrite(
            sess, 'database:import:start', { db: plan.targetDb },
            { op: 'Import database', operationId: state.operationId, fingerprint: plan.fingerprint },
            state.status === 'completato' ? 'ok' : 'error', state,
            state.error ? Object.assign(new Error(state.error), {
              code: state.originalError && state.originalError.code,
              codeName: state.originalError && state.originalError.codeName,
              target: state.originalError && state.originalError.target || plan.targetDb,
            }) : null,
          );
          if (payload.uploadId && typeof uploadRegistry.remove === 'function') {
            try { uploadRegistry.remove(payload.uploadId, socketContext.principal.ownerId, socketContext.principal.id); } catch (_) { /* gia scaduto */ }
          }
        },
      });
      cb({ ok: true, accepted, plan: publicPlan });
    });

    lifecycle.operazioneLunga('database:import:state', async (payload, cb) => {
      const registry = socketContext.importRegistry || operazioni.importOperations;
      const operation = registry.get(payload.operationId, socketContext.principal.ownerId, socketContext.principal.id);
      identita.assertWholeConnection(socketContext.principal, operation.connection, 'manage', 'vedere lo stato di un import');
      cb({ ok: true, operation });
    });

    lifecycle.operazioneLunga('database:import:list', async (_payload, cb) => {
      const registry = socketContext.importRegistry || operazioni.importOperations;
      const visible = registry.list(socketContext.principal.ownerId, socketContext.principal.id).filter((operation) => {
        try {
          identita.assertWholeConnection(socketContext.principal, operation.connection, 'manage', 'vedere gli import recuperabili');
          return true;
        } catch (_) { return false; }
      });
      cb({ ok: true, operations: visible });
    });

    lifecycle.operazioneLunga('database:import:cancel', async (payload, cb) => {
      const registry = socketContext.importRegistry || operazioni.importOperations;
      const operation = registry.get(payload.operationId, socketContext.principal.ownerId, socketContext.principal.id);
      identita.assertWholeConnection(socketContext.principal, operation.connection, 'manage', 'annullare un import');
      cb({ ok: true, cancelled: registry.cancel(payload.operationId, socketContext.principal.ownerId, socketContext.principal.id) });
    });

    lifecycle.operazioneLunga('database:import:cleanup', async (payload, cb) => {
      const tabId = lock.normTabId(payload.tabId);
      const sess = socketContext.sessions.get(tabId);
      if (!sess) throw new Error('Apri la connessione usata dall’import prima di eliminare staging e recupero.');
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'manage', 'eliminare staging e recupero di un import');
      const registry = socketContext.importRegistry || operazioni.importOperations;
      const operation = registry.get(payload.operationId, socketContext.principal.ownerId, socketContext.principal.id);
      if (operation.connection !== (sess.connName || sess.label)) {
        throw new Error(`L’operazione appartiene alla connessione "${operation.connection}".`);
      }
      const adapterFactory = socketContext.createImportAdapter || createImportArtifactAdapter;
      const adapter = adapterFactory({
        strategy: sess.strategy, dbType: sess.dbType || sess.strategy.type,
        connName: operation.connection,
        recoveryRoot: path.join(operazioni.backupRootOf(socketContext.principal), 'import-recovery'),
      });
      cb({ ok: true, operation: await registry.cleanup(payload.operationId, socketContext.principal.ownerId, adapter, socketContext.principal.id) });
    });
  }

  return registra;
}

module.exports = { createModule };
