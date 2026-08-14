'use strict';

/* ---------------------------------------------------------------------------
 * Dalla SELEZIONE DI CELLE della griglia ai dati di un grafico.
 *
 * È il terzo gemello di `cell-stats.js` (i numeri della selezione) e
 * `geo-stats.js` (le geometrie della selezione): stessa forma in ingresso — le
 * celle selezionate con la loro provenienza — e stessa ragione per stare a
 * parte dall'interfaccia (`cellgrafico.js`). Un grafico costruito male non
 * lancia eccezioni: disegna barre plausibili sulla colonna sbagliata, e chi
 * guarda non ha modo di accorgersene. Qui non si tocca il DOM, quindi si prova
 * in Node (`test/unit-cell-chart.js`, incluso in `npm test`).
 *
 * Le scelte che non sono ovvie:
 *
 * 1. UNA RIGA DELLA SELEZIONE = UNA RIGA DEL GRAFICO. La selezione è un
 *    rettangolo (eventualmente bucato) di celle, non un elenco di valori: se si
 *    appiattisse in una sequenza, due colonne selezionate insieme diventerebbero
 *    una serie sola con i valori alternati. Ogni riga della griglia diventa
 *    quindi un oggetto con le sole colonne selezionate, cioè esattamente la
 *    forma che `chart-option.js` già sa disegnare per i risultati di una query.
 *
 * 2. OGNI COLONNA NUMERICA È UNA SERIE. È il motivo per cui questa funzione
 *    esiste invece di riusare `autoConfigura` di charts.js, che sceglie UNA
 *    misura: se si selezionano tre colonne di importi, il grafico atteso è il
 *    confronto fra le tre, non la prima.
 *
 * 3. IL RAGGRUPPAMENTO SI DECIDE DAI DATI, non per preferenza. Se i valori
 *    dell'asse X sono tutti diversi (una colonna di identificativi, o l'ordinale
 *    di riga) raggruppare non unisce nulla e aggiunge solo un calcolo che
 *    l'utente non ha chiesto; se invece si ripetono ("regione", "stato"), la
 *    somma per categoria è quasi sempre la domanda. Nel dubbio si preferisce il
 *    valore grezzo: mostrare un dato così com'è non mente mai.
 *
 * 4. LA COLONNA "#". Selezionando una sola colonna di numeri non ci sarebbe
 *    alcun asse X, e il grafico sarebbe vuoto senza spiegazione. L'ordinale
 *    della riga NELLA SELEZIONE (non l'indice di pagina) è l'asse naturale:
 *    dice "il primo valore, il secondo…" ed è ciò che si vuole vedere quando si
 *    trascina su una colonna per guardarne l'andamento.
 * ------------------------------------------------------------------------- */

import { campiDisponibili, cfgDefault, serieDefault, CATEGORICA } from './chart-option.js';

/** Nome della colonna sintetica con l'ordinale della riga nella selezione. */
export const CAMPO_ORDINE = '#';

/**
 * Massimo di righe portate nel grafico.
 *
 * Non è un limite tecnico di ECharts (regge molto di più) ma di leggibilità e
 * di reattività della modale: oltre qualche migliaio di punti la costruzione
 * dell'option blocca il thread abbastanza da far sembrare l'interfaccia
 * inchiodata, per mostrare barre larghe mezzo pixel. Si taglia dichiarandolo,
 * mai in silenzio (vedi la nota restituita da `datiSelezione`).
 */
export const MAX_RIGHE = 5000;

/**
 * Trasforma le celle selezionate in righe e colonne.
 *
 * @param {{valore:any, colonna:string, riga:number}[]} voci celle in ordine di lettura
 * @returns {{righe:object[], colonne:string[], tagliate:number}}
 */
export function datiSelezione(voci) {
  const perRiga = new Map(); // indice di riga → oggetto
  const colonne = [];
  const viste = new Set();
  const escluse = new Set(); // righe oltre il tetto: si CONTANO, non si perdono in silenzio

  for (const v of voci || []) {
    if (!v || !v.colonna) continue;
    if (!viste.has(v.colonna)) { viste.add(v.colonna); colonne.push(v.colonna); }
    if (!perRiga.has(v.riga)) {
      if (perRiga.size >= MAX_RIGHE) { escluse.add(v.riga); continue; }
      perRiga.set(v.riga, Object.create(null));
    }
    perRiga.get(v.riga)[v.colonna] = v.valore;
  }
  const tagliate = escluse.size;

  // L'ordinale si assegna DOPO, sull'ordine di comparsa delle righe: usare
  // l'indice della griglia darebbe un asse che parte da 137 su una selezione
  // fatta a metà pagina.
  const righe = [];
  let n = 0;
  for (const obj of perRiga.values()) {
    n++;
    // Una colonna della tabella chiamata "#" esiste: in quel caso l'ordinale
    // sovrascriverebbe un dato vero, e non si aggiunge.
    if (!viste.has(CAMPO_ORDINE)) obj[CAMPO_ORDINE] = n;
    righe.push(obj);
  }
  return { righe, colonne, tagliate };
}

/** Tipo dedotto (`numero`, `data`, `testo`) per ogni colonna, in una mappa. */
function tipiColonne(righe) {
  const m = new Map();
  for (const f of campiDisponibili(righe)) m.set(f.nome, f);
  return m;
}

/**
 * Colonne della selezione che contengono numeri, cioè quelle proponibili come
 * misura. Serve all'interfaccia (i pulsanti "Misure"): senza, si ritroverebbe a
 * riconoscere i numeri con una regola propria, che prima o poi diverge da questa
 * — e una colonna finirebbe disegnata come serie senza avere il pulsante per
 * spegnerla.
 */
