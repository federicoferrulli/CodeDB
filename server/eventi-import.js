'use strict';

// CodeDB — eventi-import. Stato e dipendenze appartengono alla singola istanza.
const { normalizzaExportDatabase } = require('../db/artefatti');
const { creaPianoImport } = require('../db/importPlan');
const { leggiCatalogoExport } = require('../db/exportCatalogo');
const { creaPianoExport, databaseDiSistema } = require('../db/exportPlan');
const { creaSelezioneImport } = require('../db/selezioneImport');
const { creaFileExport } = require('../db/exportFile');
const { verificaImpronta } = require('../db/pianoComune');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');
const { canAdminTenant } = require('../auth/permissions');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { invalidaSnapshot } = require('../db/schemaSnapshot');

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
    }).concat((artifact.objects?.views || []).map(v => ({
      id: `vista:${v.name}`, tipo: 'vista', nome: v.name, haStruttura: true, haDati: false,
    }))),
  };
}

function createModule({ operazioni, lock, identita, audit, dependencies }) {
  const copieAttive = new WeakSet();
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
    function verificaSessioniCopia(c) {
      if (lifecycle.socketClosed || c.sorgente.closed || c.arrivo.closed
          || socketContext.sessions.get(c.tabOrigine) !== c.sorgente || socketContext.sessions.get(c.tabArrivo) !== c.arrivo
          || c.sorgente.strategy !== c.strategyOrigine || c.arrivo.strategy !== c.strategyArrivo
          || c.strategyOrigine.client !== c.clientOrigine || c.strategyArrivo.client !== c.clientArrivo
          || c.sorgente.connName !== c.nomeOrigine || c.arrivo.connName !== c.nomeArrivo
          || socketContext.principal.id !== c.actorId || socketContext.principal.ownerId !== c.ownerId) {
        throw new Error('La sessione di origine o destinazione è cambiata: verificare il bersaglio e riaprire l’anteprima.');
      }
      identita.assertWholeConnection(socketContext.principal, c.sorgente.connName, 'read', 'leggere il database di origine');
      identita.assertWholeConnection(socketContext.principal, c.arrivo.connName, 'manage', 'scrivere nel database di destinazione');
    }

    lifecycle.delegate('database:export:plan', async (strategy, payload, sess) => {
      const richiesta = Symbol();
      sess.richiestaExport = richiesta;
      sess.exportPlan = null;
      sess.confermaExportMongo = null;
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'esportare il database');
      const dbType = (sess && (sess.dbType || sess.strategy.type)) || strategy.type;
      const db = String(payload.db || '').trim();
      if (!db) throw new Error('Database di origine mancante.');
      if (databaseDiSistema(dbType, db)) throw new Error('Un database di sistema non è esportabile.');
      const formato = payload.formato || 'codedb-json';
      if (formato !== 'codedb-json' && formato !== (dbType === 'mongodb' ? 'mongosh' : 'sql')) {
        throw new Error('Formato non disponibile per questo database.');
      }
      let conferma, destinazioneMongo;
      if (payload.destinazioneMongo !== undefined) {
        const target = payload.destinazioneMongo;
        if (dbType !== 'mongodb' || formato !== 'mongosh' || !target || typeof target !== 'object'
            || typeof target.tabId !== 'string' || !target.tabId.trim() || typeof target.db !== 'string'
            || !target.db || target.db !== target.db.trim() || /[\\/. "$*<>:|?\x00]/.test(target.db)
            || Buffer.byteLength(target.db) >= 64 || databaseDiSistema('mongodb', target.db)) {
          throw new Error('Scegli una connessione MongoDB e un database di destinazione valido, diverso da quelli di sistema.');
        }
        const tabArrivo = lock.normTabId(target.tabId);
        const arrivo = socketContext.sessions.get(tabArrivo);
        if (!arrivo || arrivo.closed || arrivo.strategy.type !== 'mongodb') throw new Error('La connessione MongoDB di destinazione non è aperta.');
        if (db.toLowerCase() === target.db.toLowerCase() && (sess === arrivo || strategy.client === arrivo.strategy.client
            || (sess.connName && sess.connName === arrivo.connName))) {
          throw new Error('Origine e destinazione coincidono: scegliere un altro database o server MongoDB.');
        }
        destinazioneMongo = { tabId: tabArrivo, db: target.db, connection: arrivo.connName || arrivo.label || 'ui-session' };
        conferma = { sorgente: sess, arrivo, tabOrigine: lock.normTabId(payload.tabId), tabArrivo,
          strategyOrigine: strategy, strategyArrivo: arrivo.strategy, clientOrigine: strategy.client, clientArrivo: arrivo.strategy.client,
          nomeOrigine: sess.connName, nomeArrivo: arrivo.connName,
          actorId: socketContext.principal.id, ownerId: socketContext.principal.ownerId };
        verificaSessioniCopia(conferma);
      }
      const catalogo = await leggiCatalogoExport(strategy, dbType, db);
      const motore = { backend: 'incorporato', motivo: conferma
        ? 'Copia diretta dal server verso la connessione MongoDB selezionata.'
        : 'File prodotto sul server e scaricato via HTTP.' };
      const mongoRead = dbType === 'mongodb' ? await require('../db/mongoTopologia').leggiTopologia(strategy.client) : null;
      const plan = creaPianoExport({
        catalogo: { ...catalogo, db, dbType },
        connection: (sess && (sess.connName || sess.label)) || 'ui-session',
        modalita: payload.modalita || undefined,
        selezione: payload.selezione || null,
        backend: motore.backend,
        formato,
        ...(conferma && { destinazioneMongo, idConfermaMongo: randomUUID() }),
        opzioniSql: payload.opzioniSql,
        opzioniMongo: payload.opzioniMongo,
        compressione: false,
        consistenza: mongoRead ? mongoRead.avviso : 'snapshot repeatable-read; tabelle non transazionali escluse dalla garanzia',
      });
      if (sess.richiestaExport !== richiesta) throw new Error('Questa anteprima è stata superata da una richiesta più recente.');
      if (conferma) verificaSessioniCopia(conferma);
      sess.exportPlan = plan;
      sess.confermaExportMongo = conferma;
      // Il catalogo viaggia accanto al piano: il wizard deve poter mostrare
      // anche gli oggetti che il piano ESCLUDE — altrimenti «solo struttura»
      // farebbe sparire dalla lista proprio ciò che si vuole riaccendere.
      return {
        plan, motore,
        catalogo: catalogo.oggetti.map((o) => ({ id: `${o.tipo}:${o.nome}`, tipo: o.tipo, nome: o.nome })),
      };
    });

    lifecycle.operazioneLunga('database:export:start', (payload, cb) => {
      const sess = socketContext.sessions.get(lock.normTabId(payload.tabId));
      if (!sess || sess.closed) throw new Error('Nessuna connessione attiva.');
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'esportare il database');
      const plan = sess.exportPlan;
      verificaImpronta(plan);
      if (plan.destinazioneMongo) throw new Error('Questo piano richiede l’esecuzione sulla destinazione MongoDB confermata.');
      if (payload.fingerprint !== plan.fingerprint) throw new Error('Il piano di export è cambiato: riaprire l’anteprima.');
      if (sess.exportOperation?.status === 'in_corso') throw new Error('Un export è già in corso su questa connessione.');
      const principal = socketContext.principal;
      const operation = { id: require('crypto').randomUUID(), status: 'in_corso', rows: 0 };
      sess.exportOperation = operation;
      const check = () => {
        if (sess.closed || socketContext.socket.disconnected || operation.cancelled) throw new Error('Export annullato.');
        identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'continuare l’export');
      };
      lifecycle.acquisisciLeaseOperazione(sess);
      cb({ ok: true, operation: { ...operation } });
      creaFileExport({
        strategy: sess.strategy, plan, check,
        archivio: socketContext.archivioUpload || operazioni.archivioUpload,
        ownerId: principal.ownerId, actorId: principal.id,
        progress: value => Object.assign(operation, value),
      }).then(result => {
        Object.assign(operation, result, { status: 'completato' });
      }, err => {
        Object.assign(operation, { status: 'fallito', error: err.message });
      }).finally(async () => {
        audit.auditWrite(sess, 'database:export:start', { db: plan.sourceDb },
          { op: 'Export database', fingerprint: plan.fingerprint, formato: plan.formato },
          operation.status === 'completato' ? 'ok' : 'error', operation,
          operation.error ? new Error(operation.error) : null, 'read');
        await lifecycle.rilasciaLeaseOperazione(sess);
      }).catch(() => {
        // L'esito dell'export è già registrato; il teardown non pubblica file.
      });
    });

    lifecycle.operazioneLunga('database:export:execute', async (payload, cb) => {
      const sess = socketContext.sessions.get(lock.normTabId(payload.tabId));
      const plan = sess?.exportPlan, c = sess?.confermaExportMongo;
      if (!c || !plan?.destinazioneMongo || payload.planHash !== plan.fingerprint
          || Object.keys(payload).some(k => !['tabId', 'planHash'].includes(k))) {
        throw new Error('Piano di copia assente, superato o già utilizzato: riaprire l’anteprima.');
      }
      verificaImpronta(plan);
      verificaSessioniCopia(c);
      const sessioni = [...new Set([sess, c.arrivo])];
      if (sessioni.some(s => copieAttive.has(s))) throw new Error('Una copia MongoDB è già in corso su una delle connessioni.');
      // Consuma la conferma e acquisisce entrambe le sessioni prima del primo
      // await. Un secondo ack, anche concorrente, non può ripetere la copia.
      sess.confermaExportMongo = null;
      for (const s of sessioni) { copieAttive.add(s); lifecycle.acquisisciLeaseOperazione(s); }
      const check = () => verificaSessioniCopia(c);
      let risultato, errore;
      try {
        if (!await lifecycle.rivalidaPrincipal(true)) throw new Error('Sessione non più valida: accedi di nuovo.');
        check();
        risultato = await dependencies.eseguiExportMongo({ sorgente: c.strategyOrigine, destinazione: c.strategyArrivo, plan,
          dbDestinazione: plan.destinazioneMongo.db, check,
          onProgress: async progresso => {
            if (!await lifecycle.rivalidaPrincipal()) throw new Error('La sessione non è più autorizzata a continuare la copia.');
            check();
            socketContext.socket.emit('database:export:progress', { tabId: c.tabOrigine, planHash: plan.fingerprint, ...progresso });
          } });
      } catch (err) {
        errore = err;
        risultato = err.risultato;
      } finally {
        invalidaSnapshot(c.arrivo);
        audit.auditWrite(c.arrivo, 'database:export:execute', { db: plan.destinazioneMongo.db },
          { op: 'Copia MongoDB diretta', fingerprint: plan.fingerprint, sourceDb: plan.sourceDb,
            sourceConnection: plan.connection, ...(risultato && { risultato }) },
          errore ? 'error' : 'ok', risultato, errore, 'write');
        for (const s of sessioni) copieAttive.delete(s);
        await Promise.allSettled(sessioni.map(s => lifecycle.rilasciaLeaseOperazione(s)));
      }
      cb(errore ? { ok: false, error: require('../db/errors').spiegaErrore(errore, { dbType: 'mongodb' }),
        ...(risultato && { risultato }) } : { ok: true, risultato });
    });

    lifecycle.delegate('database:export:status', async (_strategy, payload, sess) => {
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'vedere l’export');
      const operation = sess.exportOperation;
      if (!operation || operation.id !== payload.operationId) throw new Error('Export non trovato.');
      if (payload.cancel) operation.cancelled = true;
      const { manifest, ...view } = operation;
      if (manifest && operation.status === 'completato') {
        const modulo = socketContext.artefatti || operazioni.artefatti;
        const ticket = modulo.emettiTicket({ risorsa: `artefatto:${manifest.id}`, attore: socketContext.principal.id, ownerId: socketContext.principal.ownerId });
        view.url = `/artefatti/${manifest.id}/scarica?ticket=${encodeURIComponent(ticket)}`;
        view.filename = manifest.nome;
      }
      return { operation: view };
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

    lifecycle.delegate('database:import:upload:start', async (strategy, payload) => {
      const registry = socketContext.importUploads || operazioni.importUploads;
      return registry.start(socketContext.principal.ownerId, socketContext.principal.id, {
        format: payload.format || 'codedb-json', dbType: strategy.type,
      });
    });

    lifecycle.delegate('database:import:upload:chunk', async (_strategy, payload) => {
      const registry = socketContext.importUploads || operazioni.importUploads;
      return registry.append(payload.uploadId, socketContext.principal.ownerId, payload.index, payload.chunk, socketContext.principal.id);
    });

    lifecycle.delegate('database:import:upload:finish', async (strategy, payload) => {
      const registry = socketContext.importUploads || operazioni.importUploads;
      const artifact = registry.finish(payload.uploadId, socketContext.principal.ownerId, (raw) => (
        normalizzaExportDatabase(raw, { expectedDbType: strategy.type, owned: true })
      ), socketContext.principal.id);
      return {
        artifact: {
          db: artifact.db, dbType: artifact.dbType,
          avvisi: artifact.avvisi || [],
          views: (artifact.objects?.views || []).map(v => v.name),
          collections: artifact.collections.map((collection) => ({
            name: collection.name, rows: collection.docs.length, identity: collection.identity || null,
          })),
        },
      };
    });

    lifecycle.delegate('database:import:upload:cancel', async (_strategy, payload) => {
      const registry = socketContext.importUploads || operazioni.importUploads;
      registry.remove(payload.uploadId, socketContext.principal.ownerId, socketContext.principal.id);
      return {};
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
      // Il riepilogo dell'anteprima legge `kind`, `dbType` e `sourceDb`: senza
      // di essi il piano mostrato non e' riconoscibile come piano.
      const publicPlan = {
        kind: plan.kind, dbType: plan.dbType, sourceDb: plan.sourceDb,
        fingerprint: plan.fingerprint, connection: plan.connection, targetDb: plan.targetDb,
        collections: plan.collections, views: plan.views, promotion: plan.promotion, drop: plan.drop,
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
        backupOriginId: sess.backupOriginId,
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
      const adapterFactory = socketContext.createImportAdapter || createImportArtifactAdapter;
      const adapter = adapterFactory({
        strategy: sess.strategy, dbType: sess.dbType || sess.strategy.type,
        connName: operation.connection,
        recoveryRoot: path.join(operazioni.backupRootOf(socketContext.principal), 'import-recovery'),
      });
      const connessione = { connection: sess.connName || sess.label || 'ui-session', backupOriginId: sess.backupOriginId };
      cb({ ok: true, operation: await registry.cleanup(payload.operationId, socketContext.principal.ownerId, adapter, socketContext.principal.id, connessione) });
    });
  }

  return registra;
}

module.exports = { createModule };
