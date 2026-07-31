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
 * identificatori quotati) e poi si cerca una keyword di scrittura OVUNQUE, non
 * solo in testa. La normalizzazione è ciò che evita i falsi positivi: senza,
 * `SELECT * FROM note WHERE testo = 'a;b'` e
 * `SELECT * FROM audit WHERE azione = 'DELETE'` verrebbero negate a chi le
 * esegue legittimamente oggi.
 * ------------------------------------------------------------------------- */
const { stripSqlNoise, splitStatements } = require('../db/sqlText');

// `\b` dopo la keyword impedisce i falsi positivi su nomi di colonna che la
// contengono come prefisso (`updated_at`, `deleted`, `create_time`).
const SQL_WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|MERGE|GRANT|REVOKE|RENAME|CALL|COPY|VACUUM|REINDEX|CLUSTER|LOCK|SET|DO|EXECUTE|PREPARE)\b/i;

function isWriteSql(code) {
  const raw = String(code || '').trim();
  if (!raw) return false;
  const statements = splitStatements(raw);
  // Più istruzioni nello stesso testo: nessuna lettura legittima della UI ne ha
  // bisogno, e il costo di sbagliarsi (una DROP eseguita come "lettura") è
  // enormemente superiore a quello di chiedere la capability di scrittura.
  if (statements.length > 1) return true;
  return SQL_WRITE_KEYWORDS.test(stripSqlNoise(raw));
}

// Pipeline MongoDB che materializza dati (unica forma di scrittura via pipeline).
function isWriteMongoPipeline(code) {
  return /"\$out"|"\$merge"/.test(String(code || ''));
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
  'collection:find': 'read',
  'collection:count': 'read',
  'collection:explain': 'read',
  'collection:export': 'read',
  'collection:watch': 'read',
  'schema:watch': 'read',
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
    if (isSql ? isWriteSql(code) : isWriteMongoPipeline(code)) return 'write';
    return 'read';
  }
  return EVENT_CAPABILITY[event] || null;
}

/* --- Metodi di DbStrategy --------------------------------------------------- */

// cap: capability richiesta ('dynamic' = decisa dal payload).
// db/coll: indice dell'argomento che porta il nome del database/collezione.
// db2/coll2: destinazione di una rename, che deve rientrare nello scope quanto
// l'origine (altrimenti si "uscirebbe" dallo scope rinominando).
// filter: il risultato viene filtrato per scope invece di negare la chiamata.
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
  collectionStats:     { cap: 'read', db: 0, coll: 1 },
  collectionFind:      { cap: 'read', db: 0, coll: 1 },
  collectionCount:     { cap: 'read', db: 0, coll: 1 },
  collectionExplain:   { cap: 'read', db: 0, coll: 1 },
  collectionExport:    { cap: 'read', db: 0, coll: 1 },
  collectionAggregate: { cap: 'dynamic', db: 0, coll: 1 },
  // `sync: true` = metodo non asincrono: il rifiuto va lanciato, non restituito
  // come promise rigettata (vedi guardStrategy).
  watch:               { cap: 'read', db: 0, coll: 1, sync: true },
  watchSchema:         { cap: 'read', sync: true },

  docInsert:           { cap: 'write', db: 0, coll: 1 },
  docUpdate:           { cap: 'write', db: 0, coll: 1 },
  docReplace:          { cap: 'write', db: 0, coll: 1 },
  collectionUpdateMany:{ cap: 'write', db: 0, coll: 1 },
  collectionImport:    { cap: 'write', db: 0, coll: 1 },
  docDelete:           { cap: 'delete', db: 0, coll: 1 },
  collectionDeleteMany:{ cap: 'delete', db: 0, coll: 1 },
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
  isWriteSql,
  isWriteMongoPipeline,
  EVENT_CAPABILITY,
  eventCapability,
  METHOD_CAPABILITY,
  CAPABILITY_LABEL,
  globMatch,
  matchesAny,
};
