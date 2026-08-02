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

/*
 * Note maturate durante l'ultima costruzione. Il chiamante fa
 * `azzeraAvvisi()` prima e `prendiAvvisi()` dopo: passarle come parametro
 * attraverso otto funzioni interne renderebbe illeggibile ogni firma per un
 * effetto che riguarda solo la presentazione.
 */
let avvisi = [];

export function azzeraAvvisi() { avvisi = []; }
export function prendiAvvisi() { return Array.from(new Set(avvisi)); }

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

// Cromatura del grafico: sempre token di testo/superficie, mai colori di serie.
export const INK = {
  fondo: '#161b22',      // --bg-surface
  primario: '#e2e8f0',   // --fg
  secondario: '#8892a4', // --fg-dim
  muto: '#8892a4',
  griglia: 'rgba(255, 255, 255, 0.07)',
  asse: 'rgba(255, 255, 255, 0.18)',
};

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

  return out.slice(0, 6);
}

function applicaAgg(agg, acc) {
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
    case 'primo': return acc.primo;
    default: return acc.somma;
  }
}

function nuovoAcc() {
  return { somma: 0, n: 0, righe: 0, min: null, max: null, valori: [], distinti: new Set(), primo: null };
}

function accumula(acc, val) {
  acc.righe++;
  if (acc.primo === null) acc.primo = val;
  acc.distinti.add(val === null || val === undefined ? '\u0000' : String(val));
  const n = numero(val);
  if (n === null) return;
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
 *  - `aggrega` spento: una riga = un punto, nell'ordine in cui è arrivata (è
 *    ciò che serve quando la query ha già fatto il GROUP BY).
 */
function calcolaDati(righe, c) {
  const serieAttive = c.serie.filter((s) => s.visibile !== false);
  const asseTempo = c.assex.tipo === 'time';

  if (!c.aggrega) {
    const categorie = [];
    const dati = serieAttive.map(() => []);
    for (const riga of righe) {
      const xv = c.campoX ? estrai(riga, c.campoX) : null;
      categorie.push(asseTempo ? istante(xv) : (c.campoX ? categoria(xv) : categorie.length + 1));
      serieAttive.forEach((s, i) => {
        dati[i].push(s.agg === 'conteggio' ? 1 : numero(estrai(riga, s.campoY)));
      });
    }
    return ordinaERiduci(categorie, serieAttive, dati, c);
  }

  const chiavi = [];
  const indice = new Map();
  const accs = serieAttive.map(() => []);

  for (const riga of righe) {
    const xv = c.campoX ? estrai(riga, c.campoX) : null;
    const chiave = asseTempo ? istante(xv) : (c.campoX ? categoria(xv) : 'Totale');
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

  const dati = serieAttive.map((s, i) => accs[i].map((acc) => applicaAgg(s.agg, acc)));
  return ordinaERiduci(chiavi, serieAttive, dati, c);
}

/**
 * Ordinamento delle categorie e ripiegamento della coda in "Altro".
 *
 * Il secondo non è un vezzo: con più di otto categorie la tavolozza finirebbe i
 * colori verificati, e una torta con trenta fette non si legge comunque. Sommare
 * la coda in una fetta "Altro" è il modo corretto, e vale anche per barre e
 * linee (dove il problema è la leggibilità dell'asse, non i colori).
 */
function ordinaERiduci(categorie, serieAttive, dati, c) {
  let ordine = categorie.map((_, i) => i);

  const totali = ordine.map((i) => dati.reduce((acc, d) => acc + (numero(d[i]) || 0), 0));
  if (c.ordina === 'x-asc' || c.ordina === 'x-desc') {
    const dir = c.ordina === 'x-asc' ? 1 : -1;
    ordine.sort((a, b) => {
      const va = categorie[a]; const vb = categorie[b];
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'it', { numeric: true }) * dir;
    });
  } else if (c.ordina === 'val-desc' || c.ordina === 'val-asc') {
    const dir = c.ordina === 'val-asc' ? 1 : -1;
    ordine.sort((a, b) => (totali[a] - totali[b]) * dir);
  }

  let cats = ordine.map((i) => categorie[i]);
  let vals = dati.map((d) => ordine.map((i) => d[i]));

  const max = Number(c.maxCategorie) || 0;
  if (max > 0 && cats.length > max) {
    const scartate = cats.length - max;
    const coda = vals.map((d) => d.slice(max).reduce((a, v) => a + (numero(v) || 0), 0));
    cats = cats.slice(0, max).concat([`Altro (${scartate})`]);
    vals = vals.map((d, i) => d.slice(0, max).concat([coda[i]]));
    avvisi.push(`${scartate} categorie oltre le prime ${max} sono state sommate in "Altro".`);
  } else if (cats.length > CATEGORICA.length && famigliaDi(serieAttive[0]?.tipo) === 'circolare') {
    avvisi.push(`${cats.length} fette: oltre l'ottava i colori verificati finiscono. Imposta "Max categorie" per ripiegare la coda in "Altro".`);
  }

  return { categorie: cats, valori: vals, serieAttive };
}

/** Dati della mappa di calore: [indiceX, indiceY, valore] + le due liste. */
function calcolaHeatmap(righe, c, s) {
  const catX = []; const idxX = new Map();
  const catY = []; const idxY = new Map();
  const accs = new Map();

  for (const riga of righe) {
    const kx = categoria(estrai(riga, c.campoX));
    const ky = categoria(estrai(riga, s.campoY2));
    if (!idxX.has(kx)) { idxX.set(kx, catX.length); catX.push(kx); }
    if (!idxY.has(ky)) { idxY.set(ky, catY.length); catY.push(ky); }
    const k = `${kx}\u0000${ky}`;
    if (!accs.has(k)) accs.set(k, nuovoAcc());
    accumula(accs.get(k), s.agg === 'conteggio' ? 1 : estrai(riga, s.campoY));
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
    backgroundColor: '#1f2937',
    borderColor: 'rgba(255,255,255,0.12)',
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

/** Etichette dirette: mai un numero su ogni punto se i punti sono molti. */
function bloccoEtichette(s, fmt, n) {
  if (!s.etichette) return { show: false };
  if (n > 40) {
    avvisi.push(`Serie "${s.nome || s.campoY}": ${n} punti, etichette su ognuno sarebbero illeggibili — mostrate solo sul valore massimo.`);
    return { show: false };
  }
  return {
    show: true,
    position: s.posEtichette || 'top',
    color: INK.primario, // token di testo, NON il colore della serie
    fontSize: 10,
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
    label: bloccoEtichette(s, fmt, valori.length),
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
export function costruisciOption(righe, c, box = {}) {
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
    const h = calcolaHeatmap(righe, c, prima);
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
    const d = calcolaDati(righe, c);
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
    const d = calcolaDati(righe, c);
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
          label: { show: true, position: 'inside', color: '#ffffff', fontSize: 11, formatter: (p) => `${p.name}: ${fmtY(p.value)}` },
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
  const d = calcolaDati(righe, c);
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
    return serieCartesiana(s, i, c, valori, fmtY);
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
        backgroundColor: 'rgba(255,255,255,0.04)',
        fillerColor: 'rgba(99,102,241,0.18)',
        handleStyle: { color: '#6366f1' },
        moveHandleSize: 4,
        dataBackground: { lineStyle: { color: INK.asse }, areaStyle: { color: 'rgba(255,255,255,0.06)' } },
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

