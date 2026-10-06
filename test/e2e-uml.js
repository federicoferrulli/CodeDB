'use strict';

// Diagramma di sola consultazione: caricamento locale, FK, dati, esportazione e rimontaggio.

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

// `righe` ha una FK COMPOSTA su `ordini` (due colonne, un vincolo) più una
// seconda FK verso lo stesso nodo: due archi, non tre. `dipendenti` si
// auto-riferisce. `esterna` sta in un altro schema.
const SCHEMA = {
  collections: [
    { name: 'ordini', rowsApprox: 120, fields: [{ name: 'id', pk: true, types: ['int'] }, { name: 'anno', pk: true, types: ['int'] }, { name: 'cliente_id', types: ['int'] }] },
    { name: 'righe', rowsApprox: 900, fields: [{ name: 'id', pk: true, types: ['int'] }, { name: 'ordine_id', types: ['int'] }, { name: 'ordine_anno', types: ['int'] }, { name: 'ordine_orig', types: ['int'] }] },
    { name: 'clienti', rowsApprox: 30, fields: [{ name: 'id', pk: true, types: ['int'] }, { name: 'nome', types: ['varchar'] }] },
    { name: 'dipendenti', rowsApprox: 8, fields: [{ name: 'id', pk: true, types: ['int'] }, { name: 'capo_id', types: ['int'] }] },
    { name: 'note', rowsApprox: 0, fields: [{ name: 'id', pk: true, types: ['int'] }, { name: 'utente_id', types: ['int'] }] },
  ],
  relations: [
    { from: 'righe', field: 'ordine_id', to: 'ordini', toField: 'id', constraint: 'fk_riga_ordine', ordine: 1, origine: 'vincolo', many: true },
    { from: 'righe', field: 'ordine_anno', to: 'ordini', toField: 'anno', constraint: 'fk_riga_ordine', ordine: 2, origine: 'vincolo', many: true },
    { from: 'righe', field: 'ordine_orig', to: 'ordini', toField: 'id', constraint: 'fk_riga_origine', ordine: 1, origine: 'vincolo', many: true },
    { from: 'ordini', field: 'cliente_id', to: 'clienti', toField: 'id', constraint: 'fk_ordine_cliente', ordine: 1, origine: 'vincolo', many: true },
    { from: 'dipendenti', field: 'capo_id', to: 'dipendenti', toField: 'id', constraint: 'fk_capo', ordine: 1, origine: 'vincolo' },
    { from: 'note', field: 'utente_id', to: 'utenti', origine: 'euristica' },
  ],
  schemaPage: { complete: true, cursor: 0, nextCursor: null, totals: { collections: 5 } },
};

