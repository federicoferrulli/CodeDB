'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3249 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    for (const motore of ['mongodb', 'mysql', 'postgresql']) {
      await page.evaluate(async motore => {
        const { createTab, tabs } = await import('/js/tabs.js');
        const { impostaSocket } = await import('/js/socket.js');
        const { renameDb } = await import('/js/schema-ops.js');
        const tab = createTab({ id: motore });
        tabs.activeId = tab.id;
        tab.state.dbType = motore;
        window.richieste = [];
        impostaSocket({ on() {}, off() {}, emit(evento, p) {
          if (evento === 'db:rename') window.richieste.push(p);
        } });
        window.rinomina = renameDb('prima');
      }, motore);
      await page.locator('#askinput-value').fill('dopo');
      await page.locator('#askinput-ok').click();
      await page.evaluate(() => window.rinomina);
      assert.deepEqual(await page.evaluate(() => window.richieste),
        [{ tabId: motore, db: 'prima', newName: 'dopo', eliminaOrigine: false }], motore);
    }
    console.log('OK: la rinomina invia il nome confermato per tutti i motori.');
  } finally { await browser?.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
