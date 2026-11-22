'use strict';

/* ---------------------------------------------------------------------------
 * Strumenti MCP di connessione, esplorazione, interrogazione e diagnostica
 * analitica dello schema (sola lettura).
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');
const { z } = require('zod');
const DbFactory = require('../db/DbFactory');
const { canUseConnection } = require('../auth/permissions');
const { assertNoMongoServerJs } = require('../auth/capabilities');
const { jsonResult, assertReadOnlySql, assertReadOnlyPipeline } = require('./guardie');
const { caricaAnalisi, buildGraphData } = require('./risorse-e-prompt');

function registraStrumentiLettura({
  tool, session, deps, requireDbSession, sessionPrincipal, scrittureConsentiteDaConfig,
}) {
  tool('list_saved_connections', {
    title: 'Connessioni salvate',
    description:
      'Elenca le connessioni salvate in connections.ini: nome, tipo di database (mongodb, mysql o postgresql), ' +
      'etichetta host e cartella. Le credenziali non vengono mai esposte. ' +
      'Usa il nome restituito come parametro "saved" di connect_database.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const all = deps.loadConnections(sessionPrincipal(session).ownerId);
    const visible = deps.allowedConnections
      ? deps.allowedConnections(sessionPrincipal(session), Object.keys(all))
      : Object.keys(all);
    const connections = visible.map((name) => ({
      name,
      dbType: deps.connDbType(all[name]),
      label: deps.connLabel(all[name]),
      folder: all[name].folder || '',
      readOnly: String(all[name].readOnly || '').trim().toLowerCase() !== 'false',
    }));
    return jsonResult({ connections });
  });

  tool('connect_database', {
    title: 'Apri connessione',
    description:
      'Apre una connessione a una delle connessioni salvate (indicata per nome) e restituisce il ' +
      'connection_id da usare nelle altre chiamate, il dbType (mongodb, mysql o postgresql) e l\'elenco dei database. ' +
      'Le credenziali e gli eventuali tunnel SSH restano gestiti dal server.',
    inputSchema: {
      saved: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
    },
    annotations: { openWorldHint: false },
  }, async ({ saved }) => {
    if (!canUseConnection(sessionPrincipal(session), String(saved || ''))) {
      throw new Error(`Permesso negato: la API key usata non ha accesso alla connessione "${saved}".`);
    }
    if (!deps.tryAcquireGlobalSession()) {
      throw new Error('Raggiunto il limite globale di connessioni al database: riprova più tardi.');
    }
    const connName = String(saved || '');
    const guardCtx = { principal: sessionPrincipal(session), connName };
    let conn;
    try {
      conn = await deps.establishConnection({ saved: connName }, guardCtx);
    } catch (err) {
      deps.releaseGlobalSession();
      throw err;
    }
    const connectionId = crypto.randomUUID();
    const writesAllowed = scrittureConsentiteDaConfig(conn.effective, deps);
    session.dbSessions.set(connectionId, {
      strategy: conn.strategy,
      tunnel: conn.tunnel,
      dbType: conn.dbType,
      name: String(saved || ''),
      backupOriginId: conn.effective?.backupOriginId,
      writesAllowed,
      guardCtx,
    });
    let databases = [];
    try { databases = await conn.strategy.listDatabases(); } catch { /* la lista è facoltativa */ }
    return jsonResult({
      connection_id: connectionId,
      dbType: conn.dbType,
      label: deps.connLabel(conn.effective),
      writable: writesAllowed,
      databases,
    });
  });

  tool('disconnect_database', {
    title: 'Chiudi connessione',
    description: 'Chiude una connessione aperta con connect_database e libera le risorse (client/pool e tunnel SSH).',
    inputSchema: {
      connection_id: z.string(),
    },
    annotations: { openWorldHint: false },
  }, async ({ connection_id }) => {
    const sess = requireDbSession(connection_id);
    session.dbSessions.delete(String(connection_id));
    deps.releaseGlobalSession();
    await deps.teardownConnection(sess);
    return jsonResult({ disconnected: true });
  });

  tool('get_databases_and_collections', {
    title: 'Topologia',
    description:
      'Esplora la topologia della connessione: senza "db" elenca i database (nome e dimensione su disco); ' +
      'con "db" elenca le collection/tabelle di quel database (nome, tipo, conteggio stimato dei documenti/righe).',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().optional().describe('Nome del database di cui elencare le collection/tabelle'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db }) => {
    const sess = requireDbSession(connection_id);
    const dbName = String(db || '').trim();
    if (dbName) {
      return jsonResult({ db: dbName, collections: await sess.strategy.listCollections(dbName) });
    }
    return jsonResult({ databases: await sess.strategy.listDatabases() });
  });

  tool('get_schema', {
    title: 'Schema del database',
    description:
      'Restituisce lo schema di un database: per ogni collection/tabella i campi con tipi e presenza % ' +
      '(MongoDB: dedotti da un campione; MySQL: colonne reali), più le relazioni tra collection/tabelle ' +
      '(foreign key dichiarate e euristiche di denominazione). Consultalo prima di scrivere query su dati che non conosci.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db }) => {
    const sess = requireDbSession(connection_id);
    return jsonResult(await sess.strategy.dbSchema(String(db || '').trim()));
  });

  tool('execute_query', {
    title: 'Esegui query (sola lettura)',
    description:
      'Esegue una query di sola lettura e restituisce { docs, columns, total, skip, limit } ' +
      '(documenti/righe in Extended JSON: ObjectId = {"$oid": ...}, date = {"$date": ...}). ' +
      'PREFERISCI "filtro": è un filtro STRUTTURATO che funziona allo stesso modo su tutti e tre i motori ' +
      '(MongoDB, MySQL, PostgreSQL) e non richiede di sapere quale motore risponde. ' +
      'I suoi valori sono parametrizzati, quindi non possono alterare la query. ' +
      'Su MongoDB restano disponibili "filter" (Extended JSON) e "pipeline" (aggregazione, senza $out/$merge); ' +
      'su MySQL/PostgreSQL resta "sql" con uno statement SELECT/SHOW/DESCRIBE/EXPLAIN/WITH in transazione READ ONLY, ' +
      'che serve per tutto ciò che un filtro non esprime (JOIN, GROUP BY, espressioni). ' +
      'Mantieni "limit" basso e usa "projection" o SELECT mirate per non sprecare contesto.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Database (MySQL/PostgreSQL: schema) su cui eseguire la query'),
      collection: z.string().optional().describe('Solo MongoDB: collection su cui eseguire find o pipeline'),
      filtro: z.string().optional().describe(
        'TUTTI i motori: filtro strutturato in JSON, valido su MongoDB, MySQL e PostgreSQL. '
        + 'Forma: {"condizioni":[{"campo":"eta","operatore":"maggiore","valore":30}],"unione":"e"}. '
        + 'Operatori: uguale, diverso, maggiore, maggioreUguale, minore, minoreUguale, '
        + 'contiene, iniziaCon, finisceCon, dentro (valore = elenco), vuoto, nonVuoto (senza valore). '
        + '"unione" vale "e" (default) oppure "o". I valori sono parametrizzati: nessun valore '
        + 'finisce nel testo della query. Su MySQL/PostgreSQL richiede anche "collection".'
      ),
      filter: z.string().optional().describe('Solo MongoDB: filtro find in Extended JSON, es. {"age":{"$gt":30}} o {"_id":{"$oid":"..."}}'),
      sort: z.string().optional().describe('Solo MongoDB: ordinamento in Extended JSON, es. {"age":-1}'),
      projection: z.string().optional().describe('Solo MongoDB: proiezione dei campi, es. {"name":1,"age":1}'),
      skip: z.coerce.number().int().min(0).optional().describe('Solo MongoDB find: offset per la paginazione (default 0)'),
      limit: z.coerce.number().int().min(1).max(500).optional().describe('Solo MongoDB find: numero massimo di documenti (default 50, max 500)'),
      pipeline: z.string().optional().describe('Solo MongoDB: pipeline di aggregazione in Extended JSON (array di stage); $out e $merge sono vietati'),
      sql: z.string().optional().describe('Solo MySQL/PostgreSQL: query SQL di sola lettura (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN); includi una LIMIT'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    const db = String(args.db || '').trim();
    if (!db) throw new Error('Parametro "db" mancante.');

    if (args.filtro && String(args.filtro).trim()) {
      if (args.sql && String(args.sql).trim()) {
        throw new Error('Usa "filtro" oppure "sql", non entrambi: sono due modi di dire la stessa cosa e insieme si sommerebbero.');
      }
      const coll = String(args.collection || '').trim();
      if (!coll) throw new Error('Con "filtro" serve anche "collection": il filtro dice QUALI righe, non da dove.');
      return jsonResult(await sess.strategy.collectionFind(db, coll, {
        filtro: args.filtro,
        sort: args.sort,
        projection: args.projection,
        skip: args.skip,
        limit: args.limit == null ? 50 : args.limit,
      }));
    }

    if (DbFactory.isSqlType(sess.dbType)) {
      const sql = String(args.sql || '').trim();
      if (!sql) {
        throw new Error(
          'Per MySQL/PostgreSQL usa "filtro" (strutturato, uguale su tutti i motori) '
          + 'oppure "sql" con una query di sola lettura.'
        );
      }
      assertReadOnlySql(sql);
      return jsonResult(await sess.strategy.collectionAggregate(db, null, { pipeline: sql, readOnly: true }));
    }

    if (args.sql && String(args.sql).trim()) {
      throw new Error('Il parametro "sql" vale solo per MySQL/PostgreSQL: su MongoDB usa "filter" (find) oppure "pipeline" (aggregazione).');
    }
    const coll = String(args.collection || '').trim();
    if (!coll) throw new Error('Parametro "collection" mancante.');
    if (args.pipeline && String(args.pipeline).trim()) {
      assertReadOnlyPipeline(args.pipeline);
      return jsonResult(await sess.strategy.collectionAggregate(db, coll, { pipeline: args.pipeline }));
    }
    if (args.filter && String(args.filter).trim()) {
      assertNoMongoServerJs(args.filter, 'Filtro MongoDB');
    }
    return jsonResult(await sess.strategy.collectionFind(db, coll, {
      filter: args.filter,
      sort: args.sort,
      projection: args.projection,
      skip: args.skip,
      limit: args.limit == null ? 50 : args.limit,
    }));
  });

  tool('get_shortest_path', {
    title: 'Cammino minimo tra due tabelle',
    description:
      'Trova il cammino minimo di relazioni tra due tabelle/collezioni nel database usando l\'algoritmo BFS. ' +
      'Analizza sia le relazioni esplicite (Foreign Key) che le relazioni implicite (*_id).',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
      from_table: z.string().describe('Nome della tabella/collection di partenza'),
      to_table: z.string().describe('Nome della tabella/collection di destinazione'),
      include_implicit: z.boolean().optional().describe('Includi relazioni implicite basate sui campi *_id (default: true)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db, from_table, to_table, include_implicit }) => {
    const sess = requireDbSession(connection_id);
    const schema = await sess.strategy.dbSchema(String(db || '').trim());
    const { computeShortestPath } = await caricaAnalisi();
    const res = computeShortestPath(schema, String(from_table || '').trim(), String(to_table || '').trim(), include_implicit !== false);
    if (!res) throw new Error(`Impossibile calcolare il cammino: tabella sorgente "${from_table}" o destinazione "${to_table}" non trovata nello schema.`);
    return jsonResult(res);
  });

  tool('analyze_dependencies', {
    title: 'Matrice delle dipendenze e ordine di seeding',
    description:
      'Esegue l\'analisi delle dipendenze tra le tabelle/collezioni del database. Identifica le tabelle Root ' +
      '(indipendenti, senza FK uscenti), le tabelle Leaf (foglia, terminali) e calcola l\'ordine topologico ottimale di seeding.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
      include_implicit: z.boolean().optional().describe('Includi relazioni implicite basate sui campi *_id (default: false)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db, include_implicit }) => {
    const sess = requireDbSession(connection_id);
    const schema = await sess.strategy.dbSchema(String(db || '').trim());
    const { analyzeDependencies } = await caricaAnalisi();
    return jsonResult(analyzeDependencies(schema, !!include_implicit));
  });

  tool('analyze_pii', {
    title: 'Analisi dati sensibili (PII / GDPR)',
    description:
      'Scansiona la struttura del database per identificare campi e colonne contenenti dati personali o sensibili ' +
      '(email, password, telefoni, codice fiscale, carte di credito, IBAN, token, ecc.) secondo la normativa GDPR/PII.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db }) => {
    const sess = requireDbSession(connection_id);
    const schema = await sess.strategy.dbSchema(String(db || '').trim());
    const { analyzePii } = await caricaAnalisi();
    return jsonResult(analyzePii(schema));
  });

  tool('audit_schema', {
    title: 'Diagnostica e audit dello schema',
    description:
      'Esegue una diagnosi dello stato di salute dello schema del database: rileva tabelle orfane, tabelle oversize (>25 campi), ' +
      'tabelle senza chiave primaria (PK) e calcola un punteggio complessivo di salute (0-100), con penalità proporzionali alla dimensione dello schema.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db }) => {
    const sess = requireDbSession(connection_id);
    const schema = await sess.strategy.dbSchema(String(db || '').trim());
    const { auditSchema } = await caricaAnalisi();
    return jsonResult(auditSchema(schema));
  });

  tool('filter_empty_tables', {
    title: 'Identifica tabelle vuote',
    description:
      'Identifica ed elenca le tabelle o collezioni che sono completamente vuote (0 righe/documenti) o senza campi, ' +
      'consentendo all\'AI di concentrare l\'analisi sulle sole entità popolate.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db }) => {
    const sess = requireDbSession(connection_id);
    const dbName = String(db || '').trim();
    const collections = await sess.strategy.listCollections(dbName);
    const emptyTables = collections.filter((c) => (c.count != null && c.count === 0) || (c.size != null && c.size === 0)).map((c) => c.name);
    const nonEmptyTables = collections.filter((c) => !emptyTables.includes(c.name)).map((c) => c.name);
    return jsonResult({
      empty_tables: emptyTables,
      non_empty_tables: nonEmptyTables,
      empty_count: emptyTables.length,
      total_count: collections.length,
    });
  });

  tool('get_graph', {
    title: 'Struttura Grafo Database (Nodi & Archi 3D/2D)',
    description:
      'Restituisce la struttura del grafo relazionale (Graph 3D/2D) del database in forma di nodi ed archi, ' +
      'pronta per il rendering 3D/2D o l\'analisi di rete. Include degree centrality, campi e relazioni (esplicite ed implicite).',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
      include_implicit: z.boolean().optional().describe('Includi relazioni implicite basate sui campi *_id (default: true)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db, include_implicit }) => {
    const sess = requireDbSession(connection_id);
    const schema = await sess.strategy.dbSchema(String(db || '').trim());
    return jsonResult(await buildGraphData(schema, include_implicit !== false));
  });
}

module.exports = { registraStrumentiLettura };
