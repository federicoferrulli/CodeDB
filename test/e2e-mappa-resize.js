'use strict';

// La dimensione interna di Leaflet deve seguire il pannello, anche senza
// un evento resize della finestra. Nessun database o tile esterna richiesti.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3158 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(server.url);
    await page.waitForSelector('#query-editor-resizer', { state: 'attached' });
    await page.evaluate(async () => {
      document.getElementById('onboarding-overlay')?.remove();
      const { caricaLeaflet, impostaTile } = await import('/js/geo-leaflet.js');
      impostaTile(false);
      const L = await caricaLeaflet();
      L.Map.addInitHook(function () {
        if (this.getContainer().id === 'qmap-canvas') window.mappaProva = this;
      });
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
      for (const id of ['tab-body', 'workspace']) document.getElementById(id).classList.remove('hidden');
      for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.toggle('hidden', p.id !== 'view-query');
      const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
      renderResults([{ punto: { type: 'Point', coordinates: [12.5, 41.9] } }]);
      setResultsViewMode('map');
    });
    await page.waitForFunction(() => window.mappaProva?.getContainer().clientHeight > 0);
    await page.waitForTimeout(250);
    const misura = () => page.evaluate(() => {
      const m = window.mappaProva, c = m.getContainer(), s = m.getSize();
      return { width: c.clientWidth, height: c.clientHeight, x: s.x, y: s.y,
        zoom: m.getZoom(), centro: m.getCenter() };
    });
    const iniziale = await misura();
    const maniglia = await page.locator('#query-editor-resizer').boundingBox();
    assert(maniglia);
    await page.mouse.move(maniglia.x + maniglia.width / 2, maniglia.y + maniglia.height / 2);
    await page.mouse.down();
    await page.mouse.move(maniglia.x + maniglia.width / 2, maniglia.y + 150, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const trascinata = await misura();
    console.log({ iniziale, trascinata });
    assert.notEqual(trascinata.height, iniziale.height, 'Il trascinamento deve cambiare il pannello');
    assert.equal(trascinata.y, trascinata.height, 'Leaflet deve aggiornarsi al trascinamento');
    assert.equal(trascinata.x, trascinata.width);
    assert.equal(trascinata.zoom, iniziale.zoom);
    assert(Math.abs(trascinata.centro.lat - iniziale.centro.lat) < 0.01);
    const separatore = await page.locator('#query-editor-resizer').boundingBox();
    await page.mouse.move(separatore.x + 50, separatore.y + separatore.height / 2);
    await page.mouse.down();
    await page.mouse.move(separatore.x + 50, separatore.y - 120, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const ingrandita = await misura();
    assert(ingrandita.height > trascinata.height);
    assert.equal(ingrandita.y, ingrandita.height, 'La mappa deve riempire anche lo spazio aggiunto');
    assert.equal(ingrandita.zoom, iniziale.zoom);
    await page.setViewportSize({ width: 1100, height: 1100 });
    await page.waitForTimeout(300);
    const finestra = await misura();
    assert.equal(finestra.x, finestra.width);
    assert.equal(finestra.y, finestra.height);
    await page.evaluate(async () => {
      const { setResultsViewMode } = await import('/js/query-tab.js');
      setResultsViewMode('table');
      document.getElementById('query-editor-container').style.height = '240px';
      setResultsViewMode('map');
    });
    await page.waitForTimeout(250);
    const riaperta = await misura();
    assert.equal(riaperta.y, riaperta.height);
    assert.equal(riaperta.x, riaperta.width);
    console.log('OK: mappa sincronizzata con divisorio, finestra e ritorno alla vista.');
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
