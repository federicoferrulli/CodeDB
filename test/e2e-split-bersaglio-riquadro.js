'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): il bersaglio di un riquadro Split-View resta congelato.
 *
 * Issue 02 (bloccata da 01): un riquadro deve mostrare e modificare soltanto
 * la collezione del contesto che ha originato la richiesta, anche quando
 * l'utente cambia rapidamente collezione. Due prove, con lo stesso socket
 * finto e lo stesso ordine di consegna invertito di `e2e-pagine-obsolete.js`:
 *
 *  - VISTA: un riquadro passa "ordini" → "clienti" → "prodotti" prima che
 *    arrivi alcuna risposta; le tre risposte vengono consegnate FUORI
 *    ordine. Righe, colonne e riepilogo mostrati devono appartenere tutti
 *    alla stessa generazione (l'ultima, "prodotti"), mai una miscela.
 *  - SCRITTURA: si apre la modifica di una cella di "prodotti", si passa poi
 *    il riquadro a "fatture" PRIMA di salvare, e si salva. Il `doc:update`
 *    deve raggiungere "prodotti" con l'_id della riga originale — mai
 *    "fatture", che quella riga non la conosce nemmeno.
 *
 * Sensibilità verificata rompendo di proposito, una alla volta, le due
 * guardie coinvolte:
 *   - il `contestoCorrente(...)` di `runPaneQuery`             → la prova
 *     "vista" fallisce (colonne/righe di una generazione superata);
 *   - il congelamento di `ctx.db`/`ctx.coll` in `startPaneEdit` (lettura
 *     diretta di `p.db`/`p.coll` al posto dello snapshot) → la prova
 *     "scrittura" fallisce (il doc:update raggiunge "fatture").
 *
 * Uso: node test/e2e-split-bersaglio-riquadro.js
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
  console.log('--- E2E: bersaglio del riquadro Split-View congelato ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3157 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#workspace', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);

    const esito = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const { addOrSplitPane, getFocusedPaneId } = await import('/js/splitview.js');

      const ATTESA_ACK_MS = 40;

      const inviati = [];
      const coda = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          inviati.push({ evento, msg });
          // L'elenco delle collezioni non è parte della prova (serve solo a
          // popolare le due <select> della testata): risponde subito, sempre
          // con lo stesso elenco, invece di entrare nella coda che il test
          // consegna a mano.
          if (evento === 'db:collections') {
            if (typeof cb === 'function') cb({ ok: true, collections: ['ordini', 'clienti', 'prodotti', 'fatture'] });
            return;
          }
          if (typeof cb === 'function') coda.push({ evento, msg, cb });
        },
        on: () => {}, off: () => {},
      });
      // Consegna la risposta ancora in coda per `evento` il cui payload cita
      // `coll`: la scelta è sulla COLLEZIONE richiesta, non sull'ordine di
      // invio, perché è proprio l'ordine che il test vuole capovolgere.
      const consegnaPer = async (evento, coll, risposta) => {
        const i = coda.findIndex((c) => c.evento === evento && c.msg.coll === coll);
        if (i < 0) throw new Error(`Nessun "${evento}" per "${coll}" in coda`);
        const [scelta] = coda.splice(i, 1);
        scelta.cb(risposta);
        await new Promise((r) => setTimeout(r, ATTESA_ACK_MS));
      };
      const attesa = (ms) => new Promise((r) => setTimeout(r, ms));
      const righe = (n, campo, etichetta) => Array.from({ length: n }, (_, i) => ({
        _id: 100 + i, [campo]: `${etichetta}-${i}`,
      }));

      const tab = createTab({ connName: null });
      tab.dbType = 'mongodb';
      tabs.activeId = tab.id;

      /* ===================== VISTA: tre generazioni, ordine invertito === */

      addOrSplitPane(null, 'right', {
        tabId: tab.id, db: 'negozio', coll: 'ordini',
        filter: '', sort: '', queryMode: 'find', skip: 0, limit: 50,
      });
      const paneId = getFocusedPaneId();
      await attesa(ATTESA_ACK_MS); // il db:collections popola le <select>

      const paneEl = document.querySelector(`.split-pane[data-pane-id="${paneId}"]`);
      const collSelect = paneEl.querySelector('.pane-coll-select');

      // Due cambi di collezione IN FRETTA, senza rispondere a nessuno dei tre
      // (il primo, "ordini", è partito da solo alla creazione del riquadro):
      // tre `collection:find` restano in coda, uno per generazione.
      collSelect.value = 'clienti';
      collSelect.dispatchEvent(new Event('change'));
      collSelect.value = 'prodotti';
      collSelect.dispatchEvent(new Event('change'));

      const richiesteVista = inviati.filter((i) => i.evento === 'collection:find').length;

      // Consegna FUORI ordine: la superata di mezzo, poi quella vera, infine
      // la più vecchia di tutte — con un totale diverso da ognuna delle altre
      // due, così un eventuale mescolamento si vede anche nel riepilogo.
      await consegnaPer('collection:find', 'clienti', {
        ok: true, docs: righe(2, 'nome_cliente', 'clienti'), columns: ['_id', 'nome_cliente'],
        skip: 0, limit: 50, total: 2,
      });
      await consegnaPer('collection:find', 'prodotti', {
        ok: true, docs: righe(5, 'nome_prodotto', 'prodotti'), columns: ['_id', 'nome_prodotto'],
        skip: 0, limit: 50, total: 5,
      });
      await consegnaPer('collection:find', 'ordini', {
        ok: true, docs: righe(9, 'vecchio_campo', 'ordini'), columns: ['_id', 'vecchio_campo'],
        skip: 0, limit: 50, total: 9,
      });

      const colonneMostrate = [...paneEl.querySelectorAll('.pane-grid thead th.pane-col-header')]
        .map((th) => th.textContent.replace(/\s*[▲▼]$/, ''));
      const righeMostrate = [...paneEl.querySelectorAll('.pane-grid tbody td[data-c="0"]')]
        .map((td) => td.textContent);
      const riepilogo = paneEl.querySelector('.pane-result-info').textContent;

      const vista = { richieste: richiesteVista, colonneMostrate, righeMostrate, riepilogo };

      /* =================== SCRITTURA: cambio di rotta a modifica aperta = */

      // La riga in modifica è quella di "prodotti", l'unica mostrata adesso.
      const tdModifica = paneEl.querySelector('.pane-grid tbody td.editable');
      tdModifica.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = tdModifica.querySelector('input');
      const testoOriginale = input ? input.value : null;

      // Si cambia la collezione del riquadro PRIMA di salvare: l'editor resta
      // aperto sulla riga di "prodotti" (il DOM sotto viene comunque
      // ricostruito da `updatePaneUI`, ma il riferimento all'input resta
      // valido — è un nodo staccato, non distrutto).
      collSelect.value = 'fatture';
      collSelect.dispatchEvent(new Event('change'));

      input.value = 'modificato-dopo-il-cambio';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await attesa(ATTESA_ACK_MS);

      const scritture = inviati.filter((i) => i.evento === 'doc:update');
      const scrittura = scritture[scritture.length - 1] || null;

      const esitoScrittura = {
        testoOriginale,
        numeroScritture: scritture.length,
        collBersaglio: scrittura && scrittura.msg.coll,
        dbBersaglio: scrittura && scrittura.msg.db,
        idBersaglio: scrittura && scrittura.msg.id,
      };

      // Pulizia: risponde a ciò che è rimasto in coda, così nessuna promessa
      // resta agganciata a un test già finito.
      for (const { evento, cb } of [...coda]) cb(evento === 'doc:update' ? { ok: true } : { ok: true, docs: [], columns: [], skip: 0, limit: 50, total: 0 });

      impostaSocket(null);
      return { vista, scrittura: esitoScrittura };
    });

    const { vista, scrittura } = esito;

    ok(vista.richieste === 3, `tre letture in volo prima di qualunque risposta (${vista.richieste})`);
    ok(vista.colonneMostrate.length === 2 && vista.colonneMostrate[1] === 'nome_prodotto',
      'le colonne mostrate sono quelle di "prodotti", non un mix con le altre due',
      JSON.stringify(vista.colonneMostrate));
    ok(JSON.stringify(vista.righeMostrate) === JSON.stringify(['100', '101', '102', '103', '104']),
      'le righe mostrate sono esattamente le 5 di "prodotti", nel loro ordine',
      JSON.stringify(vista.righeMostrate));
    ok(!vista.riepilogo.includes('2 ') && !vista.riepilogo.includes('9 '),
      'il riepilogo del riquadro non riporta il totale di "clienti" né di "ordini"',
      vista.riepilogo);
    ok(vista.riepilogo.startsWith('5 '), `il riepilogo mostra il totale di "prodotti" (${vista.riepilogo})`);

    ok(scrittura.testoOriginale != null, 'l\'editor si è aperto sulla cella di "prodotti"');
    ok(scrittura.numeroScritture === 1, `una sola scrittura emessa (${scrittura.numeroScritture})`);
    ok(scrittura.collBersaglio === 'prodotti',
      `la scrittura raggiunge "prodotti", non la collezione a cui il riquadro è passato dopo`,
      `bersaglio ricevuto: ${scrittura.collBersaglio}`);
    ok(scrittura.dbBersaglio === 'negozio', 'il database di scrittura resta quello originario');
    ok(scrittura.idBersaglio === '100', `l'_id scritto è quello della riga originale di "prodotti" (${scrittura.idBersaglio})`);

    ok(errori.length === 0, 'nessun errore JS nella pagina', errori.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
  if (falliti) {
    console.error(`\n--- Bersaglio riquadro: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Bersaglio riquadro: tutti i test superati ---');
})();
