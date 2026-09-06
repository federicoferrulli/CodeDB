'use strict';

/* ---------------------------------------------------------------------------
 * E2E (Chromium): le maniglie di ridimensionamento rispondono al DITO, non
 * solo al mouse.
 *
 * PERCHÉ ESISTE
 * Tre maniglie, tre implementazioni: quella della Split-View era stata portata
 * a Pointer Events, le altre due — la barra laterale (e con lei l'albero dei
 * database e lo Schema Browser della tab ⚡) e il separatore fra editor e
 * risultati — erano rimaste su `mousedown`/`mousemove`. Un evento di mouse non
 * arriva da un dito né da una penna: su un dispositivo tattile quelle maniglie
 * si vedevano, mostravano il cursore giusto e non facevano nulla. Il difetto
 * non si vede leggendo il codice, perché ciascuna copia è coerente con sé
 * stessa; si vede solo mandando eventi di puntatore di tipo `touch`.
 *
 * Il secondo controllo riguarda l'aritmetica: il separatore verticale scriveva
 * ENTRAMBE le altezze, e i due pannelli hanno un `min-height`. Appena uno dei
 * due lo incontrava, la sua altezza non veniva più applicata mentre l'altra
 * continuava a crescere: la somma superava il contenitore e il fondo dei
 * risultati finiva fuori dalla vista.
 *
 * Uso: node test/e2e-maniglie-tocco.js
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

/**
 * Trascina la maniglia `sel` di (dx, dy) con eventi di puntatore di tipo TOUCH.
 * Il corpo viene serializzato e rivalutato dentro la pagina: è l'unico modo di
 * riusare la stessa funzione in più `page.evaluate`.
 */
function trascinaColDito(sel, dx, dy) {
  const el = document.querySelector(sel);
  if (!el) return { errore: `maniglia assente: ${sel}` };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const manda = (tipo, cx, cy) => el.dispatchEvent(new PointerEvent(tipo, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: cx,
    clientY: cy,
  }));
  manda('pointerdown', x, y);
  manda('pointermove', x + dx / 2, y + dy / 2);
  manda('pointermove', x + dx, y + dy);
  manda('pointerup', x + dx, y + dy);
  return { ok: true };
}

(async () => {
  console.log('--- E2E: le maniglie si trascinano col dito ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_MANIGLIE_PORT, 10) || 3155 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, hasTouch: true });
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
      document.getElementById('onboarding-overlay')?.remove();
      document.getElementById('welcome').classList.add('hidden');
      document.getElementById('tab-body').classList.remove('hidden');
      document.getElementById('workspace').classList.remove('hidden');
      document.getElementById('placeholder').classList.add('hidden');
    });

    const sorgente = trascinaColDito.toString();

    /* --- Maniglia ORIZZONTALE: la barra delle connessioni ---------------- */

    const barra = await page.evaluate((fn) => {
      const trascina = new Function(`return (${fn})`)();
      const el = document.getElementById('conn-sidebar');
      const prima = Math.round(el.getBoundingClientRect().width);
      const esito = trascina('.resizer[data-resize="conn-sidebar"]', 90, 0);
      return { prima, dopo: Math.round(el.getBoundingClientRect().width), esito };
    }, sorgente);

    ok(!barra.esito.errore, 'la maniglia della barra connessioni esiste', JSON.stringify(barra.esito));
    ok(barra.dopo > barra.prima + 40,
      `barra connessioni: il dito la allarga davvero (${barra.prima} -> ${barra.dopo})`,
      'invariata = la maniglia ascolta solo il mouse');

    /* --- Maniglia VERTICALE: editor / risultati della tab ⚡ -------------- */

    const editore = await page.evaluate(async (fn) => {
      const trascina = new Function(`return (${fn})`)();
      for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
      document.getElementById('view-query').classList.remove('hidden');
      await new Promise((r) => setTimeout(r, 200));
      const top = document.getElementById('query-editor-container');
      const basso = document.getElementById('query-results-container');
      const resizer = document.getElementById('query-editor-resizer');
      const prima = Math.round(top.getBoundingClientRect().height);
      const esito = trascina('#query-editor-resizer', 0, 80);
      return {
        prima,
        esito,
        dopo: Math.round(top.getBoundingClientRect().height),
        contenitore: Math.round(top.parentElement.getBoundingClientRect().height),
        somma: Math.round(top.getBoundingClientRect().height)
          + Math.round(basso.getBoundingClientRect().height)
          + Math.round(resizer.getBoundingClientRect().height),
      };
    }, sorgente);

    ok(!editore.esito.errore, 'la maniglia editor/risultati esiste', JSON.stringify(editore.esito));
    ok(editore.dopo > editore.prima + 40,
      `editor ⚡: il dito lo ingrandisce davvero (${editore.prima} -> ${editore.dopo})`,
      'invariato = la maniglia ascolta solo il mouse');
    ok(Math.abs(editore.somma - editore.contenitore) <= 2,
      `editor + risultati riempiono il contenitore senza sforare (${editore.somma} contro ${editore.contenitore})`,
      'una somma maggiore del contenitore taglia fuori il fondo dei risultati');

    /* --- Spinta OLTRE il minimo: è lì che l'aritmetica si rompeva -------- */

    const oltre = await page.evaluate((fn) => {
      const trascina = new Function(`return (${fn})`)();
      const top = document.getElementById('query-editor-container');
      const basso = document.getElementById('query-results-container');
      const resizer = document.getElementById('query-editor-resizer');
      trascina('#query-editor-resizer', 0, -900);
      return {
        contenitore: Math.round(top.parentElement.getBoundingClientRect().height),
        somma: Math.round(top.getBoundingClientRect().height)
          + Math.round(basso.getBoundingClientRect().height)
          + Math.round(resizer.getBoundingClientRect().height),
        altezzaTop: Math.round(top.getBoundingClientRect().height),
        minTop: parseFloat(getComputedStyle(top).minHeight) || 0,
      };
    }, sorgente);

    ok(Math.abs(oltre.somma - oltre.contenitore) <= 2,
      `spinta oltre il minimo dell'editor, la somma resta quella del contenitore (${oltre.somma} contro ${oltre.contenitore})`,
      JSON.stringify(oltre));
    ok(oltre.altezzaTop >= oltre.minTop - 1,
      `l'editor non scende sotto il proprio minimo (${oltre.altezzaTop} >= ${oltre.minTop})`,
      JSON.stringify(oltre));

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join('\n         '));
  } finally {
    await browser.close();
    await server.stop();
  }

  if (falliti) {
    console.error(`\n--- Maniglie: ${falliti} test falliti ---`);
    process.exit(1);
  }
  console.log('\n--- Maniglie: tutti i test superati ---');
})();
