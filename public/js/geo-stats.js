'use strict';

import { isGeometry, posizioni, fuoriDaLonLat } from './geojson.js';

/* ---------------------------------------------------------------------------
 * Statistiche di una selezione di celle GEOMETRICHE (quante geometrie, di che
 * tipo, quanti vertici, riquadro di delimitazione, lunghezza, area, centro).
 *
 * È il gemello di `cell-stats.js`, e sta a parte da `geomulti.js` per la stessa
 * ragione: è la parte che, sbagliata, NON si vede. Una mappa disegnata male
 * salta all'occhio al primo sguardo; un'area di 4,7 km² è un numero plausibile
 * che l'utente porta via e usa. Qui non si tocca il DOM e non si carica
 * Leaflet, quindi si prova in Node (`test/unit-geo-stats.js`, in `npm test`).
 *
 * Quattro scelte che non sono ovvie:
 *
 * 1. NON SI PROIETTA NULLA. Lunghezze e aree si calcolano sulla SFERA
 *    (haversine per le distanze, eccesso sferico per le aree, raggio medio
 *    WGS84): è l'unico calcolo possibile senza sapere in che sistema di
 *    riferimento sta l'utente. L'errore rispetto all'ellissoide è sotto lo 0,5%
 *    e viene dichiarato; una geometria euclidea "a occhio" su gradi decimali
 *    sbaglierebbe invece del 30% alle nostre latitudini, e in silenzio.
 *
 * 2. LE GEOMETRIE PROIETTATE SI CONTANO MA NON SI MISURANO. Coordinate fuori
 *    dall'intervallo lon/lat (metri EPSG:3857, coordinate catastali…) sono
 *    numeri che la formula sferica accetterebbe volentieri restituendo un'area
 *    priva di senso: restano fuori da lunghezza, area e riquadro, e il loro
 *    numero è nel riepilogo. Meglio "3 geometrie non misurabili" di un totale
 *    inventato.
 *
 * 3. IL CENTRO È IL CENTRO DEI VERTICI, E LO DICE. Non è il baricentro di
 *    un'area (che per un poligono con buchi è un altro punto, e per una
 *    selezione di tipi misti non è definito): è la media delle posizioni. Serve
 *    a inquadrare la mappa e a copiare un punto di riferimento, non a fare
 *    catasto — l'etichetta nell'interfaccia lo dichiara.
 *
 * 4. AREE E LUNGHEZZE SONO SEPARATE PER FAMIGLIA. Sommare il perimetro dei
 *    poligoni con la lunghezza delle linee dà un numero che non risponde ad
 *    alcuna domanda: `lunghezzaM` sono le linee, `perimetroM` i poligoni, e
 *    nell'interfaccia stanno su due righe distinte.
 * ------------------------------------------------------------------------- */

// Raggio medio terrestre WGS84 (IUGG), lo stesso usato da PostGIS per le
// misure su `geography` in modalità sferica.
const RAGGIO_M = 6371008.8;

const RAD = Math.PI / 180;

/**
 * Differenza di longitudine normalizzata nell'intervallo ±180°.
 *
 * Senza normalizzazione un lato che attraversa l'antimeridiano — da 179,5° a
 * −179,5°, cioè un grado di distanza — risulta lungo 359°: la lunghezza
 * diventa quasi il giro del mondo e l'area del poligono un numero privo di
 * senso. Non è un caso di laboratorio: le Figi, le Chatham, le rotte del
 * Pacifico e qualunque riquadro globale ci passano sopra.
 */
function deltaLon(lon1, lon2) {
  return ((Number(lon2) - Number(lon1) + 540) % 360) - 180;
}

/**
 * La geometria attraversa l'antimeridiano?
 *
 * Il segnale è un LATO la cui differenza di longitudine grezza supera i 180°:
 * significa che i due estremi stanno ai due capi opposti della scala e che il
 * cammino breve passa oltre ±180°. Non basta guardare la larghezza del
 * riquadro: una linea che va da −170° a +170° passando per lo zero è larga 340°
 * e non attraversa un bel niente.
 */
