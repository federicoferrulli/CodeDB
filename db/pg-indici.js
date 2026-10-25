'use strict';

const { quotaSempre } = require('./identificatori');

// Le DDL degli indici possono contenere espressioni e predicati con stringhe.
// Riqualificare lo schema o confrontare le definizioni non deve cambiarle.
// Questo lexer conserva i literal (anche E'...' e dollar-quoted) come unità
// opache; il percorso è limitato a CREATE INDEX, non ai corpi delle routine.
function tokensIndice(sql) {
  const text = String(sql);
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const start = i, c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('--', i)) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2; }
        else if (text.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    const dollar = c === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
    if (dollar) {
      const end = text.indexOf(dollar[0], i + dollar[0].length);
      i = end < 0 ? text.length : end + dollar[0].length;
      tokens.push({ kind: 'literal', raw: text.slice(start, i), start, end: i });
      continue;
    }
    const escaped = (c === 'E' || c === 'e') && text[i + 1] === "'";
    if (c === "'" || escaped || c === '"') {
      const quote = c === '"' ? '"' : "'";
      if (escaped) i++;
      i++;
      let value = '';
      while (i < text.length) {
        if (escaped && text[i] === '\\') { value += text.slice(i, i + 2); i += 2; continue; }
        if (text[i] === quote) {
          if (text[i + 1] === quote) { value += quote; i += 2; continue; }
          i++; break;
        }
        value += text[i++];
      }
      tokens.push({ kind: quote === '"' ? 'id' : 'literal', quoted: quote === '"', value,
        raw: text.slice(start, i), start, end: i });
      continue;
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      i++;
      while (i < text.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(text[i])) i++;
      const raw = text.slice(start, i);
      tokens.push({ kind: 'id', quoted: false, value: raw.toLowerCase(), raw, start, end: i });
      continue;
    }
    i++;
    tokens.push({ kind: 'symbol', raw: c, start, end: i });
  }
  return tokens;
}

function eIndice(tokens) {
  const word = (i, value) => tokens[i]?.kind === 'id' && !tokens[i].quoted && tokens[i].value === value;
  return !tokens.some(token => token.kind === 'symbol' && token.raw === '`')
    && word(0, 'create') && (word(1, 'index') || (word(1, 'unique') && word(2, 'index')));
}

function qualificatore(token, db) {
  return token?.kind === 'id' && token.value === String(db)
    && (token.quoted || String(db) === String(db).toLowerCase());
}

function riqualificaIndice(sql, sourceDb, targetDb) {
  const tokens = tokensIndice(sql);
  if (!eIndice(tokens)) return null;
  const text = String(sql);
  const quoted = quotaSempre(targetDb, 'postgresql');
  let out = '', from = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!qualificatore(tokens[i], sourceDb) || tokens[i + 1].raw !== '.') continue;
    out += text.slice(from, tokens[i].start) + quoted;
    from = tokens[i].end;
  }
  return out + text.slice(from);
}

function canonicaIndice(sql, db) {
  const tokens = tokensIndice(sql);
  if (!eIndice(tokens)) return null;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (db && qualificatore(tokens[i], db) && tokens[i + 1]?.raw === '.') { i++; continue; }
    if (tokens[i].raw === ';' && i === tokens.length - 1) continue;
    out.push(tokens[i].raw);
  }
  return out.join(' ');
}

module.exports = { riqualificaIndice, canonicaIndice };
