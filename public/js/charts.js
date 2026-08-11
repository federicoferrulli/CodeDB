'use strict';

/* ---------------------------------------------------------------------------
 * Custom Charts: la terza vista dei risultati della tab ⚡ Query & Aggregate,
 * accanto a Tabella e JSON Tree.
 *
 * Perché esiste: il risultato di una query è già una tabella e un albero JSON —
 * quello che manca è VEDERE la forma dei dati (un andamento nel tempo, una
 * distribuzione, un confronto fra categorie) senza esportarli in un altro
 * programma. Qui si scelgono i campi da rappresentare, si compongono una o più
 * serie ("trace") e si regola ogni parte del grafico: assi, legenda, tooltip,
 * griglia, zoom, etichette, tavolozza.
 *
 * Questo modulo è l'INTERFACCIA: caricamento della libreria, canvas, pannello di
 * personalizzazione, export, preimpostazioni. La trasformazione dai risultati
 * all'`option` di ECharts sta in `chart-option.js`, che non tocca il DOM ed è
 * provato da `test/unit-charts.js` — lì stanno anche le tre scelte di progetto
 * che governano l'aspetto (nessun secondo asse Y, tavolozza in ordine fisso mai
 * ciclata, testo che non prende il colore del dato) e la spiegazione del perché.
 *
 * ECharts è VENDORIZZATO in public/vendor/echarts (nessuna build, nessuna CDN,
 * coerente con Leaflet in public/vendor/leaflet) e viene caricato solo alla
 * prima apertura di questa vista: chi non disegna grafici non paga 1,1 MB.
 *
 * Chi ha bisogno di qualcosa che il pannello non copre non resta a mani vuote:
 * la casella "Override JSON" accetta un frammento di `option` che viene fuso
 * sopra quello generato, quindi qualunque opzione della libreria è raggiungibile
 * senza toccare questo file.
 * ------------------------------------------------------------------------- */

import { $, toast, esc, safeUUID, positionFixedDropdown, chiediTesto } from './utils.js';
import { state } from './state.js';
import {
  CATEGORICA, TAVOLOZZE, TIPI, AGGREGAZIONI, AGG_GREZZO, famigliaDi, serieDefault, cfgDefault,
  campiDisponibili, costruisciOption, coloreSerie, suggerimenti, azzeraAvvisi, prendiAvvisi, INK,
  applicaInk,
} from './chart-option.js';
import { tokenTema } from './theme.js';

/**
 * La cromatura del grafico letta dai token del tema in vigore.
 *
 * Nomi delle chiavi = quelli di `INK`; i valori sono token CSS. Se un token
 * manca, `tokenTema` torna stringa vuota e `applicaInk` lascia il valore
 * precedente: meglio la cromatura del tema scuro che un `color: ''`, che
 * ECharts accetta e disegna nero su nero.
 */
function inkDalTema() {
  return {
    fondo: tokenTema('--bg-surface'),
    primario: tokenTema('--fg'),
    secondario: tokenTema('--chart-text') || tokenTema('--fg-dim'),
    muto: tokenTema('--chart-text') || tokenTema('--fg-dim'),
    griglia: tokenTema('--chart-grid'),
    asse: tokenTema('--chart-axis'),
    tooltipFondo: tokenTema('--bg-elevated'),
    tooltipBordo: tokenTema('--border-2'),
    // NON segue il tema: sta dentro un segmento colorato dalla tavolozza
    // categorica, che è fissa. Legarlo a `--fg` renderebbe l'etichetta nera
    // dentro una barra scura appena si passa al tema chiaro.
    suColore: '#ffffff',
    zoomFondo: tokenTema('--ov-40'),
    zoomArea: tokenTema('--ov-60'),
    zoomSelezione: tokenTema('--accent-glow'),
    zoomManiglia: tokenTema('--accent'),
  };
}

/* --------------------------- Stato dell'interfaccia ---------------------- */

let righeCorrenti = [];
let grafico = null;      // istanza ECharts
let osservatore = null;  // ResizeObserver del contenitore
let ultimoOption = null; // option effettivamente applicata (per l'export JSON)
let timerRidisegno = 0;  // debounce del ridisegno su cambio dimensioni

/* ============================ Caricamento libreria ======================== */

let echarts = null;
let caricamento = null;

function caricaRisorsa(tag, attrs) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    Object.assign(el, attrs);
    el.addEventListener('load', () => resolve());
    el.addEventListener('error', () => reject(new Error('Impossibile caricare ECharts da public/vendor/echarts.')));
    document.head.appendChild(el);
  });
}

async function caricaEcharts() {
  if (echarts) return echarts;
  if (!caricamento) {
    caricamento = (async () => {
      await caricaRisorsa('script', { src: '/vendor/echarts/echarts.min.js' });
      if (!window.echarts) throw new Error('ECharts caricato ma non disponibile (window.echarts assente).');
      echarts = window.echarts;
      return echarts;
    })().catch((err) => { caricamento = null; throw err; });
  }
  return caricamento;
}

/** Configurazione del tab attivo, creata alla prima richiesta. */
function cfg() {
  if (!state.chartCfg) state.chartCfg = cfgDefault();
  // Un tab ripristinato da una sessione precedente potrebbe non avere i campi
  // aggiunti dopo: si completano senza perdere ciò che l'utente ha impostato.
  const base = cfgDefault();
  const c = state.chartCfg;
  for (const k of Object.keys(base)) {
    if (c[k] === undefined) c[k] = base[k];
    else if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      for (const k2 of Object.keys(base[k])) if (c[k][k2] === undefined) c[k][k2] = base[k][k2];
    }
  }
  if (!Array.isArray(c.serie) || !c.serie.length) c.serie = [serieDefault(0)];
  return c;
}

/* =========================== Fusione dell'override ======================= */

/**
 * Fusione profonda dell'override JSON sopra l'option generata.
 *
 * È la valvola di sfogo del pannello: qualunque opzione di ECharts che qui non
 * abbia un controllo resta raggiungibile senza modificare il codice. Gli array
 * (es. `series`) si fondono per POSIZIONE, così si può ritoccare la prima serie
 * senza riscriverle tutte.
 */
