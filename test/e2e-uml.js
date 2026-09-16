'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E: il diagramma UML interattivo, con JointJS vero, in Chromium.
 *
 * PERCHÉ ESISTE. Le regole del modello sono pure e provate senza browser
 * (`test/unit-uml-modello.js`), ma una regola giusta collegata a nulla è
 * indistinguibile da una regola sbagliata. Qui si prova ciò che solo il
 * browser può dire:
 *
 *   1. JointJS si carica DA `public/vendor` e non dalla rete, e il diagramma
 *      compare (il difetto opposto — «vendorizzato» ma servito da un CDN — non
 *      si vede finché non si stacca la rete);
 *   2. una FK COMPOSTA è un arco solo: sul canvas si contano gli archi, non le
 *      righe dello schema;
 *   3. un trascinamento vero sposta il nodo e lascia UNA voce di storia:
 *      «Annulla» una volta sola rimette tutto dov'era;
 *   4. in «Esplora» il nodo NON si muove — la modalità non è un'etichetta;
 *   5. il rilascio dal catalogo mette il nodo dove è caduto il puntatore,
 *      anche dopo pan e zoom (era il difetto classico: coordinate dello
 *      schermo scambiate per coordinate del grafo);
 *   6. l'SVG esportato è autonomo: porta i propri colori, non contiene script
 *      e non contiene la trasformazione di vista.
 *
 * Nessun database: lo schema è finto e il socket è finto.
 *
 * Uso: node test/e2e-uml.js
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
      if (guida) guida.remove();
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

    /* --- 3. Trascinamento vero + annullamento in UNA voce ------------------ */
    const posizioneDi = (nome) => page.evaluate((n) => {
      const el = [...document.querySelectorAll('#uml-canvas .joint-element')]
        .find((e) => e.textContent.includes(n));
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: r.width, h: r.height };
    }, nome);

    // Lo stesso gesto, sempre: due procedure diverse non sarebbero
    // confrontabili, ed e' il confronto a dire se la modalita' conta.
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

    await page.click('#uml-mode-modifica');
    await page.waitForTimeout(150);
    const prima = await posizioneDi('clienti');
    await trascina(prima);
    const dopo = await posizioneDi('clienti');
    ok(Math.abs(dopo.x - prima.x) > 80, 'in «Modifica diagramma» il trascinamento sposta davvero il nodo',
      `${prima.x} → ${dopo.x}`);

    // Una VOCE, non una per movimento del mouse: contare le voci è l'unico
    // modo di distinguerlo, perché anche dieci istantanee identiche si
    // annullerebbero «bene» al primo colpo e poi non farebbero più nulla.
    const voci = await page.evaluate(() => window.__uml.statoUml().cronologia.indietro.length);
    ok(voci === 1, 'un gesto lascia UNA voce di storia, non una per movimento', `voci=${voci}`);

    await page.click('#uml-undo');
    await page.waitForTimeout(300);
    const annullato = await posizioneDi('clienti');
    ok(Math.abs(annullato.x - prima.x) < 12 && Math.abs(annullato.y - prima.y) < 12,
      'UN «Annulla» riporta il nodo dov’era: un gesto è una voce',
      `atteso ~${JSON.stringify(prima)}, ottenuto ${JSON.stringify(annullato)}`);

    const ripetibile = await page.evaluate(() => document.getElementById('uml-redo').disabled);
    ok(ripetibile === false, 'dopo un annullamento «Ripeti» è disponibile');

    /* --- 4. La modalita' non e' un'etichetta: in «Esplora» nulla si sposta -- */
    // Stesso nodo, stesso gesto, stessa pagina: cambia solo la modalita'.
    await page.click('#uml-mode-esplora');
    await page.waitForTimeout(150);
    const primaEsplora = await posizioneDi('clienti');
    await trascina(primaEsplora);
    const dopoEsplora = await posizioneDi('clienti');
    ok(Math.abs(dopoEsplora.x - primaEsplora.x) < 3 && Math.abs(dopoEsplora.y - primaEsplora.y) < 3,
      'in «Esplora» lo STESSO gesto non sposta nulla: la modalità non è un’etichetta',
      `${JSON.stringify(primaEsplora)} → ${JSON.stringify(dopoEsplora)}`);
    await page.click('#uml-mode-modifica');
    await page.waitForTimeout(150);

    /* --- 5. Rilascio dal catalogo dopo pan e zoom -------------------------- */
    // Si toglie `clienti` dal diagramma con i comandi VERI (clic sul nodo,
    // poi «Rimuovi»), per poterlo rimettere con il rilascio dal catalogo.
    const daTogliere = await posizioneDi('clienti');
    await page.mouse.click(daTogliere.x + 40, daTogliere.y + 10);
    await page.waitForTimeout(150);
    await page.click('#uml-rimuovi');
    await page.waitForTimeout(250);

    const rilascio = await page.evaluate(async () => {
      const uml = window.__uml;
      const { $ } = await import('/js/utils.js');
      const chiave = [...document.querySelectorAll('#uml-catalogo-lista [data-chiave]')]
        .find((v) => v.textContent.includes('clienti')).dataset.chiave;

      // Pan e zoom NON banali: con le coordinate dello schermo scambiate per
      // coordinate del grafo il nodo cadrebbe altrove, e di parecchio.
      const tavola = uml.statoUml().tavola;
      tavola.paper.scale(1.7, 1.7);
      tavola.paper.translate(-260, -140);

      const canvas = $('#uml-canvas');
      const r = canvas.getBoundingClientRect();
      const puntoSchermo = { x: Math.round(r.left + 420), y: Math.round(r.top + 260) };
      const atteso = tavola.paper.clientToLocalPoint(puntoSchermo);

      const dati = new DataTransfer();
      dati.setData('application/x-codedb-uml', chiave);
      canvas.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dati,
        clientX: puntoSchermo.x, clientY: puntoSchermo.y,
      }));
      await new Promise((r2) => setTimeout(r2, 300));
      const nodo = uml.statoUml().doc.nodi[chiave];
      return { atteso: { x: Math.round(atteso.x), y: Math.round(atteso.y) }, nodo };
    });
    ok(!!rilascio.nodo, 'il rilascio dal catalogo rimette l’oggetto nel diagramma');
    ok(rilascio.nodo && Math.abs(rilascio.nodo.x - rilascio.atteso.x) < 2
      && Math.abs(rilascio.nodo.y - rilascio.atteso.y) < 2,
      'il nodo cade dove è caduto il puntatore, anche dopo pan e zoom',
      `atteso ${JSON.stringify(rilascio.atteso)}, ottenuto ${JSON.stringify(rilascio.nodo)}`);

    /* --- 6. Ispettore: metadati completi chiesti al server ------------------ */
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

    /* --- 6b. Nota e celle: mai «[object Object]» ---------------------------- */
    // `displayValueBreve` restituisce { text, cls }: interpolarlo intero
    // stampava «[object Object]» nella scheda della nota e in OGNI cella del
    // pannello dati. Qui si scrive una nota vera e si aprono dati veri.
    await page.click('#uml-ispettore-corpo [data-isp="dati"]');
    await page.waitForTimeout(400);
    const dati = await page.evaluate(() => document.getElementById('uml-dati-corpo').textContent);
    ok(/Roma/.test(dati), 'i sottodocumenti si leggono nelle celle', dati.slice(0, 160));
    ok(!/\[object Object\]/.test(dati), 'nessuna cella dice «[object Object]»');
    await page.click('#uml-dati-chiudi');
    await page.waitForTimeout(200);
    // Angolo in basso a sinistra: in alto a destra ci sono i comandi dello
    // zoom, in basso a destra la minimappa; dopo aver inquadrato qui c'è il
    // margine vuoto di 40px.
    //
    // I TOAST ANCORA APERTI VANNO TOLTI PRIMA. Un toast è `position: fixed` in
    // basso al centro, largo fino a 760px e vivo 3,5 secondi: sopra una vista
    // dove il canvas È l'area di lavoro si sovrappone proprio a questo angolo e
    // si prende il tasto destro, quindi il menu del canvas non si apriva mai.
    // Il passo che precede ne lascia uno («Rimosso dal diagramma»), ed è un
    // residuo del test, non dello stato che si vuole misurare: aspettarne la
    // scadenza renderebbe il test lento e comunque dipendente dai tempi.
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await page.click('#uml-adatta');
    await page.waitForTimeout(400);
    const angolo = await page.evaluate(() => {
      const r = document.getElementById('uml-canvas').getBoundingClientRect();
      return { x: Math.round(r.left + 30), y: Math.round(r.bottom - 30) };
    });
    await page.mouse.click(angolo.x, angolo.y, { button: 'right' });
    await page.waitForTimeout(250);
    await page.click('#context-menu li:has-text("Aggiungi nota")');
    await page.waitForSelector('#askinput-overlay:not(.hidden)', { timeout: 5000 });
    await page.fill('#askinput-value', 'Nota di prova per Keus');
    await page.click('#askinput-ok');
    await page.waitForTimeout(400);
    const notaXY = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#uml-canvas .joint-element')]
        .find((e) => e.textContent.includes('Nota di prova'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 10) };
    });
    ok(!!notaXY, 'la nota è sul canvas', JSON.stringify(notaXY));
    await page.mouse.click(notaXY.x, notaXY.y);
    await page.waitForTimeout(300);
    const scheda = await page.evaluate(() => document.getElementById('uml-ispettore-corpo').textContent);
    ok(/Nota di prova per Keus/.test(scheda), 'l’ispettore mostra il testo della nota', scheda.slice(0, 160));
    ok(!/\[object Object\]/.test(scheda), 'e non «[object Object]»');

    /* --- 7. Export SVG autonomo -------------------------------------------- */
    const svg = await page.evaluate(() => window.__uml.statoUml().tavola.esportaSvg({}));
    ok(svg.startsWith('<svg') || svg.includes('<svg'), 'l’export produce un SVG');
    ok(!/<script/i.test(svg), 'nessuno script nell’SVG esportato');
    ok(/fill="#|fill="rgb/.test(svg), 'i colori sono INCORPORATI: l’SVG non dipende dal foglio di stile dell’app');
    ok(!/class="joint-layers"[^>]*transform=/.test(svg),
      'la trasformazione di vista non finisce nell’export: il viewBox inquadra il contenuto');
    ok(/righe/.test(svg) && /ordini/.test(svg), 'i nomi delle tabelle ci sono per intero nell’SVG');

    /* --- 8. Organizzare e instradare con gesti veri ------------------------- */
    await page.click('#uml-adatta');
    await page.waitForTimeout(300);

    // Le maniglie dei vertici sono Community, non Plus: se la distribuzione
    // non le offrisse, il resto di questa sezione non avrebbe senso.
    const strumenti = await page.evaluate(() => ({
      vertici: typeof window.joint !== 'undefined' && !!(window.joint.linkTools && window.joint.linkTools.Vertices),
      vista: typeof window.joint !== 'undefined' && !!(window.joint.dia && window.joint.dia.ToolsView),
    }));
    ok(strumenti.vertici, 'le maniglie dei vertici sono Community: disponibili senza Plus');
    ok(strumenti.vista, '...e c’è il contenitore degli strumenti');

    // Due nodi, scelti per davvero con Ctrl+clic (non impostando lo stato).
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const vociSceltaPrima = await page.evaluate(() => window.__uml.statoUml().cronologia.indietro.length);
    const centroDi = (nome) => page.evaluate((n) => {
      const el = [...document.querySelectorAll('#uml-canvas .joint-element')]
        .find((e) => e.textContent.includes(n));
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 20) };
    }, nome);
    await page.keyboard.down('Control');
    const co = await centroDi('ordini');
    await page.mouse.click(co.x, co.y);
    await page.waitForTimeout(150);
    const cr = await centroDi('righe');
    await page.mouse.click(cr.x, cr.y);
    await page.waitForTimeout(150);
    await page.keyboard.up('Control');
    const scelti = await page.evaluate(() => window.__uml.statoUml().selezione.length);
    ok(scelti === 2, 'Ctrl+clic sceglie due nodi', `scelti=${scelti}`);
    const vociSceltaDopo = await page.evaluate(() => window.__uml.statoUml().cronologia.indietro.length);
    ok(vociSceltaDopo === vociSceltaPrima,
      'scegliere senza spostare non apre voci di storia', `${vociSceltaPrima} → ${vociSceltaDopo}`);

    await page.click('#uml-ordina-btn');
    await page.waitForTimeout(150);
    // La x di arrivo non è «una qualsiasi purché uguale»: è il bordo sinistro
    // del gruppo, cioè la minore delle due di partenza. Allineare «a sinistra»
    // al bordo destro passerebbe un controllo di sola uguaglianza.
    const primaX = await page.evaluate(() => {
      const st = window.__uml.statoUml();
      return st.selezione.map((k) => st.doc.nodi[k].x);
    });
    await page.click('#uml-ordina-menu [data-allinea="sinistra"]');
    await page.waitForTimeout(300);
    const allineati = await page.evaluate(() => {
      const st = window.__uml.statoUml();
      return st.selezione.map((k) => st.doc.nodi[k].x);
    });
    ok(allineati.length === 2 && allineati[0] === allineati[1] && allineati[0] === Math.min(...primaX),
      '«Allinea a sinistra» mette i due nodi al bordo sinistro', `${primaX.join(',')} → ${allineati.join(',')}`);
    await page.click('#uml-undo');
    await page.waitForTimeout(300);
    const disallineati = await page.evaluate(() => {
      const st = window.__uml.statoUml();
      const chiavi = Object.keys(st.doc.nodi)
        .filter((k) => ['ordini', 'righe'].includes(JSON.parse(k)[3]));
      return chiavi.map((k) => st.doc.nodi[k].x);
    });
    ok(disallineati.length === 2 && disallineati[0] !== disallineati[1],
      'UN «Annulla» toglie l’allineamento in una volta sola', disallineati.join(','));

    // Tastiera vera: Esc deseleziona, Ctrl+Z annulla un trascinamento.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const svuotata = await page.evaluate(() => window.__uml.statoUml().selezione.length);
    ok(svuotata === 0, '«Esc» deseleziona', `selezionati=${svuotata}`);
    const kd0 = await posizioneDi('dipendenti');
    await trascina(kd0);
    const kd1 = await posizioneDi('dipendenti');
    ok(Math.abs(kd1.x - kd0.x) > 80, 'il trascinamento da tastiera-parte sposta');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const kd2 = await posizioneDi('dipendenti');
    ok(Math.abs(kd2.x - kd0.x) < 12 && Math.abs(kd2.y - kd0.y) < 12,
      '«Ctrl+Z» annulla senza passare dal pulsante', `${kd1.x} → ${kd2.x}`);

    // Raggruppa dal menu contestuale, col nome dato nella modale vera. La
    // selezione si rifà da capo: ciò che era scelto prima non conta più.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    await page.keyboard.down('Control');
    const grO = await centroDi('ordini');
    await page.mouse.click(grO.x, grO.y);
    await page.waitForTimeout(120);
    const gr = await centroDi('righe');
    await page.mouse.click(gr.x, gr.y);
    await page.waitForTimeout(120);
    await page.keyboard.up('Control');
    await page.mouse.move(gr.x, gr.y);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(150);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(250);
    const vociMenu = await page.evaluate(() =>
      [...document.querySelectorAll('#context-menu li')].map((li) => li.textContent.trim()));
    ok(vociMenu.some((t) => t.includes('Raggruppa')),
      'il menu su due nodi offre «Raggruppa»', vociMenu.join(' | '));
    await page.click('#context-menu li:has-text("Raggruppa")');
    await page.waitForSelector('#askinput-overlay:not(.hidden)', { timeout: 5000 });
    await page.fill('#askinput-value', 'Vendite');
    await page.click('#askinput-ok');
    await page.waitForTimeout(400);
    const gruppo = await page.evaluate(() => window.__uml.statoUml().doc.gruppi);
    ok(gruppo.length === 1 && gruppo[0].membri.length === 2 && gruppo[0].nome === 'Vendite',
      'il gruppo nasce con i due membri e il nome dato',
      JSON.stringify(gruppo.map((g) => [g.nome, g.membri.length])));

    // Comprimi dallo stesso menu: i membri spariscono dietro un segnaposto.
    //
    // I conteggi qui sotto sono RELATIVI a questa misura, non assoluti. Un
    // numero assoluto lega l'asserzione a tutto ciò che sta sul canvas —
    // compresa la nota creata dal passo 6b, che non c'entra nulla con i
    // gruppi: l'asserzione «i due membri sono nascosti dietro un segnaposto»
    // parla di una differenza (due via, uno in più), e va scritta così.
    const primaDiComprimere = await page.evaluate(() =>
      document.querySelectorAll('#uml-canvas .joint-element').length);
    const gc = await centroDi('ordini');
    await page.mouse.click(gc.x, gc.y, { button: 'right' });
    await page.waitForTimeout(250);
    await page.click('#context-menu li:has-text("Comprimi il gruppo")');
    await page.waitForTimeout(400);
    const compresso = await page.evaluate(() => ({
      flag: window.__uml.statoUml().doc.gruppi[0].compresso,
      visibili: document.querySelectorAll('#uml-canvas .joint-element').length,
    }));
    // Espanso il gruppo è tre elementi (i due membri più la CORNICE, che è a
    // sua volta un `.joint-element`); compresso è il solo segnaposto: due in meno.
    ok(compresso.flag === true && compresso.visibili === primaDiComprimere - 2,
      '«Comprimi» nasconde i due membri dietro un segnaposto',
      JSON.stringify({ ...compresso, atteso: primaDiComprimere - 2 }));

    // Annidamento: il segnaposto dentro un nuovo gruppo con un terzo nodo. La
    // selezione è il segnaposto: Ctrl+clic aggiunge «clienti» senza aprirlo.
    await page.keyboard.down('Control');
    const cc = await centroDi('clienti');
    await page.mouse.click(cc.x, cc.y);
    await page.waitForTimeout(150);
    await page.keyboard.up('Control');
    await page.mouse.click(cc.x, cc.y, { button: 'right' });
    await page.waitForTimeout(250);
    await page.click('#context-menu li:has-text("Raggruppa")');
    await page.waitForSelector('#askinput-overlay:not(.hidden)', { timeout: 5000 });
    await page.fill('#askinput-value', 'Tutto');
    await page.click('#askinput-ok');
    await page.waitForTimeout(400);
    const annidato = await page.evaluate(() => {
      const st = window.__uml.statoUml();
      const g2 = st.doc.gruppi.find((g) => g.nome === 'Tutto');
      return g2 && {
        membri: g2.membri.length,
        dentroSegnaposto: g2.membri.some((m) => st.doc.gruppi.some((x) => x.id === m)),
        internoIntatto: st.doc.gruppi.find((g) => g.nome === 'Vendite').membri.length,
      };
    });
    ok(annidato && annidato.membri === 2 && annidato.dentroSegnaposto && annidato.internoIntatto === 2,
      'il gruppo esterno contiene il segnaposto e il gruppo interno resta intatto',
      JSON.stringify(annidato));

    // Comprimere l'esterno nasconde tre foglie dietro UN segnaposto e toglie
    // gli archi interni: resta solo l'auto-riferimento dei dipendenti.
    await page.mouse.click(cc.x, cc.y, { button: 'right' });
    await page.waitForTimeout(250);
    await page.click('#context-menu li:has-text("Comprimi il gruppo")');
    await page.waitForTimeout(400);
    const esterno = await page.evaluate(() => {
      const st = window.__uml.statoUml();
      const g2 = st.doc.gruppi.find((g) => g.nome === 'Tutto');
      return {
        flag: g2.compresso,
        visibili: document.querySelectorAll('#uml-canvas .joint-element').length,
        archi: document.querySelectorAll('#uml-canvas .joint-link').length,
      };
    });
    // L'esterno raccoglie il segnaposto interno più «clienti» dietro un solo
    // segnaposto: un altro elemento in meno.
    ok(esterno.flag === true && esterno.visibili === primaDiComprimere - 3 && esterno.archi === 1,
      'l’esterno compresso mostra un segnaposto e un arco solo',
      JSON.stringify({ ...esterno, atteso: primaDiComprimere - 3 }));
    await page.click('#uml-undo');
    await page.waitForTimeout(300);
    await page.click('#uml-undo');
    await page.waitForTimeout(300);
    const tornati = await page.evaluate(() => {
      const st = window.__uml.statoUml();
      return { gruppi: st.doc.gruppi.length, flag: st.doc.gruppi[0].compresso };
    });
    ok(tornati.gruppi === 1 && tornati.flag === true,
      'due «Annulla» tolgono esterno e compressione', JSON.stringify(tornati));

    await page.click('#uml-undo');
    await page.waitForTimeout(300);
    // ...e la cornice del gruppo espanso: si torna esattamente allo stato di
    // partenza, membri e cornice compresi. È questo che «in una volta sola»
    // significa: un «Annulla», non uno per elemento riapparso.
    const espanso = await page.evaluate(() => ({
      flag: window.__uml.statoUml().doc.gruppi[0].compresso,
      visibili: document.querySelectorAll('#uml-canvas .joint-element').length,
    }));
    ok(espanso.flag === false && espanso.visibili === primaDiComprimere,
      '«Annulla» riespande il gruppo in una volta sola',
      JSON.stringify({ ...espanso, atteso: primaDiComprimere }));

    // La distribuzione porta solo `joint.min.js`: `joint.css` NON è
    // vendorizzato (vedi public/vendor/joint/PROVENIENZA.txt), perché la vista
    // porta il proprio stile e segue i token del tema. Va bene finché JointJS
    // non emette `.connection-wrap`, la fascia invisibile spessa che joint.css
    // mette sotto un collegamento per renderlo cliccabile: se ricomparisse
    // senza quel foglio resterebbe spessa zero, e i collegamenti sarebbero
    // quasi impossibili da centrare — senza alcun errore. Qui si controlla
    // l'assunzione, invece di darla per buona a ogni aggiornamento.
    const dipendenzaCss = await page.evaluate(() => {
      const wrap = document.querySelector('#uml-canvas .joint-link .connection-wrap');
      if (!wrap) return { presente: false };
      const s = getComputedStyle(wrap);
      return { presente: true, spessore: parseFloat(s.strokeWidth) || 0 };
    });
    ok(!dipendenzaCss.presente || dipendenzaCss.spessore >= 5,
      'i collegamenti restano cliccabili senza joint.css (nessuna .connection-wrap, o già spessa)',
      JSON.stringify(dipendenzaCss));

    // Arco: si mira a un punto del path cliccabile reso da JointJS (il
    // rettangolo del contenitore spesso non tocca la linea). L'etichetta sta
    // a metà arco: se il primo punto la colpisce invece della linea, si prova
    // a un terzo e a due terzi.
    const puntoSuArco = (frazione) => page.evaluate((f) => {
      for (const w of document.querySelectorAll('#uml-canvas .joint-link path[joint-selector="wrapper"]')) {
        const r = w.getBoundingClientRect();
        if (r.width < 4 && r.height < 4) continue;
        const pt = w.getPointAtLength(w.getTotalLength() * f);
        const m = w.getScreenCTM();
        return { x: Math.round(m.a * pt.x + m.c * pt.y + m.e), y: Math.round(m.b * pt.x + m.d * pt.y + m.f) };
      }
      return null;
    }, frazione);
    const arcoSceltoDa = async () => page.evaluate(() => {
      const st = window.__uml.statoUml();
      if (st.selezione.length !== 1) return null;
      const cella = st.tavola.perChiave.get(st.selezione[0]);
      return cella && cella.isLink && cella.isLink() ? st.selezione[0] : null;
    });
    let puntoArco = null;
    for (const f of [0.5, 0.3, 0.7]) {
      const p = await puntoSuArco(f);
      if (!p) break;
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(150);
      if (await arcoSceltoDa()) { puntoArco = p; break; }
    }
    ok(!!puntoArco, 'cliccare un arco lo sceglie', JSON.stringify(puntoArco));
    await page.waitForTimeout(250);
    const strumento = await page.evaluate(() =>
      !!document.querySelector('#uml-canvas .joint-tools-layer [data-tool-name="vertices"]'));
    ok(strumento, 'l’arco scelto mostra lo strumento dei vertici');

    // Clic sul path dello strumento: AGGIUNGE un vertice, che finisce nel
    // documento con una sola voce di storia.
    const puntoAggiunta = await page.evaluate(() => {
      const w = document.querySelector('#uml-canvas .joint-vertices-path');
      if (!w) return null;
      const pt = w.getPointAtLength(w.getTotalLength() / 2);
      const m = w.getScreenCTM();
      return { x: Math.round(m.a * pt.x + m.c * pt.y + m.e), y: Math.round(m.b * pt.x + m.d * pt.y + m.f) };
    });
    ok(!!puntoAggiunta, 'lo strumento offre il path di aggiunta');
    const storiaPrima = await page.evaluate(() => window.__uml.statoUml().cronologia.indietro.length);
    await page.mouse.click(puntoAggiunta.x, puntoAggiunta.y);
    await page.waitForTimeout(350);
    const dopoAggiunta = await page.evaluate(() => ({
      vie: window.__uml.statoUml().doc.instradamenti,
      voci: window.__uml.statoUml().cronologia.indietro.length,
    }));
    ok(Object.keys(dopoAggiunta.vie).length === 1
      && dopoAggiunta.vie[Object.keys(dopoAggiunta.vie)[0]].length === 1,
      'cliccare il path aggiunge UN vertice nel documento', JSON.stringify(dopoAggiunta.vie));
    ok(dopoAggiunta.voci === storiaPrima + 1,
      'l’aggiunta è UN gesto solo', `${storiaPrima} → ${dopoAggiunta.voci}`);

    // Trascinamento della maniglia: il vertice segue il puntatore.
    const maniglia = await page.evaluate(() => {
      const h = document.querySelector('#uml-canvas .joint-marker-vertex');
      if (!h) return null;
      const r = h.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    ok(!!maniglia, 'il vertice aggiunto ha la sua maniglia', JSON.stringify(maniglia));
    const verticePrima = await page.evaluate(() => {
      const vie = window.__uml.statoUml().doc.instradamenti;
      return vie[Object.keys(vie)[0]][0];
    });
    await page.mouse.move(maniglia.x, maniglia.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(maniglia.x + i * 8, maniglia.y - i * 5);
    await page.mouse.up();
    await page.waitForTimeout(350);
    const dopoTrascina = await page.evaluate(() => ({
      vie: window.__uml.statoUml().doc.instradamenti,
      voci: window.__uml.statoUml().cronologia.indietro.length,
    }));
    const verticeDopo = dopoTrascina.vie[Object.keys(dopoTrascina.vie)[0]][0];
    ok(Math.abs(verticeDopo.x - verticePrima.x) > 20,
      'trascinare la maniglia sposta il vertice nel documento',
      `${JSON.stringify(verticePrima)} → ${JSON.stringify(verticeDopo)}`);
    ok(dopoTrascina.voci === storiaPrima + 2,
      'anche lo spostamento è UN gesto solo', `${storiaPrima} → ${dopoTrascina.voci}`);

    // «Raddrizza» dal menu dell’arco: si clicca la maniglia col tasto destro
    // (è di certo sull’arco giusto: il punto di prima può essersi spostato con
    // la geometria) e i vertici manuali spariscono.
    const puntoManiglia = await page.evaluate(() => {
      const h = document.querySelector('#uml-canvas .joint-marker-vertex');
      if (!h) return null;
      const r = h.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    ok(!!puntoManiglia, 'la maniglia è ancora lì per il menu', JSON.stringify(puntoManiglia));
    await page.mouse.click(puntoManiglia.x, puntoManiglia.y, { button: 'right' });
    await page.waitForTimeout(250);
    const vociArco = await page.evaluate(() =>
      [...document.querySelectorAll('#context-menu li')].map((li) => li.textContent.trim()));
    ok(vociArco.some((t) => t.includes('Raddrizza')),
      'il menu dell’arco offre «Raddrizza»', vociArco.join(' | '));
    await page.click('#context-menu li:has-text("Raddrizza il collegamento")');
    await page.waitForTimeout(350);
    const raddrizzato = await page.evaluate(() => ({
      vie: window.__uml.statoUml().doc.instradamenti,
      voci: window.__uml.statoUml().cronologia.indietro.length,
    }));
    ok(Object.keys(raddrizzato.vie).length === 0,
      '«Raddrizza» toglie i vertici manuali', JSON.stringify(raddrizzato.vie));
    await page.click('#uml-undo');
    await page.waitForTimeout(350);
    const tornato = await page.evaluate(() => window.__uml.statoUml().doc.instradamenti);
    ok(Object.keys(tornato).length === 1,
      'UN «Annulla» rimette i vertici', JSON.stringify(tornato));

    ok(errori.length === 0, 'nessun errore JavaScript durante le prove', errori.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }

  console.log(falliti === 0 ? '\n--- UML: tutti i test superati ---' : `\n--- UML: ${falliti} test falliti ---`);
  process.exit(falliti === 0 ? 0 : 1);
})();
