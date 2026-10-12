'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `test-reports/query-map-2026-10-12/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: mutant ? 3220 : 3219 });
  const browser = await chromium.launch();
  const report = { checks: [], layouts: [], errors: [] };
  const check = text => { report.checks.push(text); console.log('OK', text); };
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(6000);
    page.on('pageerror', e => report.errors.push(e.stack || e.message));
    if (mutant) await page.route('**/js/query-map.js', async route => {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes('if (righeMostrate === lista)'));
      await route.fulfill({ response, body: source.replace('if (righeMostrate === lista)', 'if (false)') });
    });
    await page.addInitScript(versione => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true }));
      localStorage.setItem('codedb:geo:tiles', 'off');
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const L = await (await import('/js/geo-leaflet.js')).caricaLeaflet();
      const f = window.qmapFixture = { layers: [], maps: [], builds: 0 };
      const geoJSON = L.geoJSON, map = L.map;
      L.geoJSON = (...args) => { f.builds++; const l = geoJSON(...args); f.layers.push(l); return l; };
      L.map = (...args) => { const m = map(...args); f.maps.push(m); return m; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { f.clipboard = text; } } });
      f.rows = [
        { sede: { type: 'Point', coordinates: [12.495, 41.895, 25] }, percorso: { type: 'LineString', coordinates: [[12.49, 41.885], [12.503, 41.897], [12.525, 41.91]] } },
        { zona: { type: 'Polygon', coordinates: [[[12.503, 41.89], [12.518, 41.89], [12.518, 41.901], [12.503, 41.901], [12.503, 41.89]]] } },
        { consegne: { type: 'MultiPoint', coordinates: [[12.488, 41.913], [12.525, 41.893]] } },
        { annidato: { campo_con_un_nome_molto_lungo: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [12.511, 41.908] }, { type: 'LineString', coordinates: [[12.511, 41.908], [12.52, 41.92]] }] } } },
        { '<img src=x onerror="window.geoInjected=1">': JSON.stringify({ type: 'Point', coordinates: [12.487, 41.886] }) },
      ];
      f.query = await import('/js/query-tab.js');
      f.module = await import('/js/query-map.js');
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
      for (const id of ['tab-body', 'workspace', 'view-query']) document.getElementById(id).classList.remove('hidden');
      for (const panel of document.querySelectorAll('#workspace .view-panel')) panel.classList.toggle('hidden', panel.id !== 'view-query');
      document.querySelector('#query-show-results').click();
      f.query.renderResults(f.rows);
      f.query.setResultsViewMode('map');
    });
    const settle = () => page.waitForTimeout(380);
    await page.locator('#qmap-canvas canvas').waitFor(); await settle();
    assert.equal(await page.locator('#qmap-list button').count(), 6);
    assert(await page.locator('#qmap-map-panel').isVisible());
    assert(await page.locator('#qmap-list-panel').isVisible());
    assert.equal(await page.locator('#qmap-list img').count(), 0);
    assert.equal(await page.evaluate(() => window.geoInjected), undefined);
    check('Geometrie SQL JSON, annidate e multipart; nomi arbitrari trattati come testo');

    await page.locator('#query-show-editor').click(); await settle();
    assert(await page.locator('#query-editor-container').isVisible());
    assert(!await page.locator('#query-results-container').isVisible());
    await page.locator('#query-editor-input').fill('SELECT * FROM percorsi;');
    await page.locator('#query-editor-input').evaluate(el => el.setSelectionRange(7, 8));
    const surfaceMotion = await page.evaluate(() => {
      document.getElementById('query-show-both').click();
      return document.getElementById('query-surface-content').getAnimations().map(a => a.effect.getTiming().duration);
    });
    assert.deepEqual(surfaceMotion, [240]);
    assert(await page.locator('#query-editor-container').isVisible());
    assert(await page.locator('#query-results-container').isVisible());
    await page.locator('#query-show-both').press('Home');
    assert.equal(await page.locator('#query-show-editor').getAttribute('aria-selected'), 'true');
    await page.locator('#query-show-editor').press('ArrowRight');
    assert.equal(await page.locator('#query-show-results').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#query-surface-content').getAttribute('aria-labelledby'), 'query-show-results');
    assert.deepEqual(await page.locator('#query-editor-input').evaluate(el => [el.value, el.selectionStart, el.selectionEnd]), ['SELECT * FROM percorsi;', 7, 8]);
    check('Editor/Risultati/Entrambi: vere schede, focus da tastiera, transizione e bozza conservata');

    await page.locator('#qmap-list [data-i="0"]').click(); await settle();
    const before = await page.evaluate(() => ({ builds: qmapFixture.builds, center: qmapFixture.maps[0].getCenter(), zoom: qmapFixture.maps[0].getZoom() }));
    await page.evaluate(() => { qmapFixture.query.setResultsViewMode('json'); qmapFixture.query.setResultsViewMode('map'); });
    await settle();
    const after = await page.evaluate(() => ({ builds: qmapFixture.builds, center: qmapFixture.maps[0].getCenter(), zoom: qmapFixture.maps[0].getZoom() }));
    assert.equal(after.builds, before.builds, 'Cambiare vista non deve ricostruire i layer');
    assert.equal(after.zoom, before.zoom);
    assert(await page.evaluate(center => qmapFixture.maps[0].latLngToContainerPoint(center).distanceTo(qmapFixture.maps[0].getSize().divideBy(2)) <= 1, before.center), 'Inquadratura conservata entro l’arrotondamento al pixel di Leaflet');
    assert.equal(await page.locator('#qmap-list [data-i="0"]').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => qmapFixture.layers[2].fire('click'));
    assert.equal(await page.locator('#qmap-list [data-i="2"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => qmapFixture.builds), before.builds);
    check('Cambio JSON/Mappa e selezione bidirezionale senza ricostruire il canvas o perdere zoom');

    const motion = await page.evaluate(() => {
      document.getElementById('qmap-tab-riepilogo').click();
      return document.getElementById('qmap-summary-panel').getAnimations().map(a => a.effect.getTiming().duration);
    });
    assert.deepEqual(motion, [240]);
    await page.locator('#qmap-tab-riepilogo').press('ArrowLeft');
    assert.equal(await page.locator('#qmap-tab-elenco').getAttribute('aria-selected'), 'true');
    await page.locator('#qmap-copy').click();
    assert.match(await page.evaluate(() => qmapFixture.clipboard), /Geometrie\t6/);
    const download = page.waitForEvent('download');
    await page.locator('#qmap-export').click();
    const fc = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
    assert.equal(fc.features.length, 6);
    assert.deepEqual(fc.features[0].geometry.coordinates, [12.495, 41.895, 25]);
    check('Navigazione a tastiera, transizione da 240ms, copia riepilogo ed export preservano i dati');

    for (const [width, height, theme] of [[1440, 960, 'dark'], [1440, 960, 'light'], [390, 844, 'dark'], [320, 740, 'light'], [844, 390, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => (import('/js/theme.js')).then(m => m.scegliTema(theme)), theme);
      await settle();
      await page.locator('#query-map-view').evaluate(el => { el.scrollTop = 0; });
      if (height < 500) { await page.locator('#qmap-expand').click(); await settle(); }
      if (await page.locator('#qmap-tab-mappa').isVisible()) await page.locator('#qmap-tab-mappa').click();
      await page.locator('#qmap-fit').click(); await settle();
      const layout = await page.evaluate(() => {
        const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { map: rect('qmap-canvas'), view: rect('query-map-view'), export: rect('qmap-export'), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      report.layouts.push({ width, height, theme, ...layout });
      assert(!layout.overflow, 'Nessuno scorrimento orizzontale del documento');
      assert(layout.map.width > 200 && layout.map.height >= 140, `Mappa leggibile: ${JSON.stringify(layout)}`);
      assert(layout.export.bottom <= height + 1, 'Export raggiungibile');
      if (width <= 900) {
        assert(layout.export.height >= 44);
        if (height >= 500) assert(await page.locator('#query-show-results').evaluate(el => el.getBoundingClientRect().height >= 44));
      }
      if (await page.locator('#qmap-tab-mappa').isVisible()) {
        await page.locator('#qmap-tab-elenco').click();
        assert(!await page.locator('#qmap-map-panel').isVisible());
        await page.locator('#qmap-list [data-i="1"]').click();
        assert(await page.locator('#qmap-map-panel').isVisible());
        assert.equal(await page.evaluate(() => document.activeElement.id), 'qmap-tab-mappa');
      }
      await page.evaluate(() => qmapFixture.layers.forEach(l => l.closeTooltip()));
      await settle();
      await page.screenshot({ path: `${dir}/mappa-${theme}-${width}.png` });
      if (width === 390 || width === 1440 && theme === 'dark') for (const mode of ['elenco', 'riepilogo']) {
        await page.locator(`#qmap-tab-${mode}`).click(); await settle();
        await page.screenshot({ path: `${dir}/${mode}-${width}.png` });
      }
      if (width === 390) {
        await page.locator('#query-show-editor').click(); await settle();
        const indicator = await page.evaluate(() => {
          const bar = document.getElementById('query-surface-tabs');
          const tab = bar.querySelector('[aria-selected="true"]').getBoundingClientRect();
          const stripe = bar.querySelector('.tab-selection').getBoundingClientRect();
          return { dx: Math.abs(tab.x - stripe.x), dy: Math.abs(tab.y - stripe.y), width: stripe.width, height: stripe.height };
        });
        assert(indicator.dx < 1 && indicator.dy < 1 && indicator.height >= 44, `Indicatore allineato alla scheda: ${JSON.stringify(indicator)}`);
        await page.screenshot({ path: `${dir}/schede-editor-390.png` });
        await page.locator('#query-show-both').click(); await settle();
        await page.screenshot({ path: `${dir}/schede-entrambi-390.png` });
        assert(await page.locator('#query-editor-container').isVisible());
        assert(await page.locator('#query-results-container').isVisible());
        await page.locator('#query-show-results').click(); await settle();
      }
      if (height < 500) { await page.locator('#qmap-expand').click(); await settle(); }
    }
    check('Scuro/chiaro, desktop, mobile 320/390 e orizzontale: mappa libera, focus corretto, controlli touch');

    await page.setViewportSize({ width: 1440, height: 960 }); await settle();
    await page.locator('#query-map-view').evaluate(el => { el.style.width = '600px'; }); await settle();
    assert(await page.locator('#qmap-tab-mappa').isVisible(), 'Un pannello stretto usa le schede anche su desktop');
    await page.screenshot({ path: `${dir}/pannello-600.png` });
    await page.locator('#query-map-view').evaluate(el => { el.style.width = ''; }); await settle();
    assert(!await page.locator('#qmap-tab-mappa').isVisible());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => {
      document.getElementById('qmap-tab-riepilogo').click();
      return document.getElementById('qmap-body').getAnimations({ subtree: true }).length;
    }), 0);
    assert.equal(await page.evaluate(() => {
      document.getElementById('query-show-editor').click();
      const count = document.getElementById('query-surface-content').getAnimations().length;
      document.getElementById('query-show-results').click();
      return count;
    }), 0);
    check('Layout segue la larghezza del pannello; movimento ridotto senza animazioni residue');

    const isolation = await page.evaluate(async () => {
      const { apriMappaSelezione } = await import('/js/geomulti.js');
      await apriMappaSelezione({ voci: [{ valore: { type: 'Point', coordinates: [10, 40] }, colonna: 'indipendente', riga: 0 }] });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      document.getElementById('geomulti-tab-elenco').click();
      const result = document.getElementById('qmap-summary-panel').classList.contains('hidden');
      (await import('/js/utils.js')).closeModal('#geomulti-overlay');
      return result;
    });
    assert.equal(isolation, false, 'La modale non deve modificare le schede della mappa Query');
    await settle();
    await page.evaluate(async () => {
      await Promise.all([
        qmapFixture.module.renderQueryMap([{ vecchio: { type: 'Point', coordinates: [1, 2] } }]),
        qmapFixture.module.renderQueryMap([{ recente: { type: 'Point', coordinates: [3, 4] } }]),
      ]);
    });
    assert.match(await page.locator('#qmap-list').textContent(), /recente/);
    assert(!/vecchio/.test(await page.locator('#qmap-list').textContent()));
    await page.evaluate(() => qmapFixture.module.clearQueryMap());
    assert(await page.locator('#qmap-empty').isVisible());
    assert.equal(await page.locator('#qmap-list button').count(), 0);
    assert.equal(await page.locator('#qmap-conta').textContent(), '');
    assert(await page.locator('#qmap-export').isDisabled());
    await page.evaluate(() => qmapFixture.module.renderQueryMap([{ plain: 1 }]));
    assert.match(await page.locator('#qmap-empty').textContent(), /Nessuna geometria/);
    check('Istanze indipendenti, risposta superata scartata e azzeramento del contesto senza dati residui');

    const volume = await page.evaluate(async () => {
      const rows = Array.from({ length: 1600 }, (_, i) => ({ sede: { type: 'Point', coordinates: [12.4 + i / 20000, 41.8 + i / 20000] } }));
      const start = performance.now(), builds = qmapFixture.builds;
      await qmapFixture.module.renderQueryMap(rows);
      const drawMs = performance.now() - start;
      const cached = performance.now(); await qmapFixture.module.renderQueryMap(rows);
      return { drawMs, cachedMs: performance.now() - cached, builds: qmapFixture.builds - builds };
    });
    assert.equal(volume.builds, 1500);
    assert.equal(await page.locator('#qmap-list button').count(), 500);
    assert(await page.locator('#qmap-warning').isVisible());
    const volumeDownload = page.waitForEvent('download'); await page.locator('#qmap-export').click();
    assert.equal(JSON.parse(fs.readFileSync(await (await volumeDownload).path(), 'utf8')).features.length, 1600);
    report.volume = volume;
    assert.deepEqual(report.errors, []);
    check('1600 geometrie: disegno/elenco limitati, export completo e ritorno in cache senza ricostruzioni');
  } catch (err) {
    if (page) await page.screenshot({ path: `${dir}/failure.png` });
    throw err;
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
