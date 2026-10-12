'use strict';

// Renderer reale con pochi dati isolati: nessuna connessione al database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3202 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.argv.includes('--mutant')) await page.route('**/js/table-resize.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const from = 'nome != null && !manuali.has(nome)';
      assert(source.includes(from));
      await route.fulfill({ response, body: source.replace(from, 'false') });
    });
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const docs = [{ id: 1, punto: { type: 'Point', coordinates: [12.47942, 41.90254] }, poligono: { type: 'Polygon', coordinates: [[[12, 41], [13, 41], [13, 42], [12, 41]]] } }];
      const databases = [{ name: 'demo', collections: [{ name: 'geometrie' }] }];
      const tab = createTab({ id: 'larghezza' });
      tab.label = 'Locale'; tab.dbType = 'postgresql';
      Object.assign(tab.state, { connected: true, connLabel: 'Locale', dbType: 'postgresql', databases });
      tabs.activeId = tab.id;
      impostaSocket({ connected: true, on() {}, off() {}, emit(name, msg, cb) {
        cb?.({ ok: true, databases, collections: databases[0].collections, docs, skip: 0, limit: 50,
          total: docs.length, columns: Object.keys(docs[0]), fields: [], indexes: [] });
      } });
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('demo', 'geometrie');
      const grid = await import('/js/grid.js');
      const colltabs = await import('/js/colltabs.js');
      window.widthFixture = (rows = docs) => {
        colltabs.currentCollTab().gridWidths = new Map();
        Object.assign(tab.state, { docs: rows, columns: Object.keys(rows[0]), total: rows.length });
        grid.renderGrid();
      };
    });
    await page.locator('#grid tbody td[data-c="0"]').waitFor();
    const measure = (selector = '#grid', surface = page) => surface.locator(selector).last().evaluate(table => ({
      table: table.getBoundingClientRect().width,
      panel: table.parentElement.clientWidth,
      columns: [...table.querySelectorAll('thead th')].map(th => th.getBoundingClientRect().width),
    }));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const size = await measure();
    console.log('Colonne iniziali:', JSON.stringify(size));
    assert(Math.abs(size.table - size.panel) < 2, 'Con poche colonne la griglia deve occupare la larghezza disponibile');
    assert.equal(size.columns[0], 48, 'La selezione non si allarga con i dati');
    assert(size.columns[2] > size.columns[1], 'Lo spazio aggiuntivo tiene conto del contenuto');
    const dir = 'test-reports/griglia-larghezza-2026-10-11';
    fs.mkdirSync(dir, { recursive: true });
    await page.evaluate(async () => (await import('/js/theme.js')).scegliTema('dark'));
    await page.screenshot({ path: `${dir}/desktop.png` });
    await page.locator('#menu-conns-btn').click();
    await settle();
    assert(Math.abs((await measure()).table - (await measure()).panel) < 2, 'La griglia segue la chiusura del navigatore');
    await page.locator('#menu-conns-btn').click();
    await settle();

    const handle = page.locator('#grid .qt-col-resizer').first();
    const before = (await measure()).columns[1];
    await handle.focus();
    await handle.press('ArrowRight');
    const chosen = (await measure()).columns[1];
    assert(Math.abs(chosen - before - 16) < 1, 'La tastiera parte dalla larghezza effettiva');
    assert.equal(Number(await handle.getAttribute('aria-valuenow')), Math.round(chosen));
    for (const width of [1100, 1700, 390]) {
      await page.setViewportSize({ width, height: 900 }); await settle();
      const current = await measure();
      assert(Math.abs(current.columns[1] - chosen) < 1, `La misura manuale resta esatta a ${width}px`);
      assert.equal(current.columns[0], 48);
      if (width > 900) assert(Math.abs(current.table - current.panel) < 2, 'Le altre colonne riempiono il pannello');
      else assert(current.table > current.panel, 'Su mobile i contenuti larghi scorrono senza essere schiacciati');
    }
    await page.evaluate(() => window.widthFixture([{ id: 1 }])); await settle();
    assert(Math.abs((await measure()).table - (await measure()).panel) < 2, 'Una sola colonna riempie anche il mobile');
    await page.screenshot({ path: `${dir}/mobile.png` });
    await page.setViewportSize({ width: 1440, height: 900 }); await settle();
    await page.evaluate(() => window.widthFixture(Array.from({ length: 2000 }, (_, i) => ({ id: i, nome: `Riga ${i}` }))));
    await page.locator('#grid.virtual').waitFor(); await settle();
    const virtual = await measure();
    await page.locator('.grid-wrap').evaluate(el => { el.scrollTop = 5000; }); await settle();
    assert.deepEqual((await measure()).columns, virtual.columns, 'Le colonne virtualizzate non cambiano durante lo scroll');
    assert(Math.abs(virtual.table - virtual.panel) < 2, 'Anche le righe virtualizzate riempiono il pannello');
    await page.evaluate(() => window.widthFixture([Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`campo_${i}`, `Valore della colonna ${i}`]))]));
    await settle();
    const many = await measure();
    assert(many.table > many.panel * 2 && many.columns.slice(1).every(w => w >= 80), 'Molte colonne restano leggibili con scroll orizzontale');
    console.log('OK: spazio disponibile, checkbox, ridimensionamento, mobile, virtualizzazione e molte colonne');

    await page.locator('.view-tab[data-view="query"]').click();
    await page.evaluate(async () => (await import('/js/query-tab.js')).renderResults([{ id: 1, nome: 'Roma' }], ['id', 'nome']));
    await page.locator('#query-result-table tbody tr:not(.v-spacer)').first().waitFor(); await settle();
    const query = await measure('#query-result-table');
    assert(Math.abs(query.table - query.panel) < 2, 'La cache delle misure query conserva le colonne automatiche');
    const qHandle = page.locator('#query-result-table .qt-col-resizer').first();
    const qBefore = query.columns[0];
    await qHandle.press('ArrowLeft'); await settle();
    assert(Math.abs((await measure('#query-result-table')).columns[0] - qBefore + 16) < 1, 'Si può restringere una colonna query espansa');
    await page.locator('#query-result-table th').nth(1).click(); await settle();
    assert(Math.abs((await measure('#query-result-table')).columns[0] - qBefore + 16) < 1, 'L’ordinamento mantiene la misura manuale');
    await page.evaluate(async () => (await import('/js/query-tab.js')).renderResults([{ unico: 1 }], ['unico'])); await settle();
    const single = (await measure('#query-result-table')).columns[0];
    await qHandle.press('ArrowLeft'); await settle();
    assert(Math.abs((await measure('#query-result-table')).columns[0] - single + 16) < 1, 'Anche l’ultima colonna rispetta una misura manuale');
    console.log('OK: risultati query, cache, ordinamento e risultato con una colonna');
    await page.locator('.view-tab[data-view="data"]').click();
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.evaluate(() => window.widthFixture());
    await page.evaluate(async () => (await import('/js/splitview.js')).addOrSplitPane(null, 'right', {
      db: 'demo', coll: 'geometrie', tabId: 'larghezza',
    }));
    const pane = await require('./split-frame').frame(page);
    await pane.locator('#grid tbody tr:not(.v-spacer)').first().waitFor(); await settle();
    const split = await measure('#grid', pane);
    assert(Math.abs(split.table - split.panel) < 2, 'Anche il pannello affiancato usa lo spazio disponibile');
    console.log('OK: poche colonne nel pannello affiancato');
    assert.deepEqual(errors, [], 'Nessun errore runtime o ciclo di ResizeObserver');
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
