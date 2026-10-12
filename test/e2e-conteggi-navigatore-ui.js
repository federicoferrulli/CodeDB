'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/conteggi-navigatore';

(async () => {
  const server = await startTestServer({ port: 3207 });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const t = await import('/js/tabs.js');
      const tree = await import('/js/dbtree.js');
      const collections = [
        { name: 'Prova', count: 3, countApprox: false },
        { name: 'vuota', count: 0, countApprox: false },
        { name: 'archivio_storico_con_un_nome_molto_lungo', count: 2500000000, countApprox: true },
        { name: 'appena_importata', count: 1001, countLowerBound: true },
        { name: 'statistiche_assenti', count: null },
        { name: 'vista', count: null, type: 'view' },
      ];
      const f = window.countFixture = { collections, calls: [], pending: [], hold: false, tree, t };
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(event, payload, cb) {
        f.calls.push({ event, payload });
        if (event === 'db:collections' && f.hold) { f.pending.push(() => cb({ ok: true, collections: structuredClone(collections) })); return; }
        if (event === 'doc:insert') collections[0].count++;
        if (event === 'doc:delete') collections[0].count--;
        cb?.({ ok: true, collections: structuredClone(collections), databases: [{ name: 'diego', collections: structuredClone(collections) }], connections: [], docs: [], total: 0 });
      } });
      const tab = f.tab = t.createTab({ id: 'conteggi-pg', connName: 'Postgresql' });
      tab.dbType = 'postgresql';
      Object.assign(tab.state, { dbType: 'postgresql', connected: true, databases: [{ name: 'diego', collections }], expandedDbs: new Set(['diego']) });
      t.tabs.activeId = tab.id;
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      tree.renderDbTree([{ name: 'diego', collections }]);
    });
    const count = name => page.locator(`#db-tree .node-label[data-coll="${name}"] .count`);
    assert.equal(await count('Prova').textContent(), '3');
    assert.equal(await count('vuota').textContent(), '0');
    assert.match(await count('archivio_storico_con_un_nome_molto_lungo').textContent(), /^≈ /);
    assert.match(await count('archivio_storico_con_un_nome_molto_lungo').getAttribute('title'), /2\.500\.000\.000/);
    assert.match(await count('appena_importata').textContent(), /^≥ 1\.?001$/);
    assert.equal(await count('statistiche_assenti').textContent(), '—');
    assert.equal(await count('vista').count(), 0);

    await page.locator('[data-coll="Prova"]').focus();
    await page.evaluate(async () => {
      const f = window.countFixture; f.calls.length = 0;
      const { emit } = await import('/js/trasporto.js');
      await Promise.all(Array.from({ length: 10 }, () => emit('doc:insert', { db: 'diego', coll: 'Prova' })));
    });
    await page.waitForFunction(() => document.querySelector('[data-coll="Prova"] .count')?.textContent === '13');
    assert.equal(await page.evaluate(() => window.countFixture.calls.filter(c => c.event === 'db:collections').length), 1, 'Dieci scritture ravvicinate richiedono un solo refresh');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.coll), 'Prova', 'Il refresh non ricrea il nodo e non perde il focus');

    await page.evaluate(async () => {
      const f = window.countFixture; f.hold = true;
      await (await import('/js/trasporto.js')).emit('doc:delete', { db: 'diego', coll: 'Prova' });
    });
    await page.waitForFunction(() => window.countFixture.pending.length === 1);
    await page.evaluate(() => {
      const f = window.countFixture;
      const other = f.t.createTab({ id: 'conteggi-altro', connName: 'Altra connessione' });
      Object.assign(other.state, { connected: true, dbType: 'mysql', expandedDbs: new Set(['diego']) });
      f.t.tabs.activeId = other.id;
      f.tree.renderDbTree([{ name: 'diego', collections: [{ name: 'Prova', count: 99 }] }]);
      f.pending.shift()(); f.hold = false;
    });
    await page.waitForFunction(() => window.countFixture.tab.state.databases[0].collections[0].count === 12);
    assert.equal(await count('Prova').textContent(), '99', 'Risposta tardiva confinata alla connessione di origine');
    await page.evaluate(() => {
      const f = window.countFixture; f.t.tabs.activeId = f.tab.id;
      f.tree.renderDbTree(f.tab.state.databases);
    });
    assert.equal(await count('Prova').textContent(), '12');
    console.log('OK esatti/stimati/minimi/sconosciuti, aggiornamento dopo scritture, debounce, focus e isolamento dei tab');

    fs.mkdirSync(dir, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await page.locator('#mobile-nav-dbs').click();
      await page.waitForTimeout(180);
      const bounds = await page.locator('#db-tree .coll > .node-label').evaluateAll(labels => labels.map(label => {
        const count = label.querySelector('.count');
        if (!count) return true;
        const r = label.getBoundingClientRect(), c = count.getBoundingClientRect();
        const name = label.querySelector(':scope > span:not(.count)').getBoundingClientRect();
        return c.right <= r.right + 1 && c.left >= name.right - 1 && c.bottom <= r.bottom + 1;
      }));
      assert(bounds.every(Boolean), `Nessuna sovrapposizione dei conteggi a ${width}px`);
      await page.screenshot({ path: `${dir}/${width}.png` });
    }
    assert.deepEqual(errors, []);
    console.log('OK desktop/mobile 390/320: conteggi compatti senza sovrapposizioni, nessun errore JavaScript');
  } finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
