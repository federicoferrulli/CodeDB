'use strict';

/* ---------------------------------------------------------------------------
 * Tabelle di classificazione: "quale capability serve per questa operazione".
 *
 * Due viste sulla stessa realtà:
 *  - EVENT_CAPABILITY  → evento socket (usata per il pre-check in delegate);
 *  - METHOD_CAPABILITY → metodo di DbStrategy (usata dal Proxy autorizzante,
 *    che è il vero punto di applicazione: ci passano UI, Query Engine, Virtual
 *    JOIN e tutti i tool MCP).
 *
 * `isWriteSql` e `isWriteMongoPipeline` vivono qui perché servono a entrambe le
 * viste; server.js le re-importa per classifyAudit (audit e permessi devono
 * ragionare esattamente allo stesso modo su collection:aggregate).
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Lettura o scrittura?
 *
 * Questa funzione decide DUE cose: la capability richiesta
 * (METHOD_CAPABILITY.collectionAggregate = 'dynamic') e la categoria nell'audit.
 * Guardare la sola prima parola lasciava tre vie d'uscita, tutte registrate
 * nello Storico Azioni come letture:
 *
 *   1. commento iniziale        →  /* x *\/ DELETE FROM users
 *   2. CTE di scrittura (PG)    →  WITH x AS (DELETE … RETURNING *) SELECT * FROM x
 *   3. multi-statement (PG)     →  SELECT 1; DROP TABLE users
 *      (`client.query` senza parametri usa il simple query protocol, quindi
 *       PostgreSQL esegue TUTTO; su MySQL `multipleStatements:false` ferma solo
 *       questo terzo caso, non i primi due.)
 *
 * Si normalizza quindi il testo (via db/sqlText.js: via commenti, stringhe e
 * identificatori quotati): il DML viene cercato OVUNQUE (per coprire le CTE),
 * mentre il DDL — non annidabile in una CTE — deve aprire lo statement. La
 * normalizzazione è ciò che evita i falsi positivi: senza,
 * `SELECT * FROM note WHERE testo = 'a;b'` e
 * `SELECT * FROM audit WHERE azione = 'DELETE'` verrebbero negate a chi le
 * esegue legittimamente oggi.
 * ------------------------------------------------------------------------- */
const { EJSON } = require('bson');
const { splitStatements } = require('../db/sqlText');

