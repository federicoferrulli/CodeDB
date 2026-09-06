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
export function highlightQueryCode(code, engineHint = 'auto') {
  if (!code) return '';

  const str = String(code);
  let html = '';
  let i = 0;
  const len = str.length;

  while (i < len) {
    const c = str[i];
    const rest = str.substring(i);

    // Commenti SQL a riga singola (-- comment)
    if (c === '-' && str[i + 1] === '-') {
      let end = str.indexOf('\n', i);
      if (end === -1) end = len;
      html += `<span class="hl-comment">${escHtml(str.substring(i, end))}</span>`;
      i = end;
      continue;
    }

    // Commenti blocco (/* comment */)
    if (c === '/' && str[i + 1] === '*') {
      let end = str.indexOf('*/', i + 2);
      if (end === -1) end = len; else end += 2;
      html += `<span class="hl-comment">${escHtml(str.substring(i, end))}</span>`;
      i = end;
      continue;
    }

    // Stringhe con apici singoli o doppi ('...' o "...")
    if (c === "'" || c === '"') {
      const quote = c;
      let end = i + 1;
      while (end < len) {
        if (str[end] === quote) {
          if (str[end - 1] !== '\\' || (str[end - 2] === '\\' && str[end - 1] === '\\')) {
            end++;
            break;
          }
        }
        end++;
      }

      const stringVal = str.substring(i, end);

      // Verifichiamo se si tratta di una chiave JSON (es. "status": ...) o di un operatore MQL (es. "$match")
      const afterString = str.substring(end).trimStart();
      if (quote === '"' && stringVal.startsWith('"$') && stringVal.length > 2) {
        html += `<span class="hl-mql-op">${escHtml(stringVal)}</span>`;
      } else if (quote === '"' && afterString.startsWith(':')) {
        html += `<span class="hl-key">${escHtml(stringVal)}</span>`;
      } else {
        html += `<span class="hl-string">${escHtml(stringVal)}</span>`;
      }

      i = end;
      continue;
    }

    // Identificatori quotati con backtick (`col` / `db`)
    if (c === '`') {
      let end = str.indexOf('`', i + 1);
      if (end === -1) end = len; else end += 1;
      html += `<span class="hl-backtick">${escHtml(str.substring(i, end))}</span>`;
      i = end;
      continue;
    }

    // Numeri
    if (/\d/.test(c) && (i === 0 || /[\s,(=+\-*/<>;:[\]{}]/.test(str[i - 1]))) {
      const numMatch = rest.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?\b/);
      if (numMatch) {
        html += `<span class="hl-number">${escHtml(numMatch[0])}</span>`;
        i += numMatch[0].length;
        continue;
      }
    }

    // Sintassi MongoShell: db.collezione.metodo(...)
    const shellMatch = rest.match(/^db\.([a-zA-Z0-9_\-]+)\.([a-zA-Z0-9_]+)\b/);
    if (shellMatch) {
      html += `<span class="hl-shell-db">db</span>.<span class="hl-shell-coll">${escHtml(shellMatch[1])}</span>.<span class="hl-shell-method">${escHtml(shellMatch[2])}</span>`;
      i += shellMatch[0].length;
      continue;
    }

    // Parole (Parole chiave, Tipi SQL, Funzioni, Tipi Shell, Identificatori)
    if (/[a-zA-Z_$]/.test(c)) {
      const wordMatch = rest.match(/^[a-zA-Z0-9_$]+/);
      if (wordMatch) {
        const word = wordMatch[0];
        const upper = word.toUpperCase();

        if (JS_KEYWORDS.has(word)) {
          // Prima dei set SQL: `in`, `for` e `do` esistono in entrambi i mondi,
          // ma il confronto JS è sul testo esatto e quindi più specifico.
          html += `<span class="hl-keyword">${escHtml(word)}</span>`;
        } else if (JS_GLOBALS.has(word) && word !== 'db') {
          html += `<span class="hl-function">${escHtml(word)}</span>`;
        } else if (SQL_KEYWORDS.has(upper)) {
          html += `<span class="hl-keyword">${escHtml(word)}</span>`;
        } else if (SQL_TYPES.has(upper)) {
          html += `<span class="hl-type">${escHtml(word)}</span>`;
        } else if (SQL_FUNCTIONS.has(upper)) {
          html += `<span class="hl-function">${escHtml(word)}</span>`;
        } else if (MONGO_SHELL_TYPES.has(word)) {
          html += `<span class="hl-shell-type">${escHtml(word)}</span>`;
        } else if (word.startsWith('$')) {
          html += `<span class="hl-mql-op">${escHtml(word)}</span>`;
        } else if (upper === 'TRUE' || upper === 'FALSE' || upper === 'NULL') {
          html += `<span class="hl-bool">${escHtml(word)}</span>`;
        } else {
          html += escHtml(word);
        }

        i += word.length;
        continue;
      }
    }

    // Operatori e punteggiatura
    if (/^[=!=><+\-*/%;,()[\]{}]/.test(c)) {
      const opMatch = rest.match(/^(?:<=|>=|!=|<>|==|&&|\|\||=>|[=!><+\-*/%;,()[\]{}])/);
      if (opMatch) {
        html += `<span class="hl-operator">${escHtml(opMatch[0])}</span>`;
        i += opMatch[0].length;
        continue;
      }
    }

    // Carattere generico o spazio
    html += escHtml(c);
    i++;
  }

  return html;
}

/* Vocabolario condiviso: il formattatore (query-formatter.js) deve mettere in
 * maiuscolo ESATTAMENTE le parole che qui vengono riconosciute come SQL, e mai
 * un identificatore. Tenerlo in un solo posto evita che i due divergano. */
export { SQL_KEYWORDS, SQL_TYPES, SQL_FUNCTIONS, JS_KEYWORDS, MONGO_SHELL_TYPES };
