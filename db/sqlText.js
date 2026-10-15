'use strict';

/* ---------------------------------------------------------------------------
 * Normalizzazione del testo SQL, condivisa da chi deve DECIDERE qualcosa
 * guardando una query senza eseguirla: classificazione lettura/scrittura per
 * permessi e audit (`auth/capabilities.js`), validazione delle clausole libere
 * (`auth/sqlClause.js`), validazione del DDL nei backup (`backup/lib/restore.js`).
 *
 * Il punto è sempre lo stesso: le regole vanno applicate al CODICE, non a ciò
 * che sta dentro una stringa o un commento. Senza questo passaggio
 *
 *     SELECT * FROM note WHERE testo = 'a;b'
 *     SELECT * FROM audit WHERE azione = 'DELETE'
 *
 * verrebbero classificate come scritture e negate a chi le esegue legittimamente,
 * mentre
 *
 *     /* commento *\/ DELETE FROM users
 *
 * passerebbe per una lettura perché la prima parola non è una keyword.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * La barra rovesciata dentro un literal: una differenza di DIALETTO che qui
 * pesa parecchio.
 *
 * MySQL la tratta come carattere di escape; PostgreSQL, con
 * `standard_conforming_strings=on` (predefinito dalla 9.1), NO — lì un literal
 * che finisce con una barra rovesciata è un literal COMPLETO, e solo la forma
 * `E'…'` reintroduce gli escape.
 *
 * Trattarla sempre come escape (il comportamento storico di questo modulo)
 * significa, su PostgreSQL, LEGGERE MENO ISTRUZIONI di quante ne verranno
 * eseguite: una stringa che termina con la barra rovesciata "assorbe" il resto
 * del testo, la DROP che segue finisce dentro quella che lo splitter crede una
 * stringa e `isWriteSql` risponde "lettura" — mentre la DROP viene eseguita
 * davvero, perché `collectionAggregate` usa il simple query protocol, e finisce
 * nell'audit come lettura.
 *
 * Il predefinito è quindi ANSI (barra rovesciata ordinaria), che è la direzione
 * CONSERVATIVA per entrambi i dialetti: al massimo si divide PIÙ del dovuto, e
 * dividere di più fa classificare come SCRITTURA, cioè chiedere la capability
 * più alta invece della più bassa. Chi divide uno script per ESEGUIRLO — dove
 * dividere male romperebbe le istruzioni — passa il dialetto vero con
 * `{ backslashEscape: true }`.
 * ------------------------------------------------------------------------- */

/** Indice subito dopo un literal fra apici singoli aperto in `apertura`. */
function fineLiteral(s, apertura, backslashEscape) {
  let i = apertura + 1;
  while (i < s.length) {
    if (backslashEscape && s[i] === '\\') { i += 2; continue; }
    if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } return i + 1; }
    i++;
  }
  return s.length;
}

/**
 * L'apice in posizione `i` apre un literal in cui la barra rovesciata è un
 * escape? Sempre nel dialetto MySQL; in ANSI solo con il prefisso `E`/`e` di
 * PostgreSQL, che va riconosciuto come parola a sé (`E'x'`, non `nomeE'x'`).
 */
function literalConEscape(s, i, backslashEscape) {
  if (backslashEscape) return true;
  const prev = s[i - 1];
  if (prev !== 'E' && prev !== 'e') return false;
  const prima = s[i - 2];
  return prima === undefined || !/[A-Za-z0-9_$]/.test(prima);
}

/**
 * Rimuove commenti (`--`, `#`, `/* *\/`), stringhe letterali e identificatori
 * quotati, sostituendoli con segnaposto neutri. Il risultato non è SQL
 * eseguibile: serve solo a cercare parole chiave e separatori nel codice vero.
 *
 * Gli identificatori quotati diventano `_id_` perché un nome quotato non è mai
 * una parola chiave: `SELECT "update" FROM t` è una lettura, e senza questa
 * sostituzione verrebbe scambiata per una scrittura.
 */