// `\b` dopo la keyword impedisce i falsi positivi su nomi di colonna che la
// contengono come prefisso (`updated_at`, `deleted`, `create_time`).
const SQL_READ_START = /^[\s(]*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|TABLE|VALUES)\b/i;
const SQL_WRITE_KEYWORDS = /\b(INSERT|UPDATE|REPLACE|MERGE)\b/i;
const SQL_DELETE_KEYWORDS = /\bDELETE\b/i;
const SQL_DDL_START = /^[\s(]*(CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|RENAME|CALL|COPY|VACUUM|REINDEX|CLUSTER|LOCK|SET|DO|EXECUTE|PREPARE|COMMENT|ANALYZE|REFRESH|DISCARD|RESET|LISTEN|UNLISTEN|NOTIFY)\b/i;
const SQL_CAPABILITY_PRIORITY = ['ddl', 'delete', 'write', 'read'];
// Un'operazione di schema e' concessa dalla capability specifica oppure dalla
// gestione completa della connessione. Gateway MCP e Proxy autorizzante usano
// questa stessa policy, cosi' preview ed esecuzione non possono divergere.
const DDL_AUTH_CAPABILITIES = Object.freeze(['ddl', 'manage']);
// Marcatore solo-processo: un payload proveniente da JSON/MCP non puo' creare
// una chiave Symbol. Il gateway lo applica soltanto dopo la validazione
// execute_ddl, permettendo al Proxy di usare la policy specifica del tool
// senza fidarsi di un flag controllabile dal client.
const SQL_DDL_AUTHORIZED = Symbol('codedb.sql-ddl-authorized');
// MySQL/MariaDB eseguono il contenuto di questi commenti; il lexer condiviso
// li vede invece come commenti ordinari. SQL Raw li rifiuta esplicitamente.
const SQL_EXECUTABLE_COMMENT = /\/\*(?:!\d*|M!)\s*/i;

/**
 * Statement che leggono o scrivono il FILESYSTEM dell'host del DBMS.
 *
 * `SELECT … INTO OUTFILE '/var/lib/mysql-files/x.csv'` comincia per SELECT e non
 * contiene una sola keyword di scrittura SQL: era classificato lettura, quindi
 * eseguibile con la sola capability `read` — e registrato nell'audit **come
 * lettura**, cioè senza traccia del fatto che un file è comparso sul server di
 * database. Nemmeno la transazione READ ONLY lo ferma: scrivere un file non è
 * una scrittura transazionale. Il gateway MCP lo bloccava già a monte
 * (`SQL_FORBIDDEN`), il percorso socket no.
 *
 * `LOAD DATA/XML [LOCAL] INFILE` è il verso opposto (dal file alla tabella) e
 * `LOAD_FILE()` legge un file qualsiasi restituendolo in una colonna: nessuno
 * di questi è una lettura del database, e tutti valgono la capability più alta
 * invece della più bassa.
 */
const SQL_FILE_IO = /\bINTO\s+(OUT|DUMP)FILE\b|\bLOAD\s+(?:DATA|XML)\b|\bLOAD_FILE\s*\(/i;
const POSTGRES_FILE_FUNCTIONS = /\b(?:PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|PG_LS_LOGDIR|PG_LS_WALDIR|PG_LS_ARCHIVE_STATUSDIR|PG_LS_TMPDIR|PG_STAT_FILE|LO_IMPORT|LO_EXPORT|PG_FILE_WRITE|PG_FILE_RENAME|PG_FILE_UNLINK|PG_LOGDIR_LS)\s*\(/i;

/** L'istruzione tocca il filesystem dell'host del DBMS? (testo già grezzo) */
function isFileIoSql(code) {
  const statements = splitStatements(String(code || ''), { keepIdentifiers: true });
  return statements.some((statement) =>
    SQL_FILE_IO.test(statement)
    || POSTGRES_FILE_FUNCTIONS.test(statement)
    || /^\s*COPY\b/i.test(statement));
}

function analyzeSql(code) {
  const raw = String(code || '').trim();
  const statements = splitStatements(raw);
  const executableComment = SQL_EXECUTABLE_COMMENT.test(raw);
  const fileIo = isFileIoSql(raw);
  // Più istruzioni nello stesso testo: nessuna lettura legittima della UI ne ha
  // bisogno, e il costo di sbagliarsi (una DROP eseguita come "lettura") è
  // enormemente superiore a quello di chiedere la capability di scrittura.
  const found = new Set();
  for (const statement of statements) {
    // SQL Raw può sempre restituire o derivare dati, anche quando la keyword
    // iniziale è mutativa (UPDATE/DELETE ... RETURNING) o DDL
    // (CREATE TABLE ... AS SELECT). La capability mutativa non sostituisce
    // quindi mai read: si somma ad essa.
    found.add('read');
    if (SQL_WRITE_KEYWORDS.test(statement)) found.add('write');
    if (SQL_DELETE_KEYWORDS.test(statement)) found.add('delete');
    if (SQL_DDL_START.test(statement)) found.add('ddl');
    if (![SQL_READ_START, SQL_WRITE_KEYWORDS, SQL_DELETE_KEYWORDS, SQL_DDL_START]
      .some((re) => re.test(statement))) found.add('ddl');
  }
  if (executableComment) {
    // Non tentare di reinterpretare una seconda grammatica dentro il commento:
    // classificazione massimamente conservativa e rifiuto esplicito nel Proxy.
    found.add('write');
    found.add('delete');
    found.add('ddl');
  }
  if (fileIo) found.add('write');
  if (!found.size) found.add('read');
  const multipleStatements = statements.length > 1;
  if (multipleStatements) found.add('ddl');
  const capabilities = ['read', 'write', 'delete', 'ddl'].filter((cap) => found.has(cap));
  const capability = SQL_CAPABILITY_PRIORITY.find((cap) => found.has(cap)) || 'ddl';
  return {
    statements,
    capabilities,
    capability,
    multipleStatements,
    executableComment,
    fileIo,
    write: multipleStatements || capabilities.some((cap) => cap !== 'read'),
  };
}

function sqlRequiredCapabilities(code) {
  return analyzeSql(code).capabilities;
}

function sqlCapability(code) {
  return analyzeSql(code).capability;
}

function isWriteSql(code) {
  return analyzeSql(code).write;
}

const FORBIDDEN_MONGO_SERVER_JS = new Set(['$where', '$function', '$accumulator']);

function parseMongoEjson(code, label) {
  if (code == null || code === '') return null;
  if (typeof code === 'object') return code;
  try {
    return EJSON.parse(String(code), { relaxed: false });
  } catch (err) {
    throw new Error(`${label || 'JSON MongoDB'} non valido: ${err.message}`);
  }
}

function forbiddenMongoServerJs(node, seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = forbiddenMongoServerJs(item, seen);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_MONGO_SERVER_JS.has(key)) return key;
    const found = forbiddenMongoServerJs(node[key], seen);
    if (found) return found;
  }
  return null;
}

/**
 * L'unica definizione del divieto: nessun operatore che faccia eseguire
 * JavaScript al SERVER MongoDB, ovunque il testo di una query arrivi da fuori.
 *
 * `opzioni.testoIllegibile` esiste per i chiamanti che scandiscono un testo il
 * quale verra' comunque **riletto piu' avanti**, dal traduttore o dalla
 * strategia, e li' rifiutato con il messaggio giusto. Per loro anticipare qui
 * un errore di sintassi sarebbe un peggioramento; ma la scansione non puo'
 * nemmeno saltare in silenzio senza dirlo, e prima infatti non lo diceva:
 * server.js distingueva l'errore del divieto da quello di sintassi con
 * un'espressione regolare applicata al TESTO del messaggio, cioe' una terza
 * versione della regola, la piu' fragile delle tre. Ora la distinzione la fa
 * chi chiama, dichiarandola.
 *
 * @param {string|object} code   testo EJSON o struttura gia' analizzata
 * @param {string} label         come chiamare il testo nel messaggio d'errore
 * @param {{ testoIllegibile?: 'errore'|'ignora' }} [opzioni]
 */
function assertNoMongoServerJs(code, label = 'Query MongoDB', opzioni = {}) {
  if (code == null || code === '') return null;
  let parsed;
  try {
    parsed = parseMongoEjson(code, label);
  } catch (err) {
    if (opzioni.testoIllegibile === 'ignora') return null;
    throw err;
  }
  const operator = forbiddenMongoServerJs(parsed);
  if (operator) {
    throw new Error(`Operatore ${operator} non consentito: esegue JavaScript lato server MongoDB.`);
  }
  return parsed;
}

function mongoWriteTarget(operator, value) {
  let into = value;
  if (operator === '$merge' && value && typeof value === 'object' && !Array.isArray(value)) {
    into = value.into;
  }
  if (typeof into === 'string') return { db: null, coll: into, operator };
  if (into && typeof into === 'object' && !Array.isArray(into)) {
    return {
      db: into.db == null ? null : String(into.db),
      coll: into.coll == null ? null : String(into.coll),
      operator,
    };
  }
  return { db: null, coll: null, operator };
}

function mongoReadTarget(operator, value) {
  let source;
  if (operator === '$unionWith') {
    source = typeof value === 'string' ? value : value && value.coll;
  } else {
    source = value && typeof value === 'object' && !Array.isArray(value)
      ? value.from
      : null;
  }
  if (typeof source === 'string') return { db: null, coll: source, operator };
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return {
      db: source.db == null ? null : String(source.db),
      coll: source.coll == null ? null : String(source.coll),
      operator,
    };
  }
  return { db: null, coll: null, operator };
}

