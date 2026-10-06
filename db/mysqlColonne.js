'use strict';

// DEFAULT_GENERATED indica un default valutato dal server: il valore resta
// scrivibile e va conservato nei backup, diversamente dalle colonne calcolate.
function colonnaGenerata(extra) {
  return /\b(?:VIRTUAL|STORED)\s+GENERATED\b/i.test(String(extra || ''));
}

// SHOW CREATE conserva gli escape SQL; COLUMN_DEFAULT li ri-escapa e non è
// direttamente eseguibile. Le parentesi dentro stringhe non chiudono il default.
function defaultDaCreate(ddl, quotedName) {
  const line = String(ddl).split('\n').find((s) => s.trimStart().startsWith(`${quotedName} `));
  if (!line) throw new Error('Definizione originale della colonna non trovata.');
  let quote = null, start = -1, depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) {
        if (line[i + 1] === quote) i++; else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (start < 0) {
      const m = /^DEFAULT\s+/i.exec(line.slice(i));
      if (m && (i === 0 || /\s/.test(line[i - 1]))) {
        start = i + m[0].length;
        if (line[start] !== '(') {
          const simple = /^(?:CURRENT_TIMESTAMP(?:\(\d*\))?|NOW\(\))/i.exec(line.slice(start));
          if (simple) return simple[0];
          throw new Error('Default generato non riconosciuto nella definizione originale.');
        }
        i = start - 1;
      }
    } else {
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return line.slice(start, i + 1);
    }
  }
  throw new Error('Default generato incompleto nella definizione originale.');
}

module.exports = { colonnaGenerata, defaultDaCreate };
