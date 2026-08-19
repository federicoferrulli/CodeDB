'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari delle decisioni del pannello script (public/js/script-esito.js).
 *
 * Perché esistono. Uno script di due istruzioni — «USE Prova_; SELECT * FROM
 * Pippo;» su una tabella vuota — mostrava nella griglia il messaggio della USE,
 * nel contatore «2 record» (che erano le ISTRUZIONI, non le righe) e nel log
 * una sola riga su due. Tre difetti diversi, nessuno dei quali lancia: il
 * pannello sembrava funzionare e raccontava un'altra esecuzione. Sono
 * esattamente gli errori che solo un test può tenere fermi.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'script-esito.js')).href);
  const { unisciLog, righeDaMostrare, haRisultato } = mod;

  console.log('--- Test Unitari: esito del pannello script ---');

  // 1. Il log incompleto raccolto per strada viene rimpiazzato dal resoconto
  //    completo dell'evento terminale. È il caso reale: 2 istruzioni eseguite,
  //    un solo evento `statement` arrivato perché lo script è durato 12 ms e il
  //    diradamento è a 150 ms.
  {
    const raccolto = [{ line: 1, sql: 'USE Prova_', ok: true }];
    const stato = {
      results: [
        { line: 1, sql: 'USE Prova_', ok: true, rows: 1 },
        { line: 2, sql: 'SELECT * FROM Pippo', ok: true, rows: 0 },
      ],
    };
    const log = unisciLog(raccolto, stato, 200);
    assert.strictEqual(log.length, 2, 'il log deve elencare entrambe le istruzioni');
    assert.strictEqual(log[1].line, 2);
  }
  console.log('  OK   Il resoconto finale completa il log diradato');

  // 2. Gli eventi NON terminali non portano il resoconto: il log raccolto non
  //    va toccato (né azzerato, che è ciò che accadrebbe leggendo un `results`
  //    assente come una lista vuota).
  {
    const raccolto = [{ line: 1, ok: true }, { line: 2, ok: true }];
    assert.strictEqual(unisciLog(raccolto, { eseguiti: 2 }, 200), raccolto);
    assert.strictEqual(unisciLog(raccolto, {}, 200), raccolto);
    assert.strictEqual(unisciLog(raccolto, null, 200), raccolto);
  }
  console.log('  OK   Senza resoconto il log raccolto resta intatto');

  // 3. Un resoconto più CORTO non sostituisce il log: cancellerebbe righe che
  //    l'utente ha già visto passare (il resoconto del server ha un suo tetto).
  {
    const raccolto = [{ line: 1 }, { line: 2 }, { line: 3 }];
    assert.strictEqual(unisciLog(raccolto, { results: [{ line: 3 }] }, 200), raccolto);
  }
  console.log('  OK   Un resoconto più corto non cancella righe già viste');

  // 4. Il tetto di memoria vale, e tiene le righe PIÙ RECENTI.
  {
    const results = Array.from({ length: 500 }, (_, i) => ({ line: i + 1 }));
    const log = unisciLog([], { results }, 200);
    assert.strictEqual(log.length, 200);
    assert.strictEqual(log[log.length - 1].line, 500, 'devono restare le ultime');
  }
  console.log('  OK   Il tetto tiene le istruzioni più recenti');

  // 5. Il contatore dice le RIGHE MOSTRATE, non le istruzioni. Zero righe è
  //    zero: è la differenza fra una tabella vuota e il risultato della
  //    istruzione precedente lasciato lì.
  assert.strictEqual(righeDaMostrare({ docs: [{ a: 1 }, { a: 2 }] }), 2);
  assert.strictEqual(righeDaMostrare({ docs: [], columns: ['id', 'addsa'] }), 0);
  assert.strictEqual(righeDaMostrare(null), 0);
  assert.strictEqual(righeDaMostrare({}), 0);
  console.log('  OK   Il contatore conta le righe mostrate, zero incluso');

  // 6. "Zero righe" e "niente" sono due cose diverse: il primo si disegna come
  //    tabella vuota, il secondo svuota la griglia. Confonderli è come si
  //    finiva a mostrare il risultato di un'altra istruzione.
  assert.strictEqual(haRisultato({ docs: [], columns: ['id'] }), true);
  assert.strictEqual(haRisultato({ docs: [{ a: 1 }] }), true);
  assert.strictEqual(haRisultato(null), false);
  assert.strictEqual(haRisultato({ columns: ['id'] }), false);
  console.log('  OK   Result set vuoto distinto da "nessun risultato"');

  /* --- Linguette dei risultati per istruzione ----------------------------- */
  const { etichettaScheda, schedaAttiva, notaScartate } = mod;

  // 7. L'etichetta mette PRIMA la riga: in uno script generato venti
  //    «SELECT * FROM …» differiscono solo per una parola in fondo, ed è il
  //    numero di riga a rendere la scheda riconoscibile.
  {
    const et = etichettaScheda({ line: 12, sql: 'SELECT   *\n  FROM alfa', rows: 3 });
    assert.strictEqual(et.riga, 'riga 12');
    assert.strictEqual(et.testo, 'SELECT * FROM alfa', 'lo spazio va normalizzato');
    assert.strictEqual(et.righe, '3 righe');
    assert.strictEqual(etichettaScheda({ line: 1, sql: 'SELECT 1', rows: 1 }).righe, '1 riga',
      'singolare al singolare: «1 righe» fa sembrare tutto approssimativo');
    assert.strictEqual(etichettaScheda({ line: 2, sql: 'SELECT 1', rows: 0 }).righe, '0 righe');
    // Istruzione lunga: si taglia, ma il taglio si vede.
    const lunga = etichettaScheda({ line: 3, sql: 'SELECT ' + 'colonna, '.repeat(20) + 'fine FROM t', rows: 1 }, 20);
    assert.ok(lunga.testo.length <= 21 && lunga.testo.endsWith('…'));
    // Nessun testo: l'etichetta resta leggibile invece di essere vuota.
    assert.strictEqual(etichettaScheda({ line: 4, sql: '', rows: 0 }).testo, '(istruzione)');
    assert.strictEqual(etichettaScheda(null).testo, '(istruzione)');
  }
  console.log('  OK   Etichetta della linguetta: riga, istruzione normalizzata, righe');

  // 8. Si accende la linguetta dell'istruzione che ha prodotto ciò che la
  //    griglia mostra. Se la griglia mostra il riepilogo di una SCRITTURA —
  //    che linguetta non ne ha — non se ne accende nessuna: fingere il
  //    contrario sarebbe la stessa bugia appena tolta di mezzo.
  {
    const schede = [{ pos: 0, index: 1 }, { pos: 1, index: 3 }, { pos: 2, index: 4 }];
    assert.strictEqual(schedaAttiva(schede, { index: 3 }), 1);
    assert.strictEqual(schedaAttiva(schede, { index: 4 }), 2);
    assert.strictEqual(schedaAttiva(schede, { index: 2 }), null, 'indice di una scrittura: nessuna accesa');
    assert.strictEqual(schedaAttiva(schede, {}), null);
    assert.strictEqual(schedaAttiva(schede, null), null);
    assert.strictEqual(schedaAttiva([], { index: 1 }), null);
    assert.strictEqual(schedaAttiva(null, { index: 1 }), null);
    // `index: 0` è un indice valido: trattarlo come assente perché "falsy" è
    // l'errore che spegnerebbe la linguetta della PRIMA istruzione.
    assert.strictEqual(schedaAttiva([{ pos: 0, index: 0 }], { index: 0 }), 0);
  }
  console.log('  OK   Si accende la linguetta giusta, o nessuna');

  // 9. Le schede non conservate si DICONO: una linguetta che non compare,
  //    senza spiegazione, sembra un risultato perso.
  assert.strictEqual(notaScartate({ scartati: 0 }), '');
  assert.strictEqual(notaScartate(null), '');
  assert.ok(/^1 altro risultato non conservato/.test(notaScartate({ scartati: 1 })));
  assert.ok(/^7 altri risultati non conservati/.test(notaScartate({ scartati: 7 })));
  console.log('  OK   Le schede oltre il tetto vengono dichiarate, non taciute');

  console.log('Tutti i test unitari sull\'esito dello script superati!');
})().catch((err) => {
  console.error('\nFALLITO (esito script):', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