/**
 * Visita semanticamente le pipeline, comprese quelle annidate in
 * $lookup/$unionWith/$facet. Si guardano gli operatori al livello dello stage,
 * non chiavi omonime dentro documenti letterali, così i dati non diventano
 * falsi riferimenti a collection.
 */
function collectMongoPipelineTargets(pipeline, targets, readTargets, seen = new WeakSet()) {
  if (!Array.isArray(pipeline) || seen.has(pipeline)) return;
  seen.add(pipeline);
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) continue;
    for (const [operator, value] of Object.entries(stage)) {
      if (operator === '$out' || operator === '$merge') {
        targets.push(mongoWriteTarget(operator, value));
      }
      if (operator === '$lookup' || operator === '$graphLookup' || operator === '$unionWith') {
        const hasExternalSource = operator === '$graphLookup'
          || typeof value === 'string'
          || (value && typeof value === 'object' && !Array.isArray(value)
            && (Object.prototype.hasOwnProperty.call(value, 'from')
              || Object.prototype.hasOwnProperty.call(value, 'coll')));
        // $lookup/$unionWith senza namespace possono usare una pipeline che
        // inizia con $documents: non c'è una collection esterna da
        // autorizzare. $graphLookup.from, invece, è sempre obbligatorio.
        if (hasExternalSource) readTargets.push(mongoReadTarget(operator, value));
        if (value && typeof value === 'object' && !Array.isArray(value)
            && Array.isArray(value.pipeline)) {
          collectMongoPipelineTargets(value.pipeline, targets, readTargets, seen);
        }
      } else if (operator === '$facet' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const branch of Object.values(value)) {
          collectMongoPipelineTargets(branch, targets, readTargets, seen);
        }
      }
    }
  }
}

