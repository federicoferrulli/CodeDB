'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): la selezione di celle vive in PIÙ griglie, indipendenti.
 *
 * Il difetto che questo test protegge non è «la selezione non funziona»: è che
 * funzionava in una griglia sola perché il modulo cercava da sé il proprio
 * bersaglio (`#grid tbody`, `document.querySelectorAll`, il Proxy `state`). Con
 * due griglie a schermo, la selezione fatta in una si sarebbe vista — o peggio,
 * si sarebbe SCRITTA — nell'altra.
 *
 * Quindi si prova esattamente questo: due agganci nella stessa pagina, e la
 * dimostrazione che ciò che accade in uno non tocca l'altro; poi la stessa cosa
 * nel riquadro Split-View vero, che è il chiamante per cui il lavoro è stato
 * fatto.
 *
 * Non serve un database: gli agganci ricevono righe e colonne, e fabbricarle qui
 * è più preciso che dipendere dal contenuto di una collection.
 *
 * Uso: node test/e2e-selezione-celle-viste.js
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

// Costruisce nel browser una griglia finta completa (contenitore che scorre,
// thead con `data-c`, tbody con le celle) e le aggancia la selezione.
const FABBRICA = `
  window.__creaGriglia = async (nome, righe, colonne) => {
    const { creaSelezioneCelle } = await import('/js/cellselect.js');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'height:200px;overflow:auto';
    wrap.dataset.griglia = nome;
    const tabella = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    colonne.forEach((c, i) => {
      const th = document.createElement('th');
      th.dataset.c = i;
      th.textContent = c;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    const tbody = document.createElement('tbody');
    righe.forEach((doc, r) => {
      const tr = document.createElement('tr');
      colonne.forEach((c, i) => {
        const td = document.createElement('td');
        td.dataset.r = r;
        td.dataset.c = i;
        td.textContent = String(doc[c]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tabella.appendChild(thead);
    tabella.appendChild(tbody);
    wrap.appendChild(tabella);
    document.body.appendChild(wrap);

    const stato = { anchor: null, focus: null, cells: new Set() };
    const ist = creaSelezioneCelle({
      nome,
      tbody,
      thead: () => thead,
      contenitore: () => wrap,
      info: () => null,
      righe: () => righe,
      colonne: () => colonne,
      bersaglio: () => ({ db: 'prova', coll: nome, dbType: 'mysql' }),
      stato: () => stato,
      visibile: () => true,
      contesto: () => ({ tabId: nome, st: { db: 'prova', coll: nome, dbType: 'mysql' }, isStillActive: () => true }),
      assicuraRiga: () => {},
      ricarica: () => {},
      modificaRiga: () => {},
      eliminaRighe: () => {},
      motivoNoScrittura: () => null,
    });
    return { wrap, tbody, stato, ist };
  };
`;

