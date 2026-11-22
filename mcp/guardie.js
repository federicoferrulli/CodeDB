'use strict';

/* ---------------------------------------------------------------------------
 * Guardie di validazione e formattazione risposte del gateway MCP.
 *
 * Centralizza le invarianti sintattiche su SQL (sola lettura, DML con WHERE,
 * DDL di schema senza comandi amministrativi) e su pipeline/oggetti EJSON
 * MongoDB, insieme alla traduzione degli errori per i client AI.
 * ------------------------------------------------------------------------- */

const { EJSON } = require('bson');
const {
  analyzeSql, sqlCapability, analyzeMongoPipeline, assertNoMongoServerJs,
} = require('../auth/capabilities');
const { spiegaErrore } = require('../db/errors');

// Capability richiesta dalla scrittura MCP, in base all'operazione richiesta.
// Stessa mappatura di auth/capabilities.js (write/delete/ddl): così il gate del
// primo passo di execute_write non diverge dal Proxy autorizzante che protegge
// l'esecuzione vera e propria.
const WRITE_OP_CAPABILITY = {
  insert: 'write', update: 'write', delete: 'delete',
  drop_collection: 'ddl', drop_database: 'ddl',
};

// Stesso trattamento del percorso socket (vedi server.js): l'errore tecnico del
// driver diventa "cosa è successo + cosa fare". Qui il destinatario è un client
// AI, che dal messaggio deve capire se ritentare, correggere la query o
// arrendersi — un "57014" nudo non glielo dice.
function errMsg(err, ctx) {
  return spiegaErrore(err, ctx || (err && err._ctx) || {});
}

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// I tool non lanciano mai verso il protocollo: un errore diventa un risultato
// con isError, così il modello lo legge e può correggersi.
function errorResult(err) {
  return { isError: true, content: [{ type: 'text', text: `Errore: ${errMsg(err)}` }] };
}

// Primo token ammesso per l'SQL: statement di sola lettura. La whitelist da
// sola non basta (es. EXPLAIN ANALYZE esegue davvero lo statement, una CTE
// può contenere DML): per questo la query viene comunque eseguita dentro una
// transazione READ ONLY (vedi flag readOnly di MySqlStrategy).
const SQL_READONLY_START = /^[\s(]*(select|with|show|describe|desc|explain|table|values)\b/i;

/**
 * I/O sul filesystem dell'host del DBMS: non è coperto dalla transazione READ
 * ONLY (scrivere o leggere un file non è un'operazione transazionale), quindi
 * va bloccato a monte.
 *
 * La decisione è delegata a `analyzeSql` di auth/capabilities.js così la
 * barriera coincide con quella del Proxy autorizzante sul percorso socket.
 */
function assertReadOnlySql(sql) {
  const text = String(sql || '');
  const analysis = analyzeSql(text);
  if (analysis.multipleStatements) {
    throw new Error('In modalità MCP è ammesso un solo statement SQL per chiamata.');
  }
  if (analysis.fileIo) {
    throw new Error(
      "In modalità MCP non è ammesso l'I/O su file dell'host del database "
      + '(INTO OUTFILE/DUMPFILE, LOAD DATA/XML, LOAD_FILE, COPY o funzioni file PostgreSQL): '
      + 'è una lettura o una scrittura '
      + 'sul filesystem del server, non sui dati della connessione.'
    );
  }
  const statement = analysis.statements[0] || '';
  if (!SQL_READONLY_START.test(statement)
      || analysis.capabilities.some((capability) => capability !== 'read')) {
    throw new Error('In modalità MCP sono ammesse solo query di lettura (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, TABLE, VALUES).');
  }
}

/* Fase 3: guardie del tool di scrittura (execute_write). Via SQL solo DML
 * esplicito, niente DDL (i drop di database/collection passano dalle
 * operation dedicate drop_database/drop_collection, valide per entrambi i
 * dbType); UPDATE e DELETE devono avere una clausola WHERE. */
const SQL_WRITE_START = /^\s*(insert|update|delete|replace)\b/i;
const SQL_NEEDS_WHERE = /^\s*(update|delete)\b/i;

function hasTopLevelSqlKeyword(statement, keyword) {
  const text = String(statement || '');
  const wanted = String(keyword || '').toLowerCase();
  let depth = 0;
  let found = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') {
      if (depth === 0) return false; // forma sbilanciata: fail-closed
      depth--;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++;
      if (depth === 0 && text.slice(i, j).toLowerCase() === wanted) found = true;
      i = j;
      continue;
    }
    i++;
  }
  return found && depth === 0;
}

