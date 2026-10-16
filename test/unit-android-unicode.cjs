'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { trasforma } = require('../android/unicode.cjs');
const source = String.raw`[
  /\P{ASCII}/u, /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u,
  /[\p{Cs}\p{Cn}]/u, /\p{Cs}/u,
  RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u")
]`;
const result = trasforma(source);
const compatibile = code => assert(!/\\[pP]\{/.test(code), 'Proprietà Unicode non compilata');
assert.throws(() => compatibile(source), /non compilata/);
compatibile(result);
const before = vm.runInNewContext(source), after = vm.runInNewContext(result);
for (const text of ['', 'ascii', '%25.example', 'città', '東京', '𝒳', '💾', '\ud800', '\udc00', '\u0378', 'a\u200d', '123', '$nome']) {
  before.forEach((re, i) => assert.equal(after[i].test(text), re.test(text), `Semantica diversa per ${JSON.stringify(text)}`));
}
assert.equal(trasforma(result), result);
assert.equal(trasforma('const x = /[a-z]/u; // commento'), 'const x = /[a-z]/u; // commento');
assert.throws(() => trasforma(String.raw`const x = "\\p{L}";`), /dinamico non riconosciuto/);
const template = 'const x = `^(\\\\p{Extended_Pictographic}|\\\\p{Emoji_Component})+$`;';
compatibile(trasforma(template));
console.log('OK Unicode Android: regex e pattern dinamici, semantica ASCII/Unicode/emoji e fixture incompatibili rifiutate.');
