'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari delle geometrie (nessun database richiesto).
 *
 * Coprono le due cose che, sbagliate, corrompono i dati senza dirlo:
 *   1. il riconoscimento e la validazione del GeoJSON in arrivo dal client
 *      (un anello aperto o una coordinata non numerica devono essere fermati
 *      QUI, con un messaggio comprensibile, non dal DBMS con un errore opaco);
 *   2. il frammento SQL con cui la geometria viene scritta — se il SRID non
 *      viene imposto, MySQL e PostGIS rifiutano la scrittura (o, peggio,
 *      accettano una geometria nel sistema di riferimento sbagliato).
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const {
  isSqlGeometryType, isGeoJson, assertGeoJson, parseGeoJsonText,
} = require('../db/geometry');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

console.log('--- Test unitari Geometrie ---');

const punto = { type: 'Point', coordinates: [12.4964, 41.9028] };
const linea = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
const poligono = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

/* --------------------------- Tipi di colonna ----------------------------- */

for (const t of ['geometry', 'GEOMETRY', 'point', 'geography', 'multipolygon', 'geomcollection']) {
  assert.strictEqual(isSqlGeometryType(t), true, `${t} deve essere geometrico`);
}
for (const t of ['varchar(20)', 'json', 'int', '', null, undefined, 'pointer']) {
  assert.strictEqual(isSqlGeometryType(t), false, `${t} non deve essere geometrico`);
}
console.log('  OK   Riconoscimento dei tipi di colonna geometrici');

/* ------------------------------ isGeoJson -------------------------------- */

assert.strictEqual(isGeoJson(punto), true);
assert.strictEqual(isGeoJson(linea), true);
assert.strictEqual(isGeoJson({ type: 'GeometryCollection', geometries: [punto] }), true);
assert.strictEqual(isGeoJson({ type: 'Point' }), false, 'senza coordinates non è una geometria');
assert.strictEqual(isGeoJson({ type: 'Sfera', coordinates: [1, 2] }), false, 'tipo inventato');
assert.strictEqual(isGeoJson([1, 2]), false, 'un array non è una geometria');
assert.strictEqual(isGeoJson('Point'), false);
assert.strictEqual(isGeoJson(null), false);
// Un documento con un campo `type` qualsiasi non deve essere scambiato per una
// geometria: succederebbe su collezioni MongoDB del tutto normali.
assert.strictEqual(isGeoJson({ type: 'fattura', coordinates: 3 }), false);
console.log('  OK   isGeoJson distingue le geometrie dagli oggetti qualsiasi');

/* ----------------------------- assertGeoJson ----------------------------- */

assert.doesNotThrow(() => assertGeoJson(punto));
assert.doesNotThrow(() => assertGeoJson(linea));
assert.doesNotThrow(() => assertGeoJson(poligono));
assert.doesNotThrow(() => assertGeoJson({ type: 'Point', coordinates: [1, 2, 3] }), 'la quota è ammessa');

assert.throws(() => assertGeoJson({ type: 'Point', coordinates: [1] }), /posizione/i, 'posizione incompleta');
assert.throws(() => assertGeoJson({ type: 'Point', coordinates: ['1', '2'] }), /numeri finiti/i, 'coordinate testuali');
assert.throws(() => assertGeoJson({ type: 'Point', coordinates: [1, NaN] }), /numeri finiti/i, 'NaN');
assert.throws(() => assertGeoJson({ type: 'LineString', coordinates: [] }), /vuote/i, 'linea senza punti');
assert.throws(() => assertGeoJson({ type: 'Casa', coordinates: [] }), /non riconosciuto/i, 'tipo sconosciuto');
// L'anello aperto è l'errore più frequente di chi scrive il GeoJSON a mano.
assert.throws(
  () => assertGeoJson({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }),
  /non chiuso/i,
  'anello di poligono non chiuso'
);
assert.throws(
  () => assertGeoJson({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] }),
  /almeno 4 posizioni/i,
  'anello troppo corto'
);
assert.throws(() => assertGeoJson({ type: 'GeometryCollection', geometries: [] }), /almeno una geometria/i);
assert.throws(
  () => assertGeoJson({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1] }] }),
  /geometries\[0\]/,
  'l\'errore indica quale sotto-geometria'
);
console.log('  OK   assertGeoJson ferma le geometrie malformate con un messaggio parlante');

/* ---------------------------- parseGeoJsonText --------------------------- */