(async () => {
  console.log('--- E2E: diagramma UML interattivo (JointJS) ---');
  const server = await startTestServer({ port: parseInt(process.env.E2E_UML_PORT, 10) || 3151 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errori = [];
    const retiEsterne = [];
    page.on('pageerror', (err) => errori.push(String(err && err.message ? err.message : err)));
    // Un asset preso dalla rete è il difetto che «vendorizzato» esiste per
    // togliere: qui si registra ogni richiesta che esce dall'origine di prova.
    page.on('request', (req) => {
      // I font della pagina sono un'altra storia (e un'altra decisione):
      // qui interessa che NESSUNA risorsa del diagramma arrivi dalla rete.
      const esterna = !req.url().startsWith(server.url) && !req.url().startsWith('data:') && !req.url().startsWith('blob:');
      if (esterna && /joint|diagram|dagre|backbone|lodash/i.test(req.url())) retiEsterne.push(req.url());
    });

    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#uml-canvas', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(600);

    /* --- Preparazione: workspace visibile, socket finto, schema in cache --- */
    await page.evaluate(async (schema) => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');

      window.__richieste = [];
      impostaSocket({
        emit: (evento, msg, cb) => {
          window.__richieste.push({ evento, msg: JSON.parse(JSON.stringify(msg || {})) });
          if (!cb) return;
          if (evento === 'db:schema') {
            cb({ ok: true, ...JSON.parse(JSON.stringify(schema)) });
            return;
          }
          if (evento === 'collection:stats') {
            cb({
              ok: true,
              fields: [{ name: 'id', pk: true, types: ['int'] }, { name: 'nome', types: ['varchar'] }, { name: 'extra_completo', types: ['text'] }],
              indexes: [{ name: 'PRIMARY', unique: true, key: { id: 1 } }],
              stats: { count: 3 },
            });
            return;
          }
          if (evento === 'collection:find') {
            cb({
              ok: true,
              docs: [
                { id: 1, anno: 2026, profilo: { citta: 'Roma', cap: '00100' } },
                { id: 2, anno: 2026, profilo: { citta: 'Milano' }, tag: ['a', 'b'] },
              ],
              columns: ['id', 'anno', 'profilo'],
            });
            return;
          }
          cb({ ok: true });
        },
        on: () => {},
        off: () => {},
      });

      const guida = document.getElementById('onboarding-overlay');
      if (guida) guida.classList.add('hidden');
      const tab = createTab({ id: 'tab-uml', connName: null });
      tab.state.connected = true;
      tab.state.db = 'vendite';
      tab.state.coll = null;
      tab.state.connId = 'conn-prova';
      tab.state.dbSchema = JSON.parse(JSON.stringify(schema));
      tab.state.dbSchemaFor = 'vendite';
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
    }, SCHEMA);

    await page.waitForSelector('#uml-canvas .joint-element', { timeout: 15000 });
    await page.waitForTimeout(600);

    /* --- 1. JointJS locale, diagramma montato ------------------------------ */
    const montato = await page.evaluate(() => ({
      nodi: document.querySelectorAll('#uml-canvas .joint-element').length,
      archi: document.querySelectorAll('#uml-canvas .joint-link').length,
      jointLocale: [...document.querySelectorAll('script')].some((s) => s.src.includes('/vendor/joint/joint.min.js')),
      catalogo: document.querySelectorAll('#uml-catalogo-lista [data-chiave]').length,
    }));
    ok(montato.jointLocale, 'JointJS è servito da public/vendor, non da un CDN');
    ok(retiEsterne.length === 0, 'nessuna risorsa del diagramma arriva dalla rete', retiEsterne.join(', '));
    ok(montato.nodi === 5, 'i cinque oggetti dello schema sono nodi del diagramma', `nodi=${montato.nodi}`);
    ok(montato.catalogo === 5, 'il catalogo elenca gli stessi oggetti', `voci=${montato.catalogo}`);

    /* --- 2. Una FK composta è UN arco -------------------------------------- */
    // Sei righe di relazione, ma: fk_riga_ordine è composta (2 righe → 1 arco),
    // fk_riga_origine 1, fk_ordine_cliente 1, fk_capo 1 (auto-riferimento), e
    // la relazione verso `utenti` non ha nodo di destinazione nel diagramma.
    ok(montato.archi === 4, 'le due righe della FK composta danno UN arco solo', `archi=${montato.archi}`);

    const etichette = await page.evaluate(() =>
      [...document.querySelectorAll('#uml-canvas .joint-link text')].map((t) => t.textContent.trim()));
    ok(etichette.some((t) => t.startsWith('FK') && t.includes('2 colonne')),
      'l’arco composto DICHIARA di valere due colonne', etichette.join(' | '));
    ok(etichette.every((t) => /^(FK|ipotesi|logica)/.test(t)),
      'ogni arco dice la propria origine a parole, non col solo colore', etichette.join(' | '));

    /* --- 3. Il trascinamento non modifica il diagramma -------------------- */
    const posizioneDi = (nome) => page.evaluate((n) => {
      const el = [...document.querySelectorAll('#uml-canvas .joint-element')]
        .find((e) => e.textContent.includes(n));
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: r.width, h: r.height };
    }, nome);

    const trascina = async (da) => {
      await page.mouse.move(da.x + 40, da.y + 10);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(da.x + 40 + i * 14, da.y + 10 + i * 9);
      await page.mouse.up();
      await page.waitForTimeout(250);
    };

    const dentroIlCanvas = async (nome) => {
      const n = await posizioneDi(nome);
      const c = await page.evaluate(() => {
        const r = document.getElementById('uml-canvas').getBoundingClientRect();
        return { x: r.left, y: r.top, r: r.right, b: r.bottom };
      });
      return n.x > c.x && n.x + 60 < c.r && n.y > c.y + 60 && n.y + 30 < c.b;
    };
    ok(await dentroIlCanvas('clienti'),
      'all’apertura il diagramma è INQUADRATO: nessun nodo nasce fuori dalla vista');

    const primaEsplora = await posizioneDi('clienti');
    await trascina(primaEsplora);
    const dopoEsplora = await posizioneDi('clienti');
    ok(Math.abs(dopoEsplora.x - primaEsplora.x) < 3 && Math.abs(dopoEsplora.y - primaEsplora.y) < 3,
      'il trascinamento lascia il nodo fermo',
      `${JSON.stringify(primaEsplora)} → ${JSON.stringify(dopoEsplora)}`);
    /* --- 4. Ispettore: metadati completi chiesti al server ------------------ */
    const nodoScelto = await posizioneDi('clienti');
    await page.mouse.click(nodoScelto.x + 40, nodoScelto.y + 10);
    await page.waitForTimeout(500);
    const ispettore = await page.evaluate(() => {
      return {
        testo: document.getElementById('uml-ispettore-corpo').textContent,
        chiamate: window.__richieste.filter((r) => r.evento === 'collection:stats').length,
      };
    });
    ok(ispettore.chiamate >= 1, 'l’ispettore chiede i metadati COMPLETI dell’oggetto scelto');
    ok(/extra_completo/.test(ispettore.testo),
      'e mostra anche i campi che lo schema progressivo aveva tagliato');
    ok(/PRIMARY/.test(ispettore.testo), 'gli indici compaiono nell’ispettore');
    ok(/caricato/.test(ispettore.testo),
      'la completezza è dichiarata a parole («caricato»), non lasciata indovinare');

    /* --- 5. Celle: i sottodocumenti restano leggibili ---------------------- */
    await page.click('#uml-ispettore-corpo [data-isp="dati"]');
    await page.waitForTimeout(400);
    const dati = await page.evaluate(() => document.getElementById('uml-dati-corpo').textContent);
    ok(/Roma/.test(dati), 'i sottodocumenti si leggono nelle celle', dati.slice(0, 160));
    ok(!/\[object Object\]/.test(dati), 'nessuna cella dice «[object Object]»');
    await page.click('#uml-dati-chiudi');
    await page.waitForTimeout(200);
    /* --- 6. Export SVG autonomo ------------------------------------------- */
    const svg = await page.evaluate(() => window.__uml.statoUml().tavola.esportaSvg({}));
    ok(svg.startsWith('<svg') || svg.includes('<svg'), 'l’export produce un SVG');
    ok(!/<script/i.test(svg), 'nessuno script nell’SVG esportato');
    ok(/fill="#|fill="rgb/.test(svg), 'i colori sono INCORPORATI: l’SVG non dipende dal foglio di stile dell’app');
    ok(!/class="joint-layers"[^>]*transform=/.test(svg),
      'la trasformazione di vista non finisce nell’export: il viewBox inquadra il contenuto');
    ok(/righe/.test(svg) && /ordini/.test(svg), 'i nomi delle tabelle ci sono per intero nell’SVG');

    /* --- Un secondo montaggio: il canvas sopravvive a `distruggi()` -------- */
    // Il Paper ADOTTA l'elemento che riceve: montato su `#uml-canvas`,
    // `paper.remove()` cancellava il contenitore dalla pagina e il montaggio
    // seguente moriva su `innerHTML` di `null` (cambio di database,
    // «Rigenera», ritorno sulla vista). Si prova quindi il RIMONTAGGIO, che è
    // l'unica cosa che il primo non dice.
    const nodiPrimaRimontaggio = await page.locator('#uml-canvas .joint-element').count();
    await page.evaluate(() => window.__uml.loadUml(true));
    await page.waitForTimeout(900);
    const rimontato = await page.evaluate(() => ({
      canvas: !!document.getElementById('uml-canvas'),
      nodi: document.querySelectorAll('#uml-canvas .joint-element').length,
    }));
    ok(rimontato.canvas, '#uml-canvas è ancora in pagina dopo un rimontaggio');
    ok(rimontato.nodi === nodiPrimaRimontaggio, 'il secondo montaggio conserva tutti i nodi', `nodi=${rimontato.nodi}`);

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }

  console.log(falliti === 0 ? '\n--- UML: tutti i test superati ---' : `\n--- UML: ${falliti} test falliti ---`);
  process.exit(falliti === 0 ? 0 : 1);
})();
