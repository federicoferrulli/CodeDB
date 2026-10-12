'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const screenshots = !process.argv.includes('--checks-only');
const dir = `test-reports/navigatore-2026-10-12/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3205 });
  const browser = await chromium.launch();
  const report = { checks: [], motion: [], errors: [] };
  const check = text => { report.checks.push(text); console.log('OK', text); };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => report.errors.push(error.message));
    if (mutant) await page.route('**/js/navigator-motion.js', async route => {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes('if (!ridotto.matches)'));
      await route.fulfill({ response, body: source.replace('if (!ridotto.matches)', 'if (false)') });
    });
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true,
    })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const t = await import('/js/tabs.js'), c = await import('/js/colltabs.js');
      const bar = await import('/js/tabbar.js'), workspace = await import('/js/workspace.js');
      const conns = await import('/js/connmanager.js');
      const connections = [
        { name: 'mongodb', label: 'localhost:27017', dbType: 'mongodb', folder: 'Locale' },
        { name: 'mysql-locale', label: 'localhost:3306', dbType: 'mysql', folder: 'Locale' },
        { name: 'Postgresql', label: 'localhost:5432', dbType: 'postgresql', folder: 'Locale' },
        { name: 'Archivio produzione Europa', label: 'db.archivio.example:5432', dbType: 'postgresql', folder: 'Remoti' },
      ];
      const collections = ['rilevazioni', 'stazioni', 'archivio_meteorologico_storico'].map((name, i) => ({ name, count: 2400 + i }));
      const databases = [{ name: 'meteo_db', collections }, ...['admin', 'config', 'dropchecker', 'local', 'openData', 'gui_mongodb_backup_restore', 'meteo_storico', 'archivio_test'].map(name => ({ name }))];
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(name, msg, cb) {
        cb?.({ ok: true, connections, databases, collections, docs: [{ id: 1, stazione: 'Roma', temperatura: 21 }],
          data: [], skip: 0, limit: 50, total: 1, columns: ['id', 'stazione', 'temperatura'], fields: [], indexes: [] });
      } });
      for (const conn of connections.slice(0, 3)) {
        const tab = t.createTab({ id: conn.dbType, connName: conn.name }); tab.dbType = conn.dbType;
        Object.assign(tab.state, { connected: true, connLabel: conn.label, dbType: conn.dbType, databases });
        t.tabs.activeId = tab.id; bar.renderTabBar(); workspace.renderWorkspace();
        c.openCollTab('meteo_db', 'rilevazioni');
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      t.switchTab('mongodb'); conns.loadSavedConnections();
      window.navFixture = { t, c, bar, workspace, conns };
      (await import('/js/theme.js')).scegliTema('dark');
    });
    await page.waitForSelector('#conn-tree .conn-item.selected, #conn-tree .node-label.selected');
    const settle = () => page.waitForTimeout(320);
    await settle();
    const allinea = async selector => {
      const delta = await page.locator(selector).evaluate(tree => {
        const a = tree.querySelector('.node-label.selected').getBoundingClientRect();
        const b = tree.querySelector('.navigator-selection').getBoundingClientRect();
        return [Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)];
      });
      assert(delta.every(n => n < 1.1), `${selector}: selezione allineata (${delta})`);
    };
    const sample = await page.evaluate(() => {
      const tree = document.getElementById('conn-tree');
      const before = tree.querySelector('.navigator-selection').getBoundingClientRect().top;
      tree.querySelector('[data-conn-name="Postgresql"] .node-label').click();
      const indicator = tree.querySelector('.navigator-selection'), a = indicator.getAnimations()[0];
      if (!a) return { animated: false };
      a.pause(); a.currentTime = 0;
      const start = indicator.getBoundingClientRect().top;
      a.currentTime = 70; const middle = indicator.getBoundingClientRect().top;
      a.currentTime = 260; const end = indicator.getBoundingClientRect().top;
      const keys = a.effect.getKeyframes().flatMap(Object.keys);
      a.cancel();
      return { animated: true, before, start, middle, end, keys, active: window.navFixture.t.tabs.activeId };
    });
    report.motion.push(sample);
    assert(sample.animated, 'Il cambio connessione anima la selezione verticale');
    assert.equal(sample.active, 'postgresql');
    assert(Math.abs(sample.before - sample.start) < 1.1);
    assert(sample.middle > sample.start && sample.middle < sample.end);
    assert(sample.keys.every(k => ['offset', 'computedOffset', 'easing', 'composite', 'transform', 'opacity'].includes(k)));
    await settle(); await allinea('#conn-tree'); await allinea('#db-tree');
    assert.equal(await page.locator('#explorer-title').innerText(), 'Schemi');
    check('Cambio connessione immediato, indicatore continuo e contesto coerente');

    const rapid = await page.evaluate(() => {
      const tree = document.getElementById('conn-tree');
      tree.querySelector('[data-conn-name="mongodb"] .node-label').click();
      const a = tree.querySelector('.navigator-selection').getAnimations()[0];
      a.pause(); a.currentTime = 60;
      const before = tree.querySelector('.navigator-selection').getBoundingClientRect().top;
      tree.querySelector('[data-conn-name="mysql-locale"] .node-label').click();
      const b = tree.querySelector('.navigator-selection').getAnimations()[0];
      b.pause(); b.currentTime = 0;
      const after = tree.querySelector('.navigator-selection').getBoundingClientRect().top;
      b.play(); return { before, after };
    });
    assert(Math.abs(rapid.before - rapid.after) < 1.1, 'Il cambio rapido riparte dal fotogramma corrente');
    await settle(); await allinea('#conn-tree');
    await page.locator('#conn-tree [data-conn-name="mongodb"] .node-label').press('Enter');
    await page.locator('#db-tree [data-coll="stazioni"]').press('Enter');
    await settle(); await allinea('#conn-tree'); await allinea('#db-tree');
    assert.equal(await page.locator('#db-tree [aria-current="true"]').getAttribute('data-coll'), 'stazioni');
    const nodes = await page.locator('#conn-tree .conn-item').count();
    await page.locator('#conn-search').fill('Postgres');
    assert.equal(await page.locator('#conn-tree .conn-item').count(), 2);
    await page.locator('#conn-search').fill('inesistente');
    assert(await page.locator('#conn-empty').isVisible());
    await page.locator('#conn-search').fill('');
    assert.equal(await page.locator('#conn-tree .conn-item').count(), nodes);
    await settle(); await allinea('#conn-tree');
    await page.locator('#conn-tree [data-conn-name="mongodb"] .node-actions').click();
    await page.locator('#context-menu').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    const folder = page.locator('#conn-tree .folder-label').first();
    await folder.click();
    assert.equal(await page.locator('#conn-tree .navigator-selection').count(), 0, 'La selezione non resta sospesa sopra una cartella chiusa');
    await page.locator('#conn-tree .folder-label').first().click();
    await settle(); await allinea('#conn-tree');
    const db = page.locator('#db-tree .db > [data-db="meteo_db"]');
    await db.click();
    assert.equal(await page.locator('#db-tree .navigator-selection').count(), 0);
    await db.click(); await settle(); await allinea('#db-tree');
    await page.locator('#menu-conns-btn').click();
    assert(await page.locator('#navigator').evaluate(el => el.inert));
    await page.locator('#menu-conns-btn').click();
    await settle(); await allinea('#conn-tree'); await allinea('#db-tree');
    check('Interruzioni, tastiera, ricerca, stato vuoto e menu azioni');

    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      const { t } = window.navFixture;
      for (let i = 0; i < 18; i++) t.switchTab(['mongodb', 'mysql', 'postgresql'][i % 3]);
    });
    await settle(); await allinea('#conn-tree'); await allinea('#db-tree');
    assert.equal(await page.locator('#conn-tree, #db-tree').evaluateAll(trees => trees.flatMap(t => t.getAnimations({ subtree: true })).length), 0);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#conn-tree [data-conn-name="mongodb"] .node-label').click();
    assert.equal(await page.locator('#conn-tree, #db-tree').evaluateAll(trees => trees.flatMap(t => t.getAnimations({ subtree: true })).length), 0);
    await allinea('#conn-tree');
    check('Cambi ripetuti con CPU rallentata e preferenza movimento ridotto');

    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 960 });
      for (const theme of ['dark', 'light']) {
        await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
        await settle(); await allinea('#conn-tree'); await allinea('#db-tree');
        const overflow = await page.locator('#conn-tree, #db-tree').evaluateAll(trees => trees.some(t => t.scrollWidth > t.clientWidth));
        assert(!overflow, 'Gli alberi non debordano orizzontalmente');
        if (screenshots) await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-nav-conns').click();
    await page.locator('.arc-navigation-sheet').waitFor(); await settle();
    assert(await page.locator('#conn-tree').isVisible());
    await allinea('#conn-tree');
    const touch = await page.locator('#conn-tree .conn-item .node-actions').evaluateAll(els => els.every(e => e.getBoundingClientRect().height >= 44));
    assert(touch, 'Le azioni rimangono raggiungibili al tocco');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await settle();
      if (screenshots) await page.screenshot({ path: `${dir}/connessioni-mobile-${theme}.png` });
    }
    await page.locator('#conn-tree [data-conn-name="Postgresql"] .node-label').click();
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    await page.locator('#mobile-nav-dbs').click();
    await page.locator('.arc-navigation-sheet').waitFor(); await settle();
    await allinea('#db-tree');
    if (screenshots) await page.screenshot({ path: `${dir}/database-mobile.png` });
    await page.setViewportSize({ width: 320, height: 740 }); await settle();
    await allinea('#db-tree');
    assert(await page.locator('#db-tree').evaluate(el => el.scrollWidth <= el.clientWidth));
    if (screenshots) await page.screenshot({ path: `${dir}/database-mobile-320.png` });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 960 }); await settle();
    await allinea('#conn-tree'); await allinea('#db-tree');
    check('Temi chiaro/scuro, desktop, drawer mobile e ritorno senza perdere la selezione');
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
