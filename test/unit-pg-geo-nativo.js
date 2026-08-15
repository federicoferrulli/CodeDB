'use strict';

/* ---------------------------------------------------------------------------
 * Tipi geometrici NATIVI di PostgreSQL <-> GeoJSON (CDB-A88).
 *
 * Due difetti distinti, con la stessa radice — l'elenco dei tipi geometrici era
 * quello di MySQL:
 *
 *   1. in LETTURA la griglia chiamava `ST_AsGeoJSON` su una colonna `point`,
 *      che è un tipo nativo di PostgreSQL e non una geometria PostGIS: la
 *      tabella era del tutto illeggibile ("function st_asgeojson(point) does
 *      not exist");
 *   2. in SCRITTURA l'editor su mappa mandava GeoJSON a una colonna nativa, che
 *      vuole il proprio letterale: "invalid input syntax for type point".
 *
 * Le prove qui coprono il round-trip, che è il punto: un valore letto,
 * mostrato sulla mappa e riscritto deve tornare uguale. E coprono soprattutto i
 * casi in cui i due formati NON coincidono, che sono quelli in cui si perde
 * qualcosa senza accorgersene:
 *
 *   - PostgreSQL non memorizza il punto di chiusura di un poligono, GeoJSON lo
 *     pretende: chi converte deve aggiungerlo e toglierlo;
 *   - `path` è aperto o chiuso a seconda della PARENTESI, non del contenuto:
 *     `[(0,0),(1,1)]` è una linea, `((0,0),(1,1))` un anello;
 *   - `polygon` di PostgreSQL non ha buchi: un GeoJSON con più anelli non è
 *     rappresentabile e deve essere RIFIUTATO, non troncato in silenzio;
 *   - `line` e `circle` non hanno equivalente GeoJSON: devono restare testo
 *     invece di essere convertiti male.
 *
 * Nessun database: sono conversioni di testo.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { pgNativoAGeoJson, geoJsonAPgNativo } = require('../db/pg-geo-nativo');

// --- Lettura: letterale PostgreSQL -> GeoJSON ------------------------------
{
  const p = pgNativoAGeoJson('point', '(12.4964,41.9028)');
  assert.deepStrictEqual(p, { type: 'Point', coordinates: [12.4964, 41.9028] });

  // Coordinate negative e decimali: la regex dei numeri deve prenderle intere.
  assert.deepStrictEqual(pgNativoAGeoJson('point', '(-1.5,-2.25)'),
    { type: 'Point', coordinates: [-1.5, -2.25] });

  assert.deepStrictEqual(pgNativoAGeoJson('lseg', '[(0,0),(1,1)]'),
    { type: 'LineString', coordinates: [[0, 0], [1, 1]] });

  // Il poligono nativo NON ha il punto di chiusura: GeoJSON lo pretende.
  const poly = pgNativoAGeoJson('polygon', '((0,0),(1,0),(1,1),(0,1))');
  assert.strictEqual(poly.type, 'Polygon');
  assert.deepStrictEqual(poly.coordinates[0][0], [0, 0]);
  assert.deepStrictEqual(poly.coordinates[0][poly.coordinates[0].length - 1], [0, 0],
    'l\'anello GeoJSON deve essere chiuso');
  assert.strictEqual(poly.coordinates[0].length, 5, '4 vertici + la chiusura');

  // `path`: la parentesi decide se è una linea o un anello.
  assert.strictEqual(pgNativoAGeoJson('path', '[(0,0),(1,1),(2,0)]').type, 'LineString',
    'path fra parentesi quadre = aperto = LineString');
  const pathChiuso = pgNativoAGeoJson('path', '((0,0),(1,1),(2,0))');
  assert.strictEqual(pathChiuso.type, 'Polygon', 'path fra parentesi tonde = chiuso = Polygon');
  // Anche qui l'anello va CHIUSO: PostgreSQL non memorizza il punto finale, e
  // un anello aperto non è un Polygon GeoJSON valido — la mappa lo scarterebbe.
  const anelloPath = pathChiuso.coordinates[0];
  assert.deepStrictEqual(anelloPath[0], anelloPath[anelloPath.length - 1],
    `l'anello di un path chiuso deve essere chiuso anche in GeoJSON: ${JSON.stringify(anelloPath)}`);
  assert.strictEqual(anelloPath.length, 4, '3 vertici + la chiusura');

  // `box` è definito da due angoli: diventa il rettangolo.
  const box = pgNativoAGeoJson('box', '(2,3),(0,1)');
  assert.strictEqual(box.type, 'Polygon');
  assert.strictEqual(box.coordinates[0].length, 5, 'un rettangolo chiuso ha 5 posizioni');

  // Nessun equivalente GeoJSON: il valore resta com'è, invece di diventare
  // una geometria plausibile e sbagliata.
  assert.strictEqual(pgNativoAGeoJson('circle', '<(0,0),5>'), '<(0,0),5>');
  assert.strictEqual(pgNativoAGeoJson('line', '{1,-1,0}'), '{1,-1,0}');

  // NULL resta NULL: una cella vuota non è una geometria vuota.
  assert.strictEqual(pgNativoAGeoJson('point', null), null);

  console.log('  OK   Lettura: letterali PostgreSQL nativi tradotti in GeoJSON (CDB-A88)');
}

// --- Scrittura: GeoJSON -> letterale PostgreSQL ----------------------------
{
  assert.strictEqual(
    geoJsonAPgNativo('point', { type: 'Point', coordinates: [12.4964, 41.9028] }),
    '(12.4964,41.9028)',
    'è il valore che l\'inserimento mandava come GeoJSON, facendo fallire l\'INSERT');

  assert.strictEqual(
    geoJsonAPgNativo('lseg', { type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
    '[(0,0),(1,1)]');

  // Il punto di chiusura di GeoJSON non va scritto in PostgreSQL.
  assert.strictEqual(
    geoJsonAPgNativo('polygon', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }),
    '((0,0),(1,0),(1,1),(0,1))');

  assert.strictEqual(
    geoJsonAPgNativo('path', { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] }),
    '[(0,0),(1,1),(2,0)]');

  // Un letterale già nativo (cella modificata come testo) passa invariato:
  // non tutto passa dall'editor su mappa.
  assert.strictEqual(geoJsonAPgNativo('circle', '<(0,0),5>'), '<(0,0),5>');

  console.log('  OK   Scrittura: GeoJSON tradotto nel letterale PostgreSQL nativo (CDB-A88)');
}

// --- Ciò che NON è rappresentabile va rifiutato, non troncato --------------
{
  const conBuco = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]],
    ],
  };
  assert.throws(() => geoJsonAPgNativo('polygon', conBuco), /buchi/i,
    'un poligono con un buco non è rappresentabile: va rifiutato, non troncato al solo bordo esterno');
  // Stessa cosa per `path`, che accetta anch'esso un Polygon: il ramo è un
  // altro e va provato a parte, o la protezione può sparire da una sola metà.
  assert.throws(() => geoJsonAPgNativo('path', conBuco), /buchi/i,
    'anche un path chiuso deve rifiutare un poligono con buchi');

  assert.throws(() => geoJsonAPgNativo('point', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }),
    /Point/, 'un poligono non entra in una colonna point');

  assert.throws(() => geoJsonAPgNativo('lseg', { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }),
    /2 punti/, 'un lseg ha esattamente due estremi');

  assert.throws(() => geoJsonAPgNativo('circle', { type: 'Point', coordinates: [0, 0] }),
    /circle/i, 'un circle non si costruisce da GeoJSON: serve il letterale');

  console.log('  OK   Geometrie non rappresentabili rifiutate con un messaggio, non troncate (CDB-A88)');
}

// --- Round-trip: leggo, mostro, riscrivo, deve tornare uguale --------------
{
  const casi = [
    ['point', '(12.4964,41.9028)'],
    ['point', '(-1.5,-2.25)'],
    ['lseg', '[(0,0),(1,1)]'],
    ['polygon', '((0,0),(1,0),(1,1),(0,1))'],
    ['path', '[(0,0),(1,1),(2,0)]'],
    ['path', '((0,0),(1,1),(2,0))'],
  ];
  for (const [tipo, letterale] of casi) {
    const geo = pgNativoAGeoJson(tipo, letterale);
    const ritorno = geoJsonAPgNativo(tipo, geo);
    assert.strictEqual(ritorno, letterale,
      `round-trip ${tipo}: "${letterale}" -> ${JSON.stringify(geo)} -> "${ritorno}"`);
  }
  console.log(`  OK   Round-trip identico su ${casi.length} letterali nativi (CDB-A88)`);
}

console.log('\nTutti i test delle geometrie native PostgreSQL superati!');
