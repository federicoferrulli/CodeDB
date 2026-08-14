'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari della vista Grafici della tab ⚡ Query & Aggregate
 * (public/js/chart-option.js). Nessun database, nessun browser: si prova lo
 * strato PURO, cioè le due funzioni da cui dipende tutto il resto —
 * `campiDisponibili` (che campi offrire e di che tipo) e `costruisciOption`
 * (dai risultati all'`option` ECharts).
 *
 * Cosa vale la pena verificare qui, perché sbagliato non si vede subito:
 *   1. i valori EJSON. Le righe arrivano dal server in Extended JSON: un
 *      DECIMAL di MySQL è `{$numberDecimal:"12.5"}` e una data è `{$date:…}`.
 *      Senza la conversione il grafico non è "sbagliato", è VUOTO — e sembra un
 *      problema della query.
 *   2. l'aggregazione. Un result set grezzo ha 50.000 righe e 12 mesi: se il
 *      raggruppamento sbaglia, il grafico mostra numeri plausibili ma falsi,
 *      che è il modo peggiore di sbagliare.
 *   3. le regole di leggibilità che il pannello impone per costruzione: colore
 *      legato alla serie e non alla sua posizione, nessun secondo asse Y,
 *      legenda assente con una sola serie, coda ripiegata in "Altro".
 *
 * `chart-option.js` non importa nulla dell'applicazione (solo il modulo foglia
 * `valori.js`): non serve alcun browser finto per provarlo.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Custom Charts (ECharts) ---');