export function colonneNumeriche(righe, colonne) {
  const tipi = tipiColonne(righe || []);
  return (colonne || []).filter((c) => c !== CAMPO_ORDINE && tipi.get(c)?.tipo === 'numero');
}

/**
 * Configurazione di partenza del grafico per una selezione.
 *
 * Restituisce una `cfg` compatibile con `costruisciOption` (chart-option.js) e
 * le note da mostrare all'utente: sono avvisi su ciò che il grafico NON dice —
 * righe tagliate, serie in eccesso, nessuna colonna numerica — che nel disegno
 * sarebbero invisibili.
 *
 * @param {{righe:object[], colonne:string[], tagliate?:number}} dati
 * @returns {{cfg:object, note:string[], misure:string[], candidatiX:string[]}}
 */
export function configurazioneSelezione({ righe, colonne, tagliate = 0 }) {
  const cfg = cfgDefault();
  const note = [];
  if (!righe || !righe.length) return { cfg, note, misure: [], candidatiX: [] };

  const tipi = tipiColonne(righe);
  const haOrdine = Object.prototype.hasOwnProperty.call(righe[0], CAMPO_ORDINE) && !colonne.includes(CAMPO_ORDINE);
  const numeriche = colonne.filter((c) => tipi.get(c)?.tipo === 'numero');
  const nonNumeriche = colonne.filter((c) => tipi.get(c)?.tipo !== 'numero');
  const date = nonNumeriche.filter((c) => tipi.get(c)?.tipo === 'data');

  // Asse X: una data è sempre la scelta giusta (un andamento nel tempo); poi una
  // colonna di categorie; se ci sono solo numeri resta l'ordinale della riga —
  // e solo se manca pure quello si sacrifica una colonna numerica, perché senza
  // asse X non c'è grafico.
  const campoX = date[0] || nonNumeriche[0] || (haOrdine ? CAMPO_ORDINE : numeriche[0]) || colonne[0];
  cfg.campoX = campoX;
  cfg.autoX = false; // dedotto dalla SELEZIONE: non va rimpiazzato dai dati
  cfg.assex.tipo = tipi.get(campoX)?.tipo === 'data' ? 'time' : 'category';
  cfg.assex.auto = false;

  // Misure: tutte le colonne numeriche tranne quella finita sull'asse X.
  let misure = numeriche.filter((c) => c !== campoX);
  if (misure.length > CATEGORICA.length) {
    note.push(`Selezionate ${misure.length} colonne numeriche: ne sono mostrate ${CATEGORICA.length}`
      + ' (oltre, i colori distinguibili finiscono). Le altre si aggiungono dal menu delle misure.');
    misure = misure.slice(0, CATEGORICA.length);
  }

  // Raggruppamento: solo se i valori dell'asse X si ripetono davvero (vedi la
  // nota 3 in testa al file). Il conteggio dei distinti si rifà qui e non si
  // legge da `campiDisponibili`, che lo tiene volutamente approssimato (fermo a
  // "molti" e su un campione): qui serve la domanda esatta "ci sono doppioni?".
  cfg.aggrega = campoX !== CAMPO_ORDINE && haDoppioni(righe, campoX);

  if (!misure.length) {
    // Nessuna colonna numerica: l'unico grafico onesto è quante volte compare
    // ogni valore — che su una selezione di categorie è esattamente la domanda
    // ("quanti per regione?").
    const s = serieDefault(0);
    s.tipo = 'bar';
    s.campoY = null;
    s.agg = 'conteggio';
    s.autoY = false;
    s.nome = 'Righe';
    cfg.serie = [s];
    cfg.aggrega = true;
    note.push('Nessuna colonna numerica nella selezione: il grafico conta quante righe hanno lo stesso valore.');
    return { cfg, note: notaTaglio(note, tagliate), misure: [], candidatiX: candidati(colonne, haOrdine) };
  }

  const tipoBase = cfg.assex.tipo === 'time' ? 'line' : 'bar';
  cfg.serie = misure.map((nome, i) => {
    const s = serieDefault(i);
    s.tipo = tipoBase;
    s.campoY = nome;
    s.autoY = false;               // scelta della selezione, non da rimpiazzare
    s.agg = cfg.aggrega ? 'somma' : 'primo';
    return s;
  });

  return { cfg, note: notaTaglio(note, tagliate), misure, candidatiX: candidati(colonne, haOrdine) };
}

/** Chiave di confronto di un valore EJSON (stessa idea di cell-stats.js). */
function chiave(v) {
  if (v === null || v === undefined) return '\0null';
  if (typeof v === 'object') return '\0json' + JSON.stringify(v);
  return typeof v + '\0' + String(v);
}

/** Vero se il campo ha almeno un valore ripetuto (quindi raggruppare unisce qualcosa). */
function haDoppioni(righe, campo) {
  const viste = new Set();
  for (const r of righe) {
    const k = chiave(r[campo]);
    if (viste.has(k)) return true;
    viste.add(k);
  }
  return false;
}

function candidati(colonne, haOrdine) {
  return haOrdine ? [CAMPO_ORDINE, ...colonne] : [...colonne];
}

function notaTaglio(note, tagliate) {
  if (tagliate > 0) {
    note.unshift(`Selezione troppo grande: il grafico mostra le prime ${MAX_RIGHE} righe`
      + ` (${tagliate} escluse). Per l'intero insieme usa una query aggregata.`);
  }
  return note;
}