function fondi(base, sopra) {
  if (Array.isArray(base) && Array.isArray(sopra)) {
    const out = base.slice();
    sopra.forEach((v, i) => { out[i] = (v && typeof v === 'object' && out[i] && typeof out[i] === 'object') ? fondi(out[i], v) : v; });
    return out;
  }
  if (base && typeof base === 'object' && sopra && typeof sopra === 'object' && !Array.isArray(sopra)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(sopra)) {
      out[k] = (v && typeof v === 'object' && base[k] && typeof base[k] === 'object') ? fondi(base[k], v) : v;
    }
    return out;
  }
  return sopra;
}

/* ============================== Rendering ================================ */

/**
 * Sceglie da sé un asse X e una misura sensati, così la prima apertura mostra
 * già un grafico invece di un riquadro vuoto da configurare.
 *
 * La regola che conta è la seconda: un campo scelto DALL'UTENTE non si tocca
 * mai, uno indovinato da qui si rivaluta quando cambiano le colonne. Senza la
 * distinzione, passando da un `$group` a una `find` il campo indovinato prima
 * (tipicamente `_id`) restava, e l'asse diventava un elenco di 400 ObjectId
 * distinti: un grafico illeggibile che sembra un difetto del programma. Con la
 * distinzione, chi ha scelto a mano la sua colonna se la ritrova comunque.
 */
function autoConfigura(righe, c) {
  const campi = campiDisponibili(righe);
  if (!campi.length) return;
  const nomi = new Set(campi.map((f) => f.nome));

  if (c.autoX !== false || !c.campoX || !nomi.has(c.campoX)) {
    const data = campi.find((f) => f.tipo === 'data');
    const testo = campi.find((f) => f.tipo === 'testo' && !/(^|\.)_id$/.test(f.nome));
    const scelto = data || testo || campi[0];
    if (scelto.nome !== c.campoX) {
      c.campoX = scelto.nome;
      allineaAsseX(c, scelto.tipo);
    }
    c.autoX = true;
  }

  for (const s of c.serie) {
    if (s.autoY === false && s.campoY && nomi.has(s.campoY)) continue;
    if (s.autoY === false && !s.campoY && s.agg === 'conteggio') continue; // conteggio: il campo non serve
    const num = campi.find((f) => f.tipo === 'numero' && f.nome !== c.campoX);
    if (num) {
      s.campoY = num.nome;
    } else if (!c.aggrega) {
      // Senza raggruppamento "conteggio" varrebbe 1 su ogni punto, cioè una
      // riga piatta che sembra un dato: meglio nessuna misura e l'avviso.
      s.campoY = null;
    } else {
      // Nessuna colonna numerica: l'unica misura sensata è contare le righe per
      // categoria (ed è quasi sempre quello che si vuole da un elenco).
      s.campoY = null;
      s.agg = 'conteggio';
    }
    s.autoY = true;
  }
}

/**
 * Il tipo dell'asse X segue il TIPO DEL CAMPO, finché non è l'utente a sceglierlo.
 *
 * Un campo data merita un asse temporale (le distanze fra i punti diventano
 * proporzionali al tempo trascorso invece che tutte uguali); una colonna di testo
 * no — e lasciarci un asse temporale non dà un grafico impreciso, ne dà uno
 * VUOTO, perché nessun valore è un istante. Era il caso che capitava da solo:
 * l'asse dedotto da `createdAt`, poi il campo cambiato in `name` dalla barra
 * rapida e il tipo dell'asse rimasto indietro.
 */
function allineaAsseX(c, tipoCampo) {
  if (c.assex.auto === false) return; // scelta esplicita: non si tocca
  // Solo data → tempo. Un campo numerico resta "categorie": l'asse `value` vuole
  // punti come coppie [x, y], che si costruiscono per il tempo e per la
  // dispersione — su barre e linee darebbe un grafico vuoto.
  c.assex.tipo = tipoCampo === 'data' ? 'time' : 'category';
}

/** Chiamata da query-tab quando la vista Chart è attiva o i risultati cambiano. */
export async function renderChart(righe) {
  righeCorrenti = Array.isArray(righe) ? righe : [];
  const contenitore = $('#query-chart-canvas');
  if (!contenitore) return;

  const vuoto = $('#chart-empty');
  if (!righeCorrenti.length) {
    if (grafico) { grafico.clear(); }
    if (vuoto) {
      vuoto.classList.remove('hidden');
      vuoto.textContent = 'Esegui una query: i risultati compaiono qui come grafico.';
    }
    aggiornaAvvisi([]);
    return;
  }
  if (vuoto) vuoto.classList.add('hidden');

  const c = cfg();
  autoConfigura(righeCorrenti, c);

  try {
    await caricaEcharts();
  } catch (err) {
    if (vuoto) { vuoto.classList.remove('hidden'); vuoto.textContent = err.message; }
    return;
  }

  if (!grafico || grafico.isDisposed()) {
    grafico = echarts.init(contenitore, null, { renderer: 'canvas' });
    if (typeof ResizeObserver !== 'undefined') {
      if (osservatore) osservatore.disconnect();
      // Il ridisegno passa da `disegna` e non da un semplice `resize`: margini e
      // presenza dello slider dipendono dall'altezza, quindi cambiare
      // dimensione cambia l'option, non solo la scala del disegno.
      osservatore = new ResizeObserver(() => {
        if (!grafico || grafico.isDisposed()) return;
        clearTimeout(timerRidisegno);
        timerRidisegno = setTimeout(() => { if ($('#query-chart-canvas')) disegna(); }, 120);
      });
      osservatore.observe(contenitore);
    }
  }

  // Il canvas non eredita nulla dal CSS: la cromatura del grafico va LETTA dai
  // token e passata al costruttore dell'option a ogni disegno, altrimenti sul
  // tema chiaro assi ed etichette restano grigio chiaro su bianco.
  applicaInk(inkDalTema());

  azzeraAvvisi();
  const noteExtra = [];
  let option;
  try {
    // Le dimensioni VERE del riquadro: da qui dipendono i margini e il fatto di
    // disegnare o no la barra di zoom (vedi grigliaAdattata in chart-option.js).
    option = costruisciOption(righeCorrenti, c, {
      larghezza: contenitore.clientWidth,
      altezza: contenitore.clientHeight,
    });
  } catch (err) {
    console.error('[Charts] Errore nella costruzione del grafico:', err);
    aggiornaAvvisi([`Impossibile costruire il grafico: ${err.message}`]);
    return;
  }

  if (c.overrideAttivo && c.override.trim()) {
    try {
      option = fondi(option, JSON.parse(c.override));
    } catch (err) {
      noteExtra.push(`Override JSON ignorato: ${err.message}`);
    }
  }

  ultimoOption = option;
  // `notMerge: true`: senza, togliendo una serie o passando da barre a torta
  // resterebbero i pezzi della configurazione precedente sovrapposti alla nuova.
  grafico.setOption(option, { notMerge: true });
  grafico.resize();
  aggiornaAvvisi(prendiAvvisi().concat(noteExtra));
  aggiornaPannello();
  costruisciBarraRapida();
}

