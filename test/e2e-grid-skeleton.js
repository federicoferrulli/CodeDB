'use strict';
// Misure reali del browser: caricamento, ridimensionamento e ritorno ai dati.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    if (process.argv.includes('--mutant-density')) await page.route('**/js/utils.js*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('Math.floor(altezza / 32)', 'Math.floor(altezza / 80)') });
    });
    if (process.argv.includes('--mutant')) await page.route('**/css/workbench.css*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replaceAll(':has(.skeleton)', ':has(.skeleton-disabilitato)') });
    });
    await page.goto(server.url);
    const risultato = await page.evaluate(async () => {
      const { showSkeletonGrid } = await import('/js/utils.js');
      document.body.replaceChildren();
      const misure = [];
      for (const id of ['grid', 'query-result-table', 'temporanea']) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'width:900px;height:600px;overflow:auto';
        document.body.append(wrap);
        if (id !== 'temporanea') {
          wrap.innerHTML = `<table id="${id}" style="width:1800px"><colgroup><col style="width:1800px"></colgroup><thead></thead><tbody></tbody></table>`;
        }
        showSkeletonGrid(id === 'grid' ? wrap.firstChild : wrap);
        const table = wrap.querySelector('table');
        for (const [width, height] of [[900, 600], [420, 340], [1100, 720]]) {
          wrap.style.width = `${width}px`;
          wrap.style.height = `${height}px`;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const rect = table.getBoundingClientRect();
          misure.push({ id, width, height, actualWidth: rect.width, actualHeight: rect.height,
            rowHeight: table.querySelector('tbody tr').getBoundingClientRect().height });
        }
        table.querySelector('thead').replaceChildren();
        table.querySelector('tbody').replaceChildren();
        if (id !== 'temporanea') misure.push({ id, ripristinata: table.getBoundingClientRect().width });
        wrap.remove();
      }
      return misure;
    });
    for (const misura of risultato) {
      if ('ripristinata' in misura) assert.equal(misura.ripristinata, 1800, `${misura.id}: larghezza dati ripristinata`);
      else {
        assert(Math.abs(misura.actualWidth - misura.width) <= 1, `Larghezza skeleton: ${JSON.stringify(misura)}`);
        assert(Math.abs(misura.actualHeight - misura.height) <= 1, `Altezza skeleton: ${JSON.stringify(misura)}`);
        assert(misura.rowHeight <= 36, `Righe compatte: ${JSON.stringify(misura)}`);
      }
    }
    console.log('OK: skeleton Dati, Query e temporaneo a pieno pannello, resize e ripristino');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
