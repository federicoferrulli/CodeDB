/**
 * CodeDB — Vocabolari specifici del DBMS (dialetti)
 *
 * Il completamento non può proporre le stesse parole a tutti. `GROUP_CONCAT`
 * su PostgreSQL non esiste (lì è `STRING_AGG`), `RETURNING` su MySQL non
 * esiste, e su MongoDB — dove l'SQL passa dal traduttore `SqlToMql` — non
 * le funzioni scalari sono definite insieme al traduttore. Proporre una
 * funzione che il motore poi rifiuta non è un aiuto,
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

/* ==========================================================================
 * Quoting degli identificatori
 *
 * La regola non vive qui: vive in `identificatori.mjs`, l'unico modulo che
 * server e browser condividono davvero. Questo file la **ri-esporta** perché
 * era il posto da cui i chiamanti del frontend l'avevano sempre importata, e
 * spostare la conoscenza non è un buon motivo per rompere sette import.
 * ========================================================================== */

import { dialettoDi } from './identificatori.mjs';
import { FUNZIONI_SQL_MONGO, FINESTRE_SQL_MONGO } from './sql-mongo-funzioni.mjs';
import { KEYWORDS_MYSQL, KEYWORDS_POSTGRESQL, FUNZIONI_MYSQL, FUNZIONI_POSTGRESQL,
  ESPRESSIONI_MONGO, STADI_MONGO, FILTRI_MONGO, AGGIORNAMENTI_MONGO,
  ACCUMULATORI_MONGO, FINESTRA_MONGO } from './query-cataloghi.mjs';

export const FUNZIONI_COMUNI = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST',
  'UPPER', 'LOWER', 'TRIM', 'LENGTH', 'SUBSTRING', 'CONCAT', 'ROUND', 'NOW', 'DATE',
  'ABS', 'CEIL', 'CEILING', 'FLOOR', 'MOD', 'POWER', 'SQRT', 'EXTRACT',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'CUME_DIST', 'PERCENT_RANK', 'NTILE',
  'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE'];

export {
  ID_SQL, smarca, ultimoSegmento, serveQuoting, quotaIdentificatore,
  quotaSempre, quotaQualificato, dialettoDi,
} from './identificatori.mjs';

const MYSQL = {
  nome: 'MySQL 8.4',
  funzioni: [
    ...FUNZIONI_MYSQL, 'YEAR', 'MONTH', 'DAY', 'JSON_TABLE',
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
    'OVER', 'PARTITION BY', 'ROWS BETWEEN', 'RANGE BETWEEN', 'WITH RECURSIVE',
    'UNBOUNDED PRECEDING', 'CURRENT ROW', 'ON DELETE CASCADE', 'FOR SHARE', 'SKIP LOCKED',
  ],
  keywords: KEYWORDS_MYSQL,
  tipi: [
    'INT', 'INT UNSIGNED', 'TINYINT', 'TINYINT(1)', 'SMALLINT', 'MEDIUMINT',
    'BIGINT', 'BIGINT UNSIGNED', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
    'VARCHAR(255)', 'CHAR(36)', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
    'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'BOOLEAN', 'JSON',
    'BINARY(16)', 'VARBINARY(255)', 'BIT(1)', 'BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB',
    'TINYTEXT', "ENUM('valore')", "SET('valore')",
    'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTIPOLYGON', 'MULTILINESTRING', 'GEOMETRYCOLLECTION',
  ],
};

