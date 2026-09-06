'use strict';

// Chromium reale: finestra DOM limitata, resize, riuso dei nodi e fine elenco.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3157 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(server.url);
    await page.waitForSelector('#query-result-table', { state: 'attached' });
    const risultato = await page.evaluate(async () => {
      const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
      for (const id of ['tab-body', 'workspace', 'view-query']) document.getElementById(id).classList.remove('hidden');
      for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.toggle('hidden', p.id !== 'view-query');
      const contenitore = document.getElementById('query-table-view');
      // Altezza controllata: riproduce il divisorio senza dipendere dalla finestra.
      contenitore.style.cssText = 'height:180px;max-height:none;flex:none;width:650px';
      const righe = Array.from({ length: 100123 }, (_, id) => ({ id, testo: 'Contenuto della riga '.repeat(20) }));
      setResultsViewMode('table');
      const prima = performance.now();
      renderResults(righe);
      const tempo = performance.now() - prima;
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const nodi = () => [...document.querySelectorAll('#query-result-table tbody tr:not(.v-spacer)')];
      await attendi();
      const iniziali = nodi().length;
      const nodo = nodi()[0];
      contenitore.scrollLeft = 100;
      contenitore.scrollTop = 1;
      await attendi();
      const riuso = nodo === nodi()[0];
      contenitore.style.height = '650px';
      await attendi();
      await attendi();
      const dopoResize = nodi().length;
      contenitore.scrollTop = 1500000;
      await attendi();
      const posizione = contenitore.scrollTop;
      const primoMeta = nodi()[0].textContent;
      renderResults(righe);
      await attendi();
      const conservata = contenitore.scrollTop === posizione && nodi()[0].textContent === primoMeta;
      contenitore.scrollTop = contenitore.scrollHeight;
      await attendi();
      const ultima = nodi().at(-1).cells[0].textContent;
      const inFondo = nodi().length;
      document.querySelector('#query-result-table th').click();
      document.querySelector('#query-result-table th').click();
      await attendi();
      const ordinata = nodi()[0].cells[0].textContent;
      renderResults([{ id: 7, testo: 'Nuova query' }]);
      await attendi();
      const nuove = nodi().length, primoNuovo = nodi()[0].cells[0].textContent;
      renderResults(righe.slice(0, 1000));
      contenitore.scrollTop = 10000;
      await attendi();
      const primaCambio = contenitore.scrollTop;
      setResultsViewMode('json');
      await attendi();
      setResultsViewMode('table');
      await attendi();
      const cambioVista = contenitore.scrollTop === primaCambio;
      return { tempo, iniziali, dopoResize, riuso, conservata, ultima, inFondo, ordinata,
        nuove, primoNuovo, cambioVista };
    });
    console.log(risultato);
    assert(risultato.iniziali > 0 && risultato.iniziali < 100);
    assert(risultato.riuso, 'Scroll orizzontale/piccolo: i nodi devono restare gli stessi');
    assert(risultato.dopoResize > risultato.iniziali, 'Il resize deve riempire il nuovo spazio');
    assert(risultato.conservata, 'Il ridisegno degli stessi risultati deve conservare la posizione');
    assert.equal(risultato.ultima, '100122');
    assert(risultato.inFondo < 100);
    assert.equal(risultato.ordinata, '100122');
    assert.equal(risultato.nuove, 1);
    assert.equal(risultato.primoNuovo, '7');
    assert(risultato.cambioVista, 'Tabella → JSON → Tabella deve conservare la posizione');
    console.log('OK: scorrimento virtuale su 100.123 risultati, resize, ordinamento e nuova query.');
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
