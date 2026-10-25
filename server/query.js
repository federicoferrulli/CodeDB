'use strict';

// CodeDB — query. Stato e dipendenze appartengono alla singola istanza.
const { isWriteSql, isWriteMongoPipeline, assertNoMongoServerJs } = require('../auth/capabilities');
const { payloadEsecuzione, assertPayloadEsecuzione } = require('../db/payloadEsecuzione');
const SqlToMql = require('../db/SqlToMql');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');
const { conSessioneSql } = require('../db/sqlSessione');
const MongoScriptRunner = require('../db/MongoScriptRunner');
const MongoShell = require('../db/MongoShell');
const { EJSON } = require('bson');

function documentoMongo(code) {
  const testo = code.trim().replace(/;\s*$/, '');
  try {
    JSON.parse(testo);
    // La strategia legge EJSON: riemettere il JSON con stringify arrotonderebbe gli interi lunghi.
    return testo;
  } catch {
    try { return JSON.stringify(MongoShell.parseDocument(testo)); }
    catch (err) { err.message = `Documento MongoDB non valido: ${err.message}`; throw err; }
  }
}

function createModule({ config, connessioni, dependencies }) {
  const mongoshAccess = session => require('../db/mongoshRuntime').autorizza(session, config.env);
  /* ---------------------------------------------------------------------------
   * Nome della tabella dedotto dal FROM di una query SQL.
   *
   * Serve come ETICHETTA (audit, bersaglio nominale): la verifica vera dello
   * scope sta in `auth/sqlTables.js`, che analizza tutti i nomi citati. Ma
   * un'etichetta sbagliata resta un difetto: `FROM diego."Prova"` registrava
   * "diego", cioè lo schema, perché la vecchia regex si fermava al punto e non
   * conosceva le virgolette.
   * ------------------------------------------------------------------------- */
  const ID_SQL = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z0-9_$\\-]+)';

  const RE_FROM_TABELLA = new RegExp(`FROM\\s+(${ID_SQL}(?:\\s*\\.\\s*${ID_SQL})*)`, 'i');

  function ultimoSegmentoNome(qualificato) {
    const segmenti = String(qualificato || '').match(new RegExp(ID_SQL, 'g')) || [];
    const ultimo = segmenti.length ? segmenti[segmenti.length - 1] : '';
    // Via le virgolette: il nome che finisce nell'audit e nel confronto con lo
    // scope è quello vero, non la sua forma quotata.
    return ultimo.replace(/^[`"[]|[`"\]]$/g, '');
  }

  // `isWriteSql` e `isWriteMongoPipeline` vivono in auth/capabilities.js: audit e
  // motore dei permessi devono classificare collection:aggregate esattamente allo
  // stesso modo (SQL Raw di scrittura, pipeline con $out/$merge).

  // Le query libere rispettano i LIMIT espliciti, senza un tetto di righe
  // aggiunto dall'applicazione. Restano i budget di memoria e di tempo.
  const QUERY_ENGINE_MAX_ROWS = Infinity;

  // --- Runner di script (⚡ Query & Aggregate) ---------------------------------
  // Tetto di istruzioni per esecuzione: un file enorme va caricato col pannello a
  // blocchi (sql-chunker.js), non spedito in un solo evento — dividerlo costa
  // memoria proporzionale al testo e il socket ha un limite di payload.
  const MAX_SCRIPT_STATEMENTS = Math.max(parseInt(config.env.CODEDB_SCRIPT_MAX_STATEMENTS, 10) || 20000, 1);

  // Script contemporanei per sessione: più di così è quasi sempre un errore
  // dell'utente, e ognuno tiene occupata una connessione del pool.
  const MAX_SCRIPTS_PER_SESSION = 4;

  // Cadenza minima fra due eventi di progresso (ms). Errori, pause e fine
  // passano comunque: è solo l'avanzamento "normale" a essere diradato.
  const SCRIPT_PROGRESS_MS = 150;

  // Budget degli script MongoDB interpretati (db/MongoScriptRunner.js). Girano
  // DENTRO il processo CodeDB, quindi un ciclo infinito o una scrittura in massa
  // devono fermare sé stessi invece del server. I valori sono generosi per l'uso
  // normale (migrazioni, seed) e configurabili per chi ha bisogno di più.
  const SCRIPT_LIMITI = {
    tempoMs: Math.max(parseInt(config.env.CODEDB_SCRIPT_TIMEOUT_MS, 10) || 60000, 1000),
    chiamateDb: Math.max(parseInt(config.env.CODEDB_SCRIPT_MAX_DB_CALLS, 10) || 5000, 1),
  };

  // Campi del payload che solo il server può decidere: vengono rimossi da ogni
  // evento delegato prima di raggiungere le strategie (vedi delegate()).
  // `opHandle` è il descrittore dell'operazione annullabile, popolato qui: se lo
  // mandasse il client potrebbe farsi annullare le query altrui.
  const SERVER_ONLY_PAYLOAD_FIELDS = ['maxRows', 'opHandle'];

  // Gli operatori MongoDB che eseguono JavaScript lato server sono vietati anche
  // nel Query Engine della UI. La regola NON e' scritta qui: qui ce n'era una
  // copia, con un proprio elenco di operatori e un proprio messaggio, accanto a
  // quella autorevole di `auth/capabilities.js` e a una terza versione sotto
  // forma di espressione regolare sul testo di un messaggio d'errore. Tre
  // versioni della stessa regola sono tre occasioni di divergere.
  //
  // `testoIllegibile: 'ignora'` sostituisce il vecchio parse permissivo: quando
  // il testo non e' analizzabile, la scansione lascia correre perche' quel testo
  // verra' comunque riletto dal traduttore o dalla strategia, che lo rifiutera'
  // con il messaggio giusto. E' la stessa scelta di prima, ma dichiarata dal
  // chiamante invece che dedotta dal messaggio dell'eccezione.
  const vietaJsLatoServer = (code, label) =>
    assertNoMongoServerJs(code, label, { testoIllegibile: 'ignora' });

  /* ---------------------------------------------------------------------------
   * Host per l'interprete di script MongoDB.
   *
   * L'interprete (db/MongoScriptRunner.js) non conosce né strategie né sessioni:
   * riceve queste funzioni e null'altro. Il punto è che **passano tutte dalla
   * strategia della sessione**, che è già avvolta nel Proxy autorizzante: ogni
   * riga di script è quindi soggetta all'RBAC come qualsiasi altra operazione,
   * senza un solo controllo scritto qui dentro. Aggiungere un metodo
   * all'interprete non può aprire un buco, perché il varco resta uno solo.
   * ------------------------------------------------------------------------- */
  // `run` (facoltativo) è lo script in corso: le operazioni che MODIFICANO dati o
  // struttura vi lasciano un segno, così la voce di audit di chiusura può dire il
  // vero sulla categoria (CDB-69). Su uno script interpretato è l'unico momento in
  // cui la si conosce: il testo non lo dice, l'esecuzione sì.
  function mongoScriptHost(session, runId, opHandle, run = null) {
    let sessioniMongo;
    let sessioneComandi;
    const sessioni = () => sessioniMongo ||= require('../db/mongoSessioneScript').gestore(session.strategy.client);
    const esegui = (fn) => connessioni.executeWithReconnect(session, fn);
    const eseguiScrivendo = (fn) => {
      if (run) run.haScritto = true;
      return esegui(fn);
    };
    // Gli operatori che eseguono JavaScript sul SERVER MongoDB restano vietati
    // anche negli script: l'interprete gira nel processo CodeDB, `$where` no.
    // Il payload dell'interprete porta stringhe EJSON, ma un chiamante futuro
    // potrebbe passare l'oggetto già analizzato: la definizione unica accetta
    // entrambi, quindi non serve più distinguere qui.
    const controlla = (testo) => vietaJsLatoServer(testo, 'Query MongoDB dello script');

    const metodi = {
      // Stessa regola dichiarata del gestore `query:execute`: i campi del server
      // si impongono per rimozione e non perché scritti dopo lo spread.
      find: (db, coll, payload) => esegui((s) => s.collectionFind(db, coll, payloadEsecuzione({ ...payload, shell: true }, { runId, opHandle }))),
      aggregate: (db, coll, payload) => esegui((s) => coll == null
        ? s.mongoDatabaseAggregate(db, payloadEsecuzione(payload, { runId, opHandle }))
        : s.collectionAggregate(db, coll, payloadEsecuzione(payload, { runId, opHandle }))),
      explain: (db, coll, payload) => esegui((s) => s.collectionExplain(db, coll, payloadEsecuzione({ ...payload, shell: true }, { runId, opHandle }))),
      // `count` e `write` non ricevono campi del server e non hanno quindi nulla
      // da cui difendersi: il loro payload lo compone l'interprete (leggi/scrivi
      // in db/MongoScriptRunner.js) con un insieme CHIUSO di chiavi, e nessuna di
      // quelle chiavi ha un nome scelto da chi manda la richiesta.
      count: (db, coll, payload) => esegui((s) => s.collectionCount(db, coll, { ...payload, shell: true, runId, opHandle })),
      distinct: (db, coll, payload) => esegui((s) => s.mongoDistinct(db, coll, { ...payload, runId, opHandle })),
      metadata: (db, coll, payload) => esegui((s) => s.mongoShellRead(db, coll, { ...payload, runId, opHandle })),
      collectionInfos: (db, payload) => esegui((s) => s.mongoCollectionInfos(db, { ...payload, runId, opHandle })),
      index: (db, coll, payload) => eseguiScrivendo((s) => s.mongoShellIndex(db, coll, { ...payload, runId, opHandle })),
      command: async (db, command) => {
        const execute = async () => {
          const result = await eseguiScrivendo((s) => s.mongoCommand(db, { command, runId, opHandle }));
          sessioni().track(result?.cursor); return result;
        };
        if (require('../db/mongoSessioneScript').attiva()) return execute();
        sessioneComandi ||= sessioni().start();
        return sessioni().run(sessioneComandi, execute);
      },
      write: (db, coll, payload) => eseguiScrivendo((s) => s.shellWrite(db, coll, { ...payload, nativeResult: true, runId, opHandle })),
      startSession: options => sessioni().start(EJSON.deserialize(options || {}, { relaxed: true })),
      inSession: (id, fn) => sessioni().run(id, fn),
      sessionOperation: async (id, method, args) => require('../db/mongoEjson').serializza(await sessioni().operation(id, method, EJSON.deserialize(args || [], { relaxed: false }))),
      transaction: (id, fn, options) => sessioni().transaction(id, fn, EJSON.deserialize(options || {}, { relaxed: true })),
      close: () => sessioniMongo?.close(),
      listCollections: (db) => esegui((s) => s.mongoCollectionInfos(db, { nameOnly: true, runId, opHandle })),
      createCollection: (db, nome, options) => eseguiScrivendo((s) => s.createCollection(db, nome, options)),
      dropCollection: (db, coll) => eseguiScrivendo((s) => s.dropCollection(db, coll)),
      dropDatabase: (db) => eseguiScrivendo((s) => s.dropDatabase(db)),
      // L'interprete parla in termini di shell (`keys`/`options`), la strategia
      // ha il suo contratto (`fields`/`unique`/`name`): l'adattamento sta qui,
      // così nessuno dei due deve conoscere l'altro.
      createIndex: (db, coll, { keys, options }) => eseguiScrivendo((s) => s.createIndex(db, coll, {
        fields: JSON.stringify(keys || {}),
        unique: !!(options && options.unique),
        name: (options && options.name) || '',
        ...Object.fromEntries(['sparse', 'expireAfterSeconds', 'partialFilterExpression', 'collation', 'wildcardProjection']
          .filter(k => options && options[k] !== undefined).map(k => [k, options[k]])),
      })).then(r => r.name),
      dropIndex: (db, coll, nome) => eseguiScrivendo((s) => s.dropIndex(db, coll, nome)),
    };

    // Il controllo si applica UNA VOLTA SOLA, avvolgendo i metodi, invece di
    // essere ripetuto in ognuno: ripetendolo, `count` e `write` erano rimasti
    // scoperti e da uno script si arrivava a `$where` dentro la parte di
    // selezione di un update o di un delete — cioè JavaScript arbitrario nel
    // processo mongod, che decide anche QUALI documenti eliminare. Avvolgendo,
    // un metodo aggiunto in futuro nasce protetto: è la stessa ragione per cui
    // il Proxy autorizzante avvolge la strategia invece di controllare handler
    // per handler.
    const CAMPI_CON_JS = ['filter', 'pipeline', 'update', 'options'];
    const protetto = {};
    for (const [nome, fn] of Object.entries(metodi)) {
      protetto[nome] = (...args) => {
        for (const a of args) {
          if (!a || typeof a !== 'object') continue;
          for (const campo of CAMPI_CON_JS) if (a[campo] !== undefined) controlla(a[campo]);
        }
        return fn(...args);
      };
    }
    return protetto;
  }

  /**
   * Il comando porta con sé il nome del database su cui agisce (CREATE/DROP
   * DATABASE o SCHEMA), quindi non richiede un database già aperto.
   */
  function comandoConDbProprio(codeStr) {
    return /^\s*(CREATE|DROP)\s+(DATABASE|SCHEMA)\b/i.test(String(codeStr || ''));
  }

  /* ---------------------------------------------------------------------------
   * SQL di scrittura/DDL eseguito su MongoDB.
   *
   * `SqlToMql.translateWrite` produce un'operazione neutra; qui la si esegue
   * attraverso i metodi autorizzati della strategia. Il runtime SQL applica
   * schema e transazioni; l'host degli script gestisce il DDL documentale.
   * ------------------------------------------------------------------------- */
  async function eseguiSqlScritturaMongo(session, codeStr, targetDb, { runId, opHandle, fatto, conContesto, run }) {
    const op = 'SQL di scrittura (SQL→MongoDB)';
    let piano;
    try {
      piano = SqlToMql.translateWrite(codeStr);
    } catch (err) {
      throw conContesto(new Error(`Traduzione SQL→MongoDB non riuscita: ${err.message}`), 'write', op, targetDb, null);
    }

    const host = mongoScriptHost(session, runId, opHandle, run);
    const messaggio = (testo) => {
      const doc = { messaggio: testo, ...(piano.note ? { nota: piano.note } : {}) };
      return fatto({ docs: [doc], columns: Object.keys(doc) }, 'write', op, targetDb, piano.coll || null);
    };

    try {
      if (piano.kind === 'write') {
        if (run) run.haScritto = true;
        // I retry transazionali appartengono al driver: non rieseguire tutta
        // la scrittura dopo una disconnessione dall'esito incerto del commit.
        const res = await session.strategy.mongoSqlReturning(targetDb, piano.coll, { sql: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle });
        return fatto(res, 'write', op, targetDb, piano.coll);
      }
      if (piano.kind === 'ddl') {
        switch (piano.op) {
          case 'createDomain':
          case 'alterDomain':
          case 'dropDomain':
            await session.strategy.mongoSqlSchema(targetDb, piano.coll, { sql: codeStr, runId, opHandle });
            return messaggio(`Dominio "${piano.coll}" aggiornato.`);
          case 'alterTable':
            await session.strategy.mongoSqlSchema(targetDb, piano.coll, { sql: codeStr, runId, opHandle });
            return messaggio(`Tabella "${piano.coll}" modificata.`);
          case 'createIndex':
            await host.createIndex(targetDb, piano.coll, piano);
            return messaggio(`Indice "${piano.options.name}" creato su "${piano.coll}".`);
          case 'dropIndex':
            await session.strategy.mongoSqlSchema(targetDb, piano.coll, { sql: codeStr, runId, opHandle });
            return messaggio(`Indice "${piano.name}" eliminato da "${piano.coll}".`);
          case 'createCollection':
            if (piano.schema) await session.strategy.mongoSqlSchema(targetDb, piano.coll, { sql: codeStr, runId, opHandle });
            else await host.createCollection(targetDb, piano.coll);
            return messaggio(`Collezione "${piano.coll}" creata in "${targetDb}".`);
          case 'dropCollection':
            await session.strategy.mongoSqlSchema(targetDb, piano.coll, { sql: codeStr, runId, opHandle });
            return messaggio(`Collezione "${piano.coll}" eliminata da "${targetDb}".`);
          case 'createDatabase':
            // Su MongoDB il database nasce con la prima collezione: la strategia
            // lo sa fare (createDatabase crea una collezione iniziale).
            await connessioni.executeWithReconnect(session, (s) => s.createDatabase(piano.db));
            return fatto(
              { docs: [{ messaggio: `Database "${piano.db}" creato.`, nota: piano.note }], columns: ['messaggio', 'nota'] },
              'write', op, piano.db, null
            );
          case 'dropDatabase':
            await host.dropDatabase(piano.db);
            return fatto(
              { docs: [{ messaggio: `Database "${piano.db}" eliminato.` }], columns: ['messaggio'] },
              'write', op, piano.db, null
            );
          default:
            throw new Error(`Operazione DDL non gestita: ${piano.op}`);
        }
      }

    } catch (err) {
      throw conContesto(err, 'write', op, targetDb, piano.coll || null);
    }
  }

  /* ---------------------------------------------------------------------------
   * Esecuzione di UN blocco di codice del Query Engine.
   *
   * Estratta dal gestore `query:execute` perché serve a DUE chiamanti: la query
   * singola e il runner di script, che la invoca per ogni istruzione. Tenerla in
   * un solo posto è ciò che garantisce che sintassi shell, SQL→MQL, `USE`,
   * pipeline e SQL Raw si comportino IDENTICAMENTE dentro e fuori da uno script —
   * comprese le regole di sicurezza (divieto del JavaScript lato server,
   * bersaglio non vuoto) e
   * il passaggio dal Proxy autorizzante, che vede una chiamata di strategia per
   * istruzione e ne decide la capability.
   *
   * Non scrive audit: restituisce categoria e descrizione dell'operazione
   * (`category`/`op`) e, in caso di errore, le allega all'eccezione in
   * `err.auditCtx`. Chi chiama decide se e come tracciare — la query singola
   * traccia sempre, lo script traccia le scritture e un riepilogo.
   *
   * @returns {Promise<{res:object, category:'read'|'write', op:string, db:string, coll:string|null, code:string}>}
   * ------------------------------------------------------------------------- */
  /**
   * Un Virtual JOIN contiene scritture? (CDB-16)
   *
   * Le sorgenti possono portare una pipeline MongoDB (`$out`/`$merge`) o dell'SQL
   * grezzo: si usano le STESSE funzioni dei permessi, così audit e autorizzazione
   * non possono divergere. Ritorna 'write' oppure null.
   */
  function categoriaVirtualJoin(spec) {
    const vj = spec && spec.virtualJoin;
    if (!vj) return null;
    for (const src of [vj.sourceA, vj.sourceB]) {
      if (!src || !src.query) continue;
      const q = src.query;
      if (typeof q === 'string') {
        if (isWriteSql(q)) return 'write';
        try { if (isWriteMongoPipeline(JSON.parse(q))) return 'write'; } catch { /* non è JSON */ }
      } else if (isWriteMongoPipeline(q)) {
        return 'write';
      }
    }
    return null;
  }

  async function executeQueryCode(session, payload) {
    try {
      return await conSessioneSql(payload.run?.sqlScope || payload.run || session, () => eseguiQueryNelContesto(session, payload),
        !!payload.run || dependencies.DbFactory.isSqlType(session.strategy.type));
    } catch (err) {
      if (err.queryError) {
        const source = String(payload.code || '');
        const offset = source.length - source.trimStart().length;
        err.queryError = { ...err.queryError, start: err.queryError.start + offset, end: err.queryError.end + offset };
      } else if (session.strategy.type === 'mongodb') {
        require('../db/queryError').annotaErroreQuery(err, payload.code, 'mongodb');
      }
      throw err;
    }
  }

  async function eseguiQueryNelContesto(session, payload) {
    // Dentro questa funzione l'origine di una chiave non è più distinguibile:
    // che i campi imposti dal server non vengano dal client lo garantisce la
    // regola dichiarata in db/payloadEsecuzione.js, e qui si pretende che ci sia
    // passata.
    assertPayloadEsecuzione(payload);
    let { code, engine, db, coll, runId, opHandle, run } = payload;
    const codeOriginale = String(code || '').trim();
    // I commenti iniziali non decidono la lingua. Il testo originale resta nell'audit e nell'SQL inviato al driver.
    const codeStr = codeOriginale.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\/[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*(?![!+])[\s\S]*?\*\/)*/, '').trim();

    if (!codeStr) {
      throw new Error('Codice query vuoto.');
    }

    const fatto = (res, category, op, dbUsato, collUsata) => {
      if (res.truncated) {
        throw new Error('Risultato incompleto: la query supera il budget di memoria dei risultati. '
          + 'Restringi la query con filtri o un LIMIT esplicito, oppure aumenta CODEDB_MAX_RESULT_BYTES.');
      }
      return { res, category, op, db: dbUsato || null, coll: collUsata || null, code: codeOriginale };
    };
    // L'errore porta con sé il contesto di audit: senza, il chiamante non saprebbe
    // su quale db/coll è fallita l'operazione né come classificarla.
    const conContesto = (err, category, op, dbUsato, collUsata) => {
      err.auditCtx = { category, op, db: dbUsato || null, coll: collUsata || null, code: codeOriginale };
      return err;
    };

    if (engine === 'mongosh') {
      try {
        mongoshAccess(session);
        if (session.mongosh?.closing) await session.mongosh.closing;
        if (!session.mongosh || session.mongosh.closed) {
          const { MongoshRuntime } = require('../db/mongoshRuntime');
          session.mongosh = new MongoshRuntime(session.strategy.uri, {
            timeout: Math.max(100, Number(config.env.CODEDB_MONGOSH_TIMEOUT_MS) || 60000),
            maxBytes: require('../db/DbStrategy').maxResultBytes(config.env),
            onEvent: event => session.emitMongosh?.(event),
          });
        }
        if (run) run.haScritto = true;
        const res = await session.mongosh.evaluate(codeOriginale, db, opHandle);
        return fatto(res, 'write', 'Runtime mongosh nativo', res.activeDb, coll);
      } catch (err) { throw conContesto(err, 'write', 'Runtime mongosh nativo', db, coll); }
    }

    if (['mysql', 'postgresql', 'mongodb'].includes(engine) && engine !== session.strategy.type) {
      throw new Error(`Il motore ${engine} richiede una connessione ${engine}. Apri una copia della query sulla connessione SQL nativa dal menu del bersaglio.`);
    }

    // Modalità Cross-DB (Virtual Join)
    let specJoin;
    if ((!engine || engine === 'auto') && codeStr.startsWith('{')) {
      try {
        const parsed = JSON.parse(codeStr);
        if (parsed.virtualJoin?.sourceA && parsed.virtualJoin?.sourceB && parsed.virtualJoin?.on) specJoin = parsed;
      } catch { /* Un filtro MQL può usare la sintassi shell anziché JSON. */ }
    }
    if (engine === 'crossdb' || specJoin) {
      let spec = specJoin;
      try {
        spec ||= JSON.parse(codeStr);
      } catch (err) {
        throw new Error('La query Virtual Join deve essere un oggetto JSON valido: ' + err.message);
      }
      // Categoria reale anche qui (CDB-16): le due sorgenti di un Virtual JOIN
      // portano codice dell'utente (una pipeline MongoDB o dell'SQL), che può
      // benissimo essere una scrittura — `$out`/`$merge`, o un DELETE nel ramo
      // SQL. I PERMESSI erano comunque corretti, perché il Proxy autorizzante
      // classifica `collectionAggregate` guardando ciò che riceve; era l'audit a
      // registrare sempre "lettura", cioè a non lasciare traccia della modifica.
      const catJoin = categoriaVirtualJoin(spec) || 'read';
      try {
        const sorgente = (source) => {
          if (!source) throw new Error('Sorgente Virtual JOIN mancante.');
          const sessions = payload.sessions || new Map([['default', session]]);
          const candidati = [...sessions.entries()].filter(([id, s]) => !s.closed && s.strategy
            && (!source.tabId || id === source.tabId)
            && (!source.connection || s.connName === source.connection)
            && (!source.dbType || s.strategy.type === source.dbType || (source.dbType === 'postgres' && s.strategy.type === 'postgresql')));
          if (candidati.length !== 1) throw new Error('Sorgente Virtual JOIN assente o ambigua: indica connection (nome salvato) oppure tabId di una connessione aperta.');
          return candidati[0][1].strategy;
        };
        const docs = await VirtualJoinEngine.execute(spec, sorgente(spec.virtualJoin?.sourceA), sorgente(spec.virtualJoin?.sourceB));
        return fatto({ docs }, catJoin, 'Virtual JOIN Cross-DB', db, coll);
      } catch (err) {
        throw conContesto(err, catJoin, 'Virtual JOIN Cross-DB', db, coll);
      }
    }

    // Riconoscimento ed esecuzione del comando USE <dbname> (o use <dbname>;)
    const useCmdMatch = codeStr.match(/^\s*(?:USE|use)\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?\s*;?\s*$/i);
    if (useCmdMatch && session.strategy.type !== 'mysql') {
      const newDb = useCmdMatch[1];
      session.strategy.currentDb = newDb;
      const summaryDoc = { messaggio: `Database attivo cambiato in "${newDb}"`, activeDb: newDb };
      return fatto(
        { docs: [summaryDoc], columns: Object.keys(summaryDoc), activeDb: newDb },
        'write', 'Cambio Database (USE)', newDb, null
      );
    }

    // Estrazione automatica della collezione/tabella dal FROM della query SQL (es. SELECT * FROM pippo).
    // È un'ETICHETTA (audit, bersaglio nominale), non una barriera: il nome è
    // dedotto dal primo FROM e, se manca, arriva dal client, mentre la stringa SQL
    // viene eseguita verbatim. Lo scope su SQL libero è verificato sui nomi
    // CITATI nella query, dal Proxy autorizzante (auth/sqlTables.js, CDB-A03).
    // Il nome può essere qualificato e quotato — `FROM diego."Prova"` — e in quel
    // caso la tabella è l'ULTIMO segmento: la vecchia regex si fermava al punto e
    // registrava lo schema ("diego") come se fosse la tabella, sia nell'audit sia
    // nel bersaglio confrontato con lo scope.
    const sqlFromMatch = codeStr.match(RE_FROM_TABELLA);
    const extractedColl = sqlFromMatch ? ultimoSegmentoNome(sqlFromMatch[1]) : null;
    const targetColl = extractedColl || coll;
    const targetDb = db || session.strategy.currentDb || 'admin';

    // Il bersaglio deve essere un nome vero: `targetDb`/`targetColl` sono ciò
    // su cui il Proxy autorizzante confronta lo scope, e un valore vuoto
    // faceva cadere il confronto (vedi matchesAny). Meglio un errore
    // comprensibile che una query eseguita senza il controllo di ambito.
    //
    // Eccezione: i comandi che CREANO un database (o lo eliminano) portano il
    // nome con sé e non hanno bisogno di un database "corrente". Pretenderlo
    // rendeva impossibile la cosa più ovvia — creare un database da zero —
    // proprio a chi non ne aveva ancora aperto uno. Il controllo dei permessi
    // resta: lo fa il Proxy sul nome indicato nel comando.
    if (!String(targetDb || '').trim() && !comandoConDbProprio(codeStr)) {
      throw new Error('Nessun database selezionato: apri un database nella sidebar oppure usa "USE <database>" prima della query.');
    }

    // Modalità SQL (MySQL e PostgreSQL: Strategy Pattern, stesso "SQL Raw").
    if (dependencies.DbFactory.isSqlType(session.strategy.type)) {
      const write = isWriteSql(codeStr);
      const cat = write ? 'write' : 'read';
      const op = write ? 'Query di scrittura (SQL)' : 'Query di lettura (SQL)';
      try {
        const res = await connessioni.executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline: codeOriginale, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
        if (res.activeDb) session.strategy.currentDb = res.activeDb;
        return fatto(res, cat, op, targetDb, targetColl);
      } catch (err) {
        throw conContesto(err, cat, op, targetDb, targetColl);
      }
    }

    // Modalità NoSQL (MongoDB)
    if (engine === 'mongodb' || session.strategy.type === 'mongodb') {
      const triggers = require('../db/sqlTriggerMongo');
      if (triggers.riconosci(codeStr)) {
        const plan = triggers.parse(codeStr);
        if (run) run.haScritto = true;
        const res = await session.strategy.mongoSqlTrigger(targetDb, plan.coll, { sql: codeStr, runId, opHandle });
        return fatto(res, 'write', 'Trigger SQL su MongoDB', targetDb, plan.coll);
      }
      const procedures = require('../db/sqlProcedureMongo');
      if (procedures.riconosci(codeStr)) {
        const plan = procedures.parse(codeStr);
        if (run) run.haScritto = true;
        const res = await session.strategy.mongoSqlProcedure(targetDb, plan.name, { sql: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle });
        return fatto(res, 'write', 'Procedura SQL su MongoDB', targetDb, plan.name);
      }
      // Esecuzione tramite l'INTERPRETE (db/MongoScriptRunner.js): l'unico
      // percorso MongoDB che sa eseguire scritture, cicli e funzioni.
      const eseguiScriptMongo = async () => {
        const op = 'Script MongoDB';
        const host = mongoScriptHost(session, runId, opHandle, run);
        try {
          const esito = await MongoScriptRunner.eseguiScript(
            codeOriginale,
            host,
            {
              db: targetDb,
              runId,
              interrotto: () => !!(opHandle && opHandle.interrotto),
              limiti: SCRIPT_LIMITI,
            }
          );
          // I `print()` diventano documenti, così l'output dello script è
          // visibile nella stessa griglia dei risultati invece di sparire.
          const docs = esito.output.length
            ? esito.output.map((riga, i) => ({ '#': i + 1, output: riga }))
            : esito.docs;
          return fatto(
            { docs, columns: docs.length ? Object.keys(docs[0]) : [], scriptOutput: esito.output, dbCalls: esito.chiamateDb, resultSet: true },
            'write', op, targetDb, targetColl
          );
        } catch (err) {
          // La riga dell'errore, quando c'è, è l'informazione più utile.
          if (err && err.scriptLine && !/riga \d+/.test(err.message)) {
            err.message = `${err.message} (riga ${err.scriptLine})`;
          }
          throw conContesto(err, 'write', op, targetDb, targetColl);
        } finally {
          await host.close();
        }
      };

      // SCRIPT JavaScript (var/let/const, for, if, funzioni...): non è un comando
      // shell singolo né una SELECT, va INTERPRETATO. Non passa dalla divisione
      // per `;`, che non conosce i blocchi `{ … }` e spezzerebbe un ciclo a metà.
      if (MongoScriptRunner.sembraScriptJs(codeStr)) return eseguiScriptMongo();

      // SQL di SCRITTURA o DDL su MongoDB: `INSERT INTO`, `UPDATE`, `DELETE`,
      // `CREATE TABLE`, `DROP DATABASE`… Tradotti nelle stesse operazioni che usa
      // l'interprete, quindi soggetti al Proxy autorizzante allo stesso modo.
      if (SqlToMql.looksLikeSqlWrite(codeStr)) {
        return eseguiSqlScritturaMongo(session, codeStr, targetDb, { runId, opHandle, fatto, conContesto, run });
      }

      let res;
      let cat = 'read';
      let op = 'Query di lettura (MQL)';
      // Collection effettivamente interrogata: shell/SQL possono indicarne una
      // diversa da quella attiva (plan.coll); l'audit deve registrare questa.
      let queryColl = targetColl;
      try {
        if (codeStr.startsWith('[')) {
          // Pipeline MQL EJSON (scrittura solo con $out/$merge)
          if (!targetColl) throw new Error('Seleziona una collezione dallo Schema Browser o apri un tab collezione.');
          const pipeline = documentoMongo(codeStr);
          vietaJsLatoServer(pipeline, 'Pipeline MongoDB');
          if (isWriteMongoPipeline(pipeline)) { cat = 'write'; op = 'Pipeline di scrittura ($out/$merge)'; }
          else { op = 'Aggregazione (pipeline)'; }
          res = await connessioni.executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
        } else if (codeStr.startsWith('{')) {
          // MQL Filter JSON: il filtro va passato come payload.filter (stringa),
          // non come intero payload, altrimenti collectionFind lo ignorerebbe.
          const filter = documentoMongo(codeStr);
          if (!targetColl) throw new Error('Seleziona una collezione dallo Schema Browser o apri un tab collezione.');
          vietaJsLatoServer(filter, 'Filtro MongoDB');
          op = 'Query di lettura (filtro MQL)';
          res = await connessioni.executeWithReconnect(session, (strat) => strat.collectionFind(targetDb, targetColl, { filter, shell: true, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
        } else {
          // Né JSON né pipeline: prova la sintassi nativa shell (db.coll.find...)
          // oppure una SELECT SQL. Entrambe producono lo stesso "plan".
          let plan = null;
          let planLabel = '';
          if (MongoShell.looksLikeShell(codeStr)) {
            try {
              plan = MongoShell.translate(codeStr);
            } catch (e) {
              // Il traduttore produce solo piani di lettura. Se il comando è una
              // SCRITTURA (o un metodo che non conosce) non è un errore: è roba
              // da interprete, che la esegue davvero. Prima era un vicolo cieco.
              if (e.scritturaShell || e.metodoSconosciuto) return eseguiScriptMongo();
              e.message = 'Comando shell MongoDB non valido: ' + e.message;
              throw e;
            }
            planLabel = 'shell';
          } else if (SqlToMql.looksLikeSql(codeStr)) {
            try {
              plan = SqlToMql.translate(codeStr);
            } catch (e) {
              throw new Error('Traduzione SQL→MongoDB non riuscita: ' + e.message);
            }
            planLabel = 'SQL→MQL';
          }

          if (plan) {
            if (planLabel === 'SQL→MQL' && !plan.explain) {
              const result = await connessioni.executeWithReconnect(session, strat => strat.mongoSqlRead(targetDb, undefined,
                { sql: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
              return fatto(result, 'read', 'Query SQL→MQL', targetDb, plan.coll);
            }
            vietaJsLatoServer(plan.options, 'Opzioni MongoDB');
            const collName = plan.coll || targetColl;
            if (!collName) throw new Error('Collezione non specificata nel comando.');
            queryColl = collName;
            if (plan.explain) {
              vietaJsLatoServer(plan.pipeline || plan.filter, 'Query MongoDB');
              const explanation = await connessioni.executeWithReconnect(session, strat => strat.collectionExplain(targetDb, collName, {
                mode: plan.kind, shell: planLabel === 'shell', filter: EJSON.stringify(plan.filter), pipeline: EJSON.stringify(plan.pipeline),
                sort: EJSON.stringify(plan.sort), projection: EJSON.stringify(plan.projection),
                limit: plan.limit, skip: plan.skip, verbosity: plan.explain, options: EJSON.stringify(plan.options || {}), runId, opHandle,
              }));
              return fatto({ docs: [explanation.plan], columns: Object.keys(explanation.plan), resultSet: true }, cat, 'Piano MongoDB', targetDb, collName);
            }
            if (plan.kind === 'aggregate') {
              vietaJsLatoServer(plan.pipeline, 'Pipeline MongoDB');
              op = `Query di lettura (${planLabel} aggregate)`;
              res = await connessioni.executeWithReconnect(session, (strat) =>
                strat.collectionAggregate(targetDb, collName, { pipeline: EJSON.stringify(plan.pipeline), options: EJSON.stringify(plan.options || {}), maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
            } else {
              vietaJsLatoServer(plan.filter, 'Filtro MongoDB');
              op = `Query di lettura (${planLabel})`;
              res = await connessioni.executeWithReconnect(session, (strat) =>
                strat.collectionFind(targetDb, collName, {
                  filter: EJSON.stringify(plan.filter),
                  projection: EJSON.stringify(plan.projection),
                  sort: EJSON.stringify(plan.sort),
                  limit: plan.limit,
                  skip: plan.skip,
                  options: EJSON.stringify(plan.options || {}),
                  maxRows: QUERY_ENGINE_MAX_ROWS,
                  runId,
                  opHandle,
                  shell: planLabel === 'shell'
                }));
            }
          } else if (targetColl && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(codeStr)) {
            // Un nome secco (la collezione aperta): mostra i suoi documenti.
            res = await connessioni.executeWithReconnect(session, (strat) => strat.collectionFind(targetDb, targetColl, { filter: '', maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
          } else {
            // Non è JSON, non è una pipeline, non è shell di lettura né SQL:
            // l'ultima possibilità sensata è che sia codice da interpretare
            // (`print(...)`, una chiamata, un'espressione). Prima si finiva qui
            // con un "seleziona una collezione" che non spiegava nulla.
            return eseguiScriptMongo();
          }
        }
      } catch (err) {
        if (err.queryError) {
          const offset = codeOriginale.length - codeStr.length;
          err.queryError = { ...err.queryError, start: err.queryError.start + offset, end: err.queryError.end + offset };
        }
        throw conContesto(err, cat, op, targetDb, queryColl);
      }
      return fatto(res, cat, op, targetDb, queryColl);
    }

    throw new Error('Target Engine non supportato.');
  }

  return {
    MAX_SCRIPT_STATEMENTS,
    MAX_SCRIPTS_PER_SESSION,
    SCRIPT_PROGRESS_MS,
    SERVER_ONLY_PAYLOAD_FIELDS,
    mongoshAccess,
    executeQueryCode
  };
}

module.exports = { createModule };
