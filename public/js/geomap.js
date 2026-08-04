'use strict';

/* ---------------------------------------------------------------------------
 * Editor geografico: una geometria si guarda e si modifica su una MAPPA.
 *
 * Perché esiste: una colonna GEOMETRY/geography, o un campo GeoJSON su
 * MongoDB, in una griglia è una riga di JSON illeggibile — e correggerla a mano
 * significa scrivere coordinate a occhio. Qui la stessa geometria è un disegno
 * trascinabile, e il JSON resta accanto: le due viste sono LA STESSA COSA e si
 * aggiornano a vicenda (mappa → testo a ogni trascinamento, testo → mappa a
 * ogni modifica valida).
 *
 * Formato: sempre e solo GeoJSON ({ type, coordinates }), lo stesso che il
 * server produce e accetta per tutti e tre i DBMS (vedi db/geometry.js).
 *
 * Leaflet è VENDORIZZATO in public/vendor/leaflet (nessuna build, nessuna CDN)
 * e viene caricato solo quando questa finestra si apre la prima volta: chi non
 * tocca geometrie non paga 150 KB di libreria.
 *
 * Le TILE di sfondo (OpenStreetMap) sono l'unica richiesta esterna dell'intera
 * applicazione: sono opzionali, la scelta è ricordata, e senza di esse
 * l'editor funziona identico su sfondo neutro.
 * ------------------------------------------------------------------------- */

import { $, toast, openModal, closeModal } from './utils.js';
import {
  isGeometry, geometryLabel, fmtCoord, posizioni, scriviPosizione, chiuso, fuoriDaLonLat,
} from './geojson.js';
import { caricaLeaflet, tileAttive, impostaTile, TILE_URL, TILE_ATTR } from './geo-leaflet.js';

// Ri-esportati per comodita' di chi apre l'editor: chi importa geomap.js ha
// gia' quello che serve per riconoscere ed etichettare una geometria.
export { isGeometry, geometryLabel };

// Tipi disegnabili/modificabili con le maniglie. Gli altri (Multi*,
// GeometryCollection) si vedono sulla mappa ma si modificano dal JSON: dare
// maniglie a geometrie annidate richiederebbe un'interfaccia a parte, e un
// editor a metà su dati altrui è peggio di un editor che dichiara il limite.
const MODIFICABILI = new Set(['Point', 'MultiPoint', 'LineString', 'Polygon']);

let L = null;              // Leaflet (caricato su richiesta da geo-leaflet.js)
let mappa = null;          // istanza L.map
let livelloTile = null;
// Forma e maniglie stanno su DUE canvas distinti: spostare una maniglia
// ridisegna solo il canvas delle maniglie, aggiornare la forma solo il suo. Con
// un unico renderer ogni `setLatLng` per fotogramma costringeva a ridisegnare
// anche il poligono, e ogni aggiornamento del poligono tutti i cerchietti.
let gruppoForma = null;    // L.LayerGroup della geometria
let gruppoManiglie = null; // L.LayerGroup dei vertici trascinabili
let stato = null;          // { geo, onSave, readOnly, campo }
let rendererForma = null;  // L.canvas dedicato alla geometria
let rendererManiglie = null; // L.canvas dedicato ai vertici
let layerForma = null;     // polyline/polygon della geometria, aggiornata in posto
let manigliePerPercorso = new Map(); // percorso serializzato → marker (lookup O(1))
let numVertici = 0;        // quanti vertici ha la geometria disegnata
let timerTesto = 0;        // debounce del JSON digitato a mano
let trascinando = false;   // trascinamento di un vertice in corso
let fineTrascinamento = 0; // istante dell'ultimo rilascio (vedi aggiungiPunto)

/* --------------------------------- Mappa --------------------------------- */

const latlng = (pos) => [Number(pos[1]), Number(pos[0])]; // GeoJSON [lon,lat] → Leaflet [lat,lng]

