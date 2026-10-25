'use strict';

// Solo confronto, mai esecuzione: PostgreSQL può quotare un tipo locale in
// una sessione e stamparlo nudo in un'altra. Stringhe e corpi restano letterali.
function canonicaIdentificatori(sql) {
  const text = String(sql);
  let out = '', i = 0;
  while (i < text.length) {
    const start = i;
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2; }
        else if (text.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
    } else if (text[i] === "'") {
      const escape = /(?:^|[^\w$])[Ee]$/.test(text.slice(0, i)); i++;
      while (i < text.length) {
        if (escape && text[i] === '\\') { i += 2; continue; }
        if (text[i++] === "'") { if (text[i] === "'") i++; else break; }
      }
    } else if (text[i] === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))[0];
      const end = text.indexOf(tag, i + tag.length); i = end < 0 ? text.length : end + tag.length;
    } else if (text[i] === '"') {
      i++;
      while (i < text.length) if (text[i++] === '"') { if (text[i] === '"') i++; else break; }
      const token = text.slice(start, i);
      out += /^"[a-z_][a-z0-9_$]*"$/.test(token) ? token.slice(1, -1) : token;
      continue;
    } else i++;
    out += text.slice(start, i);
  }
  return out;
}

module.exports = { canonicaIdentificatori };
