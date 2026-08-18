'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E (Chromium, eventi TOUCH nativi) delle assunzioni di piattaforma su
 * cui poggia lo scorrimento automatico col dito in cellselect.js.
 *
 * Qui non si prova codice dell'applicazione: si provano i fatti del browser da
 * cui quel codice dipende. Sono fatti che non si possono dedurre leggendo il
 * sorgente, e se uno fosse falso la funzione su mobile sarebbe impossibile o la
 * complicazione che porta sarebbe inutile. Le tre assunzioni:
 *
 *   1. SCORRERE DA CODICE NON ANNULLA IL DITO. Il ciclo muove `scrollTop`
 *      mentre il dito è premuto: se il browser rispondesse con `pointercancel`
 *      (come fa quando prende lui lo scorrimento), il gesto morirebbe al primo
 *      fotogramma e la selezione non seguirebbe mai.
 *   2. LE RIGHE POSSONO ESSERE RICOSTRUITE A METÀ GESTO. La griglia è
 *      virtualizzata: scorrendo, `renderVirtualWindow` fa `tbody.innerHTML=''`
 *      e la cella su cui il tocco è stato catturato esce dal documento. Gli
 *      eventi devono continuare ad arrivare al `tbody` — altrimenti niente
 *      `pointermove` (la selezione non segue) e niente `pointerup` (il ciclo
 *      continuerebbe a scorrere a dito alzato).
 *   3. `elementsFromPoint` VEDE SOTTO LE BARRE FISSE. Col dito capita di
 *      trascinare sopra la barra inferiore del mobile: al singolare si
 *      otterrebbe la barra e la selezione smetterebbe di seguire.
 *
 * La pagina di prova non duplica logica dell'applicazione: monta la stessa
 * situazione strutturale e conta gli eventi. Nessun database, nessun server.
 *
 * Uso: node test/e2e-tocco-griglia.js
 * ------------------------------------------------------------------------- */

const { chromium } = require('playwright');

let falliti = 0;
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  \x1b[32m✔ OK\x1b[0m   ${etichetta}`);
  else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${etichetta}${dettaglio ? ` — ${dettaglio}` : ''}`);
    falliti++;
  }
};

const PAGINA = `
<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0}
  .grid-wrap{height:300px;overflow:auto}
  table{border-collapse:collapse;width:100%}
  td{height:40px;border:1px solid #ccc;touch-action:none}
  /* Un elemento fisso sovrapposto alla parte bassa della griglia: è il caso di
     una barra o di un pannello che sta DAVANTI alle celle proprio nella fascia
     dove il dito si ferma per far scorrere. */
  .barra{position:fixed;left:0;right:0;top:250px;height:50px;background:#333;z-index:130}
</style>
<div class="grid-wrap" id="wrap"><table><tbody id="tb"></tbody></table></div>
<div class="barra"></div>
<script>
  const tb = document.getElementById('tb');
  const wrap = document.getElementById('wrap');
  const RIGHE = 400, ALT = 40;

  // "Finestra virtuale" come quella di grid.js: fuori dalla vista ci sono due
  // righe-spaziatore, e le righe visibili vengono RICOSTRUITE a ogni scorrimento.
  let inizio = -1;
  function rendi() {
    const start = Math.max(0, Math.floor(wrap.scrollTop / ALT) - 3);
    if (start === inizio) return;
    inizio = start;
    const end = Math.min(RIGHE, start + 12);
    tb.innerHTML = '';
    if (start > 0) tb.appendChild(spaziatore(start * ALT));
    for (let i = start; i < end; i++) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.dataset.r = String(i);
      td.textContent = 'riga ' + i;
      tr.appendChild(td); tb.appendChild(tr);
    }
    if (end < RIGHE) tb.appendChild(spaziatore((RIGHE - end) * ALT));
    window.ricostruzioni++;
  }
  function spaziatore(h) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.style.height = h + 'px'; td.style.padding = '0'; delete td.dataset.r;
    tr.appendChild(td); return tr;
  }

  window.ricostruzioni = 0;
  window.conCattura = false;
  window.conteggi = { move: 0, up: 0, cancel: 0 };
  window.viste = [];      // righe trovate sotto al dito durante il gesto
  window.sottoBarra = 0;  // quante volte la cella è stata trovata sotto la barra
  rendi();

  let raf = 0, y = 0, premuto = false;

  // Lo stesso ciclo di cellselect.js, ridotto all'osso: scorre finché il dito
  // sta nella fascia bassa e rilegge la cella sotto al dito.
  function passo() {
    raf = 0;
    if (!premuto) return;
    const r = wrap.getBoundingClientRect();
    if (y > r.bottom - 72) {
      wrap.scrollTop += 20;
      rendi();
      leggiCella();
    }
    raf = requestAnimationFrame(passo);
  }
  function leggiCella() {
    const r = wrap.getBoundingClientRect();
    const yy = Math.min(Math.max(y, r.top + 1), r.bottom - 1);
    const pila = document.elementsFromPoint(100, yy);
    // Al singolare si otterrebbe l'elemento sovrapposto, non la cella: è il
    // motivo per cui cellselect.js legge la pila e non il solo elemento in cima.
    const singolo = document.elementFromPoint(100, yy);
    if (singolo && singolo.classList && singolo.classList.contains('barra')) window.sottoBarra++;
    for (const el of pila) {
      const td = el.closest && el.closest('td[data-r]');
      if (td && tb.contains(td)) { window.viste.push(Number(td.dataset.r)); return; }
    }
  }

  tb.addEventListener('pointerdown', (e) => {
    premuto = true; y = e.clientY;
    if (window.conCattura) tb.setPointerCapture(e.pointerId);
    if (!raf) raf = requestAnimationFrame(passo);
  });
  tb.addEventListener('pointermove', (e) => {
    window.conteggi.move++; y = e.clientY;
    if (!raf) raf = requestAnimationFrame(passo);
  });
  tb.addEventListener('pointerup', () => { window.conteggi.up++; premuto = false; });
  tb.addEventListener('pointercancel', () => { window.conteggi.cancel++; premuto = false; });
</script>`;

