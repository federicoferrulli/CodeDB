'use strict';

// Tocco reale nel drawer e moduli reali; le scritture restano nel trasporto di prova.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/mobile-crea-database';
const mutant = !!process.env.CREATE_DB_MUTANT;

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const server = await startTestServer({ port: 3199 });
  const browser = await chromium.launch();
  try {
    for (const [width, height, dbType] of (mutant ? [[390, 844, 'mongodb']] : [[390, 844, 'mongodb'], [320, 740, 'mysql'], [844, 390, 'postgresql'], [1440, 900, 'mysql']])) {
      const mobile = width <= 900;
      const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      const press = locator => mobile ? locator.tap() : locator.click();
      page.setDefaultTimeout(6000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
        await page.goto(server.url);
        await page.waitForSelector('html[data-arc-ready="true"]');
        await page.evaluate(async dbType => {
          const { createTab, tabs } = await import('/js/tabs.js');
          const tab = createTab({ id: 'crea-mobile' }); tabs.activeId = tab.id;
          tab.label = 'Connessione di prova'; tab.dbType = dbType;
          Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: tab.dbType, databases: [] });
          window.creaDbFixture = { writes: [], databases: [] };
          const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(event, payload, ack) {
            const fixture = window.creaDbFixture;
            if (event === 'db:create') {
              if (fixture.errorNext) { fixture.errorNext = false; ack({ ok: false, error: 'Permesso di creazione non disponibile' }); return; }
              fixture.writes.push(payload);
              fixture.databases.push({ name: payload.db, collections: [{ name: payload.coll, count: 0 }] });
            }
            ack?.({ ok: true, databases: fixture.databases, collections: [], docs: [], fields: [], total: 0 });
          } };
          (await import('/js/socket.js')).impostaSocket(fake);
          (await import('/js/tabbar.js')).renderTabBar();
          (await import('/js/workspace.js')).renderWorkspace();
        }, dbType);
        if (mobile) await press(page.locator('#mobile-nav-dbs'));
        if (mutant) await page.addStyleTag({ content: '.arc-navigation-slot .sidebar-title { z-index: auto !important; }' });
        const create = page.locator('#new-db-btn');
        assert(await create.evaluate(el => {
          const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
        }), 'Il + del drawer Database deve ricevere il tocco senza essere coperto dalla ricerca');
        await press(create);
        await page.locator('#dbcreate-overlay [role="dialog"]').waitFor();
        await page.locator('#dbcreate-name').fill('da_annullare');
        await press(page.locator('#dbcreate-cancel'));
        await page.waitForFunction(() => !document.getElementById('dbcreate-overlay').dataset.arcDialog);
        assert.equal(await page.evaluate(() => window.creaDbFixture.writes.length), 0, 'Annullare non crea un database');
        await press(create);
        await press(page.locator('#dbcreate-name'));
        assert(await page.locator('#dbcreate-name').evaluate(el => document.activeElement === el), 'Il nome del database deve ricevere il focus dopo il tocco');
        assert.equal(await page.locator('#dbcreate-name').inputValue(), '', 'Riaprire pulisce il modulo annullato');
        await page.locator('#dbcreate-name').fill('archivio_mobile');
        await page.locator('#dbcreate-coll').fill('eventi');
        await page.screenshot({ path: `${dir}/modulo-${width}-${dbType}.png` });
        await page.evaluate(() => { window.creaDbFixture.errorNext = true; });
        await press(page.locator('#dbcreate-save'));
        await page.locator('#dbcreate-error').waitFor();
        assert.match(await page.locator('#dbcreate-error').innerText(), /Permesso di creazione/);
        assert.equal(await page.locator('#dbcreate-name').inputValue(), 'archivio_mobile', 'Un errore conserva il nome per riprovare');
        assert.equal(await page.locator('#dbcreate-coll').inputValue(), 'eventi');
        await press(page.locator('#dbcreate-save'));
        await page.waitForFunction(() => window.creaDbFixture.writes.length === 1);
        assert.deepEqual(await page.evaluate(() => window.creaDbFixture.writes.map(({ tabId, db, coll }) => ({ tabId, db, coll }))), [{ tabId: 'crea-mobile', db: 'archivio_mobile', coll: 'eventi' }]);
        await page.waitForFunction(() => document.getElementById('dbcreate-overlay').classList.contains('hidden'));
        await page.waitForFunction(() => !document.getElementById('dbcreate-overlay').dataset.arcDialog);
        if (mobile && await page.locator('#mobile-nav-dbs').getAttribute('aria-expanded') !== 'true') await press(page.locator('#mobile-nav-dbs'));
        await page.locator('#db-tree .db > [data-db="archivio_mobile"]').waitFor();
        if (mobile) await press(page.locator('#mobile-nav-conns'));
        await press(page.locator('#conn-add-btn'));
        await page.locator('#connect-overlay [role="dialog"]').waitFor();
        await press(page.locator('#conn-cancel-btn'));
        await page.waitForFunction(() => !document.getElementById('connect-overlay').dataset.arcDialog);
        assert.deepEqual(errors, []);
        console.log(`OK ${width}×${height} ${dbType}: + Database e Connessioni, annullamento, errore/riprova, creazione e albero aggiornato`);
      } catch (error) {
        await page.screenshot({ path: `${dir}/${mutant ? 'mutante' : 'errore'}-${width}-${dbType}.png` });
        console.error(await page.evaluate(() => ({ active: document.activeElement?.id, dialog: document.getElementById('dbcreate-overlay').className, navigation: !!document.querySelector('.arc-navigation-sheet') })));
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
