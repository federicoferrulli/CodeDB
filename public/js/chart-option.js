'use strict';

/* ---------------------------------------------------------------------------
 * Strato PURO della vista Grafici: dai risultati di una query all'`option` di
 * ECharts. Nessun DOM, nessun socket, nessuna istanza di grafico — solo dati in
 * ingresso e configurazione in uscita.
 *
 * Sta separato da `charts.js` (che è l'interfaccia: canvas, pannello, eventi)
 * per due ragioni concrete:
 *
 *  - È la parte che, sbagliata, MENTE. Un'aggregazione errata non produce un
 *    grafico rotto ma un grafico plausibile e falso, e nessuno se ne accorge. Qui
 *    è provabile in Node senza browser (`test/unit-charts.js`, incluso in
 *    `npm test`); dentro il modulo dell'interfaccia non lo sarebbe, perché
 *    `utils.js` fa parte di un ciclo di import che carica l'intera applicazione.
 *  - Le regole di leggibilità (una tavolozza in ordine fisso, nessun secondo
 *    asse Y, la legenda che compare da due serie in su) diventano così proprietà
 *    verificate da un test, non promesse in un commento.
 *
 * Le note per l'utente (es. "la coda è stata sommata in Altro") non vengono
 * stampate da qui: si accumulano in un vettore che il chiamante svuota, così
 * questo modulo non ha bisogno di sapere che esiste un'interfaccia.
 * ------------------------------------------------------------------------- */

import { ejsonKind, fmtBytes, safeUUID } from './valori.js';
import { aggregaNumeriEsatti } from './valori-esatti.js';

/*
 * Note maturate durante l'ultima costruzione. Il chiamante fa
 * `azzeraAvvisi()` prima e `prendiAvvisi()` dopo: passarle come parametro
 * attraverso otto funzioni interne renderebbe illeggibile ogni firma per un
 * effetto che riguarda solo la presentazione.
 */
let avvisi = [];

export function azzeraAvvisi() { avvisi = []; }
export function prendiAvvisi() { return Array.from(new Set(avvisi)); }
/* Le note prodotte altrove (nel Web Worker, dove il precalcolo gira su un
   altro thread) tornano qui: la deduplica di `prendiAvvisi` fa il resto. */
export function aggiungiAvvisi(lista) { if (Array.isArray(lista)) avvisi.push(...lista); }

/* ============================== Tavolozze ================================ */

/*
 * Otto colori categorici in ordine fisso, verificati con lo script di
 * validazione della palette sul fondo #161b22 (--bg-surface):
 *   banda di luminosità OK · chroma OK · peggior coppia adiacente ΔE 8.4
 *   (protanopia) · ΔE 19.3 a visione normale · contrasto ≥ 3:1 tutti.
 * I primi TRE superano anche il controllo su tutte le coppie, che è quello che
 * conta per i grafici a dispersione e per le torte (dove ogni colore confina
 * con ogni altro): oltre la terza categoria in quelle forme meglio ripiegare la
 * coda in "Altro" o dividere in più grafici.
 */
export const CATEGORICA = [
  '#3987e5', // 1 blu
  '#d95926', // 2 arancio
  '#199e70', // 3 acqua
  '#c98500', // 4 giallo
  '#d55181', // 5 magenta
  '#008300', // 6 verde
  '#9085e9', // 7 viola
  '#e66767', // 8 rosso
];

// Rampa sequenziale a UN SOLO tono (blu, chiaro→scuro): è la scelta giusta
// quando il colore rappresenta una GRANDEZZA e non un'identità. Un arcobaleno
// qui si legge male e inventa soglie che nei dati non esistono.
const SEQUENZIALE_BLU = [
  '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b',
];

// Divergente blu↔rosso con grigio neutro al centro: due toni che si leggono
// come opposti, e un centro che si legge come "niente".
const DIVERGENTE = ['#0d366b', '#256abf', '#6da7ec', '#383835', '#e66767', '#d03b3b', '#8f1f1f'];

export const TAVOLOZZE = {
  categorica: { etichetta: 'Categorica (8 colori, identità)', colori: CATEGORICA },
  sequenziale: { etichetta: 'Sequenziale blu (grandezza)', colori: SEQUENZIALE_BLU },
  divergente: { etichetta: 'Divergente blu↔rosso (polarità)', colori: DIVERGENTE },
};

/*
 * Cromatura del grafico: sempre token di testo/superficie, mai colori di serie.
 *
 * I valori qui sono quelli del tema SCURO, che è il default e ciò che questo
 * modulo deve produrre quando gira in Node (i test non hanno un documento da
 * cui leggere). A finestra aperta li sovrascrive `applicaInk()`, chiamata da
 * `charts.js` con i token veri del tema in vigore: un canvas non eredita nulla
 * dal CSS, quindi sul tema chiaro le etichette resterebbero grigio chiaro su
 * bianco — non un grafico brutto, un grafico ILLEGGIBILE.
 *
 * La tavolozza CATEGORICA invece NON segue il tema, ed è deliberato: quei
 * colori sono verificati uno per uno per la visione con deficit dei colori e
 * hanno un ordine fisso, mentre i token del tema li sceglie l'utente. Un
 * grafico deve restare leggibile anche sopra un tema fatto in casa.
 */
export const INK = {
  fondo: '#161b22',      // --bg-surface
  primario: '#e2e8f0',   // --fg
  secondario: '#8892a4', // --fg-dim
  muto: '#8892a4',
  griglia: 'rgba(255, 255, 255, 0.07)',
  asse: 'rgba(255, 255, 255, 0.18)',
  // Riquadro del tooltip: è una superficie sollevata sopra il grafico.
  tooltipFondo: '#1f2937',
  tooltipBordo: 'rgba(255,255,255,0.12)',
  // Etichetta scritta DENTRO un segmento colorato (imbuto, torta): il suo
  // fondo è un colore di serie, non del tema.
  suColore: '#ffffff',
  // Barra dello zoom.
  zoomFondo: 'rgba(255,255,255,0.04)',
  zoomArea: 'rgba(255,255,255,0.06)',
  zoomSelezione: 'rgba(99,102,241,0.18)',
  zoomManiglia: '#6366f1',
};

/**
 * Sostituisce la cromatura con quella del tema in vigore. Accetta solo le
 * chiavi note e solo valori non vuoti: un token assente (tema personalizzato
 * che non lo ridefinisce, `getComputedStyle` che torna stringa vuota) deve
 * lasciare il valore precedente, non azzerarlo — un `color: ''` in ECharts non
 * dà errore, disegna nero su nero.
 */
export function applicaInk(valori) {
  if (!valori) return;
  for (const chiave of Object.keys(INK)) {
    const v = valori[chiave];
    if (typeof v === 'string' && v.trim()) INK[chiave] = v.trim();
  }
}

/* ============================ Modello di configurazione =================== */

/*
 * La configurazione vive nello STATO DEL TAB di connessione (`state.chartCfg`,
 * vedi freshState in tabs.js), non in una variabile di modulo: due tab aperti su
 * due connessioni diverse hanno due grafici diversi, e passando da uno all'altro
 * ognuno ritrova il suo. È la stessa ragione per cui `state.queryDb` è finito lì.
 */

export const TIPI = [
  { v: 'line', et: 'Linea', fam: 'cartesiano' },
  { v: 'area', et: 'Area', fam: 'cartesiano' },
  { v: 'bar', et: 'Barre', fam: 'cartesiano' },
  { v: 'scatter', et: 'Dispersione', fam: 'cartesiano' },
  { v: 'pie', et: 'Torta', fam: 'circolare' },
  { v: 'donut', et: 'Ciambella', fam: 'circolare' },
  { v: 'funnel', et: 'Imbuto', fam: 'circolare' },
  { v: 'radar', et: 'Radar', fam: 'radar' },
  { v: 'heatmap', et: 'Mappa di calore', fam: 'heatmap' },
];

