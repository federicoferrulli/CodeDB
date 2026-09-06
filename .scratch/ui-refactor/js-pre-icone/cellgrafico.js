'use strict';

/* ---------------------------------------------------------------------------
 * 📈 Grafico della selezione di celle.
 *
 * Sta alla selezione della griglia come `geomulti.js` sta alle geometrie: la
 * finestra che mostra ciò che si è appena evidenziato, senza passare per la tab
 * ⚡ Query & Aggregate. Il caso d'uso è quello di un foglio di calcolo — si
 * trascina su due colonne e si vuole VEDERE la forma di quei numeri — e chiedere
 * di riscrivere la stessa selezione come query per ottenerla sarebbe una
 * richiesta assurda: i dati sono già a schermo.
 *
 * Volutamente NON è il pannello dei grafici della tab Query: lì ci sono sei
 * sezioni di personalizzazione perché quel grafico si tiene; questo si apre, si
 * guarda e si chiude. Le quattro decisioni che contano (tipo, asse, misure,
 * calcolo) stanno in una barra sola sopra il disegno, ed è tutto.
 *
 * La parte che decide COSA disegnare — quale colonna sull'asse, quali serie,
 * se raggruppare — è pura e provata in Node: `cell-chart.js`. Qui restano solo
 * il canvas, i controlli e l'export.
 * ------------------------------------------------------------------------- */

import { $, esc, toast, openModal, closeModal } from './utils.js';
import {
  TIPI, AGGREGAZIONI, AGG_GREZZO, INK, applicaInk, costruisciOption, azzeraAvvisi, prendiAvvisi,
  famigliaDi, serieDefault, CATEGORICA,
} from './chart-option.js';
import { caricaEcharts, inkDalTema } from './chart-runtime.js';
import { datiSelezione, configurazioneSelezione, colonneNumeriche, CAMPO_ORDINE } from './cell-chart.js';
import { precalcolaGraficoAsync } from './calcoli.js';

/* ----------------------------- Stato del pannello ------------------------ */

let righe = [];
let misureDisponibili = [];
let candidatiX = [];
let cfg = null;
let noteBase = [];
let grafico = null;
let osservatore = null;
let timerRidisegno = 0;

/**
 * Apre la finestra sul contenuto della selezione.
 *
 * @param {{voci:{valore:any,colonna:string,riga:number}[], titolo?:string}} arg
 */
export function apriGraficoSelezione({ voci, titolo } = {}) {
  const dati = datiSelezione(voci);
  if (!dati.righe.length || !dati.colonne.length) {
    toast('Seleziona prima delle celle da rappresentare', true);
    return;
  }

  const conf = configurazioneSelezione(dati);
  righe = dati.righe;
  cfg = conf.cfg;
  noteBase = conf.note;
  candidatiX = conf.candidatiX;
  // Le misure OFFERTE nella barra sono tutte le colonne numeriche selezionate,
  // non solo quelle accese all'apertura: quelle oltre l'ottava e quella finita
  // sull'asse X devono poter essere accese: altrimenti la nota che le annuncia
  // sarebbe una beffa e cambiare asse lascerebbe una colonna irraggiungibile.
  misureDisponibili = colonneNumeriche(righe, dati.colonne);

  costruisciModale();
  const t = $('#cellchart-title');
  if (t) t.textContent = titolo ? `📈 Grafico della selezione — ${titolo}` : '📈 Grafico della selezione';
  openModal('#cellchart-overlay');
  costruisciBarra();
  disegna();
}

/** Le misure attualmente rappresentate (una serie per colonna). */
function misureAttive() {
  return cfg.serie.map((s) => s.campoY).filter(Boolean);
}

/* -------------------------------- Modale --------------------------------- */

