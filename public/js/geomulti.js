'use strict';

/* ---------------------------------------------------------------------------
 * Mappa di una SELEZIONE di celle geometriche.
 *
 * Perché esiste: `geomap.js` risponde alla domanda "com'è fatta questa
 * geometria?" — una cella per volta, modificabile. Qui la domanda è un'altra e
 * non aveva risposta: "come stanno FRA LORO le geometrie che ho selezionato?".
 * Venti punti di consegna in colonna sono venti righe di JSON; sulla mappa sono
 * un giro, un buco di copertura, un dato sbagliato in mezzo all'oceano. È lo
 * stesso salto che la statistica di selezione fa per i numeri, ed è il motivo
 * per cui questa finestra è di sola LETTURA: modificare venti geometrie insieme
 * è un'altra funzione, e mescolarla qui renderebbe facile rovinarle in blocco.
 *
 * Qui resta solo la CORNICE (la modale, i suoi pulsanti): mappa, riepilogo,
 * elenco, avvisi e tetti di disegno stanno in `geo-vista.js`, condivisi con la
 * mappa dei risultati della tab ⚡ Query & Aggregate — che è la stessa vista con
 * un'altra provenienza dei dati.
 * ------------------------------------------------------------------------- */

import { $, toast, openModal, closeModal } from './utils.js';
import { tileAttive, impostaTile } from './geo-leaflet.js';
import { creaVistaGeo, copia, scaricaGeoJson } from './geo-vista.js';

let vista = null;

function creaVista() {
  if (!vista) {
    vista = creaVistaGeo({
      canvas: '#geomulti-canvas',
      riepilogo: '#geomulti-summary',
      elenco: '#geomulti-list',
      notaElenco: '#geomulti-list-note',
      avvisi: '#geomulti-warning',
    });
  }
  return vista;
}

/**
 * Apre la mappa su una selezione di celle.
 *
 * @param {object} opts
 * @param {Array} opts.voci   [{ valore, colonna, riga }] — le celle selezionate,
 *                            comprese quelle non geometriche (vengono contate e ignorate)
 * @param {string} opts.titolo intestazione della finestra
 */
export async function apriMappaSelezione({ voci, titolo = '' }) {
  const v = creaVista();
  let st;
  try {
    st = await v.mostra(voci);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  // La modale si apre solo se c'è qualcosa da vedere: una finestra vuota da
  // chiudere per scoprire che non c'era nulla è peggio di un avviso. `mostra`
  // torna null proprio per questo, così le geometrie si contano una volta sola.
  if (!st) {
    toast('Nella selezione non ci sono geometrie da mostrare sulla mappa', true);
    return;
  }

  $('#geomulti-title').textContent = titolo ? `Geometrie — ${titolo}` : 'Geometrie sulla mappa';
  $('#geomulti-tiles').checked = tileAttive();

  openModal('#geomulti-overlay');
  // Leaflet legge le dimensioni del contenitore: su un div ancora nascosto
  // (0×0) disegnerebbe una mappa grigia che non si riprende.
  setTimeout(() => v.aggiorna(), 30);
}

export function initGeoMulti() {
  const overlay = $('#geomulti-overlay');
  if (!overlay) return;

  $('#geomulti-close').addEventListener('click', () => closeModal('#geomulti-overlay'));
  $('#geomulti-fit').addEventListener('click', () => creaVista().inquadraTutto());
  $('#geomulti-tiles').addEventListener('change', (e) => {
    impostaTile(e.target.checked);
    creaVista().applicaTile();
  });
  $('#geomulti-copy').addEventListener('click', () => {
    const tsv = creaVista().riepilogoTsv();
    if (tsv) copia(tsv, 'Riepilogo copiato');
  });
  // Esportazione: FeatureCollection dell'INTERA selezione, comprese le
  // geometrie non disegnate — è il file che si apre in QGIS o su geojson.io.
  $('#geomulti-export').addEventListener('click', () => scaricaGeoJson(creaVista().geojson(), 'selezione.geojson'));
}