/*
 * Valore speciale del menu "Calcolo" che significa NESSUN calcolo: una riga = un
 * punto, il valore della misura così com'è. Non è un'aggregazione (non sta in
 * AGGREGAZIONI): scriverlo nella serie sarebbe sbagliato, perché la scelta è
 * globale — o si raggruppa tutto o non si raggruppa niente — e vive in
 * `cfg.aggrega`. Sta qui e non in charts.js perché è il *contratto* fra il menu
 * e il modello: chi legge la configurazione deve poterlo riconoscere.
 */
export const AGG_GREZZO = '__grezzo__';

export const AGGREGAZIONI = [
  { v: 'somma', et: 'Somma' },
  { v: 'media', et: 'Media' },
  { v: 'conteggio', et: 'Conteggio righe' },
  { v: 'distinti', et: 'Conteggio distinti' },
  { v: 'min', et: 'Minimo' },
  { v: 'max', et: 'Massimo' },
  { v: 'mediana', et: 'Mediana' },
  { v: 'primo', et: 'Primo valore' },
];

export function famigliaDi(tipo) {
  const t = TIPI.find((x) => x.v === tipo);
  return t ? t.fam : 'cartesiano';
}

export function serieDefault(indice = 0) {
  return {
    id: safeUUID(),
    nome: '',
    tipo: 'bar',
    campoY: null,
    campoY2: null,       // solo mappa di calore: la seconda categoria (asse Y)
    agg: 'somma',
    colore: '',          // '' = slot della tavolozza (vedi 2. in testa al file)
    slot: indice % CATEGORICA.length,
    visibile: true,
    stack: '',
    smooth: false,
    areaOpacita: 10,     // % — una velatura, non un blocco saturo
    larghezzaLinea: 2,
    simbolo: 'circle',
    dimSimbolo: 8,       // mai sotto 8px: sotto non si colpisce col mouse
    barMax: 24,          // barra sottile: la fascia non va riempita
    etichette: false,
    posEtichette: 'top',
    opacita: 100,
    // false = il campo valore è stato scelto dall'utente e non va più
    // rimpiazzato automaticamente (vedi autoConfigura in charts.js).
    autoY: true,
  };
}

export function cfgDefault() {
  return {
    titolo: '',
    sottotitolo: '',
    campoX: null,
    autoX: true,         // false = asse X scelto dall'utente, da non rimpiazzare
    aggrega: true,
    ordina: 'nessuno',
    maxCategorie: 0,     // 0 = tutte
    serie: [serieDefault(0)],
    // `auto`: il tipo dell'asse X è stato dedotto dal campo, non scelto a mano —
    // quindi cambiando campo va ridedotto. Diventa false quando l'utente sceglie
    // il tipo dal pannello, e da lì in poi resta la sua scelta.
    assex: { tipo: 'category', auto: true, nome: '', rotazione: 0, griglia: false, inverti: false },
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
  };
}

/** Valore di un campo, con supporto per i percorsi annidati `a.b.c`. */
function estrai(riga, campo) {
  if (!riga || !campo) return undefined;
  if (Object.prototype.hasOwnProperty.call(riga, campo)) return riga[campo];
  if (campo.indexOf('.') === -1) return undefined;
  let cur = riga;
  for (const parte of campo.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[parte];
  }
  return cur;
}

/**
 * Numero da un valore EJSON. Le righe arrivano dal server serializzate in
 * Extended JSON (vedi la convenzione in CLAUDE.md): un DECIMAL di MySQL o un
 * NumberLong di MongoDB non sono `typeof number`, e senza questa conversione un
 * grafico su una colonna di importi risulterebbe vuoto senza spiegazione.
 */
function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const kind = ejsonKind(v);
  if (kind === 'number') return numero(Object.values(v)[0]);
  if (kind === 'decimal') return numero(v.$numberDecimal);
  if (kind === 'date') return numero(v.$date);
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Millisecondi da un valore che rappresenta un istante, oppure null. */
function istante(v) {
  if (v === null || v === undefined) return null;
  const kind = ejsonKind(v);
  if (kind === 'date') {
    const d = v.$date;
    if (typeof d === 'number') return d;
    if (typeof d === 'string') { const t = Date.parse(d); return Number.isFinite(t) ? t : null; }
    if (d && d.$numberLong) return Number(d.$numberLong);
    return null;
  }
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** Etichetta di categoria: leggibile, stabile e mai `[object Object]`. */
function categoria(v) {
  if (v === null || v === undefined) return '(vuoto)';
  // I PRIMITIVI prima di tutto: `ejsonKind` risponde `number` sia per il
  // wrapper `{$numberLong:…}` sia per un numero JavaScript nudo, e il ramo qui
  // sotto fa `Object.values(v)[0]` — che su un numero vero è `undefined`. Un
  // asse X su una colonna numerica (o sull'ordinale di riga del grafico della
  // selezione) mostrava così una fila di etichette "undefined", mentre le barre
  // erano giuste: il grafico sembrava disegnato bene e illeggibile.
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const kind = ejsonKind(v);
  if (kind === 'oid') return v.$oid;
  if (kind === 'date') {
    const ms = istante(v);
    return ms === null ? '(data non valida)' : new Date(ms).toLocaleString('it-IT');
  }
  if (kind === 'number') return String(Object.values(v)[0]);
  if (kind === 'decimal') return String(v.$numberDecimal);
  if (typeof v === 'object') return JSON.stringify(v);
  if (v === '') return '(vuoto)';
  return String(v);
}

/**
 * Campi disponibili nei risultati, con il tipo dedotto da un campione.
 * Il tipo serve a due cose: proporre da soli un asse X sensato e un valore
 * numerico da misurare, e ordinare i menu in modo che il campo giusto sia il
 * primo che si incontra.
 */
export function campiDisponibili(righe) {
  const campioni = new Map(); // nome → { num, data, tot }
  const limite = Math.min(righe.length, 300);

  const visita = (obj, prefisso, profondita) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const nome = prefisso ? `${prefisso}.${k}` : k;
      const kind = ejsonKind(v);
      // Un oggetto EJSON ($oid/$date/$numberLong) è un VALORE, non un
      // sottodocumento da esplorare: scenderci dentro produrrebbe campi
      // fantasma tipo `creato.$date`.
      if (kind === 'object' && profondita < 2) { visita(v, nome, profondita + 1); continue; }
      const c = campioni.get(nome) || { num: 0, data: 0, tot: 0, valori: new Set() };
      c.tot++;
      if (numero(v) !== null && kind !== 'date' && typeof v !== 'string') c.num++;
      else if (typeof v === 'string' && Number.isFinite(Number(v.trim())) && v.trim() !== '') c.num++;
      if (kind === 'date') c.data++;
      // Cardinalità sul campione, con un tetto: serve solo a distinguere "poche
      // categorie" (una colonna da raggruppare) da "quasi tutti diversi" (un
      // identificativo, che come asse produrrebbe 400 barre). Senza tetto, su
      // 300 righe con valori unici si terrebbero 300 stringhe per niente.
      if (c.valori.size <= 60) c.valori.add(categoria(v));
      campioni.set(nome, c);
    }
  };

  for (let i = 0; i < limite; i++) visita(righe[i], '', 0);

  return Array.from(campioni.entries()).map(([nome, c]) => ({
    nome,
    tipo: c.data > c.tot / 2 ? 'data' : (c.num > c.tot / 2 ? 'numero' : 'testo'),
    distinti: c.valori.size,      // fermo a 61 = "molti"
    righe: c.tot,
  }));
}

/* ============================= Grafici suggeriti ========================== */

