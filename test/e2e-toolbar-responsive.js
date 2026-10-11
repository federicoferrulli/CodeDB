'use strict';

// Controller e autocomplete reali; trasporto isolato, nessuna connessione utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `test-reports/toolbar-2026-10-11/${mutant ? 'mutante' : process.argv.includes('--before') ? 'prima' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3196 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const report = { layouts: [], checks: [], errors: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.setDefaultTimeout(7000);
  try {
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForFunction(() => document.getElementById('sort-input')?.closest('.ac-wrap'));
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const tab = createTab({ id: 'toolbar' });
      tab.label = 'Locale'; tab.dbType = 'mongodb'; tabs.activeId = tab.id;
      const docs = [{ id: 1, nome: 'Mario' }, { id: 2, nome: 'Anna' }];
      const databases = [{ name: 'vendite', collections: [{ name: 'ordini' }] }];
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases });
      window.toolbarRequests = [];
      impostaSocket({ connected: true, on() {}, off() {}, emit(name, msg, cb) {
        if (name === 'collection:find') window.toolbarRequests.push(msg);
        cb?.({ ok: true, databases, collections: databases[0].collections, docs, skip: 0, limit: 50,
          total: docs.length, columns: ['id', 'nome'], fields: [], indexes: [] });
      } });
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('vendite', 'ordini');
    });
    if (mutant) await page.addStyleTag({ content: '#sort-input { min-width: 320px !important; }' });
    const inspect = async label => {
      const layout = await page.locator('#view-data > .toolbar').evaluate(bar => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const controls = [...bar.querySelectorAll('#filter-mode-switch button, #filter-input, #sort-input, #query-history-btn, #run-btn, #insert-btn, #refresh-btn, #data-more-btn')]
          .map(node => ({ id: node.id || node.dataset.filterMode, ...rect(node) }));
        const overlaps = controls.flatMap((a, i) => controls.slice(i + 1).filter(b => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1).map(b => `${a.id}/${b.id}`));
        return { box: rect(bar), controls, overlaps, mobile: innerWidth <= 900,
          overflow: bar.scrollWidth > bar.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1 };
      });
      report.layouts.push({ label, ...layout });
      assert.deepEqual(layout.overlaps, [], `${label}: comandi sovrapposti`);
      assert(!layout.overflow, `${label}: overflow orizzontale`);
      for (const c of layout.controls) {
        assert(c.x >= layout.box.x && c.right <= layout.box.right + 1 && c.y >= layout.box.y && c.bottom <= layout.box.bottom + 1, `${label}: ${c.id} fuori dalla toolbar`);
        if (layout.mobile) assert(c.width >= 44 && c.height >= 44, `${label}: ${c.id} troppo piccolo per il touch`);
      }
    };
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      for (const width of [1440, 1180, 1024, 980, 950, 920, 901, 900, 844, 768, 600, 390, 320]) {
        await page.setViewportSize({ width, height: width === 844 ? 390 : 900 });
        await inspect(`${theme}/${width}`);
        if ([1440, 1024, 390].includes(width)) await page.locator('#view-data > .toolbar').screenshot({ path: `${dir}/${theme}-${width}.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#navigator').evaluate(el => { el.style.width = '650px'; });
    await inspect('desktop/navigatore-allargato');
    await page.locator('#navigator').evaluate(el => el.style.removeProperty('width'));
    report.checks.push('27 layout: due temi, 320–1440px, soglia desktop/mobile, landscape e navigatore allargato');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('radio', { name: 'Condizione', exact: true }).click();
    await page.locator('#filter-input').fill('{ "id": 1 }');
    await page.locator('#sort-input').fill('{ "nome": 1 }');
    await page.keyboard.press('Escape');
    await page.locator('#run-btn').click();
    await page.waitForFunction(() => window.toolbarRequests.at(-1)?.filter === '{ "id": 1 }');
    assert.equal(await page.evaluate(() => window.toolbarRequests.at(-1).sort), '{ "nome": 1 }');
    await page.locator('#query-history-btn').click();
    const history = page.locator('#query-history-panel');
    await history.waitFor();
    const bounds = await history.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844, 'Cronologia dentro il viewport mobile');
    await history.locator('.query-history-item').first().click();
    assert.equal(await page.locator('#sort-input').inputValue(), '{ "nome": 1 }');
    await page.locator('#sort-input').fill('nom');
    const suggestion = page.locator('#sort-input').locator('..').locator('[role="option"]').first();
    await suggestion.waitFor();
    await page.locator('#sort-input').press('ArrowDown');
    await page.locator('#sort-input').press('Enter');
    assert.match(await page.locator('#sort-input').inputValue(), /nome/);
    await page.locator('#data-more-btn').click();
    assert(await page.locator('#explain-btn').isVisible());
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await page.locator('#filter-input').inputValue(), '{ "id": 1 }');
    assert.match(await page.locator('#sort-input').inputValue(), /nome/);
    report.checks.push('Filtro, ordinamento, esecuzione, cronologia, autocomplete da tastiera e menu funzionanti; testi conservati al resize');
    assert.deepEqual(report.errors, []);
    report.ok = true;
    console.log(report.checks.join('\n'));
  } catch (error) {
    report.ok = false; report.failure = error.stack;
    await page.screenshot({ path: `${dir}/errore.png` }); console.error(error); process.exitCode = 1;
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})();
