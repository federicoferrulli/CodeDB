'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E: la palette dei comandi (Ctrl+P).
 *
 * PERCHÉ ESISTE. Due difetti, entrambi silenziosi.
 *
 * 1. L'albero tiene i database in cache come oggetti (`{ name, collections? }`,
 *    vedi renderDbTree); la palette li leggeva dalla stessa cache e li trattava
 *    come stringhe. In elenco comparivano righe «[object Object]», e — meno
 *    visibile ma peggio — lo stesso oggetto finiva come `db` nella richiesta
 *    `db:collections`, quindi le tabelle non arrivavano MAI.
 * 2. Le risposte che arrivavano venivano poi buttate: il callback che doveva
 *    fonderle nell'elenco ignorava il proprio argomento.
 *
 * E una funzione: con le tabelle di TUTTI i database l'elenco passa da una
 * decina di voci a qualche migliaio, quindi la lista è virtualizzata. Ciò che
 * qui si prova è proprio quello che un test unitario non può vedere: che in
 * DOM ci stiano poche righe anche con migliaia di voci, che scorrere non ne
 * accumuli, e che la riga scelta con le frecce venga portata in vista anche
 * quando non è disegnata.
 *
 * Non serve un database: il socket si sostituisce (`impostaSocket`) con uno
 * finto che risponde a `db:collections`, e lo stato del tab è la stessa istanza
 * che usano i moduli ESM già valutati.
 *
 * Uso: node test/e2e-palette.js
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

// Tre database, il secondo grosso: 1200 tabelle in tutto. Un numero che una
// lista non virtualizzata metterebbe tutto in DOM.
const DB_FINTI = { alfa: 100, beta: 1000, gamma: 100 };

/** Ctrl+P: l'ascoltatore del dispatcher sta sul document, in fase di cattura. */
const apriPalette = (page) => page.evaluate(() => document.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true })));

