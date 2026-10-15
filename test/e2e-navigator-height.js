'use strict';

// Clic e ridimensionamento reali; solo le risposte dei database sono simulate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports'}/navigator-height${mutant ? '-mutante' : ''}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3247 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1060 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (mutant) await page.route('**/js/workspace.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const condition = 'navigator.dataset.connectionTab !== navigatorTab';
      assert(source.includes(condition), 'Il mutante deve rimuovere il riallineamento al cambio connessione');
      await route.fulfill({ response, body: source.replace(condition, 'false') });
    });
    await page.addInitScript(versione => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true }));
      localStorage.setItem('codedb:navigator-connections-height', '460');
      localStorage.setItem('gui-db:navigator-connections-height', '480');
      localStorage.setItem('codedb:tema', 'dark');
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const connections = [
        { name: 'mongodb', label: 'localhost:27017', dbType: 'mongodb', folder: 'locale' },
        { name: 'mysql-locale', label: 'localhost:3306', dbType: 'mysql', folder: 'locale' },
        { name: 'Postgresql', label: 'localhost:5432', dbType: 'postgresql', folder: 'locale' },
      ];
      const fake = { connected: true, on() {}, off() {}, emit(name, payload, ack) {
        const conn = connections.find(c => c.name === payload.saved) || connections[0];
        ack?.({ ok: true, connections, dbType: conn.dbType, label: conn.name,
          databases: [{ name: 'archivio', collections: [{ name: 'clienti' }] }],
          collections: [{ name: 'clienti' }], fields: [], indexes: [], docs: [] });
      } };
      (await import('/js/socket.js')).impostaSocket(fake);
      (await import('/js/connmanager.js')).loadSavedConnections();
    });
    await page.waitForSelector('#conn-tree [data-conn-name="Postgresql"]');
    const measure = () => page.evaluate(() => {
      const rect = id => document.getElementById(id).getBoundingClientRect();
      const last = document.querySelector('#conn-tree [data-conn-name="Postgresql"] .node-label').getBoundingClientRect();
      return { gap: rect('navigator-divider').top - last.bottom, height: rect('conn-sidebar').height,
        dbTop: rect('sidebar').top, dividerBottom: rect('navigator-divider').bottom,
        navHeight: rect('navigator').height,
        manual: document.getElementById('navigator').style.getPropertyValue('--connections-height') };
    });
    const aligned = async label => {
      const m = await measure();
      assert(m.gap >= 0 && m.gap <= 14, `${label}: Database deve iniziare sotto PostgreSQL, geometria ${JSON.stringify(m)}`);
      assert(Math.abs(m.dbTop - m.dividerBottom) < 1);
      console.log(`OK ${label}: spazio finale ${m.gap.toFixed(1)} px`);
      return m.height;
    };
    const open = async name => {
      await page.locator(`#conn-tree [data-conn-name="${name}"] .node-label`).click();
      await page.waitForFunction(name => document.querySelector('#explorer-context').textContent.includes(name), name);
    };
    const divider = page.locator('#navigator-divider');
    const drag = async delta => {
      const r = await divider.boundingBox();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + delta, { steps: 8 });
      await page.mouse.up();
    };

    await open('mongodb');
    const initial = await aligned('Prima apertura con una vecchia altezza salvata');
    await drag(120);
    assert(Math.abs((await measure()).height - initial - 120) < 1, 'La maniglia può scendere oltre la fine della lista');
    await page.evaluate(async () => (await import('/js/workspace.js')).renderWorkspace());
    assert(Math.abs((await measure()).height - initial - 120) < 1, 'Un aggiornamento della stessa connessione conserva il trascinamento');
    await drag(-180);
    assert(Math.abs((await measure()).height - initial + 60) < 1, 'La maniglia può salire e accorciare la lista');
    await divider.press('Home');
    assert.equal((await measure()).height, 100);
    await divider.press('End');
    const maximum = await measure();
    assert(Math.abs(maximum.height - (maximum.navHeight - 100)) < 1, 'L’altezza naturale non limita la corsa manuale');
    console.log('OK trascinamento in entrambe le direzioni, aggiornamento del workspace ed estremi da tastiera');

    await open('mysql-locale');
    await aligned('Apertura di un’altra connessione dopo il trascinamento');
    await drag(80);
    await open('mongodb');
    await aligned('Ritorno a una connessione già aperta');
    await drag(70);
    await page.evaluate(async () => (await import('/js/tabs.js')).closeAllTabs());
    await open('Postgresql');
    await aligned('Riapertura dopo la chiusura di tutte le connessioni');
    await page.locator('#navigator').screenshot({ path: `${dir}/sidebar.png` });
    assert.deepEqual(errors, []);
    console.log('OK nessun errore JavaScript');
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
