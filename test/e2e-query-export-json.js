'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3247 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true,
    })), require('../package.json').version);
    if (process.argv.includes('--mutant')) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const original = 'content = serializzaJsonStandard(rows);';
      assert(source.includes(original), 'La mutazione deve colpire la serializzazione reale');
      await route.fulfill({ response, body: source.replace(original, 'content = JSON.stringify(rows, null, 2);') });
    });
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('html[data-arc-ready="true"]');
    const originalRows = [{
      _id: { $oid: '507f1f77bcf86cd799439011' },
      dettagli: { date: [{ $date: '2026-10-15T12:00:00.000Z' }] },
      intero: { $numberLong: '9223372036854775807' },
      decimale: { $numberDecimal: '12345678901234567890.1234' },
    }];
    await page.evaluate(async rows => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'export-json-fixture' });
      tab.label = 'Export JSON'; tab.dbType = 'mongodb'; tabs.activeId = tab.id;
      const databases = [{ name: 'prova', collections: [{ name: 'clienti', fields: [] }] }];
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases });
      const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(name, payload, ack) {
        if (name === 'query:execute') {
          ack({ ok: true, data: rows, columns: Object.keys(rows[0]) });
          return;
        }
        ack?.({ ok: true, databases, collections: databases[0].collections, fields: [], indexes: [], docs: [], total: 0, columns: [], relazioni: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('prova', 'clienti');
      (await import('/js/main.js')).setView('query');
    }, originalRows);
    for (const code of ['SELECT * FROM clienti', 'db.clienti.aggregate([])']) {
      await page.locator('#query-editor-input').fill(code);
      await page.locator('#query-run-btn').click();
      await page.waitForFunction(() => document.querySelector('#view-query').dataset.queryState === 'success');
      await page.locator('#query-export-menu-btn').click();
      const downloaded = page.waitForEvent('download');
      await page.locator('#query-export-json').click();
      const download = await downloaded;
      assert.match(download.suggestedFilename(), /^query_result_\d+\.json$/);
      const rows = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
      assert.deepEqual(rows, [{
        _id: '507f1f77bcf86cd799439011',
        dettagli: { date: ['2026-10-15T12:00:00.000Z'] },
        intero: '9223372036854775807', decimale: '12345678901234567890.1234',
      }], 'Esporta JSON deve scaricare valori standard anche negli oggetti e negli array annidati');
      assert.deepEqual(await page.evaluate(async () => (await import('/js/query-tab.js')).snapshotQueryView().results), originalRows);
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    console.log('OK: il pulsante Esporta JSON scarica JSON standard, senza wrapper MongoDB.');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