function analyzeMongoPipeline(code) {
  const pipeline = parseMongoEjson(code == null || code === '' ? '[]' : code, 'Pipeline MongoDB');
  if (!Array.isArray(pipeline)) throw new Error('Pipeline MongoDB non valida: deve essere un array.');
  const targets = [];
  const readTargets = [];
  collectMongoPipelineTargets(pipeline, targets, readTargets);
  return { pipeline, write: targets.length > 0, targets, readTargets };
}

function isWriteMongoPipeline(code) {
  try {
    return analyzeMongoPipeline(code).write;
  } catch {
    return true;
  }
}

// Capability per operazione della shell (metodo `shellWrite` delle strategie).
// Cancellare è una capability distinta dallo scrivere, qui come altrove.
const SHELL_WRITE_CAPABILITY = {
  insertOne: 'write',
  insertMany: 'write',
  updateOne: 'write',
  updateMany: 'write',
  replaceOne: 'write',
  findOneAndUpdate: 'write',
  deleteOne: 'delete',
  deleteMany: 'delete',
  findOneAndDelete: 'delete',
};

/** Capability di una scrittura shell; operazione ignota = la più restrittiva. */
function shellWriteCapability(op) {
  return SHELL_WRITE_CAPABILITY[String(op || '')] || 'delete';
}

/** Capability complete: findOneAnd* restituisce anche il documento letto. */
function shellWriteCapabilities(op) {
  const operation = String(op || '');
  const mutation = shellWriteCapability(operation);
  return operation === 'findOneAndUpdate' || operation === 'findOneAndDelete'
    ? ['read', mutation]
    : [mutation];
}

/* --- Eventi socket ---------------------------------------------------------- */

// Solo gli eventi che toccano i dati o le connessioni salvate. Un evento assente
// non richiede capability (es. mongo:disconnect, query:cancel, audit:list).
const EVENT_CAPABILITY = {
  // Navigazione ed esplorazione
  'db:list': 'read',
  'db:search': 'read',
  'db:collections': 'read',
  'db:schema': 'read',
  'collection:stats': 'read',
  'collection:ddl': 'read',
  'collection:identity': 'read',
  'database:import:upload:start': 'manage',
  'database:import:upload:chunk': 'manage',
  'database:import:upload:finish': 'manage',
  'collection:relations': 'read',
  // Legge righe della tabella RIFERITA: il payload porta il suo db/coll, quindi
  // lo scope viene applicato sul bersaglio giusto. Chi non può leggere
  // "clienti" non ne vede le righe nel pannello di riferimento, anche se può
  // leggere "ordini" che la referenzia.
  'collection:find': 'read',
  'collection:count': 'read',
  'collection:explain': 'read',
  'collection:export': 'read',
  'collection:watch': 'read',
  'schema:watch': 'read',
  // Togliere l'osservazione chiede la stessa capability che serviva a metterla:
  // si può smettere di osservare solo ciò che si era autorizzati a osservare.
  // Prima non ne avevano alcuna, e passando dalla giuntura dei dati sarebbero
  // state negate a ogni sottoutente (vedi ticket 17).
  'collection:unwatch': 'read',
  'schema:unwatch': 'read',
  // Ambiguo: SQL Raw / pipeline $out|$merge sono scritture (vedi eventCapability)
  'collection:aggregate': 'read',
  // DDL
  'db:create': 'ddl',
  'db:rename': 'ddl',
  'db:drop': 'ddl',
  'collection:create': 'ddl',
  'collection:rename': 'ddl',
  'collection:drop': 'ddl',
  'column:add': 'ddl',
  'column:alter': 'ddl',
  'column:drop': 'ddl',
  'index:create': 'ddl',
  'index:drop': 'ddl',
  // Scritture sui dati
  'doc:insert': 'write',
  // Duplicazione di una riga: legge i vincoli e inserisce. La capability
  // richiesta e' quella dell'esito (scrittura); il Proxy autorizzante
  // pretende comunque `read` per la lettura dei metadati.
  'doc:duplicate': 'write',
  'doc:update': 'write',
  'doc:replace': 'write',
  'collection:import': 'write',
  'doc:delete': 'delete',
  'collection:deleteMany': 'delete',
};