const POSTGRESQL = {
  nome: 'PostgreSQL 18',
  funzioni: [
    ...FUNZIONI_POSTGRESQL, 'JSON_TABLE',
    'COALESCE', 'NULLIF', 'GREATEST', 'LEAST', 'STRING_AGG', 'ARRAY_AGG',
    'ARRAY_LENGTH', 'UNNEST', 'GENERATE_SERIES', 'SPLIT_PART', 'STRPOS',
    'INITCAP', 'REGEXP_REPLACE', 'REGEXP_MATCHES', 'FORMAT',
    'TO_CHAR', 'TO_DATE', 'TO_TIMESTAMP', 'TO_NUMBER', 'DATE_TRUNC', 'EXTRACT',
    'AGE', 'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CLOCK_TIMESTAMP',
    'JSONB_BUILD_OBJECT', 'JSONB_AGG', 'JSONB_ARRAY_ELEMENTS', 'JSON_BUILD_OBJECT',
    'JSONB_SET', 'JSONB_EXTRACT_PATH_TEXT',
    'GEN_RANDOM_UUID', 'MD5', 'RANDOM', 'PG_TYPEOF', 'CURRENT_SCHEMA',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'PERCENTILE_CONT',
  ],
  // Le funzioni dell'estensione sono riconoscibili nell'elenco: richiedono PostGIS.
  estensioni: ['ST_AsGeoJSON', 'ST_GeomFromGeoJSON', 'ST_Distance', 'ST_DWithin',
    'ST_Contains', 'ST_Intersects', 'ST_X', 'ST_Y', 'ST_SRID', 'ST_Transform'],
  keywords: KEYWORDS_POSTGRESQL,
  parole: [
    'RETURNING', 'ON CONFLICT', 'ON CONFLICT DO NOTHING', 'DO UPDATE SET',
    'ILIKE', 'SIMILAR TO', 'DISTINCT ON', 'LATERAL', 'OVER', 'PARTITION BY',
    'WINDOW', 'FILTER', 'WITH RECURSIVE', 'MATERIALIZED', 'EXPLAIN ANALYZE',
    'GENERATED ALWAYS AS IDENTITY', 'FOR UPDATE', 'NULLS FIRST', 'NULLS LAST',
    'LIMIT', 'OFFSET', 'FETCH FIRST', 'ANY', 'ALL', 'ARRAY',
    'FULL OUTER JOIN', 'CROSS JOIN', 'ROWS BETWEEN', 'RANGE BETWEEN', 'GROUPS BETWEEN',
    'UNBOUNDED PRECEDING', 'CURRENT ROW', 'WITHIN GROUP', 'AT TIME ZONE', 'SKIP LOCKED',
    'ON DELETE CASCADE', 'IS DISTINCT FROM', 'IS NOT DISTINCT FROM',
  ],
  tipi: [
    'integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric(10,2)',
    'real', 'double precision', 'boolean', 'text', 'varchar(255)', 'char(36)',
    'date', 'timestamp', 'timestamptz', 'time', 'interval',
    'json', 'jsonb', 'uuid', 'bytea', 'inet', 'cidr',
    'integer[]', 'text[]', 'smallserial', 'money', 'bit(1)', 'bit varying', 'timetz',
    'macaddr', 'macaddr8', 'tsvector', 'tsquery', 'xml', 'int4range', 'int8range', 'numrange',
    'tsrange', 'tstzrange', 'daterange', 'int4multirange', 'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle',
    'geometry', 'geography(Point,4326)',
  ],
};

