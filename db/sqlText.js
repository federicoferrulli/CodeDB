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

/** Statement separati dai `;` che stanno fuori da stringhe e commenti. */
function splitStatements(sql, opts) {
  return stripSqlNoise(sql, opts)
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Più di un'istruzione nello stesso testo? */
function hasMultipleStatements(sql) {
  return splitStatements(sql).length > 1;
}

module.exports = { stripSqlNoise, splitStatements, hasMultipleStatements };
