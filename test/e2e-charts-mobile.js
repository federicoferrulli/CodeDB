'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { scegliArc } = require('./arc-controls');
const dir = 'test-reports/charts-mobile';
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3247 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.stack));
  try {
    if (mutant) await page.route('**/css/style.css*', async route => {
      const response = await route.fetch(), source = await response.text();
      const body = source.replace('grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));', 'grid-column: 1 / -1; display: flex; overflow-x: auto;');
      assert.notEqual(body, source);
      await route.fulfill({ response, body });
    });
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'charts-mobile-fixture' });
      tabs.activeId = tab.id; tab.label = 'MongoDB'; tab.dbType = 'mongodb';
      const collections = [{ name: 'bevande' }], databases = [{ name: 'prova', collections }];
      Object.assign(tab.state, { connected: true, dbType: 'mongodb', connLabel: tab.label, databases });
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        ack?.({ ok: true, databases, collections, connections: [], fields: [], columns: [], indexes: [], docs: [], total: 0, relazioni: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('prova', 'bevande');
      (await import('/js/main.js')).setView('query');
      const query = await import('/js/query-tab.js');
      query.renderResults(Array.from({ length: 10 }, (_, id) => ({ categoria: ['Acqua', 'Caffè', 'Tè'][id % 3], quantita: id + 1,
        hydrationMultiplier: 0.8, nome_categoria_con_una_etichetta_molto_lunga: `Categoria ${id % 3}` })));
      query.setResultsViewMode('chart');
    });
    await page.locator('#query-chart-canvas canvas').waitFor();
    await page.locator('#chart-quickbar [role="combobox"]').first().waitFor();
    const geometry = await page.locator('#chart-quickbar').evaluate(el => ({ width: el.clientWidth, overflow: el.scrollWidth - el.clientWidth,
      fields: [...el.querySelectorAll('[role="combobox"]')].map(e => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width, height: r.height }; }) }));
    assert(geometry.overflow <= 1 && geometry.fields.every(f => f.width >= 120 && f.height >= 44 && f.x >= 0 && f.right <= 390), `Selettori visibili e toccabili: ${JSON.stringify(geometry)}`);
    await scegliArc(page, '#chart-quickbar select[data-path="tipo"]', 'pie');
    await scegliArc(page, '#chart-quickbar select[data-path="campoX"]', 'categoria');
    await scegliArc(page, '#chart-quickbar select[data-path="campoY"]', 'quantita');
    assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.chartCfg.serie[0].tipo), 'pie');
    const checkControl = async selector => {
      const el = page.locator(selector);
      await el.scrollIntoViewIfNeeded();
      assert(await el.evaluate(el => {
        const r = el.getBoundingClientRect(), limits = document.querySelector('#query-chart-view').getBoundingClientRect();
        return r.x >= limits.x - 1 && r.right <= limits.right + 1 && r.top >= limits.top - 1 && r.bottom <= limits.bottom + 1
          && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), `Controllo raggiungibile: ${selector}`);
    };
    const layouts = [];
    for (const theme of ['dark', 'light']) for (const [width, height] of [[320, 844], [390, 844], [768, 1024], [844, 390], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(width => {
        for (const [name, value] of Object.entries({ '--sat': 0, '--sal': width === 844 ? 36 : 0, '--sar': width === 844 ? 24 : 0, '--sab': width === 844 ? 18 : 0 })) document.documentElement.style.setProperty(name, `${value}px`);
      }, width);
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.locator('#query-show-results').click();
      await page.locator('#query-chart-view').evaluate(el => { el.scrollTop = 0; });
      await page.waitForTimeout(180);
      const layout = await page.locator('#chart-quickbar').evaluate(el => ({ overflow: el.scrollWidth - el.clientWidth,
        fields: [...el.querySelectorAll('[role="combobox"]')].map(e => ({ width: e.clientWidth, height: e.clientHeight })),
        canvas: document.querySelector('#query-chart-canvas').clientHeight,
        pageOverflow: document.documentElement.scrollWidth - innerWidth }));
      layouts.push({ theme, width, height, ...layout });
      assert(layout.pageOverflow <= 1 && layout.canvas >= 240, `Spazio grafico: ${JSON.stringify(layout)}`);
      if (width <= 900) assert(layout.overflow <= 1 && layout.fields.every(f => f.width >= 120 && f.height >= 42), `Campi a ${width}px: ${JSON.stringify(layout)}`);
      for (const selector of ['#chart-suggest-btn', '#chart-export-menu-btn', '#chart-toggle-builder']) await checkControl(selector);
      // Il menu deve mostrare anche un nome di campo lungo e selezionarlo davvero.
      const field = page.locator('#chart-quickbar select[data-path="campoX"]');
      await field.locator('xpath=following-sibling::*[1]').getByRole('combobox').tap();
      const popup = page.locator('[data-arc-select-popup]');
      await page.waitForTimeout(200);
      const popupBounds = await popup.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, x: el.getBoundingClientRect().x,
        right: el.getBoundingClientRect().right, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom,
        options: [...el.querySelectorAll('[role="option"]')].map(e => ({ width: e.clientWidth, scrollWidth: e.scrollWidth, height: e.clientHeight })) }));
      assert(popupBounds.x >= 0 && popupBounds.right <= width && popupBounds.top >= 0 && popupBounds.bottom <= height, `Menu nel viewport: ${JSON.stringify(popupBounds)}`);
      assert(popupBounds.options.every(o => o.scrollWidth <= o.width + 1), `Nomi completi nel menu: ${JSON.stringify(popupBounds)}`);
      if (width <= 900) assert(popupBounds.options.every(o => o.height >= 42), 'Le opzioni hanno un’area touch di almeno 44 px, bordi compresi');
      if (width === 844) assert(popupBounds.x >= 36 && popupBounds.right <= width - 24 && popupBounds.bottom <= height - 18, 'Il menu rispetta la safe area in landscape');
      if (!checksOnly) await page.screenshot({ path: `${dir}/${theme}-${width}-menu.png`, animations: 'disabled' });
      await page.getByRole('option', { name: 'nome_categoria_con_una_etichetta_molto_lunga — testo', exact: true }).tap();
      assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.chartCfg.campoX), 'nome_categoria_con_una_etichetta_molto_lunga');
      await scegliArc(page, '#chart-quickbar select[data-path="campoX"]', 'categoria');
      await scegliArc(page, '#chart-quickbar select[data-path="tipo"]', 'bar');
      await page.locator('#chart-toggle-builder').click();
      assert.equal(await page.locator('#chart-toggle-builder').getAttribute('aria-expanded'), 'true');
      const axes = page.locator('#chart-builder summary').filter({ hasText: /^Assi$/ });
      if (!await axes.evaluate(el => el.parentElement.open)) await axes.click();
      await scegliArc(page, '#chart-builder select[data-path="assey.formato"]', 'compatto');
      assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.chartCfg.assey.formato), 'compatto');
      if (width <= 900) {
        await checkControl('#chart-close-builder');
        if (!checksOnly) await page.screenshot({ path: `${dir}/${theme}-${width}-pannello.png`, animations: 'disabled' });
        await page.locator('#chart-close-builder').tap();
      } else await page.locator('#chart-toggle-builder').click();
      assert.equal(await page.locator('#chart-toggle-builder').getAttribute('aria-expanded'), 'false');
      assert(await page.locator('#chart-builder-panel').evaluate(el => el.inert));
      await page.locator('#query-chart-view').evaluate(el => { el.scrollTop = 0; });
      if (!checksOnly) await page.screenshot({ path: `${dir}/${theme}-${width}.png`, animations: 'disabled' });
    }
    fs.writeFileSync(`${dir}/layouts.json`, JSON.stringify(layouts, null, 2));
    assert.deepEqual(errors, []);
    console.log('OK: 10 layout, selettori leggibili, campi lunghi, tipo/assi/misura reali e personalizzazione mobile accessibile.');
  } catch (e) { await page.screenshot({ path: `${dir}/failure.png` }); throw e; }
  finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
