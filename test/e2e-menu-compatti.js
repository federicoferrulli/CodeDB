'use strict';

// Menu veri e risposte simulate: nessuna scrittura nei database utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3220 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const dir = 'test-reports/menu-compatti';
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (process.argv.includes('--mutant')) await page.route('**/css/arc-theme.css', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + '\n.context-menu li[role="menuitem"] { min-height: 48px; }' });
    });
    if (process.argv.includes('--mutant-checkbox')) await page.route('**/css/arc-theme.css', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + '\n#polling-toggle [role="checkbox"] { min-height: 34px !important; height: 34px !important; width: 34px !important; }' });
    });
    await page.addInitScript(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
      localStorage.setItem('codedb:tema', 'dark');
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { state } = await import('/js/state.js');
      const { impostaSocket } = await import('/js/socket.js');
      const tab = createTab({ id: 'menu-compatti', connName: 'PostgreSQL locale' });
      tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      Object.assign(state, { connected: true, dbType: 'postgresql', db: 'diego', coll: 'prodotti', docs: [], columns: [], pollingShown: true });
      window.menuEvents = [];
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (n, p, cb) => fake.emit(n, p, r => cb(null, r)) }; }, emit(name, payload, cb) {
        menuEvents.push(name); cb?.({ ok: true, databases: [], collections: [], operations: [] });
      } };
      impostaSocket(fake);
      for (const id of ['tab-body', 'workspace', 'view-data']) document.getElementById(id).classList.remove('hidden');
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
    });
    const context = page.locator('#context-menu');
    const openSidebar = async () => {
      await page.evaluate(() => document.getElementById('sidebar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 112, clientY: 92 })));
      await context.waitFor({ state: 'visible' });
    };
    const rows = async (locator, height) => {
      const sizes = await locator.evaluateAll(nodes => nodes.map(el => ({ height: el.getBoundingClientRect().height, size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight })));
      assert(sizes.length > 0);
      assert(sizes.every(s => s.height >= height && s.height < height + 1 && s.size === '13px' && s.weight === '400'), JSON.stringify(sizes));
    };
    const fits = async locator => {
      const bounds = await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scroll: el.scrollWidth, client: el.clientWidth, width: innerWidth, height: innerHeight, style: el.style.cssText, viewport: { width: visualViewport.width, left: visualViewport.offsetLeft }, text: el.textContent };
      });
      assert(bounds.scroll <= bounds.client + 1 && bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.top >= 0 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds));
    };

    await openSidebar();
    await rows(context.getByRole('menuitem'), 28);
    assert.deepEqual(await context.getByRole('menuitem').allTextContents(), ['Nuovo schema…', 'Importa schema…', 'Aggiorna elenco']);
    assert.equal(await context.locator('svg.menu-icona').count(), 3);
    const lefts = await context.locator('.menu-label').evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().left));
    assert(lefts.every(x => x === lefts[0]), 'Testi allineati dopo la colonna icone');
    assert((await context.boundingBox()).width < 210, 'Il menu breve usa meno spazio');
    await fits(context);
    await context.screenshot({ path: `${dir}/schema-scuro.png` });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#dbimport-overlay[data-arc-dialog="open"]');
    await page.locator('#dbimport-cancel').click();
    await page.waitForSelector('#dbimport-overlay[data-arc-dialog="open"]', { state: 'hidden' });
    await openSidebar();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert(await page.evaluate(() => menuEvents.includes('db:list')), 'Aggiorna elenco chiama il callback originale');

    await page.evaluate(() => {
      document.getElementById('polling-toggle').classList.remove('hidden');
      window.pollingChanges = 0;
      document.getElementById('polling-checkbox').addEventListener('change', () => pollingChanges++);
    });
    await page.locator('#data-more-btn').click();
    const toolbar = page.locator('#data-more-menu');
    await toolbar.waitFor({ state: 'visible' });
    await rows(toolbar.locator('.dropdown-item:not(.hidden)'), 28);
    const polling = toolbar.getByRole('checkbox', { name: 'Aggiornamento automatico ogni 5 secondi' });
    const box = await polling.boundingBox();
    assert.equal(box.width, 16); assert.equal(box.height, 16);
    await toolbar.locator('#polling-toggle .menu-label').click();
    await page.waitForFunction(() => document.querySelector('#polling-toggle [role="checkbox"]').getAttribute('aria-checked') === 'true');
    assert(await page.evaluate(async () => !!(await import('/js/state.js')).state.pollingInterval));
    assert(await toolbar.isVisible(), 'La spunta non chiude il menu');
    assert(await toolbar.locator('#delete-all-btn').isDisabled());
    await fits(toolbar);
    await toolbar.screenshot({ path: `${dir}/toolbar-scuro.png` });
    await polling.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('#polling-toggle [role="checkbox"]').getAttribute('aria-checked') === 'false');
    assert(!await page.evaluate(async () => !!(await import('/js/state.js')).state.pollingInterval));
    assert.equal(await page.evaluate(() => pollingChanges), 2, 'Ogni gesto commuta la spunta una sola volta');
    assert(await toolbar.isVisible());
    await page.keyboard.press('Escape');
    assert(await toolbar.isHidden());
    await page.locator('#conn-settings-btn').focus();
    await page.keyboard.press('Enter');
    const settings = page.locator('[role="menu"][data-state="open"]');
    await settings.waitFor({ state: 'visible' });
    await rows(settings.getByRole('menuitem'), 28);
    await fits(settings);
    await settings.screenshot({ path: `${dir}/strumenti-scuro.png` });
    await settings.getByRole('menuitem', { name: 'Tema', exact: true }).click();
    await page.waitForSelector('#modal-theme[data-arc-dialog="open"]');
    await page.keyboard.press('Escape');

    // Testo lungo, voce disabilitata e voce senza icona nello stesso menu.
    await page.evaluate(async () => {
      (await import('/js/utils.js')).showContextMenu(1400, 850, [
        { icona: 'copy', label: 'Copia nome completo', action() {} },
        '---', { label: 'Schema_' + 'x'.repeat(180), disabled: true },
        { icona: 'trash-2', label: 'Elimina…', danger: true, action() {} },
      ]);
    });
    await fits(context);
    assert.equal(await context.getByRole('menuitem').nth(1).getAttribute('aria-disabled'), 'true');
    assert(await context.getByRole('menuitem').nth(1).evaluate(el => el.getBoundingClientRect().height > 28));
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await openSidebar();
    await rows(context.getByRole('menuitem'), 44);
    await fits(context);
    await context.screenshot({ path: `${dir}/schema-mobile-chiaro.png` });
    await page.keyboard.press('Escape');
    await page.locator('#data-more-btn').click();
    await toolbar.waitFor({ state: 'visible' });
    await rows(toolbar.locator('.dropdown-item:not(.hidden)'), 44);
    await fits(toolbar);
    await toolbar.screenshot({ path: `${dir}/toolbar-mobile-chiaro.png` });
    await page.keyboard.press('Escape');
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-settings-btn').click();
    await settings.waitFor({ state: 'visible' });
    await rows(settings.getByRole('menuitem'), 44);
    await fits(settings);
    await settings.screenshot({ path: `${dir}/strumenti-mobile-chiaro.png` });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 480 });
    await openSidebar();
    await fits(context);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log('  OK menu: densità desktop/touch, icone e nomi accessibili, tastiera, callback reali, tre famiglie di menu, testi lunghi, chiaro/scuro, viewport 320/390/1440');
  } finally { await browser.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