(async () => {
  console.log('--- E2E: palette dei comandi (Ctrl+P) ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_PALETTE_PORT, 10) || 3143 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const erroriJs = [];
    page.on('pageerror', (err) => erroriJs.push(String(err && err.message || err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });

    // Un tab attivo con tre database nella forma REALE dell'albero (oggetti) e
    // un socket finto che risponde con le tabelle.
    await page.evaluate(async (dbFinti) => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { renderDbTree } = await import('/js/dbtree.js');
      const { impostaSocket } = await import('/js/socket.js');

      const tab = createTab({ id: 'palette-test', connName: 'finta' });
      tabs.activeId = tab.id;
      tab.state.connected = true;
      const databases = Object.keys(dbFinti).map((name) => ({ name }));
      tab.state.databases = databases;
      renderDbTree(databases);

      window.__chieste = []; // i payload di db:collections, per controllarne la forma
      impostaSocket({
        on() {}, off() {}, once() {}, connected: true,
        emit(evento, payload, ack) {
          if (evento !== 'db:collections') {
            if (typeof ack === 'function') ack({ ok: false, error: 'socket finto' });
            return;
          }
          window.__chieste.push(payload && payload.db);
          const n = dbFinti[payload && payload.db] || 0;
          const collections = Array.from({ length: n }, (_, i) => ({
            name: `${payload.db}_tab_${String(i).padStart(4, '0')}`, count: i,
          }));
          // Risposta asincrona, come quella vera.
          setTimeout(() => ack({ ok: true, collections }), 0);
        },
      });
    }, DB_FINTI);

    await apriPalette(page);
    await page.waitForSelector('#palette-overlay', { timeout: 5000 });
    // Le tabelle arrivano dopo: si aspetta che il piede smetta di dirlo.
    await page.waitForFunction(() => !/lettura tabelle/.test(document.querySelector('.palette-piede').textContent), null, { timeout: 10000 });

    /* --- I nomi, non gli oggetti ---------------------------------------- */

    const nomi = () => page.$$eval('#palette-lista .palette-voce', (li) => li.map((el) => ({
      tipo: el.querySelector('.palette-tipo').textContent.trim(),
      nome: el.querySelector('.palette-nome').textContent.trim(),
      nota: el.querySelector('.palette-nota').textContent.trim(),
    })));

    const visibili = await nomi();
    ok(!visibili.some((v) => v.nome.includes('[object')), 'nessuna voce «[object Object]» in palette',
      JSON.stringify(visibili.slice(0, 5)));

    const chieste = await page.evaluate(() => window.__chieste);
    ok(chieste.length === 3 && chieste.every((d) => typeof d === 'string'),
      'db:collections riceve il nome del database come stringa, per ogni database',
      `payload: ${JSON.stringify(chieste)}`);

    /* --- Le tabelle ci sono e la lista è virtualizzata -------------------- */

    const conteggio = await page.evaluate(() => {
      const piede = document.querySelector('.palette-stato').textContent;
      return {
        piede,
        totale: parseInt(piede, 10),
        inDom: document.querySelectorAll('#palette-lista .palette-voce').length,
        spazioSotto: parseInt(document.querySelectorAll('.palette-spazio')[1].style.height, 10),
      };
    });
    // 2 comandi + 3 database + 1200 tabelle (le connessioni salvate dipendono
    // dal vault dell'istanza di prova, quindi il confronto è "almeno").
    ok(conteggio.totale >= 1205, 'le tabelle di tutti i database sono in elenco',
      `piede: ${conteggio.piede}`);
    ok(conteggio.inDom > 0 && conteggio.inDom < 60,
      'in DOM ci sono solo le righe della finestra visibile',
      `righe in DOM: ${conteggio.inDom} su ${conteggio.totale}`);
    ok(conteggio.spazioSotto > 1000,
      'lo spaziatore sotto rende la barra di scorrimento coerente col totale',
      `spazio sotto: ${conteggio.spazioSotto}px`);

    /* --- La ricerca ------------------------------------------------------ */

    await page.fill('#palette-input', 'beta_tab_0777');
    await page.waitForTimeout(50);
    const trovate = await nomi();
    ok(trovate.length === 1 && trovate[0].nome === 'beta_tab_0777' && trovate[0].nota === 'beta',
      'si cerca una tabella per nome, col suo database come nota',
      JSON.stringify(trovate));

    await page.fill('#palette-input', 'gamma');
    await page.waitForTimeout(50);
    const perDb = await page.evaluate(() => parseInt(document.querySelector('.palette-stato').textContent, 10));
    ok(perDb === 101, 'cercare il nome del database trova il database e le sue 100 tabelle',
      `risultati: ${perDb}`);

    await page.fill('#palette-input', 'qwertyxzk');
    await page.waitForTimeout(50);
    const vuota = await page.evaluate(() => ({
      righe: document.querySelectorAll('#palette-lista .palette-voce').length,
      avviso: !document.querySelector('.palette-vuota').hidden,
    }));
    ok(vuota.righe === 0 && vuota.avviso, "un termine senza risultati lascia l'avviso, non una lista vuota",
      JSON.stringify(vuota));

    /* --- I richiami ------------------------------------------------------ */

    const conRichiamo = async (testo) => {
      await page.fill('#palette-input', testo);
      await page.waitForTimeout(50);
      return page.evaluate(() => ({
        totale: parseInt(document.querySelector('.palette-stato').textContent, 10),
        stato: document.querySelector('.palette-stato').textContent,
        legenda: document.querySelector('.palette-legenda').textContent,
        tipi: [...new Set([...document.querySelectorAll('#palette-lista .palette-voce')]
          .map((el) => el.querySelector('.palette-tipo').textContent.trim()))],
        primo: (document.querySelector('#palette-lista .palette-nome') || {}).textContent || '',
      }));
    };

    const soloDb = await conRichiamo('#');
    ok(soloDb.totale === 3 && soloDb.tipi.length === 1 && soloDb.tipi[0] === 'Database',
      '«#» cerca fra i soli database', JSON.stringify(soloDb));
    ok(/solo database/.test(soloDb.stato), 'il piede dice quale richiamo e\' attivo',
      soloDb.stato);

    const soloTab = await conRichiamo('@beta_tab_0500');
    ok(soloTab.tipi.join() === 'Tabella' && soloTab.primo === 'beta_tab_0500',
      '«@» cerca fra le sole tabelle', JSON.stringify(soloTab));

    const soloCmd = await conRichiamo('>conness');
    ok(soloCmd.totale >= 1 && soloCmd.tipi.join() === 'Comando',
      '«>» cerca fra i soli comandi — non fra le connessioni, che sono un\'altra cosa',
      JSON.stringify(soloCmd));

    // Il richiamo RESTRINGE: lo stesso termine senza richiamo porta su anche
    // altri tipi. Senza questo controllo un filtro che non filtra passerebbe.
    const senza = await conRichiamo('alfa');
    ok(senza.tipi.length > 1 || senza.totale > (await conRichiamo('#alfa')).totale,
      'lo stesso termine senza richiamo non e\' ristretto a un tipo',
      JSON.stringify(senza));

    // Un carattere che non e' un richiamo resta parte del nome cercato.
    // (`_qwerty` non corrisponde a nulla: se `_` venisse mangiato come richiamo
    // ignoto, resterebbe `qwerty` — che invece non cambierebbe l'esito. Serve
    // quindi un termine il cui PRIMO carattere e' l'unico a fare la differenza.)
    const nonRichiamo = await conRichiamo('_beta_tab_0500');
    ok(nonRichiamo.totale === 0,
      'un carattere qualunque in testa non viene scambiato per un richiamo',
      JSON.stringify(nonRichiamo));

    const legenda = await conRichiamo('');
    ok(/> comandi/.test(legenda.legenda) && /# database/.test(legenda.legenda)
      && /@ tabelle/.test(legenda.legenda),
      'il piede insegna i richiami finche\' non se ne usa uno', legenda.legenda);

    /* --- Scorrimento e frecce ------------------------------------------- */
    /* --- Scorrimento e frecce ------------------------------------------- */

    await page.fill('#palette-input', '');
    await page.waitForTimeout(50);
    const dopoScorrimento = await page.evaluate(async () => {
      const lista = document.querySelector('#palette-lista');
      lista.scrollTop = lista.scrollHeight; // fino in fondo
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const righe = [...document.querySelectorAll('#palette-lista .palette-voce')];
      return {
        inDom: righe.length,
        ultima: righe.length ? righe[righe.length - 1].querySelector('.palette-nome').textContent : '',
        spazioSopra: parseInt(document.querySelectorAll('.palette-spazio')[0].style.height, 10),
      };
    });
    ok(dopoScorrimento.inDom < 60, 'scorrere non accumula righe in DOM',
      `righe in DOM dopo lo scorrimento: ${dopoScorrimento.inDom}`);
    ok(dopoScorrimento.ultima === 'gamma_tab_0099',
      'in fondo alla lista c\'è davvero l\'ultima voce', `ultima: ${dopoScorrimento.ultima}`);
    ok(dopoScorrimento.spazioSopra > 1000, 'lo spaziatore sopra tiene il posto di ciò che non è disegnato');

    // Freccia giù ripetuta: la selezione deve seguire ANCHE oltre la finestra
    // iniziale, cioè su righe che non erano in DOM.
    await page.evaluate(() => { document.querySelector('#palette-lista').scrollTop = 0; });
    await page.click('#palette-input');
    for (let i = 0; i < 40; i++) await page.press('#palette-input', 'ArrowDown');
    const selezione = await page.evaluate(() => {
      const attiva = document.querySelector('#palette-lista .palette-voce.attiva');
      const lista = document.querySelector('#palette-lista');
      if (!attiva) return { presente: false };
      const r = attiva.getBoundingClientRect();
      const c = lista.getBoundingClientRect();
      return {
        presente: true,
        indice: Number(attiva.dataset.i),
        inVista: r.top >= c.top - 1 && r.bottom <= c.bottom + 1,
      };
    });
    ok(selezione.presente && selezione.indice === 40,
      'le frecce muovono la selezione anche su righe non disegnate',
      JSON.stringify(selezione));
    ok(selezione.inVista, 'la riga selezionata viene portata in vista');

    /* --- Scegliere un database ------------------------------------------- */

    await page.fill('#palette-input', 'alfa');
    await page.waitForTimeout(50);
    const versoAlbero = await page.evaluate(() => {
      const voci = [...document.querySelectorAll('#palette-lista .palette-voce')];
      const db = voci.find((el) => el.querySelector('.palette-tipo').textContent.trim() === 'Database');
      if (!db) return { trovata: false };
      db.click();
      const nodo = document.querySelector('#db-tree li.db > .node-label[data-db="alfa"]');
      return {
        trovata: true,
        nodoDb: !!nodo,
        espanso: !!(nodo && !nodo.parentElement.querySelector('ul').classList.contains('hidden')),
      };
    });
    ok(versoAlbero.nodoDb, 'il nodo del database nell\'albero e\' raggiungibile per nome');
    ok(versoAlbero.espanso, 'scegliere un database dalla palette lo espande nell\'albero',
      JSON.stringify(versoAlbero));

    /* --- Aprire una tabella dalla palette -------------------------------- */

    await apriPalette(page);
    await page.waitForSelector('#palette-overlay', { timeout: 5000 });
    await page.waitForFunction(() => !/lettura tabelle/.test(document.querySelector('.palette-piede').textContent), null, { timeout: 10000 });

    await page.fill('#palette-input', 'beta_tab_0500');
    await page.waitForTimeout(50);
    await page.click('#palette-lista .palette-voce');
    await page.waitForTimeout(200);
    const aperta = await page.evaluate(async () => {
      const { tabs } = await import('/js/tabs.js');
      const t = tabs.list.find((x) => x.id === 'palette-test');
      const ct = (t.state.collTabs || []).map((c) => `${c.db}.${c.coll}`);
      return { palette: !!document.querySelector('#palette-overlay'), schede: ct };
    });
    ok(!aperta.palette, 'scegliere una voce chiude la palette');
    ok(aperta.schede.includes('beta.beta_tab_0500'),
      'scegliere una tabella la apre nel workspace', JSON.stringify(aperta.schede));

    ok(erroriJs.length === 0, 'nessun errore JavaScript durante l\'uso della palette',
      erroriJs.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }
  console.log(falliti === 0 ? '\n\x1b[32mTutti i controlli superati\x1b[0m' : `\n\x1b[31m${falliti} controlli falliti\x1b[0m`);
  process.exit(falliti === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
