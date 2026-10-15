'use strict';

// Editor e controllori reali; il trasporto simulato rende riproducibili i tre dialetti.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/query-languages';
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3247 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true,
      versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    // Il primo caricamento comprende l'avvio dei moduli; i gesti restano a 8 s.
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'query-linguaggi' });
      tab.label = 'Verifica linguaggi'; tab.dbType = 'postgresql'; tabs.activeId = tab.id;
      const fields = [{ name: 'id', type: 'integer' }, { name: 'nome', type: 'text' }];
      const collections = [{ name: 'utenti', fields }];
      const databases = [{ name: 'laboratorio', collections }];
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases });
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        ack?.({ ok: true, databases, collections, fields, indexes: [], docs: [], total: 0,
          columns: fields.map(f => f.name), relazioni: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('laboratorio', 'utenti');
      (await import('/js/main.js')).setView('query');
      (await import('/js/query-tab.js')).resetQueryView();
    });
    const editor = page.locator('#query-editor-input');
    const lista = page.locator('.ac-flottante:not(.hidden)');
    for (const [dbms, testo, attesa] of [
      ['postgresql', 'SELECT JSONB_PATH_Q', 'JSONB_PATH_QUERY'],
      ['mysql', 'SELECT JSON_T', 'JSON_TABLE'],
      ['mongodb', 'db.utenti.aggregate([{ $dateT', '$dateTrunc'],
      ['mongodb', 'db.getCollection("utenti").agg', 'aggregate'],
      ['mongodb', 'db.utenti.find({}).so', 'sort'],
      ['mongodb', 'SELECT UPP', 'UPPER'],
      ['mongodb', 'SELECT ARRAY_POS', 'ARRAY_POSITION'],
      ['mongodb', 'SELECT INT4R', 'INT4RANGE'],
      ['mongodb', 'SELECT INT4MU', 'INT4MULTIRANGE'],
      ['mongodb', 'SELECT ARRAY_DI', 'ARRAY_DIMS'],
      ['mongodb', 'SELECT RANGE_AG', 'RANGE_AGG'],
      ['mongodb', 'SELECT RANGE_INTER', 'RANGE_INTERSECT_AGG'],
      ['mongodb', 'db.utenti.bul', 'bulkWrite'],
      ['mongodb', 'db.utenti.find({}).colla', 'collation'],
      ['mongodb', 'db.runC', 'runCommand'],
      ['mongodb', 'db.getMongo().start', 'startSession'],
      ['mongodb', 'const s=db.getMongo().startSession(); s.comm', 'commitTransaction'],
      ['mongodb', 'db.utenti.getInd', 'getIndexes'],
    ]) {
      await page.evaluate(async tipo => {
        const t = (await import('/js/tabs.js')).activeTab();
        t.dbType = tipo; t.state.dbType = tipo;
        document.getElementById('query-target-engine').value = 'auto';
      }, dbms);
      await editor.fill(testo);
      await editor.press('Control+Space');
      const voce = lista.locator('.ac-testo').filter({ hasText: new RegExp(`^${attesa.replace(/[$]/g, '\\$')}$`) });
      await voce.waitFor();
      assert(await voce.isVisible(), `${dbms}: ${attesa}`);
      await voce.click();
      assert((await editor.inputValue()).includes(attesa));
      console.log(`OK ${dbms}: ${attesa} inserito dal dropdown reale`);
    }
    await page.evaluate(async () => {
      const t = (await import('/js/tabs.js')).activeTab(); t.dbType = 'postgresql'; t.state.dbType = 'postgresql';
    });
    await editor.fill("select doc->>'nome', $1, 1e-9 from utenti");
    await editor.press('Escape');
    await editor.press('Control+Shift+F');
    assert.match(await editor.inputValue(), /^SELECT doc ->> 'nome', \$1, 1e-9\nFROM utenti$/);
    await editor.fill('SELECT JSONB_PATH_Q');
    await editor.press('Control+Space');
    await editor.press('ArrowDown');
    assert(await editor.getAttribute('aria-activedescendant'));
    assert.equal(await lista.locator('[aria-selected="true"]').count(), 1);
    await page.screenshot({ path: `${dir}/completamento-postgresql.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#query-schema-sidebar').waitFor({ state: 'hidden' });
    await editor.focus();
    await editor.press('Control+Space');
    await page.screenshot({ path: `${dir}/completamento-mobile.png` });
    const rect = await lista.boundingBox();
    assert(rect && rect.x >= 0 && rect.x + rect.width <= 391, 'Dropdown entro la finestra mobile');
    assert.deepEqual(errors, []);
    console.log('OK formattazione, tastiera accessibile e dropdown desktop/mobile; nessun errore JavaScript');
  } finally { await browser?.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