/**
 * Grafici proposti a partire dalla FORMA dei risultati.
 *
 * Perché esistono: comporre un grafico a mano è quattro decisioni (tipo, asse,
 * misura, aggregazione) e nel 90% dei casi la combinazione giusta è deducibile
 * dai dati — c'è una data e un numero? è un andamento nel tempo; una colonna con
 * poche categorie e un numero? è un confronto per categoria. Chi vuole quel
 * grafico non deve doverlo comporre.
 *
 * Ogni proposta è una **modifica parziale** della configurazione, non una
 * configurazione intera: si applica sopra quella corrente, così titolo,
 * tavolozza e preferenze già scelte non vengono azzerate.
 *
 * @param {{nome:string,tipo:string,distinti:number}[]} campi
 * @returns {{id:string,etichetta:string,patch:object}[]}
 */
export function suggerimenti(campi) {
  if (!campi || !campi.length) return [];

  const nonId = (f) => !/(^|\.)_id$/.test(f.nome);
  const date = campi.filter((f) => f.tipo === 'data');
  const numeri = campi.filter((f) => f.tipo === 'numero' && nonId(f));
  // Una buona colonna da raggruppare ha poche categorie distinte: fra 2 e 30.
  // Ordinate per cardinalità crescente, così "canale" (3 valori) viene prima di
  // "città" (28) e un identificativo non compare affatto.
  const categorie = campi
    .filter((f) => f.tipo === 'testo' && nonId(f) && f.distinti >= 2 && f.distinti <= 30)
    .sort((a, b) => a.distinti - b.distinti);
  const primaCat = categorie[0];
  const primoNum = numeri[0];
  const primaData = date[0];

  const serieBase = (over) => ({ ...serieDefault(0), ...over, autoY: false });
  const out = [];

  if (primaData && primoNum) {
    out.push({
      id: 'tempo-somma',
      etichetta: `Andamento di ${primoNum.nome} nel tempo`,
      patch: {
        campoX: primaData.nome, autoX: false, aggrega: true, ordina: 'x-asc', maxCategorie: 0,
        assex: { tipo: 'time' },
        serie: [serieBase({ tipo: 'line', campoY: primoNum.nome, agg: 'somma' })],
      },
    });
  }
  if (primaData && primoNum) {
    out.push({
      id: 'tempo-grezzo',
      etichetta: `${primoNum.nome} nel tempo, valori grezzi`,
      patch: {
        // `aggrega: false` è il punto: ogni riga resta un punto col SUO valore.
        // Sommare due misurazioni dello stesso istante (o dello stesso giorno)
        // risponde a un'altra domanda — qui si vuole vedere il dato com'è.
        campoX: primaData.nome, autoX: false, aggrega: false, ordina: 'x-asc', maxCategorie: 0,
        assex: { tipo: 'time' },
        serie: [serieBase({ tipo: 'line', campoY: primoNum.nome, agg: 'primo' })],
      },
    });
  }
  if (primaData && !primoNum) {
    out.push({
      id: 'tempo-conteggio',
      etichetta: 'Quante righe nel tempo',
      patch: {
        campoX: primaData.nome, autoX: false, aggrega: true, ordina: 'x-asc', maxCategorie: 0,
        assex: { tipo: 'time' },
        serie: [serieBase({ tipo: 'line', campoY: null, agg: 'conteggio' })],
      },
    });
  }
  if (primaCat && primoNum) {
    out.push({
      id: 'cat-somma',
      etichetta: `Totale ${primoNum.nome} per ${primaCat.nome}`,
      patch: {
        campoX: primaCat.nome, autoX: false, aggrega: true, ordina: 'val-desc', maxCategorie: 8,
        assex: { tipo: 'category' },
        serie: [serieBase({ tipo: 'bar', campoY: primoNum.nome, agg: 'somma' })],
      },
    });
    out.push({
      id: 'cat-media',
      etichetta: `Media ${primoNum.nome} per ${primaCat.nome}`,
      patch: {
        campoX: primaCat.nome, autoX: false, aggrega: true, ordina: 'val-desc', maxCategorie: 8,
        assex: { tipo: 'category' },
        serie: [serieBase({ tipo: 'bar', campoY: primoNum.nome, agg: 'media' })],
      },
    });
    out.push({
      id: 'cat-quote',
      etichetta: `Quote di ${primoNum.nome} per ${primaCat.nome}`,
      patch: {
        campoX: primaCat.nome, autoX: false, aggrega: true, ordina: 'val-desc', maxCategorie: 8,
        serie: [serieBase({ tipo: 'donut', campoY: primoNum.nome, agg: 'somma' })],
      },
    });
  }
  if (primaCat) {
    out.push({
      id: 'cat-conteggio',
      etichetta: `Quante righe per ${primaCat.nome}`,
      patch: {
        campoX: primaCat.nome, autoX: false, aggrega: true, ordina: 'val-desc', maxCategorie: 8,
        assex: { tipo: 'category' },
        serie: [serieBase({ tipo: 'bar', campoY: null, agg: 'conteggio' })],
      },
    });
  }
  if (numeri.length >= 2) {
    out.push({
      id: 'dispersione',
      etichetta: `${numeri[1].nome} rispetto a ${numeri[0].nome}`,
      patch: {
        // Una dispersione confronta i VALORI riga per riga: raggruppare li
        // fonderebbe, ed è l'unico caso in cui l'aggregazione va spenta.
        campoX: numeri[0].nome, autoX: false, aggrega: false, ordina: 'nessuno', maxCategorie: 0,
        assex: { tipo: 'value' },
        serie: [serieBase({ tipo: 'scatter', campoY: numeri[1].nome, agg: 'primo' })],
      },
    });
  }
  if (primaCat && categorie[1]) {
    out.push({
      id: 'incrocio',
      etichetta: `${primaCat.nome} incrociato con ${categorie[1].nome}`,
      patch: {
        campoX: primaCat.nome, autoX: false, aggrega: true, ordina: 'nessuno', maxCategorie: 0,
        serie: [serieBase({
          tipo: 'heatmap', campoY: primoNum ? primoNum.nome : null,
          campoY2: categorie[1].nome, agg: primoNum ? 'somma' : 'conteggio',
        })],
      },
    });
  }

  return out.slice(0, 7);
}

function applicaAgg(agg, acc) {
  if (acc.haEsatti && ['somma', 'media', 'min', 'max'].includes(agg)) {
    const esito = aggregaNumeriEsatti(acc.originali, agg);
    acc.valoreEsatto = esito.testo;
    if (esito.approssimato) {
      avvisi.push('Uno o più Long/Decimal sono aggregati esattamente; il renderer mostra un’approssimazione. Il valore esatto resta conservato nei dati del grafico.');
    }
    return esito.numero;
  }
  switch (agg) {
    case 'conteggio': return acc.righe;
    case 'distinti': return acc.distinti.size;
    case 'somma': return acc.somma;
    case 'media': return acc.n ? acc.somma / acc.n : null;
    case 'min': return acc.min === null ? null : acc.min;
    case 'max': return acc.max === null ? null : acc.max;
    case 'mediana': {
      if (!acc.valori.length) return null;
      const v = acc.valori.slice().sort((a, b) => a - b);
      const m = Math.floor(v.length / 2);
      return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    }
    // Il grafico vuole un numero: tutte le altre aggregazioni passano da
    // numero(), e senza qui un DECIMAL di MySQL o un $numberLong finiva grezzo
    // in series.data — la serie non veniva disegnata male, spariva.
    case 'primo': return numero(acc.primo);
    default: return acc.somma;
  }
}

// Le sole aggregazioni per cui la somma della coda coincide col ricalcolo.
const AGG_ADDITIVE = new Set(['somma', 'conteggio']);

