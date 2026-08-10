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
 * Il calcolo (quante, di che tipo, quanto lunghe, quanto estese, dove stanno)
 * è tutto in `geo-stats.js`, che è puro e provato in Node: qui c'è solo il
 * disegno. Leaflet e le tile arrivano da `geo-leaflet.js`, condivisi con
 * l'editor perché la libreria va caricata una volta sola.
 * ------------------------------------------------------------------------- */

import { $, toast, openModal, closeModal } from './utils.js';
import { geometryLabel } from './geojson.js';
import { caricaLeaflet, tileAttive, impostaTile, TILE_URL, TILE_ATTR } from './geo-leaflet.js';
import {
  statisticheGeo, formattaDistanza, formattaArea, formattaPunto, featureCollection,
} from './geo-stats.js';

// Tetti di disegno. Non sono cautele teoriche: una selezione di colonna su una
// tabella di confini comunali sono migliaia di poligoni da decine di migliaia
// di vertici ciascuno, e disegnarli tutti significa una finestra che non si
// apre più. Oltre la soglia si disegnano le prime e LO SI DICE: una mappa
// parziale dichiarata è utile, una mappa parziale silenziosa è una bugia.
const MAX_GEOMETRIE = 1500;
const MAX_VERTICI = 120000;
// Oltre questo numero l'elenco a destra non viene costruito riga per riga: sono
// migliaia di nodi DOM per una lista che nessuno scorre fino in fondo.
const MAX_ELENCO = 500;

// Colore per FAMIGLIA di geometria, non per riga: quando venti poligoni si
// sovrappongono, sapere quale sia il numero 14 non serve a nessuno — serve
// distinguere i punti dalle aree. La geometria evidenziata dall'elenco prende
// invece un colore suo, ed è l'unica che cambia aspetto.
const COLORI = {
  Point: '#e0a800', MultiPoint: '#e0a800',
  LineString: '#4ec9b0', MultiLineString: '#4ec9b0',
  Polygon: '#007acc', MultiPolygon: '#007acc',
  GeometryCollection: '#c586c0',
};
const COLORE_EVIDENZA = '#ff6b6b';

let L = null;
let mappa = null;
let livelloTile = null;
let gruppo = null;
let renderer = null;
let stato = null;      // { st, disegnate, layerPerIndice: Map, evidenziato }

/* --------------------------------- Disegno -------------------------------- */

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

const latlng = (pos) => [Number(pos[1]), Number(pos[0])];

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

function disegna() {
  if (!mappa || !stato) return;
  gruppo.clearLayers();
  stato.layerPerIndice = new Map();

  stato.disegnate.forEach((g) => {
    const layer = creaLayer(g.geo, g.tipo, g.indice === stato.evidenziato);
    if (!layer) return;
    layer.addTo(gruppo);
    stato.layerPerIndice.set(g.indice, layer);
    layer.bindTooltip(etichettaGeo(g), { sticky: true });
    // Clic sulla mappa → si evidenzia la voce corrispondente nell'elenco: è il
    // verso opposto del clic sull'elenco, e serve per il caso normale ("questa
    // forma qui in mezzo, da che riga viene?").
    layer.on('click', () => evidenzia(g.indice, { inquadra: false }));
  });
}

function etichettaGeo(g) {
  const dove = g.colonna ? `${g.colonna}${g.riga === null ? '' : ` · riga ${g.riga + 1}`}` : '';
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

function tuttiIPunti() {
  const punti = [];
  for (const g of stato.disegnate) {
    if (!g.bbox) continue;
    punti.push([g.bbox[1], g.bbox[0]], [g.bbox[3], g.bbox[2]]);
  }
  return punti;
}

function inquadraTutto() {
  const punti = tuttiIPunti();
  if (!punti.length) return;
  const b = L.latLngBounds(punti);
  if (b.getNorth() === b.getSouth() && b.getEast() === b.getWest()) {
    mappa.setView(b.getCenter(), Math.max(mappa.getZoom(), 13));
  } else {
    mappa.fitBounds(b, { padding: [30, 30] });
  }
}

function inquadraGeometria(g) {
  if (!g || !g.bbox) return;
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
  document.querySelectorAll('#geomulti-list tr[data-i]').forEach((tr) => {
    tr.classList.toggle('attiva', Number(tr.dataset.i) === stato.evidenziato);
  });
  const attiva = document.querySelector('#geomulti-list tr.attiva');
  if (attiva) attiva.scrollIntoView({ block: 'nearest' });
}

/* -------------------------------- Contenuti ------------------------------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Righe [etichetta, valore] del riepilogo. Lunghezza e area stanno su due righe
// distinte perché sommarle darebbe un numero senza significato (vedi la nota 4
// in testa a geo-stats.js).
function righeRiepilogo(st) {
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

function riepilogoTsv(st) {
  return righeRiepilogo(st).map(([k, v]) => `${k}\t${v}`).join('\n');
}

function renderRiepilogo(st) {
  const corpo = $('#geomulti-summary');
  corpo.innerHTML = '<table class="info-table kv-table"><tbody>'
    + righeRiepilogo(st).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td class="mono copiabile" data-copia="${esc(v)}"`
      + ` title="Clic per copiare «${esc(v)}»">${esc(v)}</td></tr>`).join('')
    + '</tbody></table>';
}

function renderElenco(st) {
  const el = $('#geomulti-list');
  const mostrate = st.geometrie.slice(0, MAX_ELENCO);
  el.innerHTML = '<table class="info-table"><thead><tr>'
    + ['#', 'Colonna', 'Riga', 'Tipo', 'Vertici', 'Misura'].map((h) => `<th>${h}</th>`).join('')
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
  const nota = $('#geomulti-list-note');
  nota.textContent = st.geometrie.length > MAX_ELENCO
    ? `Elencate le prime ${MAX_ELENCO} geometrie di ${st.geometrie.length}: il riepilogo qui sopra le considera tutte.`
    : '';
  nota.classList.toggle('hidden', !nota.textContent);
}

// Avvisi: la mappa non mostra tutto quello che è stato selezionato, e va detto
// esplicitamente invece di lasciarlo dedurre da un conteggio che non torna.
function renderAvvisi(st, disegnate, motivo) {
  const el = $('#geomulti-warning');
  const parti = [];
  // Solo se qualcosa è rimasto fuori per i TETTI di disegno: le proiettate sono
  // già spiegate dalla riga successiva, e dirlo due volte fa sembrare due
  // problemi distinti dove ce n'è uno.
  if (motivo) {
    parti.push(`Disegnate ${disegnate.length} geometrie su ${st.totale} (${motivo}): `
      + 'il riepilogo e l\'esportazione riguardano invece tutta la selezione.');
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
  el.innerHTML = parti.map(esc).join('<br>');
  el.classList.toggle('hidden', !parti.length);
}

/* --------------------------------- Mappa ---------------------------------- */

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
  if (mappa) return;
  mappa = L.map('geomulti-canvas', { center: [41.9, 12.5], zoom: 5, preferCanvas: true });
  renderer = L.canvas({ padding: 0.2 });
  gruppo = L.layerGroup().addTo(mappa);
  applicaTile();
}

