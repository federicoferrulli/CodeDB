import { tokenizzaQuery } from './query-lexer.js';

// Gli offset viaggiano in UTF-16, come selectionStart dell'editor, con fine esclusiva.
export function intervalloErroreQuery(err, code, dbms) {
  const source = String(code || '');
  if (!err || !source) return null;
  if (err.queryError) return err.queryError;
  const tokens = tokenizzaQuery(source, { dbms });
  const at = offset => {
    if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return null;
    if (offset === source.length) return { start: offset, end: offset };
    const token = tokens.find(t => t.inizio <= offset && t.fine > offset);
    return token ? { start: token.inizio, end: token.fine } : null;
  };
  if (dbms === 'postgresql' && /^\d+$/.test(String(err.position || ''))) {
    // PostgreSQL conta caratteri Unicode da 1; il DOM conta unità UTF-16 da 0.
    let remaining = Number(err.position) - 1, offset = 0;
    if (!Number.isSafeInteger(remaining) || remaining < 0) return null;
    for (const ch of source) { if (!remaining) break; offset += ch.length; remaining--; }
    return remaining ? null : at(offset);
  }
  const message = String(err.sqlMessage || err.message || '');
  if (dbms === 'postgresql') {
    const name = /\b(?:relation|column|schema) "((?:""|[^"])*)" does not exist/i.exec(message)?.[1]?.replace(/""/g, '"');
    if (name) {
      const identificatore = t => t.tipo === 'identificatore'
        ? t.testo.slice(1, -1).replace(/""/g, '"') : t.testo.toLowerCase();
      const identifiers = tokens.filter(t => ['parola', 'identificatore'].includes(t.tipo));
      const exact = identifiers.filter(t => identificatore(t) === name);
      const matches = exact.length ? exact : identifiers.filter(t => identificatore(t) === name.split('.').at(-1));
      return matches.length === 1 ? { start: matches[0].inizio, end: matches[0].fine } : null;
    }
  }
  if (dbms === 'mysql') {
    const syntax = /\bnear '([\s\S]*)' at line (\d+)\s*$/.exec(message);
    if (syntax && (['ER_PARSE_ERROR', 1064].includes(err.code || err.errno) || /error in your SQL syntax/i.test(message))) {
      if (!syntax[1]) return at(source.length);
      const line = Number(syntax[2]);
      const matches = [];
      for (let i = source.indexOf(syntax[1]); i >= 0; i = source.indexOf(syntax[1], i + 1)) {
        if (source.slice(0, i).split('\n').length === line) matches.push(i);
      }
      return matches.length === 1 ? at(matches[0]) : null;
    }
    const name = /\b(?:Table|Unknown column) '([^']+)'/.exec(message)?.[1];
    if (name && (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 1146, 1054].includes(err.code || err.errno)
      || /\b(?:Table '[^']+' doesn't exist|Unknown column '[^']+' in )/.test(message))) {
      const last = name.split('.').at(-1);
      const matches = tokens.filter(t => ['parola', 'identificatore'].includes(t.tipo)
        && t.testo.replace(/^`|`$/g, '').replace(/``/g, '`') === last);
      return matches.length === 1 ? { start: matches[0].inizio, end: matches[0].fine } : null;
    }
  }
  if (dbms === 'mongodb') {
    // I parser citano il token effettivamente trovato; ripetizioni e messaggi
    // privi di token non sono sufficienti per scegliere un punto nell'editor.
    const invalid = /(?:, trovato|Token inatteso a fine (?:query|comando):|Carattere non riconosciuto nella query SQL:)\s*"([^"]+)"/.exec(message)?.[1]
      || /\bunknown (?:top level )?operator:\s*(\$[\w]+)/i.exec(message)?.[1];
    if (invalid) {
      const matches = tokens.filter(t => !['commento', 'hint', 'spazio', 'stringa'].includes(t.tipo) && t.testo === invalid);
      return matches.length === 1 ? { start: matches[0].inizio, end: matches[0].fine } : null;
    }
  }
  return null;
}

export function annotaErroreQuery(err, code, dbms) {
  const range = intervalloErroreQuery(err, code, dbms);
  if (range) err.queryError = range;
  return err;
}
