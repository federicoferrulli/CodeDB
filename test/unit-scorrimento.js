'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari di public/js/scorrimento-bordo.js — la velocità dello
 * scorrimento automatico mentre si trascina una selezione sulla griglia.
 *
 * Perché provarlo qui: sbagliato non lancia. Un segno invertito fa scappare la
 * griglia dalla parte opposta al dito; una zona morta assente fa scorrere la
 * tabella mentre si seleziona tranquillamente in mezzo allo schermo; una fascia
 * più larga di metà contenitore crea un punto che tira in due direzioni.
 * Nessun browser: il modulo è puro proprio per essere provabile senza DOM.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Scorrimento ai Bordi ---');

(async () => {
  const { velocitaAsse, BORDO_DEFAULT, V_MAX_DEFAULT } = await import('../public/js/scorrimento-bordo.js');

  // Un contenitore realistico: 800 px di larghezza a partire da x=100.
  const MIN = 100, MAX = 900;
  const v = (p, opt) => velocitaAsse(p, MIN, MAX, opt);

  /* ------------------------------ zona morta ------------------------------ */

  assert.strictEqual(v(500), 0, 'in mezzo non si scorre');
  assert.strictEqual(v(MIN + BORDO_DEFAULT), 0, 'il confine della fascia iniziale è ancora fermo');
  assert.strictEqual(v(MAX - BORDO_DEFAULT), 0, 'il confine della fascia finale è ancora fermo');
  console.log('  ✓ nessuno scorrimento lontano dai bordi');

  /* -------------------------------- segno -------------------------------- */

  assert.ok(v(MIN + 5) < 0, 'vicino al bordo iniziale si scorre indietro');
  assert.ok(v(MAX - 5) > 0, 'vicino al bordo finale si scorre avanti');
  assert.ok(v(MIN - 300) < 0, 'fuori dal contenitore, prima dell\'inizio, si scorre indietro');
  assert.ok(v(MAX + 300) > 0, 'fuori dal contenitore, dopo la fine, si scorre avanti');
  console.log('  ✓ il verso segue il bordo avvicinato');

  /* ------------------------- crescita e saturazione ----------------------- */

  // Più ci si avvicina al bordo, più si corre: è ciò che rende usabile il
  // gesto (accostarsi appena = scorrimento lento e controllabile).
  const scala = [39, 30, 20, 10, 0].map((d) => Math.abs(v(MIN + d)));
  for (let i = 1; i < scala.length; i++) {
    assert.ok(scala[i] >= scala[i - 1], `la velocità cresce avvicinandosi al bordo (${scala})`);
  }
  assert.ok(scala[scala.length - 1] > scala[0], 'sul bordo si corre più che a inizio fascia');

  assert.strictEqual(v(MIN), -V_MAX_DEFAULT, 'sul bordo esatto si è già al massimo');
  assert.strictEqual(v(MIN - 1000), -V_MAX_DEFAULT, 'oltre il bordo la velocità satura, non esplode');
  assert.strictEqual(v(MAX + 1000), V_MAX_DEFAULT, 'idem dall\'altro lato');
  console.log('  ✓ velocità crescente e saturata al massimo');

  /* ---------------------- contenitore più stretto della fascia ------------ */

  // Griglia in un pannello di 50 px: due fasce da 40 px si sovrapporrebbero e
  // il punto centrale apparterrebbe a entrambe. La fascia si dimezza, quindi
  // esiste ancora un centro fermo e i due versi restano coerenti.
  const stretto = (p) => velocitaAsse(p, 0, 50);
  assert.strictEqual(stretto(25), 0, 'il centro di un contenitore stretto resta fermo');
  assert.ok(stretto(5) < 0 && stretto(45) > 0, 'i versi restano coerenti anche da stretto');
  console.log('  ✓ contenitore più stretto di due fasce');

  /* ------------------------------ parametri ------------------------------ */

  assert.strictEqual(velocitaAsse(MIN + 5, MIN, MAX, { bordo: 2 }), 0,
    'con una fascia di 2 px, a 5 px dal bordo non si scorre ancora');
  assert.strictEqual(velocitaAsse(MAX, MIN, MAX, { vMax: 8 }), 8, 'vMax è rispettato');
  console.log('  ✓ bordo e vMax configurabili');

  /* ------------------------------- ingressi ------------------------------- */

  // Un `getBoundingClientRect()` su un elemento staccato dà zeri e NaN non
  // arriva mai: ma un contenitore di altezza 0 (pannello chiuso) sì. Non deve
  // produrre uno scorrimento infinito né un NaN che sporca scrollTop.
  assert.strictEqual(velocitaAsse(0, 0, 0), 0, 'contenitore di dimensione nulla: fermo');
  for (const p of [NaN, undefined, null, Infinity]) {
    assert.strictEqual(v(p), 0, `ingresso non finito (${p}) non muove nulla`);
  }
  console.log('  ✓ ingressi degeneri non producono NaN né corse infinite');

  console.log('--- Scorrimento ai bordi: tutti i test superati ---');
})().catch((err) => {
  console.error('  ✗ Test scorrimento ai bordi fallito:', err.message);
  process.exitCode = 1;
});