// Oltre questa soglia le maniglie non si disegnano: un confine amministrativo
// reale ha decine di migliaia di vertici e altrettanti cerchietti trascinabili
// bloccherebbero il browser — per una geometria simile, comunque, si corregge
// il JSON, non si trascina un punto alla volta.
const MAX_MANIGLIE = 2000;
// I tooltip costano un oggetto Leaflet per maniglia: sotto questa soglia sono
// utili (poche decine di vertici), sopra sono solo peso.
const MAX_TOOLTIP = 200;
// Oltre questi vertici il JSON si riscrive solo a fine trascinamento: vedi la
// nota in trascina().
const MAX_TESTO_LIVE = 500;

// Conversione GeoJSON → strutture latlng di Leaflet, con la stessa nidificazione
// che `setLatLngs` si aspetta. Serve a poter AGGIORNARE la forma esistente
// durante il trascinamento invece di ricrearla.
function latlngsDi(geo) {
  switch (geo.type) {
    case 'LineString':
    case 'MultiPoint':
      return geo.coordinates.map(latlng);
    case 'Polygon':
    case 'MultiLineString':
      return geo.coordinates.map((r) => r.map(latlng));
    case 'MultiPolygon':
      return geo.coordinates.map((p) => p.map((r) => r.map(latlng)));
    default:
      return [];
  }
}

function costruisciForma(geo) {
  const stile = { color: '#007acc', weight: 3, fillColor: '#007acc', fillOpacity: 0.18, renderer: rendererForma };
  if (geo.type === 'Polygon' || geo.type === 'MultiPolygon') return L.polygon(latlngsDi(geo), stile);
  if (geo.type === 'LineString' || geo.type === 'MultiLineString') return L.polyline(latlngsDi(geo), stile);
  if (geo.type === 'GeometryCollection') {
    // Non modificabile con le maniglie: basta il render statico di Leaflet.
    try { return L.geoJSON(geo, { style: () => stile }); } catch { return null; }
  }
  return null; // Point / MultiPoint: solo maniglie
}

/**
 * Ricostruzione COMPLETA della scena. Si chiama all'apertura, al cambio di
 * tipo, dopo una modifica del JSON e a fine trascinamento — mai durante, dove
 * si aggiorna in posto (vedi trascina()).
 */
function disegna() {
  if (!mappa || !stato) return;
  gruppoForma.clearLayers();
  layerForma = null;
  const geo = stato.geo;
  numVertici = 0;
  if (!isGeometry(geo)) { disegnaManiglie(); return; }

  layerForma = costruisciForma(geo);
  if (layerForma) layerForma.addTo(gruppoForma);
  numVertici = posizioni(geo).length;
  disegnaManiglie();
}

/**
 * Maniglie VISIBILI, e solo quelle.
 *
 * Ogni cerchietto è un disegno su canvas che viene rifatto a ogni movimento
 * della mappa: con una geometria reale (un poligono catastale ha facilmente
 * centinaia di vertici) si pagava il disegno di TUTTI i vertici anche mentre se
 * ne guardava un angolo, e lo stesso a ogni fotogramma di trascinamento. Qui si
 * costruiscono solo le maniglie dentro il riquadro visibile, con un margine per
 * non farle comparire di scatto al bordo; muovendo la mappa si ricalcolano.
 * Editare un vertice richiede comunque di vederlo, quindi non si perde nulla.
 */
