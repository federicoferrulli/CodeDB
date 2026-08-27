'use strict';

const assert = require('assert');

console.log('--- Test unitari Editor geometrico ---');

(async () => {
  const {
    tipoGeoJsonDaTipoColonna, tipoGeoJsonDaMetadato, colonnaGeometrica,
    creaGeometriaIniziale, isGeometry,
  } = await import('../public/js/geojson.js');

  // I nomi NUDI sono quelli che MySQL restituisce in COLUMN_TYPE: sono la
  // sorgente principale del sottotipo su quel motore, quindi vanno provati
  // tutti e non solo qualcuno — un buco qui e' una colonna che apre l'editor
  // sul tipo sbagliato senza che nulla lo segnali.
  const casi = [
    ['point', 'Point'],
    ['MULTIPOINT', 'MultiPoint'],
    ['linestring', 'LineString'],
    ['multilinestring', 'MultiLineString'],
    ['polygon', 'Polygon'],
    ['multipolygon', 'MultiPolygon'],
    ['  MultiPolygon  ', 'MultiPolygon'],
    ['geometry(MultiLineString,4326)', 'MultiLineString'],
    ['geometry ( MultiPolygon , 3857 )', 'MultiPolygon'],
    ['geography(Polygon,4326)', 'Polygon'],
    ['geomcollection', 'GeometryCollection'],
  ];
  for (const [tipoColonna, atteso] of casi) {
    assert.strictEqual(tipoGeoJsonDaTipoColonna(tipoColonna), atteso, tipoColonna);
  }
  for (const generico of ['geometry', 'geography', 'geojson', 'varchar(50)', '', null]) {
    assert.strictEqual(tipoGeoJsonDaTipoColonna(generico), null, `${generico} non dichiara un sottotipo`);
  }
  console.log('  OK   Il sottotipo GeoJSON viene dedotto dai tipi SQL specifici e dai typmod PostGIS');

  // Il metadato della griglia: MySQL porta il sottotipo dentro `type`,
  // PostGIS lo porta a parte in `geoType` perche' `udt_name` dice solo
  // «geometry».
  assert.strictEqual(tipoGeoJsonDaMetadato({ type: 'multipolygon' }), 'MultiPolygon', 'MySQL: sottotipo dal tipo');
  assert.strictEqual(tipoGeoJsonDaMetadato({ type: 'geometry', geoType: 'MULTIPOLYGON' }), 'MultiPolygon', 'PostGIS: sottotipo da geoType');
  assert.strictEqual(tipoGeoJsonDaMetadato({ types: ['geometry(Polygon,4326)'] }), 'Polygon', 'Elenco campi: sottotipo dal typmod');
  assert.strictEqual(tipoGeoJsonDaMetadato({ type: 'geometry' }), null, 'Un tipo generico non autorizza a indovinare');
  assert.strictEqual(tipoGeoJsonDaMetadato(null), null, 'Nessun metadato: nessun sottotipo');
  // Una colonna geometrica va riconosciuta ANCHE quando il sottotipo manca:
  // e' la condizione che decide se una cella vuota si apre sulla mappa.
  for (const meta of [{ type: 'geometry' }, { type: 'geography(Point,4326)' }, { type: 'multipolygon' }, { types: ['geometry'] }]) {
    assert.strictEqual(colonnaGeometrica(meta), true, JSON.stringify(meta));
  }
  for (const meta of [{ type: 'varchar(50)' }, { type: 'json' }, {}, null]) {
    assert.strictEqual(colonnaGeometrica(meta), false, JSON.stringify(meta));
  }
  console.log('  OK   Il metadato di colonna dichiara sottotipo e natura geometrica sui due motori SQL');

  for (const tipo of ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']) {
    const geo = creaGeometriaIniziale(tipo, [9, 45]);
    assert.strictEqual(geo.type, tipo, `${tipo}: tipo iniziale conservato`);
    assert.strictEqual(isGeometry(geo), true, `${tipo}: forma iniziale riconosciuta come GeoJSON`);
  }
  const multi = creaGeometriaIniziale('MultiPolygon', [9, 45]);
  assert.strictEqual(multi.coordinates.length, 1, 'MultiPolygon: una parte iniziale');
  assert.deepStrictEqual(multi.coordinates[0][0][0], multi.coordinates[0][0].at(-1), 'MultiPolygon: anello chiuso');
  console.log('  OK   Tutte le forme, MultiPolygon compreso, hanno un modello iniziale coerente');
})().catch((err) => {
  console.error('  FAIL Editor geometrico:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
