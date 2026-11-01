'use strict';

// Electron e UI reali, query simulata e profilo usa e getta.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-chiusura-'));
  const entry = path.join(profile, 'avvio.cjs');
  fs.writeFileSync(path.join(profile, 'connections.ini'), '');
  fs.writeFileSync(entry, `require(${JSON.stringify(path.resolve(__dirname, '../electron-main.js'))});`);
  const env = { ...process.env, PORT: '0', CODEDB_NO_UPDATE_CHECK: '1', CODEDB_RBAC: 'off',
    CODEDB_ELECTRON_USER_DATA_DIR: profile, GUI_MONGO_PASSPHRASE: '',
    CODEDB_CONNECTIONS_FILE: path.join(profile, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(profile, 'conns'),
    CODEDB_BACKUPS_DIR: path.join(profile, 'backups'), CODEDB_UI_AUDIT_FILE: path.join(profile, 'ui.log'),
    CODEDB_MCP_AUDIT_FILE: path.join(profile, 'mcp.log'), CODEDB_SCRIPT_RESULTS_DIR: path.join(profile, 'results') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ args: require('./electron-harness').argomentiElectron([entry, '--headless']), env, timeout: 30000 });
    const processoTerminato = new Promise(resolve => app.process().once('exit', (code, signal) => resolve({ code, signal })));
    const page = await app.firstWindow();
    page.on('dialog', () => {}); // La conferma Electron è gestita nel processo principale.
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const [{ createTab, tabs }, { impostaSocket }, bar, workspace, coll, main] = await Promise.all(
        ['tabs', 'socket', 'tabbar', 'workspace', 'colltabs', 'main'].map(n => import(`/js/${n}.js`)));
      const fake = { connected: true, on() {}, off() {}, emit(name, payload, cb) {
        cb?.({ ok: true, docs: [{ n: 1 }], columns: ['n'], total: 1, collections: [{ name: 'prova' }], fields: [], indexes: [] });
      } };
      impostaSocket(fake);
      const tab = createTab({ id: 'chiusura' }); tabs.activeId = tab.id; tab.dbType = 'mysql'; tab.label = 'Collaudo';
      Object.assign(tab.state, { connected: true, dbType: 'mysql', databases: [{ name: 'fixture' }] });
      bar.renderTabBar(); workspace.renderWorkspace(); coll.openCollTab('fixture', 'prova'); main.setView('query');
      const input = document.getElementById('query-editor-input');
      input.value = 'SELECT 1 AS n'; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('query-run-btn').click();
    });
    await page.waitForSelector('#view-query[data-query-state="success"]');
    const veto = await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
    assert(veto, 'La query non salvata attiva la protezione reale della UI');
    const bloccato = process.argv.includes('--blocked-renderer');
    if (bloccato) {
      await page.evaluate(() => setTimeout(() => { while (true) { /* Renderer intenzionalmente bloccato. */ } }, 0));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (process.argv.includes('--mutant')) await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.removeAllListeners('will-prevent-unload');
    });
    await app.evaluate(({ dialog, BrowserWindow, app }, quit) => {
      globalThis.confermeChiusura = [];
      dialog.showMessageBoxSync = (_window, options) => { globalThis.confermeChiusura.push(options); return 0; };
      dialog.showMessageBox = async (_window, options) => { globalThis.confermeChiusura.push(options); return { response: 0 }; };
      if (quit) app.quit();
      else BrowserWindow.getAllWindows()[0].close();
    }, process.argv.includes('--quit'));
    await new Promise(resolve => setTimeout(resolve, 250));
    if (bloccato) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && !await app.evaluate(() => globalThis.confermeChiusura.length)) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const stato = await app.evaluate(({ BrowserWindow }) => ({
      conferme: globalThis.confermeChiusura, finestre: BrowserWindow.getAllWindows().length,
    }));
    assert.equal(stato.conferme.length, 1, 'La chiusura deve offrire una conferma, senza restare bloccata in silenzio');
    assert.equal(stato.finestre, 1, 'Restare conserva la finestra e la query');
    if (bloccato) assert.deepEqual(stato.conferme[0].buttons, ['Attendi', 'Forza chiusura']);
    if (!bloccato) assert.equal(await page.locator('#query-editor-input').inputValue(), 'SELECT 1 AS n');
    const chiusa = page.waitForEvent('close', { timeout: bloccato ? 15000 : 3000 });
    await app.evaluate(({ dialog, BrowserWindow, app }, quit) => {
      dialog.showMessageBoxSync = () => 1;
      dialog.showMessageBox = async () => ({ response: 1 });
      setImmediate(() => quit ? app.quit() : BrowserWindow.getAllWindows()[0].close());
    }, process.argv.includes('--quit'));
    await chiusa;
    let timer;
    const esito = await Promise.race([processoTerminato, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('La finestra è chiusa, ma il processo Electron resta attivo')), 5000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(esito.code, 0, 'Il processo termina regolarmente');
    console.log(`OK Electron (${process.argv.includes('--quit') ? 'menu Esci' : 'chiusura finestra'}, renderer ${bloccato ? 'bloccato' : 'reattivo'}): conferma, resta, esci e termine del processo`);
  } finally {
    if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {});
    if (app) await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