/**
 * Capability richiesta da un evento delegato, risolvendo il ramo ambiguo di
 * collection:aggregate come fa classifyAudit (server.js).
 */
function eventCapability(event, payload, sess) {
  if (event === 'collection:aggregate') {
    const isSql = sess && sess.strategy && sess.strategy.type && sess.strategy.type !== 'mongodb';
    const code = payload && payload.pipeline;
    return isSql ? sqlCapability(code) : (isWriteMongoPipeline(code) ? 'write' : 'read');
  }
  return EVENT_CAPABILITY[event] || null;
}

/* --- Metodi di DbStrategy --------------------------------------------------- */

// cap: capability richiesta ('dynamic' = decisa dal payload).
// db/coll: indice dell'argomento che porta il nome del database/collezione.
// db2/coll2: destinazione di una rename, che deve rientrare nello scope quanto
// l'origine (altrimenti si "uscirebbe" dallo scope rinominando).
// filter: il risultato viene filtrato per scope invece di negare la chiamata.
/**
 * Una voce che dichiara: «questo metodo non e' un'operazione sui dati che il
 * Proxy debba autorizzare», e dice perche'. Non e' la stessa cosa che non
 * avere una voce: quella e' una dimenticanza, questa e' una decisione.
 */
function fuoriDaiDati(motivo) {
  return { cap: null, motivo };
}

