'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): l'editor su mappa si apre GIA' sul tipo che la colonna
 * dichiara, e le geometrie multipart si disegnano davvero.
 *
 * Non serve un database: la prova apre l'editor con le stesse chiamate che
 * fanno la griglia e il form di inserimento, e disegna con clic veri sulla
 * mappa — il punto era proprio che il percorso reale (Leaflet, modale, CSS
 * dell'app) si comportasse come il modulo puro promette.
 *
 * Uso: node test/e2e-editor-geometrico.js
 * ------------------------------------------------------------------------- */

const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? `\n         ${dettaglio}` : ''}`);
    falliti++;
  }
};

const apri = (page, tipoSuggerito) => page.evaluate(async (tipo) => {
  const { openGeoEditor } = await import('/js/geomap.js');
  window.__geoSalvata = null;
  await openGeoEditor({
    value: null,
    campo: 'area',
    tipoSuggerito: tipo,
    onSave: (geo) => { window.__geoSalvata = geo; },
  });
}, tipoSuggerito);

const apriCon = (page, value) => page.evaluate(async (geo) => {
  const { openGeoEditor } = await import('/js/geomap.js');
  window.__geoSalvata = null;
  await openGeoEditor({
    value: geo,
    campo: 'area',
    onSave: (g) => { window.__geoSalvata = g; },
  });
}, value);

const stato = (page) => page.evaluate(() => {
  const el = (sel) => document.querySelector(sel);
  return {
    tipoSelezionato: el('#geomap-type').value,
    geo: JSON.parse(el('#geomap-json').value),
    nuovaParteVisibile: !el('#geomap-new-part').classList.contains('hidden'),
    // Bottone a sola icona: l'etichetta che l'utente legge sta nel title, ed è
    // la stessa che sente chi usa uno screen reader (aria-label).
    nuovaParteTesto: `${el('#geomap-new-part').title}|${el('#geomap-new-part').getAttribute('aria-label')}`,
    errore: el('#geomap-error').classList.contains('hidden') ? '' : el('#geomap-error').textContent,
    aperto: !el('#geomap-overlay').classList.contains('hidden'),
    salvata: window.__geoSalvata,
    // Bottoni azione: `disabled` è la parte che l'utente vede PRIMA di premere.
    // La modalità è un controllo segmentato: lo stato sta in `aria-pressed`,
    // cioè nella stessa proprietà che lo dichiara alle tecnologie assistive.
    modo: el('#geomap-mode-draw').getAttribute('aria-pressed') === 'true' ? 'disegna' : 'modifica',
    modoAttivo: el('#geomap-mode-draw').getAttribute('aria-pressed') === 'true',
    modoCoerente: el('#geomap-mode-draw').getAttribute('aria-pressed')
      !== el('#geomap-mode-select').getAttribute('aria-pressed'),
    jsonVisibile: !el('#geomap-json').classList.contains('hidden'),
    selezione: el('#geomap-selezione').textContent,
    disattivati: Object.fromEntries(['#geomap-undo', '#geomap-redo', '#geomap-del-vertex',
      '#geomap-insert-vertex', '#geomap-del-part'].map((s) => [s.replace('#geomap-', ''), el(s).disabled])),
    parteVisibile: !el('#geomap-del-part').classList.contains('hidden'),
  };
});

// I vertici si disegnano con clic in posizioni NOTE della mappa: premere di
// nuovo lo stesso punto centra la maniglia che ci è nata sopra. Il gesto è
// quello vero (mousedown sul vertice = selezione + inizio trascinamento), senza
// bisogno di frugare dentro Leaflet dal test.
const PUNTI = [[0.35, 0.35], [0.55, 0.35], [0.55, 0.6]];

async function premiPunto(page, [fx, fy], dx = 0) {
  const box = await page.locator('#geomap-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * fx + dx, box.y + box.height * fy);
  await page.waitForTimeout(150);
}

// Tre clic distinti dentro la mappa: bastano a chiudere un anello (il quarto
// vertice lo aggiunge l'editor duplicando il primo).
async function disegnaTreVertici(page, dx = 0) {
  for (const punto of PUNTI) await premiPunto(page, punto, dx);
}

(async () => {
  console.log('--- E2E: editor geometrico (tipo dichiarato e multipart) ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_GEO_EDITOR_PORT, 10) || 3157 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#geomap-overlay', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(800);

    /* --- Il tipo della colonna decide la forma di partenza ------------ */

    await apri(page, 'MultiPolygon');
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    let s = await stato(page);
    ok(s.tipoSelezionato === 'MultiPolygon',
      `una colonna MultiPolygon apre l'editor gia' su MultiPolygon (${s.tipoSelezionato})`);
    ok(s.geo.type === 'MultiPolygon', `la geometria iniziale e' un MultiPolygon (${s.geo.type})`);
    ok(s.nuovaParteVisibile && /poligono/i.test(s.nuovaParteTesto),
      `il comando per la parte successiva e' quello del tipo (${s.nuovaParteTesto})`);

    /* --- Ridisegnare svuota, e una forma incompleta non si salva ------- */

    await page.click('#geomap-redraw');
    await page.waitForTimeout(150);
    s = await stato(page);
    ok(s.geo.type === 'MultiPolygon' && JSON.stringify(s.geo.coordinates) === '[[[]]]',
      'Ridisegna svuota la geometria conservando il tipo', JSON.stringify(s.geo));

    await page.click('#geomap-save');
    await page.waitForTimeout(150);
    s = await stato(page);
    ok(s.aperto && !s.salvata && /poligono|anello/i.test(s.errore),
      `un MultiPolygon vuoto non viene salvato e dice perche' (${s.errore || 'nessun messaggio'})`);

    /* --- Si disegna sulla mappa, parte per parte ----------------------- */

    await disegnaTreVertici(page);
    s = await stato(page);
    const anello = s.geo.coordinates[0] && s.geo.coordinates[0][0];
    ok(Array.isArray(anello) && anello.length === 4,
      `tre clic sulla mappa fanno un anello chiuso di 4 posizioni (${anello && anello.length})`);
    ok(anello && JSON.stringify(anello[0]) === JSON.stringify(anello[anello.length - 1]),
      'il primo e l’ultimo vertice coincidono: l’anello e’ chiuso');

    await page.click('#geomap-new-part');
    await page.waitForTimeout(150);
    s = await stato(page);
    ok(s.geo.coordinates.length === 2,
      `"Nuovo poligono" aggiunge una seconda parte (${s.geo.coordinates.length})`);

    await disegnaTreVertici(page, 60);
    s = await stato(page);
    ok(s.geo.coordinates[0][0].length === 4 && s.geo.coordinates[1][0].length === 4,
      'i vertici successivi vanno nella parte ATTIVA, non nella prima',
      JSON.stringify(s.geo.coordinates.map((p) => p[0].length)));

    await page.click('#geomap-save');
    await page.waitForTimeout(200);
    s = await stato(page);
    ok(!s.aperto && s.salvata && s.salvata.type === 'MultiPolygon' && s.salvata.coordinates.length === 2,
      'il MultiPolygon completo viene applicato con entrambe le parti',
      JSON.stringify(s.salvata));

    /* --- I bottoni azione lavorano sul vertice scelto ------------------ */

    await apri(page, 'Polygon');
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    await page.click('#geomap-redraw');
    await page.waitForTimeout(150);
    await disegnaTreVertici(page);
    s = await stato(page);
    ok(s.geo.coordinates[0].length === 4 && !s.disattivati.undo,
      'dopo tre vertici l’anello è chiuso e «Annulla» è attivo',
      JSON.stringify({ n: s.geo.coordinates[0].length, disattivati: s.disattivati }));
    ok(!s.parteVisibile, 'su un Polygon il bottone «Parte» non compare: di parti ne ha una sola');

    // Passata alla sola selezione, un clic sullo sfondo NON aggiunge un vertice:
    // toglie la scelta, e i bottoni che agiscono su di essa si spengono.
    await page.click('#geomap-mode-select');
    await page.waitForTimeout(100);
    await premiPunto(page, [0.15, 0.85]); // sfondo, lontano dai vertici
    s = await stato(page);
    const senzaSelezione = s.disattivati['del-vertex'] && s.disattivati['insert-vertex']
      && s.geo.coordinates[0].length === 4;

    await premiPunto(page, PUNTI[1]); // il secondo vertice, in una posizione nota
    s = await stato(page);
    ok(senzaSelezione && !s.disattivati['del-vertex'] && !s.disattivati['insert-vertex'],
      'i bottoni sul vertice si accendono solo quando un vertice è scelto',
      JSON.stringify(s.disattivati));
    ok(/vertice 2 di 4/.test(s.selezione), `la barra dice quale vertice è scelto (${s.selezione})`);

    const primaInsert = s.geo.coordinates[0].length;
    await page.click('#geomap-insert-vertex');
    await page.waitForTimeout(150);
    s = await stato(page);
    const anelloIns = s.geo.coordinates[0];
    ok(anelloIns.length === primaInsert + 1
      && JSON.stringify(anelloIns[0]) === JSON.stringify(anelloIns[anelloIns.length - 1]),
      '«Vertice dopo» infila un vertice a metà lato senza aprire l’anello',
      JSON.stringify(anelloIns));
    ok(/vertice 3 di 5/.test(s.selezione),
      `il vertice appena inserito diventa quello scelto (${s.selezione})`);

    await page.click('#geomap-del-vertex');
    await page.waitForTimeout(150);
    s = await stato(page);
    ok(s.geo.coordinates[0].length === primaInsert,
      '«Vertice» elimina quello scelto', JSON.stringify(s.geo.coordinates[0]));

    // Un anello al minimo non si svuota un vertice alla volta: il rifiuto è
    // dichiarato e la geometria resta com'era.
    await page.click('#geomap-del-vertex');
    await page.waitForTimeout(150);
    s = await stato(page);
    ok(s.geo.coordinates[0].length === primaInsert,
      'sotto il minimo di vertici l’eliminazione viene rifiutata, non eseguita');

    await page.click('#geomap-undo');
    await page.waitForTimeout(150);
    s = await stato(page);
    const dopoAnnulla = s.geo.coordinates[0].length;
    ok(dopoAnnulla === primaInsert + 1 && !s.disattivati.redo,
      '«Annulla» riporta indietro l’ultima modifica e abilita «Rifai»',
      JSON.stringify({ n: dopoAnnulla, disattivati: s.disattivati }));

    await page.click('#geomap-redo');
    await page.waitForTimeout(150);
    s = await stato(page);
    // Si guarda anche il PASSO PRECEDENTE: se annullare non avesse fatto nulla,
    // «rifai» troverebbe la lunghezza giusta senza aver rifatto niente.
    ok(dopoAnnulla === primaInsert + 1 && s.geo.coordinates[0].length === primaInsert,
      '«Rifai» la riapplica', JSON.stringify({ dopoAnnulla, ora: s.geo.coordinates[0].length }));
    // Prendere un vertice non deve richiedere la mira: un clic VICINO alla
    // maniglia sceglie lo stesso quel vertice. Misurato: prima si doveva stare
    // entro una decina di pixel, e mancare di poco era indistinguibile dal
    // premere sul vuoto.
    await premiPunto(page, [0.15, 0.85]); // sfondo: azzera la scelta
    s = await stato(page);
    const azzerata = s.disattivati['del-vertex'];
    const box = await page.locator('#geomap-canvas').boundingBox();
    await page.mouse.click(box.x + box.width * PUNTI[2][0] + 18, box.y + box.height * PUNTI[2][1]);
    await page.waitForTimeout(200);
    s = await stato(page);
    ok(azzerata && !s.disattivati['del-vertex'],
      'un clic a 18 px dal vertice lo sceglie lo stesso', `${s.selezione} · ${JSON.stringify(s.disattivati)}`);

    // Lontano da ogni vertice la scelta si azzera: l'aggancio ha un raggio, non
    // è «il vertice più vicino comunque».
    await page.mouse.click(box.x + box.width * PUNTI[2][0] + 90, box.y + box.height * PUNTI[2][1]);
    await page.waitForTimeout(200);
    s = await stato(page);
    ok(s.disattivati['del-vertex'], 'lontano da ogni vertice la scelta si azzera');

    // Il cursore dichiara la presa: passando sopra una maniglia cambia forma.
    await page.mouse.move(box.x + box.width * PUNTI[2][0], box.y + box.height * PUNTI[2][1]);
    await page.waitForTimeout(200);
    const cursore = await page.evaluate(() => document.querySelector('#geomap-canvas').style.cursor);
    await page.mouse.move(box.x + 20, box.y + box.height - 20);
    await page.waitForTimeout(200);
    const cursoreFuori = await page.evaluate(() => document.querySelector('#geomap-canvas').style.cursor);
    ok(cursore === 'grab' && cursoreFuori !== 'grab',
      'sopra una maniglia il cursore dichiara che si può prendere', `${cursore} / ${cursoreFuori}`);

    // Scegliere un vertice NON è una modifica: premerlo tre volte non deve
    // lasciare tre passi nella storia, altrimenti «Annulla» andrebbe premuto
    // quattro volte per disfare una modifica sola.
    await premiPunto(page, PUNTI[1]);
    await premiPunto(page, PUNTI[2]);
    await premiPunto(page, PUNTI[1]);
    await page.click('#geomap-undo');
    await page.waitForTimeout(150);
    s = await stato(page);
    ok(s.geo.coordinates[0].length === primaInsert + 1,
      'scegliere un vertice non riempie la storia: «Annulla» disfa la modifica vera',
      JSON.stringify({ atteso: primaInsert + 1, ora: s.geo.coordinates[0].length }));

    /* --- I pannelli: il GeoJSON si chiude e la mappa cresce ------------- */

    const larghezze = await page.evaluate(async () => {
      const mappa = document.querySelector('#geomap-canvas');
      const prima = mappa.clientWidth;
      document.querySelector('#geomap-json-btn').click();
      await new Promise((r) => setTimeout(r, 300));
      const dopo = mappa.clientWidth;
      return {
        prima,
        dopo,
        jsonNascosto: document.querySelector('#geomap-json').classList.contains('hidden'),
        premuto: document.querySelector('#geomap-json-btn').getAttribute('aria-pressed'),
        // Leaflet deve aver riletto le dimensioni: senza `invalidateSize` la
        // mappa resterebbe disegnata sulla larghezza di prima.
        tele: document.querySelector('#geomap-canvas .leaflet-map-pane') ? true : false,
      };
    });
    ok(larghezze.jsonNascosto && larghezze.premuto === 'false' && larghezze.dopo > larghezze.prima + 100,
      'chiudendo il pannello GeoJSON la mappa si prende la larghezza intera',
      JSON.stringify(larghezze));
    await page.click('#geomap-json-btn');
    await page.waitForTimeout(200);
    const riaperto = await page.evaluate(() => ({
      visibile: !document.querySelector('#geomap-json').classList.contains('hidden'),
      premuto: document.querySelector('#geomap-json-btn').getAttribute('aria-pressed'),
    }));
    ok(riaperto.visibile && riaperto.premuto === 'true', 'e si riapre dichiarando il proprio stato');

    // Lo sfondo mappa: un interruttore visibile che pilota la casella, non due
    // verità da tenere allineate.
    const sfondo = await page.evaluate(() => {
      const btn = document.querySelector('#geomap-tiles-btn');
      const box = document.querySelector('#geomap-tiles');
      const prima = { premuto: btn.getAttribute('aria-pressed'), casella: box.checked };
      btn.click();
      return { prima, dopo: { premuto: btn.getAttribute('aria-pressed'), casella: box.checked } };
    });
    ok(sfondo.dopo.casella !== sfondo.prima.casella
      && sfondo.dopo.premuto === String(sfondo.dopo.casella),
      'l’interruttore dello sfondo e la casella dicono sempre la stessa cosa',
      JSON.stringify(sfondo));
    await page.evaluate(() => document.querySelector('#geomap-tiles-btn').click());

    await page.click('#geomap-cancel');
    await page.waitForTimeout(100);

    /* --- Una geometria che ESISTE non prende vertici per sbaglio -------- */

    const esistente = {
      type: 'Polygon',
      coordinates: [[[12.4, 41.8], [12.6, 41.8], [12.6, 42.0], [12.4, 42.0], [12.4, 41.8]]],
    };
    await apriCon(page, esistente);
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    await page.waitForTimeout(300);
    s = await stato(page);
    ok(!s.modoAttivo && s.modoCoerente,
      `una geometria esistente si apre in sola selezione (${s.modo})`);

    await premiPunto(page, [0.1, 0.9]);
    s = await stato(page);
    ok(s.geo.coordinates[0].length === 5,
      'il clic sullo sfondo NON aggiunge un vertice a una geometria esistente',
      JSON.stringify(s.geo.coordinates[0]));

    await page.click('#geomap-mode-draw');
    await page.waitForTimeout(100);
    await premiPunto(page, [0.1, 0.9]);
    s = await stato(page);
    ok(s.modoAttivo && s.modoCoerente && s.geo.coordinates[0].length === 6,
      'scelto «Disegna» nel controllo segmentato, il clic torna ad aggiungere',
      JSON.stringify({ modo: s.modo, n: s.geo.coordinates[0].length }));
    await page.click('#geomap-cancel');
    await page.waitForTimeout(100);

    /* --- Lo stesso vale per MultiLineString --------------------------- */

    await apri(page, 'MultiLineString');
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    s = await stato(page);
    ok(s.tipoSelezionato === 'MultiLineString' && /linea/i.test(s.nuovaParteTesto),
      `una colonna MultiLineString apre sul proprio tipo (${s.tipoSelezionato}, ${s.nuovaParteTesto})`);
    await page.click('#geomap-cancel');
    await page.waitForTimeout(100);

    /* --- Una colonna generica non inventa una forma -------------------- */

    await apri(page, null);
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    s = await stato(page);
    ok(s.tipoSelezionato === 'Point' && !s.nuovaParteVisibile,
      `senza sottotipo dichiarato si resta su Point (${s.tipoSelezionato})`);
    await page.click('#geomap-cancel');
    await page.waitForTimeout(100);

    /* --- In sola lettura non ci sono strumenti da mostrare -------------- */

    await page.evaluate(async () => {
      const { openGeoEditor } = await import('/js/geomap.js');
      await openGeoEditor({
        value: { type: 'Polygon', coordinates: [[[12.4, 41.8], [12.6, 41.8], [12.6, 42], [12.4, 41.8]]] },
        campo: 'area',
        readOnly: true,
      });
    });
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    await page.waitForTimeout(200);
    const lettura = await page.evaluate(() => {
      const nascosto = (sel) => document.querySelector(sel).classList.contains('hidden');
      return {
        rail: nascosto('#geomap-azioni-forma'),
        vertice: nascosto('#geomap-azioni'),
        modo: nascosto('#geomap-mode'),
        salva: nascosto('#geomap-save'),
        json: document.querySelector('#geomap-json').readOnly,
      };
    });
    ok(lettura.rail && lettura.vertice && lettura.modo && lettura.salva && lettura.json,
      'in sola lettura spariscono strumenti, modalità e salvataggio', JSON.stringify(lettura));
    await page.click('#geomap-cancel');
    await page.waitForTimeout(100);

    /* --- Il form di inserimento porta il sottotipo fino all'editor ----- */

    const bottoni = await page.evaluate(async () => {
      const { insertInputFor } = await import('/js/insert.js');
      return {
        postgis: insertInputFor('geo', { typeName: 'geometry(MultiPolygon,4326)' }).dataset.geoType,
        mysql: insertInputFor('geo', { typeName: 'multipolygon' }).dataset.geoType,
        generico: insertInputFor('geo', { typeName: 'geometry' }).dataset.geoType,
      };
    });
    ok(bottoni.postgis === 'MultiPolygon' && bottoni.mysql === 'MultiPolygon',
      'il form di inserimento porta il sottotipo dei due motori fino alla mappa',
      JSON.stringify(bottoni));
    ok(bottoni.generico === '', 'una colonna `geometry` senza sottotipo non ne dichiara uno');

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Editor geometrico: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Editor geometrico: tutti i test superati ---');
})();
