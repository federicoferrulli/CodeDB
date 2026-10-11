'use strict';

// UI e controller reali; risposte isolate per pagine, conteggi e scroll continuo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const mutantCompact = process.argv.includes('--mutant-compact');
const mutantSheet = process.argv.includes('--mutant-sheet');
const dir = `test-reports/paginazione-2026-10-11/${mutant ? 'mutante' : mutantCompact ? 'mutante-compatto' : mutantSheet ? 'mutante-drawer' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3195 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(7000);
  const report = { checks: [], layouts: [], sheets: [], errors: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  const check = text => { report.checks.push(text); console.log('OK', text); };
  try {
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const grid = await import('/js/grid.js');
      const docs = (count, skip = 0) => Array.from({ length: count }, (_, i) => ({ id: skip + i + 1, nome: `Riga ${skip + i + 1}` }));
      const databases = [{ name: 'vendite', collections: [{ name: 'ordini' }] }];
      const tab = createTab({ id: 'paginazione' });
      tab.label = 'Locale'; tab.dbType = 'postgresql';
      Object.assign(tab.state, { connected: true, connLabel: 'Locale', dbType: 'postgresql', databases });
      tabs.activeId = tab.id;
      impostaSocket({ connected: true, on() {}, off() {}, emit(name, msg, cb) {
        const skip = Number(msg.skip) || 0, limit = Number(msg.limit) || 50;
        cb?.({ ok: true, databases, collections: databases[0].collections, docs: docs(Math.min(limit, Math.max(0, 123 - skip)), skip),
          skip, limit, total: 123, columns: ['id', 'nome'], fields: [], indexes: [] });
      } });
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('vendite', 'ordini');
      window.pagerFixture = (opts = {}) => {
        Object.assign(tab.state, { total: 123, countApprox: false, countTimedOut: false, countPending: false, skip: 0, limit: 50,
          infiniteScroll: false, pagerExpanded: true, docs: docs(50), columns: ['id', 'nome'], exhausted: false, ...opts });
        document.getElementById('page-size').value = String(tab.state.limit);
        grid.renderGrid();
      };
      window.pagerState = tab.state;
    });
    await page.waitForFunction(() => document.getElementById('page-info-text').textContent === '1–50');
    await page.getByRole('button', { name: 'Pagina successiva', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('page-info-text').textContent === '51–100');
    await page.getByRole('button', { name: 'Pagina successiva', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('page-info-text').textContent === '101–123');
    assert(await page.locator('#next-btn').isDisabled());
    await page.getByRole('button', { name: 'Pagina precedente', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('page-info-text').textContent === '51–100');
    await page.getByRole('combobox', { name: 'Righe per pagina o blocco', exact: true }).click();
    await page.getByRole('option', { name: '25', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('page-info-text').textContent === '1–25');
    await page.getByRole('checkbox', { name: 'Scroll continuo', exact: true }).click();
    await page.waitForFunction(() => window.pagerState.infiniteScroll);
    assert(await page.locator('#prev-btn').isDisabled() && await page.locator('#next-btn').isDisabled());
    await page.getByRole('checkbox', { name: 'Scroll continuo', exact: true }).click();
    await page.waitForFunction(() => !window.pagerState.infiniteScroll);
    check('Precedente/successiva, ultima pagina, Select Arc e scroll continuo conservano la navigazione');

    await page.evaluate(() => window.pagerFixture({ total: 3, docs: [{ id: 1 }, { id: 2 }, { id: 3 }], pagerExpanded: false }));
    assert(await page.locator('#pager').isHidden());
    assert(await page.locator('#infinite-toggle-label').isHidden());
    await page.locator('#pager-compact').press('Enter');
    assert(await page.locator('#pager').isVisible());
    assert(await page.locator('#page-info').evaluate(el => el === document.activeElement));
    await page.locator('#page-info').press('Space');
    assert(await page.locator('#pager').isHidden());
    assert(await page.locator('#pager-compact').evaluate(el => el === document.activeElement));
    check('Riepilogo ridotto e controlli espansi accessibili da tastiera, con focus conservato');

    await page.setViewportSize({ width: 390, height: 844 });
    if (mutantSheet) await page.addStyleTag({ content: '.arc-navigation-sheet { height: calc(360px + var(--sheet-extension)) !important; }' });
    await page.evaluate(() => { window.originalPagerControls = ['infinite-toggle', 'page-size'].map(id => document.getElementById(id)); });
    await page.getByRole('button', { name: 'Opzioni dei risultati', exact: true }).click();
    await page.locator('.arc-navigation-sheet').waitFor();
    assert(await page.getByRole('checkbox', { name: 'Scroll continuo', exact: true }).isVisible(), 'Le opzioni restano disponibili anche da riepilogo ridotto');
    const sheet = await page.locator('.arc-navigation-sheet').boundingBox();
    assert(844 - sheet.y <= 180, 'Il drawer segue il contenuto, senza occupare una quota fissa dello schermo');
    await page.locator('.arc-navigation-sheet').getByRole('button', { name: 'Chiudi', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert(await page.getByRole('combobox', { name: 'Righe per pagina o blocco', exact: true }).evaluate(el => el === document.activeElement), 'Il focus segue l’ordine visivo delle opzioni');
    await page.getByRole('combobox', { name: 'Righe per pagina o blocco', exact: true }).click();
    await page.getByRole('option', { name: '1000', exact: true }).click();
    await page.waitForFunction(() => window.pagerState.limit === 1000);
    await page.locator('.arc-navigation-sheet [role="listbox"]').waitFor({ state: 'detached' });
    await page.getByRole('checkbox', { name: 'Scroll continuo', exact: true }).waitFor();
    await page.getByRole('checkbox', { name: 'Scroll continuo', exact: true }).click();
    await page.waitForFunction(() => window.pagerState.infiniteScroll);
    await page.screenshot({ path: `${dir}/opzioni-mobile.png` });
    await page.getByRole('combobox', { name: 'Righe per pagina o blocco', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet [role="listbox"]').waitFor({ state: 'detached' });
    assert(await page.locator('.arc-navigation-sheet').isVisible(), 'Escape chiude prima il menu del Select');
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    assert(await page.locator('#pager-options-open').evaluate(el => document.activeElement === el));
    await page.getByRole('button', { name: 'Opzioni dei risultati', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: 'Scroll continuo', exact: true }).getAttribute('aria-checked'), 'true');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    assert(await page.getByRole('combobox', { name: 'Righe per pagina o blocco', exact: true }).isVisible());
    assert(await page.locator('#pager-options-open').isHidden());
    assert(await page.evaluate(() => window.originalPagerControls.every(node => node === document.getElementById(node.id) && node.closest('.statusbar'))));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Opzioni dei risultati', exact: true }).click();
    await page.evaluate(async () => (await import('/js/main.js')).setView('query'));
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    await page.evaluate(async () => (await import('/js/main.js')).setView('data'));
    check('Drawer Arc compatto: controlli originali, valori conservati, Escape annidato, focus e ripristino desktop/cambio vista');

    for (const theme of ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await page.locator('#pager-options-open').click();
        const drawer = page.locator('.arc-navigation-sheet');
        await drawer.waitFor();
        const layout = await drawer.evaluate(el => {
          const panel = el.querySelector('#pager-options').getBoundingClientRect();
          const labels = [...el.querySelectorAll('#pager-options > label')].map(node => node.getBoundingClientRect());
          const controls = [...el.querySelectorAll('button[role="checkbox"], button[role="combobox"], button[aria-label="Chiudi"]')].map(node => node.getBoundingClientRect());
          return { height: innerHeight - el.getBoundingClientRect().top, blank: innerHeight - panel.bottom,
            overlap: labels[0].left < labels[1].right && labels[0].right > labels[1].left && labels[0].top < labels[1].bottom && labels[0].bottom > labels[1].top,
            touch: controls.every(r => r.width >= 44 && r.height >= 44), overflow: panel.right > innerWidth || panel.left < 0 };
        });
        report.sheets.push({ theme, width, ...layout });
        assert(layout.height <= (width === 320 ? 230 : 180), `${width}: drawer troppo alto`);
        assert(layout.blank <= 12 && !layout.overlap && !layout.overflow && layout.touch, `${width}: opzioni compatte, senza sovrapposizioni e accessibili`);
        if (width <= 390) {
          const r = await drawer.boundingBox();
          await page.screenshot({ path: `${dir}/opzioni-${theme}-${width}.png`, clip: { x: r.x, y: r.y, width: r.width, height: height - r.y } });
        }
        await drawer.getByRole('button', { name: 'Chiudi', exact: true }).click();
        await drawer.waitFor({ state: 'detached' });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#pager-options-open').click();
    const heading = await page.getByRole('heading', { name: 'Opzioni dei risultati' }).boundingBox();
    await page.mouse.move(heading.x + 40, heading.y + 8);
    await page.mouse.down();
    await page.mouse.move(heading.x + 40, 842, { steps: 8 });
    await page.mouse.up();
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    check('Opzioni ad altezza naturale su 8 layout: controlli vicini, nessuno spazio vuoto e chiusura trascinando la testata');

    if (mutant) await page.addStyleTag({ content: '#page-info { width: 8px !important; flex: 0 1 8px !important; min-width: 0 !important; white-space: normal !important; overflow-wrap: anywhere !important; } #page-info-text { min-width: 0 !important; }' });
    if (mutantCompact) await page.addStyleTag({ content: '@media (max-width: 900px) { .statusbar { min-height: 102px !important; } }' });
    const inspect = async (theme, width, name) => {
      await page.locator('.statusbar').scrollIntoViewIfNeeded();
      const layout = await page.locator('.statusbar').evaluate(bar => {
        const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const visible = el => el && el.getClientRects().length && getComputedStyle(el).display !== 'none';
        const box = rect(bar);
        const controls = [...bar.querySelectorAll('#prev-btn, #next-btn, #page-info, [data-arc-component="select"], [role="checkbox"], #pager-compact, #pager-options-open')].filter(visible).map(el => ({ id: el.id || el.getAttribute('role'), ...rect(el) }));
        const groups = [...bar.querySelectorAll('.status-summary, #infinite-toggle-label, .pager-navigation, .pager-size')].filter(visible).map(rect);
        const overlaps = groups.some((a, i) => groups.slice(i + 1).some(b => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1));
        const text = bar.querySelector('#page-info-text');
        const range = document.createRange(); range.selectNodeContents(text);
        return { box, controls, overlaps, rangeLines: visible(text) ? range.getClientRects().length : 0,
          pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, footerOverflow: bar.scrollWidth > bar.clientWidth + 1,
          navTop: innerWidth <= 900 ? document.getElementById('mobile-bottom-nav').getBoundingClientRect().top : innerHeight };
      });
      assert(!layout.overlaps, `${width}/${name}: gruppi sovrapposti`);
      assert(!layout.pageOverflow && !layout.footerOverflow, `${width}/${name}: overflow`);
      assert(layout.rangeLines <= 1, `${width}/${name}: intervallo spezzato su ${layout.rangeLines} righe`);
      assert(layout.box.bottom <= layout.navTop + 1, `${width}/${name}: barra coperta dalla navigazione`);
      if (width <= 900) assert(layout.box.height <= 56, `${width}/${name}: footer compatto, altezza ${layout.box.height}px`);
      for (const r of layout.controls) {
        assert(r.x >= layout.box.x - 1 && r.right <= layout.box.right + 1, `${width}/${name}: ${r.id} fuori dalla barra`);
        if (width <= 900 || layout.box.width <= 600) assert(r.height >= 44 && (r.id !== 'page-info' || r.width >= 44), `${width}/${name}: bersaglio touch ${r.id}`);
      }
      report.layouts.push({ theme, width, name, ...layout });
    };
    const states = {
      piccolo: { total: 3, docs: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      pagine: {}, grande: { total: 9876543210, skip: 1234567890 },
      vuoto: { total: 0, docs: [], pagerExpanded: false },
    };
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      for (const width of [1440, 1024, 768, 390, 320, 844]) {
        await page.setViewportSize({ width, height: width === 844 ? 390 : 900 });
        for (const [name, opts] of Object.entries(states)) {
          await page.evaluate(opts => window.pagerFixture(opts), opts);
          await page.waitForTimeout(60);
          await inspect(theme, width, name);
          if ([1440, 390, 320].includes(width) && name === 'piccolo') await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
        }
      }
    }
    check('48 layout: temi chiaro/scuro, desktop/mobile/landscape, risultati piccoli, grandi e vuoti senza sovrapposizioni');
    for (const opts of [{ total: null }, { total: null, countTimedOut: true }, { total: 20, countApprox: true }]) {
      await page.evaluate(opts => window.pagerFixture(opts), opts);
      assert(await page.locator('#pager').isVisible());
      assert(await page.locator('#next-btn').isEnabled());
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Opzioni dei risultati', exact: true }).click();
    await page.getByRole('combobox', { name: 'Righe per pagina o blocco', exact: true }).click();
    const menu = await page.getByRole('listbox').boundingBox();
    assert(menu.x >= 0 && menu.x + menu.width <= 390 && menu.y >= 0 && menu.y + menu.height <= 844);
    await page.keyboard.press('Escape');
    check('Conteggi sconosciuti/stimati mantengono Avanti; il menu Arc resta nel viewport mobile');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) { report.ok = false; report.failure = error.stack;
    report.options = await page.locator('#pager-options').evaluate(el => el.outerHTML);
    await page.screenshot({ path: `${dir}/errore.png` }); console.error(error); process.exitCode = 1; }
  finally { fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.stop(); }
})();
