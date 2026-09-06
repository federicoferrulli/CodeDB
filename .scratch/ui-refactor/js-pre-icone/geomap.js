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
  creaGeometriaIniziale,
} from './geojson.js';
import { caricaLeaflet, tileAttive, impostaTile, TILE_URL, TILE_ATTR } from './geo-leaflet.js';
import {
  MODIFICABILI, multipart, numeroParti, parteDiPercorso, sequenzaDi, verticePiuVicino,
  aggiungiVertice, eliminaVertice, inserisciVerticeDopo, nuovaParte, eliminaParte,
  geometriaVuota, problemaGeometria, creaStoria,
} from './geo-modifica.js';
import { tokenTema } from './theme.js';

// Ri-esportati per comodita' di chi apre l'editor: chi importa geomap.js ha
// gia' quello che serve per riconoscere ed etichettare una geometria.
export { isGeometry, geometryLabel };

// Le REGOLE di modifica (quali tipi, quanti vertici servono, dove finisce un
// vertice nuovo) stanno in `geo-modifica.js`, pure e provate senza browser: qui
// resta la mappa, cioè il gesto e il disegno.

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

// Un dito non è un puntatore: bersagli e distanze di aggancio raddoppiano.
const puntatoreGrosso = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Quanto lontano da un vertice si può premere e intendere ANCORA quel vertice.
// Più larga della tolleranza del renderer perché qui non si sta trascinando: si
// sta solo scegliendo, e sbagliare bersaglio costa un altro clic, non un danno.
const RAGGIO_AGGANCIO = () => (puntatoreGrosso() ? 34 : 22);

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
      ...stileManiglia(percorso),
      renderer: rendererManiglie,
    }).addTo(gruppoManiglie);
    manigliePerPercorso.set(percorso.join('/'), m);
    if (conTooltip) m.bindTooltip(fmtCoord(pos), { direction: 'top' });
    if (!modificabile) continue;

    // Premere una maniglia la SELEZIONA e insieme comincia il trascinamento: i
    // bottoni azione (elimina, inserisci) agiscono sulla selezione, e chiedere
    // un gesto in più per sceglierla sarebbe un passaggio a vuoto.
    m.on('mousedown', (ev) => {
      seleziona(percorso);
      trascina(ev, percorso, pos.length > 2 ? pos[2] : null);
    });
    // Il cursore dice che lì si può prendere: senza, una maniglia è
    // indistinguibile da un disegno, e chi la manca crede che non risponda.
    m.on('mouseover', () => { if (!trascinando) impostaCursore('grab'); });
    m.on('mouseout', () => { if (!trascinando) impostaCursore(''); });
    // Tasto destro su un vertice = eliminalo. Resta la scorciatoia di chi la
    // conosce; il bottone è la via che si vede — e l'unica su un touch, dove il
    // tasto destro non esiste.
    m.on('contextmenu', (ev) => {
      ev.originalEvent.preventDefault();
      seleziona(percorso);
      applicaModifica((g) => eliminaVertice(g, percorso));
    });
  }
}

/**
 * Lo stile di una maniglia, selezionata o no.
 *
 * Il contorno è l'unico colore che segue il tema: con le tile spente il fondo
 * della mappa è quello della modale, e un anello bianco su fondo chiaro non si
 * vede. Il riempimento resta fisso, come i colori delle geometrie: deve
 * staccare dalle tile di OpenStreetMap, che non cambiano con il tema
 * dell'applicazione. Il vertice selezionato è più grande e di un altro colore,
 * perché è il bersaglio dei bottoni azione: senza, «elimina vertice» sarebbe un
 * bottone che agisce su qualcosa che non si sa quale sia.
 */
function stileManiglia(percorso) {
  const scelto = !!stato && Array.isArray(stato.selezione)
    && stato.selezione.join('/') === percorso.join('/');
  return {
    radius: scelto ? 10 : 7,
    color: scelto ? tokenTema('--geo-handle-selected-outline', '#fff') : tokenTema('--geo-handle-outline', '#fff'),
    weight: scelto ? 3 : 2,
    fillColor: scelto ? '#d6336c' : '#e0a800',
    fillOpacity: 1,
  };
}

