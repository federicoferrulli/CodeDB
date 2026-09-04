'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): l'incolla di celle è ESATTO e ATOMICO (issue 06).
 *
 * `coercePasted` (public/js/cellselect.js) converte il testo incollato nel
 * tipo della colonna. Due proprietà, entrambe misurate qui contro il modulo
 * vero, non ricostruite a parole:
 *
 * 1. ESATTO: i numeri oltre 2^53 e i decimali ad alta precisione passano dal
 *    codec del ticket 04 (`valori-esatti.js`), mai da `Number`; la
 *    convenzione temporale (DATE calendario, DATETIME/TIMESTAMP locale senza
 *    fuso, TIMESTAMPTZ istante con fuso esplicito) la decide il tipo
 *    DICHIARATO dalla colonna, non una conversione implicita.
 *
 *    Il difetto che questa parte prova: `coercePasted` controllava
 *    `valueType(current) === 'date'` PRIMA del tipo dichiarato dalla colonna.
 *    Su ogni motore SQL una colonna già valorizzata arriva in EJSON come
 *    `{$date}` qualunque sia il suo tipo dichiarato, quindi quel controllo
 *    catturava SEMPRE una cella non vuota — la colonna DATE veniva trattata
 *    come istante (pretendendo un fuso su un valore che non lo ha mai avuto),
 *    e una DATETIME naive allo stesso modo. Le asserzioni sul tipo DATE/
 *    DATETIME/TIMESTAMPTZ qui sotto sono quelle che sarebbero fallite con
 *    l'ordine sbagliato: la sensibilità è stata verificata rompendo di
 *    proposito l'ordine in `coercePasted` (vedi la nota di completamento nel
 *    ticket .scratch/…/06-incolla-celle-esatto-atomico.md), non ricostruendo
 *    qui una copia del difetto.
 *
 * 2. ATOMICO: `pasteIntoGrid` valida OGNI cella del blocco incollato prima di
 *    mandare la prima `doc:update` (vedi il `try { grid.forEach(...) } catch`
 *    che precede qualunque `emit`). Una cella non valida in una riga qualsiasi
 *    del blocco deve annullare l'intero incolla — zero scritture — con un
 *    errore che nomina riga e colonna. Si prova mandando un blocco di due
 *    righe dove la seconda riga contiene un valore non valido: se una
 *    versione futura applicasse la prima riga prima di validare la seconda,
 *    questo test vedrebbe una doc:update e diventerebbe rosso (verificato
 *    rompendo di proposito anche questo, vedi lo stesso ticket).
 *
 * Uso: node test/e2e-incolla-esatto-atomico.js
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

