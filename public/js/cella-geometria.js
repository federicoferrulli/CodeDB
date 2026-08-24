'use strict';

/* ---------------------------------------------------------------------------
 * Resa condivisa di una geometria dentro una cella.
 *
 * Il chiamante decide soltanto cosa significa «aprire» nella propria vista
 * (sola lettura nella tab Query, modifica in Dati/Split-View). Riconoscimento,
 * etichetta, classe, aiuto e gesto restano identici in ogni griglia.
 * ------------------------------------------------------------------------- */

import { isGeometry, geometryLabel } from './geojson.js';

/**
 * Disegna `valore` nella cella e collega il doppio clic.
 * Restituisce false senza toccare il DOM quando il valore non è GeoJSON.
 */
export function rendiCellaGeometrica(cella, valore, onApri) {
  if (!cella || !isGeometry(valore)) return false;
  const testo = geometryLabel(valore);
  cella.textContent = testo;
  cella.classList.add('type-geo');
  cella.title = `${testo}\n🗺 Doppio clic per visualizzare sulla mappa`;
  if (typeof onApri === 'function') {
    cella.addEventListener('dblclick', (evento) => {
      evento.preventDefault();
      onApri();
    });
  }
  return true;
}
