/**
 * CodeDB — Divisione del testo in istruzioni (lato client)
 *
 * Gemello ESM di `db/sqlText.js`: stesso lexer, stessa idea — un `;` separa due
 * istruzioni solo se sta FUORI da stringhe, commenti, identificatori quotati e
 * blocchi dollar-quoted.
 *
 * Qui serve a UNA sola cosa: decidere se il testo nell'editor è una query
 * singola o uno script, cioè su quale evento instradarlo (`query:execute` o
 * `script:execute`). La divisione che conta davvero — quella su cui si esegue —
 * resta quella del server: il client non deve mai poter influenzare COSA viene
 * eseguito, solo su quale percorso viaggia.
 */

/**
 * Percorre il testo e restituisce le istruzioni con la riga di partenza.
 * @returns {Array<{sql: string, line: number}>}
 */
export function splitStatements(code) {
  const s = String(code == null ? '' : code);
  const out = [];
  let i = 0;
  let stmtStart = 0;
  let line = 1;
  let stmtLine = 1;
  let visto = false; // c'è del contenuto non bianco nell'istruzione corrente?

  const avanza = (fino) => {
    while (i < fino && i < s.length) {
      if (s[i] === '\n') line++;
      i++;
    }
  };

  const chiudi = (end) => {
    const testo = s.slice(stmtStart, end).trim();
    if (testo) out.push({ sql: testo, line: stmtLine });
    visto = false;
  };

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (!visto && !/\s/.test(c)) {
      visto = true;
      stmtLine = line;
    }

    if (c === '-' && next === '-') { avanza(indexOrEnd(s, '\n', i)); continue; }
    if (c === '#') { avanza(indexOrEnd(s, '\n', i)); continue; }
    if (c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      avanza(end < 0 ? s.length : end + 2);
      continue;
    }

    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        avanza(end < 0 ? s.length : end + tag.length);
        continue;
      }
    }

    if (c === "'") {
      // La barra rovesciata è un escape solo con il prefisso E'…' di
      // PostgreSQL: altrove è un carattere ordinario. Deve valere
      // esattamente la regola di db/sqlText.js — i due splitter non
      // possono divergere (test/unit-sql-split-client.js).
      const conEscape = s[i - 1] === 'E' || s[i - 1] === 'e'
        ? (s[i - 2] === undefined || !/[A-Za-z0-9_$]/.test(s[i - 2]))
        : false;
      i++;
      while (i < s.length) {
        if (conEscape && s[i] === '\\') { avanza(i + 2); continue; }
        if (s[i] === "'") { if (s[i + 1] === "'") { avanza(i + 2); continue; } avanza(i + 1); break; }
        avanza(i + 1);
      }
      continue;
    }

    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      avanza(i + 1);
      while (i < s.length) {
        if (s[i] === close) { if (s[i + 1] === close) { avanza(i + 2); continue; } avanza(i + 1); break; }
        avanza(i + 1);
      }
      continue;
    }

    if (c === ';') {
      chiudi(i);
      avanza(i + 1);
      stmtStart = i;
      continue;
    }

    avanza(i + 1);
  }

  chiudi(s.length);
  return out;
}

function indexOrEnd(s, needle, from) {
  const idx = s.indexOf(needle, from);
  return idx < 0 ? s.length : idx;
}

/** Il testo contiene più di un'istruzione? (è quindi uno "script") */
export function isScript(code) {
  return splitStatements(code).length > 1;
}

/** Numero di istruzioni, per l'anteprima nella UI ("Esegui script (N)"). */
export function countStatements(code) {
  return splitStatements(code).length;
}