// Fonde più accumulatori in uno solo, come se le righe fossero state raccolte
// insieme fin dall'inizio: è ciò che rende "Altro" un valore vero anche per
// media, mediana, minimo, massimo e distinti.
function fondiAcc(lista) {
  const out = nuovoAcc();
  for (const a of lista) {
    if (!a) continue;
    out.somma += a.somma;
    out.n += a.n;
    out.righe += a.righe;
    if (a.min !== null) out.min = out.min === null ? a.min : Math.min(out.min, a.min);
    if (a.max !== null) out.max = out.max === null ? a.max : Math.max(out.max, a.max);
    for (const v of a.valori) out.valori.push(v);
    for (const d of a.distinti) out.distinti.add(d);
    out.originali.push(...a.originali);
    out.haEsatti ||= a.haEsatti;
    if (out.primo === null) out.primo = a.primo;
  }
  return out;
}

function nuovoAcc() {
  return {
    somma: 0, n: 0, righe: 0, min: null, max: null, valori: [], distinti: new Set(),
    primo: null, originali: [], haEsatti: false, valoreEsatto: null,
  };
}

function accumula(acc, val) {
  acc.righe++;
  if (acc.primo === null) acc.primo = val;
  acc.distinti.add(val === null || val === undefined ? '\u0000' : String(val));
  const n = numero(val);
  if (n === null) return;
  acc.originali.push(val);
  const kind = ejsonKind(val);
  if (val && typeof val === 'object' && (kind === 'decimal'
      || Object.prototype.hasOwnProperty.call(val, '$numberLong'))) acc.haEsatti = true;
  acc.somma += n;
  acc.n++;
  acc.valori.push(n);
  acc.min = acc.min === null ? n : Math.min(acc.min, n);
  acc.max = acc.max === null ? n : Math.max(acc.max, n);
}

/**
 * Dati pronti per il grafico: categorie dell'asse X e un vettore di valori per
 * ogni serie visibile, allineato alle categorie.
 *
 * Due modalità:
 *  - `aggrega` attivo: le righe con la stessa X collassano in una categoria e
 *    su ognuna si applica l'aggregazione della serie (è ciò che serve su un
 *    result set grezzo: 50.000 ordini → 12 mesi).
 *  - `aggrega` spento: una riga = un punto, col valore della misura così com'è
 *    (è ciò che serve quando la query ha già fatto il GROUP BY, e quando si
 *    vuole vedere l'andamento REALE di una misura nel tempo senza che i punti
 *    dello stesso istante o dello stesso giorno vengano fusi in uno).
 */
function calcolaDati(righe, c) {
  const serieAttive = c.serie.filter((s) => s.visibile !== false);
  const asseTempo = c.assex.tipo === 'time';
  // Su un asse temporale un punto senza istante valido non è disegnabile: se
  // restasse nell'elenco, ECharts lo scarterebbe in silenzio e il grafico
  // mostrerebbe meno dati del previsto senza dire perché.
  let senzaData = 0;

  if (!c.aggrega) {
    const categorie = [];
    const dati = serieAttive.map(() => []);
    for (const s of serieAttive) {
      if (!s.campoY && s.agg !== 'conteggio') {
        avvisi.push(`Serie "${s.nome || `Serie ${serieAttive.indexOf(s) + 1}`}": senza raggruppamento serve un campo misura da tracciare punto per punto.`);
      }
    }
    for (const riga of righe) {
      const xv = c.campoX ? estrai(riga, c.campoX) : null;
      if (asseTempo) {
        const ms = istante(xv);
        if (ms === null) { senzaData++; continue; }
        categorie.push(ms);
      } else {
        categorie.push(c.campoX ? categoria(xv) : categorie.length + 1);
      }
      serieAttive.forEach((s, i) => {
        dati[i].push(s.agg === 'conteggio' ? 1 : numero(estrai(riga, s.campoY)));
      });
    }
    notaSenzaData(senzaData, c);
    notaTroppiPunti(categorie.length);
    return ordinaERiduci(categorie, serieAttive, dati, c, true);
  }

  const chiavi = [];
  const indice = new Map();
  const accs = serieAttive.map(() => []);

  for (const riga of righe) {
    const xv = c.campoX ? estrai(riga, c.campoX) : null;
    const chiave = asseTempo ? istante(xv) : (c.campoX ? categoria(xv) : 'Totale');
    if (asseTempo && chiave === null) { senzaData++; continue; }
    const kStr = String(chiave);
    let idx = indice.get(kStr);
    if (idx === undefined) {
      idx = chiavi.length;
      indice.set(kStr, idx);
      chiavi.push(chiave);
      serieAttive.forEach((_, i) => { accs[i][idx] = nuovoAcc(); });
    }
    serieAttive.forEach((s, i) => {
      accumula(accs[i][idx], s.agg === 'conteggio' ? 1 : estrai(riga, s.campoY));
    });
  }

  notaSenzaData(senzaData, c);
  const dati = serieAttive.map((s, i) => accs[i].map((acc) => applicaAgg(s.agg, acc)));
  const esatti = accs.map((serie) => serie.map((acc) => acc.valoreEsatto));
  // Gli accumulatori seguono i valori fino in fondo: servono a ricalcolare
  // "Altro" sull'insieme dei residui invece di sommare aggregazioni.
  return ordinaERiduci(chiavi, serieAttive, dati, c, false, accs, esatti);
}

function notaSenzaData(quante, c) {
  if (!quante) return;
  avvisi.push(`${quante} righe senza un valore valido in "${c.campoX || 'asse X'}" non sono state tracciate: l'asse è temporale.`);
}

// Soglia oltre la quale un grafico a punti grezzi smette di essere leggibile
// (e comincia a costare). Non si tronca niente: si dice che c'è un modo migliore.
const TROPPI_PUNTI = 5000;

function notaTroppiPunti(n) {
  if (n <= TROPPI_PUNTI) return;
  avvisi.push(`${n.toLocaleString('it-IT')} punti grezzi: il disegno può essere lento e i segni si sovrappongono. Attiva "Raggruppa le righe" oppure restringi la query.`);
}

/**
 * Ordinamento delle categorie e ripiegamento della coda in "Altro".
 *
 * Il secondo non è un vezzo: con più di otto categorie la tavolozza finirebbe i
 * colori verificati, e una torta con trenta fette non si legge comunque. Sommare
 * la coda in una fetta "Altro" è il modo corretto, e vale anche per barre e
 * linee (dove il problema è la leggibilità dell'asse, non i colori).
 *
 * @param {boolean} grezzo modalità "una riga = un punto". Cambia due cose: la
 *   coda NON si somma in "Altro" (sommare punti grezzi inventa un valore che nei
 *   dati non esiste — lì si tronca e lo si dice), e i valori uguali sull'asse X
 *   restano punti distinti.
 * @param {Array|null} accs accumulatori per serie e categoria. Con questi la
 *   categoria "Altro" viene RICALCOLATA sull'insieme dei valori residui: la
 *   somma delle medie (o dei minimi, o dei conteggi di distinti) è un numero che
 *   nei dati non esiste, ed è tipicamente la barra più alta del grafico.
 */
