'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari di public/js/split-layout.js — la geometria della Split-View.
 * Nessun browser: il modulo è foglia e non tocca il DOM proprio per essere
 * provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede a occhio:
 *   1. il trascinamento conserva la somma delle quote e rispetta il minimo:
 *      senza, un pannello scompare sotto il vicino e non torna più;
 *   2. la rimozione ridistribuisce e collassa i contenitori rimasti a un figlio,
 *      altrimenti l'albero accumula livelli inerti a ogni chiusura;
 *   3. l'inserimento con lo stesso orientamento del genitore aggiunge un
 *      FRATELLO: annidando, il separatore più esterno muove insieme pannelli
 *      che sullo schermo non sembrano collegati;
 *   4. `valida` rimette in piedi un albero che cita pannelli morti o ne dimentica
 *      di vivi — è lo scenario del F5, dove il difetto è un pannello invisibile;
 *   5. il round-trip JSON non cambia nulla: quell'albero passa da
 *      `sessionStorage` a ogni refresh;
 *   6. nessuna funzione muta l'argomento: lo stesso oggetto è nello stato vivo e
 *      nello snapshot, e una mutazione in posto li farebbe divergere in silenzio.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Layout Split-View ---');

(async () => {
  const L = await import('../public/js/split-layout.js');
  const {
    creaAlbero, inserisci, rimuovi, trascina, pareggia, scambia,
    ruotaOrientamento, elencoPane, contaPane, valida, normalizza,
    dimensioniNormalizzate, contenitoreDi, vicinoDi,
  } = L;

  const somma = (a) => a.reduce((x, y) => x + y, 0);
  const quasi = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (${a} ≠ ${b})`);

  /* ----------------------------- normalizza ------------------------------ */

  assert.deepStrictEqual(normalizza([1, 1], 2), [0.5, 0.5], 'quote uguali normalizzate a 1');
  assert.deepStrictEqual(normalizza(null, 4), [0.25, 0.25, 0.25, 0.25], 'quote assenti = parti uguali');
  assert.deepStrictEqual(normalizza([0.9], 2), [0.5, 0.5], 'lunghezza incoerente = si riparte da zero');
  assert.deepStrictEqual(normalizza([0, 0], 2), [0.5, 0.5], 'somma nulla non deve produrre NaN');
  assert.deepStrictEqual(normalizza(['x', 2], 2), [0, 1], 'valori non numerici valgono zero');
  quasi(somma(normalizza([3, 1], 2)), 1, 'normalizza porta sempre a somma 1');
  console.log('  ✓ normalizza: quote assenti, incoerenti o spazzatura non producono NaN');

  /* ------------------------------ creaAlbero ------------------------------ */

  const due = creaAlbero('a', 'b', 'right');
  assert.strictEqual(due.type, 'row', 'destra/sinistra = riga');
  assert.deepStrictEqual(elencoPane(due), ['a', 'b'], 'a destra il nuovo va dopo');
  assert.deepStrictEqual(elencoPane(creaAlbero('a', 'b', 'left')), ['b', 'a'], 'a sinistra va prima');
  assert.strictEqual(creaAlbero('a', 'b', 'bottom').type, 'col', 'sopra/sotto = colonna');
  assert.deepStrictEqual(elencoPane(creaAlbero('a', 'b', 'top')), ['b', 'a'], 'sopra va prima');
  console.log('  ✓ creaAlbero: orientamento e ordine seguono la direzione del rilascio');

  /* ------------------------------- inserisci ------------------------------ */

  // Stesso orientamento del genitore → fratello, non annidamento.
  const tre = inserisci(due, 'b', 'c', 'right');
  assert.strictEqual(tre.children.length, 3, 'tre figli nello stesso contenitore');
  assert.ok(tre.children.every((n) => n.type === 'pane'), 'nessun contenitore annidato');
  assert.deepStrictEqual(elencoPane(tre), ['a', 'b', 'c'], 'ordine visivo corretto');
  quasi(somma(dimensioniNormalizzate(tre)), 1, 'quote ancora a somma 1');
  // Lo spazio lo cede il solo bersaglio: `a` non si è mosso.
  quasi(dimensioniNormalizzate(tre)[0], 0.5, 'il pannello non coinvolto conserva la sua quota');
  quasi(dimensioniNormalizzate(tre)[1], 0.25, 'il bersaglio cede metà della propria quota');
  quasi(dimensioniNormalizzate(tre)[2], 0.25, 'il nuovo pannello prende l\'altra metà');

  // Orientamento diverso → si annida, e solo lì.
  const misto = inserisci(due, 'b', 'd', 'bottom');
  assert.strictEqual(misto.type, 'row', 'la radice resta una riga');
  assert.strictEqual(misto.children[1].type, 'col', 'il bersaglio diventa una colonna');
  assert.deepStrictEqual(elencoPane(misto), ['a', 'b', 'd'], 'ordine visivo dopo l\'annidamento');
  quasi(dimensioniNormalizzate(misto)[0], 0.5, 'annidando, le quote della riga non cambiano');

  assert.deepStrictEqual(elencoPane(inserisci(null, 'x', 'a', 'right')), ['a'], 'albero vuoto: nasce il primo pannello');
  assert.deepStrictEqual(elencoPane(inserisci(due, 'inesistente', 'z', 'right')), ['a', 'b'],
    'bersaglio inesistente: l\'albero non cambia');
  console.log('  ✓ inserisci: fratello a orientamento uguale, annidamento solo quando serve');

  /* -------------------------------- rimuovi ------------------------------- */

  const senzaB = rimuovi(tre, 'b');
  assert.deepStrictEqual(elencoPane(senzaB), ['a', 'c']);
  quasi(somma(dimensioniNormalizzate(senzaB)), 1, 'somma 1 dopo la rimozione');
  // 0.5 e 0.25 superstiti → il rapporto 2:1 va conservato, non pareggiato.
  quasi(dimensioniNormalizzate(senzaB)[0] / dimensioniNormalizzate(senzaB)[1], 2,
    'la quota del rimosso si spartisce in proporzione, non in parti uguali');

  // Tre livelli: il collasso deve risalire, senza lasciare contenitori a un figlio.
  const profondo = inserisci(inserisci(creaAlbero('a', 'b', 'right'), 'b', 'c', 'bottom'), 'c', 'd', 'right');
  assert.strictEqual(contaPane(profondo), 4);
  let potato = rimuovi(profondo, 'c');
  potato = rimuovi(potato, 'd');
  assert.deepStrictEqual(elencoPane(potato), ['a', 'b'], 'restano i due pannelli attesi');
  const nessunoASoloFiglio = (n) => {
    if (n.type === 'pane') return true;
    return n.children.length >= 2 && n.children.every(nessunoASoloFiglio);
  };
  assert.ok(nessunoASoloFiglio(potato), 'nessun contenitore rimasto con un figlio solo');
  quasi(somma(dimensioniNormalizzate(potato)), 1, 'somma 1 anche dopo due collassi');

  assert.strictEqual(rimuovi({ type: 'pane', paneId: 'a' }, 'a'), null, 'ultimo pannello rimosso = albero vuoto');
  console.log('  ✓ rimuovi: ridistribuzione proporzionale e collasso dei contenitori inutili');

  /* -------------------------------- trascina ------------------------------ */

  const base = [0.5, 0.5];
  const dx = trascina(base, 0, 100, 1000, 220);
  quasi(somma(dx), 1, 'il trascinamento conserva la somma');
  quasi(dx[0], 0.6, '100px su 1000 = +10%');
  quasi(dx[1], 0.4, 'lo spazio lo cede il solo vicino');

  // Delta enorme nei due versi: clamp simmetrico, mai sotto il minimo.
  const tuttoADestra = trascina(base, 0, 99999, 1000, 220);
  quasi(tuttoADestra[1], 0.22, 'il vicino non scende sotto il minimo (220/1000)');
  const tuttoASinistra = trascina(base, 0, -99999, 1000, 220);
  quasi(tuttoASinistra[0], 0.22, 'e nemmeno il pannello trascinato');
  quasi(somma(tuttoASinistra), 1, 'somma 1 anche al clamp');

  // Tre pannelli: gli altri non si muovono.
  const t3 = trascina([0.4, 0.3, 0.3], 1, 50, 1000, 100);
  quasi(t3[0], 0.4, 'il pannello lontano dal separatore non si muove');
  quasi(t3[1], 0.35);
  quasi(t3[2], 0.25);
  quasi(somma(t3), 1);

  // Spazio insufficiente per due minimi: si spartisce, non ci si blocca.
  const stretto = trascina([0.5, 0.5], 0, -9999, 300, 220);
  quasi(stretto[0], 0.5, 'senza spazio per due minimi, i due vicini restano pari');
  quasi(somma(stretto), 1);

  assert.deepStrictEqual(trascina(base, 1, 10, 1000, 0), base, 'indice oltre l\'ultimo separatore: nessun effetto');
  assert.deepStrictEqual(trascina(base, 0, 10, 0, 0), base, 'contenitore di larghezza nulla: nessun effetto');
  assert.deepStrictEqual(trascina(base, 0, NaN, 1000, 0), base, 'delta non numerico: nessun effetto');
  console.log('  ✓ trascina: somma conservata, minimo rispettato, vicini isolati');

  /* --------------------- pareggia / scambia / ruota ----------------------- */

  const sbilanciato = { type: 'row', children: [{ type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'b' }], sizes: [0.9, 0.1] };
  assert.deepStrictEqual(dimensioniNormalizzate(pareggia(sbilanciato)), [0.5, 0.5], 'pareggia riporta a parti uguali');

  // Pareggio del SOLO contenitore che ospita il pannello: la riga esterna resta com'è.
  const annidato = {
    type: 'row',
    sizes: [0.8, 0.2],
    children: [
      { type: 'pane', paneId: 'a' },
      { type: 'col', sizes: [0.9, 0.1], children: [{ type: 'pane', paneId: 'b' }, { type: 'pane', paneId: 'c' }] },
    ],
  };
  const pareggiatoDentro = pareggia(annidato, 'b');
  assert.deepStrictEqual(dimensioniNormalizzate(pareggiatoDentro), [0.8, 0.2], 'il contenitore esterno non viene toccato');
  assert.deepStrictEqual(dimensioniNormalizzate(pareggiatoDentro.children[1]), [0.5, 0.5], 'pareggiato solo il contenitore del pannello');

  const scambiato = scambia(annidato, 'a', 'c');
  assert.deepStrictEqual(elencoPane(scambiato), ['c', 'b', 'a'], 'i due pannelli si scambiano di posto');
  assert.deepStrictEqual(dimensioniNormalizzate(scambiato), [0.8, 0.2], 'le quote restano al posto, non al pannello');

  const ruotato = ruotaOrientamento(annidato, 'b');
  assert.strictEqual(ruotato.children[1].type, 'row', 'colonna → riga sul contenitore del pannello');
  assert.strictEqual(ruotato.type, 'row', 'gli altri contenitori non cambiano');
  assert.deepStrictEqual(elencoPane(ruotato), ['a', 'b', 'c'], 'la rotazione non riordina i pannelli');

  assert.strictEqual(contenitoreDi(annidato, 'c').indice, 1, 'contenitoreDi trova posizione e genitore');
  assert.strictEqual(contenitoreDi(annidato, 'inesistente'), null);
  assert.strictEqual(vicinoDi(annidato, 'b', 'next'), 'c');
  assert.strictEqual(vicinoDi(annidato, 'a', 'prev'), null, 'il primo pannello non ha un precedente');
  console.log('  ✓ pareggia/scambia/ruota agiscono sul contenitore giusto');

  /* --------------------------------- valida ------------------------------- */

  // Scenario F5: lo snapshot cita un pannello che non è stato ricreato.
  const conFantasma = valida(annidato, new Set(['a', 'c']));
  assert.deepStrictEqual(elencoPane(conFantasma), ['a', 'c'], 'i riferimenti morti vengono potati');
  assert.ok(nessunoASoloFiglio(conFantasma), 'e il contenitore rimasto solo collassa');
  quasi(somma(dimensioniNormalizzate(conFantasma)), 1);

  // Doppio riferimento allo stesso pannello: ne resta uno solo (due nodi con lo
  // stesso id significherebbero lo stesso elemento DOM in due punti).
  const doppio = { type: 'row', children: [{ type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'a' }], sizes: [0.5, 0.5] };
  assert.deepStrictEqual(elencoPane(valida(doppio, new Set(['a']))), ['a'], 'nessun id duplicato sopravvive');

  // Pannello vivo che l'albero non cita: va aggiunto, altrimenti è invisibile.
  const conMancante = valida(due, new Set(['a', 'b', 'nuovo']));
  assert.deepStrictEqual(elencoPane(conMancante), ['a', 'b', 'nuovo'], 'i pannelli vivi non citati vengono aggiunti');
  quasi(somma(dimensioniNormalizzate(conMancante)), 1);

  assert.strictEqual(valida(null, new Set()), null, 'nessun pannello vivo = nessun albero');
  assert.deepStrictEqual(elencoPane(valida(null, new Set(['solo']))), ['solo'], 'albero perso ma pannello vivo: si ricostruisce');
  assert.deepStrictEqual(elencoPane(valida({ type: 'strano' }, new Set(['a']))), ['a'], 'nodo malformato da storage esterno');
  console.log('  ✓ valida: albero coerente coi pannelli davvero vivi (scenario F5)');

  /* ------------------- immutabilità e round-trip JSON --------------------- */

  const originale = JSON.parse(JSON.stringify(annidato));
  inserisci(annidato, 'b', 'z', 'right');
  rimuovi(annidato, 'b');
  pareggia(annidato);
  scambia(annidato, 'a', 'b');
  ruotaOrientamento(annidato, 'b');
  valida(annidato, new Set(['a']));
  assert.deepStrictEqual(annidato, originale, 'nessuna funzione muta l\'albero ricevuto');

  const dopoJson = JSON.parse(JSON.stringify(tre));
  assert.deepStrictEqual(dopoJson, tre, 'l\'albero sopravvive identico al round-trip JSON (sessionStorage)');
  assert.deepStrictEqual(elencoPane(dopoJson), elencoPane(tre));
  console.log('  ✓ immutabilità e round-trip JSON dello snapshot');

  console.log('--- Layout Split-View: tutti i test superati ---');
})().catch((err) => {
  console.error('  ✗ Test layout Split-View fallito:', err.message);
  process.exitCode = 1;
});
