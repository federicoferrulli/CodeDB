'use strict';

// Percorso reale dal vuoto dopo la connessione alla tabella; soltanto il trasporto è simulato.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.env.EXPLORE_MUTANT;
const dir = `test-reports/mobile-esplora/${mutant || 'dopo'}`;

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const server = await startTestServer({ port: 3197 });
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[320, 740], [390, 844], [844, 430]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      const action = page.getByRole('button', { name: 'Apri schema database', exact: true });
      assert(await action.isHidden(), 'Nessun invito allo schema senza connessione');
      await page.evaluate(async () => {
        const { createTab, tabs } = await import('/js/tabs.js');
        const tab = createTab({ id: 'esplora-mobile' }); tabs.activeId = tab.id;
        tab.label = 'Connessione prova'; tab.dbType = 'mysql';
        const collections = [{ name: 'ordini', count: 1 }], databases = [{ name: 'vendite', collections }];
        Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: 'mysql', databases });
        const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(event, payload, ack) {
          ack?.({ ok: true, databases, collections, docs: [{ id: 1, nome: 'Ordine prova' }], total: 1, columns: ['id', 'nome'], fields: [], indexes: [], relazioni: [] });
        } };
        (await import('/js/socket.js')).impostaSocket(fake);
        (await import('/js/tabbar.js')).renderTabBar();
        (await import('/js/workspace.js')).renderWorkspace();
      });
      await action.waitFor();
      if (mutant === 'azione') await action.evaluate(el => el.addEventListener('click', event => event.stopImmediatePropagation(), true));
      if (mutant === 'testo') await page.locator('#placeholder p').evaluate(el => { el.textContent = 'Scegli una tabella dalla barra laterale.'; });
      assert.match(await page.locator('#placeholder').innerText(), /Database nella barra in basso/);
      assert.doesNotMatch(await page.locator('#placeholder').innerText(), /barra laterale/);
      const bounds = await action.boundingBox(), nav = await page.locator('#mobile-bottom-nav').boundingBox();
      assert(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= nav.y, `Azione visibile sopra la navigazione a ${width}px: ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: `${dir}/esplora-${width}.png` });
      await action.tap();
      await page.locator('.arc-navigation-sheet #db-tree').waitFor();
      assert.equal(await page.locator('#explore-schema-open').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
      assert(await action.evaluate(el => el === document.activeElement), 'La chiusura restituisce il focus al pulsante');
      await page.setViewportSize({ width: 1440, height: 900 });
      assert(await action.isHidden(), 'Il pulsante resta esclusivo della vista mobile');
      assert.match(await page.locator('#placeholder').innerText(), /barra laterale/);
      await page.setViewportSize({ width, height });
      await action.tap();
      await page.locator('#db-tree .coll .node-label[data-coll="ordini"]').tap();
      await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
      await page.locator('#workspace').waitFor();
      assert(await page.locator('#placeholder').isHidden(), 'Scegliere una tabella completa il percorso');
      await page.evaluate(async () => {
        (await import('/js/tabs.js')).activeTab().state.connected = false;
        (await import('/js/workspace.js')).renderWorkspace();
      });
      assert(await action.isHidden(), 'La disconnessione rimuove l’invito');
      assert.deepEqual(errors, []);
      console.log(`OK esplora ${width}x${height}: testo, schema, selezione, desktop e disconnessione`);
      await page.close();
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
