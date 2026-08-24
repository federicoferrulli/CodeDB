'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): le geometrie sono riconoscibili e apribili da ogni griglia.
 *
 * La prova usa dati costruiti nel browser: non serve un DB per verificare il
 * contratto fra renderer della cella e editor geografico. Il server resta una
 * istanza usa-e-getta, così modali, CSS e moduli sono quelli dell'app reale.
 *
 * Uso: node test/e2e-geometrie-viste.js
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

(async () => {
  console.log('--- E2E: geometrie nelle viste a griglia ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3152 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#query-result-table', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1200);

    /* --- Resa condivisa delle geometrie ------------------------------- */

    const resa = await page.evaluate(async () => {
      const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
      setResultsViewMode('table');
      renderResults([{
        punto: { type: 'Point', coordinates: [12.5, 41.9] },
        linea: { type: 'LineString', coordinates: [[12.5, 41.9], [12.6, 42]] },
        poligono: {
          type: 'Polygon',
          coordinates: [[[12.5, 41.9], [12.6, 41.9], [12.6, 42], [12.5, 42], [12.5, 41.9]]],
        },
      }]);
      return [...document.querySelectorAll('#query-result-table tbody td')].map((td) => ({
        classe: td.classList.contains('type-geo'),
        testo: td.textContent,
        title: td.title,
      }));
    });

    ok(resa.length === 3 && resa.every((c) => c.classe),
      'Point, LineString e Polygon hanno tutti la classe `type-geo`', JSON.stringify(resa));
    ok(resa[0] && resa[0].testo.endsWith('Point (12.50000, 41.90000)'),
      `Point ha l'etichetta geometrica compatta (${resa[0] && resa[0].testo})`);
    ok(resa[1] && resa[1].testo.endsWith('LineString (2 punti)'),
      `LineString riporta il numero di vertici (${resa[1] && resa[1].testo})`);
    ok(resa[2] && resa[2].testo.endsWith('Polygon (5 punti)'),
      `Polygon riporta anche il vertice di chiusura (${resa[2] && resa[2].testo})`);
    ok(resa.every((c) => c.title.includes('Doppio clic per visualizzare sulla mappa')),
      'ogni cella geometrica spiega nel title come aprire la mappa');

    /* --- Tab Query: apertura in sola lettura -------------------------- */

    await page.evaluate(() => {
      document.querySelector('#query-result-table tbody td:nth-child(2)')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#geomap-json').value.includes('LineString'));

    const solaLettura = await page.evaluate(() => ({
      aperta: !document.querySelector('#geomap-overlay').classList.contains('hidden'),
      salvaNascosto: document.querySelector('#geomap-save').classList.contains('hidden'),
      jsonReadOnly: document.querySelector('#geomap-json').readOnly,
      titolo: document.querySelector('#geomap-title').textContent,
    }));
    ok(solaLettura.aperta, 'tab Query: il doppio clic apre `#geomap-overlay`');
    ok(solaLettura.salvaNascosto, 'tab Query: il pulsante Applica geometria è nascosto');
    ok(solaLettura.jsonReadOnly, 'tab Query: il JSON è in sola lettura');
    ok(solaLettura.titolo === 'Geometria — linea',
      `tab Query: il titolo indica la colonna (${solaLettura.titolo})`);
    await page.click('#geomap-cancel');

    /* --- Split-View reale: resa e modifica nel proprio riquadro -------- */

    const splitPreparata = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const sv = await import('/js/splitview.js');

      const spediti = [];
      window.__geoSplitSpediti = spediti;
      impostaSocket({
        emit: (evento, msg, cb) => {
          spediti.push({ evento, msg: structuredClone(msg) });
          if (!cb) return;
          if (evento === 'collection:find') {
            cb({
              ok: true,
              docs: [{ _id: 'split-1', posizione: { type: 'Point', coordinates: [11, 44] } }],
              columns: ['_id', 'posizione'], total: 1, skip: 0, limit: 50,
            });
          } else if (evento === 'collection:relations') cb({ ok: true, relazioni: [] });
          else cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });

      const tab = createTab({ id: 'tab-geo-split', connName: null });
      tabs.activeId = tab.id;
      tab.dbType = 'mongodb';
      tab.state.connected = true;
      // Nessuna collection corrente: il test crea un solo riquadro reale,
      // senza promuovere una griglia della vista Dati come secondo pannello.
      tab.state.db = null;
      tab.state.coll = null;

      sv.initSplitView();
      sv.addOrSplitPane(null, 'right', {
        tabId: tab.id, db: 'geografie_split', coll: 'luoghi_split',
      });
      await new Promise((r) => setTimeout(r, 100));

      const cella = document.querySelector('.split-pane .pane-grid tbody td[data-r="0"][data-c="1"]');
      if (!cella) return { assente: true };
      const resa = {
        assente: false,
        classe: cella.classList.contains('type-geo') || !!cella.querySelector('.type-geo'),
        testo: cella.textContent,
        title: cella.title,
      };
      cella.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return resa;
    });

    ok(!splitPreparata.assente, 'Split-View: la cella geometrica è disegnata nel riquadro reale');
    ok(splitPreparata.classe && splitPreparata.testo.includes('Point'),
      'Split-View: la resa geometrica condivisa applica classe ed etichetta');
    ok(splitPreparata.title.includes('Doppio clic per'),
      'Split-View: il title spiega come aprire la geometria');
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });
    const splitEditor = await page.evaluate(() => ({
      salvaVisibile: !document.querySelector('#geomap-save').classList.contains('hidden'),
      jsonModificabile: !document.querySelector('#geomap-json').readOnly,
      titolo: document.querySelector('#geomap-title').textContent,
    }));
    ok(splitEditor.salvaVisibile && splitEditor.jsonModificabile,
      'Split-View: il doppio clic apre la geometria in modifica');
    ok(splitEditor.titolo === 'Geometria — posizione',
      `Split-View: il titolo conserva il campo (${splitEditor.titolo})`);
    await page.fill('#geomap-json', JSON.stringify({ type: 'Point', coordinates: [12, 45] }, null, 2));
    await page.click('#geomap-save');
    await page.waitForFunction(() => window.__geoSplitSpediti.some((x) => x.evento === 'doc:update'));
    const scritturaSplit = await page.evaluate(() => {
      const invio = window.__geoSplitSpediti.find((x) => x.evento === 'doc:update');
      return invio && invio.msg;
    });
    ok(scritturaSplit && scritturaSplit.tabId === 'tab-geo-split'
      && scritturaSplit.db === 'geografie_split' && scritturaSplit.coll === 'luoghi_split',
    'Split-View: il salvataggio usa tab, database e collection del proprio riquadro');

    /* --- Vista Dati: modifica e salvataggio restano operativi --------- */

    const preparata = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const { renderGrid } = await import('/js/grid.js');

      const spediti = [];
      window.__geoSpediti = spediti;
      impostaSocket({
        emit: (evento, msg, cb) => {
          spediti.push({ evento, msg });
          if (!cb) return;
          if (evento === 'collection:find') {
            cb({
              ok: true,
              docs: [{ _id: 1, posizione: { type: 'Point', coordinates: [13, 42] } }],
              columns: ['_id', 'posizione'], total: 1, skip: 0, limit: 50,
            });
          } else cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });

      const tab = createTab({ connName: null });
      tabs.activeId = tab.id;
      tab.dbType = 'mongodb';
      tab.state.connected = true;
      tab.state.db = 'prova';
      tab.state.coll = 'luoghi';
      tab.state.docs = [{ _id: 1, posizione: { type: 'Point', coordinates: [12.5, 41.9] } }];
      tab.state.columns = ['_id', 'posizione'];
      tab.state.total = 1;
      renderGrid();

      const cella = document.querySelector('#grid tbody td[data-r="0"][data-c="1"]');
      if (!cella) return false;
      cella.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    });
    ok(preparata, 'vista Dati: la cella geometrica è presente e modificabile');
    await page.waitForSelector('#geomap-overlay:not(.hidden)', { timeout: 10000 });

    const modifica = await page.evaluate(() => ({
      salvaVisibile: !document.querySelector('#geomap-save').classList.contains('hidden'),
      jsonModificabile: !document.querySelector('#geomap-json').readOnly,
      titolo: document.querySelector('#geomap-title').textContent,
    }));
    ok(modifica.salvaVisibile && modifica.jsonModificabile,
      'vista Dati: l’editor conserva la modalità di modifica');
    ok(modifica.titolo === 'Geometria — posizione',
      `vista Dati: il titolo indica il campo (${modifica.titolo})`);

    await page.fill('#geomap-json', JSON.stringify({ type: 'Point', coordinates: [13, 42] }, null, 2));
    await page.waitForTimeout(300);
    await page.click('#geomap-save');
    await page.waitForFunction(() => window.__geoSpediti.some((x) => x.evento === 'doc:update'));
    const scrittura = await page.evaluate(() => {
      const invio = window.__geoSpediti.find((x) => x.evento === 'doc:update');
      return invio && invio.msg;
    });
    ok(scrittura && scrittura.db === 'prova' && scrittura.coll === 'luoghi',
      'vista Dati: il salvataggio mantiene il bersaglio corretto');
    ok(scrittura && scrittura.set && scrittura.set.posizione
      && scrittura.set.posizione.type === 'Point'
      && scrittura.set.posizione.coordinates[0] === 13
      && scrittura.set.posizione.coordinates[1] === 42,
    'vista Dati: Applica geometria invia il nuovo GeoJSON con `doc:update`', JSON.stringify(scrittura));

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Geometrie nelle viste: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Geometrie nelle viste: tutti i test superati ---');
})();