// Su MongoDB l'SQL non è eseguito da un motore SQL: è tradotto da
// `db/SqlToMql.js`: il registro condiviso impedisce divergenze fra i nomi
// suggeriti nell'editor e le funzioni riconosciute dall'interprete.
const MONGODB = {
  nome: 'SQL→MQL',
  funzioni: [...FINESTRE_SQL_MONGO, 'CAST', ...Object.keys(FUNZIONI_SQL_MONGO)],
  soloQueste: true,
  parole: ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
    'AS', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'LIKE', 'IN', 'BETWEEN', 'IS',
    'DISTINCT', 'ASC', 'DESC', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'CROSS JOIN', 'ON', 'UNION', 'UNION ALL',
    'WITH', 'WITH RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ILIKE',
    'RIGHT JOIN', 'FULL OUTER JOIN', 'RETURNING', 'OVER', 'PARTITION BY', 'ROWS BETWEEN', 'RANGE BETWEEN',
    'UNBOUNDED PRECEDING', 'UNBOUNDED FOLLOWING', 'CURRENT ROW',
    'WINDOW', 'GROUPS BETWEEN', 'EXCLUDE CURRENT ROW', 'EXCLUDE GROUP', 'EXCLUDE TIES', 'NULLS FIRST', 'NULLS LAST',
      'FILTER', 'EXISTS', 'ANY', 'SOME', 'ALL', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE SET', 'ON DUPLICATE KEY UPDATE',
    'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'DROP TABLE',
    'CREATE DATABASE', 'DROP DATABASE', 'CREATE INDEX', 'DROP INDEX', 'TRUNCATE TABLE', 'USE',
    'INTERSECT', 'INTERSECT ALL', 'EXCEPT', 'EXCEPT ALL', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES',
    'UNIQUE', 'CHECK', 'NOT NULL', 'DEFAULT', 'ON DELETE CASCADE', 'ON UPDATE CASCADE', 'ON DELETE SET NULL',
    'CREATE PROCEDURE', 'DROP PROCEDURE', 'CALL', 'DECLARE', 'WHILE', 'IF', 'BEGIN ATOMIC', 'LANGUAGE SQL', 'LANGUAGE PLPGSQL',
    'ALTER TABLE', 'ADD COLUMN', 'DROP COLUMN', 'RENAME COLUMN', 'ALTER COLUMN', 'ADD CONSTRAINT', 'DROP CONSTRAINT',
    'SET DEFAULT', 'DROP DEFAULT', 'SET NOT NULL', 'DROP NOT NULL', 'MODIFY COLUMN', 'CHANGE COLUMN',
    'CREATE TRIGGER', 'DROP TRIGGER', 'BEFORE', 'AFTER', 'FOR EACH ROW', 'UPDATE OF', 'OLD', 'NEW', 'WHEN', 'FOLLOWS', 'PRECEDES', 'CASCADE',
    'SAVEPOINT', 'ROLLBACK TO SAVEPOINT', 'RELEASE SAVEPOINT', 'FOR EACH STATEMENT', 'CREATE DOMAIN', 'ALTER DOMAIN', 'DROP DOMAIN', 'BEGIN ATOMIC',
    'EXCEPTION WHEN', 'unique_violation', 'not_null_violation', 'check_violation', 'foreign_key_violation', 'division_by_zero',
    'RENAME CONSTRAINT', 'RENAME INDEX', 'SET DATA TYPE', 'ADD COLUMN IF NOT EXISTS',
    'CURSOR', 'OPEN', 'FETCH', 'CLOSE', 'HANDLER', 'NOT FOUND', 'FOUND', 'SQLWARNING', 'SQLEXCEPTION', 'CONDITION', 'RESIGNAL', 'IS DISTINCT FROM', 'IS NOT DISTINCT FROM',
    'ELSIF', 'ELSEIF', 'LOOP', 'REPEAT', 'UNTIL', 'EXIT WHEN', 'CONTINUE WHEN', 'RETURN', 'SIGNAL SQLSTATE', 'RAISE EXCEPTION'],
  tipi: ['TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'INT UNSIGNED', 'BIGINT UNSIGNED', 'DECIMAL(18,2)', 'REAL', 'DOUBLE', 'TEXT', 'VARCHAR(255)', 'CHAR(1)', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON', 'UUID', "ENUM('valore')", 'BYTEA', 'BINARY(16)', 'VARBINARY(255)', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'INT[]', 'TEXT[]', 'INT4RANGE', 'INT8RANGE', 'NUMRANGE', 'DATERANGE', 'TSRANGE', 'TSTZRANGE', 'INT4MULTIRANGE', 'INT8MULTIRANGE', 'NUMMULTIRANGE', 'DATEMULTIRANGE', 'TSMULTIRANGE', 'TSTZMULTIRANGE'],
};

