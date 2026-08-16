/**
 * CodeDB — Vocabolari specifici del DBMS (dialetti)
 *
 * Il completamento non può proporre le stesse parole a tutti. `GROUP_CONCAT`
 * su PostgreSQL non esiste (lì è `STRING_AGG`), `RETURNING` su MySQL non
 * esiste, e su MongoDB — dove l'SQL passa dal traduttore `SqlToMql` — non
 * esiste **nessuna** funzione scalare: il traduttore riconosce solo i cinque
 * aggregati. Proporre una funzione che il motore poi rifiuta non è un aiuto,
 * è una trappola: si scopre l'errore solo dopo aver premuto Esegui.
 *
 * Qui c'è quindi, per ogni motore, ciò che quel motore capisce davvero:
 *
 *  - `funzioni` — funzioni proprie del dialetto (le comuni a tutti stanno in
 *    `FUNZIONI_SQL` dentro `intellisense.js` e valgono ovunque);
 *  - `parole`   — clausole e costrutti che esistono solo lì;
 *  - `tipi`     — tipi di colonna, proposti nel punto in cui il DDL li vuole;
 *  - `soloQueste` — se vero, le funzioni comuni NON vengono proposte perché
 *    quel motore non le ha (è il caso di MongoDB via SQL→MQL).
 *
 * Modulo puro: nessun DOM, nessuna rete. Serve a `intellisense.js` e si prova
 * da solo.
 */

import { SQL_KEYWORDS } from './query-highlighter.js';

/* ==========================================================================
 * Quoting degli identificatori
 * ========================================================================== */

/**
 * Il carattere con cui ogni motore delimita un identificatore.
 *
 * Su MongoDB il carattere NON è il doppio apice: l'SQL passa da
 * `db/SqlToMql.js`, il cui tokenizzatore tratta `"…"` come una **stringa** e
 * riconosce come identificatori quotati solo `` `…` `` e `[…]`. Scriverci
 * `"Prova"` non darebbe una tabella, darebbe un testo.
 */
const APICE = { mysql: '`', postgresql: '"', mongodb: '`' };

/**
 * Un identificatore SQL: quotato in una delle tre forme (`` ` ``, `"`, `[…]`)
 * oppure nudo. Sta qui, accanto alle regole del quoting, perché è la stessa
 * conoscenza: chi sa mettere le virgolette deve sapere anche riconoscerle.
 */
export const ID_SQL = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[\\w$]+)';

