'use strict';

/* ---------------------------------------------------------------------------
 * Vista "insieme di geometrie su mappa", riusabile.
 *
 * Nasce da `geomulti.js` (la mappa di una selezione di celle) il giorno in cui
 * è servita la stessa identica cosa dentro i risultati della tab ⚡ Query &
 * Aggregate: mappa, riepilogo, elenco cliccabile, avvisi, inquadratura,
 * esportazione GeoJSON. Copiarla avrebbe significato due colori diversi per lo
 * stesso tipo di geometria, due tetti di disegno che divergono e due correzioni
 * da fare ogni volta — quindi qui c'è il motore, e i due chiamanti mettono solo
 * la loro cornice (una modale, un pannello).
 *
 * Ogni istanza è INDIPENDENTE: mappa, stato ed evidenziazione stanno nella
 * chiusura, non in variabili di modulo. Serve perché le due viste possono
 * esistere insieme nella stessa pagina — la modale della selezione si apre
 * sopra la tab Query, che nel frattempo ha la sua mappa disegnata.
 *
 * Il calcolo (quante, di che tipo, quanto lunghe, quanto estese, dove stanno) è
 * tutto in `geo-stats.js`, puro e provato in Node: qui c'è solo il disegno.
 * Leaflet e le tile arrivano da `geo-leaflet.js`, condivisi con l'editor perché
 * la libreria va caricata una volta sola.
 * ------------------------------------------------------------------------- */

import { toast } from './utils.js';
import { geometryLabel } from './geojson.js';
import { caricaLeaflet, tileAttive, TILE_URL, TILE_ATTR } from './geo-leaflet.js';
import {
  statisticheGeo, formattaDistanza, formattaArea, formattaPunto, featureCollection,
} from './geo-stats.js';

// Tetti di disegno. Non sono cautele teoriche: una colonna di confini comunali
// sono migliaia di poligoni da decine di migliaia di vertici ciascuno, e
// disegnarli tutti significa una finestra che non si apre più. Oltre la soglia
// si disegnano i primi e LO SI DICE: una mappa parziale dichiarata è utile, una
// mappa parziale silenziosa è una bugia.
const MAX_GEOMETRIE = 1500;
const MAX_VERTICI = 120000;
// Oltre questo numero l'elenco non viene costruito riga per riga: sono migliaia
// di nodi DOM per una lista che nessuno scorre fino in fondo.
const MAX_ELENCO = 500;

// Colore per FAMIGLIA di geometria, non per riga: quando venti poligoni si
// sovrappongono, sapere quale sia il numero 14 non serve a nessuno — serve
// distinguere i punti dalle aree. La geometria evidenziata dall'elenco prende
// invece un colore suo, ed è l'unica che cambia aspetto.
export const COLORI = {
  Point: '#e0a800', MultiPoint: '#e0a800',
  LineString: '#4ec9b0', MultiLineString: '#4ec9b0',
  Polygon: '#007acc', MultiPolygon: '#007acc',
  GeometryCollection: '#c586c0',
};
const COLORE_EVIDENZA = '#ff6b6b';

export const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* ------------------------------- Riepilogo -------------------------------- */

// Righe [etichetta, valore] del riepilogo. Lunghezza e area stanno su due righe
// distinte perché sommarle darebbe un numero senza significato (vedi la nota 4
// in testa a geo-stats.js).
export function righeRiepilogo(st) {
  const righe = [
    ['Geometrie', String(st.totale)],
    ['Tipi', st.perTipo.map(([t, n]) => `${t} × ${n}`).join(' · ') || '—'],
    ['Vertici', st.vertici.toLocaleString('it-IT')],
  ];
  if (st.lunghezzaM !== null) righe.push([`Lunghezza (${st.conLunghezza} linee)`, formattaDistanza(st.lunghezzaM)]);
  if (st.areaM2 !== null) {
    righe.push([`Area (${st.conArea} poligoni)`, formattaArea(st.areaM2)]);
    righe.push(['Perimetro dei poligoni', formattaDistanza(st.perimetroM)]);
  }
  righe.push(['Centro (media dei vertici)', formattaPunto(st.centro)]);
  if (st.bbox) {
    righe.push(['Riquadro SO', formattaPunto([st.bbox[0], st.bbox[1]])]);
    righe.push(['Riquadro NE', formattaPunto([st.bbox[2], st.bbox[3]])]);
  }
  if (st.nonGeometriche) righe.push(['Celle non geometriche (ignorate)', String(st.nonGeometriche)]);
  if (st.vuote) righe.push(['Celle vuote', String(st.vuote)]);
  if (st.proiettate) righe.push(['Geometrie proiettate (non misurate)', String(st.proiettate)]);
  return righe;
}

