'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/query-studio-2026-10-12/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3235 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const report = { layouts: [], errors: [] };
  page.on('pageerror', e => report.errors.push(e.message));
  page.setDefaultTimeout(7000);
  const reachable = async selector => {
    const el = page.locator(selector);
    await el.scrollIntoViewIfNeeded();
    assert(await el.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight + 1 && r.x >= 0 && r.right <= innerWidth + 1
        && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), `Controllo raggiungibile: ${selector}`);
  };
  try {
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    if (mutant) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const original = "if (view) view.dataset.queryState = status;";
      assert(source.includes(original));
      await route.fulfill({ response, body: source.replace(original, "if (view) view.dataset.queryState = 'idle';") });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    // Trasporto simulato, controllori e renderer reali. Nomi e righe sono illustrativi.
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'studio-fixture' });
      tab.label = 'PostgreSQL · Sviluppo'; tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      const fields = [{ name: 'id', type: 'integer' }, { name: 'nome', type: 'text' }, { name: 'totale', type: 'numeric' }, { name: 'creato_il', type: 'timestamp' }];
      const collections = [{ name: 'Prova', fields }, { name: 'clienti', fields }, { name: 'ordini', fields }];
      const databases = [{ name: 'diego_2', collections }, { name: 'analytics', collections }, { name: 'public', collections }];
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases });
      window.studio = { queue: [], sent: [], editor: document.getElementById('query-editor-input') };
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        studio.sent.push({ name, payload });
        if (name === 'query:execute') { studio.queue.push(ack); return; }
        ack?.({ ok: true, databases, collections, fields, indexes: [], docs: [], total: 0, columns: fields.map(f => f.name), relazioni: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('diego_2', 'Prova');
      (await import('/js/main.js')).setView('query');
      window.studio.query = await import('/js/query-tab.js');
      studio.query.resetQueryView();
    });
    await page.locator('#query-table-view .query-empty-art').waitFor();
    const code = 'SELECT id, nome, totale\nFROM diego_2."Prova"\nORDER BY totale DESC;';
    const editor = page.locator('#query-editor-input');
    await editor.fill(code);
    await page.locator('#query-run-btn').click();
    assert.equal(await page.locator('#view-query').getAttribute('data-query-state'), 'running');
    assert(await page.locator('#query-stop-btn').isVisible());
    assert.equal(await page.evaluate(() => studio.sent.filter(r => r.name === 'query:execute').at(-1).payload.code), code);
    const rows = [
      { id: 1, nome: 'Ada', totale: { $numberDecimal: '12345678901234567890.12' } },
      { id: 2, nome: 'Luca', totale: { $numberDecimal: '420.50' } },
      { id: 3, nome: 'Marta', totale: { $numberDecimal: '315.00' } },
    ];
    await page.evaluate(rows => studio.queue.shift()({ ok: true, data: rows, columns: ['id', 'nome', 'totale'] }), rows);
    await page.waitForFunction(() => document.querySelector('#view-query').dataset.queryState === 'success');
    assert.equal(await page.locator('#query-count-val').textContent(), '3');
    assert((await page.locator('#query-result-table').textContent()).includes('12345678901234567890.12'));
    await page.locator('#res-mode-table').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#res-mode-json').getAttribute('aria-selected'), 'true');
    assert(await page.locator('#query-json-view').isVisible());
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#res-mode-table').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End');
    assert.equal(await page.locator('#res-mode-chart').getAttribute('aria-selected'), 'true');
    await page.waitForFunction(() => !!document.querySelector('#query-chart-canvas canvas, #query-chart-canvas svg'));
    await page.locator('#res-mode-chart').press('Home');
    await page.locator('#res-mode-json').click();
    await page.evaluate(() => studio.query.resetQueryView());
    assert.equal(await page.locator('#res-mode-table').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#res-mode-json').getAttribute('aria-selected'), 'false');
    await page.evaluate(rows => { studio.query.updateQueryMetrics('success', 12, rows.length); studio.query.renderResults(rows, ['id', 'nome', 'totale']); }, rows);
    await page.locator('#query-show-editor').click();
    assert(!await page.locator('#query-results-container').isVisible());
    await page.locator('#query-show-editor').press('End');
    assert.equal(await page.locator('#query-show-both').getAttribute('aria-selected'), 'true');
    assert(await page.evaluate(() => studio.editor === document.getElementById('query-editor-input')));
    assert.equal(await editor.inputValue(), code);
    await page.locator('#query-toggle-schema-btn').click();
    assert(!await page.locator('#query-schema-sidebar').isVisible());
    await page.locator('#query-toggle-schema-btn').click();
    await page.locator('#query-schema-search').fill('totale');
    await page.locator('.schema-node.schema-hit[data-nome="totale"]').first().waitFor();
    await page.locator('#query-schema-search').fill('');
    await page.locator('#query-editor-more-btn').click();
    await reachable('#query-save-sql-btn');
    await page.keyboard.press('Escape');
    await page.locator('#query-export-menu-btn').click();
    await reachable('#query-export-json');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${dir}/risultati-desktop.png`, animations: 'disabled' });

    await page.locator('#query-run-btn').click();
    await page.locator('#query-stop-btn').click();
    assert.equal(await page.locator('#view-query').getAttribute('data-query-state'), 'cancelled');
    await page.evaluate(() => studio.queue.shift()({ ok: true, data: [], columns: [] }));
    assert.equal(await page.locator('#view-query').getAttribute('data-query-state'), 'cancelled');
    await page.locator('#query-run-btn').click();
    await page.evaluate(() => studio.queue.shift()({ ok: false, error: 'La colonna richiesta non esiste (riga 2). Verifica il nome nello schema.' }));
    await page.waitForFunction(() => document.querySelector('#view-query').dataset.queryState === 'error');
    assert(await page.locator('#query-error-box').isVisible());
    assert.equal(await page.locator('.gutter-line-error').textContent(), '2');
    await page.evaluate(() => studio.query.resetQueryView());
    await editor.fill('');

    for (const theme of checksOnly ? [] : ['dark', 'light']) for (const [width, height] of [[1440, 1000], [1024, 768], [768, 1024], [390, 844], [320, 640], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.locator('#query-show-both').click();
      await page.waitForTimeout(400);
      const geometry = await page.locator('#view-query').evaluate(el => ({ overflow: el.scrollWidth > el.clientWidth + 1,
        toolbar: document.querySelector('.query-studio-toolbar').scrollWidth > document.querySelector('.query-studio-toolbar').clientWidth + 1,
        editor: document.querySelector('#query-editor-input').getBoundingClientRect().height }));
      assert(!geometry.overflow && !geometry.toolbar && geometry.editor >= 60, `${theme} ${width}: ${JSON.stringify(geometry)}`);
      await reachable('#query-run-btn');
      await reachable('#query-editor-more-btn');
      await page.screenshot({ path: `${dir}/${theme}-${width}-insieme.png`, animations: 'disabled' });
      if (width === 1440) await page.locator('#view-query').screenshot({ path: `${dir}/spazio-${theme}.png`, animations: 'disabled' });
      if (width <= 900) {
        await page.locator('#query-toggle-schema-btn').click();
        await reachable('#query-schema-search');
        await page.locator('#query-schema-close').click();
        await page.locator('#query-show-results').click();
        await reachable('#query-table-view .data-empty button');
        await page.screenshot({ path: `${dir}/${theme}-${width}-risultati.png`, animations: 'disabled' });
        await page.locator('#query-table-view .data-empty button').click();
        assert(await editor.evaluate(el => document.activeElement === el));
      }
      report.layouts.push({ theme, width, ...geometry });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#query-show-both').click();
    await page.evaluate(() => studio.query.updateQueryMetrics('running'));
    assert.equal(await page.locator('.query-topbar').evaluate(el => getComputedStyle(el, '::after').animationName), 'none');
    assert.equal(await page.locator('.query-target-caret').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.evaluate(() => studio.query.resetQueryView());
    assert.equal(await page.locator('#query-table-view .query-empty-art').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    assert.deepEqual(report.errors, []);
    fs.writeFileSync(`${dir}/${checksOnly ? 'funzioni' : 'checks'}.json`, JSON.stringify(report, null, 2));
    console.log(`OK: ${report.layouts.length} layout, query esatta, risultato decimale integro, grafico reale, errore, annullamento, tastiera, schema, menu e movimento ridotto.`);
  } catch (e) { await page.screenshot({ path: `${dir}/failure.png` }); throw e; }
  finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
