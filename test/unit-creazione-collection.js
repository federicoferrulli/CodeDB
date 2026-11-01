'use strict';

// LAB011: invoca il registratore e l'handler reali, senza leggere o riscrivere
// il sorgente. Il bersaglio del comando non è un'opzione per il driver.
const assert = require('node:assert/strict');
const { catalogoEventi } = require('./server-fixture');
const handler = catalogoEventi().find(item => item.evento === 'collection:create')?.handler;
assert.equal(typeof handler, 'function', 'Handler collection:create registrato');
const mutant = process.argv.includes('--mutant-metadata');
const cases = [
  ['mongodb', {}],
  ['mongodb', { validator: { $jsonSchema: { bsonType: 'object', required: ['quantita'], properties: { quantita: { bsonType: 'int', minimum: 0 } } } }, validationLevel: 'strict', validationAction: 'error' }],
  ['mongodb', { collation: { locale: 'it', strength: 1 } }],
  ['mongodb', { capped: true, size: 4096, max: 2 }],
  ['mysql', { columns: [{ name: 'id', type: 'INT', primaryKey: true }, { name: 'nome', type: 'VARCHAR(80)', nullable: true }] }],
  ['postgresql', { columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] }],
];
module.exports = (async () => {
  for (const [type, options] of cases) {
    const payload = { db: 'bersaglio', name: 'elementi', tabId: 'scheda-origine',
      runId: 'creazione-fixture', opHandle: { runId: 'creazione-fixture' },
      run: { contesto: 'solo-server' }, sessions: { contesto: 'solo-server' }, ...options };
    const original = JSON.stringify(payload); let calls = 0;
    const strategy = { type, async createCollection(db, name, passed) {
      calls++; assert.equal(db, payload.db); assert.equal(name, payload.name);
      if (mutant) passed = { ...passed, db: payload.db, name: payload.name, tabId: payload.tabId };
      assert.deepEqual(passed, options, '[COLLECTION-OPZIONI] inoltrare tutte le opzioni legittime senza metadati di trasporto');
    } };
    assert.deepEqual(await handler(strategy, payload, { dbType: type }), {});
    assert.equal(calls, 1); assert.equal(JSON.stringify(payload), original, 'Il payload del chiamante non deve cambiare');
    console.log(`  OK   Creazione collection: ${type}/${Object.keys(options).join(',') || 'semplice'}`);
  }
})();
if (require.main === module) module.exports.catch(error => { console.error(error.stack); process.exitCode = 1; });