/**
 * Ridipinge le sole maniglie, senza ricostruire la scena: cambiare selezione è
 * un cambio di STILE, e rifare forma, tooltip e gestori a ogni clic su un
 * vertice si sentirebbe su una geometria con centinaia di punti.
 */
function aggiornaStileManiglie() {
  for (const [chiave, m] of manigliePerPercorso) {
    if (m && m.setStyle) m.setStyle(stileManiglia(chiave.split('/')));
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
  // Anche spostare un vertice è una modifica da poter annullare. L'istantanea
  // si prende qui — dopo, la geometria viene mutata IN POSTO per non
  // ricostruire la scena a ogni fotogramma — ma si registra solo al primo
  // movimento vero: premere un vertice per SCEGLIERLO non cambia nulla, e
  // registrarlo lo stesso riempirebbe la storia di passi che non hanno
  // modificato niente, costringendo a premere «Annulla» più volte per disfare
  // una modifica sola.
  const primaDelTrascinamento = JSON.parse(JSON.stringify(stato.geo));
  let registrato = false;
  mappa.dragging.disable();
  trascinando = true;
  let ultimo = null;
  let raf = 0;

  const applica = () => {
    raf = 0;
    if (!ultimo) return;
    if (!registrato) { registrato = true; stato.storia.registra(primaDelTrascinamento); }
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
  let finito = false;
  const rilascia = () => {
    // Il rilascio può arrivare due volte (dalla mappa e dal documento): la
    // seconda non deve ricostruire tutto una seconda volta.
    if (finito) return;
    finito = true;
    if (raf) { cancelAnimationFrame(raf); applica(); }
    // Sulle geometrie grandi il testo NON è stato aggiornato durante il
    // trascinamento (vedi sopra): senza questa riga resterebbe indietro rispetto
    // alla mappa, cioè le due viste smetterebbero di essere la stessa cosa.
    aggiornaTesto();
    trascinando = false;
    fineTrascinamento = Date.now();
    impostaCursore('');
    mappa.dragging.enable();
    mappa.off('mousemove', muovi);
    mappa.off('mouseup', rilascia);
    document.removeEventListener('mouseup', rilascia);
    document.removeEventListener('pointerup', rilascia);
    disegna(); // una sola ricostruzione, a trascinamento finito
  };
  mappa.on('mousemove', muovi);
  mappa.on('mouseup', rilascia);
  // Leaflet emette `mouseup` solo per eventi che avvengono DENTRO il proprio
  // contenitore: rilasciando il pulsante fuori dal riquadro della mappa —
  // gesto normalissimo trascinando un vertice verso il bordo — `rilascia()`
  // non veniva mai eseguito. Restavano `trascinando = true`, il pan della
  // mappa disabilitato e i due gestori attaccati, e al rientro del puntatore
  // il vertice ricominciava a inseguirlo senza che nessun pulsante fosse
  // premuto. Il documento riceve il rilascio ovunque avvenga.
  document.addEventListener('mouseup', rilascia);
  document.addEventListener('pointerup', rilascia);
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

/**
 * Applica una modifica DICHIARATA dal modulo puro.
 *
 * Un solo punto in cui: si registra lo stato precedente per l'annullamento, si
 * riporta all'utente il rifiuto con la sua ragione, si aggiornano selezione e
 * parte attiva, e si ridisegnano testo e mappa. I bottoni azione qui sopra non
 * fanno altro che passare l'operazione.
 */
function applicaModifica(operazione, { silenzioso = false } = {}) {
  if (!stato || stato.readOnly) return false;
  const prima = stato.geo;
  const r = operazione(prima);
  if (r.errore) {
    if (!silenzioso) toast(r.errore, true);
    return false;
  }
  stato.storia.registra(prima);
  stato.geo = r.geo;
  if (r.selezione !== null) stato.selezione = r.selezione;
  if (r.parteAttiva !== null) stato.parteAttiva = r.parteAttiva;
  aggiornaTesto();
  disegna();
  return true;
}

/** Il vertice selezionato esiste ancora? La selezione sopravvive a ogni gesto. */
function selezioneValida() {
  if (!stato || !Array.isArray(stato.selezione)) return false;
  if (!isGeometry(stato.geo) || !MODIFICABILI.has(stato.geo.type)) return false;
  if (stato.geo.type === 'Point') return stato.selezione.length === 0;
  const sequenza = sequenzaDi(stato.geo, stato.selezione);
  return !!sequenza && stato.selezione[stato.selezione.length - 1] < sequenza.length;
}

function impostaCursore(valore) {
  const el = $('#geomap-canvas');
  if (el) el.style.cursor = valore;
}

/**
 * Il vertice che una pressione sulla mappa intendeva prendere.
 *
 * Le posizioni sullo schermo le sa solo la mappa; QUALE vertice vinca è invece
 * una regola pura (`verticePiuVicino`). Si guardano le sole maniglie disegnate,
 * che sono già quelle visibili: un vertice fuori dal riquadro non è ciò che si
 * stava cercando di premere.
 */
function verticeVicinoA(latlngClick) {
  if (!mappa || !manigliePerPercorso.size) return null;
  const punto = mappa.latLngToContainerPoint(latlngClick);
  const maniglie = [];
  for (const [chiave, m] of manigliePerPercorso) {
    const p = mappa.latLngToContainerPoint(m.getLatLng());
    // Chiave vuota = percorso vuoto: è il caso del Point, la cui unica
    // posizione non ha indici.
    maniglie.push({ percorso: chiave ? chiave.split('/').map(Number) : [], x: p.x, y: p.y });
  }
  return verticePiuVicino(maniglie, punto, RAGGIO_AGGANCIO());
}

function seleziona(percorso) {
  if (!stato) return;
  stato.selezione = percorso ? [...percorso] : null;
  if (percorso && multipart(stato.geo.type)) stato.parteAttiva = parteDiPercorso(stato.geo, percorso);
  aggiornaStileManiglie();
  aggiornaControlliDisegno();
}

/* ------------------------- I bottoni azione ------------------------------- */

function annulla() {
  if (!stato || stato.readOnly) return;
  const precedente = stato.storia.annulla(stato.geo);
  if (!precedente) { toast('Non c’è nulla da annullare.', true); return; }
  stato.geo = precedente;
  stato.selezione = null;
  stato.parteAttiva = Math.min(stato.parteAttiva || 0, Math.max(0, numeroParti(stato.geo) - 1));
  aggiornaTesto();
  disegna();
  preparaSelettoreTipo(stato.readOnly); // l'annullamento può riportare a un altro tipo
}

function ripeti() {
  if (!stato || stato.readOnly) return;
  const successivo = stato.storia.ripeti(stato.geo);
  if (!successivo) { toast('Non c’è nulla da rifare.', true); return; }
  stato.geo = successivo;
  stato.selezione = null;
  stato.parteAttiva = Math.min(stato.parteAttiva || 0, Math.max(0, numeroParti(stato.geo) - 1));
  aggiornaTesto();
  disegna();
  preparaSelettoreTipo(stato.readOnly);
}

function eliminaVerticeSelezionato() {
  if (!selezioneValida()) { toast('Seleziona prima un vertice sulla mappa.', true); return; }
  applicaModifica((g) => eliminaVertice(g, stato.selezione));
}

function inserisciDopoSelezionato() {
  if (!selezioneValida()) { toast('Seleziona il vertice dopo il quale inserirne uno nuovo.', true); return; }
  applicaModifica((g) => inserisciVerticeDopo(g, stato.selezione));
}

function eliminaParteAttiva() {
  if (!stato || !multipart(stato.geo.type)) return;
  if (applicaModifica((g) => eliminaParte(g, stato.parteAttiva || 0))) {
    stato.selezione = null;
    aggiornaControlliDisegno();
  }
}

function aggiungiPunto(latlngClick) {
  const geo = stato.geo;
  if (stato.readOnly || !MODIFICABILI.has(geo.type)) return;
  // Il clic sulla mappa arriva anche subito DOPO aver rilasciato un vertice
  // (Leaflet non sempre ferma la propagazione dei layer vettoriali): senza
  // questa guardia ogni trascinamento lasciava dietro di sé un vertice in più,
  // comparso dal nulla proprio dove l'utente aveva appena finito di lavorare.
  if (trascinando || Date.now() - fineTrascinamento < 300) return;
  // In modalità Modifica il clic non aggiunge: sceglie. E sceglie il vertice
  // che l'utente stava CERCANDO di prendere, non solo quello centrato al pixel:
  // mancare la maniglia di dieci pixel non deve essere indistinguibile dal
  // premere sul vuoto.
  if (stato.modo !== 'aggiungi') {
    seleziona(verticeVicinoA(latlngClick));
    return;
  }
  const nuova = [Number(latlngClick.lng.toFixed(7)), Number(latlngClick.lat.toFixed(7))];
  applicaModifica((g) => aggiungiVertice(g, nuova, stato.parteAttiva));
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
      : (stato.readOnly ? '' : (stato.modo === 'aggiungi'
        ? 'Disegna: il clic aggiunge un vertice alla parte attiva · trascina un vertice per spostarlo · Ctrl+Z annulla.'
        : 'Modifica: il clic sceglie un vertice (il clic sullo sfondo non aggiunge nulla) · Canc elimina · Ins inserisce a metà lato · Ctrl+Z annulla.'));
    nota.classList.toggle('hidden', !nota.textContent);
  }
  aggiornaControlliDisegno();
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
  if (JSON.stringify(parsed) !== JSON.stringify(stato.geo)) stato.storia.registra(stato.geo);
  stato.geo = parsed;
  // I percorsi dei vertici valgono per la geometria di prima: tenere la
  // selezione dopo una riscrittura del JSON significherebbe puntare a un
  // vertice che può non esistere più.
  stato.selezione = null;
  aggiornaIntestazione();
  // Il selettore del tipo deve seguire il JSON: restando indietro mostrava il
  // tipo PRECEDENTE, e il primo cambiamento successivo — o anche solo un clic
  // sul selettore — riconvertiva la geometria appena digitata verso quel tipo.
  preparaSelettoreTipo(stato.readOnly);
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
  // `tolerance` allarga il bersaglio delle maniglie SENZA ingrandire il
  // cerchietto: preso il raggio (7) più metà del contorno, prendere un vertice
  // richiedeva una mira di una decina di pixel — misurata, non stimata — e un
  // clic appena fuori non faceva nulla. Col dito serve molto di più: il
  // polpastrello copre un'area che il puntatore non ha.
  rendererManiglie = L.canvas({ padding: 0.2, tolerance: puntatoreGrosso() ? 20 : 10 });
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
 * Il selettore elenca tutti i tipi basati su coordinate. Se la geometria
 * aperta è una GeometryCollection va
 * comunque mostrata: prima il `select` non trovava l'opzione e si presentava
 * vuoto, facendo credere che la geometria non avesse un tipo. La si aggiunge
 * come voce disabilitata — visibile, non selezionabile, perché convertire un
 * GeometryCollection in un singolo tipo butterebbe via dei dati.
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
 * Lo stato dei bottoni azione.
 *
 * Un bottone disattivato dice, prima del clic, che quel gesto qui non ha senso:
 * «elimina vertice» senza un vertice selezionato, «elimina parte» su un tipo che
 * di parti ne ha una sola. Il `title` dice sempre PERCHÉ, perché un bottone
 * grigio e muto è solo un'occasione persa di spiegare.
 */
function aggiornaControlliDisegno() {
  if (!stato) return;
  const tipo = isGeometry(stato.geo) ? stato.geo.type : '';
  const modificabile = !stato.readOnly && MODIFICABILI.has(tipo);
  const piuParti = multipart(tipo);
  const selezione = selezioneValida() ? stato.selezione : null;
  const parti = numeroParti(stato.geo);

  const mostra = (sel, visibile) => {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', !visibile);
    return el;
  };
  const abilita = (sel, attivo, motivo) => {
    const el = $(sel);
    if (!el) return null;
    el.disabled = !attivo;
    if (motivo) el.title = motivo;
    return el;
  };

  const nuova = mostra('#geomap-new-part', modificabile && piuParti);
  if (nuova) {
    // È un bottone a sola icona: l'etichetta vive nel `title` e in
    // `aria-label`, che devono dire la stessa cosa — e dire QUALE parte, perché
    // «nuova parte» non si capisce se non si sa di che forma è fatta.
    const testo = tipo === 'MultiPolygon'
      ? 'Nuovo poligono: conclude quello corrente e ne inizia un altro'
      : 'Nuova linea: conclude quella corrente e ne inizia un’altra';
    nuova.title = testo;
    nuova.setAttribute('aria-label', testo);
  }
  mostra('#geomap-redraw', modificabile);
  mostra('#geomap-azioni', modificabile);
  mostra('#geomap-azioni-forma', modificabile);
  mostra('#geomap-del-part', modificabile && piuParti);

  abilita('#geomap-undo', modificabile && stato.storia.puoAnnullare(),
    stato.storia.puoAnnullare() ? 'Annulla l’ultima modifica (Ctrl+Z)' : 'Nessuna modifica da annullare');
  abilita('#geomap-redo', modificabile && stato.storia.puoRipetere(),
    stato.storia.puoRipetere() ? 'Rifà la modifica annullata (Ctrl+Shift+Z)' : 'Nessuna modifica da rifare');

  const vertice = selezione ? selezione[selezione.length - 1] : -1;
  const sequenza = selezione ? sequenzaDi(stato.geo, selezione) : null;
  abilita('#geomap-del-vertex', modificabile && !!selezione && tipo !== 'Point',
    !selezione ? 'Seleziona un vertice sulla mappa per eliminarlo'
      : (tipo === 'Point' ? 'Un Point ha una sola posizione: cambia il tipo' : 'Elimina il vertice selezionato (Canc)'));
  abilita('#geomap-insert-vertex', modificabile && !!selezione && tipo !== 'Point' && tipo !== 'MultiPoint',
    !selezione ? 'Seleziona il vertice dopo il quale inserirne uno nuovo'
      : 'Inserisce un vertice a metà del lato successivo (Ins)');
  abilita('#geomap-del-part', modificabile && piuParti && parti > 1,
    parti > 1 ? 'Elimina la parte attiva' : 'È l’ultima parte: usa «Ridisegna» per ricominciare');

  // Il controllo segmentato mostra ENTRAMBI gli stati, e quello attivo è
  // premuto: `aria-pressed` è anche ciò che lo dichiara a chi non vede il
  // colore. Le due modalità restano disponibili anche quando la geometria non
  // si modifica? No: lì il gruppo sparisce, perché non c'è nulla da disegnare.
  const gruppoModo = $('#geomap-mode');
  if (gruppoModo) gruppoModo.classList.toggle('hidden', !modificabile);
  const disegna_ = $('#geomap-mode-draw');
  const scegli = $('#geomap-mode-select');
  if (disegna_ && scegli) {
    const aggiunge = stato.modo === 'aggiungi';
    disegna_.setAttribute('aria-pressed', aggiunge ? 'true' : 'false');
    scegli.setAttribute('aria-pressed', aggiunge ? 'false' : 'true');
  }

  const info = $('#geomap-selezione');
  if (info) {
    const parte = selezione ? parteDiPercorso(stato.geo, selezione) : 0;
    info.textContent = !modificabile ? ''
      : (selezione
        ? `vertice ${vertice + 1} di ${sequenza ? sequenza.length : '?'}${piuParti ? ` · parte ${parte + 1} di ${parti}` : ''}`
        // Senza selezione la barra non descrive un vuoto: dice il gesto con cui
        // si esce dal vuoto, che è l'unica cosa utile in quel momento.
        : `premi un vertice per sceglierlo${piuParti ? ` · parte ${(stato.parteAttiva || 0) + 1} di ${parti}` : ''}`);
    info.classList.toggle('dim', !selezione);
  }
}

function ridisegnaDaZero() {
  if (!stato || stato.readOnly || !MODIFICABILI.has(stato.geo.type)) return;
  applicaModifica((g) => ({ geo: geometriaVuota(g.type), selezione: [], parteAttiva: 0, errore: '' }));
  stato.selezione = null;
  aggiornaControlliDisegno();
}

/**
 * Apre l'editor su una geometria.
 *
 * @param {object} opts
 * @param {object} opts.value    geometria GeoJSON di partenza (o null: si parte da un Point)
 * @param {string} opts.campo    nome del campo/colonna, per il titolo
 * @param {boolean} opts.readOnly sola visualizzazione
 * @param {string|null} opts.tipoSuggerito sottotipo dichiarato dalla colonna
 * @param {(geo: object) => void} opts.onSave chiamata con la geometria confermata
 */
export async function openGeoEditor({
  value, campo = '', readOnly = false, tipoSuggerito = null, onSave = null,
} = {}) {
  try {
    L = await caricaLeaflet();
  } catch (err) {
    toast(err.message, true);
    return;
  }

  const esistente = isGeometry(value);
  stato = {
    // Copia profonda: finché non si conferma, il valore nella griglia non deve
    // cambiare (annullare significa annullare davvero).
    geo: esistente
      ? JSON.parse(JSON.stringify(value))
      : creaGeometriaIniziale(MODIFICABILI.has(tipoSuggerito) ? tipoSuggerito : 'Point'),
    readOnly,
    onSave,
    campo,
    parteAttiva: 0,
    selezione: null,
    storia: creaStoria(),
    // Che cosa fa il clic sulla mappa dipende da che cosa si sta facendo: una
    // geometria NUOVA si disegna (il clic aggiunge vertici), una che ESISTE già
    // si corregge (il clic sceglie soltanto, e i vertici si aggiungono da un
    // bottone). Aprire in «aggiungi» una geometria esistente significava che il
    // primo clic sulla mappa — spesso solo per portare a fuoco la finestra —
    // le attaccava un vertice in coda.
    modo: esistente ? 'seleziona' : 'aggiungi',
  };
  if (multipart(stato.geo.type)) {
    stato.parteAttiva = Math.max(0, stato.geo.coordinates.length - 1);
  }

  $('#geomap-title').textContent = campo ? `Geometria — ${campo}` : 'Geometria';
  $('#geomap-error').classList.add('hidden');
  $('#geomap-json').readOnly = !!readOnly;
  $('#geomap-save').classList.toggle('hidden', !!readOnly);
  preparaSelettoreTipo(readOnly);
  $('#geomap-tiles').checked = tileAttive();
  $('#geomap-tiles-btn').setAttribute('aria-pressed', tileAttive() ? 'true' : 'false');
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
  // Il cambio di tipo è una modifica come le altre: annullabile, e con la
  // selezione azzerata perché i percorsi dei vertici cambiano forma.
  stato.storia.registra(stato.geo);
  stato.selezione = null;
  const punti = posizioni(stato.geo).map(({ pos }) => pos).filter((p) => Array.isArray(p) && p.length >= 2);
  const primo = punti[0] || [12.4964, 41.9028];
  if (nuovo === 'Point') {
    stato.geo = { type: 'Point', coordinates: primo };
  } else if (nuovo === 'MultiPoint' || nuovo === 'LineString') {
    const lista = punti.length >= 2 ? punti : [primo, [primo[0] + 0.01, primo[1] + 0.01]];
    stato.geo = { type: nuovo, coordinates: lista };
  } else if (nuovo === 'MultiLineString') {
    const lista = punti.length >= 2 ? punti : [primo, [primo[0] + 0.01, primo[1] + 0.01]];
    stato.geo = { type: nuovo, coordinates: [lista] };
  } else if (nuovo === 'Polygon' || nuovo === 'MultiPolygon') {
    let anello = punti.length >= 3 ? [...punti] : [
      primo, [primo[0] + 0.01, primo[1]], [primo[0] + 0.01, primo[1] + 0.01],
    ];
    if (!chiuso(anello)) anello.push([...anello[0]]);
    stato.geo = nuovo === 'Polygon'
      ? { type: nuovo, coordinates: [anello] }
      : { type: nuovo, coordinates: [[anello]] };
  }
  stato.parteAttiva = 0;
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
    const problema = problemaGeometria(stato.geo);
    if (problema) {
      $('#geomap-error').textContent = problema;
      $('#geomap-error').classList.remove('hidden');
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
  $('#geomap-redraw').addEventListener('click', ridisegnaDaZero);
  $('#geomap-new-part').addEventListener('click', () => {
    if (applicaModifica((g) => nuovaParte(g))) {
      // Una parte nuova è vuota: il clic torna ad aggiungere, altrimenti il
      // bottone aprirebbe qualcosa che poi non si può riempire.
      stato.modo = 'aggiungi';
      stato.selezione = null;
      aggiornaControlliDisegno();
      toast(stato.geo.type === 'MultiPolygon'
        ? 'Nuovo poligono attivo: aggiungi i vertici sulla mappa.'
        : 'Nuova linea attiva: aggiungi i vertici sulla mappa.');
    }
  });
  $('#geomap-undo').addEventListener('click', annulla);
  $('#geomap-redo').addEventListener('click', ripeti);
  $('#geomap-del-vertex').addEventListener('click', eliminaVerticeSelezionato);
  $('#geomap-insert-vertex').addEventListener('click', inserisciDopoSelezionato);
  $('#geomap-del-part').addEventListener('click', eliminaParteAttiva);
  const cambiaModo = (modo) => {
    if (!stato || stato.readOnly || stato.modo === modo) return;
    stato.modo = modo;
    // La nota sotto la mappa cambia con la modalità: dice che cosa farà il
    // prossimo clic, che è l'unica cosa che l'utente non può dedurre guardando.
    aggiornaIntestazione();
  };
  $('#geomap-mode-draw').addEventListener('click', () => cambiaModo('aggiungi'));
  $('#geomap-mode-select').addEventListener('click', () => cambiaModo('seleziona'));
  // Scorciatoie: valgono solo con l'editor aperto e mai mentre si scrive nel
  // JSON accanto alla mappa, dove Canc e Ctrl+Z appartengono al testo.
  document.addEventListener('keydown', (e) => {
    if (!stato || stato.readOnly) return;
    if ($('#geomap-overlay').classList.contains('hidden')) return;
    const dentroTesto = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
    if (dentroTesto) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); (e.shiftKey ? ripeti : annulla)(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); ripeti(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); eliminaVerticeSelezionato(); return; }
    if (e.key === 'Insert') { e.preventDefault(); inserisciDopoSelezionato(); }
  });
  $('#geomap-type').addEventListener('change', (e) => cambiaTipo(e.target.value));
  $('#geomap-tiles').addEventListener('change', (e) => {
    impostaTile(e.target.checked);
    $('#geomap-tiles-btn').setAttribute('aria-pressed', e.target.checked ? 'true' : 'false');
    applicaTile();
  });
  // L'interruttore visibile pilota la casella, che resta la sola sorgente dello
  // stato: due controlli con due verità sarebbero due stati da tenere allineati.
  $('#geomap-tiles-btn').addEventListener('click', () => {
    const box = $('#geomap-tiles');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  });
  // Il pannello GeoJSON si chiude quando serve tutta la mappa. Leaflet deve
  // rileggere le dimensioni del contenitore: senza `invalidateSize` la mappa
  // resta disegnata sulla larghezza di prima, con metà riquadro grigio.
  $('#geomap-json-btn').addEventListener('click', () => {
    const ta = $('#geomap-json');
    const chiuso_ = ta.classList.toggle('hidden');
    $('#geomap-json-btn').setAttribute('aria-pressed', chiuso_ ? 'false' : 'true');
    if (mappa) setTimeout(() => mappa.invalidateSize(), 0);
  });
}
