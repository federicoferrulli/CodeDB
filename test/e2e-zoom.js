'use strict';
// Finestra Electron e server isolati: nessun accesso alle connessioni dell'utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron: electron } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const report = [];
const output = path.resolve('test-reports/zoom-2026-10-12');

(async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const server = await startTestServer({ port: 3214, env: { CODEDB_ELECTRON_INSTANCE_SECRET: secret } });
  let desktop;
  try {
    const entry = path.join(server.dir, 'zoom-electron.cjs');
    fs.writeFileSync(entry, `
      const { app } = require('electron');
      app.setPath('userData', ${JSON.stringify(path.join(server.dir, 'electron'))});
      app.on('browser-window-created', (_, win) => { win.show = () => win.showInactive(); win.webContents.setBackgroundThrottling(false); });
      require(${JSON.stringify(path.resolve('electron-main.js'))});
    `);
    const env = { ...process.env, PORT: String(server.port), CODEDB_ELECTRON_INSTANCE_SECRET: secret, CODEDB_NO_UPDATE_CHECK: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({ args: require('./electron-harness').argomentiElectron([entry]), env, timeout: 30000 });
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    if (process.argv.includes('--mutant-capture')) await page.addInitScript(() => {
      const add = window.addEventListener;
      window.addEventListener = function(type, listener, options) {
        if (type === 'wheel' && options?.capture && options?.passive) return;
        return add.call(this, type, listener, options);
      };
    });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
      localStorage.setItem('codedb:geo:tiles', 'off');
    }, require('../package.json').version);
    await page.reload();
    await page.waitForSelector('html[data-arc-ready="true"]');
    const win = await desktop.browserWindow(page);
    if (process.argv.includes('--mutant-keyboard')) await win.evaluate(w => w.webContents.removeAllListeners('before-input-event'));
    const factor = () => win.evaluate(w => w.webContents.getZoomFactor());
    const reset = async () => { await win.evaluate(w => w.webContents.setZoomLevel(0)); };
    const measure = async () => ({ factor: await factor(), width: await page.evaluate(() => innerWidth) });
    const key = (keyCode, modifiers = ['control']) => win.evaluate((w, input) => {
      w.webContents.sendInputEvent({ type: 'keyDown', ...input });
      w.webContents.sendInputEvent({ type: 'keyUp', ...input });
    }, { keyCode, modifiers });
    const checkZoom = async (action, direction, label) => {
      const before = await measure();
      await action();
      await page.waitForFunction(({ width, direction }) => direction > 0 ? innerWidth < width : innerWidth > width, { width: before.width, direction });
      await page.waitForTimeout(100);
      const after = await measure();
      console.log(label, before, after);
      assert(direction > 0 ? after.factor > before.factor : after.factor < before.factor, label);
      assert(direction > 0 ? after.width < before.width : after.width > before.width, `${label}: ridimensiona tutta la viewport`);
      report.push({ label, before, after });
    };
    await reset();
    await checkZoom(() => key('='), 1, 'Ctrl =');
    await checkZoom(() => key('+', ['control', 'shift']), 1, 'Ctrl +');
    await checkZoom(() => key('-'), -1, 'Ctrl -');
    await checkZoom(() => key('numadd'), 1, 'Ctrl tastierino +');
    await checkZoom(() => key('numsub'), -1, 'Ctrl tastierino -');
    await key('0');
    assert.equal(await factor(), 1, 'Ctrl 0 ripristina il 100%');
    if (process.argv.includes('--mutant-wheel')) await win.evaluate(w => w.webContents.removeAllListeners('zoom-changed'));
    const wheel = async (delta, target = page.locator('body'), modifiers = ['control']) => {
      const box = await target.boundingBox(), zoom = await factor();
      assert(box, 'Bersaglio della rotellina visibile');
      await win.evaluate((w, input) => w.webContents.sendInputEvent(input), {
        type: 'mouseWheel', x: Math.round((box.x + box.width / 2) * zoom), y: Math.round((box.y + box.height / 2) * zoom),
        deltaY: -Math.sign(delta), deltaX: 0, wheelTicksY: -Math.sign(delta), wheelTicksX: 0, modifiers,
      });
    };
    await checkZoom(() => wheel(-120), 1, 'Ctrl rotellina su');
    await checkZoom(() => wheel(120), -1, 'Ctrl rotellina giù');

    // La mappa Leaflet reale deve conservare il proprio zoom con Ctrl premuto.
    await reset();
    await page.evaluate(async () => {
      const L = await (await import('/js/geo-leaflet.js')).caricaLeaflet();
      const create = L.map;
      L.map = (...args) => (window.zoomMap = create(...args));
      await (await import('/js/geomap.js')).openGeoEditor({ value: { type: 'Point', coordinates: [12.49, 41.9] } });
    });
    const map = page.locator('#geomap-canvas');
    await map.waitFor();
    await page.waitForTimeout(400);
    const mapZoom = await page.evaluate(() => window.zoomMap.getZoom());
    await checkZoom(() => wheel(-120, map), 1, 'Ctrl rotellina sopra Leaflet');
    assert.equal(await page.evaluate(() => window.zoomMap.getZoom()), mapZoom, 'Ctrl non deve ingrandire anche la mappa');
    const json = page.locator('#geomap-json'), content = await json.inputValue();
    await json.focus();
    await checkZoom(() => key('-'), -1, 'Ctrl - dentro editor JSON della dialog');
    assert.equal(await json.inputValue(), content, 'Il contenuto della geometria rimane intatto');
    await reset();
    await wheel(-120, map, []);
    await page.waitForFunction(before => window.zoomMap.getZoom() > before, mapZoom);
    assert.equal(await factor(), 1, 'Rotellina semplice lascia invariata la scala dell’app');
    await page.locator('#geomap-cancel').click();

    // Due runtime completi, come nella split view, con dati simulati.
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const databases = [{ name: 'archivio', collections: [{ name: 'ordini' }] }];
      const socket = { connected: true, on() {}, off() {}, timeout() { return { emit: (event, p, ack) => socket.emit(event, p, res => ack(null, res)) }; },
        emit(event, p = {}, ack) { ack?.({ ok: true, databases, collections: databases[0].collections,
          docs: [{ id: 1, nome: p.tabId }], columns: ['id', 'nome'], total: 1, skip: 0, limit: 50, data: [], indexes: [], fields: [], stats: { count: 1 } }); } };
      impostaSocket(socket);
      for (const id of ['mongo-zoom', 'pg-zoom']) {
        const tab = createTab({ id }); tab.label = id; tab.dbType = id.startsWith('pg') ? 'postgresql' : 'mongodb';
        Object.assign(tab.state, { connected: true, connLabel: id, dbType: tab.dbType, databases });
      }
      tabs.activeId = 'mongo-zoom';
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('archivio', 'ordini');
      await (await import('/js/splitview.js')).addOrSplitPane(null, 'right', { tabId: 'pg-zoom', db: 'archivio', coll: 'ordini' });
      window.zoomArea = tabs.list[0].state.activeCollId;
    });
    await page.waitForFunction(() => document.querySelectorAll('.pane-runtime').length === 2 && [...document.querySelectorAll('.pane-runtime')].every(f => f.codedbPanel.ready));
    const frame = page.frames().find(f => f.parentFrame());
    const grid = frame.locator('#grid');
    await grid.locator('tbody td').first().waitFor();
    await checkZoom(() => wheel(-120, grid), 1, 'Ctrl rotellina dentro pannello affiancato');
    await frame.locator('#filter-input').fill('Testo da conservare');
    await checkZoom(() => key('-'), -1, 'Ctrl - con focus nel pannello affiancato');
    assert.equal(await frame.locator('#filter-input').inputValue(), 'Testo da conservare');
    const propagation = await frame.evaluate(() => {
      const input = document.querySelector('#filter-input');
      let handled = 0;
      const handler = event => { handled++; event.preventDefault(); };
      input.addEventListener('keydown', handler); input.addEventListener('wheel', handler, { passive: false });
      const zoom = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true });
      const wheel = new WheelEvent('wheel', { deltaY: -1, ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(zoom); input.dispatchEvent(wheel);
      const preserved = { handled, prevented: zoom.defaultPrevented || wheel.defaultPrevented };
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
      input.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
      input.removeEventListener('keydown', handler); input.removeEventListener('wheel', handler);
      return { ...preserved, ordinary: handled };
    });
    assert.deepEqual(propagation, { handled: 0, prevented: false, ordinary: 2 }, 'Nel browser lo zoom resta nativo; i gesti normali arrivano ai controlli');
    await frame.evaluate(async () => (await import('/js/main.js')).setView('query'));
    const editor = frame.locator('#query-editor-input');
    await editor.fill('SELECT * FROM ordini;');
    await checkZoom(() => key('='), 1, 'Ctrl + dentro editor query');
    assert.equal(await editor.inputValue(), 'SELECT * FROM ordini;');
    await frame.evaluate(async () => (await import('/js/main.js')).setView('data'));
    await key('0');
    await page.waitForTimeout(150);
    fs.mkdirSync(output, { recursive: true });
    const screenshot = async name => {
      const png = await win.evaluate(async w => (await w.webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
    };
    await screenshot('split-100.png');
    await checkZoom(() => key('='), 1, 'Zoom mantiene il layout affiancato');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'La pagina non trabocca con lo zoom');
    const framesFit = await page.evaluate(() => [...document.querySelectorAll('.pane-runtime')].every(f => {
      const r = f.getBoundingClientRect();
      return r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && Math.abs(f.contentWindow.innerWidth - r.width) < 2;
    }));
    assert(framesFit, 'I pannelli affiancati si adattano alla nuova viewport');
    await screenshot('split-110.png');
    await key('0');
    for (let i = 0; i < 8; i++) await key('=');
    await page.waitForFunction(() => innerWidth < 900);
    await key('0');
    await page.waitForFunction(() => innerWidth > 900);
    await page.evaluate(async () => (await import('/js/colltabs.js')).switchCollTab(window.zoomArea));
    await page.waitForFunction(() => innerWidth > 900 && [...document.querySelectorAll('.pane-runtime')].every(f => f.getBoundingClientRect().width > 0));
    assert.equal(await factor(), 1);
    assert.equal(await page.locator('.pane-runtime').count(), 2);
    assert.equal(await editor.inputValue(), 'SELECT * FROM ordini;', 'Lo zoom oltre il breakpoint mobile conserva la query');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks: report, propagation }, null, 2));
    console.log('OK zoom tastiera, tastierino e rotellina; Leaflet, dialog, editor e split view; contenuti conservati');
  } finally {
    if (desktop) await desktop.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
    }).catch(() => {});
    await desktop?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
