'use strict';

// Electron reale, server e profilo usa e getta; solo le risposte del DB sono simulate.
// Uso: node test/e2e-scorciatoie.js. --mutant verifica che il cambio scheda rotto faccia fallire il test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron: electron } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const server = await startTestServer({ port: Number(process.env.E2E_SCORCIATOIE_PORT) || 3227,
    env: { CODEDB_ELECTRON_INSTANCE_SECRET: secret } });
  let desktop;
  try {
    const entry = path.join(server.dir, 'scorciatoie-electron.cjs');
    fs.writeFileSync(entry, `
      const { app } = require('electron');
      app.setPath('userData', ${JSON.stringify(path.join(server.dir, 'electron'))});
      app.on('browser-window-created', (_, win) => { win.show = () => {}; win.webContents.setBackgroundThrottling(false); });
      require(${JSON.stringify(path.resolve(__dirname, '..', 'electron-main.js'))});
    `);
    const env = { ...process.env, PORT: String(server.port), CODEDB_ELECTRON_INSTANCE_SECRET: secret, CODEDB_NO_UPDATE_CHECK: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({ args: require('./electron-harness').argomentiElectron([entry]), env, timeout: 30000 });
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept().catch(() => {}));
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true })), require('../package.json').version);
    if (process.argv.includes('--mutant')) {
      // Toglie il dispatcher reale dalla sola pagina di prova, prima dell'inizializzazione.
      await page.addInitScript(() => {
        const originale = document.addEventListener;
        document.addEventListener = function (type, listener, options) {
          if (type === 'keydown' && String(listener).includes('GLOBALI.has(id)')) {
            window.dispatcherRimosso = true;
            return;
          }
          return originale.call(this, type, listener, options);
        };
      });
    }
    await page.reload();
    await page.waitForSelector('#documents-panel', { state: 'attached' });
    if (process.argv.includes('--mutant')) assert(await page.evaluate(() => window.dispatcherRimosso), 'La fixture deve rimuovere il dispatcher');

    const selezione = () => page.evaluate(async () => {
      const { tabs, activeTab } = await import('/js/tabs.js');
      return { db: tabs.activeId, tabella: activeTab()?.state.activeCollId || null };
    });
    const verifica = async (db, tabella) => assert.deepEqual(await selezione(), { db, tabella });
    const tasto = combo => page.keyboard.press(combo);
    await tasto('Control+Tab');
    await tasto('Control+Shift+Tab');
    await verifica(null, null);

    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const { impostaSocket } = await import('/js/socket.js');
      const databases = [{ name: 'archivio', collections: [{ name: 'ordini' }, { name: 'clienti' }, { name: 'prodotti' }] }];
      const socket = { connected: true, on() {}, off() {},
        timeout() { return { emit: (event, payload, ack) => socket.emit(event, payload, res => ack(null, res)) }; },
        emit(event, payload, ack) { ack?.({ ok: true, databases, collections: databases[0].collections,
          docs: [{ id: 1, nome: 'Prova' }], columns: ['id', 'nome'], total: 1, skip: 0, limit: 50,
          data: [], indexes: [], fields: [], stats: { count: 1 } }); } };
      impostaSocket(socket);
      window.creaConnessione = id => {
        const tab = createTab({ id, connName: id });
        Object.assign(tab.state, { connected: true, connLabel: id, databases });
        return tab;
      };
      window.creaConnessione('alfa');
      tabs.activeId = 'alfa';
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/workspace.js')).renderWorkspace();
      (await import('/js/colltabs.js')).openCollTab('archivio', 'ordini');
    });
    const prima = await selezione();
    await tasto('Control+Tab');
    await tasto('Control+Shift+Tab');
    assert.deepEqual(await selezione(), prima, 'Una sola scheda: nessun cambio');
    console.log('OK: zero o una scheda non cambiano il contesto');

    const schede = await page.evaluate(async () => {
      const { activeTab, createTab } = await import('/js/tabs.js');
      const { openCollTab, switchCollTab } = await import('/js/colltabs.js');
      openCollTab('archivio', 'clienti');
      openCollTab('archivio', 'prodotti');
      const lista = activeTab().state.collTabs;
      [lista[1], lista[2]] = [lista[2], lista[1]]; // ordine diverso da quello di apertura
      switchCollTab(lista[0].id);
      window.creaConnessione('beta');
      createTab({ id: 'non-connessa' });
      window.creaConnessione('gamma');
      (await import('/js/tabbar.js')).renderTabBar();
      (await import('/js/main.js')).setView('query');
      return lista.map(t => t.id);
    });
    const editor = page.locator('#query-editor-input');
    await editor.fill('SELECT 123 AS bozza');
    await tasto('Control+Tab');
    await verifica('alfa', schede[1]);
    await tasto('Control+Tab');
    await verifica('alfa', schede[2]);
    await tasto('Control+Tab');
    await verifica('alfa', schede[0]);
    assert.equal(await editor.inputValue(), 'SELECT 123 AS bozza', 'La query sopravvive al giro delle tabelle');
    await editor.fill('SELECT 456 AS altra_bozza');
    for (const db of ['beta', 'gamma', 'alfa']) {
      await tasto('Control+Shift+Tab');
      await verifica(db, db === 'alfa' ? schede[0] : null);
    }
    assert.equal(await editor.inputValue(), 'SELECT 456 AS altra_bozza', 'La query sopravvive al giro delle connessioni');
    console.log('OK: ordine visivo, ritorno alla prima, connessioni non aperte saltate e query conservate');

    await page.evaluate(async () => (await import('/js/scorciatoie-ui.js')).apriPannelloScorciatoie());
    await page.locator('#scorciatoie-overlay[data-arc-dialog="open"]').waitFor();
    await tasto('Control+Tab');
    await tasto('Control+Shift+Tab');
    await verifica('alfa', schede[0]);
    for (const [id, combo] of [['tabellaSuccessiva', 'Control+Tab'], ['databaseSuccessivo', 'Control+Shift+Tab'],
      ['tabellaSuccessiva', 'Control+Alt+j'], ['databaseSuccessivo', 'Control+Alt+k']]) {
      await page.locator(`[data-registra="${id}"]`).click();
      await tasto(combo);
      await verifica('alfa', schede[0]);
      assert.equal(await page.locator('.scorciatoie-riga.attiva').count(), 0, 'La combinazione viene registrata');
    }
    await page.locator('#scorciatoie-chiudi').click();
    await tasto('Control+Tab');
    await tasto('Control+Shift+Tab');
    await verifica('alfa', schede[0]);
    await tasto('Control+Alt+j');
    await verifica('alfa', schede[1]);
    await tasto('Control+Alt+k');
    await verifica('beta', null);
    console.log('OK: modale protetta, registrazione dei tasti predefiniti, rimappatura di entrambe e vecchi tasti inattivi');

    const split = await page.evaluate(async () => {
      const { tabs, switchTab } = await import('/js/tabs.js');
      switchTab('alfa');
      await (await import('/js/splitview.js')).addOrSplitPane(null, 'right', { tabId: 'alfa', db: 'archivio', coll: 'ordini' });
      return tabs.list[0].state.activeCollId;
    });
    await page.waitForFunction(() => document.querySelectorAll('.pane-runtime').length === 2
      && [...document.querySelectorAll('.pane-runtime')].every(f => f.codedbPanel.ready));
    const frame = page.frames().find(f => f.parentFrame());
    await frame.locator('#filter-input').focus();
    await tasto('Control+Alt+j');
    await verifica('alfa', schede[0]);
    await page.evaluate(async id => (await import('/js/colltabs.js')).switchCollTab(id), split);
    await frame.locator('#filter-input').focus();
    await tasto('Control+Alt+k');
    await verifica('beta', null);
    console.log('OK: entrambe le scorciatoie rimappate funzionano dai pannelli affiancati');

    // Le bozze sono già state verificate: il ricaricamento qui prova solo le preferenze.
    await page.evaluate(async () => {
      for (const t of (await import('/js/tabs.js')).tabs.list) {
        for (const c of t.state.collTabs) if (c.snapQuery) c.snapQuery.dirty = false;
      }
    });
    await page.reload();
    await page.waitForFunction(async () => (await import('/js/scorciatoie.js')).mappaAttiva().tabellaSuccessiva.tasto === 'j');
    assert.equal(await page.evaluate(async () => (await import('/js/scorciatoie.js')).etichettaCombo((await import('/js/scorciatoie.js')).mappaAttiva().databaseSuccessivo)), 'Ctrl+Alt+K');
    await page.evaluate(async () => (await import('/js/scorciatoie-ui.js')).apriPannelloScorciatoie());
    await page.locator('#scorciatoie-ripristina').click();
    await page.locator('#scorciatoie-chiudi').click();
    assert.deepEqual(await page.evaluate(async () => {
      const m = await import('/js/scorciatoie.js');
      return [m.etichettaCombo(m.mappaAttiva().tabellaSuccessiva), m.etichettaCombo(m.mappaAttiva().databaseSuccessivo)];
    }), ['Ctrl+Tab', 'Ctrl+Shift+Tab']);
    assert.deepEqual(errors, [], 'Nessun errore JavaScript');
    console.log('OK: preferenze conservate al ricaricamento e ripristino dei predefiniti');
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await desktop?.close();
    await server.stop();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