// Fabbrica di una griglia finta completa (thead con data-c, tbody con celle
// data-r/data-c) agganciata a `creaSelezioneCelle`, con METADATI di colonna
// (tipo dichiarato) — è ciò che manca alla FABBRICA di
// e2e-selezione-celle-viste.js e che questa prova richiede per forza.
const FABBRICA = `
  window.__creaGrigliaTipata = async (nome, righe, colonne, metadati) => {
    const { creaSelezioneCelle } = await import('/js/cellselect.js');
    // emit() convalida il tabId contro tabs.list — un id inventato viene
    // trattato come "tab chiuso" e la scrittura viene annullata prima ancora
    // di raggiungere il socket finto. Serve un tab VERO (vedi
    // e2e-selezione-celle-viste.js, stesso motivo).
    const { createTab } = await import('/js/tabs.js');
    const tab = createTab({ connName: null });
    tab.dbType = 'mysql';
    tab.state.connected = true;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'height:200px;overflow:auto';
    document.body.appendChild(wrap);
    const tabella = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    colonne.forEach((c, i) => {
      const th = document.createElement('th');
      th.dataset.c = i;
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

    const stato = { anchor: null, focus: null, cells: new Set() };
    const ist = creaSelezioneCelle({
      nome,
      tbody,
      thead: () => thead,
      contenitore: () => wrap,
      info: () => null,
      righe: () => righe,
      colonne: () => colonne,
      metadati: () => metadati,
      bersaglio: () => ({ db: 'prova', coll: nome, dbType: 'mysql' }),
      stato: () => stato,
      visibile: () => true,
      contesto: () => ({ tabId: tab.id, st: { db: 'prova', coll: nome, dbType: 'mysql' }, isStillActive: () => true }),
      assicuraRiga: () => {},
      ricarica: () => {},
      modificaRiga: () => {},
      eliminaRighe: () => {},
      motivoNoScrittura: () => null,
    });
    return { wrap, tbody, stato, ist };
  };

  // Incolla vero via la voce di menu "Incolla (Ctrl+V)": un evento 'paste'
  // sintetico non porta clipboardData in Chromium, quindi si passa dal
  // context-menu come fa davvero l'utente (stesso percorso di
  // e2e-selezione-celle-viste.js).
  window.__incolla = async (tbody, r, c, testo) => {
    const cella = tbody.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    cella.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const appuntiVeri = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: () => Promise.resolve(testo), writeText: () => Promise.resolve() },
    });
    const confermaVera = window.confirm;
    window.confirm = () => true;
    cella.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
    const voce = [...document.querySelectorAll('#context-menu li')]
      .find((li) => li.textContent.startsWith('Incolla'));
    if (voce) voce.click();
    await new Promise((r2) => setTimeout(r2, 400));
    window.confirm = confermaVera;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: appuntiVeri });
  };
`;