function fineCommentoBlocco(s, i, annidati) {
  i += 2;
  let profondita = 1;
  while (i < s.length && profondita) {
    if (annidati && s.slice(i, i + 2) === '/*') { profondita++; i += 2; }
    else if (s.slice(i, i + 2) === '*/') { profondita--; i += 2; }
    else i++;
  }
  return i;
}

function stripSqlNoise(sql, { keepIdentifiers = false, backslashEscape = false, dbms = '' } = {}) {
  const s = String(sql == null ? '' : sql);
  let out = '';
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '-' && next === '-' && (dbms !== 'mysql' || !s[i + 2] || /\s/.test(s[i + 2]))) { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '#' && dbms !== 'postgresql' && next !== '>' && next !== '-') { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && next === '*') {
      i = fineCommentoBlocco(s, i, dbms === 'postgresql');
      out += ' ';
      continue;
    }

    // Dollar-quoting PostgreSQL: $$ … $$ oppure $tag$ … $tag$ (corpi di
    // funzione, testi lunghi). Senza gestirlo, il contenuto verrebbe letto come
    // codice e qualunque parola dentro un corpo di funzione falserebbe l'analisi.
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        i = end < 0 ? s.length : end + tag.length;
        out += " '' ";
        continue;
      }
    }

    if (c === "'") {
      i = fineLiteral(s, i, literalConEscape(s, i, backslashEscape));
      out += " '' ";
      continue;
    }

    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let inner = '';
      i++;
      while (i < s.length) {
        if (s[i] === close) { if (s[i + 1] === close) { inner += close; i += 2; continue; } i++; break; }
        inner += s[i];
        i++;
      }
      out += keepIdentifiers ? ` ${inner} ` : ' _id_ ';
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/* ---------------------------------------------------------------------------
 * Divisione in istruzioni.
 *
 * `stripSqlNoise` produce testo NORMALIZZATO: perfetto per DECIDERE (permessi,
 * audit, validazione), inutilizzabile per ESEGUIRE, perché stringhe e commenti
 * sono stati sostituiti da segnaposto. Il runner di script ha bisogno del testo
 * VERO di ogni istruzione, quindi `splitStatementsDetailed` ripercorre
 * l'originale con lo stesso lexer ma conservando i caratteri e le posizioni.
 *
 * Un solo lexer per entrambe le esigenze: `splitStatements` è costruita sopra
 * `splitStatementsDetailed`, così non possono divergere sul punto delicato —
 * quali `;` separano davvero due istruzioni e quali stanno dentro una stringa,
 * un commento o un blocco dollar-quoted.
 * ------------------------------------------------------------------------- */

/**
 * Percorre l'SQL e restituisce le istruzioni separate dai `;` che stanno fuori
 * da stringhe, commenti e dollar-quoting, con il TESTO ORIGINALE e la posizione.
 *
 * @returns {Array<{sql: string, start: number, end: number, line: number}>}
 *   `sql` = testo dell'istruzione senza il `;` finale, ripulito agli estremi;
 *   `start`/`end` = offset nel sorgente; `line` = riga 1-based del primo
 *   carattere non bianco (serve a puntare l'errore nell'editor).
 */
