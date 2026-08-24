'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): il pannello FK appartiene alla griglia che lo ha aperto.
 *
 * Non serve un database reale: il socket finto risponde con righe diverse per
 * ciascun bersaglio e registra il payload. In questo modo il test distingue il
 * difetto preciso (uso implicito del tab/griglia attivi) da un semplice errore
 * di disegno.
 *
 * Uso: node test/e2e-fk-viste.js
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
  console.log('--- E2E: chiavi esterne in più griglie indipendenti ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3148 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fk-pannello', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(800);

    const esito = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const { apriPannelloFk, chiudiPannelloFk } = await import('/js/fk-vista.js');
      const inline = await import('/js/inlineEdit.js');
      const { state } = await import('/js/state.js');
      const { renderGrid } = await import('/js/grid.js');

      const tabA = createTab({ id: 'tab-fk-a', connName: null });
      const tabB = createTab({ id: 'tab-fk-b', connName: null });
      for (const tab of [tabA, tabB]) {
        tab.dbType = 'mysql';
        tab.state.connected = true;
      }
      tabA.state.db = 'vendite_a';
      tabA.state.coll = 'ordini_a';
      tabB.state.db = 'vendite_b';
      tabB.state.coll = 'ordini_b';
      tabs.activeId = tabB.id; // apposta diverso dall'origine della prima griglia

      const relazioneA = {
        campo: 'cliente_id', db: 'anagrafiche_a', tabella: 'clienti_a',
        colonna: 'id_a', origine: 'vincolo', molti: false,
      };
      const relazioneB = {
        campo: 'fornitore_id', db: 'anagrafiche_b', tabella: 'fornitori_b',
        colonna: 'id_b', origine: 'euristica', molti: false,
      };
      const richieste = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          richieste.push({ evento, msg: structuredClone(msg) });
          if (!cb) return;
          if (evento !== 'collection:find') { cb({ ok: true }); return; }
          const righe = msg.coll === 'clienti_a'
            ? [{ id_a: 10, nome: 'Ada' }, { id_a: 11, nome: 'Bruna' }]
            : [{ id_b: 20, nome: 'Carlo' }, { id_b: 21, nome: 'Dario' }];
          const filtrata = msg.filtro && msg.filtro.condizioni
            ? righe.filter((r) => r[msg.filtro.condizioni[0].campo] === msg.filtro.condizioni[0].valore)
            : righe;
          cb({ ok: true, docs: filtrata, columns: Object.keys(righe[0]), total: filtrata.length });
        },
        on: () => {},
        off: () => {},
      });

      // Due istanze minime: ciascuna riceve il PROPRIO indice di relazioni. La
      // decorazione riproduce il contratto di una griglia con `chiaviEsterne`.
      const creaGriglia = (nome, doc, relazione, ctx) => {
        const wrap = document.createElement('div');
        wrap.dataset.griglia = nome;
        const td = document.createElement('td');
        const testo = String(doc[relazione.campo]);
        td.textContent = testo;
        td.classList.add('editable', 'fk-cella');
        if (relazione.origine !== 'vincolo') td.classList.add('fk-ipotesi');
        td.title = `${testo}\n🔗 ${relazione.tabella}.${relazione.colonna}`;
        wrap.appendChild(td);
        document.body.appendChild(wrap);
        td.addEventListener('dblclick', () => inline.startEdit(td, doc, relazione.campo, {
          ctx,
          relazione,
          sorgente: wrap,
          contenitore: wrap,
          onRender: () => {},
        }));
        return { wrap, td };
      };

      const grigliaA = creaGriglia('a', { _id: 'oa', cliente_id: 10 }, relazioneA,
        { tabId: tabA.id, db: 'vendite_a', coll: 'ordini_a', isStillActive: () => false });
      const grigliaB = creaGriglia('b', { _id: 'ob', fornitore_id: 20 }, relazioneB,
        { tabId: tabB.id, db: 'vendite_b', coll: 'ordini_b', isStillActive: () => false });

      const indicatori = {
        aFk: grigliaA.td.classList.contains('fk-cella'),
        aIpotesi: grigliaA.td.classList.contains('fk-ipotesi'),
        aTitle: grigliaA.td.title,
        bFk: grigliaB.td.classList.contains('fk-cella'),
        bIpotesi: grigliaB.td.classList.contains('fk-ipotesi'),
        bTitle: grigliaB.td.title,
      };

      let scelto;
      apriPannelloFk({
        relazione: relazioneA,
        valore: 10,
        dbCorrente: 'vendite_a',
        tabId: tabA.id,
        sorgente: grigliaA.wrap,
        contenitore: grigliaA.wrap,
        onScegli: (v) => { scelto = v; },
      });
      await new Promise((r) => setTimeout(r, 30));
      const titoloA = document.querySelector('#fk-title').textContent;
      const voceA = [...document.querySelectorAll('#fk-elenco .fk-voce')]
        .find((el) => el.textContent.includes('11'));
      if (voceA) voceA.click();
      document.querySelector('#fk-usa').click();

      const richiesteA = richieste.filter((r) => r.evento === 'collection:find' && r.msg.coll === 'clienti_a');
      const rigaA = richiesteA.find((r) => r.msg.limit === 1);

      // La seconda apertura deve sostituire la prima senza ereditarne relazione,
      // tab, database, righe o callback.
      apriPannelloFk({
        relazione: relazioneB,
        valore: 20,
        dbCorrente: 'vendite_b',
        tabId: tabB.id,
        sorgente: grigliaB.wrap,
        contenitore: grigliaB.wrap,
        onScegli: () => {},
      });
      await new Promise((r) => setTimeout(r, 30));
      const titoloB = document.querySelector('#fk-title').textContent;
      const richiesteB = richieste.filter((r) => r.evento === 'collection:find' && r.msg.coll === 'fornitori_b');
      chiudiPannelloFk();

      // Anche il percorso di modifica riceve relazione e bersaglio dal chiamante,
      // mentre il Proxy globale punta volutamente all'altra connessione.
      grigliaA.td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      const richiesteInline = richieste.filter((r) => r.evento === 'collection:find' && r.msg.coll === 'clienti_a');
      const inlineAperto = !document.querySelector('#fk-pannello').classList.contains('hidden');
      // Il tab attivo è ancora B: «Apri tabella» deve tornare alla connessione
      // che ha originato il pannello prima di creare il coll-tab collegato.
      document.querySelector('#fk-apri').click();
      await new Promise((r) => setTimeout(r, 30));
      const aperturaTabella = {
        activeId: tabs.activeId,
        inA: tabA.state.collTabs.some((ct) => ct.db === 'anagrafiche_a' && ct.coll === 'clienti_a'),
        inB: tabB.state.collTabs.some((ct) => ct.db === 'anagrafiche_a' && ct.coll === 'clienti_a'),
      };

      // Vista Dati: la firma storica senza opzioni continua ad aprire l'editor.
      tabs.activeId = tabB.id;
      state.docs = [{ _id: 1, nome: 'normale' }];
      state.columns = ['_id', 'nome'];
      state.total = 1;
      renderGrid();
      const datiTd = document.querySelector('#grid tbody td[data-c="1"]');
      if (datiTd) datiTd.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const datiFunziona = !!(datiTd && datiTd.classList.contains('editing') && datiTd.querySelector('input'));
      const datiInput = datiTd && datiTd.querySelector('input');
      if (datiInput) datiInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      impostaSocket(null);
      return {
        indicatori, scelto, titoloA, titoloB, inlineAperto, aperturaTabella, datiFunziona,
        rigaA: rigaA && rigaA.msg,
        richiesteA: richiesteA.map((r) => r.msg),
        richiesteB: richiesteB.map((r) => r.msg),
        richiesteInline: richiesteInline.map((r) => r.msg),
      };
    });

    ok(esito.indicatori.aFk && !esito.indicatori.aIpotesi,
      'la prima griglia marca una FK dichiarata con `fk-cella`');
    ok(esito.indicatori.bFk && esito.indicatori.bIpotesi,
      'la seconda griglia distingue l\'euristica con `fk-ipotesi`');
    ok(esito.indicatori.aTitle.endsWith('🔗 clienti_a.id_a')
      && esito.indicatori.bTitle.endsWith('🔗 fornitori_b.id_b'),
    'gli indicatori mostrano nel title la propria tabella e colonna');
    ok(esito.rigaA && esito.rigaA.tabId === 'tab-fk-a'
      && esito.rigaA.db === 'anagrafiche_a' && esito.rigaA.coll === 'clienti_a',
    'la riga riferita usa tabId, database e tabella della griglia A');
    ok(esito.rigaA && JSON.stringify(esito.rigaA.filtro) === JSON.stringify({
      condizioni: [{ campo: 'id_a', operatore: 'uguale', valore: 10 }],
    }), 'la riga riferita usa il filtro strutturato corretto');
    ok(esito.scelto === 11, '`onScegli` riceve il valore selezionato nell\'elenco');
    ok(esito.titoloA === 'anagrafiche_a.clienti_a.id_a'
      && esito.titoloB === 'anagrafiche_b.fornitori_b.id_b',
    'due griglie conservano titoli e relazioni distinti');
    ok(esito.richiesteB.length === 2 && esito.richiesteB.every((m) => m.tabId === 'tab-fk-b'
      && m.db === 'anagrafiche_b' && m.coll === 'fornitori_b'),
    'la griglia B non eredita richieste o contesto dalla griglia A');
    ok(esito.inlineAperto && esito.richiesteInline.length >= 4
      && esito.richiesteInline.slice(-2).every((m) => m.tabId === 'tab-fk-a'),
    '`startEdit` usa relazione e contesto espliciti del chiamante',
    JSON.stringify({ inlineAperto: esito.inlineAperto, richieste: esito.richiesteInline }));
    ok(esito.aperturaTabella.activeId === 'tab-fk-a'
      && esito.aperturaTabella.inA && !esito.aperturaTabella.inB,
    '«Apri tabella» rispetta il tabId della griglia di provenienza');
    ok(esito.datiFunziona, 'la vista Dati continua ad aprire la modifica inline senza opzioni');

    /* --- Due riquadri Split-View reali su connessioni diverse ---------- */

    const paginaSplit = await browser.newPage();
    paginaSplit.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await paginaSplit.goto(server.url, { waitUntil: 'domcontentloaded' });
    await paginaSplit.waitForSelector('#fk-pannello', { state: 'attached', timeout: 15000 });
    await paginaSplit.waitForTimeout(800);

    const reale = await paginaSplit.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const sv = await import('/js/splitview.js');

      const relazioni = {
        ordini_a: [{
          campo: 'cliente_id', db: 'anagrafiche_a', tabella: 'clienti_a',
          colonna: 'id_a', origine: 'vincolo', molti: false,
        }],
        ordini_b: [{
          campo: 'fornitore_id', db: 'anagrafiche_b', tabella: 'fornitori_b',
          colonna: 'id_b', origine: 'euristica', molti: false,
        }],
      };
      const righe = {
        ordini_a: [{ _id: 'oa', cliente_id: 10 }],
        ordini_b: [{ _id: 'ob', fornitore_id: 20 }],
        clienti_a: [{ id_a: 10, nome: 'Ada' }, { id_a: 11, nome: 'Bruna' }],
        fornitori_b: [{ id_b: 20, nome: 'Carlo' }, { id_b: 21, nome: 'Dario' }],
      };
      const richieste = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          richieste.push({ evento, msg: structuredClone(msg) });
          if (!cb) return;
          if (evento === 'collection:relations') {
            cb({ ok: true, relazioni: relazioni[msg.coll] || [] });
            return;
          }
          if (evento === 'collection:find') {
            const tutte = righe[msg.coll] || [];
            const filtrate = msg.filtro && msg.filtro.condizioni
              ? tutte.filter((r) => r[msg.filtro.condizioni[0].campo] === msg.filtro.condizioni[0].valore)
              : tutte;
            cb({
              ok: true, docs: filtrate,
              columns: filtrate[0] ? Object.keys(filtrate[0]) : [],
              total: filtrate.length, skip: 0, limit: msg.limit || 50,
            });
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });

      const host = createTab({ id: 'tab-fk-host', connName: null });
      const tabA = createTab({ id: 'tab-fk-split-a', connName: null });
      const tabB = createTab({ id: 'tab-fk-split-b', connName: null });
      for (const tab of [host, tabA, tabB]) {
        tab.dbType = 'mysql';
        tab.state.connected = true;
      }
      host.state.db = null;
      host.state.coll = null;
      tabs.activeId = host.id;

      sv.initSplitView();
      sv.addOrSplitPane(null, 'right', {
        tabId: tabA.id, db: 'vendite_a', coll: 'ordini_a',
      });
      await new Promise((r) => setTimeout(r, 80));
      const primo = sv.getSplitStateSnapshot().panes.find(([, p]) => p.coll === 'ordini_a')[0];
      sv.addOrSplitPane(primo, 'right', {
        tabId: tabB.id, db: 'vendite_b', coll: 'ordini_b',
      });
      await new Promise((r) => setTimeout(r, 150));

      const snap = sv.getSplitStateSnapshot();
      const cellaDi = (coll, campoIdx) => {
        const voce = snap.panes.find(([, p]) => p.coll === coll);
        return voce && document.querySelector(
          `.split-pane[data-pane-id="${voce[0]}"] td[data-r="0"][data-c="${campoIdx}"]`,
        );
      };
      const cellaA = cellaDi('ordini_a', 1);
      const cellaB = cellaDi('ordini_b', 1);
      if (!cellaA || !cellaB) return { assente: true, richieste };

      const indicatori = {
        aFk: cellaA.classList.contains('fk-cella'),
        aIpotesi: cellaA.classList.contains('fk-ipotesi'),
        aTitle: cellaA.title,
        bFk: cellaB.classList.contains('fk-cella'),
        bIpotesi: cellaB.classList.contains('fk-ipotesi'),
        bTitle: cellaB.title,
      };
      cellaA.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const titolo = document.querySelector('#fk-title').textContent;
      const richiesteCandidati = richieste.filter((r) =>
        r.evento === 'collection:find' && r.msg.coll === 'clienti_a');
      impostaSocket(null);
      return { assente: false, indicatori, titolo, richiesteCandidati };
    });

    ok(!reale.assente, 'Split-View: entrambi i riquadri reali disegnano le proprie righe');
    ok(reale.indicatori && reale.indicatori.aFk && !reale.indicatori.aIpotesi
      && reale.indicatori.bFk && reale.indicatori.bIpotesi,
    'Split-View: ogni riquadro distingue vincolo dichiarato ed euristica');
    ok(reale.indicatori && reale.indicatori.aTitle.endsWith('🔗 clienti_a.id_a')
      && reale.indicatori.bTitle.endsWith('🔗 fornitori_b.id_b'),
    'Split-View: gli indicatori appartengono alla relazione della propria connessione');
    ok(reale.titolo === 'anagrafiche_a.clienti_a.id_a',
      `Split-View: il pannello usa il bersaglio del riquadro A (${reale.titolo})`);
    ok(reale.richiesteCandidati && reale.richiesteCandidati.length === 2
      && reale.richiesteCandidati.every((r) => r.msg.tabId === 'tab-fk-split-a'),
    'Split-View: riga riferita ed elenco usano il tabId del riquadro A');
    await paginaSplit.close();

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Chiavi esterne: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Chiavi esterne: tutti i test superati ---');
})();