function disegnaManiglie() {
  if (!mappa || !stato) return;
  gruppoManiglie.clearLayers();
  manigliePerPercorso = new Map();
  const geo = stato.geo;
  if (!isGeometry(geo)) { aggiornaAvvisoManiglie(0, 0); return; }

  const punti = posizioni(geo);
  const vista = mappa.getBounds().pad(0.25);
  const visibili = punti.filter(({ pos }) =>
    Array.isArray(pos) && pos.length >= 2
    && Number.isFinite(Number(pos[0])) && Number.isFinite(Number(pos[1]))
    && vista.contains(latlng(pos)));

  // Troppi vertici ANCHE solo nel riquadro visibile: disegnarli non aiuta
  // (sarebbero indistinguibili) e costa a ogni fotogramma. Si dice di
  // ingrandire, che è l'unico modo sensato di lavorarci comunque.
  if (visibili.length > MAX_MANIGLIE) {
    aggiornaAvvisoManiglie(punti.length, visibili.length);
    return;
  }
  aggiornaAvvisoManiglie(punti.length, 0);

  const modificabile = !stato.readOnly && MODIFICABILI.has(geo.type);
  const conTooltip = visibili.length <= MAX_TOOLTIP;

  for (const { percorso, pos } of visibili) {
    const m = L.circleMarker(latlng(pos), {
      radius: 6, color: '#fff', weight: 2, fillColor: '#e0a800', fillOpacity: 1,
      renderer: rendererManiglie,
    }).addTo(gruppoManiglie);
    manigliePerPercorso.set(percorso.join('/'), m);
    if (conTooltip) m.bindTooltip(fmtCoord(pos), { direction: 'top' });
    if (!modificabile) continue;

    m.on('mousedown', (ev) => trascina(ev, percorso, pos.length > 2 ? pos[2] : null));
    // Tasto destro su un vertice = eliminalo (dove ha senso).
    m.on('contextmenu', (ev) => {
      ev.originalEvent.preventDefault();
      eliminaVertice(percorso);
    });
  }
}

/**
 * Trascinamento di un vertice.
 *
 * `circleMarker` non è trascinabile di suo, quindi si segue il puntatore finché
 * non si rilascia. Il punto delicato è il COSTO per fotogramma: prima qui si
 * chiamavano `aggiornaTesto()` (JSON.stringify dell'intera geometria) e
 * `disegna()` (clearLayers + ricostruzione di forma, maniglie, tooltip e
 * gestori di evento) a ogni singolo `mousemove`, cioè decine di volte al
 * secondo — da cui lo scatto. Ora per fotogramma si fa solo:
 *   - scrittura della coordinata nel modello,
 *   - `setLatLng` sulle maniglie e `setLatLngs` sulla forma già esistenti,
 * e il testo si aggiorna una volta per frame (requestAnimationFrame).
 * La ricostruzione completa avviene una sola volta, al rilascio.
 */
function trascina(ev, percorso, quota) {
  ev.originalEvent.preventDefault();
  mappa.dragging.disable();
  trascinando = true;
  let ultimo = null;
  let raf = 0;

  const applica = () => {
    raf = 0;
    if (!ultimo) return;
    const nuova = [Number(ultimo.lng.toFixed(7)), Number(ultimo.lat.toFixed(7))];
    if (quota != null) nuova.push(quota);
    const gemello = scriviPosizioneChiudendo(stato.geo, percorso, nuova);
    // Si spostano solo le maniglie realmente cambiate: quella trascinata e, se
    // è il capo di un anello, la sua gemella di chiusura.
    muoviManiglia(percorso, nuova);
    if (gemello) muoviManiglia(gemello, nuova);
    if (layerForma && layerForma.setLatLngs) layerForma.setLatLngs(latlngsDi(stato.geo));
    // Il JSON è lungo quanto la geometria: rigenerarlo a ogni fotogramma su una
    // forma con centinaia di vertici costa più del disegno stesso. Sotto la
    // soglia si aggiorna in diretta (è il senso delle due viste sincronizzate),
    // sopra si aggiorna al rilascio.
    if (numVertici <= MAX_TESTO_LIVE) aggiornaTesto();
  };

  const muovi = (e) => {
    ultimo = e.latlng;
    // Coalescenza per fotogramma: il browser emette `mousemove` più spesso di
    // quanto abbia senso ridisegnare, e lavorare a ogni evento è tempo buttato.
    if (!raf) raf = requestAnimationFrame(applica);
  };
  const rilascia = () => {
    if (raf) { cancelAnimationFrame(raf); applica(); }
    // Sulle geometrie grandi il testo NON è stato aggiornato durante il
    // trascinamento (vedi sopra): senza questa riga resterebbe indietro rispetto
    // alla mappa, cioè le due viste smetterebbero di essere la stessa cosa.
    aggiornaTesto();
    trascinando = false;
    fineTrascinamento = Date.now();
    mappa.dragging.enable();
    mappa.off('mousemove', muovi);
    mappa.off('mouseup', rilascia);
    disegna(); // una sola ricostruzione, a trascinamento finito
  };
  mappa.on('mousemove', muovi);
  mappa.on('mouseup', rilascia);
}

