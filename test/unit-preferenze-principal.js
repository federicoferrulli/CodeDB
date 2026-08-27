'use strict';

const assert = require('assert');
const { AppStore } = require('../auth/AppStore');
const { validaPreferenza } = require('../auth/preferenze');

module.exports = (async () => {
  console.log('--- Test preferenze personali e condivise ---');
  const docs = new Map();
  const keyOf = (filter) => JSON.stringify(filter);
  const collection = {
    async findOne(filter) { return docs.get(keyOf(filter)) || null; },
    async updateOne(filter, update) { docs.set(keyOf(filter), { ...filter, ...update.$set }); },
  };
  const store = new AppStore();
  store.col = () => collection;

  const a = validaPreferenza({ ambito: 'personale', chiave: 'scorciatoie', valore: { chiudi: 'Ctrl+W' } });
  await store.setPrefs('tenant', 'alice', a.ambito, a.chiave, a.valore);
  await store.setPrefs('tenant', 'bob', 'personale', 'scorciatoie', { chiudi: 'Alt+W' });
  assert.deepStrictEqual(await store.getPrefs('tenant', 'alice', 'personale', 'scorciatoie'), { chiudi: 'Ctrl+W' });
  assert.deepStrictEqual(await store.getPrefs('tenant', 'bob', 'personale', 'scorciatoie'), { chiudi: 'Alt+W' });

  await store.setPrefs('tenant', 'alice', 'condiviso', 'scorciatoie', { chiudi: 'Ctrl+Q' });
  assert.deepStrictEqual(await store.getPrefs('tenant', 'bob', 'condiviso', 'scorciatoie'), { chiudi: 'Ctrl+Q' },
    'il valore condiviso ignora il subject ma resta confinato al tenant');
  assert.strictEqual(await store.getPrefs('altro', 'alice', 'condiviso', 'scorciatoie'), null);

  assert.throws(() => validaPreferenza({ ambito: 'personale', chiave: '__proto__', valore: {} }), /non supportata/);
  assert.throws(() => validaPreferenza({ ambito: 'personale', chiave: 'scorciatoie', valore: { x: 'a'.repeat(81) } }), /non valido/);
  assert.throws(() => validaPreferenza({ ambito: 'tenant', chiave: 'scorciatoie', valore: {} }), /Ambito/);
  console.log('  OK   isolamento per principal, condivisione esplicita e validazione server-side');
})();
