'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { verificaTocchi, assertTocchi } = require('./mobile-hit-targets');
const dir = 'test-reports/mobile-schede';
const mutant = process.argv.includes('--mutant');

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const server = await startTestServer({ port: 3204 }), browser = await chromium.launch();
  try {
    for (const [width, height, theme] of [[390, 844, 'light'], [320, 740, 'dark'], [844, 390, 'dark']]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      try {
        await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
        await page.goto(server.url);
        await page.waitForSelector('html[data-arc-ready="true"]');
        await page.evaluate(async theme => {
          (await import('/js/theme.js')).scegliTema(theme);
          const { createTab, tabs } = await import('/js/tabs.js');
          const collections = ['ordini', 'clienti', 'archivio_2026_con_un_nome_molto_lungo'].map(name => ({ name }));
          const databases = [{ name: 'vendite', collections }];
          (await import('/js/socket.js')).impostaSocket({ on() {}, off() {}, emit(event, payload, cb) { cb?.({ ok: true, databases, collections, connections: [{ name: 'Produzione', label: 'localhost', dbType: 'mysql' }], docs: [{ id: 1, nome: 'Ada' }], columns: ['id', 'nome'], total: 1, fields: [], indexes: [] }); } });
          const other = createTab({ id: 'altro' }); other.label = 'Analisi'; other.dbType = 'postgresql';
          Object.assign(other.state, { connected: true, connLabel: other.label, dbType: 'postgresql', databases });
          const tab = createTab({ id: 'schede' }); tab.label = 'Produzione'; tab.dbType = 'mysql'; tabs.activeId = tab.id;
          Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: 'mysql', databases, expandedDbs: new Set(['vendite']) });
          (await import('/js/tabbar.js')).renderTabBar();
          (await import('/js/workspace.js')).renderWorkspace();
          const { openCollTab } = await import('/js/colltabs.js');
          for (const coll of collections) openCollTab('vendite', coll.name);
          tab.state.collTabs[0].snapQuery = { dirty: true, code: 'SELECT 1' };
          (await import('/js/connmanager.js')).loadSavedConnections();
        }, theme);
        const frames = [];
        for (const [trigger, panel, search, plus] of [
          ['mobile-nav-conns', 'conn-sidebar', 'conn-search', 'conn-add-btn'],
          ['mobile-nav-dbs', 'sidebar', 'db-search', 'new-db-btn'],
          ['documents-open', 'documents-panel', 'documents-search', 'documents-new-connection'],
        ]) {
          await page.locator(`#${trigger}`).tap();
          await page.waitForTimeout(220);
          if (mutant && panel === 'documents-panel') await page.addStyleTag({ content: '.arc-navigation-slot #navigator-tools { display: none !important; }' });
          await page.screenshot({ path: `${dir}/${width}-${panel}${mutant ? '-mutante' : ''}.png` });
          assert(await page.locator(`#${search}`).isVisible(), `${panel}: ricerca presente come negli altri drawer`);
          assert(await page.locator('.arc-navigation-sheet #conn-settings-btn').isVisible(), `${panel}: stesso footer Strumenti`);
          frames.push(await page.evaluate(({ panel, search, plus }) => {
            const p = document.getElementById(panel).getBoundingClientRect();
            const s = document.getElementById(search).getBoundingClientRect();
            const b = document.getElementById(plus).getBoundingClientRect();
            return { searchX: s.x - p.x, searchY: s.y - p.y, searchWidth: s.width, searchHeight: s.height, plusX: b.x - p.x, plusY: b.y - p.y, background: getComputedStyle(document.getElementById(panel)).backgroundColor };
          }, { panel, search, plus }));
        }
        for (const key of ['searchX', 'searchY', 'searchWidth', 'searchHeight', 'plusX', 'plusY']) assert(Math.abs(frames[0][key] - frames[2][key]) <= 2, `Allineamento ${key}: ${JSON.stringify(frames)}`);
        assert.equal(frames[2].background, frames[0].background, 'Schede usa la stessa superficie degli altri navigatori');
        assertTocchi(await verificaTocchi(page, page.locator('.arc-navigation-sheet'), 'Schede'));
        await page.locator('#documents-search').fill('archivio');
        assert.equal(await page.locator('.document-row:not(.document-connection)').count(), 1);
        assert.equal(await page.locator('.document-connection').count(), 1, 'La ricerca conserva il contesto della connessione');
        await page.locator('#documents-search').fill('inesistente');
        await page.getByRole('button', { name: 'Azzera ricerca', exact: true }).tap();
        assert.equal(await page.locator('#documents-search').inputValue(), '');
        assert.equal(await page.locator('.document-row:not(.document-connection)').count(), 3);
        assert(await page.locator('.document-dirty').isVisible(), 'La bozza resta segnalata');
        await page.locator('#documents-search').fill('clienti');
        await page.locator('.document-row > button:first-child').filter({ hasText: /^clienti/ }).tap();
        await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.coll), 'clienti');
        await page.locator('#documents-open').tap();
        assert.equal(await page.locator('#documents-search').inputValue(), '', 'Riaprire mostra tutte le schede');
        await page.locator('#documents-new-connection').tap();
        await page.locator('#connect-overlay [role="dialog"]').waitFor();
        await page.locator('#conn-cancel-btn').tap();
        await page.locator('#connect-overlay .arc-dialog-sheet').waitFor({ state: 'detached' });
        await page.locator('#documents-open').tap();
        await page.locator('#conn-settings-btn').tap();
        await page.getByRole('menuitem', { name: 'Scorciatoie da tastiera', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
        assert(await page.locator('#navigator #conn-settings-btn').isVisible(), 'Strumenti torna nel navigatore desktop');
        assert.deepEqual(errors, []);
        console.log(`OK ${width}×${height}: struttura comune, ricerca, stati, tocchi, selezione, +, Strumenti e ritorno desktop`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
