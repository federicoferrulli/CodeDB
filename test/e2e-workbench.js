'use strict';
// Trasporto simulato e ack controllati; tutti i controller, Arc e i renderer sono reali.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports'}/workbench`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3177 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [];
  const report = { transport: 'simulato, risposte consegnate fuori ordine', checks: [], errors };
  page.on('pageerror', e => errors.push(e.message));
  try {
    if (mutant) await page.route('**/js/query-tab.js', async route => {
      const response = await route.fetch();
      const code = (await response.text()).replaceAll('latest && documentoVisibile(curTab, collTabId)', 'latest');
      await route.fulfill({ response, body: code });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const callbacks = new Map();
      window.wb = { queue: [], sent: [], tabs, holdFind: false };
      const collections = ['ordini', 'clienti', 'archivio_con_un_nome_molto_lungo'];
      const fields = [{ name: '_id', types: ['int'], presence: 100 }, { name: 'cliente', types: ['string'], presence: 100 }, { name: 'totale', types: ['decimal'], presence: 100 }];
      const fake = {
        connected: true,
        on(name, fn) { if (!callbacks.has(name)) callbacks.set(name, new Set()); callbacks.get(name).add(fn); return fake; },
        off(name, fn) { callbacks.get(name)?.delete(fn); return fake; },
        timeout() { return { emit(name, payload, ack) { fake.emit(name, payload, res => ack(null, res)); } }; },
        emit(name, payload, ack) {
          window.wb.sent.push({ name, payload });
          if (name === 'query:execute' || name === 'doc:update' || (name === 'script:execute' && window.wb.holdScript) || (name === 'collection:find' && window.wb.holdFind)) { window.wb.queue.push({ name, payload, ack }); return; }
          if (name === 'mongo:connect') { ack?.({ ok: false, error: 'Connessione di prova non raggiungibile' }); return; }
          if (name === 'script:execute') { ack?.({ ok: true, runId: payload.runId, total: 2 }); return; }
          const docs = Array.from({ length: 12 }, (_, i) => ({ _id: i + 1, cliente: `${payload.tabId} · ${payload.db} · ${payload.coll} · ${i + 1}`, totale: { $numberDecimal: '12345678901234567890.123456789' } }));
          ack?.({ ok: true, docs, columns: ['_id', 'cliente', 'totale'], total: 12, skip: payload.skip || 0, limit: 50,
            fields, indexes: [], collections: collections.map(name => ({ name, fields, indexes: [] })),
            databases: [{ name: 'vendite' }, { name: 'archivio' }], relazioni: [], stats: { count: 12, size: 4096 }, sessions: [] });
        },
      };
      impostaSocket(fake);
      (await import('/js/script-run.js')).initScriptRun();
      window.wb.push = (name, value) => callbacks.get(name)?.forEach(fn => fn(value));
      window.wb.answer = (name, code, result) => {
        const i = window.wb.queue.findIndex(q => q.name === name && (q.payload.code === code || q.payload.coll === code));
        if (i < 0) throw new Error(`Ack assente: ${name}, ${code}`);
        window.wb.queue.splice(i, 1)[0].ack(result);
      };
      for (const [id, dbType, label] of [['locale', 'mongodb', 'Sviluppo · MongoDB'], ['analisi', 'postgresql', 'Analisi · PostgreSQL']]) {
        const tab = createTab({ id }); tab.label = label; tab.dbType = dbType;
        Object.assign(tab.state, { connected: true, connLabel: label, dbType, databases: [{ name: 'vendite', collections: collections.map(name => ({ name })) }, { name: 'archivio', collections: collections.map(name => ({ name })) }] });
      }
      tabs.activeId = 'locale';
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('vendite', 'ordini');
    });
    await page.locator('#grid tbody tr:not(.v-spacer)').first().waitFor();

    // Due database della stessa connessione: B resta intatto quando arriva A.
    await page.locator('.view-tab[data-view="query"]').click();
    await page.locator('#query-editor-input').fill('SELECT A');
    await page.locator('#query-run-btn').click();
    await page.evaluate(async () => {
      (await import('/js/colltabs.js')).openCollTab('archivio', 'clienti');
      (await import('/js/main.js')).setView('query');
    });
    await page.locator('#query-editor-input').fill('SELECT B');
    await page.locator('#query-run-btn').click();
    await page.evaluate(() => window.wb.answer('query:execute', 'SELECT A', { ok: true, data: [{ esito: 'RISULTATO_A' }], columns: ['esito'] }));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#query-table-view').textContent().then(s => s.includes('RISULTATO_A')), false, 'La risposta A non deve dipingere il documento B');
    assert(await page.locator('#query-stop-btn').isVisible(), 'B conserva il proprio annullamento');
    await page.evaluate(() => window.wb.answer('query:execute', 'SELECT B', { ok: true, data: [{ esito: 'RISULTATO_B' }], columns: ['esito'] }));
    await page.evaluate(async () => {
      const { tabs } = await import('/js/tabs.js');
      const ct = tabs.list[0].state.collTabs.find(c => c.coll === 'ordini');
      (await import('/js/colltabs.js')).switchCollTab(ct.id);
    });
    assert.equal(await page.locator('#query-editor-input').inputValue(), 'SELECT A');
    assert((await page.locator('#query-table-view').textContent()).includes('RISULTATO_A'));
    report.checks.push('Query concorrenti su database diversi della stessa connessione: risultati, codice e annullamento isolati');

    // Lo stato delle celle e del filtro ritorna sullo stesso documento.
    await page.evaluate(async () => {
      (await import('/js/main.js')).setView('data');
      const { state } = await import('/js/state.js');
      state.selectedDocs.add('1'); state.cellSel.cells.add('0:1');
      document.getElementById('filter-input').value = 'Acme';
      document.getElementById('filter-input').dispatchEvent(new Event('input', { bubbles: true }));
      const { switchCollTab } = await import('/js/colltabs.js');
      const { activeTab } = await import('/js/tabs.js');
      const ids = activeTab().state.collTabs.map(c => c.id);
      switchCollTab(ids[1]); switchCollTab(ids[0]);
    });
    assert.equal(await page.locator('#filter-input').inputValue(), 'Acme');
    assert(await page.evaluate(async () => (await import('/js/state.js')).state.cellSel.cells.has('0:1')));
    report.checks.push('Filtro e selezione delle celle conservati al cambio documento');

    // Un salvataggio rifiutato conserva il testo come bozza nel suo contesto.
    const cell = page.locator('#grid td[data-r="0"][data-c="1"]');
    await cell.dblclick();
    await cell.locator('input').fill('BOZZA_DA_RECUPERARE');
    await cell.locator('input').press('Enter');
    assert.equal(await page.evaluate(async () => (await import('/js/tabs.js')).closeTab('locale')), false, 'Una scrittura in volo impedisce la disconnessione');
    await page.evaluate(async () => {
      const tab = (await import('/js/tabs.js')).activeTab();
      (await import('/js/colltabs.js')).switchCollTab(tab.state.collTabs[1].id);
      window.wb.answer('doc:update', 'ordini', { ok: false, error: 'Vincolo di prova: scrittura rifiutata' });
    });
    await page.waitForTimeout(40);
    await page.evaluate(async () => {
      const tab = (await import('/js/tabs.js')).activeTab();
      (await import('/js/colltabs.js')).switchCollTab(tab.state.collTabs[0].id);
    });
    assert(await cell.evaluate(el => el.classList.contains('edit-draft')));
    await cell.dblclick();
    assert.equal(await cell.locator('input').inputValue(), 'BOZZA_DA_RECUPERARE');
    await cell.locator('input').press('Escape');
    assert.equal(await cell.evaluate(el => el.classList.contains('edit-draft')), false);
    report.checks.push('Salvataggio in volo protetto; errore dopo cambio documento conserva la bozza, recuperabile e annullabile');
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      (await import('/js/inlineEdit.js')).openEditDoc(state.docs[0]);
    });
    await page.locator('#editdoc-json').fill('{ "cliente": "Modifica pendente" }');
    page.once('dialog', d => d.dismiss());
    await page.evaluate(async () => (await import('/js/utils.js')).closeModal('#editdoc-overlay'));
    assert(await page.locator('#editdoc-overlay').isVisible());
    assert((await page.locator('#editdoc-id').textContent()).includes('vendite / ordini'));
    page.once('dialog', d => d.accept());
    await page.evaluate(async () => (await import('/js/utils.js')).closeModal('#editdoc-overlay'));
    report.checks.push('Editor documento: contesto esplicito e chiusura annullabile con modifiche pendenti');

    // La sequenza di file continua sul documento catturato, anche fuori fuoco.
    await page.evaluate(async () => {
      const { activeTab } = await import('/js/tabs.js');
      const tab = activeTab(), collTabId = tab.state.activeCollId;
      const q = (await import('/js/query-document.js')).queryDocument();
      q.file = { tab, collTabId, document: q, index: 0, running: false, chunker: {
        chunks: [{ index: 0, size: 10 }, { index: 1, size: 10 }],
        getFileInfo: () => ({ name: 'sequenza.sql', formattedSize: '20 B', chunkCount: 2 }),
        getChunkCount: () => 2,
        readChunk: async i => ({ text: `SELECT BLOCCO_${i};`, startByte: i * 10, endByte: (i + 1) * 10, totalBytes: 20 }),
      } };
      (await import('/js/query-tab.js')).restoreQueryView(q);
      (await import('/js/main.js')).setView('query');
      document.getElementById('chunk-run-all-btn').click();
    });
    await page.waitForFunction(() => window.wb.sent.some(r => r.name === 'script:execute' && r.payload.code.includes('BLOCCO_0')));
    await page.evaluate(async () => {
      const { activeTab } = await import('/js/tabs.js');
      const tab = activeTab();
      (await import('/js/colltabs.js')).switchCollTab(tab.state.collTabs[1].id);
      const first = window.wb.sent.find(r => r.name === 'script:execute' && r.payload.code.includes('BLOCCO_0'));
      window.wb.push('script:progress', { runId: first.payload.runId, tipo: 'done', stato: { status: 'done', total: 1, eseguiti: 1, falliti: 0 }, ultimoRisultato: { docs: [{ esito: 'BLOCCO_0' }], columns: ['esito'] } });
    });
    await page.waitForFunction(() => window.wb.sent.some(r => r.name === 'script:execute' && r.payload.code.includes('BLOCCO_1')));
    const chunks = await page.evaluate(() => window.wb.sent.filter(r => r.name === 'script:execute' && r.payload.code.includes('BLOCCO_')).map(r => r.payload));
    assert(chunks.every(r => r.tabId === 'locale' && r.db === 'vendite' && r.coll === 'ordini'));
    assert.equal(await page.locator('#query-editor-input').inputValue(), 'SELECT B');
    await page.evaluate(async runId => {
      window.wb.push('script:progress', { runId, tipo: 'done', stato: { status: 'done', total: 1, eseguiti: 1, falliti: 0 }, ultimoRisultato: { docs: [{ esito: 'BLOCCO_1' }], columns: ['esito'] } });
      const tab = (await import('/js/tabs.js')).activeTab();
      (await import('/js/colltabs.js')).switchCollTab(tab.state.collTabs[0].id);
    }, chunks[1].runId);
    await page.waitForFunction(() => document.getElementById('chunk-progress-text').textContent.includes('Completato'));
    assert((await page.locator('#query-table-view').textContent()).includes('BLOCCO_1'));
    await page.locator('#chunk-close-btn').click();
    report.checks.push('Script a blocchi: avanzamento in background, stessa sessione e database, nessuna modifica del secondo editor');
    const download = page.waitForEvent('download');
    await page.locator('#query-editor-input').press('Control+s');
    await (await download).saveAs(`${dir}/query-salvata.sql`);
    assert.equal(fs.readFileSync(`${dir}/query-salvata.sql`, 'utf8'), 'SELECT BLOCCO_1;');
    assert.equal(await page.evaluate(async () => (await import('/js/query-document.js')).queryDocument().dirty), false);
    report.checks.push('Salvataggio del testo query via Ctrl+S, senza trasformare il contenuto');

    await page.evaluate(async () => {
      window.wb.holdScript = true;
      const m = await import('/js/script-run.js');
      window.wb.scriptA = m.runScript({ code: 'SELECT VECCHIO;', db: 'vendite', coll: 'ordini' }).catch(() => {});
      window.wb.scriptB = m.runScript({ code: 'SELECT NUOVO;', db: 'vendite', coll: 'ordini' });
      window.wb.answer('script:execute', 'SELECT VECCHIO;', { ok: false, error: 'Errore tardivo' });
      await window.wb.scriptA;
    });
    assert.equal(await page.evaluate(async () => (await import('/js/query-document.js')).queryDocument().metrics[0]), 'running', 'L’errore dello script precedente non sostituisce lo stato del nuovo');
    await page.evaluate(async () => {
      const req = window.wb.sent.filter(r => r.name === 'script:execute').at(-1);
      window.wb.answer('script:execute', 'SELECT NUOVO;', { ok: true, total: 1, runId: req.payload.runId });
      await window.wb.scriptB;
      await (await import('/js/script-run.js')).abortScript(req.payload.runId);
      window.wb.holdScript = false;
    });
    assert.equal(await page.evaluate(async () => (await import('/js/query-document.js')).queryDocument().metrics[0]), 'cancelled');
    assert.equal(await page.locator('#query-table-view .skeleton').count(), 0);
    report.checks.push('Script sostituito: errore tardivo ignorato; annullamento definitivo termina stato e caricamento');

    await page.evaluate(async () => {
      const { trackPending, resumePendingQuery } = await import('/js/pending-queries.js');
      const ct = (await import('/js/tabs.js')).activeTab().state.activeCollId;
      const p = trackPending({ kind: 'script', runId: 'script-perduto', tabId: 'locale', collTabId: ct, db: 'vendite', coll: 'ordini', code: 'INSERT GIA_APPLICATO;' });
      p.fail(new Error('Sessione interrotta'));
      window.wb.beforeResume = window.wb.sent.length;
      resumePendingQuery(p.id);
    });
    assert.equal(await page.locator('#query-editor-input').inputValue(), 'INSERT GIA_APPLICATO;');
    assert.equal(await page.evaluate(() => window.wb.sent.slice(window.wb.beforeResume).some(r => ['query:execute', 'script:execute'].includes(r.name))), false, 'Uno script senza cursore non deve ripetere automaticamente le scritture');
    await page.locator('#query-editor-input').fill('SELECT BLOCCO_1;');
    report.checks.push('Script senza cursore recuperato come testo, senza ripetere scritture già applicate');

    // Due sessioni nello stesso albero di split; editor e risultati reali in entrambi.
    await page.evaluate(async () => {
      const m = await import('/js/splitview.js');
      m.addOrSplitPane(null, 'right', { tabId: 'analisi', db: 'archivio', coll: 'ordini', view: 'query' });
      const snap = m.getSplitStateSnapshot(); window.wb.panes = snap.panes.map(([id]) => id);
      await m.runPaneQuery(snap.panes.find(([, p]) => p.tabId === 'locale')[0]);
      const req = window.wb.sent.filter(r => r.name === 'collection:find' && r.payload.tabId === 'locale').at(-1);
      if (req.payload.cercaOvunque?.valore !== 'Acme' || req.payload.filter) throw new Error('Il pannello deve conservare la ricerca rapida originale');
      for (const [id] of snap.panes) m.setPaneView(id, 'query');
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.pane-runtime')].length === 2 && [...document.querySelectorAll('.pane-runtime')].every(f => f.codedbPanel.ready));
    const embedded = page.frames().filter(f => f.parentFrame());
    const frames = [];
    for (const id of ['locale', 'analisi']) {
      for (const frame of embedded) if (await frame.evaluate(() => window.frameElement.codedbPanel.tabId) === id) frames.push(frame);
    }
    assert.equal(frames.length, 2);
    assert.deepEqual(await page.locator('select.pane-coll-select').evaluateAll(els => els.map(el => el.value)), ['ordini', 'ordini'], 'I bersagli restano visibili anche se la query precede il catalogo');
    await frames[0].locator('#query-editor-input').fill('SELECT PANNELLO_1');
    await frames[1].locator('#query-editor-input').fill('SELECT PANNELLO_2');
    await frames[0].locator('#query-run-btn').click();
    await frames[1].locator('#query-run-btn').click();
    await frames[0].locator('#query-editor-input').click();
    const requests = await page.evaluate(() => window.wb.sent.filter(q => q.name === 'query:execute' && q.payload.code.startsWith('SELECT PANNELLO')).map(q => q.payload));
    assert.equal(new Set(requests.map(r => r.tabId)).size, 2, 'Le query dei pannelli usano due sessioni diverse');
    await page.evaluate(() => window.wb.answer('query:execute', 'SELECT PANNELLO_2', { ok: true, data: [{ confronto: 'SECONDO_PANNELLO' }], columns: ['confronto'] }));
    await frames[0].locator('#query-stop-btn').click();
    assert.equal(await frames[0].locator('#query-table-view .skeleton').count(), 0, 'Annullamento rimuove il caricamento');
    const cancelled = await page.evaluate(() => window.wb.sent.filter(q => q.name === 'query:cancel').at(-1).payload);
    assert.equal(cancelled.tabId, requests[0].tabId);
    assert.equal(cancelled.runId, requests[0].runId);
    await page.evaluate(() => window.wb.answer('query:execute', 'SELECT PANNELLO_1', { ok: true, data: [{ confronto: 'ANNULLATO_NON_MOSTRARE' }] }));
    assert(!(await frames[0].locator('#query-table-view').textContent()).includes('ANNULLATO_NON_MOSTRARE'));
    assert((await frames[1].locator('#query-table-view').textContent()).includes('SECONDO_PANNELLO'));
    report.checks.push('Due connessioni affiancate: risposte invertite, cambio focus e annullamento per run e sessione');

    // Nessun riavvio degli editor quando cambia il layout o si visita un altro tab.
    await page.evaluate(async () => {
      const m = await import('/js/splitview.js');
      m.scambiaConVicino(window.wb.panes[0], 'next');
      const { saveWorkspaceInputs } = await import('/js/workspace.js');
      const { switchTab } = await import('/js/tabs.js');
      saveWorkspaceInputs(); switchTab('analisi'); switchTab('locale');
    });
    assert.equal(await frames[0].locator('#query-editor-input').inputValue(), 'SELECT PANNELLO_1');
    assert((await frames[1].locator('#query-table-view').textContent()).includes('SECONDO_PANNELLO'));
    report.checks.push('Layout, focus e cambio connessione non rimontano gli editor dei pannelli');
    await frames[0].locator('#query-editor-input').press('Control+p');
    await page.locator('#palette-input').waitFor();
    await page.keyboard.press('Escape');
    const separator = page.locator('.split-resizer-v').first();
    const before = await separator.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + 100);
    await page.mouse.down();
    await page.mouse.move(before.x + 90, before.y + 100, { steps: 6 });
    await page.mouse.up();
    assert((await separator.boundingBox()).x > before.x + 50, 'Ridimensionamento reale col puntatore');
    await separator.focus();
    const oldValue = Number(await separator.getAttribute('aria-valuenow'));
    await separator.press('ArrowLeft');
    assert(Number(await separator.getAttribute('aria-valuenow')) < oldValue, 'Ridimensionamento da tastiera');
    await page.evaluate(async () => (await import('/js/splitview.js')).pareggiaPannelli());
    report.checks.push('Palette globale dall’editor incorporato, ridimensionamento con puntatore e tastiera');

    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      for (const width of [1600, 1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 1000 : 900 });
        await page.waitForTimeout(120);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: `${dir}/confronto-${theme}-${width}.png`, animations: 'disabled' });
        if (width === 390) {
          await page.locator('#workspace-active-pane-btn').click();
          await page.waitForTimeout(60);
          const bounds = await frames[0].locator('#query-editor-input').boundingBox();
          assert(bounds.y >= 0 && bounds.y < 900, 'Il pannello attivo si raggiunge con un comando');
        }
      }
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.setProperty('--accent-fg', '#c4b5fd'); document.documentElement.style.setProperty('--accent', '#6d28d9'); });
    await page.waitForTimeout(100);
    assert.equal(await frames[0].evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#6d28d9');
    await page.screenshot({ path: `${dir}/tema-personalizzato.png`, animations: 'disabled' });
    report.checks.push('Temi chiaro, scuro e token personalizzati; desktop, laptop e viewport stretto senza overflow della pagina');

    // Rifiutare la chiusura conserva il lavoro; chiudere una sessione preserva l'altra.
    page.once('dialog', dialog => dialog.dismiss());
    await page.evaluate(async () => (await import('/js/splitview.js')).closePane(window.wb.panes[0]));
    assert.equal(await page.locator('.pane-runtime').count(), 2);
    page.on('dialog', dialog => dialog.accept());
    await page.evaluate(async () => {
      (await import('/js/tabs.js')).closeTab('locale');
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
    });
    assert.equal(await page.evaluate(() => window.wb.tabs.list.length), 1);
    assert.equal(await page.locator('.pane-runtime').count(), 1);
    assert((await page.frames().find(f => f.parentFrame()).locator('#query-table-view').textContent()).includes('SECONDO_PANNELLO'));
    report.checks.push('Chiusura annullabile con query non salvate; disconnessione del proprietario trasferisce il confronto superstite');
    await page.evaluate(async () => {
      const p = await import('/js/pending-queries.js');
      const item = p.trackPending({ runId: 'sessione-chiusa', tabId: 'locale', connName: 'Sviluppo', db: 'vendite', coll: 'ordini', code: 'DELETE FROM ordini' });
      item.fail(new Error('Connessione chiusa'));
      window.wb.beforeResume = window.wb.sent.length;
      p.resumePendingQuery(item.id);
    });
    assert.equal(await page.evaluate(() => window.wb.sent.slice(window.wb.beforeResume).some(r => ['query:execute', 'script:execute'].includes(r.name))), false, 'La ripresa non deve usare una connessione diversa da quella chiusa');
    report.checks.push('Ripresa dalla sessione chiusa: testo conservato nel registro e nessuna esecuzione sulla sessione superstite');
    const err = await page.evaluate(async () => {
      try { await (await import('/js/connection.js')).connectAndOpenTab({ dbType: 'mysql', host: 'fixture.invalid' }); }
      catch (e) { return e.message; }
    });
    assert.equal(err, 'Connessione di prova non raggiungibile');
    assert.equal(await page.evaluate(() => window.wb.tabs.list.length), 1);
    report.checks.push('Errore di connessione senza alterare la sessione già aperta');
    assert.deepEqual(errors, []);
    console.log(`OK: ${report.checks.length} scenari workbench`);
  } catch (error) {
    report.failure = error.stack;
    await page.screenshot({ path: `${dir}/${mutant ? 'mutante' : 'failure'}.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/${mutant ? 'mutante' : 'report'}.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
