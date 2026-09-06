/**
 * CodeDB — La regola unica per scrivere il nome di una tabella o di una colonna
 *
 * Scrivere un identificatore dentro una query è una decisione in due tempi:
 * **se** vada quotato, e **come** si raddoppia il carattere di quotatura quando
 * compare dentro il nome. La stessa decisione serviva in sette punti — i due
 * adattatori SQL, il DDL di PostgreSQL, i JOIN virtuali, la copia SQL della
 * selezione di celle, il vocabolario dei dialetti e il motore di backup — e uno
 * solo dei sette sapeva rispondere alla prima domanda: gli altri quotavano
 * sempre o mai. È la classe di difetto per cui su PostgreSQL un nome con
 * maiuscole scritto nudo viene **abbassato** dal motore, e la tabella `Prova`
 * non si trova più.
 *
 * Le due domande restano due funzioni distinte, perché i chiamanti sono di due
 * specie e nessuna delle due è sbagliata:
 *
 *  - chi **compone** SQL per il motore (adattatori, DDL, backup, JOIN virtuali)
 *    quota sempre: è il modo più sicuro, e il nome lì non lo legge nessuno;
 *  - chi **scrive nell'editor dell'utente** (completamento, doppio clic sullo
 *    Schema Browser) quota solo quando serve davvero, altrimenti riempirebbe le
 *    query di virgolette che nessuno ha chiesto.
 *
 * Estensione `.mjs` per un motivo preciso: questo modulo è l'unico del repo che
 * serve **da tutte e due le parti**. Il browser lo importa come modulo ES; il
 * server, che è CommonJS, lo raggiunge con `require()` — cosa che Node concede
 * solo a un file dichiaratamente ESM, quale `.js` in questo pacchetto non è.
 * Per questo non ha alcuna dipendenza: nessun DOM, nessun `require`, nessun
 * import. Il ponte lato server è `db/identificatori.js`.
 */

/**
 * Il carattere con cui ogni motore delimita un identificatore.
 *
 * Su MongoDB il carattere NON è il doppio apice: l'SQL passa da
 * `db/SqlToMql.js`, il cui tokenizzatore tratta `"…"` come una **stringa** e
 * riconosce come identificatori quotati solo `` `…` `` e `[…]`. Scriverci
 * `"Prova"` non darebbe una tabella, darebbe un testo.
 */
export const APICE = { mysql: '`', postgresql: '"', mongodb: '`' };

/** Normalizza il nome del motore nelle tre famiglie che CodeDB conosce. */
export function dialettoDi(dbType) {
  const t = String(dbType || '').toLowerCase();
  if (t === 'mysql' || t === 'mariadb') return 'mysql';
  if (t === 'postgresql' || t === 'postgres' || t === 'pg') return 'postgresql';
  if (t === 'mongodb' || t === 'mongo') return 'mongodb';
  return '';
}

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
  return delimita(s, APICE[dialettoDi(dbType)]);
}

/**
 * Il nome quotato comunque, per chi compone SQL che l'utente non legge.
 *
 * Qui un motore sconosciuto è un errore del chiamante, non un caso da
 * attraversare in punta di piedi: scegliere un carattere di quotatura a caso
 * produrrebbe una query sintatticamente valida per il motore sbagliato, cioè
 * esattamente il difetto silenzioso che questo modulo esiste per togliere.
 */
export function quotaSempre(nome, dbType) {
  const d = dialettoDi(dbType);
  if (!d) throw new Error(`Motore sconosciuto per la quotatura dell'identificatore: "${dbType}"`);
  return delimita(String(nome == null ? '' : nome), APICE[d]);
}

/**
 * Un nome qualificato (`schema.tabella`, `database.tabella`) con ogni pezzo
 * quotato per conto suo. I pezzi vuoti o assenti si saltano, così chi non ha
 * uno schema da anteporre passa `null` invece di comporre due rami.
 *
 * Il punto NON viene mai quotato dentro un pezzo: un nome che contiene un punto
 * resta un pezzo solo, altrimenti `mia.tabella` diventerebbe due oggetti.
 */
export function quotaQualificato(parti, dbType, { sempre = true } = {}) {
  const quota = sempre ? quotaSempre : quotaIdentificatore;
  return (Array.isArray(parti) ? parti : [parti])
    .filter((p) => p != null && String(p) !== '')
    .map((p) => quota(p, dbType))
    .join('.');
}

/** Mette il nome fra due apici, raddoppiando quelli che contiene. */
function delimita(s, apice) {
  return apice + s.split(apice).join(apice + apice) + apice;
}

/* ==========================================================================
 * Parole riservate
 *
 * Stanno qui, e non nell'evidenziatore di sintassi da cui venivano, perché la
 * quotatura è l'unico posto in cui sbagliarle **rompe una query**: un nome di
 * colonna chiamato `order` scritto nudo è un errore di sintassi, non un colore
 * mancante. L'evidenziatore le ri-esporta da qui.
 * ========================================================================== */

export const SQL_KEYWORDS = new Set([
  // Query & Data Manipulation (DML)
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'TOP',
  'WITH', 'RECURSIVE', 'WINDOW', 'OVER', 'PARTITION', 'RANGE', 'ROWS', 'UNBOUNDED',
  'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'FOR', 'SHARE', 'FETCH', 'FIRST', 'NEXT', 'ONLY',
  // Joins
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'ON', 'USING',
  // Data Modification
  'INSERT', 'INTO', 'VALUES', 'VALUE', 'UPDATE', 'SET', 'DELETE', 'REPLACE', 'UPSERT', 'MERGE', 'MATCHED',
  // Data Definition (DDL)
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'TABLE', 'DATABASE', 'SCHEMA', 'VIEW',
  'INDEX', 'UNIQUE', 'COLUMN', 'ADD', 'MODIFY', 'CHANGE', 'CONSTRAINT', 'FOREIGN', 'REFERENCES',
  'CASCADE', 'RESTRICT', 'CHECK', 'DEFAULT', 'AUTO_INCREMENT', 'PRIMARY', 'KEY', 'ENGINE', 'CHARSET', 'COLLATE',
  // TCL / DCL / Security
  'COMMIT', 'ROLLBACK', 'TRANSACTION', 'BEGIN', 'START', 'SAVEPOINT', 'LOCK', 'SHARED',
  'EXCLUSIVE', 'GRANT', 'REVOKE', 'PRIVILEGES',
  // Logic & Conditional
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'EXISTS',
  // Set & Comparison Operators
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'REGEXP', 'RLIKE', 'IS', 'NULL', 'BETWEEN',
  'UNION', 'INTERSECT', 'EXCEPT', 'MINUS', 'ALL', 'ANY', 'SOME', 'DISTINCT', 'AS', 'ASC', 'DESC',
  'NULLS', 'LAST',
  // Statements & Utility
  'USE', 'EXPLAIN', 'ANALYZE', 'DESCRIBE', 'DESC', 'SHOW', 'STATUS', 'VARIABLES', 'CALL',
  'EXEC', 'EXECUTE', 'PREPARE', 'DEALLOCATE', 'DUPLICATE', 'IGNORE'
]);
