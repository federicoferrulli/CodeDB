'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@babel/parser');
const riscrivi = require('regexpu-core');
const proprieta = /\\[pP]\{/;
const emoji = '^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$';

// Il libnode mobile 18 non include ICU. Espandiamo le proprietà in intervalli
// solo nella copia destinata all'APK, conservando nomi Unicode e validazione URI.
function trasforma(source) {
  if (!proprieta.test(source)) return source;
  const ast = parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
  const edits = [];
  const pattern = (value, flags) => riscrivi(value, flags, { unicodePropertyEscapes: 'transform' });
  function visita(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'RegExpLiteral' && proprieta.test(node.pattern)) {
      edits.push({ start: node.start, end: node.end, text: `/${pattern(node.pattern, node.flags)}/${node.flags}` });
      return;
    }
    const value = node.type === 'StringLiteral' ? node.value
      : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
    if (typeof value === 'string' && proprieta.test(value)) {
      // Le sole stringhe-pattern presenti nel lockfile sono gli emoji di Zod.
      // Un nuovo caso richiede verificarne i flag e l'uso, senza riscrivere testo arbitrario.
      if (value !== emoji) throw new Error('Pattern Unicode dinamico non riconosciuto: aggiornare la preparazione Android.');
      edits.push({ start: node.start, end: node.end, text: JSON.stringify(pattern(value, 'u')) });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visita);
      else if (child && typeof child === 'object') visita(child);
    }
  }
  visita(ast);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

function preparaUnicode(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) count += preparaUnicode(file);
    else if (entry.isFile() && /\.(c?js|mjs)$/.test(entry.name)) {
      const source = fs.readFileSync(file, 'utf8'), result = trasforma(source);
      if (result !== source) { fs.writeFileSync(file, result); count++; }
    }
  }
  return count;
}
module.exports = { trasforma, preparaUnicode };
