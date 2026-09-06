'use strict';

// CodeDB — eventi-dati. Stato e dipendenze appartengono alla singola istanza.
const { pianoRinomina } = require('../db/rinominaSicura');
const { limitaSchema } = require('../db/schemaProgressivo');
const { scegliIdentitaSql } = require('../backup/lib/identity');
const { readSchemaObjects } = require('../db/schemaObjects');
const { createImportBatchRegistry } = require('../db/importBatches');

function createModule({ query, lock, identita, operazioni, audit }) {
  const importBatches = createImportBatchRegistry();
  function registra(socketContext, lifecycle) {
    // --- Esplorazione e gestione database (delegati alla strategia) ------------

    lifecycle.delegate('db:list', async (strategy) => ({ databases: await strategy.listDatabases() }));

    lifecycle.delegate('db:search', async (strategy, { query }) => ({ databases: await strategy.search(query) }));

    lifecycle.delegate('db:collections', async (strategy, { db }) => ({ collections: await strategy.listCollections(db) }));

    lifecycle.delegate('db:create', async (strategy, { db, coll }) => { await strategy.createDatabase(db, coll); return {}; });

    // Rinomina di un database. PostgreSQL la esegue nativamente (ALTER SCHEMA,
    // atomico); MongoDB e MySQL non hanno un comando equivalente e passano da
    // dump → verifica → restore. In entrambi i casi il lease mantiene viva la
    // sessione fino al completamento e alla registrazione dell'esito.
    lifecycle.operazioneLunga('db:rename', async (payload, cb) => {
      for (const serverOnly of query.SERVER_ONLY_PAYLOAD_FIELDS) delete payload[serverOnly];
      const sess = socketContext.sessions.get(lock.normTabId(payload.tabId));
      if (!sess) throw new Error('Nessuna connessione attiva al database.');
      const { db, newName } = payload;
      identita.assertWholeConnection(socketContext.principal, sess.connName, 'manage', 'rinominare un database');
      lifecycle.acquisisciLeaseOperazione(sess);
      let result;
      try {
        const strategy = sess.strategy;
        if (strategy.supportsNativeRename && strategy.supportsNativeRename()) {
          await strategy.renameDatabase(db, newName);
          result = {
            modo: 'nativo',
            piano: pianoRinomina(sess.dbType || strategy.type, true),
            origine: db,
            destinazione: newName,
            origineEliminata: true,
            completata: true,
          };
        } else {
          result = await operazioni.rinominaViaDump(sess, db, newName, {
            eliminaOrigine: payload.eliminaOrigine === true,
            principal: socketContext.principal,
          });
        }
        audit.auditWrite(sess, 'db:rename', payload, {
          op: 'Rinomina database', target: newName,
          garanzia: result.piano && result.piano.garanzia,
        }, 'ok', result, null);
      } catch (err) {
        audit.auditWrite(sess, 'db:rename', payload, {
          op: 'Rinomina database', target: newName,
        }, 'error', null, err);
        throw err;
      } finally {
        await lifecycle.rilasciaLeaseOperazione(sess);
      }
      cb({ ok: true, ...result });
    });

    lifecycle.delegate('db:drop', async (strategy, { db }) => { await strategy.dropDatabase(db); return {}; });

    lifecycle.delegate('db:schema', async (strategy, payload) => {
      const schema = await strategy.dbSchema(payload.db);
      return payload.progressive === true ? limitaSchema(schema, payload) : schema;
    });

    // --- Gestione collection/tabelle, colonne e indici ---------------------------

    lifecycle.delegate('collection:create', async (strategy, p) => { await strategy.createCollection(p.db, p.name, p); return {}; });

    lifecycle.delegate('collection:rename', async (strategy, p) => { await strategy.renameCollection(p.db, p.coll, p.newName); return {}; });

    lifecycle.delegate('collection:drop', async (strategy, p) => { await strategy.dropCollection(p.db, p.coll); return {}; });

    lifecycle.delegate('column:add', (strategy, p) => strategy.addColumn(p.db, p.coll, p.column));

    lifecycle.delegate('column:alter', (strategy, p) => strategy.alterColumn(p.db, p.coll, p));

    lifecycle.delegate('column:drop', (strategy, p) => strategy.dropColumn(p.db, p.coll, p.name));

    lifecycle.delegate('index:create', (strategy, p) => strategy.createIndex(p.db, p.coll, p));

    lifecycle.delegate('index:drop', async (strategy, p) => { await strategy.dropIndex(p.db, p.coll, p.name); return {}; });

    // --- Query, dettagli e mutazioni --------------------------------------------

    lifecycle.delegate('collection:stats', (strategy, { db, coll }) => strategy.collectionStats(db, coll));

    // Chiavi esterne uscenti dalla tabella aperta e righe della tabella riferita:
    // alimentano il pannello 🔗 della griglia (doppio clic su una cella collegata).
    // Le RIGHE della tabella riferita non hanno più un evento proprio: il
    // pannello le chiede con `collection:find` e un filtro strutturato, che è la
    // stessa via della griglia (ticket 22-24).
    lifecycle.delegate('collection:relations', async (strategy, { db, coll }) => ({ relazioni: await strategy.columnRelations(db, coll) }));

    lifecycle.delegate('collection:find', (strategy, p) => strategy.collectionFind(p.db, p.coll, p));

    // Conteggio totale disaccoppiato: la griglia carica prima i documenti
    // (total = null) e chiede il conteggio a parte, così non aspetta la scansione
    // completa su collection/tabelle enormi. Lettura di chrome: non tracciata.
    lifecycle.delegate('collection:count', (strategy, p) => strategy.collectionCount(p.db, p.coll, p));

    lifecycle.delegate('collection:aggregate', (strategy, p) => strategy.collectionAggregate(p.db, p.coll, p));

    lifecycle.delegate('collection:explain', (strategy, p) => strategy.collectionExplain(p.db, p.coll, p));

    lifecycle.delegate('doc:insert', (strategy, p) => strategy.docInsert(p.db, p.coll, p));

    // Duplicazione di una riga: il documento da inserire lo calcola il server
    // (chiavi primarie rifatte, chiavi uniche svuotate o ricalcolate, colonne
    // generate tolte) invece di lasciarlo comporre a mano nell'editor JSON.
    // `soloAnteprima` restituisce il documento senza scriverlo: e' la modalita'
    // "Duplica e modifica...", dove l'inserimento vero passa poi da doc:insert.
    lifecycle.delegate('doc:duplicate', async (strategy, p) => {
      const piano = await strategy.duplicatePlan(p.db, p.coll, p);
      if (p.soloAnteprima === true) return { doc: piano.doc, note: piano.note, azioni: piano.azioni };
      const esito = await strategy.docInsert(p.db, p.coll, { ...p, doc: piano.doc });
      return { ...esito, doc: piano.doc, note: piano.note, azioni: piano.azioni };
    });

    lifecycle.delegate('doc:update', (strategy, p) => strategy.docUpdate(p.db, p.coll, p));

    lifecycle.delegate('doc:replace', (strategy, p) => strategy.docReplace(p.db, p.coll, p));

    lifecycle.delegate('doc:delete', (strategy, p) => strategy.docDelete(p.db, p.coll, p));

    lifecycle.delegate('collection:deleteMany', (strategy, p) => strategy.collectionDeleteMany(p.db, p.coll, p));

    // --- Export / import di collection e tabelle ---------------------------------
    // Export: il client richiede blocchi successivi (skip/limit) e assembla il
    // file; import: il client invia batch di documenti/righe in Extended JSON.

    lifecycle.delegate('collection:export', (strategy, p) => strategy.collectionExport(p.db, p.coll, p));

    lifecycle.delegate('collection:identity', async (strategy, p) => {
      const type = strategy.type === 'postgres' ? 'postgresql' : strategy.type;
      if (type === 'mongodb') return { identity: { kind: 'mongodb-id', columns: ['_id'] } };
      const info = await strategy.tableColumnsInfo(p.db, p.coll);
      const primary = await strategy.primaryKey(p.db, p.coll);
      const uniques = await strategy.uniqueIndexes(p.db, p.coll);
      const constraints = [];
      if (primary.length) constraints.push({ kind: 'primary-key', name: 'PRIMARY', columns: primary });
      for (let i = 0; i < uniques.length; i++) {
        constraints.push({ kind: 'unique', name: `unique_${i + 1}`, columns: uniques[i] });
      }
      return { identity: scegliIdentitaSql(info.columns, constraints) };
    });

    lifecycle.delegate('collection:import', (strategy, p) => {
      if (!p.batchId) return strategy.collectionImport(p.db, p.coll, p);
      const sess = socketContext.sessions.get(lock.normTabId(p.tabId));
      const principal = socketContext.principal;
      const scope = [principal.ownerId, principal.id, sess.connName || sess.id || p.tabId,
        strategy.type, p.db, p.coll];
      return importBatches.request(scope, p, async () => {
        lifecycle.acquisisciLeaseOperazione(sess);
        try { return await strategy.collectionImport(p.db, p.coll, p); }
        finally { await lifecycle.rilasciaLeaseOperazione(sess); }
      });
    });

    // DDL della tabella (CREATE TABLE, solo SQL; null per MongoDB): usato
    // dall'export di interi database per rendere il file auto-contenuto.
    lifecycle.delegate('collection:ddl', async (strategy, p) => ({ ddl: await strategy.tableDdl(p.db, p.coll) }));

    // Indici e chiavi esterne della tabella, da applicare in coda all'import
    // quando tutte le tabelle esistono e i dati sono stati caricati.
    lifecycle.delegate('collection:auxddl', async (strategy, p) => await strategy.tableAuxDdl(p.db, p.coll));

    lifecycle.delegate('database:schema-objects', async (strategy, p) => ({
      objects: await (async () => {
        const sess = socketContext.sessions.get(lock.normTabId(p.tabId));
        identita.assertWholeConnection(socketContext.principal, sess.connName, 'read', 'esportare gli oggetti di schema del database');
        return readSchemaObjects(strategy, strategy.type, p.db);
      })(),
    }));

    // --- Aggiornamenti in tempo reale -------------------------------------------
    // I DBMS senza change stream (MySQL) falliscono qui: il frontend nasconde
    // semplicemente il badge LIVE.

    /* -------------------------------------------------------------------------
     * I quattro eventi di osservazione passano dalla giuntura dei dati.
     *
     * Sono i quattro SOLI candidati puri fra i quarantotto eventi registrati per
     * la via generica: gli altri quarantaquattro hanno un motivo che regge, e la
     * decisione di non ricondurli tutti dentro è registrata in ADR-0001.
     *
     * Rifacevano a mano la ricerca della sessione, con lo stesso messaggio
     * d'errore copiato quattro volte. Passando da `delegate` guadagnano la
     * RICONNESSIONE AUTOMATICA, che non avevano: mettere in osservazione una
     * collezione su una connessione caduta non riprovava, e l'osservazione
     * restava spenta senza che nulla lo dicesse.
     *
     * Due difetti chiusi qui, entrambi sui due eventi che TOLGONO l'osservazione:
     * non avevano una capability associata (sotto la giuntura sarebbero stati
     * negati a un sottoutente) e non rispondevano affatto al client, che restava
     * in attesa di un ack che non arrivava mai.
     * ---------------------------------------------------------------------- */

    lifecycle.delegate('collection:watch', (strategy, p) => {
      // Gli eventi push sono taggati col tabId: il frontend li instrada al tab.
      const tab = lock.normTabId(p.tabId);
      strategy.watch(p.db, p.coll, {
        onChange: (change) => socketContext.socket.emit('collection:changed', { tabId: tab, db: p.db, coll: p.coll, ...change }),
        onUnavailable: () => socketContext.socket.emit('watch:unavailable', { tabId: tab, db: p.db, coll: p.coll }),
      });
      return {};
    });

    lifecycle.delegate('collection:unwatch', (strategy) => {
      strategy.unwatch();
      return {};
    });

    // Watch dello schema (database/collection creati, rinominati o eliminati):
    // dove il change stream non c'è (MySQL, Mongo standalone) arriva subito
    // schema:unavailable e il frontend ripiega sul polling della sidebar.
    lifecycle.delegate('schema:watch', (strategy, p) => {
      const tabId = lock.normTabId(p.tabId);
      strategy.watchSchema({
        onChange: (change) => socketContext.socket.emit('schema:changed', { tabId, ...change }),
        onUnavailable: () => socketContext.socket.emit('schema:unavailable', { tabId }),
      });
      return {};
    });

    lifecycle.delegate('schema:unwatch', (strategy) => {
      strategy.unwatchSchema();
      return {};
    });
  }

  return registra;
}

module.exports = { createModule };