assert.deepStrictEqual(parseGeoJsonText(JSON.stringify(punto)), punto);
assert.deepStrictEqual(parseGeoJsonText(punto), punto, 'un oggetto passa invariato');
assert.strictEqual(parseGeoJsonText('non-json'), 'non-json', 'testo illeggibile: si conserva il valore');
assert.strictEqual(parseGeoJsonText('{"a":1}'), '{"a":1}', 'JSON che non è una geometria: invariato');
assert.strictEqual(parseGeoJsonText(null), null);
console.log('  OK   parseGeoJsonText non perde mai il contenuto della cella');

/* ------------------------- Scrittura: binding SQL ------------------------ */

const geoMy = new Map([
  ['geom', { name: 'geom', type: 'geometry', srid: 4326 }],
  ['zona', { name: 'zona', type: 'polygon', srid: 0 }],
  ['ignoto', { name: 'ignoto', type: 'geometry', srid: null }],
]);

let b = MySqlStrategy.geoBinding('geom', punto, geoMy);
assert.strictEqual(b.sql, 'ST_SRID(ST_GeomFromGeoJSON(?), 4326)', 'MySQL: SRID imposto');
assert.strictEqual(b.param, JSON.stringify(punto), 'MySQL: parametro = GeoJSON testuale');

b = MySqlStrategy.geoBinding('zona', poligono, geoMy);
assert.strictEqual(b.sql, 'ST_SRID(ST_GeomFromGeoJSON(?), 0)', 'MySQL: anche SRID 0 va imposto');

// Senza SRID dichiarato dalla colonna il SRID va imposto UGUALMENTE, e vale 0.
// Questo test affermava il contrario, cioe' il difetto: lasciato a se stesso,
// `ST_GeomFromGeoJSON` produce SRID 4326, dove MySQL usa l'ordine degli assi
// latitudine-longitudine. Misurato su MySQL 8: un `POLYGON((0 0,3 0,3 1,0 0))`
// scritto cosi' tornava `POLYGON((0 0,0 3,1 3,0 0))` — le coordinate
// SCAMBIATE, senza alcun errore. Una colonna senza SRS dichiarato contiene
// geometrie cartesiane, il cui SRID e' 0.
assert.throws(() => MySqlStrategy.geoBinding('ignoto', punto, geoMy), /SRID.*non.*noto|metadata/i,
  'MySQL: senza SRID la scrittura si ferma');

// Colonna NON geometrica: nessuna conversione, altrimenti un documento JSON con
// un campo `type` finirebbe in ST_GeomFromGeoJSON.
b = MySqlStrategy.geoBinding('note', punto, geoMy);
assert.strictEqual(b.sql, '?', 'MySQL: colonna non geometrica resta un segnaposto');
assert.strictEqual(b.param, JSON.stringify(punto), 'MySQL: oggetto serializzato come JSON');

// Colonna geometrica ma valore NON geometrico (es. NULL per svuotarla).
b = MySqlStrategy.geoBinding('geom', null, geoMy);
assert.strictEqual(b.sql, '?');
assert.strictEqual(b.param, null, 'MySQL: NULL passa senza conversione');

assert.throws(
  () => MySqlStrategy.geoBinding('geom', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, geoMy),
  /Colonna "geom".*non chiuso/is,
  'MySQL: la validazione cita la colonna'
);
console.log('  OK   MySQL: ST_GeomFromGeoJSON con il SRID della colonna');

const geoPg = new Map([
  ['geom', { name: 'geom', type: 'geometry', srid: 4326, kind: 'geometry' }],
  ['area', { name: 'area', type: 'geography', srid: 4326, kind: 'geography' }],
  ['locale', { name: 'locale', type: 'geometry', srid: 3003, kind: 'geometry' }],
  ['senzasrid', { name: 'senzasrid', type: 'geometry', srid: null }],
]);

b = PostgreSqlStrategy.geoBinding('geom', punto, geoPg, '$1');
assert.strictEqual(b.sql, 'ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)');

b = PostgreSqlStrategy.geoBinding('locale', punto, geoPg, '$2');
assert.strictEqual(b.sql, 'ST_SetSRID(ST_GeomFromGeoJSON($2), 3003)', 'PG: SRID non 4326 rispettato');

b = PostgreSqlStrategy.geoBinding('area', punto, geoPg, '$3');
assert.strictEqual(b.sql, 'ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography', 'PG: cast per geography');

assert.throws(() => PostgreSqlStrategy.geoBinding('senzasrid', punto, geoPg, '$4'), /SRID.*non.*noto|metadata/i,
  'PostgreSQL: senza SRID la scrittura si ferma');

b = PostgreSqlStrategy.geoBinding('titolo', punto, geoPg, '$5');
assert.strictEqual(b.sql, '$5', 'PG: colonna non geometrica invariata');
console.log('  OK   PostgreSQL: ST_SetSRID + cast geography');

/* ------- La geometria COM'ARRIVA dal client (Extended JSON stretto) ------- */

