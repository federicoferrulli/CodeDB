'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E: la UI si carica senza errori JavaScript.
 *
 * PERCHÉ ESISTE. I moduli del frontend si inizializzano in catena da main.js: se
 * uno lancia — un identificatore rimasto senza import dopo un refactoring, una
 * funzione rinominata a metà — l'eccezione interrompe la catena e TUTTO ciò che
 * viene dopo non si aggancia più. In pagina non compare nessun messaggio: si
 * vede solo che una funzione "non fa più niente", e la si cerca dove non è.
 * È esattamente così che la selezione di celle è sparita una volta: un
 * `ReferenceError` dentro `initCellSelect`, invisibile a `node --check` perché
 * non è un errore di sintassi ma di esecuzione.
 *
 * Non serve un database: gli `init*` girano al caricamento della pagina, prima
 * di qualunque connessione. Il server è l'istanza usa e getta di e2e-harness,
 * quindi né il vault né la configurazione dell'utente vengono toccati.
 *
 * Uso: node test/e2e-avvio-ui.js
 * ------------------------------------------------------------------------- */

const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? `\n         ${dettaglio}` : ''}`);
    falliti++;
  }
};

(async () => {
  console.log('--- E2E: avvio della UI senza errori JavaScript ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3142 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(`pageerror: ${err && err.message ? err.message : err}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      // Il socket può segnalare un tentativo di connessione fallito a seconda
      // dei tempi: è rumore di rete, non un modulo che si rompe.
      if (/websocket|socket\.io|net::ERR|Failed to load resource/i.test(t)) return;
      errori.push(`console.error: ${t}`);
    });

    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    // I moduli sono ESM caricati in differita: si lascia finire la catena.
    // `state: 'attached'`: senza una connessione la griglia esiste ma è nascosta,
    // e qui interessa che i moduli si siano inizializzati, non che si veda.
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);

    ok(errori.length === 0, 'nessun errore JavaScript durante il caricamento della UI', errori.join('\n         '));

    // La catena si è chiusa davvero fino in fondo: l'ultimo passo di main.js
    // marca il documento come pronto. Senza questo, un'eccezione a metà catena
    // lascerebbe la pagina "quasi" viva e il test non se ne accorgerebbe.
    const grid = await page.$('#grid tbody');
    ok(!!grid, 'la griglia è nel DOM');

    // Prova diretta che `initCellSelect` è arrivato in fondo: aggancia i suoi
    // gestori al `tbody`, e senza di essi la selezione non esiste. Si controlla
    // il comportamento, non il codice: una cella finta inserita nel `tbody`
    // reale deve rispondere al mousedown prendendo la classe della selezione.
    const esito = await page.evaluate(async () => {
      // Lo stato del tab è la stessa istanza che usano i moduli: importarlo qui
      // non ne crea un secondo (i moduli ESM sono già valutati). Due righe e due
      // colonne bastano: `applyCellSelection` scarta le celle fuori dai limiti,
      // quindi senza dati nessuna selezione potrebbe sopravvivere.
      const { state } = await import('/js/state.js');
      state.docs = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
      state.columns = ['a', 'b'];

      const tbody = document.querySelector('#grid tbody');
      tbody.innerHTML = '';
      for (let r = 0; r < 2; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < 2; c++) {
          const td = document.createElement('td');
          td.dataset.r = String(r); td.dataset.c = String(c);
          td.textContent = 'x';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      const prima = tbody.querySelector('td[data-r="0"][data-c="0"]');
      const ultima = tbody.querySelector('td[data-r="1"][data-c="1"]');

      prima.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
      await new Promise((r) => setTimeout(r, 30));
      const singola = prima.classList.contains('cell-selected');

      // E il trascinamento: `mouseover` sull'ultima cella deve estendere il
      // rettangolo. È il percorso che lo scorrimento automatico riusa.
      ultima.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 40, clientY: 40 }));
      await new Promise((r) => setTimeout(r, 30));
      const quante = tbody.querySelectorAll('td.cell-selected').length;
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      tbody.innerHTML = '';
      return { singola, quante };
    });
    ok(esito.singola, 'un mousedown su una cella la seleziona: initCellSelect è agganciato');
    ok(esito.quante === 4, 'il trascinamento estende il rettangolo di selezione',
      `celle selezionate: ${esito.quante} (attese 4)`);
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Avvio UI: ${falliti} test FALLITI ---`);
    process.exitCode = 1;
  } else {
    console.log('\n--- Avvio UI: tutti i test superati ---');
  }
})().catch((err) => {
  console.error('  ✗ Test avvio UI fallito:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
