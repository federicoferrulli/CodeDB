'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { trasforma, preparaUnicode } = require('../android/unicode.cjs');
const identSql = '(?:"(?:[^" ]|""| )+"|`(?:[^`]|``)+`|[\\p{L}_][\\p{L}\\p{N}_$]*)';
const source = String.raw`[
  /\P{ASCII}/u, /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u,
  /[\p{Cs}\p{Cn}]/u, /\p{Cs}/u,
  RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u"),
  RegExp("^[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$", "u"),
  RegExp("^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$", "u"),
` + `  RegExp(${JSON.stringify(identSql)}, "iu")\n]`;
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

// Anche i sorgenti applicativi, non soltanto node_modules, devono essere compilati.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-unicode-'));
try {
  const fileApp = [
    'db/backupRestoreAdapter.js',
    'db/importSql.js',
    'public/js/intellisense.js',
    'public/js/query-lexer.js',
  ];
  for (const file of fileApp) {
    const originale = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.throws(() => compatibile(originale), /non compilata/, `${file} contiene proprietà Unicode da compilare`);
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, originale);
  }
  assert.equal(preparaUnicode(temp), fileApp.length);
  for (const file of fileApp) {
    compatibile(fs.readFileSync(path.join(temp, file), 'utf8'));
  }
  assert.equal(preparaUnicode(temp), 0);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

console.log('OK Unicode Android: regex e pattern dinamici, semantica ASCII/Unicode/emoji e fixture incompatibili rifiutate.');
