'use strict';
const { scegliArc } = require('./arc-controls');

// JointJS vero, schema simulato: vista singola, database e isolamento.
// UML_TEST_MUTATION=1 forza il database anche nel contesto di una tabella:
// la stessa prova deve fallire, senza modificare i sorgenti sul disco.
// loading sopprime lo skeleton; readonly abilita il trascinamento; relazioni omette i collegamenti entranti.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3158 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    if (process.env.UML_TEST_MUTATION) {
      await page.route('**/js/uml.js', async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const body = process.env.UML_TEST_MUTATION === 'loading'
          ? source.replace("ctx.modalita === 'database'", 'false')
          : process.env.UML_TEST_MUTATION === 'readonly' ? source.replace('V.tavola.modifica = false;', 'V.tavola.modifica = true;')
          : process.env.UML_TEST_MUTATION === 'relazioni' ? source.replace('if (l.da === riferimento || l.a === riferimento)', 'if (l.da === riferimento)')
          : source.replace("const modalita = state.coll ? 'tabella' : 'database';", "const modalita = 'database';");
        await route.fulfill({ response, body });
      });
    }
    await page.goto(server.url);
    await page.waitForSelector('#uml-canvas', { state: 'attached' });
    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      const { createTab, tabs } = await import('/js/tabs.js');
      const field = { name: 'id', types: ['int'], pk: true };
      const relation = (from, to, constraint, extra = {}) => ({
        from, to, field: 'id', toField: 'id', constraint, origine: 'vincolo', ...extra,
      });
      const schema = {
        collections: ['ordini', 'righe', 'clienti', 'dipendenti', 'isolata', 'archivio'].map((name) => ({ name, fields: [field] })),
        relations: [relation('ordini', 'clienti', 'fk_cliente'), relation('righe', 'ordini', 'fk_ordine'),
          relation('righe', 'ordini', 'fk_ordine', { field: 'anno', toField: 'anno' }),
          relation('clienti', 'dipendenti', 'fk_gestore'), relation('righe', 'clienti', 'fk_altro'),
          relation('dipendenti', 'dipendenti', 'fk_capo'),
          relation('ordini', 'archivio', 'fk_esterno', { toDb: 'storico' })],
        schemaPage: { complete: true },
      };
      window.__richieste = [];
      window.__schema = schema;
      impostaSocket({ on() {}, off() {}, emit(event, msg, cb) {
        window.__richieste.push({ event, msg });
        if (!cb) return;
        if (event === 'collection:stats' && window.__ritardaTabella === msg.coll) {
          window.__rispondiTabella = () => cb({ ok: true, fields: [field, { name: 'risposta_vecchia', types: ['text'] }], indexes: [] });
          return;
        }
        if (event === 'db:schema') {
          if (window.__ritarda) { window.__rispondi = (error) => cb(error ? { ok: false, error } : { ok: true, ...schema }); return; }
          if (msg.relationCursor) cb({ ok: true, ...schema, collections: [], relations: schema.relations.slice(2) });
          else cb({ ok: true, ...schema, relations: schema.relations.slice(0, 2), schemaPage: {
            complete: false, cursori: { collezioni: null, relazioni: 2, campi: {} },
            fine: { collezioni: true, campi: true, relazioni: false },
          } });
        } else if (event === 'collection:stats') cb({ ok: true, fields: [field], indexes: [] });
        else cb({ ok: true, docs: [], columns: [] });
      } });
      const tab = createTab({ id: 'uml-modalita' });
      Object.assign(tab.state, { connected: true, db: 'vendite', coll: 'ordini', connId: 'modalita', dbType: 'postgresql', view: 'data' });
      tabs.activeId = tab.id;
      window.__state = tab.state;
      for (const id of ['welcome', 'placeholder', 'onboarding-overlay']) document.getElementById(id)?.classList.add('hidden');
      for (const id of ['tab-body', 'workspace', 'coll-tab-bar']) document.getElementById(id).classList.remove('hidden');
      for (const el of document.querySelectorAll('#workspace .view-panel:not(#view-uml)')) el.classList.add('hidden');
      window.__uml = await import('/js/uml.js');
      window.__setView = (await import('/js/main.js')).setView;
      window.__setView('data');
    });
    const openUml = async () => {
      await page.click('#view-menu-btn');
      await page.click('.view-menu-item[data-view="uml"]');
    };
    await openUml();
    assert.equal(await page.locator('#uml-ambito').count(), 0, 'la modalità segue il contesto, senza select');
    const ready = (mode, coll = null) => page.waitForFunction(({ mode, coll }) => {
      const v = window.__uml.statoUml();
      return v.tavola && v.contesto.modalita === mode && v.contesto.coll === coll
        && document.querySelectorAll('#uml-canvas .joint-element').length === v.tavola.graph.getElements().length
        && document.querySelectorAll('#uml-canvas .joint-link').length === v.tavola.graph.getLinks().length;
    }, { mode, coll }, { timeout: 5000 });
    const nodes = () => page.evaluate(() => Object.keys(window.__uml.statoUml().doc.nodi).map((k) => {
      const [, db, , name] = JSON.parse(k); return `${db}.${name}`;
    }).sort());
    const changeTable = async (coll) => {
      await page.evaluate((name) => { window.__state.coll = name; window.__setView('uml'); }, coll);
      await ready(coll ? 'tabella' : 'database', coll);
    };
    await ready('tabella', 'ordini');
    const vicine = ['storico.archivio', 'vendite.clienti', 'vendite.ordini', 'vendite.righe'];
    assert.deepEqual(await nodes(), vicine);
    assert.equal(await page.locator('#uml-canvas .joint-link').count(), 3, 'solo relazioni dirette, FK composta raggruppata');
    assert(await page.locator('#uml-canvas').textContent().then((text) => text.includes('id')));
    assert.equal(await page.evaluate(() => window.__richieste.filter((r) => r.event === 'db:schema').length), 2,
      'Singola completa le relazioni paginate prima di disegnare');
    assert.equal(await page.locator('#uml-diagrammi').isVisible(), false);
    assert.equal(await page.locator('#uml-progetta-btn').isVisible(), false);
    const solaLettura = async () => {
      const snapshot = () => page.evaluate(() => {
        const v = window.__uml.statoUml();
        return { doc: v.doc, posizioni: v.tavola.graph.getElements().map((c) => ({ id: c.id, ...c.position() })) };
      });
      const prima = await snapshot();
      const node = page.locator('#uml-canvas .joint-element').filter({ hasText: 'ordini' }).first();
      const r = await node.boundingBox();
      await page.mouse.move(r.x + 40, r.y + 10);
      await page.mouse.down();
      await page.mouse.move(r.x + 160, r.y + 75, { steps: 10 });
      await page.mouse.up();
      assert.deepEqual(await snapshot(), prima, 'il trascinamento non sposta il nodo');
      for (const key of ['Delete', 'ArrowRight', 'Control+z', 'Control+y']) await page.keyboard.press(key);
      await page.evaluate(() => {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('application/x-codedb-uml', JSON.stringify(['modalita', 'vendite', 'tabella', 'intrusa']));
        document.querySelector('#uml-canvas').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer, clientX: 500, clientY: 400 }));
      });
      assert.deepEqual(await snapshot(), prima, 'tastiera e drop non modificano il diagramma');
      assert.equal(await page.locator('#uml-mode-modifica, #uml-progetta-btn, #uml-undo, #uml-nota, #uml-entita, #uml-importa, #uml-nuovo, [data-isp="progetta"], [data-isp="rimuovi"]').count(), 0);
      assert.equal(await page.locator('#uml-catalogo [draggable="true"]').count(), 0);
      await page.mouse.click(r.x + 40, r.y + 10, { button: 'right' });
      assert(!/Modifica|Rimuovi|Aggiungi|Blocca|Rinomina|Elimina|Raggruppa/.test(await page.locator('#context-menu').innerText()));
      await page.keyboard.press('Escape');
    };
    await solaLettura();
    await page.screenshot({ path: 'test-reports/screenshots/uml-tabella.png' });
    await page.setViewportSize({ width: 760, height: 900 });
    await page.waitForTimeout(400); // attende la chiusura animata dei drawer
    await page.click('#uml-adatta');
    await page.screenshot({ path: 'test-reports/screenshots/uml-tabella-compatto.png' });
    assert.equal(await page.locator('#view-uml select:visible').count(), 0);
    const toolbar = await page.locator('.uml-bar').boundingBox();
    const inspector = await page.locator('#uml-ispettore').boundingBox();
    assert(inspector.y >= toolbar.y + toolbar.height, 'l’ispettore compatto lascia accessibili i comandi');
    await page.setViewportSize({ width: 1600, height: 950 });
    console.log('✓ Singola: relazioni dirette paginate, FK composta, schema esterno e gesti di sola lettura');

    await changeTable(null);
    await ready('database');
    assert.equal((await nodes()).length, 6);
    await solaLettura();
    const savedBefore = await page.evaluate(async () => {
      const store = await import('/js/uml-store.js');
      const v = window.__uml.statoUml();
      const doc = structuredClone(v.doc);
      doc.nome = 'Diagramma salvato';
      doc.note.push({ id: 'nota-salvata', x: 100, y: 600, w: 220, h: 110, testo: 'Nota da conservare' });
      doc.progetto = [{ id: 'bozza', kind: 'renameTable', table: 'ordini', name: 'ordini_bozza' }];
      await store.salva(v.ambito, 'salvato', { nome: doc.nome, doc });
      window.__scritture = [];
      for (const method of ['put', 'add', 'delete', 'clear']) {
        const original = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (...args) {
          window.__scritture.push(method); return original.apply(this, args);
        };
      }
      return store.leggi(v.ambito, 'salvato');
    });
    await page.click('#uml-refresh');
    await ready('database');
    await scegliArc(page, '#uml-diagrammi', 'salvato');
    await ready('database');
    assert(!(await page.locator('#uml-canvas').innerText()).includes('ordini_bozza'), 'il canvas mostra lo schema effettivo');
    const before = await page.evaluate(() => ({ doc: window.__uml.statoUml().doc, id: window.__uml.statoUml().idDiagramma }));
    await solaLettura();
    await changeTable('ordini');
    await ready('tabella', 'ordini');
    await changeTable('dipendenti');
    assert.deepEqual(await nodes(), ['vendite.clienti', 'vendite.dipendenti']);
    assert.equal(await page.locator('#uml-canvas .joint-link').count(), 2, 'autoriferimento e relazione entrante');
    await changeTable('isolata');
    assert.deepEqual(await nodes(), ['vendite.isolata']);
    assert.equal(await page.locator('#uml-canvas .joint-link').count(), 0);
    await changeTable(null);
    await ready('database');
    assert.deepEqual(await page.evaluate(() => ({ doc: window.__uml.statoUml().doc, id: window.__uml.statoUml().idDiagramma })), before);
    const saved = await page.evaluate(async () => {
      const store = await import('/js/uml-store.js');
      const v = window.__uml.statoUml();
      return (await store.elenca(v.ambito)).length;
    });
    assert.equal(saved, 1, 'le viste semplici non creano diagrammi salvati');
    await changeTable('isolata');
    await page.click('.view-tab[data-view="data"]');
    await openUml();
    await ready('tabella', 'isolata');
    assert.deepEqual(await nodes(), ['vendite.isolata'], 'rientrando dalla tabella si torna a Singola');
    await changeTable(null);
    await ready('database');
    await changeTable('ordini');
    assert.deepEqual(await nodes(), vicine, 'cambiare tabella non eredita la vista database');
    console.log('✓ Cambio tabella, rientro da Dati e diagramma database con nota conservata');

    await page.evaluate(() => { window.__ritardaTabella = 'ordini'; window.__uml.loadUml(true); });
    await page.waitForFunction(() => !!window.__rispondiTabella);
    await ready('tabella', 'ordini');
    assert.equal(await page.locator('.uml-skeleton').count(), 0);
    await changeTable('isolata');
    await page.evaluate(() => { window.__ritardaTabella = null; window.__rispondiTabella(); });
    await page.waitForTimeout(100);
    assert.deepEqual(await nodes(), ['vendite.isolata'], 'risposta della vecchia tabella scartata');
    assert(!(await page.locator('#uml-ispettore').innerText()).includes('risposta_vecchia'));
    // L'intero database rimane raggiungibile dal suo menu, anche partendo da una tabella.
    await page.evaluate(async () => {
      const { renderDbTree } = await import('/js/dbtree.js');
      renderDbTree([{ name: 'vendite', collections: [] }]);
    });
    await page.click('#db-tree .db > .node-label', { button: 'right' });
    await page.click('#context-menu li:has-text("Diagramma UML")');
    await ready('database');
    assert.equal(await page.evaluate(() => window.__state.coll), null);
    assert.equal(await page.locator('#uml-ambito').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__uml.statoUml().doc), before.doc);
    await page.evaluate(() => { window.__rispondi = null; window.__ritarda = true; window.__uml.loadUml(true); });
    await page.waitForFunction(() => !!window.__rispondi);
    assert.equal(await page.locator('#uml-canvas [role="status"]').textContent(), 'Caricamento…');
    assert.equal(await page.locator('#uml-canvas').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.uml-skeleton-nodo').count(), 4);
    assert(!/JointJS|vendor/i.test(await page.locator('#uml-canvas').innerText()));
    await page.screenshot({ path: 'test-reports/screenshots/uml-caricamento.png' });
    await page.setViewportSize({ width: 760, height: 900 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-reports/screenshots/uml-caricamento-compatto.png' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert(await page.locator('.uml-skeleton .skeleton').first().evaluate((el) => parseFloat(getComputedStyle(el).animationDuration) < 0.01));
    await page.evaluate(() => { window.__ritarda = false; window.__rispondi(); });
    await ready('database');
    assert.equal(await page.locator('.uml-skeleton').count(), 0);
    assert.equal(await page.locator('#uml-canvas').getAttribute('aria-busy'), 'false');
    await page.evaluate(() => { window.__rispondi = null; window.__ritarda = true; window.__uml.loadUml(true); });
    await page.waitForFunction(() => !!window.__rispondi);
    await page.evaluate(() => window.__rispondi('Connessione interrotta. Riprova.'));
    await page.waitForSelector('#uml-canvas .error');
    assert.equal(await page.locator('.uml-skeleton').count(), 0);
    assert.equal(await page.locator('#uml-canvas').getAttribute('aria-busy'), 'false');
    console.log('✓ Caricamento senza dettagli tecnici, skeleton database, movimento ridotto, completamento ed errore');
    assert.deepEqual(await page.evaluate(() => window.__scritture), [], 'la consultazione non scrive in IndexedDB');
    const savedAfter = await page.evaluate(async () => {
      const store = await import('/js/uml-store.js');
      return store.leggi(window.__uml.statoUml().ambito, 'salvato');
    });
    assert.deepEqual(savedAfter, savedBefore, 'anche note, bozze e revisione salvate restano intatte');
    assert.deepEqual(await page.evaluate(() => window.__richieste.filter((r) => !['db:schema', 'db:collections', 'collection:stats', 'collection:find', 'collection:count', 'collection:unwatch'].includes(r.event))), [], 'nessuna scrittura verso il server');
    assert.deepEqual(errors, []);
    console.log('✓ Risposte tardive scartate e Intero database nel contesto senza tabella');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
