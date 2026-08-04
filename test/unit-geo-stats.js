'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari delle statistiche di una selezione geometrica
 * (public/js/geo-stats.js). Nessun database, nessun browser, nessun Leaflet: il
 * modulo è puro (importa solo il modulo foglia `geojson.js`) proprio per essere
 * provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede:
 *   1. le MISURE — un'area va confrontata con un valore noto, altrimenti un
 *      errore di fattore 2 nella formula dell'eccesso sferico resta invisibile:
 *      il numero sembra comunque plausibile;
 *   2. le geometrie PROIETTATE — coordinate in metri passerebbero volentieri
 *      dalla formula sferica restituendo un'area priva di senso: devono
 *      restare fuori dai totali ed essere contate a parte;
 *   3. la separazione fra famiglie — linee e poligoni non si sommano;
 *   4. i BUCHI di un poligono — si sottraggono, altrimenti l'area di una
 *      ciambella è quella del disco pieno.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Statistiche Selezione Geometrica ---');

// Anello quadrato 1°×1° con l'angolo sud-ovest in (lon0, lat0).
function quadrato(lon0, lat0, lato = 1) {
  return [[lon0, lat0], [lon0 + lato, lat0], [lon0 + lato, lat0 + lato], [lon0, lat0 + lato], [lon0, lat0]];
}

