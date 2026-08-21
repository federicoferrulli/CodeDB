'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): il filtro rapido nella griglia vera.
 *
 * `test/unit-filtro-rapido.js` prova che il filtro venga composto bene; questo
 * prova ciò che quello non può: che il controllo segmentato esponga entrambe
 * le scelte, conservi i due testi e mandi al server soltanto l'intenzione.
 *
 * L'ultima è la cosa che conta: in modalità rapida il testo digitato è una
 * parola da cercare, e mandarlo come `filter` lo farebbe interpretare come una
 * clausola `WHERE`. Nel migliore dei casi è un errore di sintassi.
 *
 * Non serve un database: si intercetta ciò che parte dal socket.
 *
 * Uso: node test/e2e-filtro-rapido-ui.js
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
  console.log('--- E2E: il filtro rapido nella griglia ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3159 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#filter-mode-switch', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1200);

    /* --- Il controllo parte su Cerca ed è esplicito -------------------- */

    const iniziale = await page.evaluate(() => {
      const gruppo = document.querySelector('#filter-mode-switch');
      const cerca = gruppo.querySelector('[data-filter-mode="rapido"]');
      const condizione = gruppo.querySelector('[data-filter-mode="condizione"]');
      const input = document.querySelector('#filter-input');
      return {
        modo: gruppo.dataset.modo,
        cerca: cerca.textContent.trim(),
        condizione: condizione.textContent.trim(),
        cercaSelezionata: cerca.getAttribute('aria-checked'),
        segnaposto: input.placeholder,
        queryMode: document.querySelector('#query-mode').value,
        queryModeVisibile: document.querySelector('#query-mode').getClientRects().length > 0,
      };
    });
    ok(iniziale.modo === 'rapido', `si parte in modalità rapida (${iniziale.modo})`);
    ok(iniziale.cerca === 'Cerca' && iniziale.condizione === 'Condizione',
      'le due alternative sono leggibili senza interpretare un\'icona');
    ok(iniziale.cercaSelezionata === 'true', 'Cerca espone lo stato selezionato');
    ok(/tutti i campi/i.test(iniziale.segnaposto),
      'il segnaposto dichiara il perimetro della ricerca', iniziale.segnaposto);
    ok(iniziale.queryMode === 'find' && !iniziale.queryModeVisibile,
      'Aggregate/SQL Raw non è più una modalità visibile nella vista Dati');

    /* --- Le modalità conservano testi separati ------------------------ */

    const dopoClic = await page.evaluate(async () => {
      const input = document.querySelector('#filter-input');
      input.value = 'Membro';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-filter-mode="condizione"]').click();
      await new Promise((r) => setTimeout(r, 100));
      input.value = 'label IS NOT NULL';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-filter-mode="rapido"]').click();
      const rapido = input.value;
      document.querySelector('[data-filter-mode="condizione"]').click();
      return {
        modo: document.querySelector('#filter-mode-switch').dataset.modo,
        segnaposto: input.placeholder,
        rapido,
        condizione: input.value,
      };
    });
    ok(dopoClic.modo === 'condizione', `un clic porta alla modalità condizione (${dopoClic.modo})`);
    ok(/WHERE|MQL|Condizione/i.test(dopoClic.segnaposto),
      'il segnaposto cambia e nomina la condizione', dopoClic.segnaposto);
    ok(dopoClic.rapido === 'Membro', 'Cerca conserva il proprio testo', dopoClic.rapido);
    ok(dopoClic.condizione === 'label IS NOT NULL',
      'Condizione conserva il proprio testo', dopoClic.condizione);

    /* --- Che cosa parte davvero verso il server ------------------------ */

    const inviati = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { state } = await import('/js/state.js');
      const { tabs, createTab } = await import('/js/tabs.js');
      const { runQuery } = await import('/js/grid.js');

      // Un socket finto che registra ciò che parte, senza rispondere: qui
      // interessa la richiesta, non il risultato.
      const visti = [];
      impostaSocket({
        emit: (evento, payload) => { visti.push({ evento, payload }); },
        on: () => {}, off: () => {},
      });

      const tab = createTab({});
      tabs.activeId = tab.id;
      tab.state.connected = true;
      tab.state.db = 'app';
      tab.state.coll = 'utenti';
      tab.state.columns = ['_id', 'nome', 'citta'];
      state.db = 'app'; state.coll = 'utenti'; state.columns = ['_id', 'nome', 'citta'];

      const misura = (modo, testo) => {
        const gruppo = document.querySelector('#filter-mode-switch');
        gruppo.dataset.modo = modo;
        gruppo.querySelectorAll('[data-filter-mode]').forEach((b) => {
          b.classList.toggle('active', b.dataset.filterMode === modo);
        });
        const input = document.querySelector('#filter-input');
        input.value = testo;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        visti.length = 0;
        runQuery();
        const trovato = visti.find((v) => String(v.evento).startsWith('collection:find'));
        return trovato ? trovato.payload : null;
      };

      const rapido = misura('rapido', 'ann');
      const condizione = misura('condizione', "nome = 'anna'");
      impostaSocket(null);
      return { rapido, condizione };
    });

    ok(inviati.rapido && inviati.rapido.cercaOvunque,
      'modalità rapida: parte l\'intenzione contieneOvunque', JSON.stringify(inviati.rapido));
    ok(inviati.rapido && inviati.rapido.filter === undefined,
      'modalità rapida: il testo grezzo NON parte');
    ok(inviati.rapido && inviati.rapido.cercaOvunque.operatore === 'contieneOvunque',
      'il browser non enumera le colonne della pagina corrente');
    ok(inviati.rapido && inviati.rapido.cercaOvunque.valore === 'ann',
      'il testo digitato resta un valore parametrizzato');

    ok(inviati.condizione && inviati.condizione.filter === "nome = 'anna'",
      'modalità condizione: parte il testo grezzo, come prima');
    ok(inviati.condizione && inviati.condizione.cercaOvunque === undefined,
      'modalità condizione: la ricerca globale NON parte');

    ok(errori.length === 0, 'nessun errore JavaScript', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Filtro rapido: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Filtro rapido: tutti i test superati ---');
})();
