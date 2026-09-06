'use strict';
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
const OUT = __dirname + '/scatti';

const RIGHE = Array.from({ length: 300 }, (_, i) => ({
  _id: i + 1,
  codice_articolo: `ART-${String(1000 + i)}`,
  descrizione: ['Vite testa esagonale M8', 'Cuscinetto a sfere 6203', 'Guarnizione OR 12x2', 'Dado autobloccante M10'][i % 4],
  quantita: (i * 37) % 940,
  prezzo_unitario: Number(((i * 13.7) % 480 + 1.5).toFixed(2)),
  attivo: i % 3 !== 0,
  aggiornato_il: { $date: new Date(2026, 0, 1 + (i % 300)).toISOString() },
  note: i % 5 === 0 ? null : 'lotto verificato in accettazione',
}));
const COLONNE = ['_id','codice_articolo','descrizione','quantita','prezzo_unitario','attivo','aggiornato_il','note'];

(async () => {
  const server = await startTestServer({ port: 3461 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on('pageerror', (e) => console.log('ERRORE JS:', e.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.getElementById('onboarding-overlay')?.remove());

  await page.evaluate(async ({ righe, colonne }) => {
    const { state } = await import('/js/state.js');
    const { renderGrid } = await import('/js/grid.js');
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    document.getElementById('placeholder').classList.add('hidden');
    for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
    document.getElementById('view-data').classList.remove('hidden');
    const bar = document.getElementById('coll-tab-bar');
    bar.classList.remove('hidden');
    bar.innerHTML = ['articoli','ordini','clienti','movimenti_magazzino'].map((n,i)=>
      `<div class="coll-tab${i===0?' active':''}"><span class="coll-tab-name">${n}</span>`+
      `<button type="button" class="coll-tab-close" aria-label="Chiudi">×</button></div>`).join('');
    state.docs = righe; state.columns = colonne; state.total = righe.length;
    state.currentDb = 'magazzino'; state.currentCollection = 'articoli';
    renderGrid();
  }, { righe: RIGHE, colonne: COLONNE });
  await page.waitForTimeout(500);

  for (const tema of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), tema);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/pieno-${tema}-dati.png` });
  }

  // Tab query con risultati
  await page.evaluate(async ({ righe }) => {
    const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
    for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
    document.getElementById('view-query').classList.remove('hidden');
    const ed = document.getElementById('query-editor');
    if (ed) ed.value = "SELECT codice_articolo, descrizione, quantita\n  FROM articoli\n WHERE quantita > 100\n ORDER BY quantita DESC";
    setResultsViewMode('table');
    renderResults(righe);
  }, { righe: RIGHE });
  await page.waitForTimeout(500);
  for (const tema of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), tema);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/pieno-${tema}-query.png` });
  }
  await browser.close();
  await server.stop();
  console.log('fatto');
})();
