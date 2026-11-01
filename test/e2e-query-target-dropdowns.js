'use strict';

// Lista Arc reale dentro un popover nativo; soli metadati e connessioni simulati.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/query-target-dropdowns';

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const server = await startTestServer({ port: 3233 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: process.argv.includes('--motion') ? 'no-preference' : 'reduce', serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.addInitScript(version => {
      localStorage.setItem('codedb:tema', 'dark');
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const [{ createTab, tabs }, { impostaSocket }, workspace, colls, main] = await Promise.all(['tabs', 'socket', 'workspace', 'colltabs', 'main'].map(n => import(`/js/${n}.js`)));
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (n, p, cb) => fake.emit(n, p, r => cb(null, r)) }; }, emit(name, p, cb) {
        cb?.({ ok: true, databases: [{ name: 'public' }, { name: 'inventario' }], collections: [], schema: [], fields: [], docs: [], columns: [], indexes: [], total: 0 });
      } };
      impostaSocket(fake);
      for (const engine of ['mongodb', 'mysql', 'postgresql']) {
        const tab = createTab({ id: engine }); tab.dbType = engine; tab.label = `Sviluppo ${engine}`;
        Object.assign(tab.state, { connected: true, dbType: engine, db: 'public', databases: [{ name: 'public' }, { name: 'inventario' }] });
      }
      tabs.activeId = 'mongodb'; workspace.renderWorkspace(); colls.openDbTab('public'); main.setView('query');
    });
    const menu = page.locator('#query-target-menu');
    const popup = page.locator('[data-arc-select-popup]');
    const openMenu = async () => { if (!await menu.isVisible()) await page.locator('#query-target-btn').click(); };
    let layout = '1280';
    const open = async id => {
      await openMenu();
      await page.locator(`[data-arc-for="${id}"] [role="combobox"]`).click();
      await popup.waitFor({ state: 'visible' });
      await page.waitForTimeout(150);
      const result = await popup.evaluate(el => {
        const r = el.getBoundingClientRect();
        const viewport = (el.querySelector('[data-radix-select-viewport]') || el).getBoundingClientRect();
        const options = [...el.querySelectorAll('[role="option"]')].map(option => {
          const a = option.getBoundingClientRect();
          const top = Math.max(a.top, viewport.top), bottom = Math.min(a.bottom, viewport.bottom);
          const visible = a.width > 0 && bottom > top;
          const hit = visible ? document.elementFromPoint(a.left + a.width / 2, (top + bottom) / 2) : null;
          return { text: option.textContent, visible, painted: !!hit && option.contains(hit), hit: hit?.tagName + '.' + hit?.className };
        });
        const layers = [];
        for (let node = el; node; node = node.parentElement) {
          const css = getComputedStyle(node);
          layers.push({ tag: node.tagName, opacity: css.opacity, visibility: css.visibility, z: css.zIndex });
        }
        return { options, layers, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, inside: el.scrollWidth <= el.clientWidth + 1 };
      });
      await page.screenshot({ path: `${dir}/${id}-${layout}.png` });
      const r = result.rect, clip = { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
      const shown = await page.screenshot({ clip, animations: 'disabled' });
      const opacity = await popup.evaluate(el => {
        const previous = [el.style.getPropertyValue('opacity'), el.style.getPropertyPriority('opacity')];
        el.style.setProperty('opacity', '0', 'important'); return previous;
      });
      const masked = await page.screenshot({ clip, animations: 'disabled' });
      await popup.evaluate((el, [value, priority]) => value ? el.style.setProperty('opacity', value, priority) : el.style.removeProperty('opacity'), opacity);
      assert(!shown.equals(masked), `${id}: la lista esiste nel DOM ma non viene dipinta ${JSON.stringify(result)}`);
      assert(result.options.some(o => o.visible) && result.options.filter(o => o.visible).every(o => o.painted), `${id}: opzioni visibili e cliccabili ${JSON.stringify(result)}`);
      assert(result.inside);
    };
    for (const [width, height] of [[1280, 900], [390, 844], [844, 390]]) {
      layout = String(width); await page.setViewportSize({ width, height });
      await page.evaluate(width => document.documentElement.setAttribute('data-theme', width === 390 ? 'light' : 'dark'), width);
      await open('query-target-engine');
      await page.getByRole('option', { name: 'Cross-DB (Virtual JOIN)', exact: true }).click();
      assert.equal(await page.locator('#query-target-engine').inputValue(), 'crossdb');
      assert.equal(await page.locator('[id^="query-native-"]').count(), 0, 'Nessun campo della copia SQL rimasto nel menu');
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    console.log('OK: motore visibile e selezionabile in tre layout; copia su SQL nativo rimossa, nessun errore JavaScript.');
  } finally { await browser.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