(async () => {
  console.log('--- E2E: la selezione di celle in più griglie indipendenti ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3146 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.addScriptTag({ content: FABBRICA, type: 'module' });
    await page.waitForFunction(() => typeof window.__creaGriglia === 'function');

    /* --- Due griglie nella stessa pagina --------------------------------- */

    const due = await page.evaluate(async () => {
      const colonne = ['id', 'nome'];
      const righeA = Array.from({ length: 6 }, (_, i) => ({ id: i, nome: `a${i}` }));
      const righeB = Array.from({ length: 6 }, (_, i) => ({ id: i, nome: `b${i}` }));
      const A = await window.__creaGriglia('alfa', righeA, colonne);
      const B = await window.__creaGriglia('beta', righeB, colonne);
      window.__A = A; window.__B = B;

      // Un trascinamento vero su A: dalla cella (0,0) alla (2,1).
      const cella = (g, r, c) => g.tbody.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
      const giu = (td) => td.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
      const sopra = (td) => td.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      giu(cella(A, 0, 0));
      sopra(cella(A, 2, 1));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      const selezionate = (g) => [...g.tbody.querySelectorAll('td.cell-selected')].length;
      return {
        celleA: A.stato.cells.size,
        celleB: B.stato.cells.size,
        dipinteA: selezionate(A),
        dipinteB: selezionate(B),
        // Le due istanze non condividono l'oggetto di stato: è la ragione
        // strutturale per cui i due numeri qui sopra possono differire.
        statiDistinti: A.stato !== B.stato,
      };
    });

    ok(due.celleA === 6, `il trascinamento su alfa seleziona il rettangolo 3×2 (${due.celleA} celle)`);
    ok(due.celleB === 0, `beta resta intatta: nessuna cella selezionata (${due.celleB})`);
    ok(due.dipinteA === 6, `alfa: le 6 celle sono DIPINTE nel suo DOM (${due.dipinteA})`);
    ok(due.dipinteB === 0, `beta: nessuna cella dipinta nel suo DOM (${due.dipinteB})`);
    ok(due.statiDistinti, 'le due griglie hanno due oggetti di stato distinti');

    /* --- La tastiera va a UNA griglia sola ------------------------------- */

    const tastiera = await page.evaluate(() => {
      // L'ultima toccata è alfa (il trascinamento di prima): Ctrl+A deve
      // riempire alfa e lasciare beta a zero.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      const dopoAlfa = { a: window.__A.stato.cells.size, b: window.__B.stato.cells.size };
      // Ora si tocca beta: il comando passa a lei.
      window.__B.tbody.querySelector('td[data-r="1"][data-c="0"]')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      const dopoBeta = { a: window.__A.stato.cells.size, b: window.__B.stato.cells.size };
      return { dopoAlfa, dopoBeta };
    });

    ok(tastiera.dopoAlfa.a === 12 && tastiera.dopoAlfa.b === 0,
      `Ctrl+A va alla griglia toccata per ultima (alfa ${tastiera.dopoAlfa.a}, beta ${tastiera.dopoAlfa.b})`);
    ok(tastiera.dopoBeta.b === 12,
      `toccando beta il comando passa a lei: Ctrl+A la riempie (${tastiera.dopoBeta.b})`);
    ok(tastiera.dopoBeta.a === 12,
      `e alfa non viene toccata dal Ctrl+A di beta (${tastiera.dopoBeta.a})`);

    // Le due griglie finte escono di scena: da qui in poi si prova il chiamante
    // vero, e due agganci "sempre visibili" falserebbero l'arbitraggio.
    await page.evaluate(() => {
      window.__A.wrap.remove();
      window.__B.wrap.remove();
    });

    /* --- Il riquadro Split-View, cioè il chiamante vero ------------------ */

    const riquadro = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const sv = await import('/js/splitview.js');

      const tab = createTab({ connName: null });
      tabs.activeId = tab.id;
      tab.dbType = 'mongodb';
      tab.state.connected = true;
      tab.state.db = 'prova';
      tab.state.coll = 'clienti';
      tab.state.limit = 100;
      tab.state.docs = Array.from({ length: 8 }, (_, i) => ({ _id: i + 1, nome: `pane ${i}` }));
      tab.state.columns = ['_id', 'nome'];
      tab.state.total = 8;

      sv.initSplitView();
      sv.addOrSplitPane(null, 'right', { tabId: tab.id, db: 'prova', coll: 'clienti' });
      sv.renderSplitView();

      const tbody = document.querySelector('.split-pane .pane-grid tbody');
      if (!tbody) return { assente: true };
      const coordinate = !!tbody.querySelector('td[data-r][data-c]');

      const cella = (r, c) => tbody.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
      const partenza = cella(1, 0);
      if (!partenza) return { assente: false, coordinate, senzaCelle: true };
      partenza.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
      cella(3, 1).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      const dipinte = tbody.querySelectorAll('td.cell-selected').length;
      const fuoco = tbody.querySelectorAll('td.cell-focus').length;

      // La selezione deve SOPRAVVIVERE al ridisegno: la finestra virtuale
      // ricostruisce le righe a ogni scorrimento, e la vecchia Split-View non
      // aveva alcun punto in cui riapplicarla.
      sv.renderSplitView();
      const dopoRidisegno = document.querySelectorAll('.split-pane .pane-grid tbody td.cell-selected').length;

      // Il menu contestuale della selezione (copia, statistiche, duplica) deve
      // aprirsi anche qui: è la parte che nella vista Dati sta su `#grid`.
      cella(1, 0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));
      const menu = !!document.querySelector('.context-menu, #context-menu');

      // Le CLASSI da sole non bastano: le regole stavano su `#grid`, quindi in
      // un riquadro una selezione con le classi giuste sarebbe stata INVISIBILE.
      // Qui si misura lo stile calcolato, non il nome della classe.
      const scelta = tbody.querySelector('td.cell-selected');
      const nonScelta = tbody.querySelector('td[data-c]:not(.cell-selected)');
      const stile = {
        sfondoDiverso: getComputedStyle(scelta).backgroundColor
          !== getComputedStyle(nonScelta).backgroundColor,
        // `touch-action: none` sulle celle selezionate: senza, col dito la
        // tabella scorrerebbe invece di allargare la selezione.
        toccoBloccato: getComputedStyle(scelta).touchAction === 'none',
      };

      return { assente: false, coordinate, dipinte, fuoco, dopoRidisegno, menu, stile };
    });

    ok(!riquadro.assente, 'Split-View: la griglia di un riquadro è nel DOM');
    ok(riquadro.coordinate, 'Split-View: le celle di un riquadro portano riga e colonna (data-r/data-c)');
    ok(riquadro.dipinte === 6,
      `Split-View: il trascinamento dentro il riquadro seleziona il rettangolo 3×2 (${riquadro.dipinte} celle)`);
    ok(riquadro.fuoco === 1, `Split-View: una sola cella ha il fuoco (${riquadro.fuoco})`);
    ok(riquadro.dopoRidisegno === 6,
      `Split-View: la selezione sopravvive al ridisegno del riquadro (${riquadro.dopoRidisegno} celle)`);
    ok(riquadro.menu, 'Split-View: il menu contestuale della selezione si apre dentro il riquadro');
    ok(riquadro.stile && riquadro.stile.sfondoDiverso,
      'Split-View: la cella selezionata è DIPINTA davvero (il CSS non è più legato a #grid)');
    ok(riquadro.stile && riquadro.stile.toccoBloccato,
      'Split-View: sulla cella selezionata il dito non scorre (touch-action: none)');

    /* --- Il BERSAGLIO delle scritture è il riquadro, non il tab attivo ---- */

    // È il difetto che la issue chiama per nome: «scrive silenziosamente su
    // quello sbagliato». Non basta leggere il codice, e non basta nemmeno un
    // riquadro qualsiasi: serve la condizione vera, cioè un riquadro che
    // appartiene a una connessione DIVERSA da quella del tab attivo, che è il
    // caso in cui `state` (Proxy sul tab attivo) e il riquadro non coincidono.
    //
    // Il socket è finto — `impostaSocket` esiste per questo — così la prova non
    // dipende da un database: serve il riquadro con le sue righe e registra ciò
    // che viene spedito.
    // Pagina NUOVA: la sezione precedente ha già aperto una Split-View, e
    // riusarla farebbe provare il riquadro sbagliato.
    const pagina2 = await browser.newPage();
    pagina2.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await pagina2.goto(server.url, { waitUntil: 'domcontentloaded' });
    await pagina2.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await pagina2.waitForTimeout(1500);

    const bersaglio = await pagina2.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { state } = await import('/js/state.js');
      const { impostaSocket } = await import('/js/socket.js');
      const sv = await import('/js/splitview.js');

      const spediti = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          spediti.push({ evento, tabId: msg.tabId, db: msg.db, coll: msg.coll });
          if (!cb) return;
          if (evento === 'collection:find') {
            cb({
              ok: true,
              docs: Array.from({ length: 4 }, (_, i) => ({ _id: i + 1, nome: `r${i}` })),
              columns: ['_id', 'nome'],
              total: 4, skip: 0, limit: 50,
            });
          } else cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });

      // Il tab ATTIVO: è quello a cui punta il Proxy `state`.
      const attivo = createTab({ connName: null });
      attivo.dbType = 'mysql';
      attivo.state.connected = true;
      attivo.state.db = 'db_del_tab_attivo';
      attivo.state.coll = 'tabella_del_tab_attivo';
      attivo.state.docs = [];
      attivo.state.columns = [];
      // Il tab del RIQUADRO: un'altra connessione, un'altra tabella.
      const altro = createTab({ connName: null });
      altro.dbType = 'mysql';
      altro.state.connected = true;
      tabs.activeId = attivo.id;

      sv.initSplitView();
      sv.addOrSplitPane(null, 'right', { tabId: altro.id, db: 'db_del_riquadro', coll: 'tabella_del_riquadro' });
      sv.renderSplitView();
      await new Promise((r) => setTimeout(r, 300));

      const proxyDice = { db: state.db, coll: state.coll };
      // L'area ha due riquadri: quello promosso dalla collection del tab attivo
      // (vuota) e quello che ci interessa. Si prende quello che ha davvero righe.
      const tbody = [...document.querySelectorAll('.split-pane .pane-grid tbody')]
        .find((t) => t.querySelector('td[data-r]'));
      const cella = tbody && tbody.querySelector('td[data-r="0"][data-c="1"]');
      if (!cella) {
        impostaSocket(null);
        return {
          proxyDice,
          senzaCella: true,
          scritture: [],
        };
      }

      // Si tocca una cella del riquadro (il comando passa a lui) e si incolla.
      cella.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      // L'incolla si lancia dalla voce di menu «Incolla (Ctrl+V)», che è il
      // percorso vero: un evento `paste` sintetico non porta `clipboardData` in
      // Chromium, quindi proverebbe solo che il gestore esiste.
      const confermaVera = window.confirm;
      window.confirm = () => true;
      const appuntiVeri = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: () => Promise.resolve('incollato'), writeText: () => Promise.resolve() },
      });
      cella.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
      const voce = [...document.querySelectorAll('#context-menu li')]
        .find((li) => li.textContent.startsWith('Incolla'));
      if (voce) voce.click();
      await new Promise((r) => setTimeout(r, 400));
      window.confirm = confermaVera;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: appuntiVeri });

      impostaSocket(null);
      return {
        proxyDice,
        idAltro: altro.id,
        idAttivo: attivo.id,
        scritture: spediti.filter((m) => m.evento === 'doc:update'),
      };
    });

    ok(bersaglio.proxyDice.coll === 'tabella_del_tab_attivo',
      'il Proxy `state` punta al tab attivo, non al riquadro: la condizione del difetto e riprodotta');
    ok(!bersaglio.senzaCella && bersaglio.scritture.length === 1,
      `l'incolla dentro il riquadro produce una scrittura (${bersaglio.scritture ? bersaglio.scritture.length : 0} doc:update)`);
    const scritto = (bersaglio.scritture && bersaglio.scritture[0]) || {};
    ok(scritto.db === 'db_del_riquadro' && scritto.coll === 'tabella_del_riquadro',
      `la scrittura va sulla tabella del RIQUADRO, non su quella del tab attivo (${scritto.db}.${scritto.coll})`);
    ok(scritto.tabId === bersaglio.idAltro && scritto.tabId !== bersaglio.idAttivo,
      'e sulla connessione del riquadro: il tabId congelato non è quello del tab attivo (CDB-A18)');
    await pagina2.close();

    /* --- La modifica inline nel riquadro non è stata sacrificata ---------- */

    // `user-select: none` serve al trascinamento della selezione, ma dentro
    // l'editor di una cella impedirebbe di scegliere una parte del valore: la
    // vista Dati aveva già l'eccezione, scritta però su `#grid`. Un riquadro ha
    // `modificaInline` acceso, quindi qui l'eccezione deve valere identica.
    const modifica = await page.evaluate(async () => {
      const tbody = [...document.querySelectorAll('.split-pane .pane-grid tbody')]
        .find((t) => t.querySelector('td[data-r]'));
      if (!tbody) return { assente: true };
      const td = tbody.querySelector('td[data-r="0"][data-c="1"]');
      td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const inEditor = td.classList.contains('editing');
      const testoSelezionabile = getComputedStyle(td).userSelect !== 'none';
      const campo = !!td.querySelector('input, textarea, select');
      return { assente: false, inEditor, testoSelezionabile, campo };
    });

    ok(!modifica.assente && modifica.inEditor,
      'Split-View: il doppio clic apre ancora la modifica inline della cella');
    ok(modifica.campo, 'Split-View: la cella in modifica contiene davvero un campo di testo');
    ok(modifica.testoSelezionabile,
      'Split-View: nella cella in modifica il testo resta selezionabile (user-select non spento dalla selezione)');

    /* --- La vista Dati non è cambiata ------------------------------------ */

    const dati = await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      const { renderGrid } = await import('/js/grid.js');
      const { applyCellSelection } = await import('/js/cellselect.js');
      document.querySelector('#view-data').classList.remove('hidden');
      state.docs = Array.from({ length: 5 }, (_, i) => ({ _id: i + 1, nome: `riga ${i}` }));
      state.columns = ['_id', 'nome'];
      state.total = 5;
      state.cellSel = null;
      renderGrid();
      const tbody = document.querySelector('#grid tbody');
      const cella = (r, c) => tbody.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
      cella(0, 0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
      cella(1, 1).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      const dipinte = tbody.querySelectorAll('td.cell-selected').length;
      // Lo stato sta ancora dove stava: sul tab, non in una variabile del modulo.
      const suTab = !!(state.cellSel && state.cellSel.cells.size === 4);
      // Il ridisegno della griglia riapplica la selezione dalla stessa porta di
      // sempre (`applyCellSelection` senza argomenti, come la chiama grid.js).
      renderGrid();
      applyCellSelection();
      const dopoRender = tbody.querySelectorAll('td.cell-selected').length;
      // La classe che porta le regole CSS di tocco e selezione.
      const marcata = tbody.classList.contains('selezione-celle');
      return { dipinte, suTab, dopoRender, marcata };
    });

    ok(dati.dipinte === 4, `vista Dati: il trascinamento seleziona 2×2 come sempre (${dati.dipinte})`);
    ok(dati.suTab, 'vista Dati: lo stato della selezione resta in `state.cellSel`');
    ok(dati.dopoRender === 4, `vista Dati: applyCellSelection() ridipinge dopo un render (${dati.dopoRender})`);
    ok(dati.marcata, 'vista Dati: il tbody è marcato `.selezione-celle` (le regole CSS seguono la capacità)');

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Selezione di celle: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Selezione di celle: tutti i test superati ---');
})();