export function riepilogoTsv(st) {
  return righeRiepilogo(st).map(([k, v]) => `${k}\t${v}`).join('\n');
}

/* ------------------------------- La vista --------------------------------- */

/**
 * Crea una vista mappa su un insieme di elementi già presenti nel DOM.
 *
 * @param {object} el
 * @param {HTMLElement|string} el.canvas     contenitore della mappa (obbligatorio)
 * @param {HTMLElement|string} [el.riepilogo] tabella chiave/valore del riepilogo
 * @param {HTMLElement|string} [el.elenco]    elenco delle geometrie (cliccabile)
 * @param {HTMLElement|string} [el.notaElenco] nota sotto l'elenco (troncamento)
 * @param {HTMLElement|string} [el.avvisi]    riquadro degli avvisi
 * @param {string} [el.etichettaRiga]        intestazione della colonna "riga"
 */
export function creaVistaGeo(el = {}) {
  const nodo = (x) => (typeof x === 'string' ? document.querySelector(x) : x) || null;
  const canvas = nodo(el.canvas);
  const riepilogo = nodo(el.riepilogo);
  const elenco = nodo(el.elenco);
  const notaElenco = nodo(el.notaElenco);
  const avvisi = nodo(el.avvisi);
  const etichettaRiga = el.etichettaRiga || 'Riga';

  let L = null;
  let mappa = null;
  let livelloTile = null;
  let gruppo = null;
  let renderer = null;
  let stato = null; // { st, disegnate, evidenziato }

  /* ------------------------------ Disegno -------------------------------- */

  function stileDi(tipo, evidenziato) {
    const colore = evidenziato ? COLORE_EVIDENZA : (COLORI[tipo] || '#8b949e');
    return {
      color: colore,
      weight: evidenziato ? 4 : 2,
      fillColor: colore,
      fillOpacity: evidenziato ? 0.35 : 0.15,
      renderer,
    };
  }

  // Un layer Leaflet per geometria. I Point diventano cerchietti (un `L.geoJSON`
  // li renderebbe marker con icona: un'immagine per punto, cioè migliaia di nodi
  // DOM proprio nel caso in cui i punti sono tanti).
  function creaLayer(geo, tipo, evidenziato) {
    const stile = stileDi(tipo, evidenziato);
    try {
      return L.geoJSON(geo, {
        style: () => stile,
        pointToLayer: (_f, ll) => L.circleMarker(ll, { ...stile, radius: evidenziato ? 8 : 5, fillOpacity: 1 }),
      });
    } catch {
      return null;
    }
  }

  function etichettaGeo(g) {
    const dove = g.colonna ? `${g.colonna}${g.riga === null ? '' : ` · ${etichettaRiga.toLowerCase()} ${g.riga + 1}`}` : '';
    const misure = [];
    if (g.lunghezzaM !== null) misure.push(formattaDistanza(g.lunghezzaM));
    if (g.areaM2 !== null) misure.push(formattaArea(g.areaM2));
    // Leaflet inserisce un tooltip di tipo stringa con innerHTML, e qui dentro
    // finisce il NOME della colonna, che viene dal database: su MongoDB un campo
    // può chiamarsi in qualunque modo. Senza esc() basta un campo chiamato
    // "<img onerror=…>" accanto a una geometria per eseguire codice nella pagina.
    return [`#${g.indice + 1} ${geometryLabel(g.geo)}`, dove, misure.join(' · ')]
      .filter(Boolean)
      .map(esc)
      .join('<br>');
  }

  function disegna() {
    if (!mappa || !stato) return;
    gruppo.clearLayers();
    stato.disegnate.forEach((g) => {
      const layer = creaLayer(g.geo, g.tipo, g.indice === stato.evidenziato);
      if (!layer) return;
      layer.addTo(gruppo);
      layer.bindTooltip(etichettaGeo(g), { sticky: true });
      // Clic sulla mappa → si evidenzia la voce corrispondente nell'elenco: è il
      // verso opposto del clic sull'elenco, e serve per il caso normale ("questa
      // forma qui in mezzo, da che riga viene?").
      layer.on('click', () => evidenzia(g.indice, { inquadra: false }));
    });
  }

  function inquadraTutto() {
    if (!mappa || !stato) return;
    const punti = [];
    for (const g of stato.disegnate) {
      if (!g.bbox) continue;
      punti.push([g.bbox[1], g.bbox[0]], [g.bbox[3], g.bbox[2]]);
    }
    if (!punti.length) return;
    const b = L.latLngBounds(punti);
    if (b.getNorth() === b.getSouth() && b.getEast() === b.getWest()) {
      mappa.setView(b.getCenter(), Math.max(mappa.getZoom(), 13));
    } else {
      mappa.fitBounds(b, { padding: [30, 30] });
    }
  }

  function inquadraGeometria(g) {
    if (!g || !g.bbox || !mappa) return;
    const b = L.latLngBounds([[g.bbox[1], g.bbox[0]], [g.bbox[3], g.bbox[2]]]);
    if (g.bbox[0] === g.bbox[2] && g.bbox[1] === g.bbox[3]) {
      mappa.setView([g.bbox[1], g.bbox[0]], Math.max(mappa.getZoom(), 14));
    } else {
      mappa.fitBounds(b, { padding: [40, 40] });
    }
  }

  function evidenzia(indice, { inquadra = true } = {}) {
    if (!stato) return;
    stato.evidenziato = stato.evidenziato === indice && !inquadra ? null : indice;
    disegna();
    const g = stato.disegnate.find((x) => x.indice === stato.evidenziato);
    if (inquadra && g) inquadraGeometria(g);
    if (!elenco) return;
    elenco.querySelectorAll('tr[data-i]').forEach((tr) => {
      tr.classList.toggle('attiva', Number(tr.dataset.i) === stato.evidenziato);
    });
    const attiva = elenco.querySelector('tr.attiva');
    if (attiva) attiva.scrollIntoView({ block: 'nearest' });
  }

  /* ----------------------------- Contenuti ------------------------------- */

  function renderRiepilogo(st) {
    if (!riepilogo) return;
    riepilogo.innerHTML = '<table class="info-table kv-table"><tbody>'
      + righeRiepilogo(st).map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td class="mono copiabile" data-copia="${esc(v)}"`
        + ` title="Clic per copiare «${esc(v)}»">${esc(v)}</td></tr>`).join('')
      + '</tbody></table>';
  }

  function renderElenco(st) {
    if (!elenco) return;
    const mostrate = st.geometrie.slice(0, MAX_ELENCO);
    elenco.innerHTML = '<table class="info-table"><thead><tr>'
      + ['#', 'Colonna', etichettaRiga, 'Tipo', 'Vertici', 'Misura'].map((h) => `<th>${esc(h)}</th>`).join('')
      + '</tr></thead><tbody>'
      + mostrate.map((g) => {
        const misura = g.proiettata ? 'non misurabile'
          : (g.areaM2 !== null ? formattaArea(g.areaM2)
            : (g.lunghezzaM !== null ? formattaDistanza(g.lunghezzaM) : '—'));
        const pallino = `<span class="geomulti-dot" style="background:${COLORI[g.tipo] || '#8b949e'}"></span>`;
        return `<tr data-i="${g.indice}" title="Clic per inquadrarla sulla mappa">`
          + `<td>${pallino}${g.indice + 1}</td>`
          + `<td>${esc(g.colonna || '—')}</td>`
          + `<td>${g.riga === null ? '—' : g.riga + 1}</td>`
          + `<td>${esc(g.tipo)}</td>`
          + `<td>${g.vertici.toLocaleString('it-IT')}</td>`
          + `<td>${esc(misura)}</td></tr>`;
      }).join('')
      + '</tbody></table>';
    if (!notaElenco) return;
    notaElenco.textContent = st.geometrie.length > MAX_ELENCO
      ? `Elencate le prime ${MAX_ELENCO} geometrie di ${st.geometrie.length}: il riepilogo qui sopra le considera tutte.`
      : '';
    notaElenco.classList.toggle('hidden', !notaElenco.textContent);
  }

  // Avvisi: la mappa non mostra tutto quello che c'è, e va detto esplicitamente
  // invece di lasciarlo dedurre da un conteggio che non torna.
  function renderAvvisi(st, disegnate, motivo) {
    if (!avvisi) return;
    const parti = [];
    // Solo se qualcosa è rimasto fuori per i TETTI di disegno: le proiettate
    // sono già spiegate dalla riga successiva, e dirlo due volte fa sembrare due
    // problemi distinti dove ce n'è uno.
    if (motivo) {
      parti.push(`Disegnate ${disegnate.length} geometrie su ${st.totale} (${motivo}): `
        + 'il riepilogo e l\'esportazione le riguardano invece tutte.');
    }
    if (st.proiettate) {
      parti.push(`${st.proiettate} geometrie hanno coordinate fuori dall'intervallo longitudine/latitudine `
        + '(probabilmente PROIETTATE, es. metri EPSG:3857): non sono disegnate né misurate, perché sulla mappa '
        + 'finirebbero in un punto a caso.');
    }
    if (st.antimeridiano) {
      // Lunghezze e aree sono corrette (la differenza di longitudine è
      // normalizzata); è il riquadro che non sa avvolgersi, e inquadrarci sopra
      // la mappa mostrerebbe mezzo pianeta. Meglio dirlo che lasciarlo intuire.
      parti.push(`${st.antimeridiano} geometrie attraversano l'antimeridiano (±180°): lunghezze e aree sono `
        + 'corrette, ma il riquadro di delimitazione le fa sembrare larghe quanto il pianeta e l\'inquadratura '
        + 'automatica ne risente.');
    }
    avvisi.innerHTML = parti.map(esc).join('<br>');
    avvisi.classList.toggle('hidden', !parti.length);
  }

  /* -------------------------------- Mappa -------------------------------- */

  function applicaTile() {
    if (!mappa) return;
    const attive = tileAttive();
    if (attive && !livelloTile) {
      livelloTile = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR, updateWhenZooming: false }).addTo(mappa);
    } else if (!attive && livelloTile) {
      mappa.removeLayer(livelloTile);
      livelloTile = null;
    }
  }

  function creaMappa() {
    if (mappa || !canvas) return;
    mappa = L.map(canvas, { center: [41.9, 12.5], zoom: 5, preferCanvas: true });
    renderer = L.canvas({ padding: 0.2 });
    gruppo = L.layerGroup().addTo(mappa);
    applicaTile();
  }

  /* ------------------------ Gestori dei pannelli ------------------------- */

  // Delegati e registrati UNA volta: riepilogo ed elenco vengono riscritti a
  // ogni aggiornamento, quindi legarsi alle righe non funzionerebbe.
  if (riepilogo) {
    riepilogo.addEventListener('click', (e) => {
      const td = e.target.closest('td[data-copia]');
      if (!td || !td.dataset.copia || td.dataset.copia === '—') return;
      copia(td.dataset.copia, `Copiato: ${td.dataset.copia}`);
    });
  }
  if (elenco) {
    elenco.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr || !stato) return;
      const indice = Number(tr.dataset.i);
      if (!stato.disegnate.some((x) => x.indice === indice)) {
        toast('Questa geometria non è disegnata sulla mappa (proiettata o oltre il limite di disegno)', true);
        return;
      }
      evidenzia(indice);
    });
  }

  /* ------------------------------- API ----------------------------------- */

  return {
    /**
     * Calcola, disegna e inquadra un insieme di celle.
     * @param {Array} voci [{ valore, colonna, riga }] — anche non geometriche
     * @param {{isCurrent?:()=>boolean}} [opts] guardia per scartare render sorpassati
     * @returns {Promise<object|null>} le statistiche, oppure null se non c'è nulla da mostrare
     */
    async mostra(voci, { isCurrent = null } = {}) {
      const st = statisticheGeo(voci || []);
      if (isCurrent && !isCurrent()) return null;
      if (!st.totale) {
        stato = null;
        if (gruppo) gruppo.clearLayers();
        return null;
      }
      try {
        L = await caricaLeaflet();
      } catch (err) {
        if ((!isCurrent || isCurrent()) && avvisi) {
          avvisi.textContent = err.message;
          avvisi.classList.remove('hidden');
        }
        throw err;
      }
      if (isCurrent && !isCurrent()) return null;

      // Numerazione stabile: è quella mostrata nell'elenco, nei tooltip e
      // nell'esportazione, e non deve dipendere da cosa viene disegnato.
      st.geometrie.forEach((g, i) => { g.indice = i; });

      // Si scartano le proiettate (finirebbero in un punto a caso) e ci si ferma
      // ai tetti di disegno.
      const candidate = st.geometrie.filter((g) => !g.proiettata && g.bbox);
      const disegnate = [];
      let vertici = 0;
      let motivo = '';
      for (const g of candidate) {
        if (disegnate.length >= MAX_GEOMETRIE) { motivo = `oltre ${MAX_GEOMETRIE} geometrie`; break; }
        if (vertici + g.vertici > MAX_VERTICI && disegnate.length) {
          motivo = `oltre ${MAX_VERTICI.toLocaleString('it-IT')} vertici`;
          break;
        }
        vertici += g.vertici;
        disegnate.push(g);
      }

      stato = { st, disegnate, evidenziato: null };
      renderRiepilogo(st);
      renderElenco(st);
      renderAvvisi(st, disegnate, motivo);
      return st;
    },

    /**
     * Crea la mappa (se serve), la rimisura e disegna.
     * Va chiamata quando il contenitore è VISIBILE: Leaflet legge le dimensioni
     * del div, e su uno ancora nascosto (0×0) disegna una mappa grigia che non
     * si riprende più da sola.
     */
    aggiorna({ inquadra = true } = {}) {
      if (!L || !stato) return;
      creaMappa();
      if (!mappa) return;
      mappa.invalidateSize();
      disegna();
      if (inquadra) inquadraTutto();
    },

    /** Rimisura la mappa dopo un cambio di dimensioni del contenitore. */
    invalidateSize() { if (mappa) mappa.invalidateSize(); },

    inquadraTutto,
    applicaTile,

    /** Svuota mappa e pannelli (cambio di risultati o di contesto). */
    pulisci() {
      stato = null;
      if (gruppo) gruppo.clearLayers();
      if (riepilogo) riepilogo.innerHTML = '';
      if (elenco) elenco.innerHTML = '';
      if (notaElenco) { notaElenco.textContent = ''; notaElenco.classList.add('hidden'); }
      if (avvisi) { avvisi.innerHTML = ''; avvisi.classList.add('hidden'); }
    },

    stato: () => stato,
    riepilogoTsv: () => (stato ? riepilogoTsv(stato.st) : ''),
    /** FeatureCollection di TUTTE le geometrie, comprese quelle non disegnate. */
    geojson: () => (stato ? featureCollection(stato.st.geometrie) : null),
  };
}

/* ------------------------------- Utilità --------------------------------- */

export function copia(testo, messaggio) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(testo).then(() => toast(messaggio)).catch(() => toast('Copia non riuscita', true));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = testo;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  toast(messaggio);
}

/** Scarica una FeatureCollection come file .geojson. */
export function scaricaGeoJson(fc, nome) {
  if (!fc) return;
  const testo = JSON.stringify(fc, null, 2);
  const url = URL.createObjectURL(new Blob([testo], { type: 'application/geo+json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}