/**
 * Scrive la posizione tenendo CHIUSO l'anello del poligono. Il primo e
 * l'ultimo vertice di un anello sono lo stesso punto: spostandone uno solo
 * l'anello si apriva, e la geometria veniva poi rifiutata al salvataggio con un
 * errore che l'utente non poteva collegare al trascinamento appena fatto.
 *
 * Ritorna il percorso del vertice "gemello" aggiornato, o null.
 */
function scriviPosizioneChiudendo(geo, percorso, nuova) {
  scriviPosizione(geo, percorso, nuova);
  const anello = anelloDi(geo, percorso);
  if (!anello || anello.length < 2) return null;
  const i = percorso[percorso.length - 1];
  const gemello = (j) => [...percorso.slice(0, -1), j];
  if (i === 0) {
    anello[anello.length - 1] = [...nuova];
    return gemello(anello.length - 1);
  }
  if (i === anello.length - 1) {
    anello[0] = [...nuova];
    return gemello(0);
  }
  return null;
}

function muoviManiglia(percorso, pos) {
  const m = manigliePerPercorso.get(percorso.join('/'));
  if (m) m.setLatLng(latlng(pos));
}

// L'anello (array di posizioni) che contiene la posizione indicata dal
// percorso, se la geometria è fatta di anelli chiusi.
function anelloDi(geo, percorso) {
  if (geo.type === 'Polygon') return geo.coordinates[percorso[0]];
  if (geo.type === 'MultiPolygon') return geo.coordinates[percorso[0]]?.[percorso[1]];
  return null;
}

// `totali` = vertici della geometria, `troppiInVista` = quanti ce ne sono nel
// riquadro visibile quando sono troppi per disegnarli (0 = maniglie disegnate).
function aggiornaAvvisoManiglie(totali, troppiInVista) {
  const el = $('#geomap-handles-note');
  if (!el) return;
  const n = (v) => v.toLocaleString('it-IT');
  el.textContent = troppiInVista
    ? `${n(troppiInVista)} vertici nel riquadro visibile (${n(totali)} in tutto): troppi per disegnare le maniglie senza rallentare la mappa. Ingrandisci per modificarli, oppure usa il JSON qui accanto.`
    : '';
  el.classList.toggle('hidden', !troppiInVista);
}

function eliminaVertice(percorso) {
  const geo = stato.geo;
  if (!MODIFICABILI.has(geo.type) || geo.type === 'Point') {
    toast('Un Point ha una sola posizione: cambia il tipo per eliminarla.', true);
    return;
  }
  const minimi = geo.type === 'Polygon' ? 4 : (geo.type === 'LineString' ? 2 : 1);
  const anello = geo.type === 'Polygon' ? geo.coordinates[percorso[0]] : geo.coordinates;
  if (anello.length <= minimi) {
    toast(`Servono almeno ${minimi} posizioni per un ${geo.type}.`, true);
    return;
  }
  const idx = percorso[percorso.length - 1];
  anello.splice(idx, 1);
  if (geo.type === 'Polygon') chiudiAnello(anello, idx === 0);
  aggiornaTesto();
  disegna();
}

