'use strict';

// CodeDB — audit. Stato e dipendenze appartengono alla singola istanza.
const path = require('path');
const { ROOT_PRINCIPAL } = require('../auth/principal');
const { isWriteSql, isWriteMongoPipeline } = require('../auth/capabilities');

function createModule({ config, dependencies, errori }) {
  // Audit log delle operazioni critiche/di scrittura eseguite dalla Web UI, su un
  // file separato da quello del gateway MCP (mcp-audit.log) ma con lo stesso
  // formato/rotazione (db/AuditLog.js). CODEDB_UI_AUDIT_FILE lo sposta nella
  // cartella dati utente per l'app Electron pacchettizzata e isola i test.
  const UI_AUDIT_FILE = config.env.CODEDB_UI_AUDIT_FILE || path.join(config.rootDir, 'ui-audit.log');

  const {
    audit: auditUi,
    readRecent: readUiAudit,
    flush: flushAuditUi,
    statoSalute: statoSaluteAuditUi,
  } = dependencies.makeAuditor(UI_AUDIT_FILE);

  /* ---------------------------------------------------------------------------
   * Audit delle scritture via Web UI
   * ------------------------------------------------------------------------- */

  // Tronca un valore (stringa o oggetto) a n caratteri per non gonfiare il log.
  function cutStr(v, n = 200) {
    if (v == null) return undefined;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // Estrae i contatori "quante righe" dal risultato di una scrittura, qualunque
  // sia la strategia (Mongo/MySQL/PostgreSQL usano nomi diversi): entra nel log
  // solo ciò che è effettivamente presente.
  function auditCounts(r) {
    if (!r || typeof r !== 'object') return {};
    const out = {};
    for (const k of ['deletedCount', 'modifiedCount', 'matchedCount', 'insertedCount',
      'upsertedCount', 'inserted', 'imported', 'count', 'affectedRows']) {
      if (r[k] != null) out[k] = r[k];
    }
    return out;
  }

  /**
   * Identità dell'autore di un'azione, da includere in OGNI voce di audit.
   *
   * Senza questi campi lo Storico Azioni non è attribuibile e quindi non è
   * filtrabile per tenant: `ui-audit.log` è un file unico per installazione, e
   * mostrarlo intero a chiunque vanificherebbe l'isolamento per owner realizzato
   * da `connectionsFileFor()`. `ownerId` delimita il tenant, `userId` il singolo
   * soggetto (l'owner vede tutto il proprio tenant, un sottoutente solo le
   * proprie azioni), `user` è l'etichetta leggibile mostrata in tabella.
   */
  function auditActor(principal) {
    const p = principal || ROOT_PRINCIPAL;
    return {
      ownerId: p.ownerId || null,
      userId: p.id || null,
      user: p.email || p.displayName || null,
    };
  }

  // Descrittori delle operazioni di scrittura tracciate: (payload, result) →
  // campi aggiuntivi da registrare (op = etichetta italiana per la UI). Solo gli
  // eventi qui presenti vengono registrati; i restanti delegate restano di sola
  // lettura e non producono voci di audit.
  /* ---------------------------------------------------------------------------
   * LE ECCEZIONI DELLA VIA GENERICA.
   *
   * Dopo che le tre famiglie di ADR-0001 hanno preso la loro giuntura, `safeOn`
   * resta usato da questi eventi soltanto — e ognuno dice perché.
   *
   * Non è una lista di cortesia: `test/unit-registrazione-eventi.js` la confronta
   * con ciò che `server.js` registra davvero, e un evento che compaia su `safeOn`
   * senza essere dichiarato qui fa fallire il test. È il terzo gradino del
   * criterio di chiusura di questo lotto: non basta che la situazione sia
   * sistemata, dev'essere difficile riformarla.
   *
   * Aggiungere un evento qui è legittimo — le eccezioni esistono — ma richiede di
   * scriverne il motivo, che è la differenza fra una decisione e una deriva.
   * ------------------------------------------------------------------------- */

  const ECCEZIONI_VIA_GENERICA = {
    // --- Ciclo di vita della sessione ----------------------------------------
    // Le tre giunture PRESUPPONGONO una sessione: questi eventi la creano, la
    // chiudono o la provano prima che esista. Farli passare da una giuntura che
    // comincia cercando la sessione sarebbe circolare.
    'mongo:connect': 'apre la sessione che le tre giunture presuppongono',
    'mongo:disconnect': 'chiude la sessione',
    'connections:test': 'prova una connessione senza aprirne una sessione',

    // --- Capability senza bersaglio ------------------------------------------
    // Non hanno un database o una collezione su cui verificare uno scope: la
    // verifica è sull'INTERA connessione (assertWholeConnection), che è una
    // domanda diversa da quella che sa fare la giuntura dei dati.
    'health:connections': 'diagnosi di tutte le sessioni del socket, nessun bersaglio singolo',
    'db:sessions': 'sessioni del SERVER di database, autorizzate sull\'intera connessione',
    'db:killSession': 'termina sessioni altrui, autorizzata sull\'intera connessione',

    // --- Backup ---------------------------------------------------------------
    // Leggono e scrivono attraverso il driver NATIVO (strategy.client/pool), che
    // il Proxy autorizzante lascia passare invariato: sono perciò autorizzati a
    // parte, sull'intera connessione e senza scope.
    'backup:run': 'accede al driver nativo, autorizzato sull\'intera connessione',
    'backup:list': 'elenca i backup su disco, fuori dal perimetro di una strategia',
    'backup:restore': 'accede al driver nativo, autorizzato sull\'intera connessione',
    'backup:verify': 'verifica i file di un backup, fuori dal perimetro di una strategia',
  };

  /* ---------------------------------------------------------------------------
   * LA FAMIGLIA DELLE OPERAZIONI LUNGHE (ADR-0001, terza delle tre).
   *
   * È la famiglia che giustifica l'ADR: se non esistesse, i suoi eventi
   * potrebbero rientrare nella giuntura dei dati e le famiglie sarebbero due.
   * Esiste perché queste operazioni hanno bisogno di OTTO cose che la giuntura
   * dei dati non offre — e che non può offrire senza diventare un'interfaccia
   * piena di parametri opzionali, cioè superficiale.
   *
   * Finora quegli otto punti erano un'AFFERMAZIONE: scritti in un ADR in prosa,
   * da riverificare a mano ogni volta che qualcuno si chiedeva perché mai
   * `script:execute` non passasse da `delegate`. Qui diventano nomi, e ogni
   * evento dichiara quali usa. Un'operazione lunga che non ne usa nessuno non
   * appartiene a questa famiglia, e `operazioneLunga()` lo rifiuta invece di
   * lasciarla lì per inerzia.
   * ------------------------------------------------------------------------- */

  const PUNTI_ESTENSIONE = {
    /** 1. Rispondere PRIMA che l'operazione finisca, e continuare a lavorare dopo. */
    rispostaAnticipata:
      'risponde prima della fine e continua a lavorare dopo aver risposto',
    /** 2. Emettere avanzamento durante l'esecuzione. */
    avanzamento:
      'emette avanzamento mentre esegue, non solo alla fine',
    /** 3. Un riferimento di annullamento che CAMBIA nel tempo. */
    annullamentoMutevole:
      'registra un riferimento di annullamento che cambia nel tempo: uno script '
      + 'ne ha uno per istruzione, non uno fissato all\'ingresso',
    /** 4. Leggere le operazioni in corso SENZA registrarne una propria. */
    letturaOperazioniInCorso:
      'legge le operazioni in corso senza registrarne una propria: registrarla '
      + 'sotto lo stesso runId sovrascriverebbe proprio quella da annullare',
    /** 5. Interrompere un'esecuzione che gira DENTRO CodeDB. */
    interruzioneInProcesso:
      'interrompe un\'esecuzione che gira nel processo CodeDB e non sul DBMS, '
      + 'quindi non fermabile dal server del database',
    /** 6. La categoria dell'audit si conosce solo ALLA FINE. */
    categoriaAuditFinale:
      'decide la categoria dell\'audit a fine esecuzione: su uno script '
      + 'interpretato la si conosce solo eseguendo',
    /** 7. La capability si verifica per SINGOLA ISTRUZIONE. */
    capabilityPerIstruzione:
      'verifica la capability per singola istruzione, non per evento',
    /** 8. Opera su stato di sessione che non è una strategia. */
    statoDiSessione:
      'opera su stato della sessione che non è una strategia (registro degli '
      + 'script in corso, depositi dei risultati)',
  };

  /**
   * Quali punti usa ciascuna operazione lunga.
   *
   * Non è documentazione: `operazioneLunga()` la legge, e un evento che non
   * compare qui — o che non usa alcun punto — non si registra.
   */
  const OPERAZIONI_LUNGHE = {
    'query:execute': [
      'annullamentoMutevole',
      'categoriaAuditFinale',
      'interruzioneInProcesso',
      'statoDiSessione',
    ],
    'script:execute': [
      'rispostaAnticipata',
      'avanzamento',
      'annullamentoMutevole',
      'interruzioneInProcesso',
      'categoriaAuditFinale',
      'capabilityPerIstruzione',
      'statoDiSessione',
    ],
    'script:pause': ['statoDiSessione', 'interruzioneInProcesso'],
    'script:resume': ['statoDiSessione'],
    'script:state': ['statoDiSessione', 'letturaOperazioniInCorso'],
    'script:result': ['statoDiSessione'],
    'script:abort': ['statoDiSessione', 'interruzioneInProcesso'],
    'query:cancel': ['letturaOperazioniInCorso', 'interruzioneInProcesso'],
    'database:import:start': [
      'rispostaAnticipata', 'avanzamento', 'interruzioneInProcesso',
      'statoDiSessione', 'categoriaAuditFinale',
    ],
    'database:import:state': ['statoDiSessione', 'letturaOperazioniInCorso'],
    'database:import:list': ['statoDiSessione', 'letturaOperazioniInCorso'],
    'database:import:cancel': ['statoDiSessione', 'interruzioneInProcesso'],
    'database:import:cleanup': ['statoDiSessione', 'interruzioneInProcesso'],
    'db:rename': ['statoDiSessione'],
  };

  /* ---------------------------------------------------------------------------
   * LA FAMIGLIA AMMINISTRATIVA (ADR-0001, seconda delle tre).
   *
   * Ventisei eventi che non toccano alcuna strategia: vault, utenti, permessi,
   * chiavi API, connessioni salvate, licenza, aggiornamenti, storico azioni. Non
   * hanno un database come bersaglio, quindi la verifica della capability per
   * database non li riguarda — hanno invece gate d'installazione e AUDIT, e
   * l'audit una quindicina di loro se lo componeva a mano, riga per riga, con la
   * stessa forma ripetuta:
   *
   *   auditUi({ event: 'users:create', category: 'write', status: 'ok',
   *             op: 'Creazione sottoutente', ...auditActor(principal),
   *             target: user.email });
   *
   * Scritto a mano vuol dire dimenticabile: aggiungere un evento amministrativo
   * nuovo non lascia alcuna traccia se chi lo scrive non si ricorda di quella
   * riga, e nessuno se ne accorge finché non serve leggere lo storico.
   *
   * Qui l'audit diventa una DICHIARAZIONE. Ogni evento amministrativo deve avere
   * una voce in questa tabella, e `amministrativo()` rifiuta di registrare ciò
   * che non vi compare: un evento nuovo o è tracciato, o dichiara perché non lo è.
   *
   * `tracciato: false` non è una scappatoia — è la voce degli eventi di sola
   * LETTURA. Registrare nello storico ogni apertura di un elenco lo riempirebbe
   * di righe che non raccontano nulla, seppellendo quelle che contano. Il motivo
   * sta scritto accanto a ciascuno.
   *
   * I gate restano nei corpi degli handler, dove sono sempre stati: spostarli
   * qui avrebbe cambiato semantica di sicurezza in un punto in cui «vale come
   * prima» è precisamente ciò che il ticket chiede.
   * ------------------------------------------------------------------------- */

  const NON_TRACCIATO = (motivo) => ({ tracciato: false, motivo });

  const EVENTI_AMMINISTRATIVI = {
    // --- Vault ---------------------------------------------------------------
    'vault:status': NON_TRACCIATO('lettura di stato, senza effetti'),
    'vault:unlock': {
      op: 'Sblocco del vault',
      // L'esito conta: un tentativo fallito di sblocco è la cosa più
      // interessante che questo evento possa produrre.
      dettagli: (payload, res) => ({ esito: res && res.ok ? 'riuscito' : 'fallito' }),
    },
    'vault:reset': {
      op: 'Azzeramento del vault (connessioni eliminate, nuova passphrase)',
      dettagli: (payload, res) => ({ spostati: (res && res.spostati) || [] }),
    },
    'vault:setPassphrase': {
      // L'etichetta dipende dall'esito: una migrazione del vault e' un'altra
      // cosa da un semplice cambio, e leggere 'Cambio passphrase' dove il vault
      // e' stato migrato nasconde proprio l'operazione piu' delicata.
      op: (payload, res) => (res && res.migrated
        ? 'Cambio passphrase (con migrazione del vault)'
        : 'Cambio passphrase del vault'),
    },

    // --- Connessioni salvate -------------------------------------------------
    'connections:list': NON_TRACCIATO('elenco, senza effetti'),
    'connections:get': NON_TRACCIATO('lettura di una singola connessione, senza segreti'),
    'connections:save': {
      op: 'Salvataggio di una connessione',
      bersaglio: (payload) => payload && (payload.name || payload.oldName),
    },
    'connections:delete': {
      op: 'Eliminazione di una connessione salvata',
      bersaglio: (payload) => payload && payload.name,
    },
    'connections:export': { op: 'Esportazione delle connessioni salvate' },
    'connections:import': { op: 'Importazione di connessioni salvate' },

    // --- Applicazione --------------------------------------------------------
    'app:info': NON_TRACCIATO('informazioni statiche sulla versione'),
    'artifact:validate': NON_TRACCIATO('validazione di input locale non fidato, senza effetti'),
    'app:updates:check': NON_TRACCIATO('interrogazione del canale aggiornamenti'),
    'app:license': NON_TRACCIATO('testo della licenza'),
    'audit:list': NON_TRACCIATO('lettura dello storico: tracciarla lo riempirebbe di se stessa'),
    // Preferenze del tenant (scorciatoie da tastiera): tracciarle riempirebbe lo
    // storico di rumore a ogni rimappatura di un tasto.
    'prefs:get': NON_TRACCIATO('lettura di una preferenza personale'),
    'prefs:set': NON_TRACCIATO('salvataggio di una preferenza personale'),
    'prefs:shared:get': NON_TRACCIATO('lettura di una preferenza condivisa del tenant'),
    'prefs:shared:set': {
      op: 'Salvataggio preferenza condivisa',
      bersaglio: (payload) => payload && payload.chiave,
    },

    // --- Identità e permessi -------------------------------------------------
    'auth:me': NON_TRACCIATO('chi sono io, senza effetti'),
    'roles:list': NON_TRACCIATO('elenco dei ruoli, senza effetti'),
    'users:list': NON_TRACCIATO('elenco dei sottoutenti, senza effetti'),
    'users:create': {
      op: 'Creazione sottoutente',
      bersaglio: (payload, res) => (res && res.user && res.user.email) || (payload && payload.email),
    },
    'users:update': {
      op: 'Modifica sottoutente',
      bersaglio: (payload) => payload && String(payload.id),
    },
    'users:delete': {
      op: 'Eliminazione sottoutente',
      bersaglio: (payload) => payload && String(payload.id),
    },
    'grants:list': NON_TRACCIATO('elenco dei permessi, senza effetti'),
    'grants:set': {
      op: 'Assegnazione permessi',
      bersaglio: (payload) => payload && String(payload.subjectId),
      dettagli: (payload) => ({ connection: payload && payload.connName, role: payload && payload.role }),
    },
    'grants:revoke': {
      op: 'Revoca permessi',
      bersaglio: (payload) => payload && String(payload.subjectId),
      dettagli: (payload) => ({ connection: payload && String(payload.connName) }),
    },
    'apikeys:list': NON_TRACCIATO('elenco delle chiavi, senza segreti'),
    'apikeys:create': {
      op: 'Creazione API key',
      bersaglio: (payload) => payload && String(payload.subjectId),
      dettagli: (payload) => ({ label: payload && payload.label }),
    },
    'apikeys:revoke': {
      op: 'Revoca API key',
      bersaglio: (payload) => payload && String(payload.id),
    },
  };

  const AUDIT_WRITES = {
    'db:create':             (p) => ({ coll: p.coll, op: 'Creazione database' }),
    'db:rename':             (p) => ({ newName: p.newName, op: 'Rinomina database' }),
    'db:drop':               () => ({ op: 'Eliminazione database' }),
    'collection:create':     (p) => ({ coll: p.name, op: 'Creazione collection/tabella' }),
    'collection:rename':     (p) => ({ coll: p.coll, newName: p.newName, op: 'Rinomina collection/tabella' }),
    'collection:drop':       (p) => ({ coll: p.coll, op: 'Eliminazione collection/tabella' }),
    'column:add':            (p) => ({ coll: p.coll, op: 'Aggiunta colonna' }),
    'column:alter':          (p) => ({ coll: p.coll, op: 'Modifica colonna' }),
    'column:drop':           (p) => ({ coll: p.coll, column: p.name, op: 'Eliminazione colonna' }),
    'index:create':          (p) => ({ coll: p.coll, op: 'Creazione indice' }),
    'index:drop':            (p) => ({ coll: p.coll, index: p.name, op: 'Eliminazione indice' }),
    'doc:insert':            (p) => ({ coll: p.coll, op: 'Inserimento documento/riga' }),
    'doc:duplicate':         (p) => ({ coll: p.coll, op: p.soloAnteprima ? 'Anteprima duplicato' : 'Duplicazione documento/riga' }),
    'doc:update':            (p) => ({ coll: p.coll, docId: cutStr(p.id, 120), op: 'Aggiornamento documento/riga' }),
    'doc:replace':           (p) => ({ coll: p.coll, docId: cutStr(p.id, 120), op: 'Sostituzione documento/riga' }),
    'doc:delete':            (p) => ({ coll: p.coll, docId: cutStr(p.id, 120), op: 'Eliminazione documento/riga' }),
    'collection:deleteMany': (p) => ({ coll: p.coll, filter: cutStr(p.filter), op: 'Eliminazione massiva' }),
    'collection:import':     (p) => ({ coll: p.coll, op: 'Import batch' }),
  };

  // Descrittori delle operazioni di sola lettura tracciate (find, aggregate,
  // explain, export). Le letture di navigazione/chrome (db:list, db:collections,
  // db:schema, db:search, collection:stats) restano fuori: sono ad altissimo
  // volume (polling, render della sidebar) e non rappresentano un'azione utente.
  const AUDIT_READS = {
    'collection:find':      (p) => ({ coll: p.coll, op: 'Lettura documenti/righe (find)', filter: cutStr(p.filter), sort: cutStr(p.sort, 80) }),
    'collection:aggregate': (p) => ({ coll: p.coll, op: 'Aggregazione', pipeline: cutStr(p.pipeline, 300) }),
    'collection:explain':   (p) => ({ coll: p.coll, op: 'Piano di esecuzione (explain)' }),
    'collection:export':    (p) => ({ coll: p.coll, op: 'Export collection/tabella' }),
    'collection:identity':  (p) => ({ coll: p.coll, op: 'Lettura identità stabile' }),
    // Il pannello delle chiavi esterne legge righe VERE di un'altra tabella, non
    // metadati: è una lettura di dati quanto una find, e come tale va tracciata.
    // (`collection:relations` invece resta fuori, come db:schema: sono i soli
    // nomi dei vincoli, chiesti a ogni apertura di tabella.)
  };

  // Classifica un evento delegato: scrittura, lettura o non tracciato. Il ramo
  // collection:aggregate è ambiguo (nella griglia "SQL Raw"/pipeline può essere
  // una scrittura): si guarda la strategia e il codice per decidere.
  function classifyAudit(event, payload, sess) {
    if (AUDIT_WRITES[event]) return { category: 'write', describe: AUDIT_WRITES[event] };
    if (event === 'collection:aggregate') {
      const isSql = sess && sess.strategy && sess.strategy.type && sess.strategy.type !== 'mongodb';
      if (isSql && isWriteSql(payload.pipeline)) {
        return { category: 'write', describe: (p) => ({ coll: p.coll, op: 'Query di scrittura (SQL Raw)', query: cutStr(p.pipeline, 500) }) };
      }
      if (!isSql && isWriteMongoPipeline(payload.pipeline)) {
        return { category: 'write', describe: (p) => ({ coll: p.coll, op: 'Pipeline di scrittura ($out/$merge)', pipeline: cutStr(p.pipeline, 500) }) };
      }
      return { category: 'read', describe: AUDIT_READS['collection:aggregate'] };
    }
    if (AUDIT_READS[event]) return { category: 'read', describe: AUDIT_READS[event] };
    return null;
  }

  // Scrive una voce di audit per un'operazione delegata. Best-effort assoluto:
  // qualsiasi errore qui non deve mai disturbare l'operazione già completata.
  function auditWrite(sess, event, payload, extra, status, result, error, category) {
    try {
      auditUi({
        event,
        category: category || 'write',
        status,
        ...auditActor(sess && sess.principal),
        connection: (sess && (sess.connName || sess.label)) || null,
        dbType: (sess && (sess.dbType || (sess.strategy && sess.strategy.type))) || null,
        db: payload.db || null,
        client: (sess && sess.ip) || null,
        ...(extra || {}),
        ...auditCounts(result),
        ...(Array.isArray(result && result.docs) ? { rows: result.docs.length } : {}),
        ...(error ? { error: errori.errMsg(error) } : {}),
      });
    } catch { /* audit best-effort */ }
  }

  // Registra la voce di audit per un evento delegato, saltando le letture
  // automatiche (polling/live/refresh post-scrittura marcate _bg dal client).
  function auditDelegate(cls, sess, event, payload, status, result, error) {
    if (!cls) return;
    if (event === 'collection:import') {
      if (payload.batchId && payload.statusOnly) return; // consultazione della ricevuta
      if (result && (result.status === 'incerto' || result.failed > 0)) {
        status = 'error';
        error = new Error(result.error || (result.errors || []).join('; ') || 'Import parziale.');
      }
    }
    if (cls.category === 'read' && payload._bg) return;
    auditWrite(sess, event, payload, cls.describe(payload, result), status, result, error, cls.category);
  }

  // Voce di audit per una query eseguita dal Query Engine (query:execute): db/coll
  // sono quelli risolti localmente, non nel payload. Il Query Engine è sempre
  // avviato dall'utente (nessun polling): letture e scritture vengono entrambe
  // tracciate, distinte da `category`.
  function auditQuery(sess, db, coll, code, category, op, status, result, error) {
    try {
      auditUi({
        event: 'query:execute',
        category,
        status,
        op,
        ...auditActor(sess && sess.principal),
        connection: (sess && (sess.connName || sess.label)) || null,
        dbType: (sess && (sess.dbType || (sess.strategy && sess.strategy.type))) || null,
        db: db || null,
        coll: coll || null,
        client: (sess && sess.ip) || null,
        query: cutStr(code, 500),
        ...auditCounts(result),
        ...(Array.isArray(result && result.docs) ? { rows: result.docs.length } : {}),
        ...(error ? { error: errori.errMsg(error) } : {}),
      });
    } catch { /* audit best-effort */ }
  }

  return {
    auditUi,
    readUiAudit,
    flushAuditUi,
    statoSaluteAuditUi,
    auditActor,
    ECCEZIONI_VIA_GENERICA,
    PUNTI_ESTENSIONE,
    OPERAZIONI_LUNGHE,
    NON_TRACCIATO,
    EVENTI_AMMINISTRATIVI,
    AUDIT_WRITES,
    AUDIT_READS,
    classifyAudit,
    auditWrite,
    auditDelegate,
    auditQuery
  };
}

module.exports = { createModule };
