'use strict';

/* ---------------------------------------------------------------------------
 * Clausole WHERE/ORDER BY libere: quando sono ammesse e in che forma.
 *
 * Sulla griglia SQL il filtro è un frammento di SQL grezzo (`WHERE ` + testo) e
 * l'ordinamento pure. È una funzionalità dichiarata e comoda, ma non è vincolata
 * allo scope: un sottoutente limitato alla collezione "ordini" può scrivere
 *
 *     1=1 AND (SELECT COUNT(*) FROM utenti WHERE password LIKE 'a%') > 0
 *
 * e leggere a oracolo binario una tabella fuori dal proprio perimetro — lo scope
 * dei permessi vive sopra il nome della tabella, non dentro il testo della query.
 *
 * REGOLA ADOTTATA (vedi l'analisi d'impatto dell'audit)
 * La restrizione si applica SOLO ai principal che hanno effettivamente uno scope
 * su database o collezioni: per l'owner e per i sottoutenti senza scope non
 * cambia nulla, quindi nessuno perde una funzionalità che oggi usa. Per gli altri
 * si accetta la forma strutturata — confronti fra colonna e valore, combinati da
 * AND/OR, con parentesi — e si rifiuta tutto ciò che permette di uscire dalla
 * tabella corrente: sotto-query, UNION, chiamate di funzione, commenti, più
 * statement.
 *
 * Questo è un filtro sintattico, non una barriera assoluta: la protezione solida
 * resta a monte, cioè aprire le connessioni dei sottoutenti con un utente DBMS a
 * privilegi ridotti. Il messaggio d'errore lo dice, invece di limitarsi a negare.
 * ------------------------------------------------------------------------- */

// Parole che non hanno nulla da fare in un filtro o in un ordinamento della
// griglia e che sono la via d'uscita dalla tabella corrente.
const FORBIDDEN_WORDS = new Set([
  'select', 'union', 'intersect', 'except', 'with', 'insert', 'update', 'delete',
  'drop', 'alter', 'create', 'truncate', 'rename', 'grant', 'revoke', 'call',
  'execute', 'exec', 'do', 'handler', 'load', 'outfile', 'dumpfile', 'infile',
  'into', 'from', 'join', 'where', 'having', 'values', 'set', 'declare',
  'information_schema', 'pg_catalog', 'mysql', 'performance_schema', 'sys',
  'sleep', 'benchmark', 'pg_sleep', 'waitfor', 'lock', 'copy', 'returning',
]);

// Parole ammesse in una condizione o in un ordinamento.
const ALLOWED_WORDS = new Set([
  'and', 'or', 'not', 'is', 'null', 'in', 'between', 'like', 'ilike', 'rlike',
  'regexp', 'true', 'false', 'asc', 'desc', 'nulls', 'first', 'last', 'escape',
  'unknown', 'collate', 'binary',
]);

const IDENT_START = /[A-Za-z_-￿]/;
const IDENT_CHAR = /[A-Za-z0-9_$.-￿]/;

/**
 * Tokenizza una clausola. Non è un parser SQL completo: serve solo a distinguere
 * parole, stringhe, numeri e simboli, così le regole si applicano al codice e
 * non al contenuto dei valori.
 * @returns {{ words: string[], hasCall: boolean, bad: string|null }}
 */
function scanClause(text) {
  const s = String(text);
  const words = [];
  let hasCall = false;
  let bad = null;
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    // Commenti e separatori di statement: sempre rifiutati.
    if (c === ';') { bad = 'più istruzioni separate da ";"'; break; }
    if (c === '-' && s[i + 1] === '-') { bad = 'commenti SQL (--)'; break; }
    if (c === '#') { bad = 'commenti SQL (#)'; break; }
    if (c === '/' && s[i + 1] === '*') { bad = 'commenti SQL (/* */)'; break; }

    // Stringhe: il contenuto è un valore, non codice.
    if (c === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    // Identificatori quotati: il contenuto è un nome di colonna.
    if (c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) i++;
      i++;
      continue;
    }

    if (IDENT_START.test(c)) {
      let word = '';
      while (i < s.length && IDENT_CHAR.test(s[i])) { word += s[i]; i++; }
      const lower = word.toLowerCase();
      words.push(lower);
      // Chiamata di funzione: `parola(` — vietata in blocco, così anche le
      // funzioni pericolose non elencate (LOAD_FILE, lo_import, …) non passano.
      // Le parole chiave ammesse fanno eccezione: `IN (1,2,3)` e `NOT (a = 1)`
      // sono costrutti legittimi, non invocazioni.
      if (!ALLOWED_WORDS.has(lower)) {
        let j = i;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '(') hasCall = true;
      }
      continue;
    }

    i++;
  }

  return { words, hasCall, bad };
}

/**
 * @param {string} text clausola scritta dall'utente
 * @param {'filtro'|'ordinamento'} what per il messaggio d'errore
 * @throws se la clausola non è nella forma consentita ai principal con scope
 */
function assertSimpleClause(text, what) {
  const raw = String(text || '').trim();
  if (!raw) return;

  const { words, hasCall, bad } = scanClause(raw);
  const refuse = (motivo) => {
    throw new Error(
      `${what === 'ordinamento' ? 'Ordinamento' : 'Filtro'} non consentito: ${motivo}. ` +
      'Il tuo utente ha un ambito limitato a specifici database/collezioni, quindi qui sono ammessi ' +
      'solo confronti fra colonna e valore combinati con AND/OR (es. stato = \'aperto\' AND totale > 100). ' +
      'Per query più libere chiedi all\'amministratore un accesso senza limiti di ambito.'
    );
  };

  if (bad) refuse(bad);
  if (hasCall) refuse('chiamate di funzione');
  for (const w of words) {
    if (ALLOWED_WORDS.has(w)) continue;
    if (FORBIDDEN_WORDS.has(w)) refuse(`la parola chiave "${w.toUpperCase()}"`);
    // Qualsiasi altra parola è trattata come nome di colonna: legittima.
  }
}

/**
 * Applica le regole al payload di una lettura/cancellazione sulla griglia SQL,
 * ma solo per i principal con uno scope attivo sulla connessione.
 * @param {object} payload payload della strategia (filter/sort liberi)
 */
function assertScopedClauses(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.filter != null) assertSimpleClause(payload.filter, 'filtro');
  // `sort` può essere anche un JSON {"col":1}: in quel caso non c'è SQL libero.
  if (payload.sort != null) {
    const t = String(payload.sort).trim();
    if (t && !t.startsWith('{')) assertSimpleClause(t, 'ordinamento');
  }
}

module.exports = { assertSimpleClause, assertScopedClauses, FORBIDDEN_WORDS, ALLOWED_WORDS };
