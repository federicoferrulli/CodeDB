'use strict';
// Dati sintetici confinati alla prova: renderer e navigazione sono quelli dell'app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const before = process.argv.includes('--before');
const mutant = process.argv.includes('--mutant');
const dir = `test-reports/design/${before ? 'prima' : mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });
const report = { checks: [], surfaces: [], errors: [], requests: [] };

(async () => {
  const server = await startTestServer({ port: 3176 });
  const browser = await chromium.launch();
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('response', r => { if (r.url().startsWith(server.url) && r.status() >= 400) report.requests.push(r.url()); });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForTimeout(500);
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    async function snapshot(name, widths = [1440, 768, 390]) {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 960 });
        await page.waitForTimeout(100);
        const geometry = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          font: getComputedStyle(document.documentElement).fontSize,
          row: document.querySelector('#grid tbody tr:not(.v-spacer)')?.getBoundingClientRect().height,
          expectedRow: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--grid-row-h')),
          labels: [...document.querySelectorAll('.sidebar-title, .view-tab, .editor-header')].filter(e => e.getClientRects().length).map(e => ({ text: e.textContent.trim(), size: parseFloat(getComputedStyle(e).fontSize) })),
        }));
        report.surfaces.push({ name, width, ...geometry });
        assert.equal(geometry.overflow, false, `${name}: overflow a ${width}`);
        if (!before) assert(geometry.labels.every(l => l.size >= 12), `${name}: etichette sotto 12 px`);
        if (!before && name.startsWith('dati-')) assert(Math.abs(geometry.row - geometry.expectedRow) <= 1, `${name}: riga ${geometry.row}, attesa ${geometry.expectedRow}`);
        if (!before && name.startsWith('query')) {
          for (const selector of ['#query-target-btn', '#query-run-btn', '#query-stop-btn', '#query-status-badge']) {
            const control = page.locator(selector);
            if (!await control.isVisible()) continue;
            const rect = await control.boundingBox();
            assert(rect.x >= 0 && rect.x + rect.width <= width + 1, `${name}: ${selector} tagliato a ${width}px`);
          }
        }
        await page.screenshot({ path: `${dir}/${name}-${width}.png`, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 1440, height: 960 });
    }
    if (mutant) await page.addStyleTag({ content: '.sidebar-title { font-size: 8px !important; }' });
    if (!before) {
      await page.locator('#command-palette-open').click();
      await page.locator('#palette-input').fill('>tema');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.id === 'command-palette-open');
      assert(await page.locator('#command-palette-open').evaluate(e => e === document.activeElement));
      report.checks.push('Ricerca comandi visibile, apertura e ripristino del focus');
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await snapshot(`inizio-${theme}`);
    }
    await page.locator('#conn-add-btn').click();
    await snapshot('connessione');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { state } = await import('/js/state.js');
      const { impostaSocket } = await import('/js/socket.js');
      const tab = createTab({ id: 'design-fixture', connName: 'Ambiente di prova' }); tabs.activeId = tab.id;
      const docs = Array.from({ length: 26 }, (_, i) => ({ _id: 1041 + i, cliente: ['Officina Nord', 'Studio Verde', 'Linea Sud'][i % 3], stato: ['spedito', 'in lavorazione', 'confermato'][i % 3], importo: { $numberDecimal: `${(i + 3) * 147}.50` }, pagato: i % 3 !== 1, creato: { $date: '2026-10-07T09:24:16.123Z' } }));
      const fields = [{ name: '_id', types: ['int'], presence: 100 }, { name: 'cliente', types: ['string'], presence: 100 }, { name: 'stato', types: ['string'], presence: 100 }, { name: 'importo', types: ['decimal'], presence: 100 }, { name: 'pagato', types: ['boolean'], presence: 100 }, { name: 'creato', types: ['date'], presence: 100 }];
      const stats = { count: 26, size: 16384, storageSize: 32768, avgObjSize: 630, totalIndexSize: 8192, nindexes: 2 };
      const indexes = [{ name: '_id_', key: { _id: 1 }, unique: true }, { name: 'cliente_1', key: { cliente: 1 } }];
      Object.assign(state, { connected: true, connLabel: 'Ambiente di prova', dbType: 'mongodb', db: 'gestionale', coll: 'ordini', docs, columns: Object.keys(docs[0]), total: docs.length, exhausted: true,
        databases: [{ name: 'gestionale', collections: [{ name: 'ordini' }, { name: 'clienti' }, { name: 'prodotti' }] }],
        collTabs: [{ id: 'ordini-fixture', db: 'gestionale', coll: 'ordini', view: 'data' }], activeCollId: 'ordini-fixture' });
      impostaSocket({ on() {}, off() {}, emit(event, payload, cb) {
        if (event === 'collection:stats') return cb?.({ ok: true, stats, fields, indexes, sampled: 26 });
        if (event === 'db:schema') return cb?.({ ok: true, collections: [{ name: 'ordini', fields, indexes }, { name: 'clienti', fields }, { name: 'prodotti', fields }] });
        if (event === 'collection:find') return cb?.({ ok: true, docs, columns: state.columns, total: docs.length });
        cb?.({ ok: true, databases: state.databases, collections: state.databases[0].collections, fields, relazioni: [], sessions: [] });
      } });
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      window.designDocs = docs;
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await snapshot(`dati-${theme}`);
    }
    await page.locator('.view-tab[data-view="details"]').click();
    await page.locator('#stats-table tbody tr').first().waitFor();
    await snapshot('dettagli');
    await page.locator('.view-tab[data-view="query"]').click();
    if (!before) {
      const initialWidth = (await page.locator('.query-main-panel').boundingBox()).width;
      await page.locator('#query-toggle-schema-btn').click();
      assert.equal(await page.locator('#query-toggle-schema-btn').getAttribute('aria-expanded'), 'false');
      assert((await page.locator('.query-main-panel').boundingBox()).width > initialWidth + 100);
      await page.locator('#query-toggle-schema-btn').click();
      assert.equal(await page.locator('#query-toggle-schema-btn').getAttribute('aria-expanded'), 'true');
      const handle = await page.locator('[data-resize="query-sidebar"]').boundingBox();
      const schemaWidth = (await page.locator('#query-schema-sidebar').boundingBox()).width;
      report.resize = { handle, schemaWidth, target: await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 300), { x: handle.x + handle.width / 2, y: handle.y + 50 }) };
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 50);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + 50, { steps: 5 });
      await page.mouse.up();
      report.resize.after = (await page.locator('#query-schema-sidebar').boundingBox()).width;
      assert(report.resize.after >= schemaWidth + 50, JSON.stringify(report.resize));
      await page.setViewportSize({ width: 390, height: 960 });
      await page.locator('#query-toggle-schema-btn').click();
      assert.equal(await page.locator('#query-toggle-schema-btn').getAttribute('aria-expanded'), 'true');
      await page.locator('#query-schema-close').click();
      assert.equal(await page.locator('#query-toggle-schema-btn').getAttribute('aria-expanded'), 'false');
      await page.locator('#query-toggle-schema-btn').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#query-toggle-schema-btn').getAttribute('aria-expanded'), 'false');
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.evaluate(() => { document.getElementById('query-schema-sidebar').style.width = ''; });
      report.checks.push('Schema desktop richiudibile e ridimensionabile; drawer mobile apribile e richiudibile');
    }
    await page.locator('#query-editor-input').fill("SELECT cliente, stato, importo, pagato\nFROM ordini\nWHERE importo > 500\nORDER BY creato DESC\nLIMIT 50;");
    await page.evaluate(async () => {
      const m = await import('/js/query-tab.js'); m.updateEditorHighlight(); m.renderResults(window.designDocs); m.updateQueryMetrics('success', 28, 26);
    });
    await snapshot('query');
    await page.evaluate(() => document.getElementById('btn-theme').click());
    await snapshot('temi');
    await page.locator('#btn-tema-nuovo').click();
    await snapshot('tema-editor');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const { showError, showToast } = await import('/js/utils.js');
      showError('#query-error-box', 'La query non è stata eseguita. Correggi il nome della collezione e riprova.');
      showToast('Esportazione completata: 26 righe.', 'success', 0);
    });
    await page.locator('#query-error-box [role="alert"]').waitFor();
    await snapshot('query-errore', [1440]);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.requests, []);
    report.checks.push('Navigazione Dati → Dettagli → Query e impostazioni; screenshot alle tre larghezze; due temi; nessun errore JS o HTTP');
    console.log(`OK ${report.surfaces.length} superfici/larghezze (${before ? 'baseline' : 'revisione'})`);
  } catch (error) {
    if (page) await page.screenshot({ path: `${dir}/failure.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
