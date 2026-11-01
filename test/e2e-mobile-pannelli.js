'use strict';

// UI reale, trasporto isolato: riproduce i pannelli segnalati su smartphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { verificaTocchi, assertTocchi } = require('./mobile-hit-targets');
const width = Number(process.env.MOBILE_WIDTH) || 390, height = Number(process.env.MOBILE_HEIGHT) || 844;
const mutant = process.env.MOBILE_MUTANT;
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/mobile-pannelli'}/${width}-${height}${mutant ? `-${mutant}` : ''}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3196 });
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const scenario of ['menu', 'cronologia', 'grafo', 'fk']) {
      if (process.env.MOBILE_SCENARIO && process.env.MOBILE_SCENARIO !== scenario) continue;
      if (mutant && mutant !== scenario) continue;
      const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(30000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        // Controprove sul difetto, senza modificare i file di produzione.
        if (mutant === 'menu') await page.route('**/js/utils.js', async route => {
          const response = await route.fetch();
          const source = await response.text();
          await route.fulfill({ response, body: source.replace("if (!menu.matches(':popover-open')) menu.showPopover?.();", '') });
        });
        if (mutant === 'cronologia' || mutant === 'grafo') await page.route(`**/js/${mutant === 'cronologia' ? 'qe-history' : 'graph3d'}.js`, async route => {
          const response = await route.fetch();
          const source = await response.text();
          await route.fulfill({ response, body: source.replace("window.matchMedia('(max-width: 900px)')", "window.matchMedia('(max-width: 1px)')") });
        });
        await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
        await page.goto(server.url);
        await page.waitForSelector('html[data-arc-ready="true"]');
        await page.evaluate(async () => {
          const { createTab, tabs } = await import('/js/tabs.js');
          const tab = createTab({ id: 'mobile-pannelli' }); tabs.activeId = tab.id;
          const fields = Array.from({ length: 16 }, (_, i) => ({ name: `campo_${i}`, types: ['varchar'] }));
          const schema = { collections: [{ name: 'ordini', fields }, { name: 'clienti', fields }], relations: [{ from: 'ordini', to: 'clienti', field: 'cliente_id' }], schemaPage: { complete: true } };
          Object.assign(tab.state, { connected: true, dbType: 'mysql', db: 'vendite', coll: 'ordini', dbSchema: schema, dbSchemaFor: 'vendite' });
          window.__writes = [];
          const fake = { on() {}, off() {}, emit(event, payload, cb) {
            if (event === 'doc:update') window.__writes.push(payload);
            cb?.({ ok: true, ...schema, docs: [{ id: 1, nome: 'Ada' }, { id: 2, nome: 'Bruna' }], columns: ['id', 'nome'], total: 2 });
          } };
          (await import('/js/socket.js')).impostaSocket(fake);
          for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
          for (const id of ['tab-body', 'workspace']) document.getElementById(id).classList.remove('hidden');
          window.__setView = (await import('/js/main.js')).setView;
        });
        if (scenario === 'menu') {
          await page.evaluate(() => window.__setView('uml'));
          await page.locator('#uml-mobile-strumenti').tap();
          await page.locator('#uml-esporta-btn').tap();
          const geometry = await page.locator('#uml-esporta-menu').evaluate(el => {
            const r = el.getBoundingClientRect(), b = document.getElementById('uml-esporta-btn').getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, gap: Math.min(Math.abs(r.top - b.bottom), Math.abs(b.top - r.bottom)) };
          });
          assert(geometry.top >= 0 && geometry.bottom <= height + 1 && geometry.left >= 0 && geometry.right <= width && geometry.gap <= 12, `Menu adiacente e interamente visibile: ${JSON.stringify(geometry)}`);
          await page.screenshot({ path: `${dir}/menu-aperto.png` });
          await page.keyboard.press('Escape');
          assert(await page.locator('#uml-esporta-menu').isHidden());
          assert(await page.locator('#uml-esporta-btn').evaluate(el => el === document.activeElement));
          assert(await page.locator('.arc-navigation-sheet').isVisible(), 'Escape chiude prima il menu');
          await page.evaluate(async () => {
            window.__contextSelected = false;
            (await import('/js/utils.js')).showContextMenu(24, 180, [{ label: 'Prova menu contestuale', action: () => { window.__contextSelected = true; } }]);
          });
          await page.getByRole('menuitem', { name: 'Prova menu contestuale' }).tap();
          assert(await page.evaluate(() => window.__contextSelected), 'Il menu contestuale resta utilizzabile nel drawer');
        }
        if (scenario === 'cronologia') {
          await page.evaluate(async () => {
            window.__setView('query');
            const history = await import('/js/qe-history.js');
            for (let i = 0; i < 12; i++) history.registraEsecuzione({ code: `SELECT ${i}, nome FROM ordini WHERE descrizione = 'Una query lunga da leggere su telefono'`, conn: 'Connessione di prova', db: 'vendite', coll: 'ordini', dbType: 'mysql' });
          });
          await page.locator('#query-editor-more-btn').tap();
          await page.locator('#qe-history-btn').tap();
          const geometry = await page.locator('#qe-history-panel').evaluate(el => {
            const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflow: el.scrollWidth - el.clientWidth };
          });
          assert(geometry.left >= 0 && geometry.right <= width && geometry.bottom <= height + 1 && geometry.overflow <= 1, `Cronologia contenuta nel telefono: ${JSON.stringify(geometry)}`);
          await page.screenshot({ path: `${dir}/cronologia-aperta.png` });
          await page.locator('#qe-history-conn').locator('xpath=following-sibling::*[1]').getByRole('combobox').tap();
          await page.getByRole('option', { name: 'Connessione di prova', exact: true }).tap();
          await page.locator('#qe-history-search').fill('SELECT 10,');
          assert.equal(await page.locator('#qe-history-list .query-history-item').count(), 1);
          await page.locator('#qe-history-list .query-history-text').tap();
          assert((await page.locator('#query-editor-input').inputValue()).startsWith('SELECT 10,'));
        }
        if (scenario === 'grafo') {
          await page.evaluate(async () => {
            let data, click;
            const controls = { target: { x: 0, y: 0, z: 0 }, addEventListener() {} };
            const graph = new Proxy(() => {}, { get(_, key) {
              if (key === 'then' || typeof key === 'symbol') return undefined;
              if (key === 'controls') return () => controls;
              if (key === 'graphData') return value => value ? (data = value, graph) : data;
              if (key === 'cameraPosition') return value => value ? graph : { x: 0, y: 0, z: 300 };
              if (key === 'onNodeClick') return value => { click = value; return graph; };
              if (key === 'nodeColor' || key === 'linkWidth') return value => value ? graph : () => 1;
              return () => graph;
            } });
            window.ForceGraph3D = () => () => graph;
            window.__setView('graph3d');
            (await import('/js/graph3d.js')).renderGraph3d();
            window.__selectNode = () => click({ ...data.nodes[0], x: 0, y: 0, z: 0 });
            window.__selectNode();
          });
          assert(await page.locator('#graph3d-side-panel').isHidden(), 'Il tocco sul nodo lascia libero il grafo');
          await page.locator('#graph3d-details-toggle').tap();
          assert(await page.locator('#graph3d-panel-content').isVisible());
          const expand = page.getByRole('button', { name: 'Espandi pannello', exact: true });
          if (await expand.count()) await expand.tap();
          await page.waitForFunction(() => document.querySelector('.arc-navigation-sheet').getBoundingClientRect().top < innerHeight * .07);
          const headerVisible = await page.locator('.arc-navigation-sheet').evaluate(sheet => {
            const title = [...sheet.querySelectorAll('h2')].find(el => el.textContent === 'Dettagli della selezione');
            const rect = title.getBoundingClientRect();
            return sheet.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
          });
          assert(headerVisible, 'La toolbar del grafo non deve coprire la testata del drawer espanso');
          const toolbarCovered = await page.locator('.arc-navigation-sheet').evaluate(sheet => {
            const toolbar = document.querySelector('.graph3d-bar');
            const a = sheet.getBoundingClientRect(), b = toolbar.getBoundingClientRect();
            const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
            const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
            // Radix disabilita i tocchi sullo sfondo, ma questo non impedisce che venga dipinto sopra.
            const previous = toolbar.style.pointerEvents;
            toolbar.style.pointerEvents = 'auto';
            const covered = top >= bottom || left >= right || sheet.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
            toolbar.style.pointerEvents = previous;
            return covered;
          });
          assert(toolbarCovered, 'I comandi del grafo devono restare sotto il drawer, anche fuori dalla testata');
          assertTocchi(await verificaTocchi(page, page.locator('.arc-navigation-sheet'), 'Dettagli grafo'));
          await page.screenshot({ path: `${dir}/grafo-dettagli.png` });
          await page.keyboard.press('Escape');
          await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
          assert(await page.locator('#graph3d-details-toggle').isVisible(), 'La selezione resta riapribile');
          const handle = await page.locator('#graph3d-details-toggle').boundingBox();
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + 20 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y - 40 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.locator('.arc-navigation-sheet').waitFor();
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
          assert(await page.locator('#graph3d-side-panel').isVisible(), 'I dettagli tornano laterali sul desktop');
        }
        if (scenario === 'fk') {
          await page.evaluate(async ({ width, height }) => {
            window.__setView('data');
            const table = document.createElement('table');
            table.style.cssText = `position:fixed;top:${Math.min(280, height / 2)}px;left:8px;width:${width - 16}px;z-index:70`;
            table.innerHTML = '<tbody><tr><td>1</td></tr></tbody>';
            document.getElementById('view-data').append(table);
            const td = table.querySelector('td');
            const ctx = { tabId: (await import('/js/tabs.js')).tabs.activeId, db: 'vendite', coll: 'ordini', isStillActive: () => true };
            (await import('/js/inlineEdit.js')).startEdit(td, { id: 7, cliente_id: 1 }, 'cliente_id', { ctx, relazione: { campo: 'cliente_id', db: 'vendite', tabella: 'clienti', colonna: 'id', origine: 'vincolo' }, onRender: () => table.remove() });
          }, { width, height });
          await page.locator('.fk-apri-btn').tap();
          await page.locator('#fk-pannello.aperto').waitFor();
          if (mutant === 'fk') await page.locator('.inline-edit-actions').evaluate(el => { el.style.display = 'flex'; el.showPopover(); });
          const overlap = await page.locator('.inline-edit-actions').evaluate(el => {
            if (!el.getClientRects().length) return false;
            const a = el.getBoundingClientRect(), b = document.getElementById('fk-pannello').getBoundingClientRect();
            return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          });
          assert(!overlap, 'Applica/Annulla non coprono il selettore FK');
          assertTocchi(await verificaTocchi(page, page.locator('#fk-pannello'), 'Riferimento FK'));
          await page.screenshot({ path: `${dir}/fk-aperta.png` });
          await page.locator('#fk-close').tap();
          assert(await page.locator('.inline-edit-actions').isVisible(), 'I comandi della cella tornano alla chiusura');
          await page.locator('.fk-apri-btn').tap();
          await page.locator('.fk-voce').filter({ hasText: 'Bruna' }).tap();
          await page.locator('#fk-usa').tap();
          await page.waitForFunction(() => window.__writes.length === 1);
          const writes = await page.evaluate(() => window.__writes);
          assert.equal(writes[0].set.cliente_id, 2);
          assert.equal(writes[0].coll, 'ordini');
        }
        assert.deepEqual(errors, [], 'Nessun errore JavaScript');
        await page.screenshot({ path: `${dir}/${scenario}.png` });
        console.log(`OK ${scenario}`);
      } catch (error) {
        failures.push(`${scenario}: ${error.message}`);
        console.error(`FAIL ${scenario}: ${error.message}`);
        await page.screenshot({ path: `${dir}/${scenario}-errore.png` });
      } finally { await page.close(); }
    }
    assert.deepEqual(failures, []);
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
