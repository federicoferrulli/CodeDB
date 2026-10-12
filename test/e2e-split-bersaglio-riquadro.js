'use strict';
// Risposte superate e scritture: il contesto è quello del documento nel pannello.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3157 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await require('./split-frame').install(page);
    await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const tab = createTab({ id: 'negozio' }); tab.dbType = 'mongodb'; tab.label = 'Locale'; tab.state.connected = true;
      window.sent = []; window.queue = [];
      impostaSocket({ connected: true, on() {}, off() {}, emit(name, p, ack) {
        window.sent.push({ name, p });
        if (name === 'collection:find') { window.queue.push({ p, ack }); return; }
        ack?.({ ok: true, collections: ['ordini', 'clienti', 'prodotti', 'fatture'], relazioni: [], total: 5 });
      } });
      (await import('/js/workspace.js')).renderWorkspace();
      const split = await import('/js/splitview.js');
      await split.addOrSplitPane(null, 'right', { tabId: tab.id, db: 'negozio', coll: 'ordini' });
      window.paneId = split.getFocusedPaneId();
    });
    const select = page.locator('select.pane-coll-select');
    for (const coll of ['clienti', 'prodotti']) {
      await page.waitForFunction(() => document.querySelector('.pane-runtime')?.codedbPanel.ready);
      await select.selectOption(coll, { force: true });
    }
    await page.waitForFunction(() => window.queue.length === 3);
    const answer = coll => page.evaluate(coll => {
      const i = window.queue.findIndex(x => x.p.coll === coll), r = window.queue.splice(i, 1)[0];
      r.ack({ ok: true, docs: Array.from({ length: 5 }, (_, i) => ({ _id: i + 100, nome: `${coll}-${i}` })), columns: ['_id', 'nome'], total: 5, limit: 50, skip: 0 });
    }, coll);
    await answer('clienti'); await answer('prodotti'); await answer('ordini');
    const frame = page.frames().find(f => f.parentFrame());
    await frame.locator('#grid tbody td[data-c="1"]').first().waitFor();
    assert((await frame.locator('#grid').textContent()).includes('prodotti-0'));
    assert(!(await frame.locator('#grid').textContent()).includes('ordini-0'));
    assert.equal(await frame.evaluate(async () => (await import('/js/state.js')).state.total), 5);
    console.log('OK: tre bersagli, risposte fuori ordine, dati e totale dell’ultimo documento');
    const cell = frame.locator('#grid td[data-c="1"]').first();
    await cell.dblclick(); await cell.locator('input').fill('Modifica protetta');
    page.once('dialog', dialog => dialog.dismiss());
    await select.selectOption('fatture', { force: true });
    assert.equal(await select.inputValue(), 'prodotti', 'Rifiutare la perdita della bozza conserva la tabella');
    await cell.locator('input').press('Enter');
    const writes = await page.evaluate(() => window.sent.filter(x => x.name === 'doc:update'));
    assert.equal(writes.length, 1); assert.equal(writes[0].p.tabId, 'negozio'); assert.equal(writes[0].p.coll, 'prodotti'); assert.equal(writes[0].p.id, '100');
    console.log('OK: cambio bersaglio annullabile, bozza preservata e scrittura congelata sul documento originale');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
