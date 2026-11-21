'use strict';

// Percorso della modale reale: la cattura del trasporto evita scritture nei database utente.
const assert = require('node:assert/strict');
const { EJSON, BSON } = require('bson');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3248 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    const invii = await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const { openImportModal } = await import('/js/exportimport.js');
      const tab = createTab({ id: 'importa-collection' });
      Object.assign(tab.state, { connected: true, dbType: 'mongodb' });
      tabs.activeId = tab.id;
      const inviati = window.blocchiImportati = [];
      impostaSocket({ connected: true, on() {}, off() {}, emit(nome, payload, ack) {
        if (nome === 'collection:import') {
          inviati.push(payload.docs);
          ack({ ok: true, status: 'completato', inserted: payload.docs.length, failed: 0 });
        }
      } });
      openImportModal('ordine', 'eventi');
      document.querySelector('#import-text').value =
        '[{"ordine":9007199254740993,"dettaglio":[{"n":-9007199254740993}],"canonico":{"$numberLong":"9007199254740995"}}]';
      document.querySelector('#import-run').click();
      return inviati;
    });
    assert.equal(invii.length, 1);
    const scritto = BSON.deserialize(BSON.serialize(EJSON.deserialize(invii[0][0], { relaxed: false })), { promoteLongs: false });
    assert.equal(String(scritto.ordine), '9007199254740993', 'Identificatore a 64 bit importato');
    assert.equal(String(scritto.dettaglio[0].n), '-9007199254740993');
    assert.equal(String(scritto.canonico), '9007199254740995');
    console.log('OK: interi JSON esatti dalla modale fino al BSON.');
    const manda = grande => page.evaluate(async grande => {
      const { openImportModal } = await import('/js/exportimport.js');
      window.blocchiImportati.length = 0;
      openImportModal('ordine', 'eventi');
      const docs = [...Array.from({ length: 50 }, (_, i) => ({ i })),
        ...Array.from({ length: 50 }, (_, i) => ({ i: i + 50, testo: '🦊'.repeat(30000) })),
        { i: 100, testo: 'a'.repeat(grande) }];
      document.querySelector('#import-text').value = JSON.stringify(docs);
      document.querySelector('#import-run').click();
    }, grande);
    await manda(4000000);
    await page.waitForFunction(() => !document.querySelector('#import-report').classList.contains('hidden'));
    const misure = await page.evaluate(() => window.blocchiImportati.map(docs => ({
      byte: new TextEncoder().encode(JSON.stringify(docs)).length, indici: docs.map(d => d.i) })));
    assert(misure.every(m => m.byte < 5000000), 'Ogni blocco deve entrare nel trasporto UTF-8');
    assert.deepEqual(misure.flatMap(m => m.indici), Array.from({ length: 101 }, (_, i) => i));
    await manda(5000000);
    await page.waitForFunction(() => document.querySelector('#import-error').textContent.includes('101'));
    assert.equal(await page.evaluate(() => window.blocchiImportati.length), 0, 'Il preflight precede tutte le scritture');
    console.log('OK: blocchi UTF-8 eterogenei e singola riga eccessiva segnalata prima della scrittura.');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