const METHOD_CAPABILITY = {
  listDatabases:       { cap: 'read', filter: 'databases' },
  search:              { cap: 'read', filter: 'search' },
  listCollections:     { cap: 'read', db: 0, filter: 'collections' },
  dbSchema:            { cap: 'read', db: 0, filter: 'schema' },

  createDatabase:      { cap: 'ddl', db: 0 },
  renameDatabase:      { cap: 'ddl', db: 0, db2: 1 },
  dropDatabase:        { cap: 'ddl', db: 0 },
  createCollection:    { cap: 'ddl', db: 0, coll: 1 },
  renameCollection:    { cap: 'ddl', db: 0, coll: 1, coll2: 2 },
  dropCollection:      { cap: 'ddl', db: 0, coll: 1 },
  addColumn:           { cap: 'ddl', db: 0, coll: 1 },
  alterColumn:         { cap: 'ddl', db: 0, coll: 1 },
  dropColumn:          { cap: 'ddl', db: 0, coll: 1 },
  createIndex:         { cap: 'ddl', db: 0, coll: 1 },
  dropIndex:           { cap: 'ddl', db: 0, coll: 1 },

  tableDdl:            { cap: 'read', db: 0, coll: 1 },
  tableAuxDdl:         { cap: 'read', db: 0, coll: 1 },
  collectionStats:     { cap: 'read', db: 0, coll: 1 },
  duplicatePlan:       { cap: 'read', db: 0, coll: 1 },
  columnRelations:     { cap: 'read', db: 0, coll: 1, filter: 'relations' },
  collectionFind:      { cap: 'read', db: 0, coll: 1 },
  collectionCount:     { cap: 'read', db: 0, coll: 1 },
  collectionExplain:   { cap: 'read', db: 0, coll: 1 },
  collectionExport:    { cap: 'read', db: 0, coll: 1 },
  collectionAggregate: { cap: 'dynamic', db: 0, coll: 1 },
  // `sync: true` = metodo non asincrono: il rifiuto va lanciato, non restituito
  // come promise rigettata (vedi guardStrategy).
  watch:               { cap: 'read', db: 0, coll: 1, sync: true },
  watchSchema:         { cap: 'read', sync: true },

  // Scritture della shell da uno script MongoDB: un metodo solo, capability
  // decisa dall'OPERAZIONE nel payload (vedi SHELL_WRITE_CAPABILITY). Un
  // `deleteMany` dentro uno script richiede quindi `delete` esattamente come
  // dalla griglia: lo script non è una scorciatoia per i permessi.
  shellWrite:          { cap: 'dynamic', kind: 'shellWrite', db: 0, coll: 1 },

  docInsert:           { cap: 'write', db: 0, coll: 1 },
  docUpdate:           { cap: 'write', db: 0, coll: 1 },
  docReplace:          { cap: 'write', db: 0, coll: 1 },
  collectionUpdateMany:{ cap: 'write', db: 0, coll: 1 },
  collectionImport:    { cap: 'write', db: 0, coll: 1 },
  docDelete:           { cap: 'delete', db: 0, coll: 1 },
  collectionDeleteMany:{ cap: 'delete', db: 0, coll: 1 },

  /* ---------------------------------------------------------------------
   * Voci SENZA capability.
   *
   * Il Proxy le lascia passare, ma la differenza fra "passa" e "passa perche'
   * non c'e' scritto niente" e' tutta: la seconda e' una dimenticanza che
   * nessuno vede. Ogni voce qui sotto dice PERCHE' quel metodo non e'
   * un'operazione sui dati da autorizzare, e la maggior parte dice anche DOVE
   * viene autorizzato invece.
   *
   * La tabella e' completa: un metodo di strategia che non compare qui non
   * esiste, e `test/unit-tabella-autorizzazioni.js` lo verifica confrontando
   * queste chiavi con i prototipi veri delle tre strategie. E' il motivo per
   * cui il Proxy puo' permettersi di NEGARE cio' che non trova.
   * ------------------------------------------------------------------- */

  // Ciclo di vita della connessione: chi puo' aprirla lo decide
  // `assertConnAllowed` PRIMA che la strategia esista, e chiuderla non e'
  // un'operazione sui dati.
  connect:             fuoriDaiDati('apertura della connessione, autorizzata da assertConnAllowed'),
  disconnect:          fuoriDaiDati('chiusura della connessione'),

  // Amministrazione del SERVER di database, non dei dati di questa
  // connessione: server.js le autorizza con `assertWholeConnection`, che
  // pretende l'assenza di scope. Metterle qui con una capability
  // significherebbe due regole diverse per la stessa porta.
  health:              fuoriDaiDati('diagnosi della connessione, autorizzata su tutta la connessione in server.js'),
  listSessions:        fuoriDaiDati('sessioni del SERVER di database, autorizzate su tutta la connessione in server.js'),
  killSession:         fuoriDaiDati('terminazione di sessioni altrui, autorizzata su tutta la connessione in server.js'),

  // Annullare una query non legge e non modifica nulla: ferma una richiesta
  // gia' autorizzata, e la puo' fermare solo chi l'ha aperta (il riferimento
  // di annullamento vive nella sua sessione).
  cancelQuery:         fuoriDaiDati('annulla una richiesta gia autorizzata, registrata nella propria sessione'),

  // Mettere in osservazione passa da `watch`/`watchSchema`, che hanno la loro
  // voce con `read`. Toglierla non legge niente.
  unwatch:             fuoriDaiDati('smette di osservare; e watch a chiedere read'),
  unwatchSchema:       fuoriDaiDati('smette di osservare; e watchSchema a chiedere read'),

  // Dichiarazioni sul motore, non sul suo contenuto.
  supportsNativeRename: fuoriDaiDati('dichiara una capacita del motore, non tocca dati'),
  fuoriDalTettoDiTempo: fuoriDaiDati('dichiara se una esecuzione va fermata dal tetto di tempo'),

  /* ---------------------------------------------------------------------
   * Aiuti interni degli adattatori.
   *
   * Non attraversano il Proxy: le strategie li chiamano su `this`, e il Proxy
   * vede solo le chiamate che arrivano da fuori. Compaiono qui perche' la
   * tabella dev'essere completa, non perche' qualcuno li invochi da fuori — e
   * se un giorno qualcuno lo facesse, questa voce e' il posto in cui decidere
   * cosa debba succedere.
   * ------------------------------------------------------------------- */
  ...Object.fromEntries([
    // Composizione della query tabellare (db/sqlTabellare.js): stringhe, non dati.
    'buildSelect', 'buildOrderBy', 'buildKeyset', 'keysetValue', 'makeId', 'parseRowId',
    'bersaglioRiga', 'rimuoviIdVirtuale',
    // Metadati comuni ai due motori SQL (db/sqlMetadati.js): li leggono i
    // metodi pubblici che hanno gia' la loro voce.
    'primaryKey', 'tableColumnsInfo', 'tableFields', 'uniqueIndexes', 'elencoIndici',
    'indexList', 'estimatedRowCount', 'selectListFor', 'countWithTimeout',
    'colonneScrivibili', 'metadatiEsportazione', 'totaleEsportazione',
    // Dettagli di connessione e di esecuzione dei singoli motori.
    'requireClient', 'requirePool', 'usaDatabase', 'rilevaCollazione', 'conSearchPath',
    'queryConTimeout', 'threadIdsDelPool', 'processIDsDelPool', 'uccidiSulServer',
    'attesePerLock', 'isObjectIdField', 'promoteFilterObjectIds',
  ].map((nome) => [nome, fuoriDaiDati('aiuto interno dell adattatore, chiamato su this')])),
};