function ordinaERiduci(categorie, serieAttive, dati, c, grezzo = false, accs = null, esatti = null) {
  let ordine = categorie.map((_, i) => i);

  const totali = ordine.map((i) => dati.reduce((acc, d) => acc + (numero(d[i]) || 0), 0));
  // Su un asse temporale l'ordine di arrivo non è l'ordine del tempo, e una
  // linea si disegna nell'ordine dei dati: senza questo, righe non ordinate dal
  // database producono uno zigzag che non è un andamento ma un artefatto.
  const ordinaEffettivo = (c.ordina === 'nessuno' && c.assex.tipo === 'time') ? 'x-asc' : c.ordina;
  if (ordinaEffettivo === 'x-asc' || ordinaEffettivo === 'x-desc') {
    const dir = ordinaEffettivo === 'x-asc' ? 1 : -1;
    ordine.sort((a, b) => {
      const va = categorie[a]; const vb = categorie[b];
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'it', { numeric: true }) * dir;
    });
  } else if (ordinaEffettivo === 'val-desc' || ordinaEffettivo === 'val-asc') {
    const dir = ordinaEffettivo === 'val-asc' ? 1 : -1;
    ordine.sort((a, b) => (totali[a] - totali[b]) * dir);
  }

  let cats = ordine.map((i) => categorie[i]);
  let vals = dati.map((d) => ordine.map((i) => d[i]));
  let exactVals = esatti ? esatti.map((d) => ordine.map((i) => d[i])) : null;

  const max = Number(c.maxCategorie) || 0;
  if (max > 0 && cats.length > max && grezzo) {
    // Punti grezzi: sommarli in un "Altro" produrrebbe un valore che nei dati
    // non esiste. Si mostrano i primi e si dice quanti restano fuori.
    const scartati = cats.length - max;
    cats = cats.slice(0, max);
    vals = vals.map((d) => d.slice(0, max));
    if (exactVals) exactVals = exactVals.map((d) => d.slice(0, max));
    avvisi.push(`Mostrati i primi ${max} punti su ${max + scartati}: senza raggruppamento la coda non si può sommare senza inventare un valore.`);
  } else if (max > 0 && cats.length > max) {
    const scartate = cats.length - max;
    const indiciCoda = ordine.slice(max);
    const codaEsatta = [];
    const coda = serieAttive.map((s, i) => {
      const accSerie = accs && accs[i];
      if (accSerie) {
        // Ricalcolo esatto: si fondono gli accumulatori delle categorie residue
        // e si riapplica LA STESSA aggregazione della serie.
        const fuso = fondiAcc(indiciCoda.map((k) => accSerie[k]));
        const valore = applicaAgg(s.agg, fuso);
        codaEsatta[i] = fuso.valoreEsatto;
        return valore;
      }
      // Senza accumulatori si può sommare solo ciò che è additivo.
      if (!AGG_ADDITIVE.has(s.agg)) return null;
      return vals[i].slice(max).reduce((a, v) => a + (numero(v) || 0), 0);
    });
    cats = cats.slice(0, max).concat([`Altro (${scartate})`]);
    vals = vals.map((d, i) => d.slice(0, max).concat([coda[i]]));
    if (exactVals) exactVals = exactVals.map((d, i) => d.slice(0, max).concat([codaEsatta[i] || null]));
    const nonAdditive = serieAttive.some((s) => !AGG_ADDITIVE.has(s.agg));
    avvisi.push(
      nonAdditive && accs
        ? `${scartate} categorie oltre le prime ${max} sono raccolte in "Altro": il valore è ricalcolato sull'insieme dei residui, non è la somma dei loro valori.`
        : `${scartate} categorie oltre le prime ${max} sono state sommate in "Altro".`
    );
  } else if (cats.length > CATEGORICA.length && famigliaDi(serieAttive[0]?.tipo) === 'circolare') {
    avvisi.push(`${cats.length} fette: oltre l'ottava i colori verificati finiscono. Imposta "Max categorie" per ripiegare la coda in "Altro".`);
  }

  return { categorie: cats, valori: vals, valoriEsatti: exactVals, serieAttive };
}

// Tetto proprio della mappa di calore, applicato quando l'utente non ha
// impostato "Max categorie". Oltre queste soglie le celle diventano invisibili
// (e sono già migliaia di rettangoli da disegnare): è l'unica forma di grafico
// che non passava da ordinaERiduci e quindi non aveva alcuna rete.
const HEATMAP_MAX_CAT = 60;

/** Dati della mappa di calore: [indiceX, indiceY, valore] + le due liste. */
function calcolaHeatmap(righe, c, s) {
  const catX = []; const idxX = new Map();
  const catY = []; const idxY = new Map();
  const accs = new Map();
  const tetto = Number(c.maxCategorie) > 0 ? Number(c.maxCategorie) : HEATMAP_MAX_CAT;
  const fuoriX = new Set(); const fuoriY = new Set();

  for (const riga of righe) {
    const kx = categoria(estrai(riga, c.campoX));
    const ky = categoria(estrai(riga, s.campoY2));
    // Le prime `tetto` categorie incontrate entrano, le altre restano fuori e
    // si contano: ripiegarle in un "Altro" bidimensionale sommerebbe celle che
    // non hanno nulla in comune.
    if (!idxX.has(kx)) {
      if (catX.length >= tetto) { fuoriX.add(kx); continue; }
      idxX.set(kx, catX.length); catX.push(kx);
    }
    if (!idxY.has(ky)) {
      if (catY.length >= tetto) { fuoriY.add(ky); continue; }
      idxY.set(ky, catY.length); catY.push(ky);
    }
    const k = `${kx}\u0000${ky}`;
    if (!accs.has(k)) accs.set(k, nuovoAcc());
    accumula(accs.get(k), s.agg === 'conteggio' ? 1 : estrai(riga, s.campoY));
  }

  if (fuoriX.size || fuoriY.size) {
    const parti = [];
    if (fuoriX.size) parti.push(`${fuoriX.size} sull'asse X`);
    if (fuoriY.size) parti.push(`${fuoriY.size} sull'asse Y`);
    avvisi.push(`Mappa di calore limitata a ${tetto} categorie per asse: ${parti.join(' e ')} sono escluse. Restringi la query oppure cambia "Max categorie".`);
  }

  const dati = [];
  let min = null; let max = null;
  for (const [k, acc] of accs) {
    const [kx, ky] = k.split('\u0000');
    const v = applicaAgg(s.agg, acc);
    if (v === null) continue;
    dati.push([idxX.get(kx), idxY.get(ky), v]);
    min = min === null ? v : Math.min(min, v);
    max = max === null ? v : Math.max(max, v);
  }
  return { catX, catY, dati, min: min ?? 0, max: max ?? 1 };
}

/**
 * Tipo EFFETTIVO dell'asse X.
 *
 * Un asse temporale su un campo che non contiene istanti non produce un grafico
 * sbagliato: ne produce uno **vuoto**, perché ogni punto viene scartato. È il
 * caso che capita da solo — l'asse viene dedotto da un campo data, poi si cambia
 * il campo con una colonna di testo e il tipo dell'asse resta indietro. Meglio
 * disegnare il grafico che si può disegnare e dire cosa è stato fatto, che
 * mostrare un riquadro vuoto e l'elenco delle righe scartate.
 */
function tipoAsseX(righe, c) {
  if (c.assex.tipo !== 'time' || !righe.length) return c.assex.tipo;
  const limite = Math.min(righe.length, 200);
  for (let i = 0; i < limite; i++) {
    if (istante(estrai(righe[i], c.campoX)) !== null) return 'time';
  }
  avvisi.push(`"${c.campoX || 'asse X'}" non contiene date: l'asse è stato trattato come categorie. Per forzarlo, pannello ⚙ → Assi → Tipo.`);
  return 'category';
}

/* ============================ Formattazione =============================== */

function formattatore(fmt) {
  if (fmt === 'compatto') {
    const f = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 1 });
    return (v) => f.format(Number(v));
  }
  if (fmt === 'percento') return (v) => `${Number(v).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%`;
  if (fmt === 'byte') return (v) => fmtBytes(Number(v));
  if (fmt === 'grezzo') return (v) => String(v);
  return (v) => Number(v).toLocaleString('it-IT', { maximumFractionDigits: 2 });
}

/* ========================= Costruzione dell'option ======================= */

// Esportata perché il pannello mostra la pastiglia del colore accanto al nome
// della serie: quel colore deve essere ESATTAMENTE quello del grafico, quindi lo
// decide la stessa funzione e non una copia.
export function coloreSerie(s, i, tavolozza) {
  if (s.colore) return s.colore;
  const colori = TAVOLOZZE[tavolozza] ? TAVOLOZZE[tavolozza].colori : CATEGORICA;
  // Lo slot è memorizzato nella serie: aggiungere, togliere o riordinare le
  // serie NON ricolora quelle che restano (vedi 2. in testa al file).
  const slot = Number.isInteger(s.slot) ? s.slot : i;
  return colori[slot % colori.length];
}