function attraversaLinea(punti) {
  for (let i = 1; i < punti.length; i++) {
    if (Math.abs(Number(punti[i][0]) - Number(punti[i - 1][0])) > 180) return true;
  }
  return false;
}

/** Distanza in metri fra due posizioni [lon, lat] (formula dell'emisenoverso). */
export function distanzaM(a, b) {
  const f1 = Number(a[1]) * RAD;
  const f2 = Number(b[1]) * RAD;
  const df = f2 - f1;
  const dl = deltaLon(a[0], b[0]) * RAD;
  const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * RAGGIO_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lunghezza in metri di una spezzata (array di posizioni). */
function lunghezzaSpezzata(linea) {
  let tot = 0;
  for (let i = 1; i < linea.length; i++) tot += distanzaM(linea[i - 1], linea[i]);
  return tot;
}

/**
 * Area in metri quadri racchiusa da un anello, per eccesso sferico. Il segno
 * dipende dal verso di percorrenza e qui non interessa (i buchi si sottraggono
 * esplicitamente), quindi si prende il valore assoluto.
 */
function areaAnello(anello) {
  if (!Array.isArray(anello) || anello.length < 4) return 0;
  let somma = 0;
  for (let i = 0; i < anello.length - 1; i++) {
    const [lon1, lat1] = anello[i];
    const [lon2, lat2] = anello[i + 1];
    somma += deltaLon(lon1, lon2) * RAD
      * (2 + Math.sin(Number(lat1) * RAD) + Math.sin(Number(lat2) * RAD));
  }
  return Math.abs(somma * RAGGIO_M * RAGGIO_M / 2);
}

/** Area di un poligono GeoJSON (primo anello meno i buchi). */
function areaPoligono(anelli) {
  if (!Array.isArray(anelli) || !anelli.length) return 0;
  const esterna = areaAnello(anelli[0]);
  const buchi = anelli.slice(1).reduce((t, a) => t + areaAnello(a), 0);
  return Math.max(esterna - buchi, 0);
}

/** Perimetro di un poligono: tutti i suoi anelli, buchi compresi. */
function perimetroPoligono(anelli) {
  return (anelli || []).reduce((t, a) => t + lunghezzaSpezzata(a || []), 0);
}

/**
 * Scompone una geometria (GeometryCollection comprese) nelle tre famiglie che
 * si misurano in modo diverso.
 */
function scomponi(geo, acc = { punti: [], linee: [], poligoni: [] }) {
  switch (geo.type) {
    case 'Point': acc.punti.push(geo.coordinates); break;
    case 'MultiPoint': acc.punti.push(...geo.coordinates); break;
    case 'LineString': acc.linee.push(geo.coordinates); break;
    case 'MultiLineString': acc.linee.push(...geo.coordinates); break;
    case 'Polygon': acc.poligoni.push(geo.coordinates); break;
    case 'MultiPolygon': acc.poligoni.push(...geo.coordinates); break;
    case 'GeometryCollection':
      for (const g of geo.geometries || []) if (isGeometry(g)) scomponi(g, acc);
      break;
    default: break;
  }
  return acc;
}

/** Posizione valida ([lon, lat] numerici finiti)? */
function posValida(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
}

/**
 * Misure di UNA geometria. `proiettata` = coordinate fuori dall'intervallo
 * lon/lat: le misure restano null (vedi nota 2 in testa al file).
 */
export function misureGeometria(geo) {
  const base = {
    tipo: geo && geo.type ? geo.type : '?',
    vertici: 0,
    proiettata: false,
    attraversaAntimeridiano: false,
    lunghezzaM: null,
    perimetroM: null,
    areaM2: null,
    bbox: null,
  };
  if (!isGeometry(geo)) return base;

  const punti = posizioni(geo).map(({ pos }) => pos).filter(posValida);
  base.vertici = punti.length;
  base.proiettata = fuoriDaLonLat(geo);
  if (base.proiettata || !punti.length) return base;

  base.bbox = punti.reduce(
    (b, p) => [
      Math.min(b[0], Number(p[0])), Math.min(b[1], Number(p[1])),
      Math.max(b[2], Number(p[0])), Math.max(b[3], Number(p[1])),
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
  // Il riquadro non sa avvolgersi: preso come min/max delle longitudini, una
  // geometria a cavallo dell'antimeridiano produce un rettangolo che copre
  // quasi tutto il pianeta invece della striscia stretta in cui sta davvero.
  // Non lo si corregge — un riquadro che si avvolge non è rappresentabile in
  // quella forma — lo si DICHIARA, così l'inquadratura automatica e il
  // riepilogo non sembrano semplicemente sbagliati.
  base.attraversaAntimeridiano = attraversaLinea(punti);

  const { linee, poligoni } = scomponi(geo);
  if (linee.length) base.lunghezzaM = linee.reduce((t, l) => t + lunghezzaSpezzata(l), 0);
  if (poligoni.length) {
    base.areaM2 = poligoni.reduce((t, p) => t + areaPoligono(p), 0);
    base.perimetroM = poligoni.reduce((t, p) => t + perimetroPoligono(p), 0);
  }
  return base;
}

/**
 * Estrae le geometrie da una selezione di celle.
 * `voci` = [{ valore, colonna, riga }]; ritorna le sole celle geometriche,
 * ciascuna con le proprie misure, più il conteggio di quelle scartate.
 */
export function raccogliGeometrie(voci) {
  const geometrie = [];
  let vuote = 0;
  let nonGeometriche = 0;
  for (const v of voci) {
    const valore = v && typeof v === 'object' && 'valore' in v ? v.valore : v;
    if (valore === null || valore === undefined || valore === '') { vuote++; continue; }
    if (!isGeometry(valore)) { nonGeometriche++; continue; }
    geometrie.push({
      geo: valore,
      colonna: v && v.colonna !== undefined ? v.colonna : '',
      riga: v && v.riga !== undefined ? v.riga : null,
      ...misureGeometria(valore),
    });
  }
  return { geometrie, vuote, nonGeometriche };
}

/**
 * Riepilogo complessivo di una selezione geometrica.
 * `voci` = come in `raccogliGeometrie`.
 */
export function statisticheGeo(voci) {
  const { geometrie, vuote, nonGeometriche } = raccogliGeometrie(voci);

  const perTipo = new Map();
  let vertici = 0;
  let lunghezzaM = 0;
  let perimetroM = 0;
  let areaM2 = 0;
  let conLunghezza = 0;
  let conArea = 0;
  let proiettate = 0;
  let antimeridiano = 0;
  let bbox = null;
  let sommaLon = 0;
  let sommaLat = 0;
  let puntiMisurabili = 0;

  for (const g of geometrie) {
    perTipo.set(g.tipo, (perTipo.get(g.tipo) || 0) + 1);
    vertici += g.vertici;
    if (g.proiettata) { proiettate++; continue; }
    if (g.attraversaAntimeridiano) antimeridiano++;
    if (g.lunghezzaM !== null) { lunghezzaM += g.lunghezzaM; conLunghezza++; }
    if (g.areaM2 !== null) { areaM2 += g.areaM2; perimetroM += g.perimetroM || 0; conArea++; }
    if (g.bbox) {
      bbox = bbox
        ? [Math.min(bbox[0], g.bbox[0]), Math.min(bbox[1], g.bbox[1]),
           Math.max(bbox[2], g.bbox[2]), Math.max(bbox[3], g.bbox[3])]
        : [...g.bbox];
    }
    for (const { pos } of posizioni(g.geo)) {
      if (!posValida(pos)) continue;
      sommaLon += Number(pos[0]);
      sommaLat += Number(pos[1]);
      puntiMisurabili++;
    }
  }

  return {
    geometrie,
    celle: voci.length,
    totale: geometrie.length,
    vuote,
    nonGeometriche,
    proiettate,
    // Geometrie a cavallo della linea del cambiamento di data: le misure sono
    // corrette (la differenza di longitudine e' normalizzata), ma il RIQUADRO
    // di delimitazione no: non sa avvolgersi, e inquadrarci sopra la mappa
    // mostrerebbe mezzo pianeta invece della striscia in cui la geometria sta
    // davvero. Si dichiara.
    antimeridiano,
    vertici,
    perTipo: [...perTipo.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    bbox,
    // Centro = media dei vertici misurabili (vedi nota 3 in testa al file).
    centro: puntiMisurabili ? [sommaLon / puntiMisurabili, sommaLat / puntiMisurabili] : null,
    lunghezzaM: conLunghezza ? lunghezzaM : null,
    perimetroM: conArea ? perimetroM : null,
    areaM2: conArea ? areaM2 : null,
    conLunghezza,
    conArea,
  };
}

/** Numero con separatori italiani (le migliaia contano: 12.480 vertici). */
function num(n, dec = 0) {
  return Number(n).toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/**
 * Distanza leggibile: metri sotto il chilometro, chilometri sopra. Le cifre
 * decimali calano man mano che il numero cresce — "1.204,37 km" dichiara una
 * precisione al centimetro che il calcolo sferico non ha.
 */
export function formattaDistanza(m) {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  if (Math.abs(m) < 1000) return `${num(m, m < 10 ? 2 : 0)} m`;
  const km = m / 1000;
  return `${num(km, km < 10 ? 3 : (km < 1000 ? 2 : 0))} km`;
}

/** Area leggibile: m², ettari, km². */
export function formattaArea(m2) {
  if (m2 === null || m2 === undefined || !Number.isFinite(m2)) return '—';
  if (Math.abs(m2) < 10000) return `${num(m2, m2 < 100 ? 2 : 0)} m²`;
  if (Math.abs(m2) < 1e6) return `${num(m2 / 10000, 2)} ha`;
  const km2 = m2 / 1e6;
  return `${num(km2, km2 < 1000 ? 2 : 0)} km²`;
}

/** Coordinate leggibili di un centro/vertice: "12,49640 E · 41,90280 N". */
export function formattaPunto(pos) {
  if (!posValida(pos)) return '—';
  const lon = Number(pos[0]);
  const lat = Number(pos[1]);
  const f = (v) => Math.abs(v).toFixed(5).replace('.', ',');
  return `${f(lon)} ${lon < 0 ? 'O' : 'E'} · ${f(lat)} ${lat < 0 ? 'S' : 'N'}`;
}

/**
 * Riga compatta per la barra di stato. Vuota se non c'è alcuna geometria: lì
 * lo spazio è già conteso dal riassunto numerico.
 */
export function riassuntoGeoBreve(st) {
  if (!st || !st.totale) return '';
  const parti = [`🗺 ${st.totale} geometrie`];
  if (st.perTipo.length === 1) parti[0] = `🗺 ${st.totale} ${st.perTipo[0][0]}`;
  parti.push(`${num(st.vertici)} vertici`);
  if (st.lunghezzaM !== null) parti.push(`↔ ${formattaDistanza(st.lunghezzaM)}`);
  if (st.areaM2 !== null) parti.push(`▦ ${formattaArea(st.areaM2)}`);
  if (st.proiettate) parti.push(`${st.proiettate} non misurabili`);
  return parti.join(' · ');
}

/**
 * FeatureCollection GeoJSON della selezione, per l'esportazione: è il formato
 * che qualunque altro strumento (QGIS, geojson.io, un foglio Leaflet) apre
 * senza conversioni. Le proprietà portano colonna e riga d'origine, così una
 * geometria esportata resta collegabile al dato da cui viene.
 */
export function featureCollection(geometrie) {
  return {
    type: 'FeatureCollection',
    features: geometrie.map((g, i) => ({
      type: 'Feature',
      properties: { n: i + 1, colonna: g.colonna || null, riga: g.riga === null ? null : g.riga + 1 },
      geometry: g.geo,
    })),
  };
}