// Etichette italiane per il messaggio di errore.
const CAPABILITY_LABEL = {
  read: 'lettura',
  write: 'scrittura',
  ddl: 'modifica della struttura',
  delete: 'cancellazione',
  manage: 'amministrazione',
};

/* --- Scope: match glob su nomi di database/collezione ------------------------ */

// Glob minimale: `*` = qualsiasi sequenza, `?` = un carattere. Il confronto è
// case-sensitive (i nomi MongoDB lo sono, e per un confine di sicurezza è la
// scelta più prevedibile).
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

const globCache = new Map();
function globMatch(pattern, value) {
  if (pattern === '*' || pattern == null) return true;
  let re = globCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re.test(String(value == null ? '' : value));
}

/**
 * true se `value` soddisfa almeno uno dei pattern.
 *
 * Il valore ha TRE stati distinti, e confonderli era un bypass dello scope:
 *
 *  · `undefined` → l'operazione non ha un bersaglio (listDatabases, search,
 *    watchSchema): non c'è nulla da confrontare, si passa. Le liste restano
 *    comunque filtrate a valle dal Proxy, che è la vera protezione lì.
 *  · `null` / `''` → un bersaglio era ATTESO ma non è arrivato. Prima si
 *    passava ("operazione non legata a un nome"), ma il valore viene dal
 *    payload del client: bastava mandare `{ db: '', coll: '' }` per far cadere
 *    lo scope e leggere fuori dal proprio perimetro. Ora si nega.
 *  · una stringa → confronto glob normale.
 *
 * Una lista di pattern vuota o assente significa "nessun limite su questa
 * dimensione" e passa sempre.
 */
function matchesAny(patterns, value) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  if (value === undefined) return true;             // operazione senza bersaglio
  if (value === null || value === '') return false; // bersaglio atteso ma mancante
  return patterns.some((p) => globMatch(p, value));
}

module.exports = {
  analyzeSql,
  DDL_AUTH_CAPABILITIES,
  SQL_DDL_AUTHORIZED,
  sqlCapability,
  sqlRequiredCapabilities,
  isWriteSql,
  isFileIoSql,
  analyzeMongoPipeline,
  assertNoMongoServerJs,
  FORBIDDEN_MONGO_SERVER_JS,
  isWriteMongoPipeline,
  EVENT_CAPABILITY,
  eventCapability,
  METHOD_CAPABILITY,
  CAPABILITY_LABEL,
  SHELL_WRITE_CAPABILITY,
  shellWriteCapability,
  shellWriteCapabilities,
  globMatch,
  matchesAny,
};
