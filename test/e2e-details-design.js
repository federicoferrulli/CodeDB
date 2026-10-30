'use strict';
// UI e controller reali, metadati e scritture simulati: nessun database viene modificato.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
const dir = process.env.CODEDB_REPORT_DIR || `test-reports/dettagli-design-2026-10-12/${mutant ? 'mutante' : process.argv.includes('--confirm') ? 'conferma' : 'dopo'}`;

(async () => {
  const server = await startTestServer({ port: 3213 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const report = { environment: 'Chromium, metadati e scritture simulati', checks: [], layouts: [], errors: [] };
  fs.mkdirSync(dir, { recursive: true });
  page.on('pageerror', error => report.errors.push(error.message));
  const ok = message => { report.checks.push(message); console.log('OK', message); };
  const loaded = () => page.waitForFunction(() => document.querySelector('#view-details').getAttribute('aria-busy') === 'false');
  const reload = async () => { await page.evaluate(async () => (await import('/js/details.js')).loadDetails()); await loaded(); };
  try {
    await page.addInitScript(version => {
      localStorage.setItem('codedb:tema', 'dark');
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const [{ createTab, tabs }, { state }, { impostaSocket }, tabbar, workspace] = await Promise.all(['tabs', 'state', 'socket', 'tabbar', 'workspace'].map(name => import(`/js/${name}.js`)));
      const tab = createTab({ id: 'details-fixture', connName: 'Sviluppo' }); tabs.activeId = tab.id;
      const fields = [
        { name: '_id', types: ['objectId'], presence: 100 }, { name: 'key', types: ['string'], presence: 100 },
        { name: 'label', types: ['string'], presence: 100 }, { name: 'functionalityMaskId', types: ['int'], presence: 100 },
        { name: 'createdAt', types: ['date'], presence: 100 }, { name: 'updatedAt', types: ['date'], presence: 67 },
        { name: 'isDeleted', types: ['boolean'], presence: 100 }, { name: 'deletedAt', types: ['date', 'null'], presence: 33 },
        { name: 'deletedBy', types: ['objectId', 'null'], presence: 33 }, { name: 'deletionReason', types: ['string', 'null'], presence: 33 },
        { name: '__v', types: ['int'], presence: 100 },
      ];
      const data = { ok: true, stats: { count: 3, size: 553, storageSize: 36864, avgObjSize: 184, totalIndexSize: 73728, nindexes: 2 },
        fields, sampled: 3, indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }, { name: 'key_1', key: { key: 1 }, unique: true }] };
      window.detailsFixture = { data, mongo: structuredClone(data), sent: [], pending: [], hold: false, fail: false };
      Object.assign(state, { connected: true, connLabel: 'Sviluppo', dbType: 'mongodb', db: 'dropchecker', coll: 'approles',
        docs: [], columns: [], total: 0, exhausted: true, databases: [{ name: 'dropchecker', collections: [{ name: 'approles' }] }],
        collTabs: [{ id: 'details-coll', db: 'dropchecker', coll: 'approles' }], activeCollId: 'details-coll', view: 'data' });
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (event, payload, cb) => fake.emit(event, payload, response => cb(null, response)) }; }, emit(event, payload, cb) {
        const fixture = window.detailsFixture; fixture.sent.push({ event, payload });
        if (event === 'collection:stats') {
          const response = structuredClone(fixture.fail ? { ok: false, error: 'Metadati temporaneamente non disponibili.' } : fixture.data);
          if (fixture.hold) { fixture.pending.push(() => cb(response)); return; }
          return cb(response);
        }
        cb?.({ ok: true, name: payload.name || 'indice_prova', modified: 3, databases: state.databases, collections: [], docs: [], columns: [], fields: fixture.data.fields, indexes: fixture.data.indexes, total: 0 });
      } };
      impostaSocket(fake); tabbar.renderTabBar(); workspace.renderWorkspace();
    });
    if (mutant) await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) { return animate.call(this, frames, this.closest('#view-details') ? { ...options, duration: 0, delay: 0 } : options); };
    });
    await page.locator('.view-tab[data-view="details"]').click(); await loaded();
    assert.equal(await page.locator('#details-name').textContent(), 'approles');
    assert.equal(await page.locator('#schema-table tbody tr').count(), 11);
    assert.equal(await page.locator('#index-table tbody tr').count(), 2);
    assert.equal(await page.locator('#stats-table tbody tr').count(), 6);
    assert.equal(await page.locator('#schema-table tbody tr').first().locator('button').count(), 0);
    assert.equal(await page.locator('#index-table tbody tr').first().locator('button').count(), 0);
    report.motion = await page.evaluate(async () => {
      const { renderDetails } = await import('/js/details.js'); renderDetails(window.detailsFixture.data);
      const frames = [], start = performance.now();
      await new Promise(resolve => { function sample(now) {
        frames.push(getComputedStyle(document.querySelector('.details-presence-fill')).transform);
        if (now - start < 570) requestAnimationFrame(sample); else resolve();
      } requestAnimationFrame(sample); });
      return frames;
    });
    assert(new Set(report.motion).size > 4, 'La presenza attraversa fotogrammi intermedi reali');
    assert.equal(await page.locator('#view-details').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    ok('Statistiche, schema, indici protetti e animazione reale senza effetti residui');

    await page.locator('#column-add-btn').click();
    await page.locator('#coledit-name').fill('nuovo_campo'); await page.locator('#coledit-save').click();
    await page.waitForFunction(() => !document.querySelector('#coledit-overlay').dataset.arcDialog);
    await loaded();
    assert.equal(await page.evaluate(() => window.detailsFixture.sent.findLast(x => x.event === 'column:add').payload.column.name), 'nuovo_campo');
    await page.getByRole('button', { name: 'Modifica label', exact: true }).click();
    assert.equal(await page.locator('#coledit-name').inputValue(), 'label');
    await page.locator('#coledit-name').fill('descrizione'); await page.locator('#coledit-save').click();
    await page.waitForFunction(() => !document.querySelector('#coledit-overlay').dataset.arcDialog); await loaded();
    assert.equal(await page.evaluate(() => window.detailsFixture.sent.findLast(x => x.event === 'column:alter').payload.oldName), 'label');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Elimina label', exact: true }).click();
    assert.equal(await page.evaluate(() => window.detailsFixture.sent.filter(x => x.event === 'column:drop').length), 0);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Elimina label', exact: true }).click(); await loaded();
    assert.equal(await page.evaluate(() => window.detailsFixture.sent.findLast(x => x.event === 'column:drop').payload.coll), 'approles');
    await page.locator('#index-add-btn').click();
    await page.locator('#idxcreate-fields').fill('label:1'); await page.locator('#idxcreate-name').fill('indice_prova');
    await page.locator('#idxcreate-save').click();
    await page.waitForFunction(() => !document.querySelector('#idxcreate-overlay').dataset.arcDialog); await loaded();
    page.once('dialog', dialog => dialog.accept()); await page.locator('.idx-del').click(); await loaded();
    assert.equal(await page.evaluate(() => window.detailsFixture.sent.findLast(x => x.event === 'index:drop').payload.name), 'key_1');
    ok('Creazione, modifica, eliminazione e annullamento: campo e indice mantengono bersaglio e controlli');

    for (const engine of ['mysql', 'postgresql']) {
      await page.evaluate(async engine => {
        const { state } = await import('/js/state.js'); state.dbType = engine;
        window.detailsFixture.data.fields = [{ name: 'id', types: ['bigint'], nullable: false, autoIncrement: true, primaryKey: true },
          { name: 'descrizione', types: ['varchar(255)'], nullable: true, default: 'prova' }];
      }, engine); await reload();
      assert.equal(await page.locator('#schema-title').textContent(), 'Colonne');
      assert.equal(await page.locator('#schema-table .details-presence').count(), 0);
      assert.equal(await page.locator('#schema-table tbody tr').first().locator('.details-nullable').textContent(), 'Non consentiti');
      await page.getByRole('button', { name: 'Modifica id', exact: true }).click();
      assert.equal(await page.locator('#coledit-type').inputValue(), 'bigint');
      await page.locator('#coledit-save').click();
      await page.waitForFunction(() => !document.querySelector('#coledit-overlay').dataset.arcDialog); await loaded();
      if (engine === 'mysql') assert.equal(await page.evaluate(() => window.detailsFixture.sent.findLast(x => x.event === 'column:alter').payload.column.autoIncrement), true);
    }
    ok('MySQL/PostgreSQL: tipi, NULL, modifica e AUTO_INCREMENT preservati');

    await page.evaluate(() => { window.detailsFixture.fail = true; }); await reload();
    assert(await page.locator('#details-feedback').isVisible());
    assert(await page.locator('#details-content').isHidden());
    await page.evaluate(() => { window.detailsFixture.fail = false; }); await page.locator('#details-retry').click(); await loaded();
    await page.evaluate(async () => {
      const f = window.detailsFixture; f.hold = true; f.data.fields = [{ name: 'risposta_obsoleta', types: ['int'], nullable: false }];
      (await import('/js/details.js')).loadDetails();
    });
    assert(await page.locator('#details-content').isHidden(), 'Durante il caricamento non si possono modificare metadati vecchi');
    await page.evaluate(async () => {
      const f = window.detailsFixture; f.data.fields = [{ name: 'risposta_recente', types: ['int'], nullable: false }];
      (await import('/js/details.js')).loadDetails(); f.pending.pop()();
    }); await loaded();
    await page.evaluate(() => { window.detailsFixture.pending.shift()(); window.detailsFixture.hold = false; });
    assert.equal(await page.locator('.details-field-name').textContent(), 'risposta_recente');
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js'); state.dbType = 'mongodb';
      window.detailsFixture.data = { ok: true, stats: {}, fields: [], indexes: [], sampled: 0 };
    }); await reload();
    assert.equal(await page.locator('.details-empty').count(), 2);
    assert.equal(await page.locator('#stats-table tr').first().locator('td').last().textContent(), '—');
    ok('Caricamento, errore/riprova, risposta superata, vuoto e dati sconosciuti');

    await page.evaluate(() => { window.detailsFixture.data = structuredClone(window.detailsFixture.mongo); }); await reload();
    await page.waitForTimeout(4000);
    for (const [width, height, theme] of [[1440, 1000, 'dark'], [1440, 1000, 'light'], [1024, 900, 'dark'], [390, 844, 'dark'], [320, 740, 'light'], [844, 390, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.querySelector('#view-details').scrollTop = 0; }, theme);
      await page.waitForTimeout(200);
      const metrics = await page.locator('#view-details').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, root: document.documentElement.scrollWidth }));
      assert(metrics.scroll <= metrics.client + 1 && metrics.root <= width + 1, `Nessun overflow orizzontale: ${width}`);
      report.layouts.push({ width, height, theme, ...metrics });
      if (!checksOnly) await page.screenshot({ path: `${dir}/details-${theme}-${width}.png` });
      if (width <= 900) {
        for (const control of await page.locator('#view-details button').all()) if (await control.isVisible()) assert((await control.boundingBox()).height >= 44, 'Azioni touch di almeno 44px');
        await page.locator('#index-add-btn').scrollIntoViewIfNeeded();
        if (!checksOnly) await page.screenshot({ path: `${dir}/indexes-${theme}-${width}.png` });
        await page.locator('#index-add-btn').click(); await page.waitForSelector('#idxcreate-overlay[data-arc-dialog="open"]');
        assert(await page.locator('#idxcreate-overlay .arc-dialog-sheet').isVisible());
        await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#idxcreate-overlay').dataset.arcDialog);
      }
    }
    await page.evaluate(() => {
      const f = window.detailsFixture; f.data.fields.push({ name: '<img src=x>', types: ['<script>'], presence: null },
        { name: 'nome_molto_lungo_che_deve_andare_a_capo_senza_spostare_le_azioni_fuori_dallo_schermo', types: ['un_tipo_molto_lungo_che_deve_andare_a_capo'], presence: 17 });
      f.data.indexes.push({ name: 'indice_con_nome_lungo_non_troncato', key: { 'campo.con.un.nome.molto.lungo': -1, testo: 'text' }, unique: false });
    }); await page.setViewportSize({ width: 320, height: 740 }); await reload();
    assert.equal(await page.locator('#view-details img, #view-details script').count(), 0);
    assert(await page.locator('#view-details').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.locator('#schema-table tbody tr').last().scrollIntoViewIfNeeded();
    if (!checksOnly) await page.screenshot({ path: `${dir}/extreme-320.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // L'emulazione CDP ritorna prima del frame che notifica i MediaQueryList già creati.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await reload();
    report.reducedMotion = await page.locator('#view-details').evaluate(el => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, animations: el.getAnimations({ subtree: true }).map(a => ({ target: a.effect.target.outerHTML.slice(0, 200), frames: a.effect.getKeyframes(), state: a.playState })) }));
    assert.equal(await page.locator('#view-details').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    assert.deepEqual(report.errors, []);
    ok('Desktop/mobile, chiaro/scuro, landscape, nomi lunghi, escaping, drawer Arc e movimento ridotto');
  } catch (error) { report.failure = error.stack; throw error; }
  finally { fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
