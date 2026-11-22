/**
 * CodeDB — Divisione del testo in istruzioni (lato client)
 *
 * Gemello ESM di `db/sqlText.js`: stesso lexer, stessa idea — un `;` separa due
 * istruzioni solo se sta FUORI da stringhe, commenti, identificatori quotati e
 * blocchi dollar-quoted.
 *
 * L'editor distingue query e script. L'indice dei file SQL usa gli stessi
 * intervalli per trasportare istruzioni intere. Il server verifica e divide
 * il testo ricevuto prima di eseguirlo.
 */

import { blocchiSql } from './sql-blocchi.mjs';

// next è l'offset UTF-16 dopo il separatore. L'ultimo intervallo, con next
// nullo, può proseguire nella successiva finestra di lettura di un file.
export function* intervalliSql(code, { dbms = '', backslashEscape = false, delimiter = ';' } = {}) {
  let blocchi = blocchiSql();
  const s = String(code == null ? '' : code);
  let i = 0;
  let stmtStart = 0;
  let line = 1;
  let stmtLine = 1;
  let visto = false; // c'è del contenuto non bianco nell'istruzione corrente?
  let delimitatore = delimiter, haCodice = false;

  const avanza = (fino) => {
    while (i < fino && i < s.length) {
      if (s[i] === '\n') line++;
      i++;
    }
  };

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (dbms === 'mysql' && !haCodice && (i === 0 || s[i - 1] === '\n')) {
      const direttiva = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(s.slice(i));
      if (direttiva) { delimitatore = direttiva[1]; avanza(i + direttiva[0].length); stmtStart = i; visto = false; continue; }
    }
    if (delimitatore !== ';' && s.startsWith(delimitatore, i)) {
      yield { start: stmtStart, end: i, next: i + delimitatore.length, line: stmtLine, delimiter: delimitatore, haCodice };
      avanza(i + delimitatore.length); stmtStart = i; visto = false; haCodice = false; blocchi = blocchiSql(); continue;
    }

    if (!visto && !/\s/.test(c)) {
      visto = true;
      stmtLine = line;
    }

    if (c === '-' && next === '-' && (dbms !== 'mysql' || !s[i + 2] || /\s/.test(s[i + 2]))) { avanza(indexOrEnd(s, '\n', i)); continue; }
    if (c === '#' && dbms !== 'postgresql' && next !== '>' && next !== '-') { avanza(indexOrEnd(s, '\n', i)); continue; }
    if (c === '/' && next === '*') {
      if (dbms === 'mysql' && (s[i + 2] === '!' || s.startsWith('/*M!', i))) haCodice = true;
      avanza(i + 2);
      let profondita = 1;
      while (i < s.length && profondita) {
        if (dbms === 'postgresql' && s.slice(i, i + 2) === '/*') { profondita++; avanza(i + 2); }
        else if (s.slice(i, i + 2) === '*/') { profondita--; avanza(i + 2); }
        else avanza(i + 1);
      }
      continue;
    }
    if (c !== ';' && !/\s/.test(c)) haCodice = true;

    if (c === '$' && dbms !== 'mysql') {
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
      const conEscape = backslashEscape || (s[i - 1] === 'E' || s[i - 1] === 'e'
        ? (s[i - 2] === undefined || !/[A-Za-z0-9_$]/.test(s[i - 2]))
        : false);
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
        if (c === '"' && backslashEscape && s[i] === '\\') { avanza(i + 2); continue; }
        if (s[i] === close) { if (s[i + 1] === close) { avanza(i + 2); continue; } avanza(i + 1); break; }
        avanza(i + 1);
      }
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let token = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i))[0];
      if (delimitatore !== ';' && token.includes(delimitatore)) token = token.slice(0, token.indexOf(delimitatore));
      blocchi.parola(token); avanza(i + token.length); continue;
    }
    if (c === ';' && delimitatore === ';' && blocchi.separa()) {
      yield { start: stmtStart, end: i, next: i + 1, line: stmtLine, delimiter: delimitatore, haCodice };
      avanza(i + 1);
      stmtStart = i;
      visto = false;
      haCodice = false;
      continue;
    }

    avanza(i + 1);
  }

  yield { start: stmtStart, end: s.length, next: null, line: stmtLine, delimiter: delimitatore, haCodice };
}

export function splitStatements(code, opts) {
  const s = String(code ?? '');
  const out = [];
  for (const st of intervalliSql(s, opts)) {
    const sql = s.slice(st.start, st.end).trim();
    if (sql) out.push({ sql, line: st.line });
  }
  return out;
}

function indexOrEnd(s, needle, from) {
  const idx = s.indexOf(needle, from);
  return idx < 0 ? s.length : idx;
}

/** Il testo contiene più di un'istruzione? (è quindi uno "script") */
export function isScript(code, opts) {
  return splitStatements(code, opts).length > 1 || (opts?.dbms === 'mysql' && /^\s*DELIMITER\s+/im.test(code));
}

/** Numero di istruzioni, per l'anteprima nella UI ("Esegui script (N)"). */
export function countStatements(code, opts) {
  return splitStatements(code, opts).length;
}
