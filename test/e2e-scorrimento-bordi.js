'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium, eventi TOUCH nativi): lo scorrimento automatico ai bordi
 * funziona nel riquadro Split-View vero.
 *
 * La prova attraversa `splitview.js` e l'istanza reale di `cellselect.js`: una
 * cella viene selezionata, poi il dito la trascina fino al bordo del riquadro e
 * resta fermo. Devono avanzare sia lo scroll del SOLO riquadro sia la cella di
 * fuoco, anche mentre la finestra virtuale ricostruisce le righe.
 *
 * Uso: node test/e2e-scorrimento-bordi.js
 * ------------------------------------------------------------------------- */

const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? ` — ${dettaglio}` : ''}`);
    falliti++;
  }
};

async function trascinaColDito(cdp, page, x, y0, y1) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }],
  });
  for (let i = 1; i <= 8; i++) {
    const y = Math.round(y0 + ((y1 - y0) * i) / 8);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(20);
  }
  // Nessun altro evento: da qui deve essere il requestAnimationFrame della
  // selezione a continuare lo scorrimento.
  await page.waitForTimeout(450);
}

(async () => {
  console.log('--- E2E: scorrimento ai bordi nel riquadro Split-View ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3147 });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1000, height: 760 },
    });
    const page = await context.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1200);

    // Un'altezza deterministica rende il bordo del riquadro indipendente dalla
    // dimensione assegnata dal layout della macchina che esegue il test.
    await page.addStyleTag({ content: `
      #workspace { position: fixed !important; inset: 0 !important; height: 700px !important;
        display: flex !important; z-index: 10000 !important; }
      .pane-grid-wrap { height: 260px !important; min-height: 260px !important; }
    ` });

    await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const sv = await import('/js/splitview.js');

      const tab = createTab({ connName: null });
      tabs.activeId = tab.id;
      tab.dbType = 'mongodb';
      tab.state.connected = true;
      tab.state.db = 'prova';
      tab.state.coll = 'grande';
      tab.state.limit = 5000;
      tab.state.docs = Array.from(
        { length: 3000 },
        (_, i) => ({ _id: i + 1, nome: `pane ${i}` })
      );
      tab.state.columns = ['_id', 'nome'];
      tab.state.total = 3000;

      document.getElementById('tab-body').classList.remove('hidden');
      sv.initSplitView();
      sv.addOrSplitPane(null, 'right', { tabId: tab.id, db: 'prova', coll: 'grande' });
      sv.renderSplitView();

      const tbody = document.querySelector('.split-pane .pane-grid tbody');
      window.__conteggiToccoPane = { move: 0, up: 0, cancel: 0 };
      window.__scrollVisti = [];
      tbody.closest('.pane-grid-wrap').addEventListener('scroll', (e) => {
        window.__scrollVisti.push({ x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop });
      });
      tbody.addEventListener('pointermove', (e) => {
        window.__conteggiToccoPane.move++;
        window.__conteggiToccoPane.ultimaY = e.clientY;
      });
      tbody.addEventListener('pointerup', () => window.__conteggiToccoPane.up++);
      tbody.addEventListener('pointercancel', () => window.__conteggiToccoPane.cancel++);
    });

    const contenitore = page.locator('.split-pane .pane-grid-wrap').first();
    const prima = contenitore.locator('tbody td[data-r="0"][data-c="0"]');
    await prima.waitFor({ state: 'visible' });

    // Il percorso tattile di cellselect parte da una cella già selezionata:
    // il primo clic riproduce il tocco/pressione con cui l'utente la sceglie.
    await prima.click();
    const selezionata = await prima.evaluate((td) => td.classList.contains('cell-selected'));
    ok(selezionata, 'la cella iniziale del riquadro è selezionata prima del trascinamento');
    await page.evaluate(() => { window.__conteggiToccoPane = { move: 0, up: 0, cancel: 0 }; });

    const cellaBox = await prima.boundingBox();
    const wrapBox = await contenitore.boundingBox();
    const x = Math.round(cellaBox.x + cellaBox.width / 2);
    const y0 = Math.round(cellaBox.y + cellaBox.height / 2);
    const yBordo = Math.round(wrapBox.y + wrapBox.height - 3);
    const cdp = await context.newCDPSession(page);
    await trascinaColDito(cdp, page, x, y0, yBordo);

    const durante = await page.evaluate(() => {
      const pane = document.querySelector('.split-pane .pane-grid-wrap');
      const focus = pane.querySelector('tbody td.cell-focus');
      return {
        scrollPane: pane.scrollTop,
        scrollXPane: pane.scrollLeft,
        scrollHeight: pane.scrollHeight,
        clientHeight: pane.clientHeight,
        rettangolo: pane.getBoundingClientRect().toJSON(),
        scrollTutti: [...document.querySelectorAll('.split-pane .pane-grid-wrap')].map((el) => el.scrollTop),
        scrollVisti: window.__scrollVisti.slice(),
        scrollDati: document.querySelector('.grid-wrap').scrollTop,
        rigaFuoco: focus ? Number(focus.dataset.r) : -1,
        ...window.__conteggiToccoPane,
      };
    });

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(80);
    const dopo = await page.evaluate(() => ({ ...window.__conteggiToccoPane }));

    ok(durante.cancel === 0,
      'lo scorrimento programmato del riquadro non annulla il gesto tattile',
      `pointercancel=${durante.cancel}`);
    ok(durante.move > 0, 'il riquadro riceve i pointermove del dito');
    ok(durante.scrollPane > 150,
      'il riquadro scorre da solo col dito fermo sul proprio bordo',
      `scrollTop=${durante.scrollPane}, altezze=${durante.clientHeight}/${durante.scrollHeight}, `
        + `y=${durante.ultimaY}, bordo=${durante.rettangolo.bottom}, tutti=${durante.scrollTutti}, `
        + `x=${durante.scrollXPane}, eventi=${JSON.stringify(durante.scrollVisti)}`);
    ok(durante.scrollDati === 0,
      'la griglia Dati nella stessa pagina non viene spostata',
      `scrollTop=${durante.scrollDati}`);
    ok(durante.rigaFuoco > 0,
      'la cella sotto al dito avanza nella finestra virtuale del riquadro',
      `riga=${durante.rigaFuoco}`);
    ok(dopo.up === 1, 'il pointerup arriva al riquadro e ferma il ciclo', JSON.stringify(dopo));
    ok(errori.length === 0, 'nessun errore JavaScript durante il gesto', errori.join('\n'));

    await context.close();
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Scorrimento nel riquadro: ${falliti} test FALLITI ---`);
    process.exitCode = 1;
  } else {
    console.log('\n--- Scorrimento nel riquadro: tutti i test superati ---');
  }
})().catch((err) => {
  console.error('  ✖ Test scorrimento nel riquadro fallito:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
