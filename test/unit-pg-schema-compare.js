'use strict';
const assert = require('node:assert/strict');
const { canonicaIdentificatori: actual } = require('../db/pg-schema-compare');
const normalize = process.argv.includes('--mutant') ? value => value : actual;
assert.equal(normalize('"colore"'), normalize('colore'), '[PG-QUOTE] stesso identificatore');
assert.equal(normalize('"nome_1$"'), 'nome_1$');
for (const text of ['"Colore"', '"a b"', '"a""b"', "'\"colore\"'", "E'\\\'\"colore\"'", '$$"colore"$$',
  '$corpo$"colore"$corpo$', '-- "colore"', '/* "colore" /* "annidato" */ */']) {
  assert.equal(normalize(text), text, 'Testo letterale e nomi distinti intatti: ' + text);
}
assert.equal(normalize('/*x*/ "colore" --x\n "a"'), '/*x*/ colore --x\n a');
assert.notEqual(normalize('"Colore"'), normalize('colore'));
console.log('OK PostgreSQL: identificatori equivalenti, maiuscole, escape, commenti annidati e corpi dollar');
