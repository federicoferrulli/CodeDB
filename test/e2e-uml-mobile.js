'use strict';

// Controller e JointJS reali; soltanto il trasporto dati è una fixture isolata.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant-pan');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/uml-mobile-2026-10-11'}/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3193 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  page.setDefaultTimeout(7000);
  const report = { checks: [], errors: [] };
  page.on('pageerror', e => report.errors.push(e.message));
  const check = text => { report.checks.push(text); console.log('OK', text); };
  try {
    // L'onboarding si apre in differita: la fixture lo segna già letto prima dell'avvio.
    await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    if (mutant) await page.route('**/js/uml-paper.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const guard = 'if (this._pizzico.puntatori.size === 2) { this._aggiornaPizzico(); return; }';
      assert(source.includes(guard));
      await route.fulfill({ response, body: source.replace(guard, 'if (this._pizzico.puntatori.size >= 1) { this._aggiornaPizzico(); return; }') });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => (await import('/js/theme.js')).scegliTema('dark'));
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const fields = [{ name: 'id', pk: true, types: ['int'] }, { name: 'nome', types: ['varchar'] }, { name: 'cliente_id', types: ['int'] }];
      const schema = { collections: ['ordini', 'clienti', 'righe', 'prodotti', 'pagamenti', 'magazzino'].map(name => ({ name, fields })),
        relations: [['ordini', 'clienti'], ['righe', 'ordini'], ['righe', 'prodotti'], ['pagamenti', 'ordini'], ['prodotti', 'magazzino']].map(([from, to]) => ({ from, to, field: 'cliente_id', toField: 'id', origine: 'vincolo', constraint: `fk_${from}_${to}` })), schemaPage: { complete: true } };
      impostaSocket({ on() {}, off() {}, emit(event, msg, cb) {
        if (!cb) return;
        if (event === 'db:schema') cb({ ok: true, ...schema });
        else if (event === 'collection:stats') cb({ ok: true, fields: [...fields, { name: 'campo_con_nome_estremamente_lungo_da_leggere_per_intero', types: ['character varying(255)'] }], indexes: [{ name: 'indice_con_nome_lungo', key: { id: 1 }, unique: true }] });
        else cb({ ok: true, docs: [{ id: 1, nome: 'Ordine di prova', profilo: { citta: 'Roma' } }], columns: ['id', 'nome', 'profilo'] });
      } });
      const tab = createTab({ id: 'uml-mobile' });
      Object.assign(tab.state, { connected: true, db: 'vendite', coll: null, connId: 'mobile', dbType: 'postgresql', view: 'uml', dbSchema: schema, dbSchemaFor: 'vendite' });
      tabs.activeId = tab.id;
      window.__state = tab.state;
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
      for (const id of ['tab-body', 'workspace']) document.getElementById(id).classList.remove('hidden');
      window.__uml = await import('/js/uml.js');
      window.__setView = (await import('/js/main.js')).setView;
      window.__setView('uml');
      window.__panels = ['uml-catalogo', 'uml-ispettore', 'uml-dati'].map(id => document.getElementById(id));
    });
    await page.waitForFunction(() => window.__uml.statoUml().tavola?.graph.getElements().length === 6);
    await page.waitForTimeout(200);
    const canvas = page.locator('#uml-canvas');
    const state = () => page.evaluate(() => {
      const v = window.__uml.statoUml();
      return { zoom: v.tavola.scala, pan: v.tavola.paper.translate(), doc: JSON.stringify(v.doc), selection: v.selezione,
        gesture: { pan: v.tavola._pan, points: v.tavola._pizzico && [...v.tavola._pizzico.puntatori] } };
    });
    const initial = await state();
    const checkCanvas = async (width, minimumHeight) => {
      const box = await canvas.boundingBox();
      assert(box.width >= width - 32, `canvas ${box.width}px su ${width}px`);
      assert(box.height >= minimumHeight, `altezza utile ${box.height}px`);
      assert(!await page.locator('#uml-ispettore').isVisible());
      assert(!await page.locator('#uml-catalogo').isVisible());
      const controls = await page.locator('.uml-mobile-bar button, .uml-flottante button').evaluateAll(nodes => nodes.map(el => {
        const r = el.getBoundingClientRect(); return { id: el.id, x: r.x, right: r.right, width: r.width, height: r.height, bottom: r.bottom };
      }));
      assert(controls.every(r => r.x >= 0 && r.right <= width && r.width >= 44 && r.height >= 44), JSON.stringify(controls));
    };
    await checkCanvas(390, 300);
    await page.screenshot({ path: `${dir}/schema-390.png` });
    check('Canvas a tutta larghezza e comandi touch senza sovrapposizioni');

    await page.locator('#uml-mobile-catalogo').click();
    await page.locator('#uml-cerca').fill('ordini');
    await page.screenshot({ path: `${dir}/catalogo-390.png` });
    await page.locator('#uml-catalogo-lista [data-chiave]').press('Enter');
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    assert((await state()).selection[0].includes('ordini'));
    assert(await page.locator('#uml-mobile-catalogo').evaluate(el => el === document.activeElement));
    await page.waitForTimeout(300); // Il livello di dettaglio del canvas si aggiorna dopo il gesto.
    await page.screenshot({ path: `${dir}/tabella-390.png` });
    await page.locator('#uml-mobile-dettagli').click();
    await page.locator('.uml-isp-titolo').filter({ hasText: 'ordini' }).waitFor();
    await page.waitForTimeout(300);
    assert(await page.locator('#uml-ispettore-corpo').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: `${dir}/dettagli-390.png` });
    const selected = (await state()).selection;
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    assert.deepEqual((await state()).selection, selected, 'chiudere il drawer conserva la selezione');
    check('Catalogo ricercabile, centratura della tabella e dettagli leggibili con nomi lunghi');

    await page.locator('#uml-mobile-dettagli').click();
    await page.locator('[data-isp="dati"]').click();
    await page.locator('#uml-dati-corpo tr[data-riga]').click();
    await page.locator('#uml-dati-dettaglio').click();
    assert((await page.locator('#uml-dati-json').innerText()).includes('Ordine di prova'));
    assert(await page.locator('#uml-dati-affianca').isHidden(), 'Il drawer dati UML non propone lo split su mobile');
    await page.screenshot({ path: `${dir}/dati-390.png` });
    await page.locator('.arc-navigation-sheet').getByRole('button', { name: 'Chiudi', exact: true }).click();
    await checkCanvas(390, 300);
    check('Dati e dettaglio JSON nel drawer, senza ridurre il diagramma');

    await page.locator('#uml-mobile-strumenti').click();
    assert(await page.locator('.arc-navigation-sheet [role="combobox"]').isVisible());
    await page.screenshot({ path: `${dir}/strumenti-390.png` });
    await page.locator('#uml-esporta-btn').click();
    assert(await page.locator('#uml-esp-svg').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').getByRole('button', { name: 'Chiudi', exact: true }).click();
    check('Diagrammi salvati, esportazione e aggiornamento raggiungibili dagli strumenti');

    await page.locator('#uml-mobile-espandi').click();
    await checkCanvas(390, 700);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 2, radiusY: 2 })) });
    const drag = async (x, y) => {
      const before = await state();
      await touch('touchStart', [[1, x, y]]);
      await touch('touchMove', [[1, x + 35, y + 45]]);
      await touch('touchEnd', []);
      const after = await state();
      assert(Math.abs(after.pan.tx - before.pan.tx - 35) < 2 && Math.abs(after.pan.ty - before.pan.ty - 45) < 2, 'un dito deve trascinare il diagramma');
      assert.equal(after.doc, initial.doc, 'il gesto non modifica il documento');
    };
    const b = await canvas.boundingBox();
    await drag(b.x + 12, b.y + 12);
    const node = await page.locator('#uml-canvas .joint-element').filter({ hasText: 'ordini' }).first().boundingBox();
    await drag(node.x + 35, node.y + 15);
    const beforePinch = await state();
    const cy = b.y + b.height / 2;
    await touch('touchStart', [[1, 100, cy]]);
    await touch('touchStart', [[1, 100, cy], [2, 200, cy]]);
    await touch('touchMove', [[1, 70, cy], [2, 230, cy]]);
    assert((await state()).zoom > beforePinch.zoom * 1.3, 'il pizzico ingrandisce');
    await touch('touchEnd', [[2, 230, cy]]);
    const remaining = await state();
    await touch('touchMove', [[1, 90, cy + 20]]);
    const resumed = await state();
    assert(Math.abs(resumed.pan.tx - remaining.pan.tx - 20) < 2, `il dito rimasto riprende il pan: ${JSON.stringify({ prima: remaining.pan, dopo: resumed.pan, gesto: resumed.gesture })}`);
    await touch('touchCancel', []);
    await drag(20, b.y + 20);
    check('Gesti touch reali: pan sullo sfondo e sui nodi, pinch, ritorno a un dito e annullamento');

    for (const theme of ['dark', 'light']) for (const [width, height] of [[320, 650], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.locator('#uml-adatta').click();
      await checkCanvas(width, height - 140);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/intero-${theme}-${width}.png` });
    }
    await page.keyboard.press('Escape');
    assert(!await page.locator('#view-uml').evaluate(el => el.classList.contains('uml-schermo-intero')));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#uml-mobile-catalogo').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    assert(await page.locator('#uml-catalogo').isVisible());
    assert(await page.locator('#uml-ispettore').isVisible());
    assert(await page.evaluate(() => window.__panels.every(el => document.getElementById(el.id) === el && el.closest('#view-uml'))));
    await page.screenshot({ path: `${dir}/desktop-1440.png` });
    check('Schermo intero, temi, verticale/orizzontale e ritorno al desktop conservano i pannelli originali');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { window.__state.coll = 'ordini'; window.__setView('uml'); });
    await page.waitForFunction(() => window.__uml.statoUml().contesto.coll === 'ordini' && window.__uml.statoUml().tavola);
    await page.waitForTimeout(300);
    assert((await state()).zoom >= 1, 'la vista di una tabella parte leggibile, centrata sulla selezione');
    check('L’UML della tabella si apre centrato e leggibile su mobile');
    await page.screenshot({ path: `${dir}/tabella-contesto-390.png` });
    await page.locator('#uml-mobile-dettagli').click();
    await page.evaluate(() => window.__setView('data'));
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    check('Il cambio vista chiude il drawer UML');
    assert.deepEqual(report.errors, []);
  } catch (e) {
    report.failure = e.stack;
    await page.screenshot({ path: `${dir}/failure.png` });
    throw e;
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
