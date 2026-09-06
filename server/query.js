'use strict';

// CodeDB — query. Stato e dipendenze appartengono alla singola istanza.
const { isWriteSql, isWriteMongoPipeline, assertNoMongoServerJs } = require('../auth/capabilities');
const { payloadEsecuzione, assertPayloadEsecuzione } = require('../db/payloadEsecuzione');
const SqlToMql = require('../db/SqlToMql');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');
const MongoScriptRunner = require('../db/MongoScriptRunner');
const MongoShell = require('../db/MongoShell');

function createModule({ config, connessioni, dependencies }) {
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
      find: (db, coll, payload) => esegui((s) => s.collectionFind(db, coll, payloadEsecuzione(payload, { runId, opHandle }))),
      aggregate: (db, coll, payload) => esegui((s) => s.collectionAggregate(db, coll, payloadEsecuzione(payload, { runId, opHandle }))),
      // `count` e `write` non ricevono campi del server e non hanno quindi nulla
      // da cui difendersi: il loro payload lo compone l'interprete (leggi/scrivi
      // in db/MongoScriptRunner.js) con un insieme CHIUSO di chiavi, e nessuna di
      // quelle chiavi ha un nome scelto da chi manda la richiesta.
      count: (db, coll, payload) => esegui((s) => s.collectionCount(db, coll, payload)),
      write: (db, coll, payload) => eseguiScrivendo((s) => s.shellWrite(db, coll, payload)),
      listCollections: (db) => esegui((s) => s.listCollections(db)),
      createCollection: (db, nome) => eseguiScrivendo((s) => s.createCollection(db, nome)),
      dropCollection: (db, coll) => eseguiScrivendo((s) => s.dropCollection(db, coll)),
      dropDatabase: (db) => eseguiScrivendo((s) => s.dropDatabase(db)),
      // L'interprete parla in termini di shell (`keys`/`options`), la strategia
      // ha il suo contratto (`fields`/`unique`/`name`): l'adattamento sta qui,
      // così nessuno dei due deve conoscere l'altro.
      createIndex: (db, coll, { keys, options }) => eseguiScrivendo((s) => s.createIndex(db, coll, {
        fields: JSON.stringify(keys || {}),
        unique: !!(options && options.unique),
        name: (options && options.name) || '',
      })),
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
    const CAMPI_CON_JS = ['filter', 'pipeline', 'update'];
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
   * usando le STESSE funzioni dell'interprete di script (mongoScriptHost), così
   * esiste un solo percorso di scrittura verso MongoDB e un solo punto in cui
   * l'RBAC si applica.
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
      if (piano.kind === 'ddl') {
        switch (piano.op) {
          case 'createCollection':
            await host.createCollection(targetDb, piano.coll);
            return messaggio(`Collezione "${piano.coll}" creata in "${targetDb}".`);
          case 'dropCollection':
            await host.dropCollection(targetDb, piano.coll);
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

      // Scritture sui dati: stesso metodo `shellWrite` usato dagli script.
      const payload = { op: piano.op };
      if (piano.op === 'insertOne') payload.doc = JSON.stringify(piano.docs[0]);
      if (piano.op === 'insertMany') payload.docs = JSON.stringify(piano.docs);
      if (piano.filter !== undefined) payload.filter = JSON.stringify(piano.filter);
      if (piano.update !== undefined) payload.update = JSON.stringify(piano.update);

      const res = await host.write(targetDb, piano.coll, payload);
      const doc = { operazione: piano.op, collezione: piano.coll, ...res, ...(piano.note ? { nota: piano.note } : {}) };
      return fatto({ docs: [doc], columns: Object.keys(doc) }, 'write', op, targetDb, piano.coll);
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
    // Dentro questa funzione l'origine di una chiave non è più distinguibile:
    // che i campi imposti dal server non vengano dal client lo garantisce la
    // regola dichiarata in db/payloadEsecuzione.js, e qui si pretende che ci sia
    // passata.
    assertPayloadEsecuzione(payload);
    let { code, engine, db, coll, runId, opHandle, run } = payload;
    const codeStr = String(code || '').trim();

    if (!codeStr) {
      throw new Error('Codice query vuoto.');
    }

    const fatto = (res, category, op, dbUsato, collUsata) => {
      if (res.truncated) {
        throw new Error('Risultato incompleto: la query supera il budget di memoria dei risultati. '
          + 'Restringi la query con filtri o un LIMIT esplicito, oppure aumenta CODEDB_MAX_RESULT_BYTES.');
      }
      return { res, category, op, db: dbUsato || null, coll: collUsata || null, code: codeStr };
    };
    // L'errore porta con sé il contesto di audit: senza, il chiamante non saprebbe
    // su quale db/coll è fallita l'operazione né come classificarla.
    const conContesto = (err, category, op, dbUsato, collUsata) => {
      err.auditCtx = { category, op, db: dbUsato || null, coll: collUsata || null, code: codeStr };
      return err;
    };

    // Modalità Cross-DB (Virtual Join)
    if (engine === 'crossdb' || codeStr.includes('"virtualJoin"')) {
      let spec;
      try {
        spec = JSON.parse(codeStr);
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
        const docs = await connessioni.executeWithReconnect(session, (strat) => VirtualJoinEngine.execute(spec, strat, strat));
        return fatto({ docs }, catJoin, 'Virtual JOIN Cross-DB', db, coll);
      } catch (err) {
        throw conContesto(err, catJoin, 'Virtual JOIN Cross-DB', db, coll);
      }
    }

    // Riconoscimento ed esecuzione del comando USE <dbname> (o use <dbname>;)
    const useCmdMatch = codeStr.match(/^\s*(?:USE|use)\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?\s*;?\s*$/i);
    if (useCmdMatch) {
      const newDb = useCmdMatch[1];
      session.strategy.currentDb = newDb;
      const summaryDoc = { messaggio: `Database attivo cambiato in "${newDb}"`, activeDb: newDb };
      return fatto(
        { docs: [summaryDoc], columns: Object.keys(summaryDoc), activeDb: newDb },
        'write', 'Cambio Database (USE)', newDb, null
      );
    }

    // Se il codice inizia con USE <dbname>; seguito da ulteriori istruzioni
    const usePrefixMatch = codeStr.match(/^\s*(?:USE|use)\s+[`"]?([a-zA-Z0-9_\-]+)[`"]?\s*;?\s*\n?/i);
    if (usePrefixMatch && codeStr.trim().length > usePrefixMatch[0].trim().length) {
      const newDb = usePrefixMatch[1];
      session.strategy.currentDb = newDb;
      db = newDb;
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
    if (engine === 'mysql' || engine === 'postgresql' || dependencies.DbFactory.isSqlType(session.strategy.type)) {
      // Su PostgreSQL il pool è legato a `cfg.database` e nella UI il livello
      // "database" È LO SCHEMA: un CREATE DATABASE non può essere eseguito dal
      // pool (non è ammesso in transazione) e comunque il risultato non
      // comparirebbe mai nella sidebar. Meglio dirlo che lasciar fallire con un
      // errore del driver che non spiega nulla.
      if (session.strategy.type === 'postgresql' && /^\s*CREATE\s+DATABASE\b/i.test(codeStr)) {
        throw new Error('Su PostgreSQL la connessione è legata a un database e nella sidebar il livello "database" corrisponde allo SCHEMA: usa "CREATE SCHEMA <nome>" per creare un contenitore visibile qui. Per un nuovo database serve una connessione separata.');
      }

      const write = isWriteSql(codeStr);
      const cat = write ? 'write' : 'read';
      const op = write ? 'Query di scrittura (SQL)' : 'Query di lettura (SQL)';
      try {
        const res = await connessioni.executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
        return fatto(res, cat, op, targetDb, targetColl);
      } catch (err) {
        throw conContesto(err, cat, op, targetDb, targetColl);
      }
    }

    // Modalità NoSQL (MongoDB)
    if (engine === 'mongodb' || session.strategy.type === 'mongodb') {
      // Esecuzione tramite l'INTERPRETE (db/MongoScriptRunner.js): l'unico
      // percorso MongoDB che sa eseguire scritture, cicli e funzioni.
      const eseguiScriptMongo = async () => {
        const op = 'Script MongoDB';
        try {
          const esito = await MongoScriptRunner.eseguiScript(
            codeStr,
            mongoScriptHost(session, runId, opHandle, run),
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
          vietaJsLatoServer(codeStr, 'Pipeline MongoDB');
          if (isWriteMongoPipeline(codeStr)) { cat = 'write'; op = 'Pipeline di scrittura ($out/$merge)'; }
          else { op = 'Aggregazione (pipeline)'; }
          res = await connessioni.executeWithReconnect(session, (strat) => strat.collectionAggregate(targetDb, targetColl, { pipeline: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
        } else if (codeStr.startsWith('{')) {
          // MQL Filter JSON: il filtro va passato come payload.filter (stringa),
          // non come intero payload, altrimenti collectionFind lo ignorerebbe.
          let parsed;
          try {
            parsed = JSON.parse(codeStr);
          } catch (e) {
            throw new Error('Filtro JSON MongoDB non valido: ' + e.message);
          }
          if (!targetColl) throw new Error('Seleziona una collezione dallo Schema Browser o apri un tab collezione.');
          vietaJsLatoServer(parsed, 'Filtro MongoDB');
          op = 'Query di lettura (filtro MQL)';
          res = await connessioni.executeWithReconnect(session, (strat) => strat.collectionFind(targetDb, targetColl, { filter: codeStr, maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
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
              throw new Error('Comando shell MongoDB non valido: ' + e.message);
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
            const collName = plan.coll || targetColl;
            if (!collName) throw new Error('Collezione non specificata nel comando.');
            queryColl = collName;
            if (plan.kind === 'aggregate') {
              vietaJsLatoServer(plan.pipeline, 'Pipeline MongoDB');
              op = `Query di lettura (${planLabel} aggregate)`;
              res = await connessioni.executeWithReconnect(session, (strat) =>
                strat.collectionAggregate(targetDb, collName, { pipeline: JSON.stringify(plan.pipeline), maxRows: QUERY_ENGINE_MAX_ROWS, runId, opHandle }));
            } else {
              vietaJsLatoServer(plan.filter, 'Filtro MongoDB');
              op = `Query di lettura (${planLabel})`;
              res = await connessioni.executeWithReconnect(session, (strat) =>
                strat.collectionFind(targetDb, collName, {
                  filter: JSON.stringify(plan.filter),
                  projection: JSON.stringify(plan.projection),
                  sort: JSON.stringify(plan.sort),
                  limit: plan.limit,
                  skip: plan.skip,
                  maxRows: QUERY_ENGINE_MAX_ROWS,
                  runId,
                  opHandle
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
    executeQueryCode
  };
}

module.exports = { createModule };
