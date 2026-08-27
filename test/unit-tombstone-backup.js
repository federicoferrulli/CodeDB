'use strict';

const assert = require('assert');
const {
  dichiarazioneCancellazioni, semanticaCancellazioni,
  applicaRighe, applicaTombstone, calcolaTombstone,
} = require('../backup/lib/tombstones');

console.log('--- Test unitari tombstone dei backup ---');

const identity = { kind: 'primary-key', columns: ['tenant', 'id'] };
const precedente = applicaRighe(new Map(), [
  { tenant: 'a', id: 1 }, { tenant: 'a', id: 2 }, { tenant: 'b', id: 1 },
], identity);
const corrente = applicaRighe(new Map(), [
  { tenant: 'a', id: 2 }, { tenant: 'b', id: 1 }, { tenant: 'c', id: 9 },
], identity);
const rimossi = calcolaTombstone(precedente, corrente);
assert.deepStrictEqual(rimossi, [{ tenant: 'a', id: 1 }]);

const ricostruito = new Map(precedente);
applicaTombstone(ricostruito, rimossi, identity);
applicaRighe(ricostruito, [{ tenant: 'c', id: 9 }], identity);
assert.deepStrictEqual([...ricostruito.keys()].sort(), [...corrente.keys()].sort());

assert.strictEqual(semanticaCancellazioni({ version: 2 }).completa, false);
assert.strictEqual(semanticaCancellazioni({ version: 3, deletions: dichiarazioneCancellazioni() }).completa, true);

// Sensibilità: ignorando il tombstone resta una identità in più.
const senzaCancellazioni = new Map(precedente);
applicaRighe(senzaCancellazioni, [{ tenant: 'c', id: 9 }], identity);
assert.notDeepStrictEqual([...senzaCancellazioni.keys()].sort(), [...corrente.keys()].sort());

console.log('  OK   identità composite, ordine delete→upsert e storico incompleto');
