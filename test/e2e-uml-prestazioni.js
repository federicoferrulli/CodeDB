'use strict';

/* ---------------------------------------------------------------------------
 * Misure di prestazione UML: i numeri che il piano chiede di FISSARE, non di
 * presumere (fase 1: hardware, browser e fixture dichiarati qui sotto).
 *
 * Fixture: 100 tabelle da 8 campi, 200 relazioni, socket finto istantaneo.
 * Si misurano tre cose, separate:
 *   1. apertura (schema finto -> diagramma inquadrato);
 *   2. trascinamento di un nodo: p50/p95/max dei fotogrammi durante il gesto;
 *   3. inserimenti incrementali: doppio clic da catalogo, uno alla volta.
 *
 * I budget sono gate di regressione tarati su QUESTO ambiente (headless,
 * raster software), non gli obiettivi del piano (p95 sotto 33 ms su hardware
 * reale): i valori misurati sono stampati e trascritti nel piano. Su una
 * macchina diversa questi numeri vanno rifissati, non inseguiti.
 *
 * Uso: node test/e2e-uml-prestazioni.js
 * ------------------------------------------------------------------------- */

const os = require('os');
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
const info = (s) => console.log(`      ${s}`);

function fixture() {
  const nomi = Array.from({ length: 100 }, (_, i) => `tab_${String(i).padStart(3, '0')}`);
  return {
    collections: nomi.map((name) => ({
      name,
      rowsApprox: 100,
      fields: Array.from({ length: 8 }, (_, j) => ({ name: `c${j}`, types: ['int'] })),
    })),
    relations: Array.from({ length: 200 }, (_, i) => ({
      from: nomi[i % 100],
      field: `f${i}`,
      to: nomi[(i * 7 + 13) % 100],
      toField: 'id',
      constraint: `fk_${i}`,
      ordine: 1,
      origine: 'vincolo',
    })),
    schemaPage: { complete: true },
  };
}

