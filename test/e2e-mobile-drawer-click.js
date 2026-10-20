'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { verificaTocchi, assertTocchi } = require('./mobile-hit-targets');
const dir = 'test-reports/mobile-drawer-click';
const mutant = process.env.DRAWER_CLICK_MUTANT;

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const server = await startTestServer({ port: Number(process.env.DRAWER_PORT) || 3201 }), browser = await chromium.launch();
  const results = [], errors = [];
  try {
    for (const [width, height] of process.env.DRAWER_WIDTH ? [[Number(process.env.DRAWER_WIDTH), Number(process.env.DRAWER_HEIGHT) || 844]] : [[320, 740], [390, 844], [844, 390]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      page.on('pageerror', e => { errors.push(e.stack); console.error(`Errore JavaScript in ${phase}: ${e.stack}`); });
      let phase = '';
      const scan = async (name, selector = '.arc-navigation-sheet') => {
        phase = `${width}-${name}`;
        const root = page.locator(selector);
        await root.waitFor();
        await page.waitForTimeout(250);
        const scanned = await verificaTocchi(page, root, phase);
        results.push(...scanned);
        const failures = scanned.filter(r => r.points.some(p => !p.ok) || !r.clicked);
        console.log(`${failures.length ? 'FAIL' : 'OK'} ${phase}: ${scanned.length} controlli, ${failures.length} coperti`);
        if (failures.length) { console.log(JSON.stringify(failures)); await page.screenshot({ path: `${dir}/${phase}.png` }); }
      };
      const close = async () => {
        await page.locator('.arc-navigation-sheet').getByRole('button', { name: 'Chiudi', exact: true }).tap();
        await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
      };
      try {
        await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
        await page.goto(server.url);
        await page.waitForSelector('html[data-arc-ready="true"]');
        await page.evaluate(async () => {
          const fields = [{ name: 'id', pk: true, types: ['int'] }, { name: 'nome', types: ['varchar'] }, { name: 'cliente_id', types: ['int'] }];
          const collections = ['ordini', 'clienti', 'righe', 'prodotti', 'pagamenti', 'magazzino'].map(name => ({ name, fields, count: 8 }));
          const schema = { collections, relations: [{ from: 'ordini', to: 'clienti', field: 'cliente_id', toField: 'id', origine: 'vincolo' }], schemaPage: { complete: true } };
          const databases = [{ name: 'vendite', collections }];
          const connections = Array.from({ length: 6 }, (_, i) => ({ name: `Connessione ${i}`, label: 'localhost', dbType: 'mysql', folder: i < 3 ? 'Sviluppo' : '' }));
          (await import('/js/socket.js')).impostaSocket({ on() {}, off() {}, emit(event, payload, cb) {
            if (event === 'app:license') { cb?.({ ok: true, licenza: 'AGPL-3.0-only', dipendenze: [] }); return; }
            cb?.({ ok: true, ...schema, databases, connections, docs: [{ id: 1, nome: 'Ada', cliente_id: 2 }, { id: 2, nome: 'Bruna', cliente_id: 1 }], columns: ['id', 'nome', 'cliente_id'], total: 8, fields, indexes: [] });
          } });
          const { createTab, tabs } = await import('/js/tabs.js');
          const tab = createTab({ id: 'drawer-click' }); tabs.activeId = tab.id; tab.label = 'Connessione 0'; tab.dbType = 'mysql'; tab.connName = tab.label;
          Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: 'mysql', db: 'vendite', coll: 'ordini', databases, dbSchema: schema, dbSchemaFor: 'vendite', expandedDbs: new Set(['vendite']) });
          (await import('/js/tabbar.js')).renderTabBar();
          (await import('/js/workspace.js')).renderWorkspace();
          const { openCollTab } = await import('/js/colltabs.js');
          for (const name of ['clienti', 'prodotti', 'ordini']) openCollTab('vendite', name);
          (await import('/js/connmanager.js')).loadSavedConnections();
          window.__setView = (await import('/js/main.js')).setView;
          window.__uml = await import('/js/uml.js');
        });
        await page.locator('#mobile-nav-conns').tap();
        if (mutant === '1') await page.addStyleTag({ content: '.arc-navigation-slot .sidebar-title { z-index: auto !important; }' });
        await scan('connessioni');
        if (mutant === '1') assertTocchi(results);
        await page.locator('#conn-tree .node-actions').first().tap();
        await scan('menu-connessione', '#context-menu');
        await page.keyboard.press('Escape');
        await page.locator('#conn-settings-btn').tap();
        if (mutant === 'menu') await page.addStyleTag({ content: '[data-radix-menu-content] { max-height: none !important; overflow-y: visible !important; }' });
        await scan('strumenti', '[data-radix-menu-content]');
        if (mutant === 'menu') assertTocchi(results);
        for (const [label, id] of [['Esporta connessioni', 'connexport-overlay'], ['Informazioni & Licenza', 'about-overlay']]) {
          await page.getByRole('menuitem', { name: label, exact: true }).tap();
          await page.locator(`#${id} .arc-dialog-sheet`).waitFor();
          await page.locator(`#${id} .arc-dialog-sheet`).getByRole('button', { name: 'Chiudi finestra', exact: true }).tap();
          await page.locator(`#${id} .arc-dialog-sheet`).waitFor({ state: 'detached' });
          if (id === 'connexport-overlay') await page.locator('#conn-settings-btn').tap();
        }
        await page.locator('#mobile-nav-dbs').tap();
        await scan('database');
        await page.locator('#db-tree .db > .node-actions').first().tap();
        await scan('menu-database', '#context-menu');
        await page.keyboard.press('Escape');
        await page.locator('#db-tree .coll > .node-actions').first().tap();
        await scan('menu-tabella', '#context-menu');
        await page.keyboard.press('Escape');
        await page.locator('#documents-open').tap();
        await scan('schede');
        await page.locator('#documents-panel [data-document-id]').last().tap();
        await scan('menu-scheda', '#context-menu');
        await page.keyboard.press('Escape');
        await close();
        await page.evaluate(() => window.__setView('uml'));
        await page.waitForFunction(() => window.__uml.statoUml().tavola?.graph.getElements().length >= 2);
        await page.locator('#uml-mobile-catalogo').tap();
        await scan('uml-tabelle');
        await page.locator('#uml-cerca').fill('ordini');
        await page.locator('#uml-catalogo-lista [data-chiave]').tap();
        await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
        await page.locator('#uml-mobile-dettagli').tap();
        await scan('uml-dettagli');
        await page.locator('[data-isp="dati"]').tap();
        await page.locator('#uml-dati-corpo tr[data-riga]').first().tap();
        await page.locator('#uml-dati-dettaglio').tap();
        await scan('uml-dati');
        await close();
        await page.locator('#uml-mobile-strumenti').tap();
        await scan('uml-strumenti');
        await page.locator('#uml-esporta-btn').tap();
        await scan('uml-export', '#uml-esporta-menu');
        await page.keyboard.press('Escape'); await close();
        await page.evaluate(async () => {
          window.__setView('query');
          const history = await import('/js/qe-history.js');
          for (let i = 0; i < 8; i++) history.registraEsecuzione({ code: `SELECT ${i}, nome FROM ordini`, conn: 'Connessione 0', db: 'vendite', coll: 'ordini', dbType: 'mysql' });
        });
        await page.locator('#query-toggle-schema-btn').tap();
        await scan('schema-query', '#query-schema-sidebar');
        await page.keyboard.press('Escape');
        await page.locator('#query-editor-more-btn').tap();
        await page.locator('#qe-history-btn').tap();
        await scan('cronologia-query');
        await close();
        await page.evaluate(() => window.__setView('data'));
        await page.locator('#pager-options-open').tap();
        await scan('opzioni-risultati');
        await close();
        // I dialog sono tutti drawer su mobile: controlla anche i comandi del
        // modulo aperto, non soltanto quelli del navigatore sottostante.
        const ids = await page.locator('.overlay').evaluateAll(nodes => nodes.filter(n => n.querySelector('.modal')).map(n => n.id));
        for (const id of ids) {
          await page.evaluate(async id => (await import('/js/utils.js')).openModal(id), id);
          await scan(id, `#${id} .arc-dialog-sheet`);
          await page.evaluate(async id => (await import('/js/utils.js')).closeModal(id, { saved: true }), id);
          await page.locator(`#${id} .arc-dialog-sheet`).waitFor({ state: 'detached' });
        }
      } catch (error) { await page.screenshot({ path: `${dir}/${width}-interrotto.png` }); throw new Error(`${phase}: ${error.message}`, { cause: error }); }
      finally { await page.close(); }
    }
    assert.deepEqual(errors, [], 'Nessun errore JavaScript');
    assertTocchi(results);
  } finally { fs.writeFileSync(`${dir}/${mutant ? `mutante-${mutant}` : `report-${process.env.DRAWER_WIDTH || 'tutti'}`}.json`, JSON.stringify({ results, errors }, null, 2)); await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
