'use strict';

/* ---------------------------------------------------------------------------
 * Helper GeoJSON puri (nessun DOM, nessuna dipendenza).
 *
 * Stanno qui e non in geomap.js perché servono anche a chi NON apre la mappa:
 * `utils.js` li usa per rendere leggibile una cella geometrica nella griglia, e
 * `utils.js` è importato da tutti — importare geomap.js (che tira dentro
 * Leaflet e la modale) da lì creerebbe un ciclo per due funzioni di poche righe.
 * ------------------------------------------------------------------------- */

// Profondità dell'array `coordinates` per tipo (Point → [x,y] = 0 livelli).
export const PROFONDITA = {
  Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3,
};

export function isGeometry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.type !== 'string') return false;
  if (v.type === 'GeometryCollection') return Array.isArray(v.geometries);
  return PROFONDITA[v.type] !== undefined && Array.isArray(v.coordinates);
}

/* ---------------------------------------------------------------------------
 * Normalizzazione: cosa vale come geometria DA DISEGNARE.
 *
 * `isGeometry` risponde alla domanda stretta ("è GeoJSON?") e va lasciata così:
 * decide anche come una cella viene RESA nella griglia, e allargarla
 * trasformerebbe in "▦ Point" qualunque colonna JSON con dentro una x e una y.
 * Le MAPPE hanno però bisogno della domanda larga, perché la stessa geometria
 * arriva in tre forme a seconda di come la si è chiesta:
 *
 *   · oggetto GeoJSON      — MongoDB, e il percorso della griglia sui DB SQL;
 *   · TESTO GeoJSON        — `ST_AsGeoJSON(...)` in una query scritta a mano:
 *                            la tab ⚡ esegue la query così com'è e nessuno
 *                            converte;
 *   · coppia {x, y}        — il tipo `point` nativo di PostgreSQL (il driver
 *                            `pg` lo consegna così), un `JSON_OBJECT('x',…)` su
 *                            MySQL, o un campo con lat/lon separati.
 *
 * La coppia è l'unica euristica, e sta dentro due paletti dichiarati: SOLO due
 * chiavi riconosciute (niente altro nell'oggetto) e valori dentro l'intervallo
 * longitudine/latitudine. Senza, un vettore `{x: 1920, y: 1080}` finirebbe sulla
 * mappa; con, il caso peggiore è una coppia di numeri piccoli davvero ambigua —
 * e in quel caso la scheda mappa compare in più, non sbaglia un disegno.
 *
 * Ordine delle coordinate: `x` è la LONGITUDINE (è la convenzione di PostGIS,
 * di `point` e di GeoJSON stesso). Con nomi espliciti (lat/lon) si obbedisce ai
 * nomi, che è l'unico caso in cui il dubbio non esiste.
 * ------------------------------------------------------------------------- */

/** Oltre questa lunghezza non si tenta il parse di una stringa come GeoJSON. */
const MAX_TESTO_GEO = 4 * 1024 * 1024;

const CHIAVI_LON = ['x', 'lon', 'lng', 'long', 'longitude', 'longitudine'];
const CHIAVI_LAT = ['y', 'lat', 'latitude', 'latitudine'];

/** Numero da un valore, EJSON compreso; null se non è un numero finito. */
function numero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === 'object') {
    const raw = v.$numberDouble ?? v.$numberDecimal ?? v.$numberInt ?? v.$numberLong;
    if (raw !== undefined) return numero(raw);
  }
  return null;
}

/** Punto GeoJSON da una coppia {x,y} / {lon,lat} / {latitude,longitude}, oppure null. */
export function puntoDaCoppia(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const chiavi = Object.keys(v);
  if (chiavi.length !== 2) return null; // due sole chiavi: niente oggetti "con dentro anche" x e y
  const kLon = chiavi.find((k) => CHIAVI_LON.includes(k.toLowerCase()));
  const kLat = chiavi.find((k) => CHIAVI_LAT.includes(k.toLowerCase()));
  if (!kLon || !kLat || kLon === kLat) return null;
  let lon = numero(v[kLon]);
  let lat = numero(v[kLat]);
  if (lon === null || lat === null) return null;
  // Una latitudine oltre ±90 NON esiste: se il secondo valore la supera e il
  // primo no, la coppia è scritta al contrario e si scambia. Non è indovinare —
  // è l'unico modo in cui i due numeri stanno insieme al mondo. Capita davvero:
  // su MySQL `ST_X` di una geometria SRID 4326 restituisce la LATITUDINE
  // (ordine degli assi dell'SRS), quindi un JSON_OBJECT('x', ST_X(...), …)
  // consegna la coppia invertita.
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { const t = lon; lon = lat; lat = t; }
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null; // fuori dal mondo: non è una posizione
  return { type: 'Point', coordinates: [lon, lat] };
}