/** Toglie le virgolette da un identificatore. */
export function smarca(nome) {
  return String(nome || '').replace(/^[`"[]|[`"\]]$/g, '');
}

/** L'ultimo pezzo di un nome qualificato (`schema."Prova"` → `Prova`). */
export function ultimoSegmento(qualificato) {
  const pezzi = String(qualificato || '').match(new RegExp(ID_SQL, 'g')) || [];
  return pezzi.length ? smarca(pezzi[pezzi.length - 1]) : '';
}

/**
 * Un identificatore ha bisogno delle virgolette?
 *
 * Il caso che conta davvero è PostgreSQL: lì un nome non quotato viene
 * **abbassato a minuscolo** dal motore, quindi una tabella creata come `Prova`
 * risponde solo a `"Prova"` — `FROM diego.Prova` cerca `diego.prova` e non la
 * trova. È l'errore che si vede scritto in tutte le lettere nel messaggio
 * "relation … does not exist".
 *
 * MySQL e MongoDB non abbassano niente, quindi lì le virgolette servono solo
 * quando il nome contiene caratteri fuori dall'alfabeto degli identificatori
 * (spazi, trattini, punti) o coincide con una parola chiave.
 */
export function serveQuoting(nome, dbType) {
  const d = dialettoDi(dbType);
  if (!d) return false;
  const s = String(nome == null ? '' : nome);
  if (!s) return false;
  if (SQL_KEYWORDS.has(s.toUpperCase())) return true;
  return d === 'postgresql'
    ? !/^[a-z_][a-z0-9_$]*$/.test(s)   // una sola maiuscola basta
    : !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
}

/**
 * Il nome pronto da scrivere in una query per quel motore: quotato se serve,
 * intatto se non serve. Con un motore sconosciuto non si tocca niente —
 * inventare virgolette sbagliate romperebbe una query che funzionava.
 */
export function quotaIdentificatore(nome, dbType) {
  const s = String(nome == null ? '' : nome);
  if (!serveQuoting(s, dbType)) return s;
  const q = APICE[dialettoDi(dbType)];
  return q + s.split(q).join(q + q) + q;
}

/** Normalizza il nome del motore nelle tre famiglie che CodeDB conosce. */
export function dialettoDi(dbType) {
  const t = String(dbType || '').toLowerCase();
  if (t === 'mysql' || t === 'mariadb') return 'mysql';
  if (t === 'postgresql' || t === 'postgres' || t === 'pg') return 'postgresql';
  if (t === 'mongodb' || t === 'mongo') return 'mongodb';
  return '';
}

const MYSQL = {
  nome: 'MySQL',
  funzioni: [
    'IFNULL', 'IF', 'GROUP_CONCAT', 'CONCAT_WS', 'SUBSTRING_INDEX', 'LOCATE',
    'INSTR', 'LPAD', 'RPAD', 'REPLACE', 'REGEXP_REPLACE', 'REGEXP_SUBSTR',
    'DATE_FORMAT', 'STR_TO_DATE', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF',
    'TIMESTAMPDIFF', 'CURDATE', 'CURTIME', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
    'JSON_EXTRACT', 'JSON_UNQUOTE', 'JSON_OBJECT', 'JSON_ARRAY', 'JSON_CONTAINS',
    'JSON_LENGTH', 'JSON_SET', 'LAST_INSERT_ID', 'DATABASE', 'VERSION',
    'UUID', 'MD5', 'SHA2', 'RAND', 'FIND_IN_SET', 'GREATEST', 'LEAST',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD',
    'ST_AsGeoJSON', 'ST_GeomFromGeoJSON', 'ST_Distance_Sphere', 'ST_Contains',
    'ST_Within', 'ST_Intersects', 'ST_X', 'ST_Y', 'ST_SRID',
  ],
  parole: [
    'ON DUPLICATE KEY UPDATE', 'AUTO_INCREMENT', 'ENGINE=InnoDB',
    'DEFAULT CHARSET=utf8mb4', 'STRAIGHT_JOIN', 'REGEXP', 'RLIKE',
    'SHOW TABLES', 'SHOW COLUMNS FROM', 'SHOW CREATE TABLE', 'SHOW INDEX FROM',
    'SHOW PROCESSLIST', 'EXPLAIN ANALYZE', 'LOCK IN SHARE MODE', 'FOR UPDATE',
    'UNSIGNED', 'ZEROFILL', 'COLLATE', 'IGNORE', 'REPLACE INTO', 'LIMIT',
  ],
  tipi: [
    'INT', 'INT UNSIGNED', 'TINYINT', 'TINYINT(1)', 'SMALLINT', 'MEDIUMINT',
    'BIGINT', 'BIGINT UNSIGNED', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
    'VARCHAR(255)', 'CHAR(36)', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
    'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'BOOLEAN', 'JSON',
    'BLOB', 'LONGBLOB', 'ENUM(…)', 'SET(…)',
    'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTIPOLYGON',
  ],
};

const POSTGRESQL = {
  nome: 'PostgreSQL',
  funzioni: [
    'COALESCE', 'NULLIF', 'GREATEST', 'LEAST', 'STRING_AGG', 'ARRAY_AGG',
    'ARRAY_LENGTH', 'UNNEST', 'GENERATE_SERIES', 'SPLIT_PART', 'STRPOS',
    'INITCAP', 'REGEXP_REPLACE', 'REGEXP_MATCHES', 'FORMAT',
    'TO_CHAR', 'TO_DATE', 'TO_TIMESTAMP', 'TO_NUMBER', 'DATE_TRUNC', 'EXTRACT',
    'AGE', 'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CLOCK_TIMESTAMP',
    'JSONB_BUILD_OBJECT', 'JSONB_AGG', 'JSONB_ARRAY_ELEMENTS', 'JSON_BUILD_OBJECT',
    'JSONB_SET', 'JSONB_EXTRACT_PATH_TEXT',
    'GEN_RANDOM_UUID', 'MD5', 'RANDOM', 'PG_TYPEOF', 'CURRENT_SCHEMA',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'PERCENTILE_CONT',
    'ST_AsGeoJSON', 'ST_GeomFromGeoJSON', 'ST_Distance', 'ST_DWithin',
    'ST_Contains', 'ST_Intersects', 'ST_X', 'ST_Y', 'ST_SRID', 'ST_Transform',
  ],
  parole: [
    'RETURNING', 'ON CONFLICT', 'ON CONFLICT DO NOTHING', 'DO UPDATE SET',
    'ILIKE', 'SIMILAR TO', 'DISTINCT ON', 'LATERAL', 'OVER', 'PARTITION BY',
    'WINDOW', 'FILTER', 'WITH RECURSIVE', 'MATERIALIZED', 'EXPLAIN ANALYZE',
    'GENERATED ALWAYS AS IDENTITY', 'FOR UPDATE', 'NULLS FIRST', 'NULLS LAST',
    'LIMIT', 'OFFSET', 'FETCH FIRST', 'ANY', 'ALL', 'ARRAY',
  ],
  tipi: [
    'integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric(10,2)',
    'real', 'double precision', 'boolean', 'text', 'varchar(255)', 'char(36)',
    'date', 'timestamp', 'timestamptz', 'time', 'interval',
    'json', 'jsonb', 'uuid', 'bytea', 'inet', 'cidr',
    'integer[]', 'text[]', 'geometry', 'geography(Point,4326)',
  ],
};

// Su MongoDB l'SQL non è eseguito da un motore SQL: è tradotto da
// `db/SqlToMql.js`, che riconosce solo i cinque aggregati. Le funzioni comuni
// (UPPER, CONCAT, ROUND…) qui NON vanno proposte: nessuna di quelle arriva a
// destinazione, e vederle nell'elenco fa credere che siano disponibili.
const MONGODB = {
  nome: 'SQL→MQL',
  funzioni: ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'],
  soloQueste: true,
  parole: ['LIMIT', 'OFFSET', 'GROUP BY', 'HAVING', 'ORDER BY', 'UNION ALL'],
  tipi: [],
};

export const DIALETTI = { mysql: MYSQL, postgresql: POSTGRESQL, mongodb: MONGODB };

/**
 * Vocabolario SQL del motore indicato. Con un motore sconosciuto restituisce
 * elenchi vuoti: il completamento resta quello comune a tutti i dialetti,
 * cioè esattamente il comportamento che c'era prima.
 */
export function vocabolarioSql(dbType) {
  const d = DIALETTI[dialettoDi(dbType)];
  if (!d) return { nome: '', funzioni: [], parole: [], tipi: [], soloQueste: false };
  return {
    nome: d.nome,
    funzioni: d.funzioni,
    parole: d.parole,
    tipi: d.tipi,
    soloQueste: !!d.soloQueste,
  };
}

/* ==========================================================================
 * MongoDB — elementi della shell che non sono operatori
 * ========================================================================== */

// Metodi dell'oggetto `db` (non di una collezione): dopo `db.` hanno senso
// quanto i nomi delle collezioni, e prima non venivano proposti affatto.
export const METODI_DB_MONGO = [
  'getCollection', 'getCollectionNames', 'createCollection', 'dropDatabase',
  'runCommand', 'adminCommand', 'stats', 'getSiblingDB', 'version',
];