function aggiornaAvvisi(lista) {
  const el = $('#chart-notes');
  if (!el) return;
  const uniche = Array.from(new Set(lista));
  if (!uniche.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = uniche.map((n) => `<div class="chart-note">${esc(n)}</div>`).join('');
}

/** Ridisegna con i dati già in memoria (usata da ogni modifica del pannello). */
function disegna() {
  renderChart(righeCorrenti);
}

/** Il contenitore è nascosto quando si cambia vista: al ritorno va rimisurato. */
export function resizeChart() {
  if (grafico && !grafico.isDisposed()) grafico.resize();
}

/* ============================ Pannello (builder) ========================= */

/*
 * Il pannello si GENERA da qui invece di stare in index.html: sono decine di
 * controlli, la metà dei quali dipende dal tipo di grafico e dalle colonne del
 * result set corrente (che non si conoscono a priori). Scriverli a mano nel
 * markup significherebbe tenere allineati due elenchi di campi.
 *
 * Ogni controllo dichiara `data-path` (dove scrivere nella configurazione) e,
 * quando serve, `data-serie` (in quale serie). Un solo gestore delegato legge il
 * valore, lo scrive e ridisegna: niente un listener per campo.
 */

let campiCache = [];

function opzioni(lista, sel) {
  return lista.map((o) => {
    const v = typeof o === 'string' ? o : o.v;
    const et = typeof o === 'string' ? o : (o.et || o.v);
    return `<option value="${esc(String(v))}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(String(et))}</option>`;
  }).join('');
}

function opzioniCampi(sel) {
  const lista = campiCache;
  // Il tipo si scrive DOPO il nome e per esteso: come prefisso (`A _id`,
  // `# importo`) sembrava parte del nome della colonna, e proprio nel menu in
  // cui si cerca una colonna per nome.
  return `<option value="">— nessuno —</option>` + lista.map((f) => (
    `<option value="${esc(f.nome)}"${f.nome === (sel || '') ? ' selected' : ''}>${esc(f.nome)} — ${esc(f.tipo)}</option>`
  )).join('');
}

const riga = (etichetta, controllo, nota) => `
  <label class="chart-field">
    <span class="chart-field-label">${esc(etichetta)}</span>
    ${controllo}
    ${nota ? `<span class="chart-field-hint">${esc(nota)}</span>` : ''}
  </label>`;

const sel = (path, lista, valore, extra = '') => `<select data-path="${path}" ${extra}>${opzioni(lista, valore)}</select>`;
const num = (path, valore, min, max, step = 1) => `<input type="number" data-path="${path}" value="${valore ?? ''}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} step="${step}">`;
const txt = (path, valore, ph = '') => `<input type="text" data-path="${path}" value="${esc(String(valore ?? ''))}" placeholder="${esc(ph)}">`;
const chk = (path, valore, etichetta, extra = '') => `
  <label class="chart-check">
    <input type="checkbox" data-path="${path}"${valore ? ' checked' : ''} ${extra}>
    <span>${esc(etichetta)}</span>
  </label>`;

function pannelloSerie(s, i, c) {
  const fam = famigliaDi(s.tipo);
  const colore = coloreSerie(s, i, c.tavolozza);
  const cartesiano = fam === 'cartesiano';
  const linea = s.tipo === 'line' || s.tipo === 'area';
  const d = `data-serie="${s.id}"`;

  return `
  <div class="chart-serie${s.visibile === false ? ' spenta' : ''}" data-serie-box="${s.id}">
    <div class="chart-serie-head">
      <span class="chart-serie-dot" style="background:${esc(colore)}"></span>
      <strong>${esc(s.nome || s.campoY || `Serie ${i + 1}`)}</strong>
      <span class="chart-serie-tipo">${esc((TIPI.find((t) => t.v === s.tipo) || {}).et || s.tipo)}</span>
      <span class="chart-serie-actions">
        <button type="button" class="mini-btn ghost" data-azione="serie-visibile" ${d} title="${s.visibile === false ? 'Mostra' : 'Nascondi'} la serie">${s.visibile === false ? '👁' : '🚫'}</button>
        <button type="button" class="mini-btn ghost" data-azione="serie-duplica" ${d} title="Duplica la serie">⧉</button>
        <button type="button" class="mini-btn ghost danger" data-azione="serie-rimuovi" ${d} title="Rimuovi la serie">✕</button>
      </span>
    </div>
    <div class="chart-serie-body">
      ${riga('Tipo', `<select data-path="tipo" ${d} data-ricostruisci="1">${opzioni(TIPI.map((t) => ({ v: t.v, et: t.et })), s.tipo)}</select>`)}
      ${riga('Nome (legenda)', `<input type="text" data-path="nome" ${d} value="${esc(s.nome)}" placeholder="${esc(s.campoY || 'automatico')}">`)}
      ${riga('Campo valore (Y)', `<select data-path="campoY" ${d}>${opzioniCampi(s.campoY)}</select>`, s.agg === 'conteggio' ? 'Con "Conteggio righe" il campo non serve.' : '')}
      ${fam === 'heatmap' ? riga('Campo categoria Y', `<select data-path="campoY2" ${d}>${opzioniCampi(s.campoY2)}</select>`, 'La mappa di calore incrocia due categorie.') : ''}
      ${c.aggrega ? riga('Aggregazione', `<select data-path="agg" ${d}>${opzioni(AGGREGAZIONI, s.agg)}</select>`) : ''}
      <div class="chart-field">
        <span class="chart-field-label">Colore</span>
        <span class="chart-color-row">
          <input type="color" data-path="colore" ${d} value="${esc(colore)}">
          <button type="button" class="mini-btn ghost" data-azione="colore-auto" ${d} title="Torna al colore della tavolozza">Auto</button>
          ${s.colore ? '<span class="chart-field-hint">manuale</span>' : `<span class="chart-field-hint">slot ${(Number.isInteger(s.slot) ? s.slot : i) % CATEGORICA.length + 1}</span>`}
        </span>
      </div>
      ${cartesiano ? riga('Impila con (nome gruppo)', `<input type="text" data-path="stack" ${d} value="${esc(s.stack)}" placeholder="vuoto = non impilata">`, 'Stesso nome su più serie = barre/aree impilate.') : ''}
      ${linea ? chk('smooth', s.smooth, 'Linea morbida', d) : ''}
      ${s.tipo === 'area' || s.tipo === 'radar' ? riga('Opacità area (%)', `<input type="number" data-path="areaOpacita" ${d} value="${s.areaOpacita}" min="0" max="60" step="5">`, 'Una velatura: sopra il 20% copre griglia e serie sotto.') : ''}
      ${linea ? riga('Spessore linea', `<input type="number" data-path="larghezzaLinea" ${d} value="${s.larghezzaLinea}" min="1" max="6">`) : ''}
      ${(linea || s.tipo === 'scatter') ? riga('Simbolo', `<select data-path="simbolo" ${d}>${opzioni(['circle', 'rect', 'roundRect', 'triangle', 'diamond', 'pin', 'arrow', 'none'], s.simbolo)}</select>`) : ''}
      ${(linea || s.tipo === 'scatter') ? riga('Dimensione simbolo', `<input type="number" data-path="dimSimbolo" ${d} value="${s.dimSimbolo}" min="8" max="40">`, 'Minimo 8px: sotto non si colpisce col mouse.') : ''}
      ${s.tipo === 'bar' ? riga('Spessore max barra', `<input type="number" data-path="barMax" ${d} value="${s.barMax}" min="4" max="80">`, 'Barra sottile: la fascia non va riempita.') : ''}
      ${chk('etichette', s.etichette, 'Etichette sui valori', d)}
      ${s.etichette && cartesiano ? riga('Posizione etichette', `<select data-path="posEtichette" ${d}>${opzioni(['top', 'inside', 'right', 'left', 'bottom'], s.posEtichette)}</select>`) : ''}
      ${riga('Opacità (%)', `<input type="number" data-path="opacita" ${d} value="${s.opacita}" min="10" max="100" step="5">`)}
    </div>
  </div>`;
}

function costruisciPannello() {
  const host = $('#chart-builder');
  if (!host) return;
  const c = cfg();
  campiCache = righeCorrenti.length ? campiDisponibili(righeCorrenti) : [];
  costruisciSuggeriti();
  const fam = famigliaDi((c.serie.find((s) => s.visibile !== false) || c.serie[0]).tipo);
  const cartesiano = fam === 'cartesiano';

  host.innerHTML = `
    <details class="chart-group" open>
      <summary>Dati</summary>
      <div class="chart-group-body">
        ${riga(fam === 'circolare' ? 'Campo categoria (fette)' : 'Campo asse X', `<select data-path="campoX">${opzioniCampi(c.campoX)}</select>`,
    campiCache.length ? '' : 'Esegui una query per vedere i campi.')}
        ${chk('aggrega', c.aggrega, 'Raggruppa le righe per il campo X', 'data-ricostruisci="1"')}
        <span class="chart-field-hint block">${c.aggrega
    ? 'Le righe con la stessa X collassano in una categoria e si applica l\'aggregazione della serie.'
    : 'Una riga = un punto, col valore della misura così com\'è. È la modalità giusta per vedere l\'andamento reale nel tempo (due misurazioni dello stesso istante restano due punti) e quando la query ha già fatto il GROUP BY.'}</span>
        ${riga('Ordina categorie', sel('ordina', [
      { v: 'nessuno', et: 'Come arrivano' },
      { v: 'x-asc', et: 'Per X crescente' },
      { v: 'x-desc', et: 'Per X decrescente' },
      { v: 'val-desc', et: 'Per valore decrescente' },
      { v: 'val-asc', et: 'Per valore crescente' },
    ], c.ordina))}
        ${riga('Max categorie (0 = tutte)', num('maxCategorie', c.maxCategorie, 0, 500),
    'Oltre questo numero la coda si somma in "Altro": con più di 8 categorie i colori verificati finiscono.')}
      </div>
    </details>

    <details class="chart-group" open>
      <summary>Serie <span class="chart-count">${c.serie.length}</span></summary>
      <div class="chart-group-body">
        <div id="chart-serie-list">${c.serie.map((s, i) => pannelloSerie(s, i, c)).join('')}</div>
        <button type="button" class="mini-btn" data-azione="serie-aggiungi">＋ Aggiungi serie</button>
        ${fam !== 'cartesiano' && fam !== 'radar' ? '<span class="chart-field-hint block">Questa forma mostra una sola serie: le altre sono ignorate.</span>' : ''}
      </div>
    </details>

    <details class="chart-group">
      <summary>Titolo</summary>
      <div class="chart-group-body">
        ${riga('Titolo', txt('titolo', c.titolo, 'nessuno'))}
        ${riga('Sottotitolo', txt('sottotitolo', c.sottotitolo, 'nessuno'))}
      </div>
    </details>

    ${cartesiano ? `
    <details class="chart-group">
      <summary>Assi</summary>
      <div class="chart-group-body">
        ${chk('orizzontale', c.orizzontale, 'Barre orizzontali (scambia gli assi)', 'data-ricostruisci="1"')}
        <div class="chart-subgroup">Asse categorie (X)</div>
        ${riga('Tipo', sel('assex.tipo', [
    { v: 'category', et: 'Categorie' },
    { v: 'time', et: 'Tempo' },
    { v: 'value', et: 'Numerico' },
  ], c.assex.tipo), c.assex.auto === false
    ? 'Scelto a mano: non cambia più da solo al cambio del campo X.'
    : 'Segue il tipo del campo X (data → Tempo). Con "Tempo" le distanze fra i punti sono proporzionali al tempo trascorso; toccandolo diventa una scelta fissa.')}
        ${riga('Nome asse', txt('assex.nome', c.assex.nome, 'nessuno'))}
        ${riga('Rotazione etichette (°)', num('assex.rotazione', c.assex.rotazione, -90, 90, 15))}
        ${chk('assex.griglia', c.assex.griglia, 'Griglia verticale')}
        ${chk('assex.inverti', c.assex.inverti, 'Inverti direzione')}
        <div class="chart-subgroup">Asse valori (Y)</div>
        ${riga('Nome asse', txt('assey.nome', c.assey.nome, 'nessuno'))}
        ${riga('Formato numeri', sel('assey.formato', [
    { v: 'migliaia', et: '1.234,5' },
    { v: 'compatto', et: '1,2 Mln' },
    { v: 'percento', et: '12,3 %' },
    { v: 'byte', et: '1,2 MB' },
    { v: 'grezzo', et: 'grezzo' },
  ], c.assey.formato))}
        ${riga('Minimo', txt('assey.min', c.assey.min, 'automatico'))}
        ${riga('Massimo', txt('assey.max', c.assey.max, 'automatico'))}
        ${chk('assey.griglia', c.assey.griglia, 'Griglia orizzontale')}
        ${chk('assey.log', c.assey.log, 'Scala logaritmica')}
        <span class="chart-field-hint block">Un secondo asse Y non è previsto: allineare due scale diverse fa leggere una correlazione che nei dati non c'è. Due misure di grandezza diversa → due grafici.</span>
      </div>
    </details>` : ''}

    <details class="chart-group">
      <summary>Legenda e tooltip</summary>
      <div class="chart-group-body">
        ${riga('Legenda', sel('legenda.mostra', [
    { v: 'auto', et: 'Automatica (da 2 serie)' },
    { v: 'si', et: 'Sempre' },
    { v: 'no', et: 'Mai' },
  ], c.legenda.mostra), 'Con una sola serie il riquadro ripete il titolo.')}
        ${riga('Posizione', sel('legenda.posizione', [
    { v: 'top', et: 'In alto' },
    { v: 'bottom', et: 'In basso' },
    { v: 'left', et: 'A sinistra' },
    { v: 'right', et: 'A destra' },
  ], c.legenda.posizione))}
        ${chk('tooltip.mostra', c.tooltip.mostra, 'Tooltip al passaggio del mouse')}
        ${riga('Attivazione tooltip', sel('tooltip.trigger', [
    { v: 'auto', et: 'Automatica' },
    { v: 'axis', et: 'Sull\'asse (mirino)' },
    { v: 'item', et: 'Sul singolo segno' },
  ], c.tooltip.trigger))}
      </div>
    </details>

    <details class="chart-group">
      <summary>Aspetto</summary>
      <div class="chart-group-body">
        ${riga('Tavolozza', sel('tavolozza', Object.entries(TAVOLOZZE).map(([v, t]) => ({ v, et: t.etichetta })), c.tavolozza))}
        <div class="chart-palette-preview">
          ${(TAVOLOZZE[c.tavolozza] || TAVOLOZZE.categorica).colori.map((col, i) => `<span title="Slot ${i + 1}: ${col}" style="background:${col}"></span>`).join('')}
        </div>
        ${cartesiano ? chk('zoom', c.zoom, 'Barra di zoom sui dati') : ''}
        ${chk('animazione', c.animazione, 'Animazioni')}
        ${cartesiano ? `
        <div class="chart-subgroup">Margini del riquadro (px)</div>
        <div class="chart-grid-4">
          ${riga('Alto', num('griglia.top', c.griglia.top, 0, 300))}
          ${riga('Basso', num('griglia.bottom', c.griglia.bottom, 0, 300))}
          ${riga('Sinistra', num('griglia.left', c.griglia.left, 0, 300))}
          ${riga('Destra', num('griglia.right', c.griglia.right, 0, 300))}
        </div>` : ''}
      </div>
    </details>

    <details class="chart-group">
      <summary>Override JSON (avanzato)</summary>
      <div class="chart-group-body">
        <span class="chart-field-hint block">Frammento di <code>option</code> ECharts fuso sopra quello generato: da qui è raggiungibile qualunque opzione della libreria che il pannello non copre. Gli array (es. <code>series</code>) si fondono per posizione.</span>
        ${chk('overrideAttivo', c.overrideAttivo, 'Applica l\'override')}
        <textarea data-path="override" id="chart-override" spellcheck="false" rows="8" placeholder='{ "series": [ { "barGap": "10%" } ] }'>${esc(c.override)}</textarea>
        <div class="chart-btn-row">
          <button type="button" class="mini-btn" data-azione="option-copia">Copia option generata</button>
          <button type="button" class="mini-btn ghost" data-azione="override-pulisci">Pulisci</button>
        </div>
      </div>
    </details>

    <details class="chart-group">
      <summary>Preimpostazioni</summary>
      <div class="chart-group-body">
        ${riga('Salvate', `<select id="chart-preset-select">${opzioni([{ v: '', et: '— scegli —' }].concat(nomiPreset().map((n) => ({ v: n, et: n }))), '')}</select>`)}
        <div class="chart-btn-row">
          <button type="button" class="mini-btn" data-azione="preset-carica">Carica</button>
          <button type="button" class="mini-btn" data-azione="preset-salva">Salva come…</button>
          <button type="button" class="mini-btn ghost danger" data-azione="preset-elimina">Elimina</button>
        </div>
        <div class="chart-btn-row">
          <button type="button" class="mini-btn ghost" data-azione="cfg-reset">Ripristina configurazione</button>
        </div>
      </div>
    </details>`;
}

/* ---------------------------- Barra rapida ------------------------------- */

/*
 * Le quattro decisioni che fanno un grafico — tipo, categoria, misura,
 * aggregazione — stanno SEMPRE in vista, sopra il disegno.
 *
 * Prima erano in fondo a un pannello laterale con sei sezioni a fisarmonica:
 * per cambiare da barre a linee si apriva la sezione Serie, si scorreva, si
 * trovava il menu. Sono le quattro cose che si cambiano continuamente, mentre
 * assi, legenda e margini si toccano una volta e restano: il pannello completo
 * resta lì per quelle, chiuso finché non serve.
 */
function costruisciBarraRapida() {
  const host = $('#chart-quickbar');
  if (!host) return;
  const c = cfg();
  const s = c.serie.find((x) => x.visibile !== false) || c.serie[0];
  const fam = famigliaDi(s.tipo);
  const d = `data-serie="${s.id}"`;

  // Firma: si ridisegna solo quando cambia qualcosa che si vede, altrimenti a
  // ogni ridisegno del grafico si perderebbe il menu aperto sotto il mouse.
  const firma = [s.tipo, c.campoX, s.campoY, s.agg, c.aggrega, campiCache.length, c.serie.length].join('|');
  if (host.dataset.firma === firma) return;
  host.dataset.firma = firma;

  const etichettaX = fam === 'circolare' ? 'Fette' : (fam === 'heatmap' ? 'Righe' : 'Asse X');
  host.innerHTML = `
    <label class="chart-quick-field">
      <span>Tipo</span>
      <select data-path="tipo" ${d} data-ricostruisci="1">${opzioni(TIPI.map((t) => ({ v: t.v, et: t.et })), s.tipo)}</select>
    </label>
    <label class="chart-quick-field">
      <span>${esc(etichettaX)}</span>
      <select data-path="campoX">${opzioniCampi(c.campoX)}</select>
    </label>
    ${fam === 'heatmap' ? `
    <label class="chart-quick-field">
      <span>Colonne</span>
      <select data-path="campoY2" ${d}>${opzioniCampi(s.campoY2)}</select>
    </label>` : ''}
    <label class="chart-quick-field">
      <span>Misura</span>
      <select data-path="campoY" ${d}${c.aggrega && s.agg === 'conteggio' ? ' disabled title="Con «Conteggio righe» il campo non serve"' : ''}>${opzioniCampi(s.campoY)}</select>
    </label>
    <label class="chart-quick-field">
      <span>Calcolo</span>
      <select data-path="agg" ${d} data-ricostruisci="1" title="${esc(c.aggrega
    ? 'Le righe con la stessa X vengono raggruppate e su ognuna si applica questo calcolo.'
    : 'Nessun raggruppamento: una riga = un punto, col valore della misura così com\'è.')}">${opzioni(
    [{ v: AGG_GREZZO, et: 'Valori grezzi (nessun calcolo)' }].concat(AGGREGAZIONI),
    c.aggrega ? s.agg : AGG_GREZZO,
  )}</select>
    </label>
    ${c.serie.length > 1 ? `<span class="chart-quick-nota" title="La barra rapida agisce sulla prima serie visibile; le altre si regolano nel pannello">+${c.serie.length - 1} serie</span>` : ''}`;
}

/*
 * Grafici suggeriti: un clic e il grafico è fatto.
 *
 * Le proposte le calcola `suggerimenti()` dalla forma dei risultati (vedi la
 * nota lì). Stanno in un menu a tendina e non in una fila di pulsanti perché in
 * un pannello dei risultati alto 200 px ogni riga fissa di interfaccia è
 * altezza rubata al grafico.
 */
function costruisciSuggeriti() {
  const menu = $('#chart-suggest-menu');
  const btn = $('#chart-suggest-btn');
  if (!menu || !btn) return;
  const lista = suggerimenti(campiCache);
  btn.classList.toggle('hidden', !lista.length);
  menu.innerHTML = lista.map((sug) => (
    `<button type="button" class="dropdown-item" data-suggerimento="${esc(sug.id)}">${esc(sug.etichetta)}</button>`
  )).join('') || '<div class="dropdown-empty">Nessuna proposta per questi dati.</div>';
}

/** Applica una proposta sopra la configurazione corrente. */
function applicaSuggerimento(id) {
  const sug = suggerimenti(campiCache).find((x) => x.id === id);
  if (!sug) return false;
  const c = cfg();
  for (const [k, v] of Object.entries(sug.patch)) {
    // Gli oggetti (assex, assey…) si fondono, così una proposta che imposta il
    // tipo di asse non azzera il nome dell'asse scelto a mano; `serie` è invece
    // una sostituzione voluta.
    if (v && typeof v === 'object' && !Array.isArray(v) && c[k] && typeof c[k] === 'object') Object.assign(c[k], v);
    else c[k] = v;
  }
  return true;
}

/** Aggiorna le sole parti del pannello che dipendono dai dati, senza rifarlo. */
function aggiornaPannello() {
  const host = $('#chart-builder');
  if (!host) return;
  // Il pannello si ricostruisce solo se non è mai stato costruito o se le
  // colonne del result set sono cambiate: rifarlo a ogni ridisegno farebbe
  // perdere il fuoco mentre si digita.
  const firma = campiDisponibili(righeCorrenti).map((f) => `${f.nome}:${f.tipo}`).join('|');
  if (host.dataset.firma !== firma || !host.children.length) {
    const aperti = Array.from(host.querySelectorAll('.chart-group')).map((d) => d.open);
    costruisciPannello();
    host.dataset.firma = firma;
    Array.from(host.querySelectorAll('.chart-group')).forEach((d, i) => { if (aperti[i] !== undefined) d.open = aperti[i]; });
  }
}

/* ---------------------------- Scrittura nella cfg ------------------------ */

function scriviPercorso(obj, percorso, valore) {
  const parti = percorso.split('.');
  let cur = obj;
  for (let i = 0; i < parti.length - 1; i++) {
    if (!cur[parti[i]] || typeof cur[parti[i]] !== 'object') cur[parti[i]] = {};
    cur = cur[parti[i]];
  }
  cur[parti[parti.length - 1]] = valore;
}

function valoreControllo(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? '' : Number(el.value);
  return el.value;
}

function serieDaId(c, id) {
  return c.serie.find((s) => s.id === id);
}

/* ============================ Preimpostazioni ============================ */

const CHIAVE_PRESET = 'codedb:charts:preset';
const CHIAVE_PANNELLO = 'codedb:charts:pannello';

function tuttiPreset() {
  try { return JSON.parse(localStorage.getItem(CHIAVE_PRESET) || '{}'); } catch { return {}; }
}
function nomiPreset() { return Object.keys(tuttiPreset()).sort((a, b) => a.localeCompare(b, 'it')); }
function salvaPreset(nome, c) {
  const tutti = tuttiPreset();
  tutti[nome] = JSON.parse(JSON.stringify(c));
  try { localStorage.setItem(CHIAVE_PRESET, JSON.stringify(tutti)); } catch (err) {
    toast(`Impossibile salvare la preimpostazione: ${err.message}`, true);
  }
}

/* ================================ Export ================================= */

function esportaPng() {
  if (!grafico || grafico.isDisposed()) { toast('Nessun grafico da esportare.', true); return; }
  // Fondo pieno, non trasparente: un PNG trasparente incollato in un documento
  // chiaro mostra assi ed etichette chiari su bianco, cioè illeggibili.
  const url = grafico.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: INK.fondo });
  const a = document.createElement('a');
  a.href = url;
  a.download = `grafico_${Date.now()}.png`;
  a.click();
  toast('Grafico esportato in PNG.');
}