const unici = valori => [...new Map(valori.map(v => [v.toUpperCase(), v])).values()];
for (const d of [MYSQL, POSTGRESQL]) {
  d.funzioni = unici([...FUNZIONI_COMUNI, ...d.funzioni]);
  const tipi = new Set(d.tipi.map(t => t.split(/[ (\[]/)[0].toUpperCase()));
  const funzioni = new Set(d.funzioni.map(t => t.toUpperCase()));
  d.parole = unici([...d.parole, ...d.keywords.filter(k => !tipi.has(k) && !funzioni.has(k))]);
}
export const DIALETTI = { mysql: MYSQL, postgresql: POSTGRESQL, mongodb: MONGODB };

/**
 * Vocabolario SQL del motore indicato. Con un motore sconosciuto restituisce
 * elenchi vuoti: il completamento resta quello comune a tutti i dialetti,
 * cioè esattamente il comportamento che c'era prima.
 */
export function vocabolarioSql(dbType) {
  const d = DIALETTI[dialettoDi(dbType)];
  if (!d) return { nome: '', funzioni: [], parole: [], tipi: [], estensioni: [], keywords: [], soloQueste: false };
  return {
    nome: d.nome,
    funzioni: d.funzioni,
    parole: d.parole,
    tipi: d.tipi,
    soloQueste: !!d.soloQueste,
    estensioni: d.estensioni || [],
    keywords: d.keywords || [],
  };
}

/* ==========================================================================
 * MongoDB — elementi della shell che non sono operatori
 * ========================================================================== */

// Metodi dell'oggetto `db` (non di una collezione): dopo `db.` hanno senso
// quanto i nomi delle collezioni, e prima non venivano proposti affatto.
export const METODI_DB_MONGO = [
  'getCollection', 'getCollectionNames', 'createCollection', 'dropDatabase',
  'getSiblingDB', 'getName', 'getMongo', 'runCommand', 'adminCommand', 'getCollectionInfos', 'stats', 'version', 'hello', 'aggregate',
];
export const METODI_SESSIONE_MONGO = ['getDatabase', 'getOptions', 'getSessionId', 'getClusterTime', 'getOperationTime',
  'advanceClusterTime', 'advanceOperationTime', 'startTransaction', 'commitTransaction', 'abortTransaction', 'withTransaction', 'endSession', 'hasEnded'];

// Solo metodi implementati da MongoScriptRunner; le opzioni ignorate non sono promesse.
export const METODI_COLLEZIONE_MONGO = ['find', 'findOne', 'aggregate', 'countDocuments',
  'estimatedDocumentCount', 'distinct', 'insertOne', 'insertMany', 'updateOne', 'updateMany',
  'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
  'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'hideIndex', 'unhideIndex', 'getIndexes',
  'drop', 'getName', 'getFullName', 'getDB', 'count', 'bulkWrite', 'stats', 'options', 'isCapped'];
export const METODI_CURSORE_MONGO = ['sort', 'limit', 'skip', 'projection', 'toArray',
  'count', 'itcount', 'hasNext', 'next', 'tryNext', 'close', 'isClosed', 'project', 'forEach', 'map', 'allowDiskUse', 'batchSize', 'hint',
  'maxTimeMS', 'readPref', 'readConcern', 'collation', 'comment', 'min', 'max', 'returnKey', 'showRecordId', 'explain'];
export const VARIABILI_MONGO = ['$$ROOT', '$$CURRENT', '$$REMOVE', '$$NOW', '$$CLUSTER_TIME',
  '$$DESCEND', '$$PRUNE', '$$KEEP', '$$SEARCH_META', '$$USER_ROLES'];
export const OPERATORI_MQL = [...new Set([...STADI_MONGO, ...ESPRESSIONI_MONGO, ...FILTRI_MONGO,
  ...AGGIORNAMENTI_MONGO, ...ACCUMULATORI_MONGO, ...FINESTRA_MONGO,
  '$text', '$search', '$language', '$caseSensitive', '$diacriticSensitive', '$options',
  '$geometry', '$maxDistance', '$minDistance', '$center', '$centerSphere', '$box', '$polygon',
  '$natural', '$meta', '$', '$[]', '$[elemento]',
])].filter(v => !['$function', '$accumulator', '$where'].includes(v));
export function dettaglioMongo(parola) {
  if (VARIABILI_MONGO.includes(parola)) return 'Variabile di sistema';
  if (['$search', '$searchMeta', '$vectorSearch', '$listSearchIndexes'].includes(parola)) return 'Richiede MongoDB Search';
  const tipi = [];
  if (STADI_MONGO.includes(parola)) tipi.push('Stadio');
  if (ESPRESSIONI_MONGO.includes(parola)) tipi.push('Espressione');
  if (FILTRI_MONGO.includes(parola)) tipi.push('Filtro');
  if (AGGIORNAMENTI_MONGO.includes(parola)) tipi.push('Aggiornamento');
  if (ACCUMULATORI_MONGO.includes(parola)) tipi.push('Accumulatore');
  if (FINESTRA_MONGO.includes(parola)) tipi.push('Finestra');
  return tipi.join(' · ');
}
