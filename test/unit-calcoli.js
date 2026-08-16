'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario dello spostamento dei calcoli pesanti su Web Worker
 * (public/js/calcoli-protocollo.js, calcoli.js, e il precalcolo separabile di
 * chart-option.js).
 *
 * Il rischio di questa ottimizzazione non è la lentezza: è che i due percorsi
 * — con Worker e senza — smettano di dare lo stesso risultato, e che un
 * grafico o una somma cambino a seconda della DIMENSIONE del dataset. Sarebbe
 * un difetto invisibile in piccolo e inspiegabile in grande.
 *
 * Perciò qui si provano tre cose:
 *
 *  1. la decisione (`conviene`) e il calcolo del peso, che sono l'unico
 *     interruttore fra i due percorsi;
 *  2. che `eseguiCompito` — la funzione che gira su ENTRAMBI i lati del
 *     confine — copra tutti i compiti e rifiuti quelli sconosciuti;
 *  3. che il grafico costruito col precalcolo separato sia IDENTICO a quello
 *     costruito com'era prima, e che il precalcolo sopravviva a un giro di
 *     serializzazione (è ciò che accade passando da un thread all'altro).
 *
 * Il Worker vero non esiste in Node: la via sincrona è però la stessa che si
 * usa in caso di ricaduta, quindi provarla qui prova metà del meccanismo. La
 * metà con il Worker si prova in browser (collaudo Playwright).
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let falliti = 0;
function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}
async function provaAsync(nome, fn) {
  try {
    await fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

const modulo = (nome) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', nome)).href;

(async () => {
  const proto = await import(modulo('calcoli-protocollo.js'));
  const calcoli = await import(modulo('calcoli.js'));
  const opt = await import(modulo('chart-option.js'));

  console.log('--- Test unitari calcoli su Web Worker ---');

  /* --- 1. La decisione --------------------------------------------------- */

  prova('La soglia è quella dichiarata (50.000 celle)', () => {
    assert.strictEqual(proto.SOGLIA_CELLE, 50000);
    assert.strictEqual(proto.conviene(49999), false);
    assert.strictEqual(proto.conviene(50000), true);
    assert.strictEqual(proto.conviene(0), false);
  });

  prova('Il peso di un grafico conta le righe per i campi letti', () => {
    const cfg = { serie: [{ visibile: true }, { visibile: true }, { visibile: false }] };
    // 1000 righe × (asse X + 2 serie visibili) = 3000
    assert.strictEqual(proto.celleGrafico(new Array(1000), cfg), 3000);
    // Senza configurazione si conta almeno una lettura per riga.
    assert.strictEqual(proto.celleGrafico(new Array(10), null), 10);
  });

  /* --- 2. Il dispatcher condiviso --------------------------------------- */

  const valori = [1, 2, 3, '4', { $numberDecimal: '5.5' }, null, 'testo'];

  prova('eseguiCompito copre i quattro compiti', () => {
    const st = proto.eseguiCompito({ tipo: 'statistiche', valori });
    assert.strictEqual(st.numerici, 5);
    assert.strictEqual(st.somma, 15.5);

    const perCol = proto.eseguiCompito({ tipo: 'statistichePerColonna', colonne: [{ nome: 'a', valori }] });
    assert.strictEqual(perCol[0].nome, 'a');
    assert.strictEqual(perCol[0].somma, 15.5);

    const campi = proto.eseguiCompito({ tipo: 'campiDisponibili', righe: [{ a: 1, b: 'x' }] });
    assert.deepStrictEqual(campi.map((f) => f.nome).sort(), ['a', 'b']);

    const pre = proto.eseguiCompito({
      tipo: 'precalcolaGrafico',
      righe: [{ x: 'a', y: 1 }],
      cfg: cfgProva('x', 'y'),
    });
    assert.ok(pre && pre.dati, 'il precalcolo deve produrre i dati');
  });

  prova('Un compito sconosciuto viene rifiutato, non ignorato', () => {
    assert.throws(() => proto.eseguiCompito({ tipo: 'inventato' }), /sconosciuto/i);
    assert.throws(() => proto.eseguiCompito(null), /sconosciuto/i);
  });

  /* --- 3. La facciata: sotto soglia calcola sul posto -------------------- */

  await provaAsync('Sotto soglia si calcola qui, e il risultato è quello di sempre', async () => {
    const prima = calcoli.contatori.locali;
    const st = await calcoli.statisticheAsync(valori);
    assert.strictEqual(st.somma, 15.5);
    assert.strictEqual(calcoli.contatori.locali, prima + 1, 'doveva restare sul thread chiamante');
    assert.strictEqual(calcoli.workerAttivo(), false, 'nessun Worker deve essere stato creato');
  });

  await provaAsync('Senza Worker disponibile anche sopra soglia si calcola qui', async () => {
    // In Node `Worker` (quello del browser) non esiste: è esattamente la
    // condizione di ricaduta che deve restare funzionante.
    const tanti = new Array(60000).fill(2);
    const st = await calcoli.statisticheAsync(tanti);
    assert.strictEqual(st.numerici, 60000);
    assert.strictEqual(st.somma, 120000);
  });

  await provaAsync('Il sequenziatore riconosce il risultato sorpassato', async () => {
    const seq = calcoli.sequenziatore();
    const primo = seq.nuovo();
    const secondo = seq.nuovo();
    assert.strictEqual(seq.attuale(primo), false, 'il primo non è più attuale');
    assert.strictEqual(seq.attuale(secondo), true);
  });

  /* --- 3-bis. Il precalcolo non si ripete per nulla ---------------------- */

  await provaAsync('Stesse righe e stessa configurazione: il precalcolo si riusa', async () => {
    // Il grafico si ridisegna a ogni ridimensionamento del riquadro: senza
    // memoria, ogni resize ricopierebbe l'intero result set verso l'altro
    // thread per ottenere gli stessi numeri.
    const righeMemo = [{ x: 'a', y: 1 }, { x: 'b', y: 2 }];
    const c = cfgProva('x', 'y');
    calcoli.scordaPrecalcolo();

    const primo = await calcoli.precalcolaGraficoAsync(righeMemo, c);
    const riusatiPrima = calcoli.contatori.riusati;
    const secondo = await calcoli.precalcolaGraficoAsync(righeMemo, c);
    assert.strictEqual(secondo, primo, 'doveva tornare lo stesso identico risultato');
    assert.strictEqual(calcoli.contatori.riusati, riusatiPrima + 1);

    // Configurazione cambiata (il pannello la modifica sul posto): si ricalcola.
    c.ordina = 'val-desc';
    const terzo = await calcoli.precalcolaGraficoAsync(righeMemo, c);
    assert.notStrictEqual(terzo, primo, 'con un\'altra configurazione non si riusa');

    // Righe nuove (un altro result set è un altro array): si ricalcola.
    const quarto = await calcoli.precalcolaGraficoAsync([...righeMemo], c);
    assert.notStrictEqual(quarto, terzo);

    // E si può buttare via, per non tenere in vita un result set chiuso.
    calcoli.scordaPrecalcolo();
    const quinto = await calcoli.precalcolaGraficoAsync(righeMemo, c);
    assert.notStrictEqual(quinto, terzo);
  });

  /* --- 4. Il grafico non cambia ------------------------------------------ */

  function cfgProva(campoX, campoY, extra = {}) {
    const c = opt.cfgDefault();
    c.campoX = campoX;
    c.aggrega = true;
    c.serie = [{ ...opt.serieDefault(0), campoY, agg: 'somma' }];
    return { ...c, ...extra };
  }

  // Dati con categorie ripetute, così l'aggregazione ha davvero qualcosa da fare.
  const righe = [];
  for (let i = 0; i < 500; i++) {
    righe.push({ citta: ['Roma', 'Milano', 'Napoli'][i % 3], importo: (i % 7) + 0.5, data: `2026-01-${(i % 28) + 1}` });
  }

  prova('Con e senza precalcolo il grafico è identico', () => {
    const c = cfgProva('citta', 'importo');

    opt.azzeraAvvisi();
    const prima = opt.costruisciOption(righe, c, { larghezza: 800, altezza: 400 });
    const avvisiPrima = opt.prendiAvvisi();

    opt.azzeraAvvisi();
    const pre = opt.precalcola(righe, c);
    const dopo = opt.costruisciOption(righe, c, { larghezza: 800, altezza: 400 }, pre);
    const avvisiDopo = opt.prendiAvvisi();

    // Le funzioni (formatter) non si confrontano con deepStrictEqual: si
    // confrontano i DATI, che sono la parte che il precalcolo produce.
    assert.deepStrictEqual(serieDati(dopo), serieDati(prima));
    assert.deepStrictEqual(categorie(dopo), categorie(prima));
    assert.deepStrictEqual(avvisiDopo, avvisiPrima, 'anche le note devono essere le stesse');
  });

  prova('Vale anche su un asse temporale e su una torta', () => {
    for (const c of [
      cfgProva('data', 'importo'),
      (() => { const x = cfgProva('citta', 'importo'); x.serie = [{ ...x.serie[0], tipo: 'pie' }]; return x; })(),
    ]) {
      opt.azzeraAvvisi();
      const prima = opt.costruisciOption(righe, c, {});
      opt.azzeraAvvisi();
      const dopo = opt.costruisciOption(righe, c, {}, opt.precalcola(righe, c));
      assert.deepStrictEqual(serieDati(dopo), serieDati(prima));
    }
  });

  prova('Il precalcolo sopravvive al passaggio fra thread (serializzabile)', () => {
    const c = cfgProva('citta', 'importo');
    const pre = opt.precalcola(righe, c);
    // `structuredClone` è la copia che fa davvero il browser fra due thread;
    // un giro JSON è più severo (rifiuta anche undefined e le funzioni) e in
    // Node è sempre disponibile.
    const viaggiato = JSON.parse(JSON.stringify(pre));
    opt.azzeraAvvisi();
    const conCopia = opt.costruisciOption(righe, c, {}, viaggiato);
    opt.azzeraAvvisi();
    const conOriginale = opt.costruisciOption(righe, c, {}, pre);
    assert.deepStrictEqual(serieDati(conCopia), serieDati(conOriginale));
  });

  prova('Il precalcolo passato viene USATO, non rifatto', () => {
    // Senza questa prova, un `costruisciOption` che ignorasse `pre` e
    // ricalcolasse tutto passerebbe comunque i confronti di uguaglianza: il
    // risultato sarebbe giusto e il lavoro dell'altro thread buttato via.
    const c = cfgProva('citta', 'importo');
    const pre = opt.precalcola(righe, c);
    const falsato = JSON.parse(JSON.stringify(pre));
    falsato.dati.categorie = ['SOLO_QUESTA'];
    falsato.dati.valori = falsato.dati.valori.map(() => [42]);
    opt.azzeraAvvisi();
    const option = opt.costruisciOption(righe, c, {}, falsato);
    assert.deepStrictEqual(categorie(option), ['SOLO_QUESTA']);
    assert.ok(JSON.stringify(option.series[0].data).includes('42'), JSON.stringify(option.series[0].data));
  });

  prova('Le note del precalcolo non si perdono per strada', () => {
    // Il taglio delle categorie in "Altro" produce un avviso DENTRO il
    // precalcolo. Deve arrivare a chi mostra le note anche quando è stato
    // prodotto su un altro thread: è l'unico posto in cui l'utente viene a
    // sapere che il grafico non mostra tutte le categorie.
    const tante = [];
    for (let i = 0; i < 3000; i++) tante.push({ citta: `c${i}`, importo: i });
    const c = cfgProva('citta', 'importo');
    c.maxCategorie = 5;
    c.serie = [{ ...c.serie[0], agg: 'media' }];

    const pre = opt.precalcola(tante, c);
    assert.ok(pre.avvisi.length > 0, 'lo scenario deve produrre almeno una nota, altrimenti non prova nulla');

    opt.azzeraAvvisi();
    opt.costruisciOption(tante, c, {}, JSON.parse(JSON.stringify(pre)));
    const note = opt.prendiAvvisi();
    for (const n of pre.avvisi) assert.ok(note.includes(n), `manca la nota: ${n}`);
  });

  function serieDati(option) {
    return (option.series || []).map((s) => JSON.stringify(s.data ?? null));
  }
  function categorie(option) {
    return option.xAxis && option.xAxis.data ? option.xAxis.data : null;
  }

  console.log(falliti === 0
    ? '  Tutti i test dei calcoli superati.'
    : `  ${falliti} test dei calcoli FALLITI.`);
  if (falliti > 0) process.exitCode = 1;
})();
