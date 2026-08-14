'use strict';

/* ---------------------------------------------------------------------------
 * Le due cose che servono a CHIUNQUE disegni un grafico ECharts nell'interfaccia:
 * la libreria e la cromatura del tema in vigore.
 *
 * Stavano dentro `charts.js` (la vista Grafici della tab ⚡ Query & Aggregate)
 * finché il grafico era uno solo. Da quando anche la selezione di celle della
 * griglia ne disegna uno (`cellgrafico.js`), duplicarle avrebbe significato due
 * `<script>` della stessa libreria da 1,1 MB — e, peggio, due elenchi di token
 * da tenere allineati: un token aggiunto al tema qui e dimenticato là dà un
 * grafico grigio su bianco solo in una delle due finestre.
 *
 * Il caricamento resta PIGRO e a prova di doppia chiamata: chi non apre mai un
 * grafico non scarica nulla, e due aperture contemporanee condividono la stessa
 * promessa invece di iniettare due volte lo script.
 * ------------------------------------------------------------------------- */

import { tokenTema } from './theme.js';

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

/** Carica (una volta sola) ECharts vendorizzato e restituisce `window.echarts`. */
export async function caricaEcharts() {
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

/**
 * La cromatura del grafico letta dai token del tema in vigore.
 *
 * Nomi delle chiavi = quelli di `INK` (chart-option.js); i valori sono token
 * CSS. Se un token manca, `tokenTema` torna stringa vuota e `applicaInk` lascia
 * il valore precedente: meglio la cromatura del tema scuro che un `color: ''`,
 * che ECharts accetta e disegna nero su nero.
 */
export function inkDalTema() {
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
