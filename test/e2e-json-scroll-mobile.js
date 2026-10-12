'use strict';

// Gesti touch sul renderer reale; connessione simulata, nessun database coinvolto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `test-reports/json-scroll-mobile/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3246 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.stack));
  try {
    if (mutant) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch(), source = await response.text();
      // Ripristina il difetto: stacca anche le righe rimaste visibili e rifocalizza.
      const body = source.replace('queryJsonWindow?.prima || creaSpazio()', 'creaSpazio()')
        .replace('queryJsonWindow?.dopo || creaSpazio()', `creaSpazio();
  const focus = container.contains(document.activeElement) ? document.activeElement : null;
  const frammento = document.createDocumentFragment(); frammento.appendChild(prima)`)
        .replace('nodi.set(riga, nodo);', 'nodi.set(riga, nodo); frammento.appendChild(nodo);')
        .replace(/  \/\/ Come nella griglia,[\s\S]*?  queryJsonNodes = nodi;/, `  prima.style.height = \`\${spazioSopra}px\`;
  dopo.style.height = \`\${spazioSotto}px\`;
  frammento.appendChild(dopo); container.replaceChildren(frammento);
  if (focus?.isConnected) focus.focus({ preventScroll: true });
  queryJsonNodes = nodi;`);
      assert.notEqual(body, source);
      await route.fulfill({ response, body });
    });
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'json-scroll-fixture' });
      tab.label = 'MongoDB'; tab.dbType = 'mongodb'; tabs.activeId = tab.id;
      const collections = [{ name: 'bevande' }], databases = [{ name: 'prova', collections }];
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases });
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        ack?.({ ok: true, databases, collections, connections: [], fields: [], columns: [], indexes: [], docs: [], total: 0, relazioni: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('prova', 'bevande');
      (await import('/js/main.js')).setView('query');
      window.query = await import('/js/query-tab.js');
      window.righeJson = Array.from({ length: 250 }, (_, id) => ({ id, name: `Bevanda ${id}`, createdAt: { $date: '2026-06-04T22:37:01.637Z' }, deletedAt: null,
        deletedBy: null, deletionReason: null, hydrationMultiplier: 0.8, icon: 'coffee', isDeleted: false, isSystem: true, updatedAt: { $date: '2026-06-04T22:37:01.637Z' }, note: 'Dettagli' }));
      query.renderResults(righeJson);
    });
    await page.locator('#res-mode-json').tap();
    await page.locator('[data-json-index="1"] [role="button"]').tap();
    const view = page.locator('#query-json-view');
    const positions = await view.evaluate(async view => {
      const result = [];
      for (let i = 0; i < 12; i++) {
        view.scrollTop += 65;
        const requested = view.scrollTop;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        result.push({ requested, actual: view.scrollTop, height: view.scrollHeight });
      }
      return result;
    });
    for (const p of positions) assert(Math.abs(p.actual - p.requested) <= 1, `Lo scroll non deve tornare indietro al ridisegno: ${JSON.stringify(p)}`);
    await view.evaluate(async el => { el.scrollTop = 200; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    const cdp = await page.context().newCDPSession(page);
    const swipe = async () => {
      const rect = await view.boundingBox();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height - 20;
      const before = await view.evaluate(el => el.scrollTop);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * Math.min(14, (rect.height - 40) / 10) }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(350);
      const after = await view.evaluate(el => el.scrollTop);
      assert(after > before + 30, `Il gesto verso il basso deve avanzare: ${before} → ${after}`);
    };
    await swipe();
    for (const count of [5, 10, 15, 20, 30]) {
      await page.evaluate(count => query.renderResults(righeJson.slice(0, count)), count);
      await page.locator('[data-json-index="1"] [role="button"]').tap();
      const short = await view.evaluate(async view => {
        const result = [];
        for (let i = 0; i < 20; i++) {
          view.scrollTop += 25;
          const requested = view.scrollTop;
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          result.push({ requested, actual: view.scrollTop, height: view.scrollHeight });
        }
        return result;
      });
      for (const p of short) assert(Math.abs(p.actual - p.requested) <= 1, `Elenco ${count}, salto: ${JSON.stringify(p)}`);
    }
    // Attraversa col dito la soglia che azzerava lo scroll, su due larghezze mobili.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => query.renderResults(righeJson.slice(0, 10)));
      const first = page.locator('[data-json-index="1"] [role="button"]');
      await first.tap();
      await first.focus();
      await page.evaluate(() => {
        window.jsonFocusEvents = 0;
        document.querySelector('[data-json-index="1"] [role="button"]').addEventListener('focus', () => jsonFocusEvents++);
      });
      await view.evaluate(async el => { el.scrollTop = 150; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
      assert.equal(await page.evaluate(() => jsonFocusEvents), 0, 'Lo scroll non stacca e rifocalizza la riga attiva');
      await swipe();
      const top = await view.evaluate(el => el.scrollTop);
      await page.locator('#res-mode-table').tap();
      await page.locator('#res-mode-json').tap();
      assert.equal(await view.evaluate(el => el.scrollTop), top, 'Il ritorno alla vista JSON conserva lo scroll');
    }
    await page.screenshot({ path: `${dir}/scorrimento.png` });
    assert.deepEqual(errors, []);
    console.log('OK: JSON Tree mobile 320/390px, elenchi brevi/lunghi, focus stabile, gesti touch e cambio vista senza ritorno verso l’alto.');
  } catch (e) { await page.screenshot({ path: `${dir}/failure.png` }); throw e; }
  finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