const testoBase = { color: INK.secondario, fontFamily: 'Inter, -apple-system, "Segoe UI", sans-serif', fontSize: 11 };

function assePerConfig(conf, tipoForzato, formato) {
  const a = {
    type: tipoForzato || conf.tipo,
    name: conf.nome || undefined,
    nameLocation: 'middle',
    nameGap: 30,
    nameTextStyle: { ...testoBase, color: INK.secondario, fontSize: 11 },
    inverse: !!conf.inverti,
    axisLine: { show: true, lineStyle: { color: INK.asse, width: 1 } },
    axisTick: { show: false },
    // Griglia: linea a un passo dal fondo, SOLIDA e da 1px. Tratteggiata o più
    // spessa diventa inchiostro che compete col dato.
    splitLine: { show: !!conf.griglia, lineStyle: { color: INK.griglia, width: 1, type: 'solid' } },
    axisLabel: { ...testoBase, color: INK.muto, hideOverlap: true },
  };
  if (conf.rotazione) a.axisLabel.rotate = Number(conf.rotazione);
  if (formato) a.axisLabel.formatter = formato;
  if (conf.min !== '' && conf.min !== undefined && conf.min !== null) a.min = Number(conf.min);
  if (conf.max !== '' && conf.max !== undefined && conf.max !== null) a.max = Number(conf.max);
  if (conf.log) a.type = 'log';
  return a;
}

function legendaVisibile(c, nSerie) {
  // Con due o più serie la legenda è il canale affidabile dell'identità e c'è
  // sempre. Con una sola serie un riquadro con un solo colore ripete il titolo
  // e ruba spazio: si nasconde.
  if (c.legenda.mostra === 'si') return true;
  if (c.legenda.mostra === 'no') return false;
  return nSerie > 1;
}

function bloccoLegenda(c, nSerie) {
  if (!legendaVisibile(c, nSerie)) return { show: false };
  const p = c.legenda.posizione;
  const l = {
    show: true,
    type: 'scroll',
    orient: c.legenda.orient,
    textStyle: { ...testoBase, color: INK.primario },
    inactiveColor: INK.muto,
    itemWidth: 12,
    itemHeight: 8,
    icon: 'roundRect',
  };
  if (p === 'top') { l.top = 8; l.left = 'center'; }
  else if (p === 'bottom') { l.bottom = 4; l.left = 'center'; }
  else if (p === 'left') { l.left = 4; l.top = 'middle'; l.orient = 'vertical'; }
  else { l.right = 4; l.top = 'middle'; l.orient = 'vertical'; }
  return l;
}

function bloccoTooltip(c, famiglia, fmt) {
  if (!c.tooltip.mostra) return { show: false };
  const trigger = c.tooltip.trigger === 'auto'
    ? (famiglia === 'cartesiano' ? 'axis' : 'item')
    : c.tooltip.trigger;
  return {
    show: true,
    trigger,
    // Il mirino verticale su una serie temporale è quello che rende leggibile
    // un grafico a linee: senza, si legge a occhio la posizione sull'asse.
    axisPointer: { type: famiglia === 'cartesiano' ? 'line' : 'none', lineStyle: { color: INK.asse, width: 1 } },
    backgroundColor: INK.tooltipFondo,
    borderColor: INK.tooltipBordo,
    borderWidth: 1,
    textStyle: { ...testoBase, color: INK.primario, fontSize: 12 },
    valueFormatter: fmt,
    confine: true,
  };
}

function bloccoTitolo(c) {
  if (!c.titolo && !c.sottotitolo) return { show: false };
  return {
    show: true,
    text: c.titolo || undefined,
    subtext: c.sottotitolo || undefined,
    left: 12,
    top: 6,
    textStyle: { ...testoBase, color: INK.primario, fontSize: 14, fontWeight: 600 },
    subtextStyle: { ...testoBase, color: INK.muto, fontSize: 11 },
  };
}

/** Numero grezzo di un punto della serie, che sia scalare o coppia [x, y]. */
function valorePunto(v) {
  const grezzo = Array.isArray(v) ? v[1] : v;
  return numero(grezzo);
}

/** Etichette dirette: mai un numero su ogni punto se i punti sono molti. */
function bloccoEtichette(s, fmt, valori) {
  if (!s.etichette) return { show: false };
  const n = Array.isArray(valori) ? valori.length : Number(valori) || 0;
  const base = {
    position: s.posEtichette || 'top',
    color: INK.primario, // token di testo, NON il colore della serie
    fontSize: 10,
  };
  if (n > 40) {
    // L'avviso promette l'etichetta sul solo massimo, e qui la si mette
    // davvero: prima si annunciava un comportamento e se ne attuava un altro
    // (nessuna etichetta), cioè l'unico caso peggiore di non dire nulla.
    avvisi.push(`Serie "${s.nome || s.campoY}": ${n} punti, etichette su ognuno sarebbero illeggibili — mostrata solo sul valore massimo.`);
    const numeri = Array.isArray(valori) ? valori.map(valorePunto).filter((x) => x !== null) : [];
    if (!numeri.length) return { show: false };
    const massimo = Math.max(...numeri);
    return {
      ...base,
      show: true,
      formatter: (p) => (valorePunto(p.value) === massimo ? fmt(valorePunto(p.value)) : ''),
    };
  }
  return {
    ...base,
    show: true,
    formatter: (p) => fmt(p.value === null || p.value === undefined ? '' : (Array.isArray(p.value) ? p.value[1] : p.value)),
  };
}

function serieCartesiana(s, i, c, valori, fmt) {
  const colore = coloreSerie(s, i, c.tavolozza);
  const opacita = Math.max(0, Math.min(100, Number(s.opacita) || 100)) / 100;
  const nome = s.nome || s.campoY || `Serie ${i + 1}`;
  const base = {
    name: nome,
    // `colorBy: 'series'` è essenziale: senza, ECharts colora ogni BARRA di una
    // serie singola con un colore diverso della tavolozza — una rampa di colori
    // su categorie che non hanno alcun ordine naturale, che raddoppia
    // l'informazione già data dalla lunghezza della barra e brucia l'unico
    // canale libero.
    colorBy: 'series',
    itemStyle: { color: colore, opacity: opacita },
    emphasis: { focus: 'series' },
    label: bloccoEtichette(s, fmt, valori),
  };

  if (s.tipo === 'bar') {
    return {
      ...base,
      type: 'bar',
      data: valori,
      stack: s.stack || undefined,
      barMaxWidth: Number(s.barMax) || 24,
      itemStyle: {
        ...base.itemStyle,
        // Estremità arrotondata di 4px sul lato del DATO, spigolo vivo sulla
        // linea di base: la barra cresce da una base, non galleggia.
        borderRadius: c.orizzontale ? [0, 4, 4, 0] : [4, 4, 0, 0],
        // Su una barra impilata il distacco fra i segmenti lo fa un vuoto di 2px
        // del colore del fondo, non un contorno colorato.
        borderColor: s.stack ? INK.fondo : 'transparent',
        borderWidth: s.stack ? 2 : 0,
      },
    };
  }

  if (s.tipo === 'scatter') {
    return {
      ...base,
      type: 'scatter',
      data: valori,
      symbol: s.simbolo || 'circle',
      symbolSize: Math.max(8, Number(s.dimSimbolo) || 8),
      // Anello di 2px del colore del fondo: i punti restano leggibili dove si
      // sovrappongono, e l'anello fa parte del bersaglio del mouse.
      itemStyle: { ...base.itemStyle, borderColor: INK.fondo, borderWidth: 2 },
    };
  }

  const linea = {
    ...base,
    type: 'line',
    data: valori,
    smooth: !!s.smooth,
    symbol: s.simbolo === 'none' ? 'none' : (s.simbolo || 'circle'),
    symbolSize: Math.max(8, Number(s.dimSimbolo) || 8),
    showSymbol: valori.length <= 200, // su mille punti i marker sono solo rumore
    stack: s.stack || undefined,
    lineStyle: { color: colore, width: Number(s.larghezzaLinea) || 2, cap: 'round', join: 'round', opacity: opacita },
    itemStyle: { ...base.itemStyle, borderColor: INK.fondo, borderWidth: 2 },
  };
  if (s.tipo === 'area') {
    // Velatura al 10%: un riempimento saturo nasconde la griglia e le serie
    // sottostanti.
    linea.areaStyle = { color: colore, opacity: (Number(s.areaOpacita) || 10) / 100 };
  }
  return linea;
}