function assertWriteSql(sql) {
  const text = String(sql || '');
  const analysis = analyzeSql(text);
  if (analysis.multipleStatements) {
    throw new Error('execute_write ammette un solo statement SQL per chiamata.');
  }
  const statement = analysis.statements[0] || '';
  // `read` è ammesso INSIEME a write/delete, non da solo: `analyzeSql` lo
  // aggiunge ormai a ogni istruzione, perché anche una mutativa può restituire
  // dati (`UPDATE … RETURNING`, `CREATE TABLE … AS SELECT`). Niente `ddl` e
  // niente `manage`, in nessuna posizione dell'istruzione.
  const AMMESSE = ['read', 'write', 'delete'];
  const mutativa = analysis.capabilities.some((c) => c === 'write' || c === 'delete');
  if (!SQL_WRITE_START.test(statement)
      || !mutativa
      || analysis.capabilities.some((capability) => !AMMESSE.includes(capability))) {
    throw new Error('execute_write ammette solo INSERT, UPDATE, DELETE o REPLACE (niente DDL).');
  }
  if (analysis.fileIo) {
    throw new Error("execute_write non ammette l'I/O su file dell'host del database.");
  }
  if (SQL_NEEDS_WHERE.test(statement) && !hasTopLevelSqlKeyword(statement, 'where')) {
    throw new Error('UPDATE e DELETE senza clausola WHERE non sono ammessi: specifica sempre le righe interessate.');
  }
  return sqlCapability(statement);
}

// Il tool DDL accetta un solo comando di definizione esplicito. La
// classificazione generale di SQL Raw è volutamente conservativa e tratta
// anche comandi amministrativi/ignoti come `ddl`; qui serve una whitelist più
// stretta, perché CALL, COPY, GRANT o SET non sono operazioni di schema.
const SQL_SCHEMA_OBJECT = [
  'materialized\\s+view',
  'foreign\\s+table',
  'text\\s+search\\s+(?:configuration|dictionary|parser|template)',
  'table', 'database', 'schema', 'index', 'view', 'sequence', 'trigger',
  'function', 'procedure', 'type', 'domain', 'aggregate', 'operator',
  'collation', 'conversion', 'policy', 'rule', 'cast', 'statistics',
  'column', 'constraint',
].join('|');
const SQL_DDL_TOOL_START = new RegExp(
  '^\\s*(?:' +
    'create\\s+(?:(?:or\\s+replace|temporary|temp|unlogged|unique|fulltext|spatial)\\s+)*' +
      `(?:${SQL_SCHEMA_OBJECT})\\b` +
    `|alter\\s+(?:${SQL_SCHEMA_OBJECT})\\b` +
    `|drop\\s+(?:temporary\\s+)?(?:${SQL_SCHEMA_OBJECT})\\b` +
    '|truncate(?:\\s+table)?\\b' +
    '|rename\\s+table\\b' +
    `|comment\\s+on\\s+(?:${SQL_SCHEMA_OBJECT})\\b` +
  ')',
  'i',
);

function assertDdlSql(sql) {
  const text = String(sql || '');
  const analysis = analyzeSql(text);
  if (analysis.multipleStatements) {
    throw new Error('execute_ddl ammette un solo statement SQL per chiamata.');
  }
  if (analysis.executableComment) {
    throw new Error('execute_ddl non ammette commenti SQL eseguibili /*! ... */ o /*M! ... */.');
  }
  if (analysis.fileIo) {
    throw new Error("execute_ddl non ammette l'I/O su file dell'host del database.");
  }
  const statement = analysis.statements[0] || '';
  if (!SQL_DDL_TOOL_START.test(statement)) {
    throw new Error(
      'execute_ddl ammette solo DDL di schema su oggetti del database; ' +
      'comandi amministrativi come USER, ROLE, SYSTEM, GRANT o REVOKE non sono consentiti.'
    );
  }
  // `analysis.statements` contiene il testo normalizzato per la decisione:
  // anteprima ed esecuzione condividono invece l'SQL originale.
  return text.trim();
}

// Parse di un oggetto EJSON che deve esistere e non essere vuoto (filtri e
// $set delle scritture: mai operare "su tutto" per omissione).
function parseNonEmptyObject(text, label) {
  let obj;
  try {
    obj = EJSON.parse(String(text || ''), { relaxed: false });
  } catch (err) {
    throw new Error(`${label} non valido: ${errMsg(err)}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Object.keys(obj).length) {
    throw new Error(`${label} mancante o vuoto: specifica un oggetto esplicito.`);
  }
  return obj;
}

// Pipeline MongoDB: $out e $merge sono gli unici stage che scrivono e sono
// ammessi solo al livello superiore della pipeline.
function assertReadOnlyPipeline(pipelineText) {
  const analysis = analyzeMongoPipeline(pipelineText);
  assertNoMongoServerJs(analysis.pipeline, 'Pipeline MongoDB');
  if (analysis.write) {
    throw new Error('Gli stage $out e $merge non sono ammessi in modalità MCP (sola lettura).');
  }
}

module.exports = {
  WRITE_OP_CAPABILITY,
  errMsg,
  jsonResult,
  errorResult,
  assertReadOnlySql,
  hasTopLevelSqlKeyword,
  assertWriteSql,
  assertDdlSql,
  parseNonEmptyObject,
  assertReadOnlyPipeline,
};
