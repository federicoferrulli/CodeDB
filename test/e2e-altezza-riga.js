'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): l'altezza di riga che il JavaScript USA è quella che il CSS
 * PRODUCE, in tutte e tre le griglie.
 *
 * PERCHÉ ESISTE
 * La finestra virtuale di `griglia.js` non misura nulla: moltiplica un'altezza
 * di riga per il numero di righe che non disegna, e da quel prodotto ricava
 * l'altezza degli spaziatori — cioè la lunghezza della barra di scorrimento e
 * la posizione di ogni riga. Quel numero era però scritto in quattro posti che
 * non si parlavano (`QUERY_ROW_H = 36` nella tab ⚡, `ALTEZZA_RIGA_RIQUADRO =
 * 34` nella Split-View, un `28` di ripiego in `grid.js`, e il valore vero
 * prodotto dal CSS, che non coincideva con nessuno dei tre). Il difetto non è
 * visibile leggendo il codice, perché ogni copia è coerente con sé stessa: si
 * vede solo confrontando il numero usato con quello RESO.
 *
 * Non serve un database: le funzioni di render ricevono righe e colonne.
 *
 * Uso: node test/e2e-altezza-riga.js
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

const RIGHE = 3000;

(async () => {
  console.log('--- E2E: una sola altezza di riga, dal CSS al JavaScript ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_ROWH_PORT, 10) || 3151 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);

    const esito = await page.evaluate(async (righeTotali) => {
      const { state } = await import('/js/state.js');
      const { renderGrid } = await import('/js/grid.js');
      const { renderResults, setResultsViewMode } = await import('/js/query-tab.js');
      const { altezzaRigaGriglia } = await import('/js/griglia.js');

      document.getElementById('onboarding-overlay')?.remove();
      document.getElementById('welcome').classList.add('hidden');
      document.getElementById('tab-body').classList.remove('hidden');
      document.getElementById('workspace').classList.remove('hidden');
      document.getElementById('placeholder').classList.add('hidden');

      // Righe con un BOOLEANO e righe senza: la pillola `true`/`false` è
      // inline-flex, e se supera la casella di riga alza SOLO le righe che ne
      // hanno una — cioè rende disuguali righe che la finestra virtuale
      // presume uguali. Alternarle è ciò che rende il controllo capace di
      // vederlo.
      const righe = Array.from({ length: righeTotali }, (_, i) => (
        i % 2 === 0
          ? { _id: i + 1, nome: `riga ${i}`, attivo: true }
          : { _id: i + 1, nome: `riga ${i}`, attivo: null }
      ));
      const colonne = ['_id', 'nome', 'attivo'];

      /** Altezza dichiarata dagli spaziatori più quella delle righe disegnate. */
      const misura = (tbody) => {
        const tutte = [...tbody.querySelectorAll('tr')];
        const spaziatori = tutte.filter((tr) => tr.classList.contains('v-spacer'));
        const vere = tutte.filter((tr) => !tr.classList.contains('v-spacer'));
        const altezze = [...new Set(vere.map((tr) => Math.round(tr.getBoundingClientRect().height)))];
        return {
          altezzeDistinte: altezze,
          disegnate: vere.length,
          altezzaSpaziatori: spaziatori.reduce(
            (a, tr) => a + parseInt(tr.querySelector('td').style.height || '0', 10), 0),
        };
      };

      const out = {};

      state.docs = righe; state.columns = colonne; state.total = righeTotali;
      renderGrid();
      out.dati = misura(document.querySelector('#grid tbody'));
      out.datiToken = altezzaRigaGriglia(document.querySelector('#grid'));

      // La tab ⚡ va MOSTRATA: un pannello con `display: none` restituisce
      // altezze zero, e un controllo che misura zero passerebbe qualunque cosa.
      for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
      document.getElementById('view-query').classList.remove('hidden');
      setResultsViewMode('table');
      renderResults(righe.map((r) => ({ id: r._id, nome: r.nome, attivo: r.attivo })));
      out.query = misura(document.querySelector('#query-result-table tbody'));
      out.queryToken = altezzaRigaGriglia(document.querySelector('#query-result-table'));

      // Lo STESSO valore, letto per due strade diverse, deve avere lo stesso
      // aspetto: sono righe dello stesso database. Si confronta lo stile
      // CALCOLATO e non le classi — con la classe sul `td` invece che su uno
      // span, le regole c'erano ma non raggiungevano nulla, e un controllo
      // sulle classi sarebbe passato lo stesso.
      const stile = (el) => {
        if (!el) return null;
        const c = getComputedStyle(el);
        return { colore: c.color, carattere: c.fontFamily, corpo: c.fontSize, peso: c.fontWeight };
      };
      const cella = (sel, indiceColonna) => {
        const tr = [...document.querySelectorAll(`${sel} tbody tr`)]
          .find((r) => !r.classList.contains('v-spacer'));
        const td = tr && tr.children[indiceColonna];
        return td && (td.querySelector('span') || td);
      };
      // Vista Dati: colonna 0 e' la checkbox, quindi _id=1, nome=2, attivo=3.
      out.confronto = {
        intestazione: {
          dati: stile(document.querySelector('#grid thead th:nth-child(2)')),
          query: stile(document.querySelector('#query-result-table thead th:nth-child(1)')),
        },
        numero: { dati: stile(cella('#grid', 1)), query: stile(cella('#query-result-table', 0)) },
        testo: { dati: stile(cella('#grid', 2)), query: stile(cella('#query-result-table', 1)) },
        booleano: { dati: stile(cella('#grid', 3)), query: stile(cella('#query-result-table', 2)) },
      };

      return out;
    }, RIGHE);

    for (const [nome, chiaveToken] of [['vista Dati', 'datiToken'], ['tab ⚡', 'queryToken']]) {
      const m = nome === 'vista Dati' ? esito.dati : esito.query;
      const token = esito[chiaveToken];

      ok(m.altezzeDistinte.length === 1,
        `${nome}: tutte le righe disegnate hanno la STESSA altezza`,
        `altezze trovate: ${JSON.stringify(m.altezzeDistinte)} — con righe disuguali gli spaziatori mentono`);

      ok(m.altezzeDistinte.length === 1 && m.altezzeDistinte[0] === token,
        `${nome}: l'altezza RESA coincide con quella che il JavaScript USA (${token}px)`,
        `resa ${JSON.stringify(m.altezzeDistinte)}, usata ${token}`);

      // Il conto che la barra di scorrimento promette all'utente.
      const atteso = RIGHE * token;
      const reale = m.altezzaSpaziatori + m.disegnate * (m.altezzeDistinte[0] || 0);
      ok(Math.abs(reale - atteso) <= m.disegnate,
        `${nome}: spaziatori + righe coprono l'altezza delle ${RIGHE} righe (${reale} contro ${atteso})`,
        `uno scarto qui è la barra di scorrimento che promette un contenuto che non c'è`);
    }

    /* --- Le due griglie rendono lo stesso valore allo stesso modo --------- */

    for (const [che, coppia] of Object.entries(esito.confronto)) {
      const { dati, query } = coppia;
      ok(dati && query, `${che}: la cella esiste in entrambe le griglie`,
        `dati=${JSON.stringify(dati)} query=${JSON.stringify(query)}`);
      ok(dati && query && JSON.stringify(dati) === JSON.stringify(query),
        `${che}: stesso stile calcolato nella vista Dati e nella tab ⚡`,
        `Dati: ${JSON.stringify(dati)} / Query: ${JSON.stringify(query)}`);
    }

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Altezza di riga: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Altezza di riga: tutti i test superati ---');
})();
