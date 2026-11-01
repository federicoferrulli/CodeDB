'use strict';

// Browser, Socket.IO, traduttore SQL e MongoDB reali; database casuale della fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

(async () => {
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_schede_errori' });
  const db = targets.target('mongo');
  targets.assertOwned(db);
  const host = process.env.MONGO_HOST || '127.0.0.1';
  const port = Number(process.env.MONGO_PORT || 27017);
  const client = new MongoClient(`mongodb://${host}:${port}`, { serverSelectionTimeoutMS: 5000 });
  const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports'}/script-errori-mongodb`;
  let server, browser, connected = false;
  try {
    await client.connect();
    connected = true;
    await client.db(db).collection('approles').insertMany([{ key: 'OWNER' }, { key: 'MEMBER' }, { key: 'READER' }]);
    server = await startTestServer({ port: 3186 });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async ({ db, host, port }) => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { emit } = await import('/js/utils.js');
      const { socket } = await import('/js/socket.js');
      const tab = createTab({ id: 'schede-mongo-reali' });
      tabs.activeId = tab.id;
      await emit('mongo:connect', { host, port });
      tab.label = 'MongoDB di prova'; tab.dbType = 'mongodb';
      Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType,
        databases: [{ name: db, collections: [{ name: 'approles' }] }] });
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab(db, 'approles');
      (await import('/js/main.js')).setView('query');
      window.esitoScript = null;
      socket.on('script:progress', ev => { if (ev.tipo === 'done') window.esitoScript = ev; });
    }, { db, host, port });
    const tabs = page.locator('#script-results-tabs [role="tab"]');
    const errorBox = page.locator('#query-error-box .data-empty');
    const editor = page.locator('#query-editor-input');
    fs.mkdirSync(dir, { recursive: true });
    for (const errorePrima of [true, false]) {
      const queries = ['SELECT * FROM "approles";', 'SELECT * FROM approles;'];
      if (!errorePrima) queries.reverse();
      await editor.fill(queries.join('\n'));
      await page.evaluate(() => { window.esitoScript = null; });
      await page.locator('#query-run-btn').click();
      await page.waitForFunction(() => window.esitoScript !== null);
      const esito = await page.evaluate(() => ({
        falliti: window.esitoScript.stato.falliti,
        schede: window.esitoScript.risultati.schede.map(s => ({ index: s.index, errore: !!s.error, righe: s.rows })),
      }));
      assert.equal(esito.falliti, 1);
      assert.equal(esito.schede.length, 2, `MongoDB deve produrre due schede: ${JSON.stringify(esito)}`);
      assert.equal(await tabs.count(), 2, 'Entrambe le schede devono essere presenti nel DOM');
      assert(await page.locator('#script-results-tabs').isVisible());
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
      const errorePos = errorePrima ? 0 : 1;
      await tabs.nth(errorePos).click();
      await errorBox.waitFor({ state: 'visible' });
      assert.match(await errorBox.innerText(), /Traduzione SQL→MongoDB non riuscita/);
      assert.equal(await page.locator('#query-editor-code .query-error-mark').innerText(), '"approles"');
      await page.screenshot({ path: `${dir}/${errorePrima ? 'prima' : 'ultima'}-query-errore.png` });
      await tabs.nth(1 - errorePos).click();
      await page.waitForFunction(() => document.querySelectorAll('#query-result-table tbody tr').length === 3
        && document.querySelector('#query-error-box').classList.contains('hidden'));
      assert.equal(await errorBox.count(), 0);
      assert.equal(await tabs.nth(1 - errorePos).getAttribute('aria-selected'), 'true');
      await page.screenshot({ path: `${dir}/${errorePrima ? 'prima' : 'ultima'}-query-dati.png` });
    }
    assert.deepEqual(errors, []);
    console.log('OK MongoDB reale: due schede per SELECT fallita/riuscita in entrambi gli ordini, tre righe conservate e sottolineatura precisa.');
  } finally {
    await browser?.close();
    await server?.stop();
    try {
      if (connected) await targets.cleanup(name => client.db(name).dropDatabase());
    } finally { await client.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
