'use strict';

// Confronta DDL già canoniche. Divide solo le virgole del corpo CREATE TABLE:
// espressioni, stringhe, identificatori e corpi dollar restano indivisibili.
function partiTabella(sql) {
  let depth = 0, begin = -1, part = -1;
  const parts = [];
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      const escape = c === '`' || (c === "'" && /(?:^|[^\w$])[Ee]$/.test(sql.slice(0, i)));
      let closed = false;
      while (++i < sql.length) {
        if (escape && sql[i] === '\\') { i++; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) i++; else { closed = true; break; } }
      }
      if (!closed) return null;
    } else if (c === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) return null;
      i = end + tag.length - 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end;
    } else if (sql.startsWith('/*', i)) {
      let nesting = 1; i += 2;
      for (; i < sql.length && nesting; i++) {
        if (sql.startsWith('/*', i)) { nesting++; i++; }
        else if (sql.startsWith('*/', i)) { nesting--; i++; }
      }
      if (nesting) return null;
      i--;
    } else if (c === '(') {
      if (depth++ === 0) { begin = i; part = i + 1; }
    } else if (c === ',' && depth === 1) {
      parts.push(sql.slice(part, i).trim()); part = i + 1;
    } else if (c === ')') {
      if (--depth === 0) {
        parts.push(sql.slice(part, i).trim());
        return { head: sql.slice(0, begin), tail: sql.slice(i + 1), parts };
      }
      if (depth < 0) return null;
    }
  }
  return null;
}

function nomeColonna(part) {
  const match = /^("(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_][A-Za-z0-9_$]*)\s/.exec(part);
  if (!match || /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|KEY|INDEX|CHECK|FULLTEXT|SPATIAL)$/i.test(match[1])) return null;
  return match[1];
}

function schemaMergeConColonneLocali(incoming, baseline) {
  if (!baseline || incoming === baseline) return incoming;
  const source = partiTabella(incoming), target = partiTabella(baseline);
  if (!source || !target || source.head !== target.head || source.tail !== target.tail) return incoming;
  const columns = new Set(source.parts.map(nomeColonna).filter(Boolean));
  const retained = target.parts.filter(part => !nomeColonna(part) || columns.has(nomeColonna(part)));
  // Accettiamo solo colonne aggiuntive. Ogni definizione comune e ogni vincolo
  // devono ancora coincidere: non si impara lo schema atteso dallo staging.
  if (JSON.stringify(retained) !== JSON.stringify(source.parts)) return incoming;
  return baseline;
}

module.exports = { schemaMergeConColonneLocali };
module.exports.partiTabella = partiTabella;
