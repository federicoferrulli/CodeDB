'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari di public/js/table-cols.js — larghezze e ordinamento delle
 * colonne nella tabella dei risultati di ⚡ Query & Aggregate. Nessun browser:
 * il modulo è puro e riceve il misuratore di testo dall'esterno proprio per
 * essere provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede:
 *   1. i valori EJSON — un DECIMAL di MySQL è la stringa "12.50" e un
 *      $numberLong è un oggetto: ordinati per testo darebbero un ordine
 *      plausibile e sbagliato ("100" prima di "9");
 *   2. l'ordine totale su colonne di tipi misti (MongoDB non ha schema): senza,
 *      il risultato dipenderebbe dall'algoritmo di sort;
 *   3. i vuoti restano in fondo in ENTRAMBE le direzioni;
 *   4. l'array di partenza non viene toccato — è `currentResults`, che serve
 *      anche ai grafici e all'export;
 *   5. le larghezze rispettano minimo e tetto: senza tetto una cella con dentro
 *      un documento intero renderebbe la tabella larga diecimila pixel.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Colonne della Tabella Risultati ---');

(async () => {
  const {
    chiaveOrdinamento, confrontaChiavi, ordinaRighe, larghezzeColonne,
    LARGH_MIN, LARGH_MAX, isVuoto,
  } = await import('../public/js/table-cols.js');

  const cmp = (a, b) => confrontaChiavi(chiaveOrdinamento(a), chiaveOrdinamento(b));

  /* ------------------------------ chiavi --------------------------------- */

  assert.ok(cmp(2, 10) < 0, 'numeri confrontati come numeri');
  assert.ok(cmp('9', '100') < 0, 'stringhe numeriche (DECIMAL di mysql2) come numeri');
  assert.ok(cmp({ $numberDecimal: '12.50' }, { $numberDecimal: '9.99' }) > 0);
  assert.ok(cmp({ $numberLong: '900' }, { $numberInt: '1000' }) < 0);
  assert.ok(cmp({ $date: 1000 }, { $date: 2000 }) < 0);
  assert.ok(cmp({ $date: { $numberLong: '1000' } }, { $date: 2000 }) < 0, '$date in forma canonica');
  assert.ok(cmp(false, true) < 0);
  assert.ok(cmp('Anna', 'bruno') < 0, 'confronto testuale insensibile al maiuscolo');
  assert.ok(cmp('item2', 'item10') < 0, 'ordinamento naturale dei numeri dentro il testo');
  assert.ok(
    cmp({ $oid: '5f00000000000000000000aa' }, { $oid: '6f00000000000000000000aa' }) < 0,
    'ObjectId: ordine esadecimale = ordine di creazione'
  );

  // Ordine totale su tipi misti: numeri prima delle date, delle stringhe, ecc.
  assert.ok(cmp(5, { $date: 0 }) < 0);
  assert.ok(cmp({ $date: 0 }, 'testo') < 0);
  assert.ok(cmp('testo', { a: 1 }) < 0);
  assert.strictEqual(cmp(3, 3), 0);
  console.log('  ✓ chiaveOrdinamento: EJSON, stringhe numeriche, ordine totale sui tipi misti');

  assert.ok(isVuoto(null) && isVuoto(undefined));
  assert.ok(!isVuoto('') && !isVuoto(0) && !isVuoto(false), '0, false e "" sono valori, non vuoti');

  /* ----------------------------- ordinaRighe ----------------------------- */

  const righe = [
    { n: '10', t: 'b' },
    { n: '9', t: 'a' },
    { n: null, t: 'c' },
    { n: '100', t: 'd' },
  ];
  const copia = JSON.parse(JSON.stringify(righe));

  const asc = ordinaRighe(righe, 'n', 1);
  assert.deepStrictEqual(asc.map((r) => r.n), ['9', '10', '100', null]);

  const desc = ordinaRighe(righe, 'n', -1);
  assert.deepStrictEqual(desc.map((r) => r.n), ['100', '10', '9', null], 'i vuoti restano in fondo anche al contrario');

  assert.deepStrictEqual(righe, copia, "l'array di partenza non viene modificato");
  assert.notStrictEqual(asc, righe);

  // Stabilità: a parità di chiave l'ordine di partenza va conservato.
  const pari = [{ k: 1, id: 'a' }, { k: 1, id: 'b' }, { k: 1, id: 'c' }];
  assert.deepStrictEqual(ordinaRighe(pari, 'k', 1).map((r) => r.id), ['a', 'b', 'c']);

  // Colonna assente in alcune righe (MongoDB): trattata come vuota, non come errore.
  const sparse = [{ x: 2 }, { y: 1 }, { x: 1 }];
  assert.deepStrictEqual(ordinaRighe(sparse, 'x', 1).map((r) => r.x), [1, 2, undefined]);
  console.log('  ✓ ordinaRighe: vuoti in fondo, stabile, sorgente intatta');

  /* --------------------------- larghezzeColonne -------------------------- */

  // Misuratore finto e deterministico: 10px per carattere.
  const misura = (t) => String(t ?? '').length * 10;
  const testo = (v) => (v === null || v === undefined ? '' : String(v));

  const dati = [
    { b: 'a', L: 'x'.repeat(200) },
    { b: 'bb', L: 'y' },
  ];
  const w = larghezzeColonne(dati, ['b', 'L'], { misura, testo });

  assert.strictEqual(w.get('b'), LARGH_MIN, 'colonna cortissima: si ferma al minimo leggibile');
  assert.strictEqual(w.get('L'), LARGH_MAX, 'cella enorme: tagliata al tetto, non 2000px');

  // L'intestazione fa parte della misura: colonna dal nome lungo, valori corti.
  const w2 = larghezzeColonne([{ data_di_registrazione: 1 }], ['data_di_registrazione'], { misura, testo });
  assert.ok(w2.get('data_di_registrazione') > LARGH_MIN, "il titolo della colonna non deve essere troncato");

  // Il campione limita il lavoro: la riga 500 non viene misurata.
  const molte = [];
  for (let i = 0; i < 500; i++) molte.push({ c: 'ab' });
  molte[499].c = 'z'.repeat(50);
  const w3 = larghezzeColonne(molte, ['c'], { misura, testo, campione: 100 });
  assert.ok(w3.get('c') < LARGH_MAX, 'oltre il campione non si misura (la si allarga a mano)');

  // Senza misuratore non si inventa nulla: mappa vuota, il chiamante ripiega.
  assert.strictEqual(larghezzeColonne(dati, ['breve'], {}).size, 0);
  console.log('  ✓ larghezzeColonne: minimo, tetto, intestazione inclusa, campione rispettato');

  console.log('--- Colonne della Tabella Risultati: tutti i test superati ---');
})().catch((err) => {
  console.error('  ✗ Test colonne tabella risultati falliti:', err.message);
  process.exitCode = 1;
});