(async () => {
  console.log('--- E2E: incolla di celle esatto e atomico (issue 06) ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UI_PORT, 10) || 3147 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.addScriptTag({ content: FABBRICA, type: 'module' });
    await page.waitForFunction(() => typeof window.__creaGrigliaTipata === 'function');

    /* === Parte 1: coercePasted, chiamato direttamente ===================== */

    const puro = await page.evaluate(async () => {
      const { coercePasted } = await import('/js/cellselect.js');
      const out = {};

      // Interi e decimali esatti: lo stesso codec del ticket 04, mai Number().
      out.bigintMax = coercePasted({ $numberLong: '1' }, '9223372036854775807', { type: 'bigint' });
      out.bigintOltre53 = coercePasted({ $numberLong: '1' }, '9007199254740993', { type: 'bigint' });
      out.decimaleEsteso = coercePasted(
        { $numberDecimal: '1' }, '1234567890.123456789012345678', { type: 'decimal(38,18)' }
      );
      out.bigintRifiutato = (() => {
        try { coercePasted({ $numberLong: '1' }, 'abc', { type: 'bigint' }); return null; }
        catch (e) { return e.message; }
      })();

      // DATE: calendario puro, nessun fuso preteso.
      out.data = coercePasted({ $date: '2024-01-01T00:00:00.000Z' }, '2024-06-15', { type: 'date' });

      // DATETIME/TIMESTAMP naive: locale, stringa preservata AL CARATTERE —
      // è così che un incolla attraversa un passaggio di ora legale senza
      // ambiguità: non prova a risolvere l'orario a un istante.
      out.dstFallback = coercePasted(
        { $date: '2024-01-01T00:00:00.000Z' }, '2026-10-25T02:30:00', { type: 'datetime' }
      );

      // TIMESTAMPTZ: istante, richiede il fuso esplicito. Stesso orario
      // civile (02:30) nei due lati del cambio d'ora dà due ISTANTI UTC
      // diversi, perché è l'offset scritto a deciderlo, non una conversione
      // implicita basata sulla data.
      out.tzPrimaCambio = coercePasted(
        { $date: '2024-01-01T00:00:00.000Z' }, '2026-10-25T02:30:00+02:00',
        { type: 'timestamp with time zone' }
      );
      out.tzDopoCambio = coercePasted(
        { $date: '2024-01-01T00:00:00.000Z' }, '2026-10-25T02:30:00+01:00',
        { type: 'timestamp with time zone' }
      );
      out.tzAmbiguoRifiutato = (() => {
        try {
          coercePasted({ $date: '2024-01-01T00:00:00.000Z' }, '2026-10-25T02:30:00',
            { type: 'timestamp with time zone' });
          return null;
        } catch (e) { return e.message; }
      })();

      // MongoDB: nessun tipo di colonna dichiarato, un $date resta sempre
      // istante (comportamento invariato dalla issue).
      out.mongoData = coercePasted({ $date: '2024-01-01T00:00:00.000Z' }, '2026-10-25T02:30:00Z', {});
      out.mongoAmbiguoRifiutato = (() => {
        try { coercePasted({ $date: '2024-01-01T00:00:00.000Z' }, '2026-10-25T02:30:00', {}); return null; }
        catch (e) { return e.message; }
      })();

      return out;
    });

    ok(JSON.stringify(puro.bigintMax) === JSON.stringify({ $numberLong: '9223372036854775807' }),
      `BIGINT al limite 2^63-1 resta esatto (${JSON.stringify(puro.bigintMax)})`);
    ok(JSON.stringify(puro.bigintOltre53) === JSON.stringify({ $numberLong: '9007199254740993' }),
      `BIGINT oltre 2^53 non passa da Number (${JSON.stringify(puro.bigintOltre53)})`);
    ok(JSON.stringify(puro.decimaleEsteso) === JSON.stringify({ $numberDecimal: '1234567890.123456789012345678' }),
      `decimale ad alta precisione esatto (${JSON.stringify(puro.decimaleEsteso)})`);
    ok(/intero/i.test(puro.bigintRifiutato || ''),
      `testo non numerico su colonna bigint rifiutato (${puro.bigintRifiutato})`);

    ok(puro.data === '2024-06-15', `DATE: calendario puro, nessun fuso preteso (ottenuto ${JSON.stringify(puro.data)})`);
    ok(puro.dstFallback === '2026-10-25T02:30:00',
      `DATETIME naive: stringa locale preservata al carattere attraverso il cambio d'ora (${JSON.stringify(puro.dstFallback)})`);
    ok(JSON.stringify(puro.tzPrimaCambio) === JSON.stringify({ $date: '2026-10-25T00:30:00.000Z' }),
      `TIMESTAMPTZ prima del cambio d'ora → istante UTC corretto (${JSON.stringify(puro.tzPrimaCambio)})`);
    ok(JSON.stringify(puro.tzDopoCambio) === JSON.stringify({ $date: '2026-10-25T01:30:00.000Z' }),
      `TIMESTAMPTZ dopo il cambio d'ora → istante UTC diverso, stesso orario civile (${JSON.stringify(puro.tzDopoCambio)})`);
    ok(/fuso|z|offset/i.test(puro.tzAmbiguoRifiutato || ''),
      `TIMESTAMPTZ senza fuso esplicito rifiutato, non convertito implicitamente (${puro.tzAmbiguoRifiutato})`);

    ok(JSON.stringify(puro.mongoData) === JSON.stringify({ $date: '2026-10-25T02:30:00.000Z' }),
      `MongoDB: $date resta istante senza tipo di colonna dichiarato (${JSON.stringify(puro.mongoData)})`);
    ok(/fuso|z|offset/i.test(puro.mongoAmbiguoRifiutato || ''),
      `MongoDB: istante ambiguo rifiutato anche senza colonna SQL (${puro.mongoAmbiguoRifiutato})`);

    /* === Parte 2: pasteIntoGrid, atomicità del blocco ===================== */

    const atomico = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const spediti = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          spediti.push({ evento, ...msg });
          if (cb) cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });

      const colonne = ['big'];
      const metadati = { big: { type: 'bigint' } };
      const righe = [
        { _id: 1, big: { $numberLong: '1' } },
        { _id: 2, big: { $numberLong: '2' } },
      ];
      const g = await window.__creaGrigliaTipata('atomico', righe, colonne, metadati);

      // Blocco di due righe sulla stessa colonna: la prima valida, la
      // seconda no. Se il preflight validasse riga per riga ANCHE inviando
      // (invece di costruire l'intero blocco prima di spedire), qui
      // vedremmo una doc:update per la prima riga.
      await window.__incolla(g.tbody, 0, 0, '123\nnonnumerico');

      impostaSocket(null);
      return {
        scritture: spediti.filter((m) => m.evento === 'doc:update'),
        toast: document.querySelector('#toast')?.textContent || '',
      };
    });

    ok(atomico.scritture.length === 0,
      `blocco con una cella non valida: ZERO scritture inviate (${atomico.scritture.length} doc:update) — `
      + 'il database resta invariato');
    ok(/riga\s*2/i.test(atomico.toast) && /big/.test(atomico.toast),
      `l'errore identifica riga e colonna ("${atomico.toast}")`);

    /* === Parte 3: pasteIntoGrid, valori esatti sul giro intero ============ */

    const giroIntero = await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const spediti = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          spediti.push({ evento, ...msg });
          if (cb) cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });

      const colonne = ['big', 'dec', 'datacol', 'dtcol', 'tzcol'];
      const metadati = {
        big: { type: 'bigint' },
        dec: { type: 'decimal(38,18)' },
        datacol: { type: 'date' },
        dtcol: { type: 'datetime' },
        tzcol: { type: 'timestamp with time zone' },
      };
      const righe = [{
        _id: 1,
        big: { $numberLong: '1' },
        dec: { $numberDecimal: '1' },
        datacol: { $date: '2024-01-01T00:00:00.000Z' },
        dtcol: { $date: '2024-01-01T00:00:00.000Z' },
        tzcol: { $date: '2024-01-01T00:00:00.000Z' },
      }];
      const g = await window.__creaGrigliaTipata('giroIntero', righe, colonne, metadati);

      const testo = [
        '9223372036854775807',
        '1234567890.123456789012345678',
        '2024-06-15',
        '2026-10-25T02:30:00',
        '2026-10-25T02:30:00+02:00',
      ].join('\t');
      await window.__incolla(g.tbody, 0, 0, testo);

      impostaSocket(null);
      const scrittura = spediti.find((m) => m.evento === 'doc:update');
      return {
        set: scrittura && scrittura.set,
        scritture: spediti.filter((m) => m.evento === 'doc:update').length,
        toast: document.querySelector('#toast')?.textContent || '',
      };
    });

    ok(giroIntero.scritture === 1,
      `il blocco valido produce una sola doc:update (${giroIntero.scritture}) toast="${giroIntero.toast}"`);
    const set = giroIntero.set || {};
    ok(JSON.stringify(set.big) === JSON.stringify({ $numberLong: '9223372036854775807' }),
      `scrittura reale: BIGINT esatto (${JSON.stringify(set.big)})`);
    ok(JSON.stringify(set.dec) === JSON.stringify({ $numberDecimal: '1234567890.123456789012345678' }),
      `scrittura reale: decimale esatto (${JSON.stringify(set.dec)})`);
    ok(set.datacol === '2024-06-15', `scrittura reale: DATE senza fuso (${JSON.stringify(set.datacol)})`);
    ok(set.dtcol === '2026-10-25T02:30:00', `scrittura reale: DATETIME locale invariato (${JSON.stringify(set.dtcol)})`);
    ok(JSON.stringify(set.tzcol) === JSON.stringify({ $date: '2026-10-25T00:30:00.000Z' }),
      `scrittura reale: TIMESTAMPTZ convertito in UTC dal fuso esplicito (${JSON.stringify(set.tzcol)})`);

    ok(errori.length === 0, `nessun errore JS in pagina (${errori.join(' | ')})`);
  } finally {
    await browser.close();
    await server.stop();
  }

  console.log(falliti === 0 ? '\nTutti i test superati.' : `\n${falliti} test falliti.`);
  process.exit(falliti === 0 ? 0 : 1);
})();
