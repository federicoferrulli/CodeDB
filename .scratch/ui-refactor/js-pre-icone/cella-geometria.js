'use strict';

/* ---------------------------------------------------------------------------
 * Resa condivisa di una geometria dentro una cella.
 *
 * Il chiamante decide soltanto cosa significa «aprire» nella propria vista.
 * Riconoscimento, etichetta, classe, aiuto e gesto restano identici in ogni
 * griglia: la vista Dati, un riquadro della Split-View e la tabella dei
 * risultati della tab ⚡ mostrano la stessa cella e rispondono allo stesso
 * doppio clic.
 *
 * Che cosa significhi «aprire» non e' pero' una proprieta' della VISTA, ma
 * della CELLA: una riga senza `_id` — una vista SQL, un result set, un utente
 * senza permesso di scrittura — non e' scrivibile, e offrirle «Applica
 * geometria» significa promettere un salvataggio che parte senza bersaglio e
 * torna indietro come errore. La sola lettura sta quindi qui, in un posto
 * solo, e ogni griglia dichiara nei propri termini quando una cella e'
 * modificabile.
 * ------------------------------------------------------------------------- */

import { isGeometry, geometryLabel } from './geojson.js';
import { openGeoEditor } from './geomap.js';

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

/**
 * L'apertura di una cella che si può guardare ma non scrivere: la mappa senza
 * il pulsante di salvataggio e con il JSON in sola lettura.
 */
export function aperturaSolaLettura(valore, campo) {
  return () => openGeoEditor({ value: valore, campo, readOnly: true });
}

/**
 * L'apertura da dare a `rendiCellaGeometrica`: `onModifica` se la cella è
 * scrivibile, altrimenti la sola lettura. È una funzione e non un `if` in ogni
 * griglia perché è la stessa decisione, presa con criteri diversi.
 */
export function aperturaCella({ valore, campo, modificabile, onModifica }) {
  return modificabile && typeof onModifica === 'function'
    ? onModifica
    : aperturaSolaLettura(valore, campo);
}