// Non è un caso di laboratorio: è esattamente ciò che `deserializeClientObject`
// consegna a `docUpdate` e a `collectionInsert`. In modalità `relaxed: false`
// il decodificatore trasforma OGNI numero in un oggetto BSON (Double, Int32),
// quindi `typeof coordinata === 'number'` era falso e la validazione rifiutava
// con «le coordinate devono essere numeri finiti» OGNI geometria salvata dalla
// griglia — cioè disegnare un poligono sulla mappa e applicarlo era impossibile
// su entrambi i motori SQL.
const { EJSON } = require('bson');
const { normalizzaGeoJson } = require('../db/geometry');
const dalClient = (geo) => EJSON.deserialize({ v: geo }, { relaxed: false }).v;

const poligonoClient = dalClient({
  type: 'Polygon',
  coordinates: [[[13.05, 42.21], [14.08, 42.36], [13.94, 41.77], [13.05, 42.21]]],
});
assert.notStrictEqual(typeof poligonoClient.coordinates[0][0][0], 'number',
  'il caso di prova è quello vero: le coordinate NON sono numeri JS');

b = MySqlStrategy.geoBinding('geom', poligonoClient, geoMy);
assert.strictEqual(
  b.param,
  '{"type":"Polygon","coordinates":[[[13.05,42.21],[14.08,42.36],[13.94,41.77],[13.05,42.21]]]}',
  'MySQL: a ST_GeomFromGeoJSON arriva GeoJSON con numeri, non oggetti BSON'
);

b = PostgreSqlStrategy.geoBinding('geom', poligonoClient, geoPg, '$1');
assert.strictEqual(
  b.param,
  '{"type":"Polygon","coordinates":[[[13.05,42.21],[14.08,42.36],[13.94,41.77],[13.05,42.21]]]}',
  'PostgreSQL: idem, e il frammento SQL resta quello con il SRID'
);
assert.strictEqual(b.sql, 'ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)');

// Un intero resta un intero, e i tipi esatti non diventano notazione BSON
// dentro il testo GeoJSON.
const conInteri = dalClient({ type: 'Point', coordinates: [12, 41] });
b = MySqlStrategy.geoBinding('geom', conInteri, geoMy);
assert.strictEqual(b.param, '{"type":"Point","coordinates":[12,41]}', 'MySQL: interi srotolati');

// La normalizzazione NON è una tolleranza sul formato: ciò che non è un numero
// resta com'è e viene rifiutato con il messaggio di prima.
assert.throws(() => MySqlStrategy.geoBinding('geom', { type: 'Point', coordinates: ['12', 41] }, geoMy),
  /numeri finiti/i, 'una coordinata testuale resta un errore');
assert.throws(() => MySqlStrategy.geoBinding('geom', { type: 'Point', coordinates: [NaN, 41] }, geoMy),
  /numeri finiti/i, 'e NaN pure');

// La forma canonica non tocca ciò che geometria non è.
assert.deepStrictEqual(normalizzaGeoJson({ a: 1 }), { a: 1 }, 'un oggetto qualunque torna com’è');
assert.strictEqual(normalizzaGeoJson(null), null);
console.log('  OK   Le coordinate arrivate come oggetti BSON diventano numeri prima di ogni scrittura');

/* --------------------- Lettura: testo GeoJSON → oggetto ------------------ */

const righe = [
  { id: 1, geom: JSON.stringify(punto), nome: 'Roma' },
  { id: 2, geom: null, nome: 'senza geometria' },
  { id: 3, geom: 'valore strano', nome: 'illeggibile' },
];
MySqlStrategy.geoRowsToJson(righe, geoMy);
assert.deepStrictEqual(righe[0].geom, punto, 'la geometria diventa un oggetto');
assert.strictEqual(righe[0].nome, 'Roma', 'le altre colonne non si toccano');
assert.strictEqual(righe[1].geom, null);
assert.strictEqual(righe[2].geom, 'valore strano', 'valore non analizzabile conservato');

const righePg = [{ geom: JSON.stringify(linea) }];
PostgreSqlStrategy.geoRowsToJson(righePg, geoPg);
assert.deepStrictEqual(righePg[0].geom, linea);

// Nessuna colonna geometrica: le righe non vengono nemmeno percorse.
const intatte = [{ a: '{"type":"Point","coordinates":[1,2]}' }];
MySqlStrategy.geoRowsToJson(intatte, new Map());
assert.strictEqual(typeof intatte[0].a, 'string', 'senza colonne geo nulla viene convertito');
console.log('  OK   Lettura: solo le colonne geometriche vengono convertite');

console.log('\nTutti i test unitari Geometrie superati!');