/**
 * La geometria contenuta in un valore, in forma GeoJSON — oppure null.
 * Accetta le tre forme descritte in testa a questa sezione.
 */
export function normalizzaGeometria(v) {
  if (v === null || v === undefined) return null;
  if (isGeometry(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    // I controlli prima del parse non sono zelo: questa funzione tocca OGNI
    // cella di testo di un result set, e su decine di migliaia di righe di
    // descrizioni un JSON.parse per cella si sente.
    if (t.length < 15 || t.length > MAX_TESTO_GEO || t[0] !== '{') return null;
    if (!t.includes('"type"') && !/"(x|lon|lng|long|longitude)"/i.test(t)) return null;
    try {
      const o = JSON.parse(t);
      if (isGeometry(o)) return o;
      return puntoDaCoppia(o);
    } catch {
      return null; // testo che assomiglia a un JSON ma non lo è: non è un errore
    }
  }
  return puntoDaCoppia(v);
}

export function contaPunti(coords, depth) {
  if (depth === 0) return 1;
  if (!Array.isArray(coords)) return 0;
  return coords.reduce((tot, c) => tot + contaPunti(c, depth - 1), 0);
}

export function fmtCoord(pos) {
  if (!Array.isArray(pos) || pos.length < 2) return '?';
  return `${Number(pos[0]).toFixed(5)}, ${Number(pos[1]).toFixed(5)}`;
}

/**
 * Etichetta compatta: "▦ Polygon (12 punti)". Una cella della griglia con tre
 * righe di coordinate non dice nulla di utile e rompe il layout; il tipo e il
 * numero di vertici sì, e il dettaglio è a un doppio clic di distanza.
 */
export function geometryLabel(geo) {
  if (!isGeometry(geo)) return '';
  if (geo.type === 'GeometryCollection') return `▦ GeometryCollection (${geo.geometries.length} geometrie)`;
  if (geo.type === 'Point') return `▦ Point (${fmtCoord(geo.coordinates)})`;
  return `▦ ${geo.type} (${contaPunti(geo.coordinates, PROFONDITA[geo.type])} punti)`;
}

/**
 * Tutte le posizioni con il PERCORSO per raggiungerle dentro `coordinates`.
 * È ciò che permette di trascinare una maniglia e sapere quale coordinata
 * riscrivere, senza ricostruire l'oggetto intero a ogni movimento del mouse.
 */
export function posizioni(geo) {
  const out = [];
  const visita = (nodo, percorso, depth) => {
    if (depth === 0) { out.push({ percorso, pos: nodo }); return; }
    if (!Array.isArray(nodo)) return;
    nodo.forEach((c, i) => visita(c, [...percorso, i], depth - 1));
  };
  if (!isGeometry(geo)) return out;
  if (geo.type === 'GeometryCollection') {
    (geo.geometries || []).forEach((g, i) => {
      for (const p of posizioni(g)) out.push({ percorso: ['geometries', i, ...p.percorso], pos: p.pos });
    });
    return out;
  }
  visita(geo.coordinates, [], PROFONDITA[geo.type]);
  return out;
}

/** Riscrive la posizione indicata dal percorso prodotto da `posizioni`. */
export function scriviPosizione(geo, percorso, nuova) {
  if (percorso[0] === 'geometries') {
    const sotto = geo.geometries[percorso[1]];
    scriviPosizione(sotto, percorso.slice(2), nuova);
    return;
  }
  if (!percorso.length) { geo.coordinates = nuova; return; } // Point
  let nodo = geo.coordinates;
  for (let i = 0; i < percorso.length - 1; i++) nodo = nodo[percorso[i]];
  nodo[percorso[percorso.length - 1]] = nuova;
}

/** L'anello ha la prima posizione ripetuta in fondo (requisito dei poligoni)? */
export function chiuso(anello) {
  if (!Array.isArray(anello) || anello.length < 2) return false;
  const a = anello[0], b = anello[anello.length - 1];
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

/**
 * Coordinate fuori dall'intervallo longitudine/latitudine: quasi sempre una
 * geometria PROIETTATA (metri, es. EPSG:3857). Una mappa che le interpretasse
 * come gradi mostrerebbe un punto a caso: meglio avvisare che mentire.
 */
export function fuoriDaLonLat(geo) {
  return posizioni(geo).some(({ pos }) =>
    !Array.isArray(pos) || Math.abs(Number(pos[0])) > 180 || Math.abs(Number(pos[1])) > 90);
}
