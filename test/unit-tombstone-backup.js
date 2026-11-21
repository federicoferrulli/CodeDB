'use strict';

const assert = require('assert');
const {
  dichiarazioneCancellazioni, semanticaCancellazioni, equivalenzaCatena,
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

const layer = (type, nomi, entityInventory) => ({ manifest: { version: entityInventory ? 6 : 5, type,
  files: nomi.map(collection => ({ kind: 'data', collection, mode: 'full' })), entityInventory } });
const full = layer('full', ['a', 'b']);
assert.equal(equivalenzaCatena([full, layer('incremental', ['a'])]).completa, false);
const inv = { scope: 'all', selection: null, removed: ['b'] };
assert.equal(equivalenzaCatena([full, layer('incremental', ['a'], inv)]).completa, true);
const { validaCopertura } = require('../backup/lib/inventario-entita');
assert.throws(() => validaCopertura(layer('incremental', ['a'], { ...inv, removed: ['estranea'] }).manifest,
  new Set(['a', 'b'])), /incoerenti/);

// Sensibilità: ignorando il tombstone resta una identità in più.
const senzaCancellazioni = new Map(precedente);
applicaRighe(senzaCancellazioni, [{ tenant: 'c', id: 9 }], identity);
assert.notDeepStrictEqual([...senzaCancellazioni.keys()].sort(), [...corrente.keys()].sort());

console.log('  OK   identità composite, ordine delete→upsert e storico incompleto');
