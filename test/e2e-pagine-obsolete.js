'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): la griglia scarta le pagine obsolete.
 *
 * Il difetto che questa prova esiste per impedire non si vede leggendo il
 * codice: dipende dall'ORDINE con cui il server risponde. Due letture in volo,
 * l'acknowledgment della prima consegnato DOPO quello della seconda, e la
 * griglia mostra le righe della query che l'utente ha già sostituito — con il
 * conteggio, la paginazione e l'indicatore di caricamento di quella vecchia.
 *
 * Il socket è finto (`impostaSocket`) e mette gli acknowledgment in coda invece
 * di consegnarli: è l'unico modo di decidere l'ordine di consegna, cosa che un
 * database vero non concede. Il server resta l'istanza usa-e-getta
 * dell'harness, così moduli, DOM e catena di init sono quelli dell'app reale.
 *
 * Le risposte obsolete portano di proposito `total: null`: un totale già noto
 * impedirebbe al chiamante di chiedere il conteggio, e l'asserto sul secondo
 * conteggio non potrebbe fallire nemmeno a guardia rimossa.
 *
 * Sensibilità verificata rompendo di proposito, una alla volta, le tre guardie:
 *   - il `contestoCorrente(...)` di `runQuery`   → 7 asserti rossi;
 *   - il `contestoCorrente(...)` di `requestTotalCount` → 1 asserto rosso;
 *   - il `contestoCorrente(...)` di `fetchMore`  → 1 asserto rosso.
 *
 * Uso: node test/e2e-pagine-obsolete.js
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
  console.log('--- E2E: pagine obsolete scartate dalla griglia ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3156 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    // La catena degli init* del frontend è asincrona: senza questa attesa il
    // socket finto verrebbe installato prima che l'app abbia finito di montarsi.
    await page.waitForTimeout(1500);

    const esito = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const { runQuery } = await import('/js/grid.js');

      // Le uniche attese del test. Il socket è finto, quindi non si sta
      // aspettando la rete ma solo che la catena dei `.then()` già risolti
      // scorra (microtask + il `setTimeout(0)` del trasporto); lo scroll passa
      // in più dal gestore dell'evento e dal ridisegno della griglia.
      const ATTESA_ACK_MS = 40;
      const ATTESA_SCROLL_MS = 80;

      // Coda degli acknowledgment: il test decide QUANDO e in che ordine
      // consegnarli. `inviati` conserva anche ciò che è partito, perché una
      // richiesta MAI spedita è un esito diverso da una spedita e scartata.
      const inviati = [];
      const coda = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          inviati.push({ evento, msg });
          if (typeof cb === 'function') coda.push({ evento, msg, cb });
        },
        on: () => {}, off: () => {},
      });
      // Consegna l'acknowledgment della n-esima richiesta ancora in coda per
      // quell'evento (0 = la più vecchia) e aspetta che i `.then` scorrano.
      const consegna = async (evento, indice, risposta) => {
        const scelta = coda.filter((c) => c.evento === evento)[indice];
        if (!scelta) throw new Error(`Nessun "${evento}" in coda all'indice ${indice}`);
        coda.splice(coda.indexOf(scelta), 1);
        scelta.cb(risposta);
        await new Promise((r) => setTimeout(r, ATTESA_ACK_MS));
      };
      const contaEventi = (evento) => inviati.filter((i) => i.evento === evento).length;
      const righe = (n, etichetta) => Array.from({ length: n }, (_, i) => ({
        _id: i + 1, nome: `${etichetta}-${i}`,
      }));

      const tab = createTab({ connName: null });
      tab.dbType = 'mysql';
      tabs.activeId = tab.id;
      const st = tab.state;
      st.connected = true;
      st.db = 'magazzino';
      st.coll = 'ordini';
      st.docs = []; st.columns = [];
      document.querySelector('#page-size').value = '50';
      document.querySelector('#sort-input').value = '';
      document.querySelector('#query-mode').value = 'find';

      /* --- Due letture, acknowledgment in ordine inverso ---------------- */

      document.querySelector('#filter-input').value = 'vecchio';
      st.skip = 0;
      runQuery();
      document.querySelector('#filter-input').value = 'nuovo';
      st.skip = 100;
      runQuery();

      const spedite = inviati.filter((i) => i.evento === 'collection:find');
      // La seconda risponde per prima: è la pagina che l'utente sta guardando.
      await consegna('collection:find', 1, {
        ok: true, docs: righe(3, 'nuovo'), columns: ['_id', 'nome'],
        skip: 100, limit: 50, total: null,
      });
      const contiDopoNuova = contaEventi('collection:count');
      // …e solo ora arriva quella vecchia, con altre righe, un'altra pagina e
      // un totale ignoto — quindi, se venisse accettata, lancerebbe un secondo
      // conteggio. Tutto ciò che non deve accadere.
      await consegna('collection:find', 0, {
        ok: true, docs: righe(7, 'vecchio'), columns: ['_id', 'vecchio_campo'],
        skip: 0, limit: 50, total: null,
      });

      const inverso = {
        filtriSpediti: spedite.map((i) => JSON.stringify(
          i.msg.cercaOvunque || i.msg.filtro || i.msg.filter || null
        )),
        righe: st.docs.map((d) => d.nome),
        colonne: [...st.columns],
        skip: st.skip,
        contiDopoNuova,
        contiDopoVecchia: contaEventi('collection:count'),
      };

      /* --- Il conteggio obsoleto non risale al footer ------------------- */

      // La lettura appena accettata ha chiesto il proprio conteggio; se ne
      // forza un secondo (nuovo filtro) e si consegnano al contrario.
      document.querySelector('#filter-input').value = 'nuovissimo';
      runQuery();
      await consegna('collection:find', 0, {
        ok: true, docs: righe(2, 'nuovissimo'), columns: ['_id', 'nome'],
        skip: 0, limit: 50, total: null,
      });
      const contiInVolo = coda.filter((c) => c.evento === 'collection:count').length;
      await consegna('collection:count', 1, { ok: true, total: 2 });
      await consegna('collection:count', 0, { ok: true, total: 999 });
      const conteggio = { contiInVolo, total: st.total, countPending: st.countPending };

      /* --- Il caricamento incrementale obsoleto non accoda -------------- */

      st.infiniteScroll = true;
      st.exhausted = false;
      st.loading = false;
      st.total = null;
      st.countApprox = false;
      st.docs = righe(50, 'blocco1');
      st.columns = ['_id', 'nome'];
      st.limit = 50;
      const findPrima = contaEventi('collection:find');
      const wrap = document.querySelector('.grid-wrap');
      wrap.scrollTop = wrap.scrollHeight;
      wrap.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, ATTESA_SCROLL_MS));
      const partito = contaEventi('collection:find') > findPrima;
      const caricamentoAcceso = st.loading === true;
      // Una nuova query mentre il blocco è in volo: da qui in poi il blocco
      // appartiene a una generazione superata.
      runQuery();
      await consegna('collection:find', 0, {
        ok: true, docs: righe(4, 'blocco2'), columns: ['_id', 'nome'],
        skip: 50, limit: 50, total: null,
      });
      const blocco = {
        partito,
        caricamentoAcceso,
        righe: st.docs.length,
        etichette: [...new Set(st.docs.map((d) => String(d.nome).split('-')[0]))],
        loading: st.loading,
      };

      impostaSocket(null);
      return { inverso, conteggio, blocco };
    });

    const { inverso, conteggio, blocco } = esito;

    ok(inverso.filtriSpediti.length === 2 && inverso.filtriSpediti[0] !== inverso.filtriSpediti[1],
      'le due letture partono davvero con filtri diversi', JSON.stringify(inverso.filtriSpediti));
    ok(inverso.righe.length === 3 && inverso.righe.every((n) => n.startsWith('nuovo')),
      'le righe mostrate sono quelle della lettura più recente', JSON.stringify(inverso.righe));
    ok(!inverso.colonne.includes('vecchio_campo'),
      'le colonne della pagina obsoleta non tornano in griglia', JSON.stringify(inverso.colonne));
    ok(inverso.skip === 100, `la paginazione resta quella recente (skip = ${inverso.skip})`);
    ok(inverso.contiDopoVecchia === inverso.contiDopoNuova,
      'la pagina obsoleta non lancia un secondo conteggio',
      `${inverso.contiDopoNuova} → ${inverso.contiDopoVecchia}`);

    ok(conteggio.contiInVolo === 2,
      `due conteggi in volo da consegnare al contrario (${conteggio.contiInVolo})`);
    ok(conteggio.total === 2,
      `il conteggio obsoleto non sovrascrive il totale corrente (total = ${conteggio.total})`);
    ok(conteggio.countPending === false, 'il conteggio corrente risulta concluso');

    ok(blocco.partito, 'lo scroll infinito ha davvero chiesto il blocco successivo');
    ok(blocco.caricamentoAcceso, 'il blocco in volo accende l\'indicatore di caricamento');
    ok(blocco.righe === 50 && blocco.etichette.length === 1 && blocco.etichette[0] === 'blocco1',
      'il blocco obsoleto non viene accodato alle righe',
      `${blocco.righe} righe, etichette ${JSON.stringify(blocco.etichette)}`);
    ok(blocco.loading === false, 'il blocco obsoleto spegne il proprio indicatore di caricamento');

    ok(errori.length === 0, 'nessun errore JS nella pagina', errori.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
  if (falliti) {
    console.error(`\n--- Pagine obsolete: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Pagine obsolete: tutti i test superati ---');
})();