(async () => {
  console.log('--- Prestazioni UML (misura, non presunzione) ---');
  console.log(`      macchina: ${os.cpus()[0].model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB`);
  const server = await startTestServer({ port: parseInt(process.env.E2E_UML_PERF_PORT, 10) || 3153 });
  const browser = await chromium.launch();
  console.log(`      browser: Chromium ${browser.version()}`);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errori = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    const t0 = Date.now();
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#uml-canvas', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(500);
    await page.evaluate(async (schema) => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      impostaSocket({
        emit: (evento, msg, cb) => {
          if (!cb) return;
          if (evento === 'db:schema') { cb({ ok: true, ...JSON.parse(JSON.stringify(schema)) }); return; }
          if (evento === 'collection:stats') { cb({ ok: true, fields: [], indexes: [], stats: null }); return; }
          cb({ ok: true });
        },
        on: () => {}, off: () => {},
      });
      const guida = document.getElementById('onboarding-overlay');
      if (guida) guida.remove();
      const tab = createTab({ id: 'tab-uml', connName: null });
      tab.state.connected = true;
      tab.state.db = 'perf';
      tab.state.coll = null;
      tab.state.connId = 'conn-prova';
      tab.state.view = 'uml';
      tabs.activeId = tab.id;
      document.getElementById('welcome').classList.add('hidden');
      document.getElementById('tab-body').classList.remove('hidden');
      document.getElementById('workspace').classList.remove('hidden');
      for (const v of document.querySelectorAll('#workspace .view-panel')) v.classList.add('hidden');
      document.getElementById('view-uml').classList.remove('hidden');
      const uml = await import('/js/uml.js');
      window.__uml = uml;
      uml.loadUml(true);
    }, fixture());
    await page.waitForFunction(
      () => document.querySelectorAll('#uml-canvas .joint-element').length >= 100
        && document.querySelectorAll('#uml-canvas .joint-link').length >= 150,
      { timeout: 60000 });
    await page.waitForTimeout(800);
    const apertura = await page.evaluate(() => ({
      nodi: document.querySelectorAll('#uml-canvas .joint-element').length,
      archi: document.querySelectorAll('#uml-canvas .joint-link').length,
    }));
    info(`apertura: ${apertura.nodi} nodi, ${apertura.archi} archi in ${Date.now() - t0} ms (parete, fixture inclusa)`);
    ok(apertura.nodi === 100 && apertura.archi >= 150, 'la fixture è quella dichiarata', JSON.stringify(apertura));

    /* --- Trascinamento: fotogrammi durante un gesto vero ------------------ */
    await page.click('#uml-mode-modifica');
    await page.waitForTimeout(200);
    const da = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#uml-canvas .joint-element')][10];
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) };
    });
    const xPrima = await page.evaluate(() => {
      const doc = window.__uml.statoUml().doc;
      return Object.values(doc.nodi)[10].x;
    });
    // Il campionatore gira INSIEME al gesto: lo si avvia senza attenderlo,
    // si trascina, poi si alza la bandierina e si attende la fine.
    const campionatura = page.evaluate(() => new Promise((resolve) => {
      const tempi = [];
      let ultimo = performance.now();
      let conta = 0;
      window.__tempi = tempi;
      const giro = () => {
        const ora = performance.now();
        if (conta++ > 5) tempi.push(ora - ultimo);
        ultimo = ora;
        if (!window.__stopFrame) requestAnimationFrame(giro);
        else resolve();
      };
      requestAnimationFrame(giro);
      // Sicura: anche se il gesto non partisse, il campionatore finisce.
      setTimeout(() => { window.__stopFrame = true; }, 15000);
    }));
    await page.mouse.move(da.x, da.y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(da.x + i * 9, da.y + i * 6);
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
    await page.evaluate(() => { window.__stopFrame = true; });
    await campionatura;
    const xDopo = await page.evaluate(() => Object.values(window.__uml.statoUml().doc.nodi)[10].x);
    ok(Math.abs(xDopo - xPrima) > 50, 'il trascinamento misurato è reale', `${xPrima} → ${xDopo}`);
    const fotogrammi = await page.evaluate(() => {
      const t = (window.__tempi || []).filter((d) => d < 1000);
      const ord = t.slice().sort((a, b) => a - b);
      const pct = (p) => (ord.length ? ord[Math.min(ord.length - 1, Math.floor((p / 100) * ord.length))] : 0);
      return { n: t.length, p50: pct(50).toFixed(1), p95: pct(95).toFixed(1), max: (ord.length ? ord[ord.length - 1] : 0).toFixed(1) };
    });
    info(`trascinamento su 100 nodi/200 archi: ${fotogrammi.n} fotogrammi, p50 ${fotogrammi.p50} ms, p95 ${fotogrammi.p95} ms, max ${fotogrammi.max} ms`);
    // Il gate è 100 ms, NON i 33 del piano: su 5 nodi questo stesso ambiente
    // misura p95 ~68 ms contro ~64 di 100 nodi, quindi la coda è il pavimento
    // dell'headless (raster software + input via CDP), non la scala. Il gate
    // cattura le regressioni vere (una pittura da 130 ms o un rebuild da
    // secondi lo sfondano); i 33 ms restano l'obiettivo su hardware reale.
    ok(Number(fotogrammi.p95) < 100, 'p95 dei fotogrammi sotto il budget di regressione (100 ms)', `p95=${fotogrammi.p95} ms`);

    /* --- Sagoma: dettaglio proporzionato allo zoom ------------------------- */
    const scalaFit = await page.evaluate(() => window.__uml.statoUml().tavola.scala);
    const nascosteFit = await page.evaluate(() =>
      document.querySelectorAll('#uml-canvas .joint-element text[display="none"]').length);
    ok(scalaFit < 0.5 && nascosteFit > 100,
      'a vista intera i campi si nascondono (sagoma)', `scala=${scalaFit.toFixed(2)}, testi nascosti=${nascosteFit}`);
    for (let i = 0; i < 8; i++) await page.click('#uml-zoom-piu');
    await page.waitForTimeout(500);
    const scalaVicino = await page.evaluate(() => window.__uml.statoUml().tavola.scala);
    const nascosteVicino = await page.evaluate(() =>
      document.querySelectorAll('#uml-canvas .joint-element text[display="none"]').length);
    ok(scalaVicino >= 0.5 && nascosteVicino === 0,
      'da vicino i campi tornano', `scala=${scalaVicino.toFixed(2)}, nascosti=${nascosteVicino}`);
    for (let i = 0; i < 8; i++) await page.click('#uml-zoom-meno');
    await page.waitForTimeout(500);
    const svgSagoma = await page.evaluate(() => window.__uml.statoUml().tavola.esportaSvg({}));
    ok(/c0/.test(svgSagoma) && !/display="none"/.test(svgSagoma),
      'l’export dalla sagoma porta tutti i campi', `byte=${svgSagoma.length}`);

    /* --- Inserimenti incrementali: un doppio clic alla volta -------------- */
    await page.evaluate(() => {
      const st = window.__uml.statoUml();
      for (const k of Object.keys(st.doc.nodi).slice(0, 10)) delete st.doc.nodi[k];
      st.selezione = [];
    });
    const durate = [];
    for (let i = 0; i < 10; i++) {
      const punto = await page.evaluate(() => {
        const st = window.__uml.statoUml();
        const voce = [...document.querySelectorAll('#uml-catalogo-lista [data-chiave]')]
          .find((v) => !st.doc.nodi[v.dataset.chiave]);
        if (!voce) return null;
        const r = voce.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      const t = Date.now();
      const attesi = await page.evaluate(() => Object.keys(window.__uml.statoUml().doc.nodi).length + 1);
      await page.mouse.dblclick(punto.x, punto.y);
      await page.waitForFunction(
        (n) => Object.keys(window.__uml.statoUml().doc.nodi).length === n,
        attesi, { timeout: 15000 });
      durate.push(Date.now() - t);
    }
    const maxIns = Math.max(...durate);
    info(`10 inserimenti: max ${maxIns} ms, media ${(durate.reduce((a, b) => a + b, 0) / durate.length).toFixed(0)} ms`);
    ok(maxIns < 500, 'nessun inserimento blocca oltre il budget (500 ms)', `max=${maxIns} ms`);
    ok(errori.length === 0, 'nessun errore durante le misure', errori.join(' | '));
    await page.close();
  } finally {
    await browser.close();
    await server.stop();
  }
  console.log(falliti === 0 ? '\n--- Prestazioni UML: misure registrate ---' : `\n--- Prestazioni UML: ${falliti} controlli falliti ---`);
  process.exit(falliti === 0 ? 0 : 1);
})();
