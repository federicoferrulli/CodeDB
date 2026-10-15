/**
 * CodeDB — Query & Aggregate Syntax Highlighter
 * 
 * Tokenizer ultra-veloce a zero dipendenze per l'evidenziazione della sintassi in tempo reale.
 * Supporta un set esaustivo di keyword SQL (DML, DDL, DCL, TCL, Tipi, Funzioni), MQL (JSON) e MongoShell.
 */

// Le parole riservate SQL stanno nel modulo della quotatura: è lì che
// sbagliarle rompe qualcosa (un nome di colonna `order` scritto nudo è un
// errore di sintassi), qui al massimo cambierebbe un colore. Si ri-esportano in
// fondo insieme agli altri vocabolari, perché è da qui che i chiamanti le
// prendono da sempre.
import { SQL_KEYWORDS } from './identificatori.mjs';
import { DIALETTI, FUNZIONI_COMUNI, vocabolarioSql } from './sql-dialetti.js';
import { tokenizzaQuery, linguaQuery } from './query-lexer.js';

// Tipi di dati SQL
const SQL_TYPES = new Set([
  'INT', 'INTEGER', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'BIGINT', 'DECIMAL', 'NUMERIC',
  'FLOAT', 'DOUBLE', 'REAL', 'BOOLEAN', 'BOOL', 'BIT',
  'VARCHAR', 'CHAR', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BLOB', 'TINYBLOB',
  'MEDIUMBLOB', 'LONGBLOB', 'VARBINARY', 'BINARY',
  'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'INTERVAL',
  'JSON', 'JSONB', 'UUID', 'ENUM', 'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON'
]);

// Funzioni SQL ed Aggregate
const SQL_FUNCTIONS = new Set([
  // Aggregazione
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'STDDEV', 'VARIANCE',
  // Window Functions
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
  // Stringhe
  'CONCAT', 'CONCAT_WS', 'SUBSTRING', 'SUBSTR', 'LENGTH', 'CHAR_LENGTH', 'LOWER', 'UPPER',
  'TRIM', 'LTRIM', 'RTRIM', 'REPLACE', 'LPAD', 'RPAD', 'INSTR', 'FIELD', 'REPEAT', 'REVERSE', 'LEFT', 'RIGHT',
  // Date & Ora
  'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'DATE_ADD', 'DATE_SUB',
  'DATEDIFF', 'DATE_FORMAT', 'STR_TO_DATE', 'EXTRACT', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
  // Utility, Matematica & Conversioni
  'CAST', 'CONVERT', 'COALESCE', 'NULLIF', 'IFNULL', 'GREATEST', 'LEAST', 'FORMAT', 'HEX', 'UNHEX',
  'UUID', 'RAND', 'ABS', 'CEIL', 'CEILING', 'FLOOR', 'MOD', 'POW', 'POWER', 'ROUND', 'SQRT'
]);

// Tipi nativi e costruttori MongoShell
const MONGO_SHELL_TYPES = new Set([
  'ObjectId', 'ISODate', 'Date', 'NumberLong', 'NumberInt', 'NumberDecimal', 'Timestamp',
  'RegExp', 'UUID', 'BinData', 'MinKey', 'MaxKey', 'DBRef'
]);

// Parole chiave JavaScript degli script MongoDB (db/MongoScript.js). Sono
// confrontate sul testo ORIGINALE, non in maiuscolo: in JavaScript `let` è una
// parola chiave ma `LET` è un normale identificatore, e colorarli allo stesso
// modo darebbe l'idea sbagliata di cosa il motore riconosce.
const JS_KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'of', 'in',
  'while', 'do', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new',
  'typeof', 'instanceof', 'void', 'delete', 'this',
]);
// `true`/`false`/`null` restano fuori: sono già colorati come valori booleani
// più avanti, ed è la resa giusta anche negli script.