(async () => {
  const {
    campiDisponibili, costruisciOption, suggerimenti, azzeraAvvisi, prendiAvvisi,
  } = await import('../public/js/chart-option.js');

  /* --------------------------- campiDisponibili -------------------------- */

  const righeMisto = [
    { _id: { $oid: 'a'.repeat(24) }, nome: 'Rossi', importo: { $numberDecimal: '12.50' }, creato: { $date: 1700000000000 }, attivo: true },
    { _id: { $oid: 'b'.repeat(24) }, nome: 'Bianchi', importo: { $numberDecimal: '7.25' }, creato: { $date: 1700086400000 }, attivo: false },
  ];

  const campi = campiDisponibili(righeMisto);
  const perNome = new Map(campi.map((f) => [f.nome, f.tipo]));
  assert.strictEqual(perNome.get('importo'), 'numero', 'Un $numberDecimal deve essere un campo numerico');
  assert.strictEqual(perNome.get('creato'), 'data', 'Un $date deve essere un campo data');
  assert.strictEqual(perNome.get('nome'), 'testo', 'Una stringa deve essere un campo testo');
  // Un oggetto EJSON è un VALORE, non un sottodocumento: `creato.$date` fra i
  // campi proponibili sarebbe un campo fantasma che non si può graficare.
  assert.ok(!campi.some((f) => f.nome.includes('$')), 'Nessun campo deve derivare dall\'interno di un oggetto EJSON');
  console.log('  OK   Tipi dei campi dedotti dai valori EJSON (decimal, date, oid)');

  const righeAnnidate = [{ utente: { citta: 'Roma', eta: 30 } }, { utente: { citta: 'Milano', eta: 41 } }];
  const campiAnnidati = campiDisponibili(righeAnnidate).map((f) => f.nome);
  assert.ok(campiAnnidati.includes('utente.citta'), 'I sottodocumenti devono produrre percorsi puntati');
  assert.ok(campiAnnidati.includes('utente.eta'), 'I sottodocumenti devono produrre percorsi puntati');
  console.log('  OK   Percorsi annidati (a.b) fra i campi disponibili');

  /* ------------------------- Configurazione base ------------------------- */

  const cfgBase = (over = {}) => ({
    titolo: '',
    sottotitolo: '',
    campoX: 'citta',
    aggrega: true,
    ordina: 'nessuno',
    maxCategorie: 0,
    serie: [{
      id: 's1', nome: '', tipo: 'bar', campoY: 'importo', campoY2: null, agg: 'somma',
      colore: '', slot: 0, visibile: true, stack: '', smooth: false, areaOpacita: 10,
      larghezzaLinea: 2, simbolo: 'circle', dimSimbolo: 8, barMax: 24, etichette: false,
      posEtichette: 'top', opacita: 100,
    }],
    assex: { tipo: 'category', nome: '', rotazione: 0, griglia: false, inverti: false },
    assey: { tipo: 'value', nome: '', min: '', max: '', griglia: true, log: false, formato: 'migliaia' },
    legenda: { mostra: 'auto', posizione: 'top', orient: 'horizontal' },
    tooltip: { mostra: true, trigger: 'auto' },
    griglia: { top: 56, right: 28, bottom: 52, left: 64 },
    zoom: false,
    orizzontale: false,
    animazione: true,
    tavolozza: 'categorica',
    override: '',
    overrideAttivo: false,
    ...over,
  });

  const vendite = [
    { citta: 'Roma', importo: 10, categoria: 'A' },
    { citta: 'Roma', importo: 5, categoria: 'B' },
    { citta: 'Milano', importo: 20, categoria: 'A' },
    { citta: 'Napoli', importo: 1, categoria: 'B' },
  ];

  /* ---------------------------- Aggregazione ---------------------------- */

  let opt = costruisciOption(vendite, cfgBase());
  assert.deepStrictEqual(opt.xAxis.data, ['Roma', 'Milano', 'Napoli'], 'Le categorie collassano nell\'ordine di prima apparizione');
  assert.deepStrictEqual(opt.series[0].data, [15, 20, 1], 'La somma per categoria deve essere corretta');
  console.log('  OK   Aggregazione "somma" per categoria');

  opt = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], agg: 'media' }] }));
  assert.deepStrictEqual(opt.series[0].data, [7.5, 20, 1], 'La media per categoria deve essere corretta');

  opt = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], agg: 'conteggio' }] }));
  assert.deepStrictEqual(opt.series[0].data, [2, 1, 1], 'Il conteggio righe non deve dipendere dal campo valore');

  opt = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], agg: 'max' }] }));
  assert.deepStrictEqual(opt.series[0].data, [10, 20, 1], 'Il massimo per categoria deve essere corretto');

  opt = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], campoY: 'categoria', agg: 'distinti' }] }));
  assert.deepStrictEqual(opt.series[0].data, [2, 1, 1], 'Il conteggio distinti deve contare i valori diversi');
  console.log('  OK   Aggregazioni media, conteggio, massimo, distinti');

  // Mediana su un numero pari di valori: media dei due centrali.
  opt = costruisciOption(
    [{ k: 'x', v: 1 }, { k: 'x', v: 2 }, { k: 'x', v: 3 }, { k: 'x', v: 10 }],
    cfgBase({ campoX: 'k', serie: [{ ...cfgBase().serie[0], campoY: 'v', agg: 'mediana' }] }),
  );
  assert.deepStrictEqual(opt.series[0].data, [2.5], 'La mediana di [1,2,3,10] è 2,5');
  console.log('  OK   Mediana su un numero pari di valori');

  /* ------------------------------ Valori EJSON --------------------------- */

  const righeEjson = [
    { mese: 'gen', tot: { $numberDecimal: '10.5' } },
    { mese: 'gen', tot: { $numberLong: '4' } },
    { mese: 'feb', tot: { $numberDouble: '2.5' } },
  ];
  opt = costruisciOption(righeEjson, cfgBase({ campoX: 'mese', serie: [{ ...cfgBase().serie[0], campoY: 'tot' }] }));
  assert.deepStrictEqual(opt.series[0].data, [14.5, 2.5], 'Decimal, Long e Double devono sommarsi come numeri');
  console.log('  OK   Somma di valori EJSON (decimal, long, double)');

  /* ---------------------------- Asse temporale --------------------------- */

  const serieTempo = [
    { quando: { $date: 1700000000000 }, v: 3 },
    { quando: { $date: 1700086400000 }, v: 7 },
  ];
  opt = costruisciOption(serieTempo, cfgBase({
    campoX: 'quando',
    assex: { tipo: 'time', nome: '', rotazione: 0, griglia: false, inverti: false },
    serie: [{ ...cfgBase().serie[0], tipo: 'line', campoY: 'v' }],
  }));
  assert.strictEqual(opt.xAxis.type, 'time', 'Il tipo di asse "time" deve arrivare a ECharts');
  // Su un asse temporale il punto è una COPPIA [istante, valore]: con le sole y
  // i punti si distribuirebbero a indici interi, cioè il grafico mentirebbe
  // sulla spaziatura fra le date.
  assert.deepStrictEqual(opt.series[0].data, [[1700000000000, 3], [1700086400000, 7]], 'I punti su asse tempo devono essere coppie [ms, valore]');
  console.log('  OK   Asse temporale: punti come coppie [istante, valore]');

  /* --------------------- Ordinamento e coda in "Altro" ------------------- */

  opt = costruisciOption(vendite, cfgBase({ ordina: 'val-desc' }));
  assert.deepStrictEqual(opt.xAxis.data, ['Milano', 'Roma', 'Napoli'], 'Ordinamento per valore decrescente');
  opt = costruisciOption(vendite, cfgBase({ ordina: 'x-asc' }));
  assert.deepStrictEqual(opt.xAxis.data, ['Milano', 'Napoli', 'Roma'], 'Ordinamento alfabetico per categoria');

  opt = costruisciOption(vendite, cfgBase({ ordina: 'val-desc', maxCategorie: 2 }));
  assert.deepStrictEqual(opt.xAxis.data, ['Milano', 'Roma', 'Altro (1)'], 'La coda oltre il massimo si ripiega in "Altro"');
  assert.deepStrictEqual(opt.series[0].data, [20, 15, 1], 'Il valore di "Altro" è la somma della coda');
  console.log('  OK   Ordinamento e ripiegamento della coda in "Altro"');

  // CDB-A24 — controesempio: con un'aggregazione NON additiva la coda non si
  // somma. Sommare medie (o minimi, o conteggi di distinti) produce un numero
  // che nei dati non esiste, e in un grafico è tipicamente la barra più alta.
  const perMedia = [
    { citta: 'Milano', importo: 100 },
    { citta: 'Roma', importo: 90 },
    { citta: 'Napoli', importo: 10 },
    { citta: 'Bari', importo: 20 },
    { citta: 'Torino', importo: 30 },
  ];
  const cfgMedia = cfgBase({ ordina: 'val-desc', maxCategorie: 2 });
  cfgMedia.serie[0].agg = 'media';
  opt = costruisciOption(perMedia, cfgMedia);
  assert.deepStrictEqual(opt.xAxis.data, ['Milano', 'Roma', 'Altro (3)'], 'Anche con "media" la coda si ripiega in "Altro"');
  // Media dei residui: (10 + 20 + 30) / 3 = 20. La somma delle medie darebbe 60.
  assert.strictEqual(opt.series[0].data[2], 20, '"Altro" deve essere la media dei residui, non la somma delle medie');

  const cfgMin = cfgBase({ ordina: 'val-desc', maxCategorie: 2 });
  cfgMin.serie[0].agg = 'min';
  opt = costruisciOption(perMedia, cfgMin);
  assert.strictEqual(opt.series[0].data[2], 10, '"Altro" con "min" è il minimo dei residui, non la somma dei minimi');

  const cfgMediana = cfgBase({ ordina: 'val-desc', maxCategorie: 2 });
  cfgMediana.serie[0].agg = 'mediana';
  opt = costruisciOption(perMedia, cfgMediana);
  assert.strictEqual(opt.series[0].data[2], 20, '"Altro" con "mediana" è la mediana dei residui');
  console.log('  OK   "Altro" ricalcolato per le aggregazioni non additive (CDB-A24)');

  /* ----------------------- Regole di leggibilità ------------------------- */

  // Nessun doppio asse Y: due scale verticali sullo stesso riquadro fanno
  // leggere una correlazione che nei dati non c'è. Non è un'opzione nascosta,
  // non deve poter comparire.
  const dueSerie = cfgBase({
    serie: [
      { ...cfgBase().serie[0], id: 's1', slot: 0 },
      { ...cfgBase().serie[0], id: 's2', slot: 1, campoY: 'importo', agg: 'conteggio' },
    ],
  });
  opt = costruisciOption(vendite, dueSerie);
  assert.ok(!Array.isArray(opt.yAxis), 'L\'asse Y deve essere unico (mai un array di due assi)');
  assert.ok(opt.series.every((s) => s.yAxisIndex === undefined), 'Nessuna serie deve puntare a un secondo asse Y');
  console.log('  OK   Nessun doppio asse Y (né come asse, né come yAxisIndex)');

  // La legenda è il canale affidabile dell'identità da due serie in su; con una
  // sola ripeterebbe il titolo.
  assert.strictEqual(opt.legend.show, true, 'Con due serie la legenda deve esserci');
  assert.strictEqual(costruisciOption(vendite, cfgBase()).legend.show, false, 'Con una sola serie la legenda si nasconde');
  assert.strictEqual(costruisciOption(vendite, cfgBase({ legenda: { mostra: 'si', posizione: 'top', orient: 'horizontal' } })).legend.show, true, 'La legenda forzata deve comparire');
  console.log('  OK   Legenda automatica (assente con una serie, presente da due)');

  // Il colore segue la SERIE (il suo slot), non la posizione nell'elenco:
  // togliere la prima serie non deve ricolorare quelle che restano.
  const colorePrima = opt.series[1].itemStyle.color;
  const soloSeconda = costruisciOption(vendite, cfgBase({ serie: [dueSerie.serie[1]] }));
  assert.strictEqual(soloSeconda.series[0].itemStyle.color, colorePrima, 'Il colore deve restare legato alla serie, non alla sua posizione');
  console.log('  OK   Il colore segue la serie: rimuoverne una non ricolora le altre');

  // `colorBy: 'series'` evita che ECharts colori ogni barra di una serie sola
  // con un colore diverso — una rampa di colori su categorie senza ordine, che
  // raddoppia l'informazione già data dalla lunghezza della barra.
  assert.strictEqual(costruisciOption(vendite, cfgBase()).series[0].colorBy, 'series', 'Una serie sola = un solo colore per tutte le barre');
  console.log('  OK   Una serie sola usa un colore unico (colorBy: series)');

  // Specifiche dei segni: barra sottile con estremità arrotondata sul lato del
  // dato, linea da 2px, simboli mai sotto 8px.
  const bar = costruisciOption(vendite, cfgBase()).series[0];
  assert.strictEqual(bar.barMaxWidth, 24, 'La barra non deve riempire la fascia');
  assert.deepStrictEqual(bar.itemStyle.borderRadius, [4, 4, 0, 0], 'Estremità arrotondata sul dato, spigolo sulla base');
  const orizz = costruisciOption(vendite, cfgBase({ orizzontale: true })).series[0];
  assert.deepStrictEqual(orizz.itemStyle.borderRadius, [0, 4, 4, 0], 'A barre orizzontali l\'arrotondamento segue il verso del dato');
  const lineaOpt = costruisciOption(vendite, cfgBase({
    serie: [{ ...cfgBase().serie[0], tipo: 'line', dimSimbolo: 3, larghezzaLinea: 2 }],
  })).series[0];
  assert.strictEqual(lineaOpt.lineStyle.width, 2, 'Linea da 2px');
  assert.ok(lineaOpt.symbolSize >= 8, 'Un simbolo sotto 8px non si colpisce col mouse: va alzato');
  console.log('  OK   Specifiche dei segni (barra ≤24px, angoli 4px, linea 2px, simbolo ≥8px)');

  // A barre orizzontali gli assi si scambiano: le categorie vanno sulla Y.
  const scambiato = costruisciOption(vendite, cfgBase({ orizzontale: true }));
  assert.deepStrictEqual(scambiato.yAxis.data, ['Roma', 'Milano', 'Napoli'], 'Con barre orizzontali le categorie stanno sull\'asse Y');
  assert.strictEqual(scambiato.xAxis.data, undefined, 'Con barre orizzontali l\'asse X porta i valori');
  console.log('  OK   Barre orizzontali: assi scambiati');

  // Su una barra impilata il distacco fra i segmenti è un vuoto del colore del
  // fondo, non un contorno colorato.
  const impilata = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], stack: 'g' }] })).series[0];
  assert.strictEqual(impilata.stack, 'g', 'Lo stack deve arrivare a ECharts');
  assert.strictEqual(impilata.itemStyle.borderWidth, 2, 'Vuoto di 2px fra i segmenti impilati');
  console.log('  OK   Barre impilate: vuoto di 2px del colore del fondo');

  // L'area è una velatura, non un blocco saturo.
  const area = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], tipo: 'area', areaOpacita: 10 }] })).series[0];
  assert.ok(area.areaStyle && Math.abs(area.areaStyle.opacity - 0.1) < 1e-9, 'Il riempimento dell\'area sta al 10%');
  console.log('  OK   Area come velatura al 10%');

  /* ------------------------- Serie non visibili -------------------------- */

  opt = costruisciOption(vendite, cfgBase({
    serie: [{ ...cfgBase().serie[0], visibile: false }, { ...cfgBase().serie[0], id: 's2', slot: 1, agg: 'conteggio' }],
  }));
  assert.strictEqual(opt.series.length, 1, 'Una serie nascosta non deve essere disegnata');
  assert.deepStrictEqual(opt.series[0].data, [2, 1, 1], 'La serie rimasta conserva i propri dati');
  console.log('  OK   Le serie nascoste non vengono disegnate');

  /* ------------------------------- Torta -------------------------------- */

  opt = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], tipo: 'pie' }] }));
  assert.strictEqual(opt.series[0].type, 'pie');
  assert.deepStrictEqual(opt.series[0].data.map((d) => [d.name, d.value]), [['Roma', 15], ['Milano', 20], ['Napoli', 1]], 'La torta usa categorie e valori aggregati');
  assert.ok(!opt.xAxis && !opt.yAxis, 'Una torta non ha assi cartesiani');
  const ciambella = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], tipo: 'donut' }] }));
  assert.ok(Array.isArray(ciambella.series[0].radius), 'La ciambella ha un raggio interno e uno esterno');
  console.log('  OK   Torta e ciambella (categorie, valori, nessun asse)');

  /* ---------------------------- Mappa di calore -------------------------- */

  const traffico = [
    { giorno: 'lun', ora: '09', hit: 5 },
    { giorno: 'lun', ora: '09', hit: 3 },
    { giorno: 'lun', ora: '10', hit: 1 },
    { giorno: 'mar', ora: '09', hit: 4 },
  ];
  opt = costruisciOption(traffico, cfgBase({
    campoX: 'giorno',
    serie: [{ ...cfgBase().serie[0], tipo: 'heatmap', campoY: 'hit', campoY2: 'ora', agg: 'somma' }],
  }));
  assert.strictEqual(opt.series[0].type, 'heatmap');
  assert.deepStrictEqual(opt.xAxis.data, ['lun', 'mar']);
  assert.deepStrictEqual(opt.yAxis.data, ['09', '10']);
  assert.deepStrictEqual(opt.series[0].data, [[0, 0, 8], [0, 1, 1], [1, 0, 4]], 'Le celle sono [indiceX, indiceY, valore aggregato]');
  // Il colore qui è una GRANDEZZA: un solo tono, chiaro→scuro. Un arcobaleno
  // inventerebbe soglie che nei dati non esistono.
  assert.ok(opt.visualMap && opt.visualMap.inRange.color.length > 2, 'La mappa di calore usa una rampa sequenziale');
  const rampa = opt.visualMap.inRange.color;
  assert.strictEqual(new Set(rampa).size, rampa.length, 'La rampa non deve avere passi ripetuti');
  // La scala di colore sta a destra e il riquadro le fa spazio: in orizzontale
  // sotto il grafico le sue etichette finivano sulla banda delle etichette
  // dell'asse X e si leggevano come categorie.
  assert.strictEqual(opt.visualMap.orient, 'vertical', 'La scala di colore è verticale, a lato');
  assert.ok(opt.visualMap.bottom === undefined, 'La scala di colore non deve stare sotto l\'asse X');
  assert.ok(opt.grid.right >= 76, 'Il riquadro deve lasciare spazio alla scala di colore');
  console.log('  OK   Mappa di calore (incrocio di due categorie + rampa sequenziale)');

  // Senza il secondo campo categoria la mappa di calore non è definibile: lo
  // dice, invece di disegnare un riquadro vuoto.
  const senzaY2 = costruisciOption(traffico, cfgBase({
    campoX: 'giorno',
    serie: [{ ...cfgBase().serie[0], tipo: 'heatmap', campoY: 'hit', campoY2: null }],
  }));
  assert.ok(senzaY2.graphic && /seconda categoria/i.test(senzaY2.graphic.style.text), 'Serve un messaggio esplicito, non un grafico vuoto');
  console.log('  OK   Mappa di calore senza secondo campo: messaggio esplicito');

  // CDB-A27 — controesempio: due colonne ad alta cardinalità. Era l'unica forma
  // di grafico senza tetto, quindi senza avviso e senza limite al disegno.
  const tanteCoppie = [];
  for (let i = 0; i < 300; i++) tanteCoppie.push({ a: 'a' + i, b: 'b' + i, v: i });
  azzeraAvvisi();
  opt = costruisciOption(tanteCoppie, cfgBase({
    campoX: 'a',
    serie: [{ ...cfgBase().serie[0], tipo: 'heatmap', campoY: 'v', campoY2: 'b', agg: 'somma' }],
  }));
  assert.ok(opt.xAxis.data.length <= 60, 'La mappa di calore deve avere un tetto di categorie sull\'asse X');
  assert.ok(opt.yAxis.data.length <= 60, 'La mappa di calore deve avere un tetto di categorie sull\'asse Y');
  assert.ok(prendiAvvisi().some((a) => /Mappa di calore limitata/i.test(a)), 'Il troncamento va DICHIARATO, non fatto in silenzio');
  console.log('  OK   Mappa di calore: tetto di cardinalità dichiarato (CDB-A27)');

  // CDB-A26 — "Primo valore" su valori EJSON: senza conversione la serie non
  // veniva disegnata male, spariva.
  const decimali = [
    { citta: 'Roma', importo: { $numberDecimal: '12.50' } },
    { citta: 'Milano', importo: { $numberDecimal: '7.25' } },
  ];
  const cfgPrimo = cfgBase();
  cfgPrimo.serie[0].agg = 'primo';
  opt = costruisciOption(decimali, cfgPrimo);
  assert.deepStrictEqual(opt.series[0].data, [12.5, 7.25], '"Primo valore" deve arrivare a ECharts come numero, non come EJSON');
  console.log('  OK   "Primo valore" convertito in numero (CDB-A26)');

  // CDB-A36 — l'avviso prometteva l'etichetta sul solo massimo e non ne mostrava
  // nessuna: o si attua o non si annuncia.
  const moltiPunti = [];
  for (let i = 0; i < 50; i++) moltiPunti.push({ citta: 'c' + i, importo: i });
  const cfgEtich = cfgBase();
  cfgEtich.serie[0].etichette = true;
  opt = costruisciOption(moltiPunti, cfgEtich);
  const lab = opt.series[0].label;
  assert.strictEqual(lab.show, true, 'Con molti punti le etichette restano attive, ma solo sul massimo');
  assert.ok(lab.formatter({ value: 49 }), 'Il massimo deve avere la sua etichetta');
  assert.strictEqual(lab.formatter({ value: 3 }), '', 'Gli altri punti non devono avere etichetta');
  console.log('  OK   Etichette sul solo valore massimo, come annunciato (CDB-A36)');

  /* -------------------------------- Radar -------------------------------- */

  opt = costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], tipo: 'radar' }] }));
  assert.strictEqual(opt.series[0].type, 'radar');
  assert.deepStrictEqual(opt.radar.indicator.map((i) => i.name), ['Roma', 'Milano', 'Napoli']);
  assert.deepStrictEqual(opt.series[0].data[0].value, [15, 20, 1]);
  console.log('  OK   Radar (indicatori dalle categorie)');

  /* --------------------- Senza aggregazione: una riga = un punto --------- */

  opt = costruisciOption(vendite, cfgBase({ aggrega: false }));
  assert.deepStrictEqual(opt.xAxis.data, ['Roma', 'Roma', 'Milano', 'Napoli'], 'Senza aggregazione ogni riga è un punto');
  assert.deepStrictEqual(opt.series[0].data, [10, 5, 20, 1], 'I valori restano quelli delle righe');
  console.log('  OK   Modalità senza aggregazione (query che ha già fatto il GROUP BY)');

  /* ------------- Andamento nel tempo SENZA aggregazione ------------------ */

  /*
   * Il caso che l'aggregazione non copre: "voglio vedere questa misura nel
   * tempo, così com'è". Due misurazioni dello stesso istante devono restare due
   * punti — sommarle o farne la media risponde a un'altra domanda, e lo fa senza
   * dirlo. Qui si verificano le tre proprietà che rendono la modalità onesta:
   * i valori non si fondono, l'ordine è quello del TEMPO e non quello di arrivo,
   * e le righe senza data valida vengono dichiarate invece che sparire.
   */
  const misure = [
    { t: { $date: 300 }, v: 9 },
    { t: { $date: 100 }, v: 3 },
    { t: { $date: 100 }, v: 5 },   // stesso istante: due punti, non uno
    { t: null, v: 42 },            // senza data: non disegnabile su un asse tempo
  ];
  const cfgTempoGrezzo = cfgBase({
    campoX: 't',
    aggrega: false,
    assex: { tipo: 'time', nome: '', rotazione: 0, griglia: false, inverti: false },
    serie: [{ ...cfgBase().serie[0], tipo: 'line', campoY: 'v', agg: 'primo' }],
  });

  azzeraAvvisi();
  opt = costruisciOption(misure, cfgTempoGrezzo);
  assert.deepStrictEqual(
    opt.series[0].data,
    [[100, 3], [100, 5], [300, 9]],
    'Senza aggregazione i valori dello stesso istante restano punti distinti, ordinati per tempo',
  );
  const note = prendiAvvisi();
  assert.ok(note.some((n) => /senza un valore valido/i.test(n)), 'Le righe senza data valida vanno dichiarate, non scartate in silenzio');
  console.log('  OK   Misura grezza nel tempo: nessuna fusione, ordine temporale, righe senza data dichiarate');

  // L'ordinamento per tempo è un default, non un'imposizione: una scelta
  // esplicita dell'utente vince.
  azzeraAvvisi();
  opt = costruisciOption(misure, { ...cfgTempoGrezzo, ordina: 'x-desc' });
  assert.deepStrictEqual(opt.series[0].data.map((p) => p[0]), [300, 100, 100], 'Un ordinamento scelto a mano vince sul default temporale');

  // Su un asse temporale l'ordine di arrivo non è l'ordine del tempo: vale
  // anche quando si aggrega, perché una linea si disegna nell'ordine dei dati.
  azzeraAvvisi();
  opt = costruisciOption(misure, {
    ...cfgTempoGrezzo,
    aggrega: true,
    serie: [{ ...cfgTempoGrezzo.serie[0], agg: 'somma' }],
  });
  assert.deepStrictEqual(opt.series[0].data, [[100, 8], [300, 9]], 'Aggregando, gli istanti uguali collassano e restano in ordine di tempo');
  console.log('  OK   Asse temporale ordinato per tempo (default), scelta manuale rispettata');

  // Punti grezzi: la coda oltre "Max categorie" NON si somma in "Altro" —
  // sommare valori grezzi inventa un numero che nei dati non esiste.
  azzeraAvvisi();
  opt = costruisciOption(vendite, cfgBase({ aggrega: false, maxCategorie: 2 }));
  assert.deepStrictEqual(opt.xAxis.data, ['Roma', 'Roma'], 'Senza aggregazione si mostrano i primi N punti');
  assert.deepStrictEqual(opt.series[0].data, [10, 5], 'Nessun valore sintetico "Altro" fra i punti grezzi');
  assert.ok(prendiAvvisi().some((n) => /primi 2 punti/i.test(n)), 'Va detto quanti punti restano fuori');
  console.log('  OK   Punti grezzi: la coda si tronca dichiarandolo, non si somma in "Altro"');

  /*
   * Asse temporale su un campo che NON contiene date. È il caso che capita da
   * solo: l'asse viene dedotto da `createdAt`, poi si cambia il campo X con una
   * colonna di testo. Un asse temporale lì non dà un grafico impreciso, ne dà
   * uno VUOTO — ogni punto viene scartato. Va disegnato quello che si può
   * disegnare, dicendo cosa è stato fatto.
   */
  azzeraAvvisi();
  opt = costruisciOption(vendite, cfgBase({
    campoX: 'citta',
    aggrega: false,
    assex: { tipo: 'time', nome: '', rotazione: 0, griglia: false, inverti: false },
    serie: [{ ...cfgBase().serie[0], tipo: 'line', campoY: 'importo' }],
  }));
  assert.strictEqual(opt.xAxis.type, 'category', 'Un asse "tempo" su un campo senza date ricade su categorie');
  assert.deepStrictEqual(opt.series[0].data, [10, 5, 20, 1], 'Nessun punto deve essere scartato: il grafico non deve restare vuoto');
  assert.ok(prendiAvvisi().some((n) => /non contiene date/i.test(n)), 'Va detto che l\'asse è stato reinterpretato');
  console.log('  OK   Asse temporale su campo non temporale: ricade su categorie invece di svuotare il grafico');

  // Il ripiego vale solo quando NON c'è alcuna data: un campo temporale con
  // qualche riga guasta resta temporale, e le righe guaste si dichiarano.
  azzeraAvvisi();
  opt = costruisciOption(misure, cfgTempoGrezzo);
  assert.strictEqual(opt.xAxis.type, 'time', 'Con almeno un istante valido l\'asse resta temporale');
  azzeraAvvisi();

  // Senza un campo misura la modalità grezza non ha niente da tracciare: lo
  // dice, invece di disegnare una serie di buchi.
  azzeraAvvisi();
  costruisciOption(misure, { ...cfgTempoGrezzo, serie: [{ ...cfgTempoGrezzo.serie[0], campoY: null }] });
  assert.ok(prendiAvvisi().some((n) => /campo misura/i.test(n)), 'Senza misura va detto che manca il campo da tracciare');
  azzeraAvvisi();

  /* ------------------------------ Valori nulli --------------------------- */

  const conNulli = [{ k: 'a', v: 5 }, { k: 'b', v: null }, { k: 'c' }, { k: 'd', v: 'non un numero' }];
  opt = costruisciOption(conNulli, cfgBase({ campoX: 'k', serie: [{ ...cfgBase().serie[0], campoY: 'v', agg: 'max' }] }));
  assert.deepStrictEqual(opt.series[0].data, [5, null, null, null], 'Un valore non numerico diventa un buco, non uno zero');
  console.log('  OK   Valori nulli/non numerici: buchi nella serie, non zeri inventati');

  // Una categoria assente non deve diventare la stringa "undefined".
  opt = costruisciOption([{ v: 1 }], cfgBase({ campoX: 'manca', serie: [{ ...cfgBase().serie[0], campoY: 'v' }] }));
  assert.deepStrictEqual(opt.xAxis.data, ['(vuoto)'], 'Una categoria assente si etichetta "(vuoto)"');
  console.log('  OK   Categoria assente etichettata "(vuoto)"');

  // …e nemmeno una categoria NUMERICA. `ejsonKind` risponde "number" sia per il
  // wrapper EJSON sia per un numero nudo: il ramo che legge `Object.values(v)[0]`
  // trasformava ogni etichetta in "undefined", con le barre però giuste — cioè
  // un grafico che sembra disegnato bene ed è illeggibile.
  opt = costruisciOption(
    [{ n: 1, v: 10 }, { n: 2, v: 20 }, { n: 3, v: 30 }],
    cfgBase({ campoX: 'n', aggrega: false, serie: [{ ...cfgBase().serie[0], campoY: 'v', agg: 'primo' }] }),
  );
  assert.deepStrictEqual(opt.xAxis.data, ['1', '2', '3'], 'Un asse su una colonna numerica mostra i numeri, non "undefined"');
  opt = costruisciOption([{ b: true, v: 1 }], cfgBase({ campoX: 'b', serie: [{ ...cfgBase().serie[0], campoY: 'v' }] }));
  assert.deepStrictEqual(opt.xAxis.data, ['true'], 'Anche un booleano è una categoria leggibile');
  console.log('  OK   Categoria numerica/booleana etichettata col suo valore');

  /* --------------------------- Titolo e tooltip -------------------------- */

  opt = costruisciOption(vendite, cfgBase({ titolo: 'Vendite', sottotitolo: 'per città' }));
  assert.strictEqual(opt.title.text, 'Vendite');
  assert.strictEqual(opt.title.subtext, 'per città');
  assert.strictEqual(costruisciOption(vendite, cfgBase()).title.show, false, 'Senza titolo il blocco non occupa spazio');

  assert.strictEqual(costruisciOption(vendite, cfgBase()).tooltip.trigger, 'axis', 'Su un cartesiano il tooltip si attiva sull\'asse (mirino)');
  assert.strictEqual(costruisciOption(vendite, cfgBase({ serie: [{ ...cfgBase().serie[0], tipo: 'pie' }] })).tooltip.trigger, 'item', 'Su una torta il tooltip si attiva sul segno');
  assert.strictEqual(costruisciOption(vendite, cfgBase({ tooltip: { mostra: false, trigger: 'auto' } })).tooltip.show, false);
  console.log('  OK   Titolo e attivazione del tooltip per famiglia di grafico');

  /* ------------------------------- Zoom e log ---------------------------- */

  opt = costruisciOption(vendite, cfgBase({ zoom: true }));
  assert.ok(Array.isArray(opt.dataZoom) && opt.dataZoom.length === 2, 'Lo zoom aggiunge slider e rotella');
  assert.ok(opt.grid.bottom >= 62, 'Con lo slider il margine inferiore deve fargli spazio');

  opt = costruisciOption(vendite, cfgBase({ assey: { ...cfgBase().assey, log: true } }));
  assert.strictEqual(opt.yAxis.type, 'log', 'La scala logaritmica deve arrivare a ECharts');

  opt = costruisciOption(vendite, cfgBase({ assey: { ...cfgBase().assey, min: 0, max: 50 } }));
  assert.strictEqual(opt.yAxis.min, 0, 'Il minimo dell\'asse deve essere rispettato (0 non è "vuoto")');
  assert.strictEqual(opt.yAxis.max, 50);
  console.log('  OK   Zoom, scala logaritmica, min/max dell\'asse (0 incluso)');

  /* ------------------------ Griglia e cromatura -------------------------- */

  opt = costruisciOption(vendite, cfgBase());
  assert.strictEqual(opt.yAxis.splitLine.lineStyle.type, 'solid', 'La griglia è solida: tratteggiata compete col dato');
  assert.strictEqual(opt.xAxis.splitLine.show, false, 'La griglia verticale è spenta per default');
  assert.strictEqual(opt.backgroundColor, 'transparent', 'Il fondo lo dà il tema dell\'applicazione');
  // Il testo non porta il colore del dato: un giallo leggibile come
  // riempimento è illeggibile come testo.
  const coloriSerie = new Set(opt.series.map((s) => s.itemStyle.color));
  assert.ok(!coloriSerie.has(opt.yAxis.axisLabel.color), 'Le etichette degli assi usano un token di testo, non un colore di serie');
  assert.ok(!coloriSerie.has(opt.legend.textStyle?.color), 'La legenda usa un token di testo, non un colore di serie');
  console.log('  OK   Cromatura: griglia solida e recessiva, testo con token di testo');

  /* ------------------------- Formato dei numeri -------------------------- */

  const fmt = costruisciOption(vendite, cfgBase()).yAxis.axisLabel.formatter;
  assert.strictEqual(typeof fmt, 'function', 'L\'asse valori deve avere un formattatore');
  assert.strictEqual(fmt(1234.5), (1234.5).toLocaleString('it-IT', { maximumFractionDigits: 2 }));
  const fmtPct = costruisciOption(vendite, cfgBase({ assey: { ...cfgBase().assey, formato: 'percento' } })).yAxis.axisLabel.formatter;
  assert.ok(fmtPct(12.34).endsWith('%'), 'Il formato percentuale aggiunge il segno');
  console.log('  OK   Formattatori dell\'asse valori');

  /* ------------------- Adattamento allo spazio disponibile --------------- */

  // I margini sono in pixel assoluti: in un pannello basso un margine da 56+52
  // lascia al disegno meno della metà dell'altezza. Vanno limitati, altrimenti
  // il grafico sparisce fra le sue cornici.
  const basso = costruisciOption(vendite, cfgBase({ zoom: true }), { larghezza: 800, altezza: 150 });
  assert.ok(basso.grid.top <= Math.round(150 * 0.22), 'Margine superiore limitato a una frazione dell\'altezza');
  assert.ok(basso.grid.bottom <= Math.round(150 * 0.28) + 30, 'Margine inferiore limitato a una frazione dell\'altezza');
  assert.ok(basso.grid.top + basso.grid.bottom < 150 * 0.7, 'Al disegno deve restare la maggior parte dell\'altezza');
  console.log('  OK   Margini limitati allo spazio reale del riquadro');

  // Lo slider dello zoom sotto una certa altezza NON si disegna: occuperebbe un
  // ottavo del grafico per fare quello che fa la rotella. Prima veniva disegnato
  // comunque e, in un pannello da 227px, finiva fuori dalla finestra.
  const tipiZoom = (o) => (o.dataZoom || []).map((z) => z.type);
  assert.deepStrictEqual(tipiZoom(basso), ['inside'], 'In un riquadro basso resta solo lo zoom con la rotella');
  assert.ok(prendiAvvisi().some((n) => /rotella/i.test(n)), 'Va detto perché la barra di zoom non c\'è');
  azzeraAvvisi();
  const alto = costruisciOption(vendite, cfgBase({ zoom: true }), { larghezza: 800, altezza: 420 });
  assert.deepStrictEqual(tipiZoom(alto), ['inside', 'slider'], 'Con spazio la barra di zoom c\'è');
  assert.ok(alto.grid.bottom > costruisciOption(vendite, cfgBase(), { larghezza: 800, altezza: 420 }).grid.bottom,
    'La barra di zoom deve avere spazio riservato, non sovrapporsi alle etichette dell\'asse');
  assert.deepStrictEqual(tipiZoom(costruisciOption(vendite, cfgBase(), { larghezza: 800, altezza: 420 })), [], 'Senza zoom nessun dataZoom');
  console.log('  OK   Barra di zoom solo dove c\'è spazio, con margine riservato');

  /* --------------------------- Grafici suggeriti ------------------------- */

  // Cardinalità: serve a NON proporre un identificativo come asse (400 valori
  // distinti = 400 barre) e a preferire la colonna con poche categorie.
  const campiVendite = campiDisponibili(vendite);
  assert.strictEqual(campiVendite.find((f) => f.nome === 'citta').distinti, 3, 'La cardinalità sul campione va riportata');

  const sugg = suggerimenti(campiDisponibili([
    { regione: 'Lazio', canale: 'web', creato: { $date: 1700000000000 }, importo: 10, quantita: 2 },
    { regione: 'Lombardia', canale: 'negozio', creato: { $date: 1700086400000 }, importo: 20, quantita: 1 },
  ]));
  assert.ok(sugg.length >= 3, 'Con data, categorie e numeri le proposte devono esserci');
  assert.ok(sugg.every((s) => s.id && s.etichetta && s.patch), 'Ogni proposta ha id, etichetta e modifica');
  const tempo = sugg.find((s) => s.id === 'tempo-somma');
  assert.ok(tempo, 'Con un campo data va proposto un andamento nel tempo');
  assert.strictEqual(tempo.patch.assex.tipo, 'time', 'L\'andamento nel tempo usa un asse temporale');
  assert.strictEqual(tempo.patch.serie[0].tipo, 'line');
  assert.strictEqual(tempo.patch.autoX, false, 'Una proposta è una scelta esplicita: non va rimpiazzata');
  // La proposta "valori grezzi" è la strada da un clic per vedere una misura nel
  // tempo senza che nulla venga fuso: deve spegnere il raggruppamento.
  const grezzo = sugg.find((s) => s.id === 'tempo-grezzo');
  assert.ok(grezzo, 'Con data e numero va proposto anche l\'andamento a valori grezzi');
  assert.strictEqual(grezzo.patch.aggrega, false, 'La proposta a valori grezzi non deve raggruppare');
  assert.strictEqual(grezzo.patch.assex.tipo, 'time');
  const disp = sugg.find((s) => s.id === 'dispersione');
  assert.ok(disp, 'Con due numeri va proposta una dispersione');
  assert.strictEqual(disp.patch.aggrega, false, 'Una dispersione confronta i valori riga per riga: niente raggruppamento');

  // La proposta deve produrre un grafico VALIDO, non solo una configurazione
  // plausibile: si applica e si costruisce l'option.
  for (const s of sugg) {
    const conf = cfgBase();
    for (const [k, v] of Object.entries(s.patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && conf[k] && typeof conf[k] === 'object') Object.assign(conf[k], v);
      else conf[k] = v;
    }
    const o = costruisciOption([
      { regione: 'Lazio', canale: 'web', creato: { $date: 1700000000000 }, importo: 10, quantita: 2 },
      { regione: 'Lombardia', canale: 'negozio', creato: { $date: 1700086400000 }, importo: 20, quantita: 1 },
    ], conf, { larghezza: 800, altezza: 400 });
    assert.ok(o.series && o.series.length, `La proposta "${s.id}" deve produrre almeno una serie`);
    assert.ok(o.series[0].data && o.series[0].data.length, `La proposta "${s.id}" deve produrre dei dati`);
  }
  console.log('  OK   Grafici suggeriti: dedotti dai tipi dei campi e tutti disegnabili');

  // Un campo quasi tutto distinto (un identificativo) non è una categoria da
  // proporre: come asse produrrebbe una barra per riga.
  const righeId = Array.from({ length: 40 }, (_, i) => ({ codice: `X${i}`, importo: i }));
  const suggId = suggerimenti(campiDisponibili(righeId));
  assert.ok(!suggId.some((s) => s.patch.campoX === 'codice'), 'Un campo ad alta cardinalità non va proposto come categoria');
  console.log('  OK   Gli identificativi non vengono proposti come categoria');

  /* -------------------------- Result set vuoto --------------------------- */

  opt = costruisciOption([], cfgBase());
  assert.deepStrictEqual(opt.series[0].data, [], 'Un result set vuoto produce una serie vuota, non un errore');
  console.log('  OK   Result set vuoto gestito senza errori');

  console.log('Tutti i test unitari di Custom Charts superati con successo!');
})();
