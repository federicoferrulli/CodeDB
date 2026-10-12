'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/data-empty-2026-10-11/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3198 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  const report = { checks: [], layouts: [], errors: [] };
  const title = (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent === text, { selector: selector + ' .data-empty h3', text });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error' && !/net::|Failed to load resource/.test(msg.text())) report.errors.push(msg.text()); });
  try {
    if (mutant) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source.replace('renderDataEmpty(container, righe.length ? null : queryEmptyOptions());', 'renderDataEmpty(container, queryEmptyOptions());');
      assert.notEqual(body, source);
      await route.fulfill({ response, body });
    });
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    for (const theme of checksOnly ? ['dark'] : ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      for (const width of checksOnly ? [1440, 320] : [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width > 900 ? 960 : 844 });
        const welcome = page.locator('#welcome');
        await title('#welcome', 'Nessuna connessione aperta');
        const action = welcome.getByRole('button', { name: 'Aggiungi connessione' });
        const rect = await action.boundingBox();
        assert(rect.height >= 44 && rect.x >= 0 && rect.x + rect.width <= width, 'Azione iniziale raggiungibile anche su mobile');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Benvenuto senza overflow');
        if (!checksOnly) await page.screenshot({ path: `${dir}/welcome-${theme}-${width}.png`, animations: 'disabled' });
        if (width > 900) { await action.focus(); await page.keyboard.press('Enter'); }
        else await action.click();
        await page.locator('#conn-cancel-btn').waitFor();
        await page.locator('#conn-cancel-btn').click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert(await welcome.isVisible());
      }
    }
    report.checks.push('Nessuna connessione: azione accessibile da tastiera e touch, apertura e chiusura del form desktop/drawer mobile');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'empty-fixture' });
      tab.label = 'Locale'; tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      const databases = [{ name: 'app', collections: [{ name: 'ordini' }] }];
      Object.assign(tab.state, { connected: true, connLabel: 'Locale', dbType: tab.dbType, databases });
      window.emptyFixture = { docs: [], requests: [] };
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(name, payload, cb) {
        window.emptyFixture.requests.push(name);
        cb?.({ ok: true, databases, collections: databases[0].collections, docs: window.emptyFixture.docs,
          skip: 0, limit: 50, total: window.emptyFixture.docs.length, columns: ['id', 'nome'], fields: [], indexes: [] });
      } });
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('app', 'ordini');
    });
    await page.locator('.grid-wrap .data-empty h3').waitFor();
    assert(!(await page.locator('#welcome').isVisible()), 'Il benvenuto scompare con una connessione aperta');
    await title('.grid-wrap', 'Questa tabella è vuota');
    await page.evaluate(async () => {
      (await import('/js/state.js')).state.columns = [];
      (await import('/js/grid.js')).renderGrid();
    });
    assert.equal(await page.locator('#grid thead th').count(), 0, 'Nessuna intestazione fittizia senza colonne');
    const before = await page.evaluate(() => window.emptyFixture.requests.filter(n => n === 'collection:find').length);
    await page.locator('.grid-wrap .data-empty button').click();
    await page.waitForFunction(before => window.emptyFixture.requests.filter(n => n === 'collection:find').length > before, before);
    await page.locator('#filter-input').fill('inesistente');
    await page.locator('#run-btn').click();
    await page.locator('.grid-wrap .data-empty h3', { hasText: 'Nessuna corrispondenza' }).waitFor();
    await page.locator('.grid-wrap .data-empty button').click();
    assert(await page.locator('#filter-input').evaluate(el => el === document.activeElement));
    if (!checksOnly) await page.screenshot({ path: `${dir}/griglia-desktop.png`, animations: 'disabled' });
    report.checks.push('Griglia: vuota, filtrata, Aggiorna invia la richiesta e Modifica filtro porta il focus al campo');

    await page.locator('.view-tab[data-view="query"]').click();
    await page.evaluate(async () => { window.emptyQuery = await import('/js/query-tab.js'); window.emptyQuery.resetQueryView(); });
    await title('#query-table-view', 'I risultati iniziano qui');
    await page.evaluate(() => { window.emptyQuery.updateQueryMetrics('success', 12, 0); window.emptyQuery.renderResults([], ['id', 'nome']); });
    assert.equal(await page.locator('#query-result-table th').count(), 2, 'Zero righe conserva le colonne SQL');
    await title('#query-table-view', 'Nessun risultato');

    for (const theme of checksOnly ? [] : ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width > 900 ? 960 : 844 });
        if (width <= 900) await page.locator('#query-show-results').click();
        const empty = page.locator('#query-table-view .data-empty');
        await empty.locator('button').scrollIntoViewIfNeeded();
        const geometry = await empty.evaluate(el => {
          const r = el.getBoundingClientRect(), viewport = document.getElementById('query-table-view').getBoundingClientRect();
          const title = el.querySelector('h3'), description = el.querySelector('p');
          return { x: r.x, right: r.right, viewport: { x: viewport.x, right: viewport.right }, overflow: el.scrollWidth > el.clientWidth + 1,
            titleSize: getComputedStyle(title).fontSize, descriptionSize: getComputedStyle(description).fontSize,
            bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        assert(!geometry.overflow && !geometry.bodyOverflow, `${theme}/${width}: overflow`);
        assert(geometry.x >= geometry.viewport.x - 1 && geometry.right <= geometry.viewport.right + 1, 'Messaggio dentro il viewport');
        if (width <= 600) assert((await empty.locator('button').boundingBox()).height >= 44);
        await page.screenshot({ path: `${dir}/query-${theme}-${width}.png`, animations: 'disabled' });
        report.layouts.push({ theme, width, ...geometry });
      }
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('#query-show-results').click();
    await page.locator('#query-table-view .data-empty button').click();
    assert(await page.locator('#query-editor-input').evaluate(el => el === document.activeElement));
    assert.equal(await page.locator('.query-main-panel').getAttribute('data-surface'), 'editor');
    await page.locator('#query-show-results').click();
    for (const [mode, selector] of [['json', '#query-json-view'], ['chart', '#chart-empty']]) {
      await page.evaluate(mode => window.emptyQuery.setResultsViewMode(mode), mode);
      await page.locator(`${selector} .data-empty`).waitFor();
      await title(selector, 'Nessun risultato');
      if (!checksOnly) await page.screenshot({ path: `${dir}/${mode}-mobile.png`, animations: 'disabled' });
      await page.locator(`${selector} .data-empty button`).click();
      assert(await page.locator('#query-editor-input').evaluate(el => el === document.activeElement));
      await page.locator('#query-show-results').click();
    }
    report.checks.push('Query: stato iniziale e zero risultati distinti, colonne conservate, azione editor funzionante da tabella/JSON/grafico');

    await page.evaluate(() => { window.emptyQuery.setResultsViewMode('table'); window.emptyQuery.updateQueryMetrics('running'); });
    assert.equal(await page.locator('#query-table-view .data-empty').count(), 0, 'Il vuoto non resta sopra il caricamento');
    await page.evaluate(() => { window.emptyQuery.updateQueryMetrics('success', 12, 1); window.emptyQuery.renderResults([{ id: 1, nome: 'Anna' }], ['id', 'nome']); });
    assert.equal(await page.locator('#query-table-view .data-empty').count(), 0, 'Il vuoto scompare quando arrivano dati');
    assert.match(await page.locator('#query-result-table tbody').textContent(), /Anna/);
    await page.evaluate(() => { window.emptyQuery.setResultsViewMode('json'); });
    assert.equal(await page.locator('#query-json-view .data-empty').count(), 0);
    await page.locator('#query-json-tree .json-header[aria-expanded="false"]').first().click();
    assert.match(await page.locator('#query-json-tree').textContent(), /Anna/);
    await page.evaluate(() => { window.emptyQuery.updateQueryMetrics('error', 3, 0, 'Errore di prova'); window.emptyQuery.renderResults([]); });
    await title('#query-json-view', 'La query non è riuscita');
    await page.evaluate(() => { window.emptyQuery.resetQueryView(); });
    await title('#query-table-view', 'I risultati iniziano qui');
    await page.evaluate(() => { window.emptyQuery.updateQueryMetrics('running'); window.emptyQuery.renderResults([], ['id']); window.emptyQuery.updateQueryMetrics('success', 10, 0); });
    await title('#query-table-view', 'Nessun risultato');
    await page.evaluate(() => { window.emptyQuery.updateQueryMetrics('running'); window.emptyQuery.renderResults([]); window.emptyQuery.updateQueryMetrics('cancelled'); });
    await title('#query-table-view', 'Query annullata');
    report.checks.push('Transizioni: vuoto → caricamento → dati → errore → reset, senza messaggi residui o duplicati');
    report.checks.push('Script: messaggio aggiornato anche quando le righe arrivano prima dello stato success/cancelled');

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(async () => {
      const split = await import('/js/splitview.js');
      split.addOrSplitPane(null, 'right', { tabId: 'empty-fixture', db: 'app', coll: 'ordini', view: 'data' });
    });
    const pane = await require('./split-frame').frame(page, -1);
    await pane.locator('.grid-wrap .data-empty:visible').first().waitFor();
    if (!checksOnly) await page.screenshot({ path: `${dir}/split-desktop.png`, animations: 'disabled' });
    const refreshBefore = await page.evaluate(() => window.emptyFixture.requests.filter(n => n === 'collection:find').length);
    await pane.locator('.grid-wrap .data-empty:visible button').first().click();
    await page.waitForFunction(before => window.emptyFixture.requests.filter(n => n === 'collection:find').length > before, refreshBefore);
    report.checks.push('Pannello affiancato: composizione condivisa e pulsante Aggiorna funzionante');
    assert.deepEqual(report.errors, []);
    console.log(`OK: ${report.checks.length} scenari stati vuoti, ${report.layouts.length} layout`);
  } catch (error) {
    report.failure = error.stack;
    await page.screenshot({ path: `${dir}/failure.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/${checksOnly ? 'checks' : 'report'}.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