function costruisciModale() {
  if (document.getElementById('cellchart-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'cellchart-overlay';
  overlay.className = 'overlay hidden';
  overlay.innerHTML = `
    <div class="modal wide cellchart-modal">
      <h2 id="cellchart-title">📈 Grafico della selezione</h2>
      <div id="cellchart-bar" class="cellchart-bar"></div>
      <div id="cellchart-note" class="cellchart-note hidden"></div>
      <div id="cellchart-canvas" class="cellchart-canvas"></div>
      <div class="modal-actions">
        <button id="cellchart-png" class="ghost">Esporta PNG</button>
        <button id="cellchart-close" class="primary">Chiudi</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('cellchart-close').addEventListener('click', () => chiudi());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) chiudi(); });
  document.getElementById('cellchart-png').addEventListener('click', esportaPng);

  const barra = document.getElementById('cellchart-bar');
  barra.addEventListener('change', (e) => {
    const el = e.target.closest('[data-campo]');
    if (!el) return;
    applicaControllo(el.dataset.campo, el.value);
  });
  barra.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-misura]');
    if (!chip) return;
    commutaMisura(chip.dataset.misura);
  });

  // Il disegno è su canvas: al cambio tema non si ritinge da solo come il resto
  // della pagina, va ricostruita l'option — ma solo se la finestra è aperta.
  document.addEventListener('codedb:tema', () => { if (visibile()) disegna(); });
}

function visibile() {
  const ov = document.getElementById('cellchart-overlay');
  return !!ov && !ov.classList.contains('hidden');
}

function chiudi() {
  closeModal('#cellchart-overlay');
  // L'istanza si smonta: una selezione può essere grande, e tenerne in vita il
  // canvas (con il suo ResizeObserver) dopo che la finestra è sparita significa
  // pagare memoria e ridisegni per un grafico che nessuno vede.
  if (osservatore) { osservatore.disconnect(); osservatore = null; }
  if (grafico && !grafico.isDisposed()) grafico.dispose();
  grafico = null;
  righe = [];
}

/* -------------------------------- Barra ---------------------------------- */

function opzioni(lista, scelto) {
  return lista.map((o) => {
    const v = typeof o === 'string' ? o : o.v;
    const et = typeof o === 'string' ? o : (o.et || o.v);
    return `<option value="${esc(String(v))}"${String(v) === String(scelto ?? '') ? ' selected' : ''}>${esc(String(et))}</option>`;
  }).join('');
}

function costruisciBarra() {
  const barra = $('#cellchart-bar');
  if (!barra || !cfg) return;
  const prima = cfg.serie[0] || serieDefault(0);
  const fam = famigliaDi(prima.tipo);
  const attive = new Set(misureAttive());
  const etichettaX = fam === 'circolare' ? 'Fette' : 'Asse X';
  // La colonna sull'asse non compare fra le misure: una serie che disegna sé
  // stessa contro sé stessa è una diagonale che non dice nulla.
  const misure = misureDisponibili.filter((m) => m !== cfg.campoX);

  barra.innerHTML = `
    <label class="cellchart-campo">
      <span>Tipo</span>
      <select data-campo="tipo">${opzioni(TIPI.map((t) => ({ v: t.v, et: t.et })), prima.tipo)}</select>
    </label>
    <label class="cellchart-campo">
      <span>${esc(etichettaX)}</span>
      <select data-campo="campoX">${opzioni(candidatiX.map((c) => ({
    v: c, et: c === CAMPO_ORDINE ? '# (ordine di riga)' : c,
  })), cfg.campoX)}</select>
    </label>
    <label class="cellchart-campo">
      <span>Calcolo</span>
      <select data-campo="agg" title="${esc(cfg.aggrega
    ? 'Le righe con lo stesso valore sull\'asse X vengono raggruppate e su ognuna si applica questo calcolo.'
    : 'Nessun raggruppamento: una riga della selezione = un punto, col valore così com\'è.')}">${opzioni(
    [{ v: AGG_GREZZO, et: 'Valori grezzi (nessun calcolo)' }].concat(AGGREGAZIONI),
    cfg.aggrega ? prima.agg : AGG_GREZZO,
  )}</select>
    </label>
    ${misure.length ? `
    <div class="cellchart-misure">
      <span>Misure</span>
      ${misure.map((m) => `<button type="button" class="cellchart-chip${attive.has(m) ? ' attiva' : ''}"
        data-misura="${esc(m)}" title="${attive.has(m) ? 'Togli' : 'Aggiungi'} la colonna dal grafico">${esc(m)}</button>`).join('')}
    </div>` : '<span class="cellchart-solo-conteggio">Conteggio delle righe per valore</span>'}
    <span class="cellchart-conta">${righe.length} righe</span>`;
}

function applicaControllo(campo, valore) {
  if (campo === 'tipo') {
    cfg.serie.forEach((s) => { s.tipo = valore; });
    // Un asse temporale su una torta non significa nulla e le famiglie non
    // cartesiane ignorano comunque l'asse: si lascia com'è, ci pensa
    // `costruisciOption`.
  } else if (campo === 'campoX') {
    cfg.campoX = valore;
    cfg.assex.tipo = valore === CAMPO_ORDINE ? 'category' : cfg.assex.tipo;
    // La colonna scelta come asse non può restare anche una misura: sarebbe una
    // serie che disegna sé stessa contro sé stessa.
    if (misureAttive().includes(valore)) {
      if (misureAttive().length > 1) {
        commutaMisura(valore, { ridisegna: false });
      } else {
        // Era l'unica misura: invece di rifiutare il cambio d'asse (l'utente ha
        // chiesto una cosa sensata) il grafico passa a contare le righe, che è
        // l'unica domanda rimasta con zero colonne da misurare.
        const s = cfg.serie[0];
        s.campoY = null;
        s.agg = 'conteggio';
        s.nome = 'Righe';
        cfg.serie = [s];
        cfg.aggrega = true;
      }
    }
  } else if (campo === 'agg') {
    if (valore === AGG_GREZZO) {
      cfg.aggrega = false;
      cfg.serie.forEach((s) => { if (s.agg === 'conteggio') s.agg = 'primo'; });
    } else {
      cfg.aggrega = true;
      cfg.serie.forEach((s) => { s.agg = valore; });
    }
  }
  costruisciBarra();
  disegna();
}

function commutaMisura(nome, { ridisegna = true } = {}) {
  const attive = misureAttive();
  const modello = cfg.serie[0] || serieDefault(0);
  if (attive.includes(nome)) {
    if (attive.length <= 1) { toast('Serve almeno una misura da rappresentare', true); return; }
    cfg.serie = cfg.serie.filter((s) => s.campoY !== nome);
  } else {
    if (cfg.serie.length >= CATEGORICA.length) {
      toast(`Massimo ${CATEGORICA.length} misure insieme: oltre, i colori distinguibili finiscono.`, true);
      return;
    }
    // Lo slot di colore è il primo LIBERO: togliendo una misura in mezzo, la
    // successiva non eredita il colore di un'altra serie ancora a schermo.
    const usati = new Set(cfg.serie.map((s) => s.slot));
    let slot = 0;
    while (usati.has(slot) && slot < CATEGORICA.length) slot++;
    const s = serieDefault(slot);
    s.slot = slot % CATEGORICA.length;
    s.tipo = modello.tipo;
    s.agg = modello.agg === 'conteggio' ? 'somma' : modello.agg;
    s.campoY = nome;
    s.autoY = false;
    // La serie "conteggio righe" (nessuna colonna da misurare) esiste solo
    // finché non c'è una misura vera: accanto a una colonna misurata sarebbe una
    // seconda barra alta 1 su ogni categoria.
    cfg.serie = cfg.serie.filter((x) => x.campoY);
    cfg.serie.push(s);
  }
  if (ridisegna) { costruisciBarra(); disegna(); }
}

/* ------------------------------- Disegno --------------------------------- */

function mostraNote(lista) {
  const el = $('#cellchart-note');
  if (!el) return;
  const uniche = Array.from(new Set(lista.filter(Boolean)));
  el.classList.toggle('hidden', !uniche.length);
  el.innerHTML = uniche.map((n) => `<div>${esc(n)}</div>`).join('');
}

async function disegna() {
  const contenitore = $('#cellchart-canvas');
  if (!contenitore || !cfg || !righe.length) return;

  let echarts;
  try {
    echarts = await caricaEcharts();
  } catch (err) {
    mostraNote([err.message]);
    return;
  }
  // Fra l'await e qui l'utente può aver chiuso la finestra: inizializzare ora
  // creerebbe un canvas su un contenitore nascosto (dimensioni 0) e lascerebbe
  // in vita un osservatore per un grafico mai visto.
  if (!visibile()) return;

  if (!grafico || grafico.isDisposed()) {
    grafico = echarts.init(contenitore, null, { renderer: 'canvas' });
    if (typeof ResizeObserver !== 'undefined') {
      if (osservatore) osservatore.disconnect();
      // Ridisegno completo e non semplice `resize`: margini e barra di zoom
      // dipendono dalle dimensioni del riquadro (vedi grigliaAdattata).
      osservatore = new ResizeObserver(() => {
        if (!grafico || grafico.isDisposed() || !visibile()) return;
        clearTimeout(timerRidisegno);
        timerRidisegno = setTimeout(disegna, 120);
      });
      osservatore.observe(contenitore);
    }
  }

  applicaInk(inkDalTema());
  azzeraAvvisi();
  let option;
  try {
    // Come nella vista Grafici: il precalcolo può finire su un Web Worker (una
    // selezione può contenere centinaia di migliaia di celle), il disegno no.
    const pre = await precalcolaGraficoAsync(righe, cfg);
    option = costruisciOption(righe, cfg, {
      larghezza: contenitore.clientWidth,
      altezza: contenitore.clientHeight,
    }, pre);
  } catch (err) {
    console.error('[Grafico selezione] Errore nella costruzione del grafico:', err);
    mostraNote([`Impossibile costruire il grafico: ${err.message}`]);
    return;
  }
  grafico.setOption(option, { notMerge: true });
  grafico.resize();
  mostraNote(noteBase.concat(prendiAvvisi()));
}

function esportaPng() {
  if (!grafico || grafico.isDisposed()) { toast('Nessun grafico da esportare.', true); return; }
  // Fondo pieno, non trasparente: un PNG trasparente incollato in un documento
  // chiaro mostra assi ed etichette chiari su bianco, cioè illeggibili.
  const url = grafico.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: INK.fondo });
  const a = document.createElement('a');
  a.href = url;
  a.download = `selezione_${Date.now()}.png`;
  a.click();
  toast('Grafico esportato in PNG.');
}
