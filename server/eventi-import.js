'use strict';

// CodeDB — eventi-import. Stato e dipendenze appartengono alla singola istanza.
const { normalizzaExportDatabase } = require('../db/artefatti');
const { creaPianoImport } = require('../db/importPlan');
const { leggiCatalogoExport } = require('../db/exportCatalogo');
const { creaPianoExport } = require('../db/exportPlan');
const { creaSelezioneImport } = require('../db/selezioneImport');
const { backendDisponibile } = require('../backup/lib/nativi');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');
const { canAdminTenant } = require('../auth/permissions');
const path = require('path');

/**
 * L'inventario che `creaSelezioneImport` sa leggere, dall'artefatto normalizzato.
 *
 * Il formato `.codedb.json` elenca collection con `docs`, `ddl` e `identity`;
 * l'inventario parla di oggetti con `haStruttura`/`haDati`. La traduzione sta
 * qui, in un posto solo, perché è l'unico punto in cui le due forme si toccano.
 */
function inventarioDaArtefatto(artifact) {
  return {
    db: artifact.db,
    dbType: artifact.dbType,
    oggetti: (artifact.collections || []).map((c) => {
      // Stessa forma dell'id del piano di export (`tipo:nome`): un id che non
      // coincide col tipo che dichiara è un id che non si può incrociare.
      const tipo = artifact.dbType === 'mongodb' ? 'collection' : 'tabella';
      return {
      id: `${tipo}:${c.name}`,
      tipo,
      nome: c.name,
      // Su MongoDB non c'è DDL: la struttura è la collection stessa, che
      // l'import materializza comunque — anche vuota.
      haStruttura: artifact.dbType === 'mongodb' ? true : !!c.ddl,
      haDati: Array.isArray(c.docs) && c.docs.length > 0,
      identita: c.identity || null,
      };
    }),
  };
}

function createModule({ operazioni, lock, identita, audit }) {
  function registra(socketContext, lifecycle) {
    // Un file `.codedb.json` attraversa lo stesso confine server-side usato dal
    // restore. L'evento non legge ne' muta il database; il client dichiara il
    // motore della connessione corrente, che deve coincidere con l'artefatto.
    lifecycle.amministrativo('artifact:validate', (payload, cb) => cb({
      ok: true,
      artifact: normalizzaExportDatabase(payload.artifact, { expectedDbType: payload.expectedDbType }),
    }));

    // Biglietto per il data-plane HTTP: il browser non può impostare header su
    // un download, quindi la GET si autorizza con un ticket breve legato a una
    // risorsa sola dentro il tenant di chi lo chiede. Non tocca alcun database
    // e non esce mai dal tenant: per questo è amministrativo (tracciato, senza
    // strategia) e non delegate (che pretenderebbe tabId e sessione).
    //
    // Ma il tenant non basta: un artefatto può contenere l'intero database, e
    // un sottoutente con scope su due collection non deve scaricarlo aggirando
    // i permessi per connessione. Il ticket lo emette solo chi amministra il
    // tenant (owner, root o tenant-admin): gli altri usano i percorsi socket,
    // dove ogni lettura passa dal proxy autorizzante.
    lifecycle.amministrativo('artefatti:ticket', (payload, cb) => {
      if (!canAdminTenant(socketContext.principal)) {
        return cb({ ok: false, error: 'Permesso negato: il trasferimento di artefatti richiede l\u2019amministrazione del tenant.' });
      }
      const modulo = socketContext.artefatti || operazioni.artefatti;
      return cb({
        ok: true,
        ticket: modulo.emettiTicket({
          risorsa: payload && payload.risorsa,
          attore: socketContext.principal.id,
          ownerId: socketContext.principal.ownerId,
        }),
      });
    });

    /* --- Piano di export ---------------------------------------------------- */

    // L'anteprima dell'export. Legge il catalogo REALE del database (vincoli
    // dichiarati, dipendenze di view, tabella di un trigger — mai le euristiche
    // UML) e ne ricava il piano immutabile e firmato che l'utente conferma.
    //
    // Sta QUI e non nel browser perche' due decisioni non possono stare nel
    // client: che cosa sia un database di sistema — il controllo viveva solo in
    // `public/js/exportimport.js`, quindi chi parlava direttamente col socket
    // poteva chiedere `mysql` o `pg_catalog` — e quale perimetro la chiusura
    // delle dipendenze porti davvero dentro.
    lifecycle.delegate('database:export:plan', async (strategy, payload) => {
      const sess = socketContext.sessions.get(lock.normTabId(payload.tabId));
      const dbType = (sess && (sess.dbType || sess.strategy.type)) || strategy.type;
      const db = String(payload.db || '').trim();
      if (!db) throw new Error('Database di origine mancante.');
      const catalogo = await leggiCatalogoExport(strategy, dbType, db);
      // Il backend si GUARDA, non si presume: dichiarare «nativo» senza il
      // binario farebbe fallire l'esecuzione dopo la conferma, non prima.
      const motore = backendDisponibile(dbType);
      const plan = creaPianoExport({
        catalogo: { ...catalogo, db, dbType },
        connection: (sess && (sess.connName || sess.label)) || 'ui-session',
        modalita: payload.modalita || undefined,
        selezione: payload.selezione || null,
        backend: motore.backend,
      });
      // Il catalogo viaggia accanto al piano: il wizard deve poter mostrare
      // anche gli oggetti che il piano ESCLUDE — altrimenti «solo struttura»
      // farebbe sparire dalla lista proprio ciò che si vuole riaccendere.
      return {
        plan, motore,
        catalogo: catalogo.oggetti.map((o) => ({ id: `${o.tipo}:${o.nome}`, tipo: o.tipo, nome: o.nome })),
      };
    });

    /* --- Selezione di import ------------------------------------------------ */

    // Che cosa dell'archivio entra, con quale politica, e che cosa resta fuori:
    // deciso e FIRMATO prima di ogni scrittura. Rifiuta qui ciò che non si può
    // eseguire — fondere senza un'identità stabile, chiedere dati che
    // l'archivio non contiene — invece di scoprirlo a metà import.
    lifecycle.delegate('database:import:selezione', async (strategy, payload) => {
      const sess = socketContext.sessions.get(lock.normTabId(payload.tabId));
      const uploadRegistry = socketContext.importUploads || operazioni.importUploads;
      const artifact = payload.uploadId
        ? uploadRegistry.get(payload.uploadId, socketContext.principal.ownerId, socketContext.principal.id)
        : normalizzaExportDatabase(payload.artifact, { expectedDbType: strategy.type });
      return {
        selezione: creaSelezioneImport({
          inventario: inventarioDaArtefatto(artifact),
          selezione: payload.selezione || null,
          connection: (sess && (sess.connName || sess.label)) || 'ui-session',
          targetDb: payload.targetDb,
          politicaDefault: payload.politicaDefault || undefined,
        }),
      };
    });

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
