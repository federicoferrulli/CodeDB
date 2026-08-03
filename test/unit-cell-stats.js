'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari delle statistiche della selezione di celle
 * (public/js/cell-stats.js). Nessun database, nessun browser: il modulo è puro
 * (importa solo il modulo foglia `valori.js`) proprio per essere provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede:
 *   1. i valori EJSON — un DECIMAL di MySQL è `{$numberDecimal:"12.50"}`: senza
 *      conversione la somma di una colonna di importi risulterebbe vuota;
 *   2. cosa NON è un numero — date e booleani restano fuori: sommarli darebbe
 *      un totale plausibile e privo di senso;
 *   3. la virgola mobile — 0.1+0.2 non deve mostrare 0.30000000000000004;
 *   4. l'onestà sulla precisione — oltre 2^53 il totale è approssimato e va
 *      dichiarato, non spacciato per esatto.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Statistiche Selezione Celle ---');

(async () => {
  const {
    numeroCella, statistiche, statistichePerColonna, formattaNumero, riassuntoBreve,
  } = await import('../public/js/cell-stats.js');

  /* ------------------------------ numeroCella ---------------------------- */

  assert.strictEqual(numeroCella(42), 42);
  assert.strictEqual(numeroCella('12.50'), 12.5, 'stringa numerica (DECIMAL di mysql2)');
  assert.strictEqual(numeroCella('  7 '), 7, 'spazi ignorati');
  assert.strictEqual(numeroCella({ $numberDecimal: '12.50' }), 12.5);
  assert.strictEqual(numeroCella({ $numberInt: '3' }), 3);
  assert.strictEqual(numeroCella({ $numberLong: '900' }), 900);
  assert.strictEqual(numeroCella({ $numberDouble: '1.5' }), 1.5);
  assert.strictEqual(numeroCella(null), null);
  assert.strictEqual(numeroCella(''), null);
  assert.strictEqual(numeroCella('Rossi'), null);
  assert.strictEqual(numeroCella(true), null, 'un booleano non è una misura');
  assert.strictEqual(numeroCella({ $date: 1700000000000 }), null, 'una data non si somma');
  assert.strictEqual(numeroCella({ $oid: 'a'.repeat(24) }), null);
  assert.strictEqual(numeroCella([1, 2]), null);
  assert.strictEqual(numeroCella(NaN), null);
  assert.strictEqual(numeroCella(Infinity), null);
  console.log('  ✓ numeroCella: EJSON convertito, date/booleani/testo esclusi');

  /* ------------------------------ statistiche ---------------------------- */

  const st = statistiche([1, 2, 3, 4]);
  assert.strictEqual(st.celle, 4);
  assert.strictEqual(st.numerici, 4);
  assert.strictEqual(st.somma, 10);
  assert.strictEqual(st.media, 2.5);
  assert.strictEqual(st.mediana, 2.5, 'mediana pari = media dei due centrali');
  assert.strictEqual(st.min, 1);
  assert.strictEqual(st.max, 4);
  assert.ok(Math.abs(st.devStd - 1.2909944487) < 1e-9, 'dev. std campionaria (n-1)');
  assert.strictEqual(statistiche([5, 1, 3]).mediana, 3, 'mediana dispari, dati non ordinati');
  console.log('  ✓ somma/media/mediana/min/max/dev.std');

  // Selezione mista: solo i numeri entrano nei calcoli, il resto viene contato.
  const misto = statistiche([
    { $numberDecimal: '10.50' }, 'Rossi', null, '', { $date: 1700000000000 }, '4.50', true,
  ]);
  assert.strictEqual(misto.celle, 7);
  assert.strictEqual(misto.numerici, 2, 'decimal + stringa numerica');
  assert.strictEqual(misto.somma, 15);
  assert.strictEqual(misto.vuote, 2, 'null e stringa vuota');
  assert.strictEqual(misto.nonNumerici, 3, 'testo, data e booleano');
  console.log('  ✓ selezione mista: numeri sommati, il resto solo contato');

  // Nessun numero: i campi restano null invece di 0, che sarebbe una bugia.
  const testo = statistiche(['a', 'b', 'a']);
  assert.strictEqual(testo.numerici, 0);
  assert.strictEqual(testo.somma, null);
  assert.strictEqual(testo.media, null);
  assert.strictEqual(testo.distinti, 2, 'distinti anche senza numeri');
  assert.strictEqual(statistiche([]).celle, 0);
  assert.strictEqual(statistiche([7]).devStd, null, 'dev.std indefinita su un solo valore');
  console.log('  ✓ nessun numero: null, non zero');

  // Valori distinti: gli oggetti EJSON si confrontano per contenuto.
  const dist = statistiche([{ $oid: 'a'.repeat(24) }, { $oid: 'a'.repeat(24) }, { $oid: 'b'.repeat(24) }]);
  assert.strictEqual(dist.distinti, 2);
  assert.strictEqual(statistiche([1, '1']).distinti, 2, 'tipi diversi = valori distinti');
  console.log('  ✓ conteggio dei valori distinti');

  /* ---------------------- virgola mobile e precisione -------------------- */

  const importi = statistiche([{ $numberDecimal: '0.10' }, { $numberDecimal: '0.20' }]);
  assert.strictEqual(importi.somma, 0.3, '0.1+0.2 non deve mostrare 0.30000000000000004');
  assert.strictEqual(importi.decimali, 2);
  assert.strictEqual(importi.approssimato, false);

  const centesimi = statistiche(Array.from({ length: 1000 }, () => '0.01'));
  assert.strictEqual(centesimi.somma, 10, 'mille centesimi fanno esattamente 10');

  const grande = statistiche([{ $numberLong: '9007199254740993' }, 1]);
  assert.strictEqual(grande.approssimato, true, 'oltre 2^53 il totale è dichiarato approssimato');
  assert.strictEqual(statistiche([{ $numberDecimal: '1.123456789012345678' }]).approssimato, true,
    'oltre 15 cifre significative la precisione è persa');
  console.log('  ✓ somma compensata, arrotondata ai decimali dei dati, precisione dichiarata');

  /* --------------------------- per colonna e UI -------------------------- */

  const perCol = statistichePerColonna([
    { nome: 'importo', valori: ['10', '20'] },
    { nome: 'nome', valori: ['a', 'b'] },
  ]);
  assert.strictEqual(perCol.length, 2);
  assert.strictEqual(perCol[0].nome, 'importo');
  assert.strictEqual(perCol[0].somma, 30);
  assert.strictEqual(perCol[1].somma, null, 'colonna di testo: nessun totale inventato');
  console.log('  ✓ statistiche colonna per colonna');

  assert.strictEqual(formattaNumero(null), '—');
  assert.strictEqual(formattaNumero(NaN), '—');
  assert.ok(/e/i.test(formattaNumero(1e20)), 'numeri enormi in notazione esponenziale');
  assert.strictEqual(riassuntoBreve(statistiche([1])), '', 'con un solo numero non c\'è nulla da riassumere');
  assert.strictEqual(riassuntoBreve(statistiche(['a', 'b'])), '');
  const breve = riassuntoBreve(statistiche([1, 2, 3]));
  assert.ok(breve.includes('Σ') && breve.includes('x̄') && breve.includes('n 3'), breve);
  assert.ok(riassuntoBreve(statistiche([{ $numberLong: '9007199254740993' }, 2])).endsWith('≈'),
    'il riassunto segnala l\'approssimazione');
  console.log('  ✓ formattazione e riassunto della barra di stato');

  console.log('Statistiche selezione celle: OK');
})().catch((err) => {
  console.error('FALLITO:', err);
  process.exitCode = 1;
});
