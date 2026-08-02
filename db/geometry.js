'use strict';

/* ---------------------------------------------------------------------------
 * Geometrie: un solo formato sul filo, GeoJSON.
 *
 * I tre DBMS rappresentano le geometrie in modo diverso e nessuna di quelle
 * forme è utilizzabile da una mappa nel browser:
 *   - MongoDB      → GeoJSON nativo, già un oggetto ({ type, coordinates });
 *   - PostGIS      → il driver `pg` restituisce il WKB in esadecimale
 *                    ("0101000020E6100000…"), illeggibile e non modificabile;
 *   - MySQL        → mysql2 analizza il WKB in oggetti {x, y} annidati, che
 *                    NON distinguono LineString da MultiPoint né Polygon da
 *                    MultiLineString: dalla sola forma del valore non si può
 *                    ricostruire il tipo, quindi non basta convertirli in JS.
 *
 * Per questo su SQL la lettura passa da `ST_AsGeoJSON` e la scrittura da
 * `ST_GeomFromGeoJSON`: il client vede e rimanda sempre e solo GeoJSON, e
 * l'editor su mappa è uno solo per tutti e tre i database.
 * ------------------------------------------------------------------------- */

// Tipi di colonna considerati geometrici (MySQL `DATA_TYPE`, PostgreSQL
// `udt_name`). `geography` esiste solo su PostGIS.
const SQL_GEOMETRY_TYPES = new Set([
  'geometry', 'geography',
  'point', 'linestring', 'polygon',
  'multipoint', 'multilinestring', 'multipolygon',
  'geometrycollection', 'geomcollection',
]);

function isSqlGeometryType(dataType) {
  return SQL_GEOMETRY_TYPES.has(String(dataType || '').trim().toLowerCase());
}

// Profondità dell'array `coordinates` per ciascun tipo: Point → [x, y],
// LineString/MultiPoint → [[x, y], …], Polygon/MultiLineString → [[[x, y]…]…],
// MultiPolygon → un livello ancora.
const COORD_DEPTH = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

const GEOJSON_TYPES = new Set([...Object.keys(COORD_DEPTH), 'GeometryCollection']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Il valore è una geometria GeoJSON? Controllo di FORMA, non di validità
 * geometrica: serve a decidere se una cella va trattata come geometria (dal
 * client, per aprire la mappa) e se un valore in scrittura va convertito.
 */
function isGeoJson(v) {
  if (!isPlainObject(v) || !GEOJSON_TYPES.has(v.type)) return false;
  if (v.type === 'GeometryCollection') return Array.isArray(v.geometries);
  return Array.isArray(v.coordinates);
}

// Una posizione: [x, y] oppure [x, y, z]. I valori NON sono per forza
// longitudine/latitudine (le geometrie possono essere proiettate), quindi si
// controlla che siano numeri finiti, non il loro intervallo.
function checkPosition(pos, dove) {
  if (!Array.isArray(pos) || pos.length < 2 || pos.length > 3) {
    throw new Error(`${dove}: una posizione deve essere [x, y] oppure [x, y, z].`);
  }
  for (const n of pos) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error(`${dove}: le coordinate devono essere numeri finiti.`);
    }
  }
}

function checkCoords(coords, depth, dove) {
  if (depth === 0) {
    checkPosition(coords, dove);
    return;
  }
  if (!Array.isArray(coords)) throw new Error(`${dove}: coordinate non valide (atteso un array).`);
  if (!coords.length) throw new Error(`${dove}: coordinate vuote.`);
  for (const c of coords) checkCoords(c, depth - 1, dove);
}

/**
 * Valida una geometria prima di mandarla al database. Il messaggio è pensato
 * per finire davanti all'utente: senza questo controllo un GeoJSON malformato
 * diventerebbe un errore grezzo del DBMS ("Invalid GeoJSON data provided to
 * function st_geomfromgeojson"), identico per qualunque causa.
 */
function assertGeoJson(v, dove = 'Geometria') {
  if (!isPlainObject(v)) throw new Error(`${dove}: la geometria deve essere un oggetto GeoJSON.`);
  if (!GEOJSON_TYPES.has(v.type)) {
    throw new Error(`${dove}: tipo GeoJSON non riconosciuto ("${v.type}"). Ammessi: ${[...GEOJSON_TYPES].join(', ')}.`);
  }
  if (v.type === 'GeometryCollection') {
    if (!Array.isArray(v.geometries) || !v.geometries.length) {
      throw new Error(`${dove}: una GeometryCollection deve avere almeno una geometria in "geometries".`);
    }
    v.geometries.forEach((g, i) => assertGeoJson(g, `${dove} → geometries[${i}]`));
    return v;
  }
  checkCoords(v.coordinates, COORD_DEPTH[v.type], dove);
  // Gli anelli di un poligono vanno chiusi (primo punto = ultimo): PostGIS e
  // MySQL rifiutano l'anello aperto, e chi disegna sulla mappa non ha motivo di
  // saperlo — l'editor chiude da sé, questo è il controllo di sicurezza.
  if (v.type === 'Polygon' || v.type === 'MultiPolygon') {
    const rings = v.type === 'Polygon' ? v.coordinates : v.coordinates.flat();
    for (const ring of rings) {
      if (ring.length < 4) {
        throw new Error(`${dove}: un anello di poligono deve avere almeno 4 posizioni (la prima ripetuta in fondo).`);
      }
      const a = ring[0];
      const b = ring[ring.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) {
        throw new Error(`${dove}: anello di poligono non chiuso (la prima e l'ultima posizione devono coincidere).`);
      }
    }
  }
  return v;
}

/**
 * Testo prodotto da `ST_AsGeoJSON` → oggetto. Un valore non analizzabile torna
 * com'è: meglio mostrare il testo grezzo che perdere il contenuto della cella.
 */
function parseGeoJsonText(value) {
  if (value === null || value === undefined) return value;
  if (isPlainObject(value)) return value; // pg con ::json restituisce già l'oggetto
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return isGeoJson(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

module.exports = {
  SQL_GEOMETRY_TYPES,
  GEOJSON_TYPES,
  isSqlGeometryType,
  isGeoJson,
  assertGeoJson,
  parseGeoJsonText,
};