// Funzioni dell'ambiente degli script: non sono parole chiave, ma vederle
// colorate distingue subito ciò che l'interprete mette a disposizione da un
// nome qualsiasi (che sarebbe un errore "Nome non definito").
const JS_GLOBALS = new Set([
  'print', 'printjson', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'db',
]);

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converte una stringa di codice (SQL, MQL o MongoShell) in HTML colorato con classi CSS.
 * @param {string} code 
 * @param {string} [engineHint='auto'] 
 * @returns {string} HTML generato
 */
for (const d of Object.values(DIALETTI)) {
  for (const t of d.tipi) SQL_TYPES.add(t.split(/[ (\[]/)[0].toUpperCase());
  for (const f of [...d.funzioni, ...(d.estensioni || [])]) SQL_FUNCTIONS.add(f.toUpperCase());
}

export function highlightQueryCode(code, engineHint = 'auto') {
  if (!code) return '';
  const lingua = engineHint === 'mongosh' ? 'mongo' : linguaQuery(code, engineHint === 'mongodb' ? 'mongo' : 'sql');
  const mongo = lingua === 'mongo';
  const d = vocabolarioSql(engineHint);
  const parole = new Set(d.keywords.length ? d.keywords : SQL_KEYWORDS);
  const funzioni = d.nome ? new Set([...d.funzioni, ...d.estensioni, ...(d.soloQueste ? [] : FUNZIONI_COMUNI)].map(f => f.toUpperCase())) : SQL_FUNCTIONS;
  const tokens = tokenizzaQuery(code, { lingua, dbms: engineHint });
  const visibili = tokens.filter(t => t.tipo !== 'spazio');
  const indici = new Map(visibili.map((t, i) => [t, i]));
  return tokens.map(t => {
    let classe = '';
    const v = t.testo, upper = v.toUpperCase(), j = indici.get(t);
    const next = visibili[j + 1]?.testo, prev = visibili[j - 1]?.testo;
    if (t.tipo === 'commento' || t.tipo === 'hint') classe = 'comment';
    else if (t.tipo === 'identificatore') classe = 'backtick';
    else if (t.tipo === 'stringa') {
      classe = mongo && /^['"]\$/.test(v) ? 'mql-op' : mongo && next === ':' ? 'key' : 'string';
    } else if (t.tipo === 'numero' || t.tipo === 'parametro') classe = 'number';
    else if (t.tipo === 'parola') {
      if (/^(true|false|null)$/i.test(v)) classe = 'bool';
      else if (mongo) {
        if (v === 'db' && next === '.') classe = 'shell-db';
        else if (prev === '.' && next === '(') classe = 'shell-method';
        else if (prev === '.' && visibili[j - 2]?.testo === 'db') classe = 'shell-coll';
        else if (JS_KEYWORDS.has(v)) classe = 'keyword';
        else if (MONGO_SHELL_TYPES.has(v)) classe = 'shell-type';
        else if (JS_GLOBALS.has(v)) classe = 'function';
        else if (v.startsWith('$')) classe = 'mql-op';
        else if (next === ':') classe = 'key';
      } else if (next === '(' && funzioni.has(upper)) classe = 'function';
      else if (SQL_TYPES.has(upper)) classe = 'type';
      else if (parole.has(upper)) classe = 'keyword';
      else if (funzioni.has(upper)) classe = 'function';
    } else if (t.tipo === 'operatore' || t.tipo === 'punteggiatura') classe = 'operator';
    return classe ? '<span class="hl-' + classe + '">' + escHtml(v) + '</span>' : escHtml(v);
  }).join('');
}

/* Vocabolario condiviso: il formattatore (query-formatter.js) deve mettere in
 * maiuscolo ESATTAMENTE le parole che qui vengono riconosciute come SQL, e mai
 * un identificatore. Tenerlo in un solo posto evita che i due divergano. */
export { SQL_KEYWORDS, SQL_TYPES, SQL_FUNCTIONS, JS_KEYWORDS, MONGO_SHELL_TYPES };
