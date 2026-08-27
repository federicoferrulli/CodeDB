'use strict';

const assert = require('assert');
const { pianoRinomina, improntaDatabase, confrontaStatoCorrente } = require('../db/rinominaSicura');

module.exports = (async () => {
  console.log('--- Test unitari rinomina sicura ---');
  assert.strictEqual(pianoRinomina('postgresql', true).eliminaOrigine, true);
  assert.strictEqual(pianoRinomina('mysql', false).eliminaOrigine, false);
  assert.match(pianoRinomina('mongodb', false).descrizione, /conserva l’origine/i);

  const dati = {
    origine: [{ id: 1, nome: 'A' }],
    copia: [{ id: 1, nome: 'A' }],
  };
  const strategy = {
    async listCollections() { return [{ name: 't' }]; },
    async collectionExport(db) {
      const rows = dati[db];
      return { lines: rows.map(JSON.stringify), count: rows.length, total: rows.length };
    },
  };
  const copiaIniziale = await improntaDatabase(strategy, 'copia');
  dati.origine.push({ id: 2, nome: 'scrittura concorrente' });
  const origineCorrente = await improntaDatabase(strategy, 'origine');
  assert.strictEqual(confrontaStatoCorrente(origineCorrente, copiaIniziale).ok, false,
    'la verifica corrente intercetta la scrittura fra copia e promozione');

  // Sensibilità: confrontare la copia con sé stessa (la vecchia verifica del
  // solo artefatto iniziale) darebbe un falso positivo.
  assert.strictEqual(confrontaStatoCorrente(copiaIniziale, copiaIniziale).ok, true);
  console.log('  OK   piano per motore e barriera sullo stato corrente');
})();
