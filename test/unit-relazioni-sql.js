'use strict';

const assert = require('assert');
const { raggruppaVincoli } = require('../db/relazioni');

const relazioni = raggruppaVincoli([
  { nome: 'fk_ab', ordine: 2, campo: 'b_locale', db: 's2', tabella: 'padre', colonna: 'b_remota' },
  { nome: 'fk_ab', ordine: 1, campo: 'a_locale', db: 's2', tabella: 'padre', colonna: 'a_remota' },
]);
assert.strictEqual(relazioni.length, 1);
assert.deepStrictEqual(relazioni[0].coppie, [
  { campo: 'a_locale', colonna: 'a_remota', ordine: 1 },
  { campo: 'b_locale', colonna: 'b_remota', ordine: 2 },
]);
console.log('  OK   metadata SQL: FK composita raggruppata e ordinata per vincolo');
