'use strict';

/* ---------------------------------------------------------------------------
 * Caricamento su richiesta di Leaflet e impostazioni delle tile.
 *
 * Sta a parte perché ora le finestre che usano una mappa sono DUE — l'editor di
 * una geometria (`geomap.js`) e la mappa di una selezione (`geomulti.js`) — e
 * il caricamento va fatto una volta sola per pagina: due copie della promessa
 * significherebbero due `<script>` di Leaflet, con la seconda che sovrascrive
 * `window.L` mentre la prima mappa è già disegnata sopra la vecchia.
 *
 * Anche la scelta sulle tile è condivisa: è la stessa impostazione ("faccio o
 * non faccio richieste a OpenStreetMap"), e vederla spuntata in una finestra e
 * vuota nell'altra sarebbe semplicemente falso.
 * ------------------------------------------------------------------------- */

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTR = '© OpenStreetMap';
const CHIAVE_TILE = 'codedb:geo:tiles';

let L = null;
let caricamento = null;

function caricaRisorsa(tag, attrs) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    Object.assign(el, attrs);
    el.addEventListener('load', () => resolve());
    el.addEventListener('error', () => reject(new Error('Impossibile caricare Leaflet da public/vendor/leaflet.')));
    document.head.appendChild(el);
  });
}

/** Leaflet, caricato alla prima apertura di una mappa (150 KB non dovuti a chi non ne apre nessuna). */
export async function caricaLeaflet() {
  if (L) return L;
  if (!caricamento) {
    caricamento = (async () => {
      await caricaRisorsa('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css' });
      await caricaRisorsa('script', { src: '/vendor/leaflet/leaflet.js' });
      if (!window.L) throw new Error('Leaflet caricato ma non disponibile (window.L assente).');
      L = window.L;
      return L;
    })().catch((err) => { caricamento = null; throw err; });
  }
  return caricamento;
}

/** Le tile OpenStreetMap sono attive? (unica richiesta esterna dell'applicazione) */
export function tileAttive() {
  return localStorage.getItem(CHIAVE_TILE) !== 'off';
}

export function impostaTile(attive) {
  localStorage.setItem(CHIAVE_TILE, attive ? 'on' : 'off');
}
