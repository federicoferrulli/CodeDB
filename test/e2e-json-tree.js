'use strict';

// Chromium reale, senza database: scorrimento virtuale anche nei rami espansi.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3168 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errori = [];
    page.on('pageerror', err => errori.push(err.message));
    if (process.argv.includes('--mutante')) {
      await page.route('**/js/query-tab.js', async route => {
        const risposta = await route.fetch();
        const sorgente = await risposta.text();
        const mutato = sorgente.replace('overscan: JSON_OVERSCAN', 'overscan: queryJsonRows.length');
        assert.notEqual(mutato, sorgente, 'Mutazione non applicata');
        await route.fulfill({ response: risposta, body: mutato });
      });
    }
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForTimeout(500);
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    const iniziale = await page.evaluate(async () => {
      const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
      for (const id of ['tab-body', 'workspace', 'view-query']) document.getElementById(id).classList.remove('hidden');
      for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.toggle('hidden', p.id !== 'view-query');
      document.getElementById('query-json-view').style.cssText = 'height:180px;max-height:none;flex:none;width:650px';
      setResultsViewMode('json');
      const prima = performance.now();
      renderResults(Array.from({ length: 2282 }, (_, id) => ({ id })));
      const tree = document.getElementById('query-json-tree');
      tree.getBoundingClientRect();
      return { ms: performance.now() - prima, nodi: tree.querySelectorAll('.json-node').length,
        altri: tree.querySelectorAll('.json-more').length, testo: tree.textContent };
    });
    console.log('Apertura JSON con 2.282 risultati:', { ms: iniziale.ms, nodi: iniziale.nodi });
    assert.equal(iniziale.altri, 0, 'Tutti i risultati si raggiungono scorrendo, senza Mostra altri');
    assert(iniziale.nodi > 1 && iniziale.nodi < 100, 'DOM limitato alla finestra visibile');
    assert.match(iniziale.testo, /2282 elementi/);
    const primo = page.locator('#query-json-tree [data-json-index="1"] .json-header');
    await primo.press('Enter');
    assert.equal(await primo.getAttribute('aria-expanded'), 'true');
    await primo.press('Space');
    assert.equal(await primo.getAttribute('aria-expanded'), 'false');

    const verifica = await page.evaluate(async () => {
      const { renderResults, setResultsViewMode, resetQueryView } = await import('/js/query-tab.js');
      const { buildJsonNode } = await import('/js/utils.js');
      const tree = document.getElementById('query-json-tree');
      const view = document.getElementById('query-json-view');
      const attendi = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const nodi = () => [...tree.querySelectorAll('.json-node')];
      const riga = i => tree.querySelector(`[data-json-index="${i}"]`);
      const esiti = {};
      const iniziali = nodi().length;
      const nodo = riga(0);
      view.scrollTop = 1;
      await attendi();
      esiti.riuso = nodo === riga(0);
      riga(1).querySelector('.json-header').click();
      view.scrollTop = 20000;
      await attendi();
      esiti.meta = Number(nodi()[0].dataset.jsonIndex) > 500 && nodi().length < 100;
      const posizione = view.scrollTop;
      const primaCambio = nodi()[0];
      setResultsViewMode('table');
      await attendi();
      setResultsViewMode('json');
      await attendi();
      esiti.cambioVista = view.scrollTop === posizione && nodi()[0] === primaCambio;
      view.scrollTop = view.scrollHeight;
      await attendi();
      nodi().at(-1).querySelector('.json-header').click();
      view.scrollTop = view.scrollHeight;
      await attendi();
      esiti.ultima = nodi().at(-1).textContent === 'id: 2281' && nodi().length < 100;
      view.scrollTop = 0;
      await attendi();
      esiti.espansione = riga(1).querySelector('.json-header').getAttribute('aria-expanded') === 'true'
        && riga(2).textContent === 'id: 0';
      view.style.height = '500px';
      await attendi();
      esiti.resize = nodi().length > iniziali && nodi().length < 100;
      const h = riga(0).querySelector('.json-header');
      h.click();
      esiti.collasso = nodi().length === 1;
      h.click();
      esiti.riapertura = riga(2).textContent === 'id: 0';

      const dati = { lista: Array.from({ length: 2282 }, (_, i) => i),
        vuoto: [], nullo: null, falso: false, testo: '<img src=x onerror="throw new Error()">',
        intero: { $numberLong: '9007199254740993' } };
      const originale = JSON.stringify(dati);
      renderResults([dati]);
      esiti.nuovaQuery = view.scrollTop === 0 && riga(1).querySelector('.json-header').getAttribute('aria-expanded') === 'false';
      riga(1).querySelector('.json-header').click();
      riga(2).querySelector('.json-header').click();
      view.scrollTop = 20000;
      await attendi();
      esiti.annidato = nodi().length < 100 && Number(nodi()[0].textContent) > 500;
      view.scrollTop = view.scrollHeight;
      await attendi();
      esiti.fineAnnidato = tree.textContent.includes('2281') && tree.textContent.includes('nullo: null')
        && tree.textContent.includes('falso: false') && tree.textContent.includes(dati.testo) && !tree.querySelector('img');
      nodi().at(-1).querySelector('.json-header').click();
      view.scrollTop = view.scrollHeight;
      await attendi();
      esiti.ejson = tree.textContent.includes('9007199254740993');
      renderResults([Object.fromEntries(dati.lista.map(i => [`campo${i}`, i]))]);
      riga(1).querySelector('.json-header').click();
      view.scrollTop = view.scrollHeight;
      await attendi();
      esiti.oggetto = nodi().at(-1).textContent === 'campo2281: 2281' && nodi().length < 100;
      renderResults([{ testo: 'Testo lungo '.repeat(2000) }]);
      riga(1).querySelector('.json-header').click();
      esiti.righe = nodi().every(n => Math.abs(n.getBoundingClientRect().height - nodi()[0].getBoundingClientRect().height) < 1)
        && view.scrollWidth > view.clientWidth;
      resetQueryView();
      await attendi();
      esiti.reset = tree.textContent === 'Nessun risultato da mostrare';
      setResultsViewMode('json');
      renderResults([dati]);
      esiti.ripristino = nodi().length === 2 && JSON.stringify(dati) === originale;
      const classico = buildJsonNode(dati.lista, 'Plan', true);
      esiti.classico = classico.querySelectorAll('.json-node').length === 2282 && !classico.querySelector('button');
      return esiti;
    });
    for (const [nome, valore] of Object.entries(verifica)) assert.equal(valore, true, nome);
    assert.deepEqual(errori, []);
    console.log('OK: fine elenco, rami annidati, DOM limitato, tastiera, resize, stato conservato, reset ed EJSON.');
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