// Un anello di poligono deve avere la prima posizione ripetuta in fondo: se si
// tocca il primo vertice va riallineato l'ultimo (e viceversa), altrimenti il
// database rifiuta la geometria e l'utente non capirebbe perché.
function chiudiAnello(anello, primoModificato) {
  if (anello.length < 2) return;
  if (primoModificato) anello[anello.length - 1] = [...anello[0]];
  else anello[0] = [...anello[anello.length - 1]];
}

function aggiungiPunto(latlngClick) {
  const geo = stato.geo;
  if (stato.readOnly || !MODIFICABILI.has(geo.type)) return;
  // Il clic sulla mappa arriva anche subito DOPO aver rilasciato un vertice
  // (Leaflet non sempre ferma la propagazione dei layer vettoriali): senza
  // questa guardia ogni trascinamento lasciava dietro di sé un vertice in più,
  // comparso dal nulla proprio dove l'utente aveva appena finito di lavorare.
  if (trascinando || Date.now() - fineTrascinamento < 300) return;
  const nuova = [Number(latlngClick.lng.toFixed(7)), Number(latlngClick.lat.toFixed(7))];
  if (geo.type === 'Point') {
    geo.coordinates = nuova; // un Point si sposta, non si moltiplica
  } else if (geo.type === 'Polygon') {
    const anello = geo.coordinates[0] || (geo.coordinates[0] = []);
    // Il nuovo vertice entra PRIMA della ripetizione di chiusura.
    if (anello.length >= 2) anello.splice(anello.length - 1, 0, nuova);
    else anello.push(nuova);
    if (anello.length >= 3 && !chiuso(anello)) anello.push([...anello[0]]);
  } else {
    geo.coordinates.push(nuova);
  }
  aggiornaTesto();
  disegna();
}

function inquadra() {
  if (!mappa || !isGeometry(stato.geo)) return;
  const punti = posizioni(stato.geo)
    .filter(({ pos }) => Array.isArray(pos) && pos.length >= 2 && Number.isFinite(Number(pos[0])) && Number.isFinite(Number(pos[1])))
    .map(({ pos }) => latlng(pos));
  if (!punti.length) return;
  if (punti.length === 1) mappa.setView(punti[0], Math.max(mappa.getZoom(), 13));
  else mappa.fitBounds(L.latLngBounds(punti), { padding: [30, 30] });
}

/* ---------------------------- Testo ⇄ geometria --------------------------- */

function aggiornaTesto() {
  const ta = $('#geomap-json');
  if (ta) ta.value = JSON.stringify(stato.geo, null, 2);
  aggiornaIntestazione();
}

function aggiornaIntestazione() {
  const info = $('#geomap-info');
  if (info) info.textContent = isGeometry(stato.geo) ? geometryLabel(stato.geo) : 'geometria non valida';
  const avviso = $('#geomap-warning');
  if (avviso) {
    const proiettata = isGeometry(stato.geo) && fuoriDaLonLat(stato.geo);
    avviso.textContent = proiettata
      ? 'Coordinate fuori dall\'intervallo longitudine/latitudine: la geometria è probabilmente PROIETTATA (es. metri EPSG:3857). La posizione sulla mappa non è attendibile; modifica pure il JSON.'
      : '';
    avviso.classList.toggle('hidden', !proiettata);
  }
  const nonModificabile = isGeometry(stato.geo) && !MODIFICABILI.has(stato.geo.type);
  const nota = $('#geomap-note');
  if (nota) {
    nota.textContent = nonModificabile
      ? `Le geometrie ${stato.geo.type} si visualizzano sulla mappa ma si modificano dal JSON qui accanto.`
      : (stato.readOnly ? '' : 'Clic sulla mappa = aggiungi un punto · trascina un vertice = spostalo · tasto destro su un vertice = eliminalo.');
    nota.classList.toggle('hidden', !nota.textContent);
  }
}

