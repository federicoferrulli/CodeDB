'use strict';

/* ---------------------------------------------------------------------------
 * 🗺 Mappa: la quarta vista dei risultati della tab ⚡ Query & Aggregate,
 * accanto a Tabella, JSON Tree e Grafici.
 *
 * Perché esiste: una `SELECT ST_AsGeoJSON(area) …` o una `find` su una
 * collection con un campo `loc` producono righe che nella tabella sono muri di
 * coordinate e nel JSON Tree alberi da scorrere. La domanda vera — dove sta
 * questa roba, e come sta messa fra sé — ha una sola risposta possibile, ed è
 * una mappa. Era già così per la SELEZIONE di celle nella griglia (`geomulti.js`),
 * e non c'era motivo perché i risultati di una query valessero di meno.
 *
 * Il pulsante della vista compare SOLO se nei risultati ci sono davvero
 * geometrie: su una query di conteggi sarebbe una scheda che si apre su un
 * riquadro vuoto, cioè una funzione che sembra rotta.
 *
 * Qui c'è la cornice (toolbar, messaggio di vuoto, aggiornamento a ogni
 * risultato). La mappa vera — disegno, elenco, riepilogo, tetti, avvisi — è
 * `geo-vista.js`, condivisa con la modale della selezione; il riconoscimento
 * delle geometrie dentro le righe è `geo-risultati.js`, puro e provato in Node.
 * ------------------------------------------------------------------------- */

import { $, toast } from './utils.js';
import { tileAttive, impostaTile } from './geo-leaflet.js';
import { creaVistaGeo, copia, scaricaGeoJson } from './geo-vista.js';
import { haGeometrie, vociGeometriche, notaTroncamento, MAX_CELLE } from './geo-risultati.js';

let vista = null;
// Righe già mappate: ricalcolare statistiche e disegno a ogni cambio di vista
// su decine di migliaia di geometrie costerebbe secondi per rimostrare la
// stessa identica mappa.
let righeMostrate = null;
// Ogni render asincrono ha un'identità: se nel frattempo arriva un risultato
// più recente, quello vecchio non deve più scrivere nella mappa condivisa.
let renderToken = 0;

function creaVista() {
  if (!vista) {
    vista = creaVistaGeo({
      canvas: '#qmap-canvas',
      riepilogo: '#qmap-summary',
      elenco: '#qmap-list',
      notaElenco: '#qmap-list-note',
      avvisi: '#qmap-warning',
      etichettaRiga: 'Riga',
    });
  }
  return vista;
}

function mostraVuoto(testo) {
  const vuoto = $('#qmap-empty');
  const corpo = $('#qmap-body');
  if (vuoto) {
    vuoto.textContent = testo;
    vuoto.classList.toggle('hidden', !testo);
  }
  if (corpo) corpo.classList.toggle('hidden', !!testo);
}

/**
 * Mostra o nasconde il pulsante della vista mappa in base ai risultati.
 * @returns {boolean} true se i risultati contengono geometrie
 */
export function aggiornaPulsanteMappa(righe) {
  const btn = $('#res-mode-map');
  const ci = haGeometrie(righe);
  if (btn) {
    btn.classList.toggle('hidden', !ci);
    btn.title = ci
      ? 'Mostra su mappa le geometrie contenute nei risultati'
      : 'Nessuna geometria nei risultati';
  }
  return ci;
}

/** Disegna (o ridisegna) la mappa dei risultati. Chiamata da renderResults. */
export async function renderQueryMap(righe) {
  const token = ++renderToken;
  const lista = Array.isArray(righe) ? righe : [];
  if (!lista.length) {
    righeMostrate = null;
    creaVista().pulisci();
    mostraVuoto('Esegui una query: le geometrie contenute nei risultati compaiono qui sulla mappa.');
    return;
  }

  // Stessi risultati di prima: la mappa è già quella giusta, va solo rimisurata
  // (il contenitore era nascosto mentre si guardava un'altra vista).
  if (righeMostrate === lista) {
    creaVista().invalidateSize();
    return;
  }

  const { voci, colonne, tagliate } = vociGeometriche(lista);
  if (!voci.length) {
    righeMostrate = null;
    creaVista().pulisci();
    mostraVuoto('Nessuna geometria in questi risultati: la mappa disegna i campi GeoJSON '
      + '(su SQL, il risultato di ST_AsGeoJSON).');
    return;
  }

  mostraVuoto('');
  const v = creaVista();
  let st;
  try {
    st = await v.mostra(voci, { isCurrent: () => token === renderToken });
  } catch (err) {
    if (token !== renderToken) return;
    mostraVuoto(err.message);
    return;
  }
  if (token !== renderToken) return;
  righeMostrate = lista;

  const nota = $('#qmap-nota');
  if (nota) {
    const testo = notaTroncamento(tagliate, MAX_CELLE);
    nota.textContent = testo;
    nota.classList.toggle('hidden', !testo);
  }
  const conta = $('#qmap-conta');
  if (conta && st) {
    const dove = colonne.length === 1 ? colonne[0] : `${colonne.length} campi`;
    conta.textContent = `${st.totale.toLocaleString('it-IT')} geometrie · ${dove}`;
  }

  // Il contenitore è visibile solo quando questa vista è attiva: si disegna qui,
  // dopo che `setResultsViewMode` l'ha scoperto (Leaflet su un div 0×0 disegna
  // una mappa grigia che non si riprende più).
  v.aggiorna();
}

/** Il pannello era nascosto: al ritorno la mappa va rimisurata. */
export function resizeQueryMap() {
  if (vista) vista.invalidateSize();
}

/** Cambio di collection o di connessione: la mappa non descrive più nulla. */
export function clearQueryMap() {
  renderToken++;
  righeMostrate = null;
  if (vista) vista.pulisci();
  const nota = $('#qmap-nota');
  if (nota) { nota.textContent = ''; nota.classList.add('hidden'); }
  const conta = $('#qmap-conta');
  if (conta) conta.textContent = '';
  mostraVuoto('Esegui una query: le geometrie contenute nei risultati compaiono qui sulla mappa.');
  const btn = $('#res-mode-map');
  if (btn) btn.classList.add('hidden');
}

export function initQueryMap() {
  const canvas = $('#qmap-canvas');
  if (!canvas) return;

  const tiles = $('#qmap-tiles');
  if (tiles) {
    tiles.checked = tileAttive();
    tiles.addEventListener('change', (e) => {
      impostaTile(e.target.checked);
      creaVista().applicaTile();
    });
  }
  const fit = $('#qmap-fit');
  if (fit) fit.addEventListener('click', () => creaVista().inquadraTutto());

  const copy = $('#qmap-copy');
  if (copy) {
    copy.addEventListener('click', () => {
      const tsv = creaVista().riepilogoTsv();
      if (!tsv) { toast('Nessuna geometria da riepilogare', true); return; }
      copia(tsv, 'Riepilogo copiato');
    });
  }
  // Esportazione: FeatureCollection di TUTTE le geometrie raccolte, comprese
  // quelle non disegnate per i tetti — è il file che si apre in QGIS.
  const exp = $('#qmap-export');
  if (exp) {
    exp.addEventListener('click', () => {
      const fc = creaVista().geojson();
      if (!fc) { toast('Nessuna geometria da esportare', true); return; }
      scaricaGeoJson(fc, 'risultati.geojson');
    });
  }
}
