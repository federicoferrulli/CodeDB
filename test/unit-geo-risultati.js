'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari del riconoscimento delle geometrie nei RISULTATI di una query
 * (public/js/geo-risultati.js), cioè ciò che alimenta la vista 🗺 Mappa della
 * tab ⚡ Query & Aggregate. Nessun database, nessun browser: il modulo importa
 * solo `geojson.js`, che è una foglia.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede — una mappa che
 * mostra 40 punti su 60 sembra una mappa giusta:
 *   1. dove si guarda: primo livello (SQL), sottodocumenti (MongoDB) e dentro
 *      gli array (un elenco di tappe è un elenco di geometrie);
 *   2. dove NON si guarda: dentro i valori EJSON, che non contengono geometrie
 *      e produrrebbero percorsi fantasma;
 *   3. la provenienza: colonna e riga di ogni geometria, che nell'elenco della
 *      mappa sono l'unico modo per tornare al dato;
 *   4. i limiti dichiarati: oltre il tetto si taglia dicendolo.
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Geometrie nei Risultati di Query ---');

const punto = (x, y) => ({ type: 'Point', coordinates: [x, y] });
const linea = { type: 'LineString', coordinates: [[9, 45], [10, 46]] };

(async () => {
  const {
    haGeometrie, vociGeometriche, notaTroncamento, MAX_CELLE, MAX_NODI_RILEVAMENTO,
  } = await import('../public/js/geo-risultati.js');

  /* ------------------------------ haGeometrie ---------------------------- */

  assert.strictEqual(haGeometrie([{ nome: 'Bari', area: linea }]), true);
  assert.strictEqual(haGeometrie([{ nome: 'Bari', abitanti: 320000 }]), false);
  assert.strictEqual(haGeometrie([]), false);
  assert.strictEqual(haGeometrie(null), false, 'nessun risultato = nessuna geometria, non un\'eccezione');
  // Il rilevamento non deve perdere geometrie nelle righe finali; il lavoro
  // resta protetto da un budget esplicito di valori visitati.
  const tante = [];
  for (let i = 0; i < 500; i++) tante.push({ n: i });
  tante.push({ n: 500, geo: punto(9, 45) });
  assert.strictEqual(haGeometrie(tante), true, 'la geometria oltre la riga 50 va rilevata');
  assert.strictEqual(haGeometrie(tante, 10), false, 'il budget impedisce scansioni patologiche');
  assert.strictEqual(haGeometrie(tante, 2000), true, 'con budget sufficiente si scorre tutto');
  assert.ok(MAX_NODI_RILEVAMENTO >= 2000);
  console.log('  ✓ rilevamento completo con budget, senza eccezioni sui casi vuoti');

  /* --------------------------- vociGeometriche --------------------------- */

  {
    const righe = [
      { citta: 'Bari', posizione: punto(16.87, 41.12) },
      { citta: 'Roma', posizione: punto(12.49, 41.9) },
    ];
    const { voci, colonne, tagliate, righeConGeometrie } = vociGeometriche(righe);
    assert.strictEqual(voci.length, 2);
    assert.deepStrictEqual(colonne, ['posizione']);
    assert.deepStrictEqual(voci.map((v) => v.riga), [0, 1], 'la riga di provenienza segue la geometria');
    assert.deepStrictEqual(voci.map((v) => v.colonna), ['posizione', 'posizione']);
    assert.strictEqual(tagliate, 0);
    assert.strictEqual(righeConGeometrie, 2);
    console.log('  ✓ colonna di primo livello (il caso SQL)');
  }

  {
    // MongoDB: la geometria sta spesso in un sottodocumento.
    const righe = [{ ordine: 1, spedizione: { destinazione: punto(9, 45), corriere: 'X' } }];
    const { voci, colonne } = vociGeometriche(righe);
    assert.strictEqual(voci.length, 1);
    assert.deepStrictEqual(colonne, ['spedizione.destinazione'], 'il percorso completo, non solo il nome finale');
    console.log('  ✓ geometria in un sottodocumento');
  }

  {
    // Un array di geometrie è un elenco di geometrie, non un campo solo: ogni
    // elemento va sulla mappa, e l'indice resta nell'etichetta della cella.
    const righe = [{ percorso: [punto(9, 45), punto(10, 46), punto(11, 44)] }];
    const { voci, colonne } = vociGeometriche(righe);
    assert.strictEqual(voci.length, 3, 'tre punti, non un campo');
    assert.deepStrictEqual(voci.map((v) => v.colonna), ['percorso[0]', 'percorso[1]', 'percorso[2]']);
    assert.deepStrictEqual(colonne, ['percorso[]'], 'nell\'elenco dei campi gli indici collassano');
    console.log('  ✓ array di geometrie: una voce per elemento');
  }

  {
    // Più campi geometrici sulla stessa riga: partenza e arrivo sono due cose
    // diverse e vanno disegnate entrambe.
    const righe = [{ da: punto(9, 45), a: punto(12, 41), tratta: linea }];
    const { voci, colonne } = vociGeometriche(righe);
    assert.strictEqual(voci.length, 3);
    assert.deepStrictEqual(colonne, ['da', 'a', 'tratta']);
    console.log('  ✓ più campi geometrici sulla stessa riga');
  }

  {
    // I valori EJSON non contengono geometrie: scenderci dentro darebbe percorsi
    // inesistenti (e su documenti grandi sarebbe lavoro sprecato a ogni riga).
    const righe = [{
      _id: { $oid: 'a'.repeat(24) },
      creato: { $date: '2026-01-01T00:00:00Z' },
      importo: { $numberDecimal: '12.50' },
      dove: punto(9, 45),
    }];
    const { voci, colonne } = vociGeometriche(righe);
    assert.deepStrictEqual(colonne, ['dove']);
    assert.strictEqual(voci.length, 1);
    console.log('  ✓ i valori EJSON non vengono esplorati');
  }

  {
    // Una riga che È una geometria (aggregazioni che proiettano il solo campo).
    const { voci, colonne } = vociGeometriche([punto(9, 45)]);
    assert.strictEqual(voci.length, 1);
    assert.deepStrictEqual(colonne, ['(valore)']);
    console.log('  ✓ la riga stessa può essere una geometria');
  }

  {
    // Niente geometrie: elenco vuoto, non un\'eccezione e non voci fantasma.
    const { voci, colonne, righeConGeometrie } = vociGeometriche([{ a: 1, b: { c: 'x' } }, { a: 2 }]);
    assert.deepStrictEqual(voci, []);
    assert.deepStrictEqual(colonne, []);
    assert.strictEqual(righeConGeometrie, 0);
    console.log('  ✓ risultati senza geometrie');
  }

  {
    // IL CASO SQL: la tab ⚡ esegue la query così com'è scritta, e
    // `SELECT ST_AsGeoJSON(area)` produce TESTO. Senza questo, la mappa
    // funzionava su MongoDB e su MySQL/PostgreSQL non compariva mai.
    const righe = [
      { citta: 'Bari', area: JSON.stringify({ type: 'Point', coordinates: [16.87, 41.12] }) },
      { citta: 'Roma', area: JSON.stringify({ type: 'LineString', coordinates: [[9, 45], [10, 46]] }) },
    ];
    assert.strictEqual(haGeometrie(righe), true, 'anche una geometria in forma di testo va rilevata');
    const { voci, colonne } = vociGeometriche(righe);
    assert.strictEqual(voci.length, 2);
    assert.deepStrictEqual(colonne, ['area']);
    assert.strictEqual(voci[0].valore.type, 'Point', 'il testo diventa oggetto prima di arrivare alla mappa');
    console.log('  ✓ geometria come stringa GeoJSON (ST_AsGeoJSON su SQL)');
  }

  {
    // Testo che NON è una geometria: nessun falso positivo e nessuna eccezione,
    // nemmeno su JSON valido ma di altra natura o su JSON rotto.
    const righe = [{
      note: 'Bari, Puglia',
      config: JSON.stringify({ type: 'admin', ruoli: ['a'] }),
      rotto: '{ "type": "Point", "coordinates": [1,',
      quasi: '{"type":"Point"}',
      vuoto: '',
    }];
    const { voci } = vociGeometriche(righe);
    assert.deepStrictEqual(voci, [], 'nessun falso positivo su testo qualsiasi');
    assert.strictEqual(haGeometrie(righe), false);
    console.log('  ✓ testo non geometrico: nessun falso positivo, nessuna eccezione');
  }

  {
    // LA COPPIA {x, y}: è come il driver `pg` consegna il tipo `point` nativo di
    // PostgreSQL, e come esce un JSON_OBJECT('x', ST_X(...), 'y', ST_Y(...)) su
    // MySQL. `x` è la LONGITUDINE (convenzione di PostGIS e di GeoJSON).
    const righe = [
      { id: 4, punto: { x: 12.5193957, y: 41.9088027 } },
      { id: 5, punto: { x: 12.4878265, y: 41.8877202 } },
    ];
    assert.strictEqual(haGeometrie(righe), true);
    const { voci } = vociGeometriche(righe);
    assert.strictEqual(voci.length, 2);
    assert.deepStrictEqual(voci[0].valore, { type: 'Point', coordinates: [12.5193957, 41.9088027] });
    // Con i nomi espliciti si obbedisce ai NOMI, non alla posizione.
    const conNomi = vociGeometriche([{ p: { lat: 41.9, lon: 12.5 } }, { p: { latitude: 45.4, longitude: 9.2 } }]);
    assert.deepStrictEqual(conNomi.voci.map((v) => v.valore.coordinates), [[12.5, 41.9], [9.2, 45.4]]);
    // Anche in forma di testo (colonna JSON letta come stringa).
    const testo = vociGeometriche([{ p: '{"x":12.5,"y":41.9}' }]);
    assert.strictEqual(testo.voci.length, 1);
    // Coppia scritta al contrario: una latitudine oltre ±90 non esiste, quindi
    // i due valori si scambiano invece di disegnare un punto impossibile.
    // (Su MySQL `ST_X` di una geometria SRID 4326 restituisce la latitudine.)
    const rovescia = vociGeometriche([{ p: { x: 41.9, y: 116.4 } }]);
    assert.deepStrictEqual(rovescia.voci[0].valore.coordinates, [116.4, 41.9], 'coppia invertita raddrizzata');
    console.log('  ✓ coppia {x,y} / {lat,lon}: riconosciuta come punto');
  }

  {
    // …e i paletti dell'euristica, che sono la parte che evita i disastri.
    const fuori = vociGeometriche([
      { schermo: { x: 1920, y: 1080 } },                    // fuori dall'intervallo lon/lat
      { vettore: { x: 1, y: 2, z: 3 } },                    // tre chiavi: non è una posizione
      { misto: { x: 12.5, y: 41.9, nome: 'Roma' } },        // ha altro dentro
      { testo: { x: 'dodici', y: 'quarantuno' } },          // non numeri
      { conteggi: { x: 10, y: 20 } },                       // ambiguo ma dentro l'intervallo…
    ]);
    // …l'ultimo caso è l'unico falso positivo possibile, ed è dichiarato: due
    // numeri piccoli chiamati x e y sono indistinguibili da una posizione.
    assert.strictEqual(fuori.voci.length, 1, 'solo la coppia piccola e ambigua passa');
    assert.deepStrictEqual(fuori.voci[0].colonna, 'conteggi');
    console.log('  ✓ coppie non plausibili scartate (fuori scala, chiavi in più, non numeri)');
  }

  {
    // Tetto: si taglia e si DICE quante ne restano fuori.
    const righe = [];
    for (let i = 0; i < 30; i++) righe.push({ p: punto(9 + i / 100, 45) });
    const { voci, tagliate } = vociGeometriche(righe, { max: 10 });
    assert.strictEqual(voci.length, 10);
    assert.strictEqual(tagliate, 20);
    assert.ok(/escluse/i.test(notaTroncamento(tagliate, 10)), 'il taglio va dichiarato');
    assert.strictEqual(notaTroncamento(0, 10), '', 'senza taglio nessuna nota');
    assert.ok(MAX_CELLE > 0);
    console.log('  ✓ tetto alle celle mappate, dichiarato');
  }

  console.log('--- Geometrie nei Risultati: tutti i test superati ---\n');
})().catch((err) => {
  console.error('✗ Test geometrie nei risultati falliti:', err);
  process.exit(1);
});