/**
 * Riquadro del grafico adattato allo SPAZIO REALE disponibile.
 *
 * I margini sono configurabili, ma sono valori assoluti in pixel: in un
 * pannello dei risultati alto 200 px un margine superiore da 56 px e uno
 * inferiore da 52 px lasciano al grafico meno della metà dell'altezza, e con lo
 * slider dello zoom non resta niente. Qui i margini vengono **limitati** a una
 * frazione dell'altezza vera: la configurazione dell'utente vale finché c'è
 * spazio, e quando non c'è vince il grafico invece di sparire.
 */
function grigliaAdattata(c, box, conZoom) {
  const h = box.altezza || 400;
  const titolo = !!(c.titolo || c.sottotitolo);
  const legenda = c.legenda.mostra !== 'no';
  // Spazio minimo indispensabile in alto: titolo e legenda, se ci sono.
  const minTop = (titolo ? 22 : 6) + (legenda && (c.legenda.posizione === 'top') ? 20 : 0);
  const top = Math.max(minTop, Math.min(Number(c.griglia.top) || 56, Math.round(h * 0.22)));
  const bottomBase = Math.max(24, Math.min(Number(c.griglia.bottom) || 52, Math.round(h * 0.28)));
  return {
    top,
    bottom: conZoom ? bottomBase + ALTEZZA_ZOOM : bottomBase,
    left: Number(c.griglia.left) || 64,
    right: Number(c.griglia.right) || 28,
    containLabel: true,
  };
}

// Altezza riservata allo slider dello zoom (slider + respiro dal bordo).
const ALTEZZA_ZOOM = 26;
// Sotto questa altezza lo slider NON si disegna: occuperebbe un ottavo del
// grafico per una funzione che la rotella del mouse svolge già.
const ALTEZZA_MIN_SLIDER = 200;

/**
 * Costruisce l'`option` ECharts dai dati e dalla configurazione.
 * È una funzione PURA: prende righe, configurazione e (opzionale) le dimensioni
 * del riquadro, e restituisce l'option. Da qui passa anche l'export JSON, quindi
 * ciò che si vede e ciò che si esporta non possono divergere.
 *
 * @param {object} [box] `{ larghezza, altezza }` in pixel dell'area di disegno.
 *   Serve per adattare margini e zoom allo spazio vero: senza, il grafico si
 *   disegna come se avesse sempre spazio in abbondanza.
 */
/**
 * La parte del grafico che DIPENDE DALLE RIGHE, separata dal disegno.
 *
 * Tutto ciò che costa qui dentro è proporzionale al numero di righe: dedurre il
 * tipo dell'asse, raggruppare, aggregare, ordinare e ridurre le categorie. Il
 * resto di `costruisciOption` lavora sui punti già calcolati (poche decine) e
 * costa quanto costa comporre un oggetto.
 *
 * Sta a parte perché è **serializzabile**: entrano righe e configurazione,
 * escono array di numeri e stringhe. Questo permette di eseguirla in un Web
 * Worker su dataset grandi (vedi `calcoli.js`), cosa impossibile per l'option
 * intera — che contiene funzioni (i `formatter` di ECharts) e quindi non
 * attraversa il confine fra due thread.
 *
 * Il risultato si passa a `costruisciOption` come quarto argomento; senza, il
 * calcolo avviene lì come prima.
 */
export function precalcola(righe, c) {
  const tipoAsse = tipoAsseX(righe, c);
  const cEff = { ...c, assex: { ...c.assex, tipo: tipoAsse } };
  const serieAttive = cEff.serie.filter((s) => s.visibile !== false);
  const prima = serieAttive[0] || cEff.serie[0];

  // Le note raccolte da chi ha chiamato non sono affar nostro: si mettono da
  // parte e si rimettono a posto. Azzerarle e basta funzionava solo perché in
  // tutti i chiamanti di oggi `azzeraAvvisi()` viene subito prima — cioè per
  // caso, non per costruzione.
  const precedenti = avvisi;
  avvisi = [];
  const pre = { tipoAsse, avvisi: [], dati: null, heatmap: null };
  try {
    if (famigliaDi(prima && prima.tipo) === 'heatmap') {
      if (prima && prima.campoY2) pre.heatmap = calcolaHeatmap(righe, cEff, prima);
    } else {
      pre.dati = calcolaDati(righe, cEff);
    }
    pre.avvisi = prendiAvvisi();
  } finally {
    avvisi = precedenti;
  }
  return pre;
}

/**
 * @param {object} [pre] risultato di `precalcola` per le STESSE righe e la
 *   stessa configurazione. Se manca, si calcola qui.
 */