function splitStatementsDetailed(sql, { backslashEscape = false, dbms = '' } = {}) {
  let blocchi = require('../public/js/sql-blocchi.mjs').blocchiSql();
  const s = String(sql == null ? '' : sql);
  const out = [];
  let i = 0;
  let stmtStart = 0;
  let delimitatore = ';', haCodice = false;

  // Riga del carattere `pos` (1-based).
  //
  // Il conteggio è INCREMENTALE e non riparte da capo a ogni istruzione: le
  // chiamate arrivano in ordine crescente di `pos` (si emette un'istruzione
  // dopo l'altra), quindi basta ricordare dove si era arrivati. Ripartire da
  // zero rendeva la divisione quadratica — `O(N × L)` — e non su un percorso
  // raro: `splitStatements` è usata da `isWriteSql`, cioè da OGNI
  // `collection:aggregate` e `query:execute` su MySQL/PostgreSQL. Un testo di
  // 2,5 MB fatto di `a;` ripetuto vale ~10¹² passi in un ciclo sincrono che non
  // cede mai il controllo: il processo si ferma e non torna più, portandosi via
  // tutte le sessioni, il gateway MCP e la finestra dell'app desktop.
  // Il gemello client (`public/js/sql-split.js`) tiene la riga così da sempre.
  let ultimaPos = 0;
  let ultimaRiga = 1;
  const lineAt = (pos) => {
    const fine = Math.min(pos, s.length);
    for (let k = ultimaPos; k < fine; k++) if (s[k] === '\n') ultimaRiga++;
    if (fine > ultimaPos) ultimaPos = fine;
    return ultimaRiga;
  };

  const push = (end) => {
    const raw = s.slice(stmtStart, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) {
      out.push({ sql: text, start: stmtStart + lead, end, line: lineAt(stmtStart + lead) });
    }
  };

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (dbms === 'mysql' && !haCodice && (i === 0 || s[i - 1] === '\n')) {
      const direttiva = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(s.slice(i));
      if (direttiva) { delimitatore = direttiva[1]; i += direttiva[0].length; stmtStart = i; continue; }
    }
    if (delimitatore !== ';' && s.startsWith(delimitatore, i)) {
      push(i); i += delimitatore.length; stmtStart = i; haCodice = false;
      blocchi = require('../public/js/sql-blocchi.mjs').blocchiSql();
      continue;
    }

    if (c === '-' && next === '-' && (dbms !== 'mysql' || !s[i + 2] || /\s/.test(s[i + 2]))) { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '#' && dbms !== 'postgresql' && next !== '>' && next !== '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      if (s[i + 2] === '!') haCodice = true;
      i = fineCommentoBlocco(s, i, dbms === 'postgresql');
      continue;
    }
    if (!/\s/.test(c)) haCodice = true;

    if (c === '$' && dbms !== 'mysql') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        i = end < 0 ? s.length : end + tag.length;
        continue;
      }
    }

    if (c === "'") {
      i = fineLiteral(s, i, literalConEscape(s, i, backslashEscape));
      continue;
    }

    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < s.length) {
        if (c === '"' && backslashEscape && s[i] === '\\') { i += 2; continue; }
        if (s[i] === close) { if (s[i + 1] === close) { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let token = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i))[0];
      if (delimitatore !== ';' && token.includes(delimitatore)) token = token.slice(0, token.indexOf(delimitatore));
      blocchi.parola(token); i += token.length; continue;
    }
    if (c === ';' && delimitatore === ';' && blocchi.separa()) {
      push(i);
      i++;
      stmtStart = i;
      haCodice = false;
      continue;
    }

    i++;
  }

  // Ultima istruzione senza `;` finale.
  push(s.length);
  return out;
}

/** Statement separati dai `;` che stanno fuori da stringhe e commenti. */
function splitStatements(sql, opts) {
  // Il testo va normalizzato DOPO la divisione: normalizzare prima cancella i
  // commenti ma lascia il loro posto vuoto, e chi classifica vuole comunque il
  // codice ripulito, istruzione per istruzione.
  return splitStatementsDetailed(sql, opts)
    .map((st) => stripSqlNoise(st.sql, opts).trim())
    .filter(Boolean);
}

/** Più di un'istruzione nello stesso testo? */
function hasMultipleStatements(sql, opts) {
  return splitStatements(sql, opts).length > 1;
}

module.exports = {
  stripSqlNoise,
  splitStatements,
  splitStatementsDetailed,
  hasMultipleStatements,
};