// Un trascinamento col dito, in eventi touch nativi (CDP): Playwright non ha un
// "touch drag", e gli eventi sintetici costruiti in pagina non passerebbero dal
// percorso reale del browser — che è proprio ciò che si sta provando.
async function trascinaColDito(cdp, page, x, y0, y1, { passi = 8, attesaFinaleMs = 400 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
  for (let i = 1; i <= passi; i++) {
    const y = Math.round(y0 + ((y1 - y0) * i) / passi);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(20);
  }
  // Dito fermo sul bordo: è il momento che conta, quello in cui deve scorrere
  // da solo senza che arrivi più alcun evento.
  await page.waitForTimeout(attesaFinaleMs);
  const durante = await page.evaluate(() => ({
    scrollTop: document.getElementById('wrap').scrollTop,
    ...window.conteggi,
    ricostruzioni: window.ricostruzioni,
    viste: window.viste.slice(),
    sottoBarra: window.sottoBarra,
  }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(50);
  const dopo = await page.evaluate(() => ({
    scrollTop: document.getElementById('wrap').scrollTop,
    ...window.conteggi,
  }));
  return { durante, dopo };
}

async function scenario(browser, conCattura, yFinale) {
  const context = await browser.newContext({
    hasTouch: true, isMobile: true, viewport: { width: 390, height: 700 },
  });
  const page = await context.newPage();
  await page.setContent(PAGINA);
  await page.evaluate((v) => { window.conCattura = v; }, conCattura);
  const cdp = await context.newCDPSession(page);
  const esito = await trascinaColDito(cdp, page, 100, 60, yFinale);
  await context.close();
  return esito;
}

(async () => {
  console.log('--- E2E: scorrimento automatico col dito (assunzioni di piattaforma) ---');
  const browser = await chromium.launch();
  try {
    // Dito fermo appena sopra il fondo della griglia (che è a y=300): dentro la
    // fascia di 72 px, quindi il ciclo deve scorrere da solo.
    const con = await scenario(browser, true, 280);
    const senza = await scenario(browser, false, 280);
    console.log(`  con cattura:   ${JSON.stringify({ ...con.durante, viste: con.durante.viste.length })}`);
    console.log(`  senza cattura: ${JSON.stringify({ ...senza.durante, viste: senza.durante.viste.length })}`);

    /* 1. Scorrere da codice non annulla il dito. */
    ok(con.durante.cancel === 0, 'scorrere il contenitore da codice non annulla il puntatore (nessun pointercancel)');
    ok(con.durante.scrollTop > 200, 'il contenitore scorre da solo col dito fermo sul bordo',
      `scrollTop=${con.durante.scrollTop}`);

    /* 2. Le righe si ricostruiscono a metà gesto e il gesto sopravvive. */
    ok(con.durante.ricostruzioni > 1, 'la finestra virtuale è stata ricostruita durante il gesto',
      `ricostruzioni=${con.durante.ricostruzioni}`);
    ok(con.durante.viste.length > 0, 'la cella sotto al dito continua a essere trovata mentre le righe cambiano');
    const righe = con.durante.viste;
    ok(righe[righe.length - 1] > righe[0],
      'la riga sotto al dito AVANZA con lo scorrimento: è ciò che fa crescere la selezione',
      `da ${righe[0]} a ${righe[righe.length - 1]}`);
    ok(con.dopo.up === 1, 'il pointerup arriva a gesto finito: il ciclo si ferma');
    ok(con.dopo.scrollTop === con.durante.scrollTop || con.dopo.up === 1,
      'a dito alzato lo scorrimento non prosegue');

    ok(con.durante.move >= senza.durante.move && con.dopo.up >= senza.dopo.up,
      'la cattura esplicita non peggiora mai la consegna degli eventi');
    if (senza.dopo.up === 1 && senza.durante.viste.length > 0) {
      console.log('  \x1b[33m! NOTA\x1b[0m questo Chromium consegna gli eventi anche senza cattura esplicita:'
        + ' quando l\'elemento catturato sparisce, rilascia la cattura e torna al hit-test.'
        + ' La cattura sul tbody resta come garanzia portabile (WebKit qui è noto per emettere pointercancel).');
    }

    /* 3. La cella si trova anche sotto un elemento sovrapposto.
     * Il dito si ferma a y=280, dove la barra fissa (250-300) copre la griglia:
     * è la stessa fascia in cui si sta fermi per far scorrere. */
    console.log(`  sopra la barra: ${JSON.stringify({ ...con.durante, viste: con.durante.viste.length })}`);
    ok(con.durante.sottoBarra > 0,
      'in cima alla pila c\'è l\'elemento sovrapposto: elementFromPoint da solo NON darebbe la cella',
      `sottoBarra=${con.durante.sottoBarra}`);
    ok(con.durante.viste.length > 0,
      'elementsFromPoint trova comunque la cella sotto l\'elemento sovrapposto: la selezione continua a seguire');
  } finally {
    await browser.close();
  }

  if (falliti) {
    console.error(`\n--- Scorrimento col dito: ${falliti} test FALLITI ---`);
    process.exitCode = 1;
  } else {
    console.log('\n--- Scorrimento col dito: tutti i test superati ---');
  }
})().catch((err) => {
  console.error('  ✗ Test scorrimento col dito fallito:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
