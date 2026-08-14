'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari del grafico della selezione di celle
 * (public/js/cell-chart.js). Nessun database, nessun browser: il modulo è puro
 * (importa solo `chart-option.js`, a sua volta provato da unit-charts.js)
 * proprio per essere provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede — un grafico
 * costruito male non lancia eccezioni, disegna barre plausibili:
 *   1. la selezione resta una TABELLA: due colonne selezionate insieme non si
 *      appiattiscono in una serie sola con i valori alternati;
 *   2. ogni colonna numerica diventa una serie, e la colonna finita sull'asse X
 *      non diventa anche una misura di sé stessa;
 *   3. il raggruppamento si accende solo se i valori dell'asse si RIPETONO:
 *      raggruppare valori tutti diversi aggiunge un calcolo che nessuno ha
 *      chiesto, e il totale che ne esce sembra un dato;
 *   4. i limiti sono dichiarati: righe tagliate e serie in eccesso producono una
 *      nota, non un grafico silenziosamente parziale.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Grafico della Selezione di Celle ---');

(async () => {
  const {
    datiSelezione, configurazioneSelezione, colonneNumeriche, CAMPO_ORDINE, MAX_RIGHE,
  } = await import('../public/js/cell-chart.js');
  const { CATEGORICA, costruisciOption } = await import('../public/js/chart-option.js');

  /** Comodità: costruisce le voci come le passa cellselect.js (ordine di lettura). */
  const voci = (righe) => {
    const out = [];
    righe.forEach((obj, i) => {
      for (const [colonna, valore] of Object.entries(obj)) out.push({ valore, colonna, riga: i });
    });
    return out;
  };

  /* ----------------------------- datiSelezione --------------------------- */

  {
    const d = datiSelezione(voci([
      { regione: 'Lazio', importo: 10, pezzi: 2 },
      { regione: 'Puglia', importo: 20, pezzi: 3 },
    ]));
    assert.deepStrictEqual(d.colonne, ['regione', 'importo', 'pezzi'], 'colonne nell\'ordine di comparsa');
    assert.strictEqual(d.righe.length, 2, 'una riga della griglia = una riga del grafico');
    assert.strictEqual(d.righe[0].importo, 10);
    assert.strictEqual(d.righe[0].pezzi, 2, 'le colonne selezionate insieme restano sulla STESSA riga');
    assert.strictEqual(d.tagliate, 0);
    console.log('  ✓ la selezione resta una tabella (righe × colonne)');
  }

  {
    // Selezione "bucata" (Ctrl+clic): le celle mancanti restano assenti, non
    // diventano zeri — uno zero inventato è un punto sul grafico che mente.
    const d = datiSelezione([
      { valore: 5, colonna: 'importo', riga: 7 },
      { valore: 9, colonna: 'importo', riga: 9 },
    ]);
    assert.strictEqual(d.righe.length, 2);
    assert.strictEqual(d.righe[0][CAMPO_ORDINE], 1);
    assert.strictEqual(d.righe[1][CAMPO_ORDINE], 2, 'l\'ordinale è quello della SELEZIONE, non della pagina');
    assert.ok(!('pezzi' in d.righe[0]), 'nessuna colonna inventata');
    console.log('  ✓ ordinale di riga progressivo e celle mancanti non riempite');
  }

  {
    // Una colonna della tabella chiamata "#" esiste: l'ordinale non deve
    // sovrascrivere un dato vero.
    const d = datiSelezione([{ valore: 'x', colonna: CAMPO_ORDINE, riga: 0 }]);
    assert.strictEqual(d.righe[0][CAMPO_ORDINE], 'x', 'il dato dell\'utente ha la precedenza');
    console.log('  ✓ una colonna chiamata "#" non viene sovrascritta');
  }

  {
    // I nomi delle colonne sono dati del database, non proprietà sicure di un
    // oggetto normale: __proto__/constructor/toString devono restare colonne.
    const d = datiSelezione([
      { valore: { inquinato: true }, colonna: '__proto__', riga: 0 },
      { valore: 7, colonna: 'constructor', riga: 0 },
      { valore: 'testo', colonna: 'toString', riga: 0 },
    ]);
    assert.deepStrictEqual(d.righe[0].__proto__, { inquinato: true });
    assert.strictEqual(d.righe[0].constructor, 7);
    assert.strictEqual(d.righe[0].toString, 'testo');
    assert.strictEqual({}.inquinato, undefined, 'il prototipo globale non deve essere alterato');
    console.log('  ✓ nomi di colonna speciali conservati senza prototype pollution');
  }

  {
    const molte = [];
    for (let i = 0; i < MAX_RIGHE + 25; i++) molte.push({ valore: i, colonna: 'n', riga: i });
    const d = datiSelezione(molte);
    assert.strictEqual(d.righe.length, MAX_RIGHE, 'tetto di righe rispettato');
    assert.strictEqual(d.tagliate, 25, 'le righe escluse si CONTANO (per righe, non per celle)');
    const { note } = configurazioneSelezione(d);
    assert.ok(note.some((n) => /troppo grande/i.test(n)), 'il taglio va dichiarato all\'utente');
    console.log('  ✓ selezione enorme: tagliata al tetto e dichiarata');
  }

  /* ------------------------- configurazioneSelezione --------------------- */

  {
    // Categorie ripetute + due colonne numeriche: asse = la categoria, due
    // serie, raggruppamento acceso.
    const d = datiSelezione(voci([
      { regione: 'Lazio', importo: 10, pezzi: 2 },
      { regione: 'Lazio', importo: 5, pezzi: 1 },
      { regione: 'Puglia', importo: 20, pezzi: 3 },
    ]));
    const { cfg } = configurazioneSelezione(d);
    assert.strictEqual(cfg.campoX, 'regione');
    assert.strictEqual(cfg.assex.tipo, 'category');
    assert.deepStrictEqual(cfg.serie.map((s) => s.campoY), ['importo', 'pezzi'], 'una serie per colonna numerica');
    assert.strictEqual(cfg.aggrega, true, 'valori dell\'asse ripetuti → raggruppamento');
    assert.ok(cfg.serie.every((s) => s.agg === 'somma'));
    assert.ok(cfg.serie.every((s) => s.autoY === false), 'scelte della selezione: non da rimpiazzare');
    console.log('  ✓ categoria + misure: due serie e raggruppamento');
  }

  {
    // Stessa forma ma con valori dell'asse tutti diversi: raggruppare non
    // unirebbe nulla, e il calcolo aggiunto sembrerebbe un dato.
    const d = datiSelezione(voci([
      { codice: 'A1', importo: 10 },
      { codice: 'A2', importo: 20 },
    ]));
    const { cfg } = configurazioneSelezione(d);
    assert.strictEqual(cfg.campoX, 'codice');
    assert.strictEqual(cfg.aggrega, false, 'nessun doppione → valori grezzi');
    assert.strictEqual(cfg.serie[0].agg, 'primo');
    console.log('  ✓ asse senza doppioni: nessun raggruppamento inventato');
  }

  {
    // Una sola colonna di numeri: l'asse è l'ordinale della riga, e quella
    // colonna resta la misura (non diventa anche l'asse di sé stessa).
    const d = datiSelezione(voci([{ importo: 10 }, { importo: 30 }]));
    const { cfg } = configurazioneSelezione(d);
    assert.strictEqual(cfg.campoX, CAMPO_ORDINE);
    assert.deepStrictEqual(cfg.serie.map((s) => s.campoY), ['importo']);
    assert.strictEqual(cfg.aggrega, false, 'l\'ordinale è unico per definizione');
    console.log('  ✓ una sola colonna numerica: asse = ordine di riga');
  }

  {
    // Una data batte una colonna di testo come asse, e il grafico diventa una
    // linea su asse temporale (le distanze fra i punti sono il tempo).
    const d = datiSelezione(voci([
      { canale: 'web', creato: { $date: '2026-01-01T00:00:00Z' }, importo: 3 },
      { canale: 'web', creato: { $date: '2026-02-01T00:00:00Z' }, importo: 4 },
    ]));
    const { cfg } = configurazioneSelezione(d);
    assert.strictEqual(cfg.campoX, 'creato', 'la data ha la precedenza sul testo');
    assert.strictEqual(cfg.assex.tipo, 'time');
    assert.ok(cfg.serie.every((s) => s.tipo === 'line'), 'un andamento nel tempo è una linea');
    console.log('  ✓ colonna data: asse temporale e linea');
  }

  {
    // Valori EJSON: un DECIMAL di MySQL è {$numberDecimal:"12.50"} e un BIGINT
    // {$numberLong:…}. Senza riconoscerli, la colonna non sarebbe una misura e
    // il grafico risulterebbe vuoto — sembrando un problema della query.
    const d = datiSelezione(voci([
      { citta: 'Bari', totale: { $numberDecimal: '12.50' }, righe: { $numberLong: '3' } },
      { citta: 'Bari', totale: { $numberDecimal: '7.50' }, righe: { $numberLong: '1' } },
    ]));
    const { cfg } = configurazioneSelezione(d);
    assert.deepStrictEqual(cfg.serie.map((s) => s.campoY), ['totale', 'righe'], 'EJSON riconosciuto come numero');
    console.log('  ✓ DECIMAL e NumberLong contano come misure');
  }

  {
    // Nessuna colonna numerica: l'unico grafico onesto è quante righe hanno lo
    // stesso valore, e va detto che è questo che si sta guardando.
    const d = datiSelezione(voci([{ stato: 'attivo' }, { stato: 'sospeso' }, { stato: 'attivo' }]));
    const { cfg, note, misure } = configurazioneSelezione(d);
    assert.strictEqual(cfg.serie.length, 1);
    assert.strictEqual(cfg.serie[0].campoY, null);
    assert.strictEqual(cfg.serie[0].agg, 'conteggio');
    assert.strictEqual(cfg.aggrega, true);
    assert.deepStrictEqual(misure, []);
    assert.ok(note.some((n) => /nessuna colonna numerica/i.test(n)), 'il ripiego va spiegato');
    console.log('  ✓ sole categorie: conteggio delle righe, dichiarato');
  }

  {
    // Più colonne numeriche dei colori distinguibili: si mostra quel che si può
    // e si dice quante sono rimaste fuori.
    const riga = {};
    for (let i = 0; i < CATEGORICA.length + 3; i++) riga[`m${i}`] = i + 1;
    const d = datiSelezione(voci([riga, { ...riga }]));
    const { cfg, note } = configurazioneSelezione(d);
    assert.strictEqual(cfg.serie.length, CATEGORICA.length, 'tetto = colori verificati disponibili');
    assert.ok(note.some((n) => /colonne numeriche/i.test(n)), 'le colonne escluse vanno annunciate');
    // Gli slot di colore sono distinti: due serie dello stesso colore sono due
    // serie che non si distinguono.
    assert.strictEqual(new Set(cfg.serie.map((s) => s.slot)).size, cfg.serie.length);
    console.log('  ✓ troppe misure: tetto ai colori e nota');
  }

  {
    // Le misure OFFERTE dall'interfaccia si chiedono qui, non con una seconda
    // regola nel modulo del DOM: due criteri diversi per "questa colonna è un
    // numero" divergono, e una colonna disegnata come serie resterebbe senza il
    // pulsante per spegnerla. La colonna sporca (un testo in mezzo ai numeri)
    // resta una misura, come per l'asse: decide la maggioranza dei valori.
    const d = datiSelezione(voci([
      { citta: 'Bari', importo: 10, note: 'ok' },
      { citta: 'Bari', importo: 'n/d', note: 'ok' },
      { citta: 'Roma', importo: 30, note: 'ok' },
    ]));
    assert.deepStrictEqual(colonneNumeriche(d.righe, d.colonne), ['importo']);
    assert.deepStrictEqual(colonneNumeriche(d.righe, d.colonne),
      configurazioneSelezione(d).cfg.serie.map((s) => s.campoY),
      'le misure offerte coincidono con quelle disegnate');
    console.log('  ✓ misure offerte all\'interfaccia = misure disegnate');
  }

  {
    // La configurazione va provata FINO AL DISEGNO, non solo nella sua forma:
    // una cfg perfetta può produrre un'option con gli assi sbagliati, e questa
    // è esattamente la falla da cui è passato il difetto delle etichette
    // "undefined" sull'asse ordinale (numerico) — barre giuste, asse illeggibile.
    const d = datiSelezione(voci([{ importo: 10 }, { importo: 30 }, { importo: 20 }]));
    const { cfg } = configurazioneSelezione(d);
    const opt = costruisciOption(d.righe, cfg, { larghezza: 900, altezza: 400 });
    assert.deepStrictEqual(opt.xAxis.data, ['1', '2', '3'], 'asse = ordinale leggibile');
    assert.deepStrictEqual(opt.series[0].data, [10, 30, 20], 'i valori arrivano al grafico così come sono');
    console.log('  ✓ la configurazione arriva a un\'option con assi e valori leggibili');
  }

  {
    // Selezione vuota: nessuna eccezione, una configurazione neutra.
    const { cfg, note, misure } = configurazioneSelezione(datiSelezione([]));
    assert.ok(cfg && Array.isArray(cfg.serie));
    assert.deepStrictEqual(note, []);
    assert.deepStrictEqual(misure, []);
    console.log('  ✓ selezione vuota: nessuna eccezione');
  }

  console.log('--- Grafico della Selezione: tutti i test superati ---\n');
})().catch((err) => {
  console.error('✗ Test grafico della selezione falliti:', err);
  process.exit(1);
});