function leggiTesto() {
  const ta = $('#geomap-json');
  const err = $('#geomap-error');
  if (!ta) return;
  let parsed;
  try {
    parsed = JSON.parse(ta.value);
  } catch (e) {
    err.textContent = `JSON non valido: ${e.message}`;
    err.classList.remove('hidden');
    return;
  }
  if (!isGeometry(parsed)) {
    err.textContent = 'Non è una geometria GeoJSON: serve { "type": "Point|LineString|Polygon|…", "coordinates": [...] }.';
    err.classList.remove('hidden');
    return;
  }
  err.classList.add('hidden');
  stato.geo = parsed;
  aggiornaIntestazione();
  disegna();
}

/* --------------------------------- Modale -------------------------------- */

function applicaTile() {
  if (!mappa) return;
  const attive = tileAttive();
  if (attive && !livelloTile) {
    livelloTile = L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: TILE_ATTR,
      // Niente richieste di tile durante l'animazione di zoom: sarebbero
      // scaricate e buttate al fotogramma dopo.
      updateWhenZooming: false,
    }).addTo(mappa);
  } else if (!attive && livelloTile) {
    mappa.removeLayer(livelloTile);
    livelloTile = null;
  }
}

function creaMappa() {
  if (mappa) return;
  // `preferCanvas`: le geometrie finiscono su canvas invece che su un elemento
  // SVG per vertice — con qualche centinaio di maniglie la differenza in
  // fluidità è netta e il DOM resta leggero.
  mappa = L.map('geomap-canvas', { center: [41.9, 12.5], zoom: 5, zoomControl: true, preferCanvas: true });
  rendererForma = L.canvas({ padding: 0.2 });
  rendererManiglie = L.canvas({ padding: 0.2 });
  gruppoForma = L.layerGroup().addTo(mappa);
  gruppoManiglie = L.layerGroup().addTo(mappa);
  applicaTile();
  mappa.on('click', (e) => aggiungiPunto(e.latlng));
  // Le maniglie visibili cambiano quando cambia il riquadro. Si ricalcolano a
  // movimento FINITO (non durante il pan, che deve restare fluido) e mai in
  // mezzo a un trascinamento, dove le maniglie esistenti sono già quelle giuste.
  mappa.on('moveend zoomend', () => { if (!trascinando) disegnaManiglie(); });
}

/**
 * Il selettore elenca i quattro tipi convertibili con le maniglie. Se la
 * geometria aperta è di un ALTRO tipo (MultiPolygon, GeometryCollection) va
 * comunque mostrata: prima il `select` non trovava l'opzione e si presentava
 * vuoto, facendo credere che la geometria non avesse un tipo. La si aggiunge
 * come voce disabilitata — visibile, non selezionabile, perché convertire un
 * MultiPolygon in Polygon butterebbe via dei dati.
 */
function preparaSelettoreTipo(readOnly) {
  const sel = $('#geomap-type');
  if (!sel) return;
  sel.querySelectorAll('option[data-extra]').forEach((o) => o.remove());
  const tipo = isGeometry(stato.geo) ? stato.geo.type : 'Point';
  if (!MODIFICABILI.has(tipo)) {
    const o = document.createElement('option');
    o.value = tipo;
    o.textContent = `${tipo} (non convertibile)`;
    o.disabled = true;
    o.dataset.extra = '1';
    sel.appendChild(o);
  }
  sel.value = tipo;
  sel.disabled = !!readOnly;
}

/**
 * Apre l'editor su una geometria.
 *
 * @param {object} opts
 * @param {object} opts.value    geometria GeoJSON di partenza (o null: si parte da un Point)
 * @param {string} opts.campo    nome del campo/colonna, per il titolo
 * @param {boolean} opts.readOnly sola visualizzazione
 * @param {(geo: object) => void} opts.onSave chiamata con la geometria confermata
 */
