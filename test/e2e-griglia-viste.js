'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): le tre viste che disegnano una griglia usano lo stesso
 * modulo, e nel DOM vero.
 *
 * Il test unitario di `griglia.js` gira con un documento finto: prova
 * l'aritmetica e l'ordine dei nodi, non il DOM. Qui si prova ciò che quello non
 * può — che nel browser vero, attraverso le funzioni di render delle viste
 * reali, le righe compaiano e gli spaziatori dichiarino l'altezza giusta.
 *
 * Non serve un database: le funzioni di render ricevono righe e colonne, e
 * fabbricarle qui è più preciso che dipendere dal contenuto di una collection.
 * Il server è l'istanza usa e getta di e2e-harness.
 *
 * Uso: node test/e2e-griglia-viste.js
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
  console.log('--- E2E: il modulo unico della griglia nelle viste reali ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3144 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);

    /* --- Vista Dati: sotto e sopra la soglia di virtualizzazione --------- */

    const dati = await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      const { renderGrid } = await import('/js/grid.js');
      const { SOGLIA_VIRTUALE } = await import('/js/griglia.js');

      const misura = (n) => {
        state.docs = Array.from({ length: n }, (_, i) => ({ _id: i + 1, nome: `riga ${i}` }));
        state.columns = ['_id', 'nome'];
        state.total = n;
        renderGrid();
        const tbody = document.querySelector('#grid tbody');
        const spaziatori = [...tbody.querySelectorAll('tr.v-spacer')];
        const righe = [...tbody.querySelectorAll('tr')].filter((tr) => !tr.classList.contains('v-spacer'));
        return {
          righe: righe.length,
          spaziatori: spaziatori.length,
          // Altezza dichiarata dagli spaziatori più quella delle righe vere:
          // è ciò che la barra di scorrimento userà.
          altezzaSpaziatori: spaziatori.reduce(
            (a, tr) => a + parseInt(tr.querySelector('td').style.height || '0', 10), 0
          ),
          primaCella: righe.length ? righe[0].textContent.includes('riga 0') : false,
        };
      };

      return { soglia: SOGLIA_VIRTUALE, piccola: misura(20), grande: misura(3000) };
    });

    ok(dati.piccola.righe === 20, `vista Dati sotto la soglia: tutte le 20 righe disegnate (${dati.piccola.righe})`);
    ok(dati.piccola.spaziatori === 0, 'vista Dati sotto la soglia: nessuno spaziatore');
    ok(dati.piccola.primaCella, 'vista Dati: la prima riga contiene davvero il suo dato');

    ok(dati.grande.righe > 0 && dati.grande.righe < 3000,
      `vista Dati sopra la soglia: solo la finestra visibile in DOM (${dati.grande.righe} di 3000)`);
    ok(dati.grande.spaziatori >= 1,
      `vista Dati sopra la soglia: spaziatori presenti (${dati.grande.spaziatori})`);
    ok(dati.grande.altezzaSpaziatori > 0,
      'vista Dati: gli spaziatori dichiarano l\'altezza delle righe non disegnate');

    /* --- Tab ⚡: la stessa griglia, capacità diverse --------------------- */

    const risultati = await page.evaluate(async () => {
      const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
      // `renderResults` riceve l'ARRAY delle righe, non l'esito del server.
      setResultsViewMode('table');
      const misura = (n) => {
        renderResults(Array.from({ length: n }, (_, i) => ({ id: i + 1, nome: `res ${i}` })));
        const tbody = document.querySelector('#query-result-table tbody');
        if (!tbody) return { assente: true };
        const spaziatori = [...tbody.querySelectorAll('tr.v-spacer')];
        const righe = [...tbody.querySelectorAll('tr')].filter((tr) => !tr.classList.contains('v-spacer'));
        return {
          righe: righe.length,
          spaziatori: spaziatori.length,
          altezzaSpaziatori: spaziatori.reduce(
            (a, tr) => a + parseInt(tr.querySelector('td').style.height || '0', 10), 0
          ),
          primaCella: righe.length ? righe[0].textContent.includes('res 0') : false,
        };
      };
      return { piccola: misura(20), grande: misura(3000) };
    });

    ok(!risultati.piccola.assente, 'tab ⚡: la tabella dei risultati è nel DOM');
    ok(risultati.piccola.righe === 20,
      `tab ⚡ sotto la soglia: tutte le 20 righe disegnate (${risultati.piccola.righe})`);
    ok(risultati.piccola.spaziatori === 0, 'tab ⚡ sotto la soglia: nessuno spaziatore');
    ok(risultati.piccola.primaCella, 'tab ⚡: la prima riga contiene davvero il suo dato');
    ok(risultati.grande.righe > 0 && risultati.grande.righe < 3000,
      `tab ⚡ sopra la soglia: solo la finestra visibile in DOM (${risultati.grande.righe} di 3000)`);
    ok(risultati.grande.spaziatori >= 1,
      `tab ⚡ sopra la soglia: spaziatori presenti (${risultati.grande.spaziatori})`);
    ok(risultati.grande.altezzaSpaziatori > 0,
      'tab ⚡: gli spaziatori dichiarano l\'altezza delle righe non disegnate');

    /* --- Il modulo comune contro il DOM vero ---------------------------- */

    const modulo = await page.evaluate(async () => {
      const g = await import('/js/griglia.js');
      const tabella = document.createElement('table');
      const tbody = document.createElement('tbody');
      tabella.appendChild(tbody);
      document.body.appendChild(tabella);
      const righe = Array.from({ length: 500 }, (_, i) => i);
      const finestra = g.finestraVirtuale({
        scrollTop: 1000, altezzaViewport: 400, altezzaRiga: 40, righeTotali: 500, overscan: 8,
      });
      g.disegnaCorpo({
        tbody,
        righe,
        disegnaRiga: (v) => {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.textContent = String(v);
          tr.appendChild(td);
          return tr;
        },
        finestra,
        colonneTotali: 1,
      });
      const nodi = [...tbody.children];
      const alto = nodi[0];
      const basso = nodi[nodi.length - 1];
      const esito = {
        primoSpaziatore: alto.classList.contains('v-spacer'),
        ultimoSpaziatore: basso.classList.contains('v-spacer'),
        // Le altezze DICHIARATE dagli spaziatori: sono ciò che il modulo
        // controlla. L'altezza delle righe vere la decide il browser dal
        // contenuto, e confrontarla proverebbe il CSS, non questo codice.
        sopra: parseInt(alto.querySelector('td').style.height, 10),
        sotto: parseInt(basso.querySelector('td').style.height, 10),
        disegnate: nodi.length - 2,
        attesa: 500 * 40,
        primoValore: nodi[1] ? nodi[1].textContent : null,
        atteso: String(finestra.inizio),
      };
      tabella.remove();
      return esito;
    });

    ok(modulo.primoSpaziatore && modulo.ultimoSpaziatore,
      'modulo comune: le righe stanno fra due spaziatori');
    ok(modulo.primoValore === modulo.atteso,
      `modulo comune: la prima riga disegnata è quella giusta (${modulo.primoValore} atteso ${modulo.atteso})`);
    // La proprietà che tiene onesta la barra di scorrimento, misurata sugli
    // spaziatori veri messi nel DOM: spazio sopra + righe disegnate + spazio
    // sotto deve fare l'altezza totale del dataset.
    const totale = modulo.sopra + modulo.disegnate * 40 + modulo.sotto;
    ok(totale === modulo.attesa,
      `modulo comune: gli spaziatori nel DOM coprono le righe non disegnate (${totale} contro ${modulo.attesa})`);

    /* --- Split-View: la terza copia, ora virtualizzata ------------------ */

    const riquadro = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const sv = await import('/js/splitview.js');

      // Un tab connesso finto e una collection aperta: è la condizione da cui
      // la Split-View promuove il primo riquadro.
      const tab = createTab({ connName: null });
      tabs.activeId = tab.id;
      tab.dbType = 'mongodb';
      tab.state.connected = true;
      tab.state.db = 'prova';
      tab.state.coll = 'grande';
      tab.state.limit = 5000;
      tab.state.docs = Array.from({ length: 3000 }, (_, i) => ({ _id: i + 1, nome: `pane ${i}` }));
      tab.state.columns = ['_id', 'nome'];
      tab.state.total = 3000;

      sv.initSplitView();
      // Nessun bersaglio: si apre una nuova area promuovendo la collection
      // aperta a primo riquadro.
      sv.addOrSplitPane(null, 'right', { tabId: tab.id, db: 'prova', coll: 'grande' });
      sv.renderSplitView();

      const tbody = document.querySelector('.split-pane .pane-grid tbody');
      if (!tbody) return { assente: true };
      const spaziatori = [...tbody.querySelectorAll('tr.v-spacer')];
      const righe = [...tbody.querySelectorAll('tr')].filter((tr) => !tr.classList.contains('v-spacer'));
      return {
        righe: righe.length,
        spaziatori: spaziatori.length,
        altezzaSpaziatori: spaziatori.reduce(
          (a, tr) => a + parseInt(tr.querySelector('td').style.height || '0', 10), 0
        ),
      };
    });

    ok(!riquadro.assente, 'Split-View: la griglia di un riquadro è nel DOM');
    ok(riquadro.righe > 0 && riquadro.righe < 3000,
      `Split-View: su 3.000 righe solo la finestra visibile è in DOM (${riquadro.righe})`);
    ok(riquadro.spaziatori >= 1 && riquadro.altezzaSpaziatori > 0,
      'Split-View: gli spaziatori dichiarano le righe non disegnate');

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Griglia nelle viste: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Griglia nelle viste: tutti i test superati ---');
})();
