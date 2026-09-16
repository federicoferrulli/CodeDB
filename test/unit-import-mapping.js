'use strict';

// Il mapping dei nomi si prova senza browser: è logica pura e il wizard la
// riusa così com'è. Ciò che si prova è ciò che, taciuto, sovrascrive la
// tabella sbagliata: collisioni fra sorgenti, maiuscole piegate da PostgreSQL,
// nomi che esistono già.

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { mappaNomi } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'import-mapping.js')).href
  );

  /* --- Senza conflitti ------------------------------------------------------------------ */

  {
    const { mapping, avvisi } = mappaNomi({ sorgenti: ['ordini', 'clienti'], esistenti: [], motore: 'postgresql' });
    assert.deepStrictEqual(mapping, [{ da: 'ordini', a: 'ordini' }, { da: 'clienti', a: 'clienti' }]);
    assert.deepStrictEqual(avvisi, [], 'niente conflitti, niente avvisi');
    const rinominato = mappaNomi({ sorgenti: ['ordini'], esistenti: [], motore: 'mysql', rinomina: { ordini: 'ordini_2026' } });
    assert.deepStrictEqual(rinominato.mapping, [{ da: 'ordini', a: 'ordini_2026' }]);
    assert.deepStrictEqual(rinominato.avvisi, []);
    console.log('  OK   mapping diretto e rinomina senza avvisi');
  }

  /* --- Collisioni ------------------------------------------------------------------------------ */

  {
    const { avvisi } = mappaNomi({
      sorgenti: ['a', 'b'], esistenti: [], motore: 'mysql', rinomina: { a: 'x', b: 'x' },
    });
    assert.strictEqual(avvisi.length, 1);
    assert.strictEqual(avvisi[0].tipo, 'collisione-sorgenti');
    assert.deepStrictEqual([avvisi[0].da, avvisi[0].altro].sort(), ['a', 'b']);
    // Stessa rinomina due volte per lo STESSO oggetto non è una collisione.
    const doppio = mappaNomi({ sorgenti: ['a'], esistenti: [], motore: 'mysql' });
    assert.deepStrictEqual(doppio.avvisi, []);
    console.log('  OK   due sorgenti sullo stesso nome: avviso, non silenzio');
  }

  /* --- Maiuscole e esistenti ---------------------------------------------------------------------- */

  {
    // PostgreSQL abbassa i nomi non quotati: `Prova` esistente e `prova`
    // importata sono la stessa tabella.
    const { avvisi } = mappaNomi({ sorgenti: ['prova'], esistenti: ['Prova'], motore: 'postgresql' });
    assert.strictEqual(avvisi.length, 1);
    assert.strictEqual(avvisi[0].tipo, 'fold-maiuscole');
    assert.strictEqual(avvisi[0].esistente, 'Prova');
    // Su MySQL la forma si conserva: niente fold, ma l'esistenza si vede.
    const my = mappaNomi({ sorgenti: ['Prova'], esistenti: ['Prova'], motore: 'mysql' });
    assert.strictEqual(my.avvisi.length, 1);
    assert.strictEqual(my.avvisi[0].tipo, 'esiste-gia');
    const myOk = mappaNomi({ sorgenti: ['prova'], esistenti: ['Prova'], motore: 'mysql' });
    assert.deepStrictEqual(myOk.avvisi, [], 'maiuscole diverse su MySQL sono tabelle diverse');
    console.log('  OK   fold PostgreSQL dichiarato, esistenti visti');
  }

  /* --- Rifiuti ------------------------------------------------------------------------------------------- */

  {
    assert.throws(() => mappaNomi({ sorgenti: ['  '], motore: 'mysql' }), /vuoto/);
    assert.throws(() => mappaNomi({ sorgenti: ['a'], rinomina: { a: '  ' }, motore: 'mysql' }), /vuota/);
    console.log('  OK   nomi vuoti rifiutati');
  }

  console.log('  OK   Mapping nomi per l import passed');
})().catch((err) => {
  console.error('  FAIL Mapping nomi:', err.stack || err);
  process.exitCode = 1;
});