/* --------------------------------- Apertura ------------------------------- */

/**
 * Apre la mappa su una selezione di celle.
 *
 * @param {object} opts
 * @param {Array} opts.voci   [{ valore, colonna, riga }] — le celle selezionate,
 *                            comprese quelle non geometriche (vengono contate e ignorate)
 * @param {string} opts.titolo intestazione della finestra
 */
export async function apriMappaSelezione({ voci, titolo = '' }) {
  const st = statisticheGeo(voci || []);
  if (!st.totale) {
    toast('Nella selezione non ci sono geometrie da mostrare sulla mappa', true);
    return;
  }
  try {
    L = await caricaLeaflet();
  } catch (err) {
    toast(err.message, true);
    return;
  }

  // Numerazione stabile: è quella mostrata nell'elenco, nei tooltip e
  // nell'esportazione, e non deve dipendere da cosa viene disegnato.
  st.geometrie.forEach((g, i) => { g.indice = i; });

  // Selezione di ciò che si disegna: si scartano le proiettate (finirebbero in
  // un punto a caso) e ci si ferma ai tetti di disegno.
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

  stato = { st, disegnate, layerPerIndice: new Map(), evidenziato: null };

  $('#geomulti-title').textContent = titolo ? `Geometrie — ${titolo}` : 'Geometrie sulla mappa';
  $('#geomulti-tiles').checked = tileAttive();
  renderRiepilogo(st);
  renderElenco(st);
  renderAvvisi(st, disegnate, motivo);

  openModal('#geomulti-overlay');
  // Come nell'editor: Leaflet legge le dimensioni del contenitore, e su un div
  // ancora nascosto (0×0) disegnerebbe una mappa grigia che non si riprende.
  setTimeout(() => {
    creaMappa();
    mappa.invalidateSize();
    disegna();
    inquadraTutto();
  }, 30);
}

function copia(testo, messaggio) {
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

export function initGeoMulti() {
  const overlay = $('#geomulti-overlay');
  if (!overlay) return;

  $('#geomulti-close').addEventListener('click', () => closeModal('#geomulti-overlay'));
  $('#geomulti-fit').addEventListener('click', () => { if (mappa) inquadraTutto(); });
  $('#geomulti-tiles').addEventListener('change', (e) => {
    impostaTile(e.target.checked);
    applicaTile();
  });
  $('#geomulti-copy').addEventListener('click', () => {
    if (stato) copia(riepilogoTsv(stato.st), 'Riepilogo copiato');
  });
  // Esportazione: FeatureCollection dell'INTERA selezione, comprese le
  // geometrie non disegnate — è il file che si apre in QGIS o su geojson.io.
  $('#geomulti-export').addEventListener('click', () => {
    if (!stato) return;
    const testo = JSON.stringify(featureCollection(stato.st.geometrie), null, 2);
    const url = URL.createObjectURL(new Blob([testo], { type: 'application/geo+json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'selezione.geojson';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Gestori delegati: riepilogo ed elenco vengono riscritti a ogni apertura.
  $('#geomulti-summary').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-copia]');
    if (!td || !td.dataset.copia || td.dataset.copia === '—') return;
    copia(td.dataset.copia, `Copiato: ${td.dataset.copia}`);
  });
  $('#geomulti-list').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr || !stato) return;
    const indice = Number(tr.dataset.i);
    const g = stato.disegnate.find((x) => x.indice === indice);
    if (!g) {
      toast('Questa geometria non è disegnata sulla mappa (proiettata o oltre il limite di disegno)', true);
      return;
    }
    evidenzia(indice);
  });
}