function esportaOption() {
  if (!ultimoOption) { toast('Nessun grafico da esportare.', true); return; }
  // Le funzioni (formattatori) non sono serializzabili: si annotano come stringa
  // invece di sparire in silenzio lasciando un JSON che sembra completo.
  const testo = JSON.stringify(ultimoOption, (k, v) => (typeof v === 'function' ? '[funzione: formattatore]' : v), 2);
  const blob = new Blob([testo], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `echarts_option_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================ Inizializzazione =========================== */

export function initCharts() {
  const host = $('#chart-builder');
  const barra = $('#chart-quickbar');
  if (!host) return;

  // Il grafico è disegnato su canvas: al cambio tema non si ritinge da solo
  // come il resto della pagina, va ricostruita l'option. Si ridisegna solo se
  // c'è davvero un grafico in vita, altrimenti ogni cambio tema pagherebbe una
  // costruzione inutile.
  document.addEventListener('codedb:tema', () => {
    if (grafico && !grafico.isDisposed() && $('#query-chart-canvas')) disegna();
  });

  // Un solo gestore per i controlli del pannello E della barra rapida: ognuno
  // dichiara dove scrivere con data-path (e con data-serie in quale serie),
  // quindi i due gruppi di controlli non hanno bisogno di codice diverso.
  const onCambio = (e) => {
    const el = e.target.closest('[data-path]');
    if (!el || !(host.contains(el) || (barra && barra.contains(el)))) return;
    const c = cfg();
    const path = el.dataset.path;
    const idSerie = el.closest('[data-serie]')?.dataset.serie || el.dataset.serie;

    if (idSerie) {
      const s = serieDaId(c, idSerie);
      if (!s) return;
      // "Calcolo" è un menu solo: le aggregazioni vere stanno nella SERIE, la
      // voce "Valori grezzi" spegne invece il raggruppamento, che è una scelta
      // globale (`c.aggrega`) — non avrebbe senso raggruppare per una serie e
      // non per un'altra, condividendo lo stesso asse X.
      if (path === 'agg' && el.value === AGG_GREZZO) {
        c.aggrega = false;
        // In modalità grezza `agg` non si applica più, tranne 'conteggio' che
        // varrebbe 1 su ogni punto: si torna al valore neutro.
        if (s.agg === 'conteggio') s.agg = 'primo';
        s.autoY = false;
        host.dataset.firma = '';
        if (barra) barra.dataset.firma = '';
        disegna();
        return;
      }
      if (path === 'agg') c.aggrega = true;
      scriviPercorso(s, path, valoreControllo(el));
      // Scelta esplicita: da qui in poi `autoConfigura` non la rimpiazza più
      // quando cambiano le colonne del result set.
      if (path === 'campoY' || path === 'agg') s.autoY = false;
    } else {
      scriviPercorso(c, path, valoreControllo(el));
      if (path === 'campoX') {
        c.autoX = false;
        // Il CAMPO è una scelta dell'utente, il TIPO DELL'ASSE no: va ridedotto,
        // altrimenti un asse temporale rimasto da un campo data scarta ogni
        // punto del campo di testo appena scelto.
        allineaAsseX(c, (campiCache.find((f) => f.nome === c.campoX) || {}).tipo);
        host.dataset.firma = '';
        if (barra) barra.dataset.firma = '';
      }
      // Il tipo di asse scelto a mano non va più ridedotto da nessuno.
      if (path === 'assex.tipo') c.assex.auto = false;
    }

    if (el.dataset.ricostruisci) {
      // Cambiare tipo o calcolo cambia QUALI controlli hanno senso: si
      // ricostruiscono sia il pannello sia la barra rapida.
      host.dataset.firma = '';
      if (barra) barra.dataset.firma = '';
    }
    disegna();
  };

  // `change` per select/checkbox/color, `input` con debounce per il testo: senza
  // il ritardo ogni tasto premuto in un campo di testo ridisegnerebbe il
  // grafico, e su decine di migliaia di righe si sentirebbe.
  host.addEventListener('change', onCambio);
  if (barra) barra.addEventListener('change', onCambio);
  let timer = 0;
  host.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.matches('input[type="text"], input[type="number"], textarea')) return;
    clearTimeout(timer);
    timer = setTimeout(() => onCambio(e), 300);
  });

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-azione]');
    if (!btn) return;
    const c = cfg();
    const id = btn.dataset.serie;
    const azione = btn.dataset.azione;
    let ricostruisci = true;

    if (azione === 'serie-aggiungi') {
      if (c.serie.length >= 12) { toast('Massimo 12 serie: oltre, il grafico non si legge più.', true); return; }
      // Lo slot di colore è il primo LIBERO, non la lunghezza dell'elenco: dopo
      // aver rimosso una serie in mezzo, la nuova non ruba il colore di un'altra.
      const usati = new Set(c.serie.map((s) => s.slot));
      let slot = 0;
      while (usati.has(slot) && slot < CATEGORICA.length) slot++;
      const nuova = serieDefault(slot);
      nuova.slot = slot % CATEGORICA.length;
      nuova.tipo = c.serie[0]?.tipo || 'bar';
      nuova.agg = c.serie[0]?.agg || 'somma';
      c.serie.push(nuova);
      if (c.serie.length > CATEGORICA.length) {
        toast('Oltre 8 serie i colori verificati finiscono: meglio dividere in più grafici.', true);
      }
    } else if (azione === 'serie-rimuovi') {
      if (c.serie.length <= 1) { toast('Serve almeno una serie.', true); return; }
      c.serie = c.serie.filter((s) => s.id !== id);
    } else if (azione === 'serie-duplica') {
      const s = serieDaId(c, id);
      if (!s) return;
      const usati = new Set(c.serie.map((x) => x.slot));
      let slot = 0;
      while (usati.has(slot) && slot < CATEGORICA.length) slot++;
      c.serie.push({ ...JSON.parse(JSON.stringify(s)), id: safeUUID(), slot: slot % CATEGORICA.length, colore: '' });
    } else if (azione === 'serie-visibile') {
      const s = serieDaId(c, id);
      if (s) s.visibile = s.visibile === false;
    } else if (azione === 'colore-auto') {
      const s = serieDaId(c, id);
      if (s) s.colore = '';
    } else if (azione === 'option-copia') {
      if (!ultimoOption) { toast('Esegui prima una query.', true); return; }
      const area = $('#chart-override');
      if (area) {
        area.value = JSON.stringify(ultimoOption, (k, v) => (typeof v === 'function' ? undefined : v), 2);
        c.override = area.value;
        toast('Option generata copiata: modificala e attiva l\'override.');
      }
      ricostruisci = false;
    } else if (azione === 'override-pulisci') {
      c.override = '';
      c.overrideAttivo = false;
    } else if (azione === 'preset-salva') {
      // Salvare un preset non cambia il grafico: si esce senza ridisegnare, e
      // la modale (asincrona, vedi chiediTesto) può concludersi con calma.
      chiediTesto({
        titolo: 'Salva preimpostazione',
        etichetta: 'Nome della preimpostazione',
        ok: 'Salva',
      }).then((nome) => {
        if (!nome || !nome.trim()) return;
        salvaPreset(nome.trim(), c);
        toast(`Preimpostazione "${nome.trim()}" salvata.`);
      });
      return;
    } else if (azione === 'preset-carica') {
      const nome = $('#chart-preset-select')?.value;
      if (!nome) { toast('Scegli una preimpostazione.', true); return; }
      const p = tuttiPreset()[nome];
      if (!p) { toast('Preimpostazione non trovata.', true); return; }
      // I campi salvati potrebbero non esistere nel result set corrente:
      // autoConfigura li rimpiazza al primo disegno invece di lasciare un
      // grafico vuoto senza spiegazione.
      state.chartCfg = JSON.parse(JSON.stringify(p));
      cfg().serie.forEach((s) => { if (!s.id) s.id = safeUUID(); });
      toast(`Preimpostazione "${nome}" caricata.`);
    } else if (azione === 'preset-elimina') {
      const nome = $('#chart-preset-select')?.value;
      if (!nome) { toast('Scegli una preimpostazione.', true); return; }
      const tutti = tuttiPreset();
      delete tutti[nome];
      try { localStorage.setItem(CHIAVE_PRESET, JSON.stringify(tutti)); } catch { /* spazio esaurito: nulla da fare */ }
      toast(`Preimpostazione "${nome}" eliminata.`);
    } else if (azione === 'cfg-reset') {
      state.chartCfg = cfgDefault();
      toast('Configurazione del grafico ripristinata.');
    } else {
      return;
    }

    if (ricostruisci) { host.dataset.firma = ''; if (barra) barra.dataset.firma = ''; }
    disegna();
  });

  const btnPng = $('#chart-export-png');
  if (btnPng) btnPng.addEventListener('click', esportaPng);
  const btnOpt = $('#chart-export-option');
  if (btnOpt) btnOpt.addEventListener('click', esportaOption);

  /* ----------------------------- Suggeriti ------------------------------- */

  const btnSug = $('#chart-suggest-btn');
  const menuSug = $('#chart-suggest-menu');
  if (btnSug && menuSug) {
    btnSug.addEventListener('click', (e) => {
      e.stopPropagation();
      const chiuso = menuSug.classList.contains('hidden');
      document.querySelectorAll('.toolbar-dropdown-menu').forEach((m) => m.classList.add('hidden'));
      // `positionFixedDropdown` posiziona il menu in coordinate fisse: dentro un
      // pannello con overflow nascosto un menu in flusso verrebbe tagliato.
      if (chiuso) positionFixedDropdown(btnSug, menuSug);
    });
    menuSug.addEventListener('click', (e) => {
      const voce = e.target.closest('[data-suggerimento]');
      if (!voce) return;
      menuSug.classList.add('hidden');
      if (!applicaSuggerimento(voce.dataset.suggerimento)) { toast('Proposta non più valida per questi dati.', true); return; }
      host.dataset.firma = '';
      if (barra) barra.dataset.firma = '';
      disegna();
      toast(`Grafico: ${voce.textContent}`);
    });
  }

  /* ------------------------------ Pannello ------------------------------- */

  const btnPannello = $('#chart-toggle-builder');
  const pannello = $('#chart-builder-panel');
  if (btnPannello && pannello) {
    const aggiornaEtichetta = () => {
      const chiuso = pannello.classList.contains('collassato');
      btnPannello.textContent = chiuso ? '⚙ Personalizza' : '⚙ Chiudi pannello';
      btnPannello.classList.toggle('attivo', !chiuso);
    };
    // Il pannello parte CHIUSO: la barra rapida copre il caso comune e il
    // grafico prende tutta la larghezza (288 px in più, che in un riquadro da
    // 850 sono un terzo). La scelta viene ricordata, perché chi personalizza
    // molto non deve riaprirlo ogni volta.
    if (localStorage.getItem(CHIAVE_PANNELLO) !== 'aperto') pannello.classList.add('collassato');
    aggiornaEtichetta();

    btnPannello.addEventListener('click', () => {
      pannello.classList.toggle('collassato');
      aggiornaEtichetta();
      try {
        localStorage.setItem(CHIAVE_PANNELLO, pannello.classList.contains('collassato') ? 'chiuso' : 'aperto');
      } catch { /* spazio esaurito: la preferenza non si ricorda, pazienza */ }
      // Il riquadro ha cambiato larghezza: `disegna` e non `resizeChart`, perché
      // margini e zoom dipendono dalle dimensioni (vedi grigliaAdattata).
      requestAnimationFrame(() => disegna());
    });
  }
}