export async function openGeoEditor({ value, campo = '', readOnly = false, onSave = null }) {
  try {
    L = await caricaLeaflet();
  } catch (err) {
    toast(err.message, true);
    return;
  }

  stato = {
    // Copia profonda: finché non si conferma, il valore nella griglia non deve
    // cambiare (annullare significa annullare davvero).
    geo: isGeometry(value) ? JSON.parse(JSON.stringify(value)) : { type: 'Point', coordinates: [12.4964, 41.9028] },
    readOnly,
    onSave,
    campo,
  };

  $('#geomap-title').textContent = campo ? `Geometria — ${campo}` : 'Geometria';
  $('#geomap-error').classList.add('hidden');
  $('#geomap-json').readOnly = !!readOnly;
  $('#geomap-save').classList.toggle('hidden', !!readOnly);
  preparaSelettoreTipo(readOnly);
  $('#geomap-tiles').checked = tileAttive();
  aggiornaTesto();

  openModal('#geomap-overlay');
  // La mappa va creata/ridimensionata DOPO che il contenitore è visibile:
  // Leaflet legge le dimensioni del div e su un contenitore nascosto (0×0)
  // disegnerebbe una mappa grigia che non si aggiusta più da sola.
  setTimeout(() => {
    creaMappa();
    mappa.invalidateSize();
    disegna();
    inquadra();
  }, 30);
}

// Converte la geometria corrente in un altro tipo, riusando le posizioni già
// presenti: cambiare tipo senza ridisegnare da capo è il caso normale (un
// Point tracciato per sbaglio al posto di un LineString).
function cambiaTipo(nuovo) {
  const punti = posizioni(stato.geo).map(({ pos }) => pos).filter((p) => Array.isArray(p) && p.length >= 2);
  const primo = punti[0] || [12.4964, 41.9028];
  if (nuovo === 'Point') {
    stato.geo = { type: 'Point', coordinates: primo };
  } else if (nuovo === 'MultiPoint' || nuovo === 'LineString') {
    const lista = punti.length >= 2 ? punti : [primo, [primo[0] + 0.01, primo[1] + 0.01]];
    stato.geo = { type: nuovo, coordinates: lista };
  } else if (nuovo === 'Polygon') {
    let anello = punti.length >= 3 ? [...punti] : [
      primo, [primo[0] + 0.01, primo[1]], [primo[0] + 0.01, primo[1] + 0.01],
    ];
    if (!chiuso(anello)) anello.push([...anello[0]]);
    stato.geo = { type: 'Polygon', coordinates: [anello] };
  }
  aggiornaTesto();
  disegna();
  inquadra();
}

export function initGeoMap() {
  const overlay = $('#geomap-overlay');
  if (!overlay) return;

  $('#geomap-cancel').addEventListener('click', () => closeModal('#geomap-overlay'));

  $('#geomap-save').addEventListener('click', () => {
    clearTimeout(timerTesto);
    leggiTesto(); // eventuali modifiche a mano non ancora applicate (debounce compreso)
    if (!$('#geomap-error').classList.contains('hidden')) return;
    if (!isGeometry(stato.geo)) {
      toast('Geometria non valida.', true);
      return;
    }
    const salva = stato.onSave;
    const geo = stato.geo;
    closeModal('#geomap-overlay');
    if (salva) salva(geo);
  });

  // Il JSON digitato a mano si rilegge con un piccolo ritardo: analizzare e
  // ridisegnare a ogni tasto premuto significa, su una geometria lunga, un
  // parse completo per carattere — e mostra errori di sintassi mentre si sta
  // ancora scrivendo.
  $('#geomap-json').addEventListener('input', () => {
    clearTimeout(timerTesto);
    timerTesto = setTimeout(leggiTesto, 200);
  });
  $('#geomap-fit').addEventListener('click', () => inquadra());
  $('#geomap-type').addEventListener('change', (e) => cambiaTipo(e.target.value));
  $('#geomap-tiles').addEventListener('change', (e) => {
    impostaTile(e.target.checked);
    applicaTile();
  });
}
