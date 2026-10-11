'use strict';

// Controller e runtime reali; il trasporto non usa database o configurazioni personali.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `test-reports/split-mobile-2026-10-11/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3194 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true, reducedMotion: 'reduce' });
  page.setDefaultTimeout(7000);
  const report = { checks: [], errors: [] };
  page.on('pageerror', e => report.errors.push(e.message));
  const check = text => { report.checks.push(text); console.log('OK', text); };
  try {
    if (mutant) await page.route('**/js/splitview.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const guard = 'export async function addOrSplitPane(targetPaneId, dir, item, opts = {}) {\n  if (!splitDisponibile()) return;';
      assert(source.includes(guard));
      await route.fulfill({ response, body: source.replace(guard, 'export async function addOrSplitPane(targetPaneId, dir, item, opts = {}) {') });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const databases = [{ name: 'vendite', collections: ['ordini', 'clienti'].map(name => ({ name })) }];
      const socket = { connected: true, on() {}, off() {}, timeout() { return { emit: (name, msg, cb) => socket.emit(name, msg, res => cb(null, res)) }; },
        emit(name, msg, cb) { cb?.({ ok: true, dbType: 'postgresql', label: 'Locale', databases,
          collections: databases[0].collections, docs: [{ id: 1, nome: msg.coll }], columns: ['id', 'nome'], total: 1, fields: [], indexes: [], relations: [] }); } };
      impostaSocket(socket);
      const tab = createTab({ id: 'locale-split', connName: 'Locale' });
      tab.dbType = 'postgresql';
      Object.assign(tab.state, { connected: true, connLabel: 'Locale', dbType: 'postgresql', databases, expandedDbs: new Set(['vendite']) });
      tabs.activeId = tab.id;
      const coll = await import('/js/colltabs.js'), split = await import('/js/splitview.js');
      window.fixture = { tab, tabs, coll, split, workspace: await import('/js/workspace.js') };
      (await import('/js/tabbar.js')).renderTabBar();
      window.fixture.workspace.renderWorkspace();
      coll.openCollTab('vendite', 'ordini');
      window.fixture.singleId = tab.state.activeCollId;
      (await import('/js/main.js')).setView('query');
    });
    await page.locator('#query-editor-input').fill('SELECT BOZZA_SINGOLA');
    await page.evaluate(async () => {
      const f = window.fixture;
      await f.split.addOrSplitPane(null, 'right', { tabId: f.tab.id, db: 'vendite', coll: 'clienti' });
      f.areaId = f.tab.state.activeCollId;
    });
    await page.waitForFunction(() => document.querySelector('.pane-runtime')?.codedbPanel.ready);
    const frame = page.frames().find(f => f.parentFrame());
    await frame.locator('#query-editor-input').fill('SELECT BOZZA_PANNELLO');
    const before = await page.evaluate(() => window.fixture.split.getSplitStateSnapshot(window.fixture.areaId));
    assert(before.panes.some(([, p]) => p.query?.code === 'SELECT BOZZA_PANNELLO' && p.query.dirty));
    assert(await page.locator('#workspace-split-btn').isVisible());
    check('Desktop: area affiancata con editor reale e bozza non salvata');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.getElementById('workspace').classList.contains('split-active'));
    assert(await page.locator('#workspace').isVisible());
    await page.evaluate(async () => (await import('/js/main.js')).setView('query'));
    await page.locator('#query-editor-input').waitFor();
    assert.equal(await page.locator('#query-editor-input').inputValue(), 'SELECT BOZZA_SINGOLA');
    for (const selector of ['#workspace-split-btn', '#workspace-active-pane-btn', '#uml-dati-affianca', '.view-tab[data-view="split"]']) {
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).display), 'none', selector);
    }
    assert.deepEqual(await page.evaluate(() => window.fixture.split.getSplitStateSnapshot(window.fixture.areaId)), before);
    assert.equal(await page.locator('.split-container').count(), 0);
    await page.screenshot({ path: `${dir}/singola-390.png` });
    check('Passaggio a mobile: scheda singola, comandi rimossi, area e bozza conservate');

    const guard = await page.evaluate(async () => {
      const f = window.fixture, count = f.tab.state.collTabs.length;
      await f.split.addOrSplitPane(null, 'right', { tabId: f.tab.id, db: 'vendite', coll: 'clienti' }, { nuovaArea: true });
      return { count, after: f.tab.state.collTabs.length };
    });
    assert.equal(guard.after, guard.count, 'Su mobile neppure una chiamata diretta può creare uno split');
    await page.evaluate(() => {
      const f = window.fixture, ws = document.getElementById('workspace');
      const data = new DataTransfer();
      data.setData('application/codedb-tab', JSON.stringify({ tabId: f.tab.id, db: 'vendite', coll: 'clienti' }));
      const rect = ws.getBoundingClientRect();
      for (const type of ['dragover', 'drop']) ws.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.right - 2, clientY: rect.top + 80 }));
      f.coll.switchCollTab(f.areaId);
      f.split.renderSplitView();
    });
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Alt+m');
    assert(await page.locator('#drop-zone-overlay').isHidden());
    assert.deepEqual(await page.evaluate(() => window.fixture.split.getSplitStateSnapshot(window.fixture.areaId)), before);
    assert.equal(await page.locator('.split-container').count(), 0);
    check('Creazione diretta, trascinamento, scorciatoie e riapertura dello split bloccati su mobile');

    await page.locator('#documents-open').click();
    await page.locator('.arc-navigation-sheet').waitFor();
    assert.equal(await page.locator('#documents-panel .document-row').count(), 2);
    assert.equal(await page.locator('#documents-panel').getByText(/Area affiancata|Affiancati/).count(), 0);
    assert((await page.locator('#documents-panel').textContent()).includes('1 documenti'));
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    await page.locator('#mobile-nav-dbs').click();
    await page.locator('#db-tree .coll > .node-label').first().click({ button: 'right' });
    assert(!/Affianca|Split-View/.test(await page.locator('#context-menu').textContent()));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    check('Schede e menu Database non propongono aree affiancate');

    await page.locator('#query-editor-input').fill('SELECT MODIFICA_MOBILE');
    await page.evaluate(async () => {
      const f = window.fixture;
      f.split.renderSplitView();
      await f.split.riprendiQueryPane({ paneId: f.split.getSplitStateSnapshot(f.areaId).panes[0][0] });
    });
    await page.setViewportSize({ width: 901, height: 900 });
    await page.waitForTimeout(100);
    assert(await page.locator('#workspace-split-btn').isVisible());
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#query-editor-input').inputValue(), 'SELECT MODIFICA_MOBILE');
    assert(await page.locator('#workspace-split-btn').isHidden());
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.fixture.coll.switchCollTab(window.fixture.areaId));
    await page.locator('.split-container').waitFor();
    assert.equal(await frame.locator('#query-editor-input').inputValue(), 'SELECT BOZZA_PANNELLO');
    assert.deepEqual(await page.evaluate(() => window.fixture.split.getSplitStateSnapshot(window.fixture.areaId)), before);
    await page.screenshot({ path: `${dir}/ripresa-desktop.png` });
    check('Soglia 900/901px e ritorno desktop: editor singolo e runtime affiancato conservano bozze distinte');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.getElementById('workspace').classList.contains('split-active'));
    await page.evaluate(async () => {
      const session = await import('/js/session-restore.js');
      session.persistSession();
      const key = Object.keys(sessionStorage).find(key => key.includes('session') && sessionStorage.getItem(key).includes('locale-split'));
      const saved = JSON.parse(sessionStorage.getItem(key));
      const tab = saved.tabs.find(t => t.id === 'locale-split');
      tab.id = 'ripristinata-mobile'; tab.connName = 'Ripristinata';
      tab.collTabs = tab.collTabs.filter(c => c.isSplitTab);
      const area = tab.collTabs[0]; area.id = 'area-ripristinata';
      area.splitSnap.splitCollTabId = area.id;
      for (const [, pane] of area.splitSnap.panes) pane.tabId = tab.id;
      tab.activeCollId = area.id;
      sessionStorage.setItem(key, JSON.stringify({ ...saved, activeId: tab.id, tabs: [tab] }));
      await session.restoreSession();
      window.fixture.restored = (await import('/js/tabs.js')).activeTab();
    });
    assert(await page.locator('#query-editor-input').isVisible());
    assert.equal(await page.locator('.split-container').count(), 0);
    const restored = await page.evaluate(() => {
      const f = window.fixture;
      return { single: f.coll.currentCollTab(), area: f.split.getSplitStateSnapshot('area-ripristinata') };
    });
    assert(restored.single.isDbTab && restored.single.db === 'vendite');
    assert.equal(restored.area.panes.length, before.panes.length);
    assert(restored.area.panes.some(([, p]) => p.query?.code === 'SELECT BOZZA_PANNELLO' && p.query.dirty));
    check('Ripristino mobile di una sessione con sole aree split: database singolo utilizzabile e bozze intatte');
    await page.evaluate(() => {
      const f = window.fixture;
      const area = f.split.getSplitStateSnapshot('area-ripristinata');
      for (const [, pane] of area.panes) pane.tabId = f.tab.id;
      f.split.restoreSplitStateSnapshot(area, 'area-ripristinata');
      f.restored.state.collTabs = f.restored.state.collTabs.filter(c => c.isSplitTab);
      f.restored.state.activeCollId = 'area-ripristinata';
      f.workspace.renderWorkspace();
    });
    assert(await page.locator('#placeholder').isVisible());
    assert.equal(await page.evaluate(() => window.fixture.coll.currentCollTab() || null), null);
    assert.equal(await page.evaluate(() => window.fixture.split.getSplitStateSnapshot('area-ripristinata').panes.length), before.panes.length);
    check('Area con soli pannelli di un’altra connessione: navigatore disponibile, nessun contesto errato e area conservata');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) { report.ok = false; report.failure = error.stack; console.error(error); process.exitCode = 1; }
  finally { fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.stop(); }
})();
