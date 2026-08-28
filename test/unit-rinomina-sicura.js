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

  // collectionExport calcola il totale SOLO alla prima pagina (vedi
  // test/unit-export-conteggio.js): improntaDatabase deve conservarlo invece
  // di aspettarselo su ogni pagina. Con un conteggio multiplo esatto della
  // dimensione di pagina (1000), NON conservarlo lascia `skip >= total`
  // sempre falso dopo la prima pagina (Number(undefined) è NaN) e strappa un
  // blocco vuoto in più prima che il ciclo se ne accorga da `count === 0`.
  {
    const PAGINA = 1000;
    const righe = Array.from({ length: PAGINA * 2 }, (_, i) => ({ id: i }));
    let chiamate = 0;
    const strategyPaginata = {
      async listCollections() { return [{ name: 't' }]; },
      async collectionExport(_db, _coll, payload) {
        chiamate += 1;
        const skip = payload.skip || 0;
        const pagina = righe.slice(skip, skip + payload.limit);
        const risposta = { lines: pagina.map((r) => JSON.stringify(r)), count: pagina.length };
        const primaPagina = !payload.after && !(Number(payload.skip) > 0);
        if (primaPagina) risposta.total = righe.length;
        return risposta;
      },
    };
    await improntaDatabase(strategyPaginata, 'qualsiasi');
    assert.strictEqual(chiamate, 2,
      `2000 righe su pagine da 1000 devono fermarsi in 2 chiamate (ottenute: ${chiamate}): `
      + 'un totale multiplo esatto della pagina non deve costare un blocco vuoto in più');
    console.log('  OK   improntaDatabase riusa il totale della prima pagina (nessun blocco vuoto superfluo)');
  }
})();