export function costruisciOption(righe, c, box = {}, pre = null) {
  // Le note del precalcolo (fatto magari su un altro thread) rientrano nel
  // registro prima che se ne aggiungano altre qui.
  if (pre) aggiungiAvvisi(pre.avvisi);
  // Da qui in giù si lavora sul tipo di asse EFFETTIVO: un asse temporale su un
  // campo senza date scarterebbe ogni punto (vedi tipoAsseX). La configurazione
  // dell'utente non viene modificata — solo interpretata.
  c = { ...c, assex: { ...c.assex, tipo: pre ? pre.tipoAsse : tipoAsseX(righe, c) } };
  const datiPronti = () => (pre && pre.dati ? pre.dati : calcolaDati(righe, c));
  const fmtY = formattatore(c.assey.formato);
  const serieAttive = c.serie.filter((s) => s.visibile !== false);
  const prima = serieAttive[0] || c.serie[0];
  const famiglia = famigliaDi(prima.tipo);

  const comune = {
    backgroundColor: 'transparent',
    animation: !!c.animazione,
    animationDuration: 300,
    color: TAVOLOZZE[c.tavolozza] ? TAVOLOZZE[c.tavolozza].colori : CATEGORICA,
    textStyle: testoBase,
    title: bloccoTitolo(c),
    tooltip: bloccoTooltip(c, famiglia, fmtY),
  };

  /* ------------------------------- Heatmap ------------------------------- */
  if (famiglia === 'heatmap') {
    if (!prima.campoY2) {
      return { ...comune, graphic: messaggio('Scegli il campo della seconda categoria (asse Y) per la mappa di calore.') };
    }
    const h = (pre && pre.heatmap) ? pre.heatmap : calcolaHeatmap(righe, c, prima);
    return {
      ...comune,
      legend: { show: false },
      // La scala di colore sta A DESTRA, in verticale, e il riquadro le fa
      // spazio: in orizzontale sotto il grafico le sue etichette di minimo e
      // massimo finivano sulla stessa banda delle etichette dell'asse X, e si
      // leggevano come categorie ("Lazio 1653 Campania 1684 Sicilia"). Il lato
      // destro è anche il posto convenzionale di una scala di colore, e non
      // dipende dall'altezza del pannello dei risultati, che qui è bassa.
      grid: { ...grigliaAdattata(c, box, false), right: Math.max(Number(c.griglia.right) || 28, 76) },
      xAxis: { ...assePerConfig(c.assex, 'category'), data: h.catX },
      yAxis: { ...assePerConfig({ ...c.assey, log: false, min: '', max: '' }, 'category'), data: h.catY },
      visualMap: {
        min: h.min,
        max: h.max,
        calculable: true,
        orient: 'vertical',
        right: 8,
        top: 'middle',
        itemWidth: 12,
        itemHeight: 110,
        formatter: (v) => fmtY(v),
        // Un solo tono, chiaro→scuro: il colore qui è una GRANDEZZA.
        inRange: { color: SEQUENZIALE_BLU },
        textStyle: { ...testoBase, color: INK.muto },
      },
      series: [{
        type: 'heatmap',
        name: prima.nome || prima.campoY || 'Valore',
        data: h.dati,
        label: { show: !!prima.etichette, color: INK.primario, fontSize: 10, formatter: (p) => fmtY(p.value[2]) },
        // Vuoto di 2px del colore del fondo fra le celle.
        itemStyle: { borderColor: INK.fondo, borderWidth: 2 },
        emphasis: { itemStyle: { borderColor: INK.primario, borderWidth: 2 } },
      }],
    };
  }

  /* -------------------------------- Radar -------------------------------- */
  if (famiglia === 'radar') {
    const d = datiPronti();
    return {
      ...comune,
      legend: bloccoLegenda(c, d.serieAttive.length),
      radar: {
        indicator: d.categorie.map((cat) => ({ name: String(cat) })),
        center: ['50%', '55%'],
        radius: '62%',
        axisName: { ...testoBase, color: INK.muto },
        splitLine: { lineStyle: { color: INK.griglia } },
        splitArea: { show: false },
        axisLine: { lineStyle: { color: INK.griglia } },
      },
      series: [{
        type: 'radar',
        data: d.serieAttive.map((s, i) => {
          const colore = coloreSerie(s, i, c.tavolozza);
          return {
            name: s.nome || s.campoY || `Serie ${i + 1}`,
            value: d.valori[i].map((v) => (v === null ? 0 : v)),
            lineStyle: { color: colore, width: Number(s.larghezzaLinea) || 2 },
            itemStyle: { color: colore },
            areaStyle: s.tipo === 'radar' && s.areaOpacita ? { color: colore, opacity: (Number(s.areaOpacita) || 10) / 100 } : undefined,
            label: { show: !!s.etichette, color: INK.primario, fontSize: 10, formatter: (p) => fmtY(p.value) },
          };
        }),
      }],
    };
  }

  /* --------------------------- Torta / imbuto ---------------------------- */
  if (famiglia === 'circolare') {
    const d = datiPronti();
    if (d.serieAttive.length > 1) {
      avvisi.push('Torta, ciambella e imbuto mostrano UNA serie: le altre sono ignorate. Per confrontare più misure usa barre.');
    }
    const valori = d.valori[0] || [];
    const dati = d.categorie.map((cat, i) => ({ name: String(cat), value: numero(valori[i]) || 0 }));
    const s = d.serieAttive[0] || prima;

    if (prima.tipo === 'funnel') {
      return {
        ...comune,
        legend: bloccoLegenda(c, dati.length),
        series: [{
          type: 'funnel',
          data: dati,
          left: '12%',
          right: '12%',
          // Anche l'imbuto deve stare nello spazio che c'è: con un margine
          // superiore fisso, in un pannello basso restava un imbuto alto due
          // centimetri sotto una fascia vuota.
          top: grigliaAdattata(c, box, false).top,
          bottom: 20,
          minSize: '10%',
          gap: 2, // il vuoto fra i segmenti è del colore del fondo
          label: { show: true, position: 'inside', color: INK.suColore, fontSize: 11, formatter: (p) => `${p.name}: ${fmtY(p.value)}` },
          itemStyle: { borderColor: INK.fondo, borderWidth: 2 },
        }],
      };
    }

    return {
      ...comune,
      legend: bloccoLegenda(c, dati.length),
      series: [{
        type: 'pie',
        name: s.nome || s.campoY || 'Valore',
        data: dati,
        radius: prima.tipo === 'donut' ? ['45%', '70%'] : '68%',
        center: ['50%', '56%'],
        // Etichette esterne con linea guida: dentro una fetta stretta il testo
        // verrebbe tagliato, e un'etichetta tagliata è peggio di nessuna.
        label: {
          show: true,
          color: INK.secondario,
          fontSize: 11,
          formatter: (p) => `${p.name}  ${p.percent}%`,
        },
        labelLine: { lineStyle: { color: INK.asse } },
        itemStyle: { borderColor: INK.fondo, borderWidth: 2 },
        minAngle: 2,
      }],
    };
  }

  /* ------------------------------ Cartesiano ----------------------------- */
  const d = datiPronti();
  const asseValori = assePerConfig(c.assey, undefined, fmtY);
  const asseCategorie = { ...assePerConfig(c.assex, c.assex.tipo === 'time' ? 'time' : undefined), data: c.assex.tipo === 'time' ? undefined : d.categorie.map(String) };

  const serie = d.serieAttive.map((s, i) => {
    let valori = d.valori[i];
    // Su un asse temporale (o su una dispersione con X numerica) il punto è una
    // COPPIA [x, y]: passare solo le y farebbe distribuire i punti a indici
    // interi, cioè un grafico che mente sulla spaziatura.
    if (c.assex.tipo === 'time' || (s.tipo === 'scatter' && c.assex.tipo === 'value')) {
      valori = d.categorie.map((cat, j) => [c.assex.tipo === 'time' ? cat : numero(cat), d.valori[i][j]]);
    }
    const pronta = serieCartesiana(s, i, c, valori, fmtY);
    if (d.valoriEsatti && d.valoriEsatti[i]) pronta.codedbExactValues = d.valoriEsatti[i];
    return pronta;
  });

  // Lo slider si disegna solo se c'è davvero spazio: in un riquadro basso
  // occuperebbe un ottavo dell'altezza per fare quello che la rotella del mouse
  // fa già. Sotto la soglia resta lo zoom `inside` (rotella e trascinamento) e
  // una nota lo dice, invece di lasciar credere che lo zoom non funzioni.
  const altezza = box.altezza || 400;
  const conSlider = !!c.zoom && altezza >= ALTEZZA_MIN_SLIDER;
  if (c.zoom && !conSlider) {
    avvisi.push('Pannello troppo basso per la barra di zoom: usa la rotella del mouse sul grafico, oppure allarga il pannello dei risultati.');
  }

  const option = {
    ...comune,
    legend: bloccoLegenda(c, serie.length),
    grid: grigliaAdattata(c, box, conSlider),
    xAxis: c.orizzontale ? asseValori : asseCategorie,
    yAxis: c.orizzontale ? asseCategorie : asseValori,
    series: serie,
  };

  if (c.zoom) {
    option.dataZoom = [{ type: 'inside', filterMode: 'weakFilter' }];
    if (conSlider) {
      option.dataZoom.push({
        type: 'slider',
        height: 16,
        bottom: 4,
        borderColor: 'transparent',
        backgroundColor: INK.zoomFondo,
        fillerColor: INK.zoomSelezione,
        handleStyle: { color: INK.zoomManiglia },
        moveHandleSize: 4,
        dataBackground: { lineStyle: { color: INK.asse }, areaStyle: { color: INK.zoomArea } },
        // Le etichette agli estremi dello slider ricadrebbero sulla banda delle
        // etichette dell'asse: il valore lo dice già l'asse.
        showDetail: false,
        showDataShadow: true,
        labelPrecision: 0,
        textStyle: { ...testoBase, color: INK.muto },
      });
    }
  }

  return option;
}

function messaggio(testo) {
  return {
    type: 'text',
    left: 'center',
    top: 'middle',
    style: { text: testo, fill: INK.muto, fontSize: 12, fontFamily: 'Inter, sans-serif' },
  };
}

