'use strict';
// Stessi controller della scheda singola, due sessioni e database distinti.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/split-completa-2026-10-12';
const mutant = process.argv.includes('--mutant');
(async () => {
  const server = await startTestServer({ port: 3204 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message));
  const check = msg => { checks.push(msg); console.log('OK', msg); };
  try {
    if (mutant) await page.route('**/js/pane-runtime.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const guard = 'const message = { ...payload, tabId: pane.tabId };';
      assert(source.includes(guard));
      await route.fulfill({ response, body: source.replace(guard, "const message = { ...payload, tabId: tabs.activeId };") });
    });
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const split = await import('/js/splitview.js');
      const databases = ['vendite', 'archivio'].map(name => ({ name, collections: ['ordini', 'clienti', 'prodotti'].map(name => ({ name })) }));
      const listeners = new Map();
      window.fixture = { sent: [], queue: [], tabs, split, push(event, data) { for (const fn of listeners.get(event) || []) fn(data); } };
      const socket = { connected: true,
        on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
        off(event, fn) { listeners.get(event)?.delete(fn); },
        timeout() { return { emit: (name, p, ack) => socket.emit(name, p, res => ack(null, res)) }; },
        emit(name, p = {}, ack) {
          window.fixture.sent.push({ name, p });
          if ((name === 'doc:update' && window.fixture.holdWrite) || (name === 'query:execute' && p.code.includes('ATTESA')) || (name === 'collection:find' && window.fixture.holdFind)) { window.fixture.queue.push({ name, p, ack }); return; }
          if (name === 'collection:watch') window.fixture.push('watch:unavailable', { ...p });
          const docs = Array.from({ length: Number(p.limit) || 50 }, (_, i) => ({ _id: i + (p.skip || 0) + 1, cliente: `${p.tabId}/${p.db}/${p.coll} ${i + (p.skip || 0) + 1}`, importo: 25 + i }));
          ack?.({ ok: true, databases, collections: databases[0].collections, docs, columns: ['_id', 'cliente', 'importo'],
            total: 2282, skip: p.skip || 0, limit: Number(p.limit) || 50, data: docs, fields: [{ name: '_id', types: ['integer'] }, { name: 'cliente', types: ['text'] }], indexes: [], relations: [], stats: { count: 2282 }, relazioni: [] });
        },
      };
      impostaSocket(socket);
      for (const [id, dbType, label] of [['mongo', 'mongodb', 'MongoDB locale'], ['pg', 'postgresql', 'PostgreSQL analisi']]) {
        const t = createTab({ id }); t.label = label; t.dbType = dbType;
        Object.assign(t.state, { connected: true, connLabel: label, dbType, databases });
      }
      tabs.activeId = 'mongo';
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('vendite', 'ordini');
      await new Promise(r => setTimeout(r, 20));
      await split.addOrSplitPane(null, 'right', { tabId: 'pg', db: 'archivio', coll: 'clienti' });
      window.fixture.area = tabs.list[0].state.activeCollId;
    });
    await page.waitForFunction(() => document.querySelectorAll('.pane-runtime').length === 2 && [...document.querySelectorAll('.pane-runtime')].every(f => f.codedbPanel.ready));
    const [mongo, pg] = page.frames().filter(f => f.parentFrame());
    await pg.locator('#grid tbody td[data-c="1"]').first().waitFor();
    assert((await pg.locator('#grid').textContent()).includes('pg/archivio/clienti'), 'Il pannello PostgreSQL deve leggere dalla propria sessione');
    assert((await mongo.locator('#grid').textContent()).includes('mongo/vendite/ordini'));
    const ids = await page.evaluate(() => window.fixture.split.getSplitStateSnapshot().panes.map(([id]) => id));
    const panes = ids.map(id => page.locator(`[data-pane-id="${id}"]`));
    check('Dati completi e bersagli isolati fra connessione MongoDB e PostgreSQL');
    await pg.locator('#filter-input').fill('Acme');
    await pg.locator('#run-btn').click();
    let sent = await page.evaluate(() => window.fixture.sent.filter(x => x.name === 'collection:find').at(-1).p);
    assert.equal(sent.tabId, 'pg'); assert.equal(sent.db, 'archivio'); assert.equal(sent.cercaOvunque.valore, 'Acme');
    await pg.locator('#next-btn').click();
    sent = await page.evaluate(() => window.fixture.sent.filter(x => x.name === 'collection:find').at(-1).p);
    assert.equal(sent.skip, 50); assert.equal(sent.tabId, 'pg');
    assert.equal(await mongo.locator('#filter-input').inputValue(), '');
    check('Ricerca e paginazione indipendenti con gli stessi comandi della scheda singola');
    // Un salvataggio non può essere dirottato da focus o chiusura.
    await page.evaluate(() => { window.fixture.holdWrite = true; });
    const cell = pg.locator('#grid tbody td[data-c="1"]').first();
    await cell.dblclick();
    await cell.locator('input').fill('Nuovo cliente');
    await cell.locator('input').press('Enter');
    await page.waitForFunction(() => window.fixture.queue.some(x => x.name === 'doc:update'));
    await mongo.locator('#filter-input').click();
    await panes[1].locator('.pane-close-btn').click();
    assert.equal(await page.locator('.pane-runtime').count(), 2, 'Il salvataggio in volo impedisce la chiusura');
    const write = await page.evaluate(() => window.fixture.queue.find(x => x.name === 'doc:update').p);
    assert.equal(write.tabId, 'pg'); assert.equal(write.db, 'archivio'); assert.equal(write.coll, 'clienti');
    await page.evaluate(() => { window.fixture.holdWrite = false; window.fixture.queue.shift().ack({ ok: true }); });
    check('Modifica inline sulla sessione corretta e protezione durante il salvataggio');
    // Le operazioni avanzate sono gli stessi controller, non copie limitate.
    await pg.locator('#insert-btn').click();
    await pg.locator('#insert-overlay .modal').waitFor();
    await pg.locator('#insert-overlay .arc-dialog-shell').waitFor();
    assert.equal(await pg.locator('#insert-overlay .arc-dialog-sheet').count(), 0, 'Un pannello desktop stretto mantiene un dialog');
    await pg.locator('#insert-overlay .modal').press('Escape');
    await pg.locator('#insert-overlay').waitFor({ state: 'hidden' });
    await panes[1].locator('[data-pane-view="details"]').click();
    await pg.locator('#view-details').waitFor();
    await panes[1].locator('[data-pane-view="query"]').click();
    await pg.locator('#query-editor-input').fill('SELECT ATTESA_PG');
    await pg.locator('#query-run-btn').click();
    await panes[0].locator('[data-pane-view="query"]').click();
    await mongo.locator('#query-editor-input').fill('SELECT ATTESA_MONGO');
    await mongo.locator('#query-run-btn').click();
    await page.evaluate(() => {
      const i = window.fixture.queue.findIndex(x => x.p.tabId === 'pg');
      window.fixture.queue.splice(i, 1)[0].ack({ ok: true, data: [{ esito: 'Solo PostgreSQL' }], columns: ['esito'] });
    });
    assert((await pg.locator('#query-table-view').textContent()).includes('Solo PostgreSQL'));
    assert(!(await mongo.locator('#query-table-view').textContent()).includes('Solo PostgreSQL'));
    await mongo.locator('#query-stop-btn').click();
    check('Inserimento, Dettagli, query concorrenti, risposte invertite e annullamento isolati');
    await page.evaluate(async ids => { window.fixture.split.scambiaConVicino(ids[0], 'next'); window.fixture.split.massimizzaPane(ids[1]); }, ids);
    assert.equal(await pg.locator('#query-editor-input').inputValue(), 'SELECT ATTESA_PG');
    await page.evaluate(ids => window.fixture.split.massimizzaPane(ids[1]), ids);
    await panes[1].locator('[data-pane-view="data"]').click();
    assert.equal(await pg.locator('#filter-input').inputValue(), 'Acme');
    assert.equal(await pg.evaluate(async () => (await import('/js/state.js')).state.skip), 50);
    await page.evaluate(ids => window.fixture.split.scambiaConVicino(ids[0], 'prev'), ids);
    const snapshot = await page.evaluate(() => window.fixture.split.getSplitStateSnapshot());
    assert.equal(snapshot.panes.find(([, p]) => p.tabId === 'pg')[1].skip, 50);
    assert.equal(snapshot.panes.find(([, p]) => p.tabId === 'pg')[1].filter, 'Acme');
    check('Layout, espansione e cambio vista conservano bozze, filtri e pagina; snapshot aggiornato');
    // Live: l'evento appartiene al solo osservatore che lo ha richiesto.
    await page.evaluate(ids => { window.fixture.sent = []; window.fixture.push('collection:changed', { tabId: 'pg', watchId: ids[1], db: 'archivio', coll: 'clienti' }); }, ids);
    await page.waitForFunction(() => window.fixture.sent.some(x => x.name === 'collection:find'));
    assert((await page.evaluate(() => window.fixture.sent.filter(x => x.name === 'collection:find').map(x => x.p.tabId))).every(id => id === 'pg'));
    check('Aggiornamento live instradato al solo pannello interessato');
    if (!process.argv.includes('--checks-only')) {
      await page.waitForTimeout(4500);
      fs.mkdirSync(dir, { recursive: true });
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        for (const width of [1600, 1024]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.waitForTimeout(100);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          for (const frame of [mongo, pg]) {
            const box = await frame.locator('#workspace').boundingBox();
            for (const selector of ['#run-btn', '#refresh-btn', '#insert-btn']) {
              if (await frame.locator(selector).isVisible()) { const r = await frame.locator(selector).boundingBox(); assert(r.x + r.width <= box.x + box.width + 1, `${selector} raggiungibile a ${width}px`); }
            }
          }
          await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector('.split-container'));
    assert.equal(await page.locator('.pane-runtime:visible').count(), 0);
    if (!process.argv.includes('--checks-only')) await page.screenshot({ path: `${dir}/mobile.png` });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(async () => (await import('/js/colltabs.js')).switchCollTab(window.fixture.area));
    assert.equal(await pg.locator('#filter-input').inputValue(), 'Acme');
    check('Su mobile resta la scheda singola; tornare allo split conserva i pannelli');
    assert.deepEqual(errors, []);
    if (!mutant) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/report.json`, JSON.stringify({ checks, errors }, null, 2)); }
  } finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
