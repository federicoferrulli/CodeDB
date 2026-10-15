'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): il filtro rapido nella griglia vera.
 *
 * `test/unit-filtro-rapido.js` prova che il filtro venga composto bene; questo
 * prova ciò che quello non può: che il controllo segmentato esponga entrambe
 * le scelte, conservi il testo al cambio di modalità e mandi al server soltanto
 * l'intenzione scelta.
 *
 * L'ultima è la cosa che conta: in modalità rapida il testo digitato è una
 * parola da cercare, e mandarlo come `filter` lo farebbe interpretare come una
 * clausola `WHERE`. Nel migliore dei casi è un errore di sintassi.
 *
 * Non serve un database: si intercetta ciò che parte dal socket.
 *
 * Uso: node test/e2e-filtro-rapido-ui.js
 * Sensibilità: aggiungere --mutant ripristina lo scambio dei testi nel browser.
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
    if (process.argv.includes('--mutant')) {
      await page.route('**/js/grid.js', async (route) => {
        const response = await route.fetch();
        const code = await response.text();
        const corretto = "gruppo.dataset[chiaveDopo] = $('#filter-input').value;";
        if (!code.includes(corretto)) throw new Error('Mutazione del cambio modalità non applicata');
        await route.fulfill({ response, body: code.replace(corretto,
          "$('#filter-input').value = gruppo.dataset[chiaveDopo] || '';") });
      });
    }
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

    /* --- Cambiare modalità conserva ciò che si sta scrivendo ----------- */

    const dopoClic = await page.evaluate(async () => {
      const { leggiStatoFiltro, applicaStatoFiltro } = await import('/js/grid.js');
      const input = document.querySelector('#filter-input');
      const sort = document.querySelector('#sort-input');
      sort.value = 'label ASC';
      input.value = 'Membro';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-filter-mode="condizione"]').click();
      const primaCondizione = input.value;
      input.value = 'label IS NOT NULL';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-filter-mode="rapido"]').click();
      const rapido = input.value;
      document.querySelector('[data-filter-mode="condizione"]').click();
      const condizione = input.value;
      const salvato = leggiStatoFiltro();
      applicaStatoFiltro({ modo: 'rapido', rapido: 'altra scheda' });
      applicaStatoFiltro(salvato);
      const ripristinato = input.value;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-filter-mode="rapido"]').click();
      const vuotoRapido = input.value;
      document.querySelector('[data-filter-mode="condizione"]').click();
      return {
        modo: document.querySelector('#filter-mode-switch').dataset.modo,
        segnaposto: input.placeholder,
        primaCondizione,
        rapido,
        condizione,
        ripristinato,
        vuotoRapido,
        vuotoCondizione: input.value,
        sort: sort.value,
      };
    });
    ok(dopoClic.modo === 'condizione', `un clic porta alla modalità condizione (${dopoClic.modo})`);
    ok(/WHERE|MQL|Condizione/i.test(dopoClic.segnaposto),
      'il segnaposto cambia e nomina la condizione', dopoClic.segnaposto);
    ok(dopoClic.primaCondizione === 'Membro',
      'Cerca → Condizione mantiene il testo appena scritto', dopoClic.primaCondizione);
    ok(dopoClic.rapido === 'label IS NOT NULL',
      'Condizione → Cerca mantiene il testo, anche se Cerca aveva un valore precedente', dopoClic.rapido);
    ok(dopoClic.condizione === 'label IS NOT NULL',
      'i cambi ripetuti conservano il testo corrente', dopoClic.condizione);
    ok(dopoClic.ripristinato === 'label IS NOT NULL',
      'lo snapshot della scheda conserva il testo dopo il cambio di modalità', dopoClic.ripristinato);
    ok(dopoClic.vuotoRapido === '' && dopoClic.vuotoCondizione === '',
      'svuotare il campo e cambiare modalità non recupera testi precedenti');
    ok(dopoClic.sort === 'label ASC', 'anche l’ordinamento resta invariato');

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
        const input = document.querySelector('#filter-input');
        input.value = testo;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        gruppo.querySelector(`[data-filter-mode="${modo}"]`).click();
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