(async () => {
  const {
    distanzaM, misureGeometria, raccogliGeometrie, statisticheGeo,
    formattaDistanza, formattaArea, formattaPunto, riassuntoGeoBreve, featureCollection,
  } = await import('../public/js/geo-stats.js');

  /* -------------------------------- distanze ----------------------------- */

  // Un grado di latitudine sul raggio medio terrestre: 111,195 km.
  const gradoLat = distanzaM([0, 0], [0, 1]);
  assert.ok(Math.abs(gradoLat - 111195) < 50, `un grado di latitudine ≈ 111,2 km (ottenuto ${gradoLat})`);
  // Un grado di longitudine si accorcia con il coseno della latitudine: a 60°
  // vale metà che all'equatore. Senza il coseno nella formula questo test cade.
  const gradoLon60 = distanzaM([0, 60], [1, 60]);
  assert.ok(Math.abs(gradoLon60 - gradoLat / 2) < 300, `un grado di longitudine a 60° ≈ metà (ottenuto ${gradoLon60})`);
  assert.strictEqual(distanzaM([12, 42], [12, 42]), 0, 'due volte lo stesso punto: distanza nulla');

  /* --------------------------------- misure ------------------------------ */

  const punto = misureGeometria({ type: 'Point', coordinates: [12.5, 41.9] });
  assert.strictEqual(punto.vertici, 1);
  assert.strictEqual(punto.areaM2, null, 'un punto non ha area');
  assert.strictEqual(punto.lunghezzaM, null, 'un punto non ha lunghezza');
  assert.deepStrictEqual(punto.bbox, [12.5, 41.9, 12.5, 41.9]);

  const linea = misureGeometria({ type: 'LineString', coordinates: [[0, 0], [0, 1], [0, 2]] });
  assert.strictEqual(linea.vertici, 3);
  assert.ok(Math.abs(linea.lunghezzaM - 2 * gradoLat) < 1, 'due gradi di latitudine in fila');
  assert.strictEqual(linea.areaM2, null, 'una linea non ha area');

  // Quadrato 1°×1° all'equatore: R²·Δλ·(senφ2 − senφ1) ≈ 12.363 km².
  const poly = misureGeometria({ type: 'Polygon', coordinates: [quadrato(0, 0)] });
  const atteso = 1.2363e10;
  assert.ok(Math.abs(poly.areaM2 - atteso) / atteso < 0.001, `area del quadrato 1°×1° ≈ 12.363 km² (ottenuto ${poly.areaM2})`);
  assert.strictEqual(poly.lunghezzaM, null, 'il perimetro di un poligono NON è una lunghezza di linea');
  assert.ok(poly.perimetroM > 0, 'il perimetro c\'è, su una riga sua');

  // Il verso di percorrenza non cambia l'area (il segno dell'eccesso sferico sì).
  const polyInverso = misureGeometria({ type: 'Polygon', coordinates: [[...quadrato(0, 0)].reverse()] });
  assert.ok(Math.abs(polyInverso.areaM2 - poly.areaM2) < 1, 'area indipendente dal verso dell\'anello');

  // Buco: l'area è quella esterna MENO quella interna.
  const conBuco = misureGeometria({
    type: 'Polygon',
    coordinates: [quadrato(0, 0, 2), quadrato(0.5, 0.5, 1)],
  });
  const pieno = misureGeometria({ type: 'Polygon', coordinates: [quadrato(0, 0, 2)] });
  const buco = misureGeometria({ type: 'Polygon', coordinates: [quadrato(0.5, 0.5, 1)] });
  assert.ok(Math.abs(conBuco.areaM2 - (pieno.areaM2 - buco.areaM2)) < 1, 'i buchi si sottraggono');

  // MultiPolygon e GeometryCollection: le parti si sommano.
  const multi = misureGeometria({ type: 'MultiPolygon', coordinates: [[quadrato(0, 0)], [quadrato(10, 0)]] });
  assert.ok(Math.abs(multi.areaM2 - 2 * poly.areaM2) / poly.areaM2 < 0.02, 'due quadrati ≈ due volte l\'area');
  const collection = misureGeometria({
    type: 'GeometryCollection',
    geometries: [
      { type: 'Point', coordinates: [0, 0] },
      { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
      { type: 'Polygon', coordinates: [quadrato(0, 0)] },
    ],
  });
  assert.strictEqual(collection.vertici, 1 + 2 + 5);
  assert.ok(Math.abs(collection.lunghezzaM - gradoLat) < 1, 'la GeometryCollection somma le sue linee');
  assert.ok(Math.abs(collection.areaM2 - poly.areaM2) < 1, 'e i suoi poligoni');

  /* ------------------------- geometrie proiettate ------------------------ */

  // Coordinate in metri (EPSG:3857): la formula sferica le accetterebbe e
  // restituirebbe un'area astronomica. Devono restare fuori.
  const proiettata = misureGeometria({
    type: 'Polygon',
    coordinates: [[[1390000, 5140000], [1391000, 5140000], [1391000, 5141000], [1390000, 5141000], [1390000, 5140000]]],
  });
  assert.strictEqual(proiettata.proiettata, true);
  assert.strictEqual(proiettata.areaM2, null, 'una geometria proiettata non si misura');
  assert.strictEqual(proiettata.bbox, null, 'né entra nel riquadro di delimitazione');
  assert.strictEqual(proiettata.vertici, 5, 'i vertici però si contano');

  /* ------------------------------ la selezione --------------------------- */

  const voci = [
    { valore: { type: 'Point', coordinates: [0, 0] }, colonna: 'geom', riga: 0 },
    { valore: { type: 'Point', coordinates: [0, 2] }, colonna: 'geom', riga: 1 },
    { valore: { type: 'LineString', coordinates: [[0, 0], [0, 1]] }, colonna: 'percorso', riga: 2 },
    { valore: { type: 'Polygon', coordinates: [quadrato(0, 0)] }, colonna: 'area', riga: 3 },
    { valore: null, colonna: 'geom', riga: 4 },
    { valore: 'Rossi', colonna: 'nome', riga: 5 },
    { valore: { type: 'Point', coordinates: [1390000, 5140000] }, colonna: 'geom', riga: 6 },
  ];

  const raccolta = raccogliGeometrie(voci);
  assert.strictEqual(raccolta.geometrie.length, 5, 'cinque geometrie (la proiettata è una geometria)');
  assert.strictEqual(raccolta.vuote, 1);
  assert.strictEqual(raccolta.nonGeometriche, 1, 'una stringa non è una geometria');
  assert.strictEqual(raccolta.geometrie[0].colonna, 'geom', 'la provenienza viene conservata');
  assert.strictEqual(raccolta.geometrie[0].riga, 0);

  const st = statisticheGeo(voci);
  assert.strictEqual(st.celle, 7);
  assert.strictEqual(st.totale, 5);
  assert.strictEqual(st.proiettate, 1);
  assert.strictEqual(st.vertici, 1 + 1 + 2 + 5 + 1);
  assert.deepStrictEqual(st.perTipo, [['Point', 3], ['LineString', 1], ['Polygon', 1]], 'tipi ordinati per frequenza');
  assert.strictEqual(st.conLunghezza, 1);
  assert.strictEqual(st.conArea, 1);
  assert.ok(Math.abs(st.lunghezzaM - gradoLat) < 1, 'la lunghezza è quella delle sole LINEE');
  assert.ok(Math.abs(st.areaM2 - poly.areaM2) < 1);
  assert.ok(st.perimetroM > 0 && st.perimetroM !== st.lunghezzaM, 'perimetro e lunghezza restano distinti');
  // Il riquadro ignora la geometria proiettata: senza quel filtro arriverebbe a
  // longitudine 1.390.000 e la mappa si aprirebbe sul nulla.
  assert.deepStrictEqual(st.bbox, [0, 0, 1, 2], 'riquadro delle sole geometrie in lon/lat');
  assert.ok(st.centro[0] >= 0 && st.centro[0] <= 1 && st.centro[1] >= 0 && st.centro[1] <= 2, 'centro dentro il riquadro');

  const vuoto = statisticheGeo([{ valore: 42 }, { valore: null }]);
  assert.strictEqual(vuoto.totale, 0);
  assert.strictEqual(vuoto.bbox, null);
  assert.strictEqual(vuoto.centro, null);
  assert.strictEqual(vuoto.areaM2, null);
  assert.strictEqual(riassuntoGeoBreve(vuoto), '', 'senza geometrie il riassunto è vuoto');

  /* ------------------------------ formattazione -------------------------- */

  assert.strictEqual(formattaDistanza(0), '0,00 m');
  assert.strictEqual(formattaDistanza(950), '950 m');
  assert.ok(/^1,500 km$/.test(formattaDistanza(1500)), `1500 m → 1,500 km (ottenuto ${formattaDistanza(1500)})`);
  assert.strictEqual(formattaDistanza(null), '—');
  assert.ok(formattaArea(500).endsWith('m²'));
  assert.ok(formattaArea(50000).endsWith('ha'), '5 ettari si leggono in ettari');
  assert.ok(formattaArea(5e6).endsWith('km²'));
  assert.strictEqual(formattaArea(null), '—');
  assert.strictEqual(formattaPunto([12.4964, 41.9028]), '12,49640 E · 41,90280 N');
  assert.strictEqual(formattaPunto([-3.5, -12.25]), '3,50000 O · 12,25000 S', 'emisferi ovest e sud');
  assert.strictEqual(formattaPunto(null), '—');

  const breve = riassuntoGeoBreve(st);
  assert.ok(breve.includes('5 geometrie'), breve);
  assert.ok(breve.includes('vertici'), breve);
  assert.ok(breve.includes('non misurabili'), 'il riassunto dichiara le geometrie proiettate');

  /* ------------------------------ esportazione --------------------------- */

  const fc = featureCollection(st.geometrie);
  assert.strictEqual(fc.type, 'FeatureCollection');
  assert.strictEqual(fc.features.length, 5);
  assert.strictEqual(fc.features[0].geometry.type, 'Point');
  assert.strictEqual(fc.features[0].properties.colonna, 'geom');
  assert.strictEqual(fc.features[0].properties.riga, 1, 'le righe sono numerate da 1 come nell\'interfaccia');
  // Deve restare un GeoJSON valido, cioè analizzabile da chiunque altro.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(fc)));

  console.log('✓ Statistiche selezione geometrica: OK');
})().catch((err) => {
  console.error('✗ Statistiche selezione geometrica:', err.message);
  process.exitCode = 1;
});
