'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): la griglia scarta le pagine obsolete.
 *
 * Il difetto che questa prova esiste per impedire non si vede leggendo il
 * codice: dipende dall'ORDINE con cui il server risponde. Due letture in volo,
 * l'acknowledgment della prima consegnato DOPO quello della seconda, e la
 * griglia mostra le righe della query che l'utente ha gia' sostituito — con il
 * conteggio, la paginazione e l'indicatore di caricamento di quella vecchia.
 *
 * Il socket e' finto (`impostaSocket`) e mette gli acknowledgment in coda
 * invece di consegnarli: e' l'unico modo di decidere l'ordine di consegna, cosa
 * che un database vero non concede. Il server resta l'istanza usa-e-getta
 * dell'harness, cosi' moduli, DOM e catena di init sono quelli dell'app reale.
 *
 * Sensibilita' verificata rompendo di proposito, una alla volta:
 *   - il confronto `richiesta.runId !== st.gridRunId` in `runQuery`;
 *   - il confronto `token !== st.countToken` in `requestTotalCount`;
 *   - il `contestoCorrente(...)` di `fetchMore`.
 * Ognuna delle tre rende rosso almeno un asserto qui sotto.
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
    await page.waitForTimeout(1200);

    const esito = await page.evaluate(async () => {
      const { tabs, createTab } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const { runQuery } = await import('/js/grid.js');

      // Coda degli acknowledgment: il test decide QUANDO e in che ordine
      // consegnarli. `inviati` conserva anche cio' che e' partito, perche' una
      // richiesta MAI spedita e' un esito diverso da una spedita e scartata.
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
      // quell'evento (0 = la piu' vecchia) e aspetta che i `.then` scorrano.
      const consegna = async (evento, indice, risposta) => {
        const scelta = coda.filter((c) => c.evento === evento)[indice];
        if (!scelta) throw new Error(`Nessun "${evento}" in coda all'indice ${indice}`);
        coda.splice(coda.indexOf(scelta), 1);
        scelta.cb(risposta);
        await new Promise((r) => setTimeout(r, 40));
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
      // La seconda risponde per prima: e' la pagina che l'utente sta guardando.
      await consegna('collection:find', 1, {
        ok: true, docs: righe(3, 'nuovo'), columns: ['_id', 'nome'],
        skip: 100, limit: 50, total: null,
      });
      const countDopoNuova = contaEventi('collection:count');
      // …e solo ora arriva quella vecchia, con altre righe, altra pagina e un
      // totale gia' pronto: tutto cio' che non deve toccare nulla.
      await consegna('collection:find', 0, {
        ok: true, docs: righe(7, 'vecchio'), columns: ['_id', 'vecchio_campo'],
        skip: 0, limit: 50, total: 999,
      });

      const dopoInverso = {
        filtriSpediti: spedite.map((i) => JSON.stringify(
          i.msg.cercaOvunque || i.msg.filtro || i.msg.filter || null
        )),
        righe: st.docs.map((d) => d.nome),
        colonne: [...st.columns],
        skip: st.skip,
        total: st.total,
        countSpediti: contaEventi('collection:count'),
        countDopoNuova,
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
      const dopoConteggio = { contiInVolo, total: st.total, countPending: st.countPending };

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
      await new Promise((r) => setTimeout(r, 80));
      const partito = contaEventi('collection:find') > findPrima;
      const caricamentoAcceso = st.loading === true;
      // Una nuova query mentre il blocco e' in volo: da qui in poi il blocco
      // appartiene a una generazione superata.
      runQuery();
      await consegna('collection:find', 0, {
        ok: true, docs: righe(4, 'blocco2'), columns: ['_id', 'nome'],
        skip: 50, limit: 50, total: null,
      });
      const dopoBloccoObsoleto = {
        partito,
        caricamentoAcceso,
        righe: st.docs.length,
        etichette: [...new Set(st.docs.map((d) => String(d.nome).split('-')[0]))],
        loading: st.loading,
      };

      impostaSocket(null);
      return { dopoInverso, dopoConteggio, dopoBloccoObsoleto };
    });

    const a = esito.dopoInverso;
    ok(a.filtriSpediti.length === 2 && a.filtriSpediti[0] !== a.filtriSpediti[1],
      'le due letture partono davvero con filtri diversi', JSON.stringify(a.filtriSpediti));
    ok(a.righe.length === 3 && a.righe.every((n) => n.startsWith('nuovo')),
      'le righe mostrate sono quelle della lettura piu\' recente', JSON.stringify(a.righe));
    ok(!a.colonne.includes('vecchio_campo'),
      'le colonne della pagina obsoleta non tornano in griglia', JSON.stringify(a.colonne));
    ok(a.skip === 100, `la paginazione resta quella recente (skip = ${a.skip})`);
    ok(a.total !== 999, `il totale della pagina obsoleta non viene adottato (total = ${a.total})`);
    ok(a.countSpediti === a.countDopoNuova,
      'la pagina obsoleta non lancia un secondo conteggio',
      `${a.countDopoNuova} → ${a.countSpediti}`);

    const b = esito.dopoConteggio;
    ok(b.contiInVolo === 2, `due conteggi in volo da consegnare al contrario (${b.contiInVolo})`);
    ok(b.total === 2, `il conteggio obsoleto non sovrascrive il totale corrente (total = ${b.total})`);
    ok(b.countPending === false, 'il conteggio corrente risulta concluso');

    const c = esito.dopoBloccoObsoleto;
    ok(c.partito, 'lo scroll infinito ha davvero chiesto il blocco successivo');
    ok(c.caricamentoAcceso, 'il blocco in volo accende l\'indicatore di caricamento');
    ok(c.righe === 50 && c.etichette.length === 1 && c.etichette[0] === 'blocco1',
      'il blocco obsoleto non viene accodato alle righe',
      `${c.righe} righe, etichette ${JSON.stringify(c.etichette)}`);
    ok(c.loading === false, 'il blocco obsoleto spegne il proprio indicatore di caricamento');

    ok(errori.length === 0, 'nessun errore JS nella pagina', errori.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
  if (falliti) { console.error(`\n${falliti} verifiche fallite.`); process.exit(1); }
  console.log('\nTutte le verifiche superate.');
})();
