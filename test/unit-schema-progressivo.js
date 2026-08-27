'use strict';

const assert = require('assert');
const { limitaSchema } = require('../db/schemaProgressivo');

console.log('--- Test budget schema progressivo ---');
const grande = {
  collections: Array.from({ length: 500 }, (_, i) => ({
    name: `tabella_${String(i).padStart(3, '0')}`,
    fields: Array.from({ length: 100 }, (_, j) => ({ name: `campo_${j}`, types: ['varchar'] })),
  })),
  relations: Array.from({ length: 499 }, (_, i) => ({ from: `tabella_${String(i + 1).padStart(3, '0')}`, to: `tabella_${String(i).padStart(3, '0')}`, field: 'parent_id' })),
};
const first = limitaSchema(grande, { collectionLimit: 50, fieldLimit: 10, relationLimit: 60 });
assert.strictEqual(first.collections.length, 50);
assert(first.collections.every((collection) => collection.fields.length <= 10));
assert(first.relations.length <= 60);
assert.strictEqual(first.schemaPage.totals.collections, 500);
assert.strictEqual(first.schemaPage.complete, false);
assert.strictEqual(first.schemaPage.nextCursor, 50);
assert(Buffer.byteLength(JSON.stringify(first)) < 200000, 'il primo payload deve restare entro il budget');
const next = limitaSchema(grande, { cursor: first.schemaPage.nextCursor, collectionLimit: 50, fieldLimit: 10 });
assert.strictEqual(next.collections[0].name, 'tabella_050', 'la continuazione non deve ripetere la prima pagina');

const piccolo = limitaSchema({ collections: [{ name: 'a', fields: [{ name: 'id' }] }], relations: [] });
assert.strictEqual(piccolo.schemaPage.complete, true);
assert.deepStrictEqual(piccolo.collections[0].fields, [{ name: 'id' }]);
console.log('  OK   payload iniziale limitato, metadati, continuazione e schema piccolo completo');
