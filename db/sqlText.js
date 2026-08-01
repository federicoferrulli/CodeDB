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

/**
 * Rimuove commenti (`--`, `#`, `/* *\/`), stringhe letterali e identificatori
 * quotati, sostituendoli con segnaposto neutri. Il risultato non è SQL
 * eseguibile: serve solo a cercare parole chiave e separatori nel codice vero.
 *
 * Gli identificatori quotati diventano `_id_` perché un nome quotato non è mai
 * una parola chiave: `SELECT "update" FROM t` è una lettura, e senza questa
 * sostituzione verrebbe scambiata per una scrittura.
 */
function stripSqlNoise(sql, { keepIdentifiers = false } = {}) {
  const s = String(sql == null ? '' : sql);
  let out = '';
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '-' && next === '-') { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
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
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
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
function splitStatementsDetailed(sql) {
  const s = String(sql == null ? '' : sql);
  const out = [];
  let i = 0;
  let stmtStart = 0;

  // Riga del carattere `pos` (1-based), calcolata solo quando serve emettere
  // un'istruzione: contare le newline a ogni carattere sarebbe sprecato su file
  // da megabyte.
  const lineAt = (pos) => {
    let line = 1;
    for (let k = 0; k < pos && k < s.length; k++) if (s[k] === '\n') line++;
    return line;
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

    if (c === '-' && next === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        i = end < 0 ? s.length : end + tag.length;
        continue;
      }
    }

    if (c === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }

    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < s.length) {
        if (s[i] === close) { if (s[i + 1] === close) { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }

    if (c === ';') {
      push(i);
      i++;
      stmtStart = i;
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
  return splitStatementsDetailed(sql)
    .map((st) => stripSqlNoise(st.sql, opts).trim())
    .filter(Boolean);
}

/** Più di un'istruzione nello stesso testo? */
function hasMultipleStatements(sql) {
  return splitStatements(sql).length > 1;
}

module.exports = {
  stripSqlNoise,
  splitStatements,
  splitStatementsDetailed,
  hasMultipleStatements,
};
