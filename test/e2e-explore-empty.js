'use strict';

// Icona reale e stati del workspace, con trasporto locale di prova.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = 'test-reports/esplora-dati-2026-10-12';
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3217 });
  const browser = await chromium.launch();
  const errors = [], layouts = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    if (mutant) await page.route('**/explore-data.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" id="explore-data" viewBox="0 0 192 152" />' }));
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'explore-demo' });
      tab.label = 'Connessione dimostrativa'; tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      const databases = [{ name: 'demo', collections: [{ name: 'ordini' }] }];
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases });
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(name, payload, cb) {
        cb?.({ ok: true, databases, collections: databases[0].collections, docs: [{ id: 1, nome: 'Esempio' }], skip: 0, limit: 50, total: 1, columns: ['id', 'nome'], fields: [], indexes: [] });
      } });
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
    });
    const placeholder = page.locator('#placeholder');
    await placeholder.waitFor({ state: 'visible' });
    const asset = await page.request.get(`${server.url}/explore-data.svg`);
    assert(asset.ok());
    await page.waitForTimeout(200);
    const glyph = await placeholder.locator('use').evaluate(el => { const b = el.getBBox(); return { width: b.width, height: b.height }; });
    assert(glyph.width > 140 && glyph.height > 100, 'L’icona esterna deve essere effettivamente disegnata');
    assert.equal(await placeholder.getByRole('heading', { name: 'Esplora i dati' }).count(), 1);
    assert.equal(await placeholder.locator('.explore-art').evaluate(el => el.getAnimations().length), 0, 'Il movimento ridotto evita l’ingresso animato');

    for (const theme of ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      for (const [width, height] of [[1440, 900], [390, 844], [320, 640], [844, 390]]) {
        await page.setViewportSize({ width, height });
        const layout = await placeholder.evaluate(el => {
          const p = el.getBoundingClientRect(), s = el.querySelector('section').getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
          return { inside: p.left >= 0 && p.right <= innerWidth && p.top >= parent.top && p.bottom <= parent.bottom + 1, scrollable: s.height <= el.clientHeight || getComputedStyle(el).overflowY === 'auto', overflow: el.scrollWidth > el.clientWidth, text: getComputedStyle(el.querySelector('p')).fontSize };
        });
        assert(layout.inside && layout.scrollable && !layout.overflow, `Composizione leggibile: ${theme} ${width}×${height}`);
        layouts.push({ theme, width, height, ...layout });
        if (!mutant) {
          await page.screenshot({ path: `${dir}/${theme}-${width}.png`, animations: 'disabled' });
          if (width === 1440) await placeholder.screenshot({ path: `${dir}/dettaglio-${theme}.png`, animations: 'disabled' });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => (await import('/js/colltabs.js')).openCollTab('demo', 'ordini'));
    await placeholder.waitFor({ state: 'hidden' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const motion = await page.evaluate(async () => {
      const tabs = await import('/js/colltabs.js');
      tabs.closeCollTab(tabs.currentCollTab().id);
      const icon = document.querySelector('#placeholder .explore-art');
      getComputedStyle(icon).animationName;
      return icon.getAnimations().map(a => a.effect.getTiming().iterations);
    });
    await placeholder.waitFor({ state: 'visible' });
    assert.deepEqual(motion, [1], 'La ricomparsa anima l’icona una volta, senza cicli continui');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await placeholder.locator('.explore-art').evaluate(el => el.getAnimations().length), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${dir}/checks.json`, JSON.stringify({ layouts, glyph, errors, motion }, null, 2));
    console.log('OK: icona SVG, 8 layout chiaro/scuro, apertura/chiusura tabella e movimento ridotto');
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
