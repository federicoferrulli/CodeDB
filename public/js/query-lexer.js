/** Lessico dell'editor: conserva il testo e gli intervalli, anche mentre è incompleto. */
export function linguaQuery(testo, ripiego = 'sql') {
  const s = String(testo).replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\/[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
  if (/^(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|CREATE|ALTER|DROP|TRUNCATE|SHOW|DESCRIBE|DESC|EXPLAIN|USE|GRANT|REVOKE|SET|RESET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE|ANALYSE|DO|CALL|COPY|MERGE|VALUES|TABLE|PREPARE|EXECUTE|DEALLOCATE|DISCARD|COMMENT|REFRESH|REINDEX|CLUSTER|LOCK|UNLOCK|RENAME|FLUSH|KILL)\b/i.test(s)) return 'sql';
  if (/^(?:[[{]|db\s*[.[]|(?:var|let|const|function|async|await|for|while|if|try|print|printjson)\b)/.test(s)) return 'mongo';
  return ripiego;
}

export function tokenizzaQuery(testo, { dbms = '', lingua = linguaQuery(testo) } = {}) {
  const s = String(testo);
  const out = [];
  const mongo = lingua === 'mongo';
  const pg = /^(postgresql|postgres|pg)$/.test(dbms);
  let i = 0;
  const aggiungi = (tipo, inizio, chiuso = true) => out.push({ tipo, testo: s.slice(inizio, i), inizio, fine: i, chiuso });
  while (i < s.length) {
    const inizio = i, c = s[i], next = s[i + 1];
    if (/\s/.test(c)) {
      while (i < s.length && /\s/.test(s[i])) i++;
      aggiungi('spazio', inizio); continue;
    }
    if ((!mongo && c === '-' && next === '-' && (dbms !== 'mysql' || !s[i + 2] || /\s/.test(s[i + 2])))
      || (mongo && c === '/' && next === '/') || (!mongo && !pg && c === '#' && !['>', '-'].includes(next))) {
      i = s.indexOf('\n', i);
      if (i < 0) i = s.length;
      aggiungi('commento', inizio, i < s.length); continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      let profondita = 1;
      while (i < s.length && profondita) {
        if (pg && s.slice(i, i + 2) === '/*') { profondita++; i += 2; }
        else if (s.slice(i, i + 2) === '*/') { profondita--; i += 2; }
        else i++;
      }
      aggiungi(!mongo && /[!+]/.test(s[inizio + 2] || '') ? 'hint' : 'commento', inizio, !profondita); continue;
    }
    if (!mongo && c === '$') {
      const tag = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(s.slice(i));
      if (tag) {
        const fine = s.indexOf(tag[0], i + tag[0].length);
        i = fine < 0 ? s.length : fine + tag[0].length;
        aggiungi('stringa', inizio, fine >= 0); continue;
      }
      const parametro = /^\$\d+/.exec(s.slice(i));
      if (parametro) { i += parametro[0].length; aggiungi('parametro', inizio); continue; }
    }
    // E'…', B'…', X'…', N'…' e U&'…' devono restare attaccati al prefisso.
    const prefisso = !mongo && /^(?:[eEbBxXnN]|[uU]&)(?=['"])/.exec(s.slice(i));
    if (prefisso) i += prefisso[0].length;
    const apice = s[i];
    if (apice === "'" || apice === '"' || apice === '`') {
      i++;
      let chiuso = false;
      const escape = mongo || !pg || (prefisso && /^[eE]$/.test(prefisso[0]));
      while (i < s.length) {
        if (escape && s[i] === '\\') { i = Math.min(i + 2, s.length); continue; }
        if (s[i] === apice) {
          i++;
          if (!mongo && s[i] === apice) { i++; continue; }
          chiuso = true; break;
        }
        i++;
      }
      aggiungi(apice === '`' && !mongo || apice === '"' && pg ? 'identificatore' : 'stringa', inizio, chiuso); continue;
    }
    const numero = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
    if (numero) { i += numero[0].length; aggiungi('numero', inizio); continue; }
    // PostgreSQL ammette anche operatori definiti dall'utente: la grafia è
    // indivisibile, non un elenco chiuso da aggiornare per ogni estensione.
    let operatore = pg ? /^(?:::|:=|[-+*\/<>=~!@#%^&|`?]+)/.exec(s.slice(i))
      : /^(?:-\|-|&<|&>|->>|#>>|<=>|<->|<#>|<<|>>|->|#>|#-|::|:=|>=|<=|<>|!=|\|\||&&|@>|<@|@\?|@@|\?\||\?&|!~\*|!~|~\*|=>|==|\*\*)/.exec(s.slice(i));
    if (pg && operatore) {
      // Un commento termina l'operatore; + e - finali richiedono almeno un
      // carattere non SQL standard (regole lessicali di PostgreSQL).
      operatore[0] = operatore[0].split(/--|\/\*/)[0];
      if (!/[~!@#%^&|`?]/.test(operatore[0])) operatore[0] = operatore[0].replace(/(.+?)[+-]+$/, '$1');
      if (!operatore[0]) operatore = null;
    }
    if (operatore) { i += operatore[0].length; aggiungi('operatore', inizio); continue; }
    const parola = /^[\p{L}_@$][\p{L}\p{N}_@$]*/u.exec(s.slice(i));
    if (parola) { i += parola[0].length; aggiungi('parola', inizio); continue; }
    i++;
    aggiungi('(),;[]{}'.includes(c) ? 'punteggiatura' : 'operatore', inizio);
  }
  return out;
}

/** L'istruzione che contiene il cursore, compresa la parte scritta alla sua destra. */
export function intervalloIstruzione(testo, cursore, opts = {}) {
  let inizio = 0, fine = testo.length;
  for (const t of tokenizzaQuery(testo, opts)) {
    if (t.tipo !== 'punteggiatura' || t.testo !== ';') continue;
    if (t.inizio < cursore) inizio = t.fine;
    else { fine = t.inizio; break; }
  }
  return { inizio, fine, testo: testo.slice(inizio, fine) };
}

/** Nasconde i valori e i commenti lasciando intatti gli indici del testo. */
export function mascheraQuery(testo, opts = {}) {
  return tokenizzaQuery(testo, opts).map(t => ['stringa', 'commento', 'hint'].includes(t.tipo)
    ? t.testo.replace(/[^\r\n]/g, ' ') : t.testo).join('');
}
