'use strict';

// Regressione reale del ciclo di vita DOM/Arc: il menu contestuale aperto dalla
// griglia durante la chiusura del dialogo deve sopravvivere al riordino portal.
// Server e browser reali; i soli dati della griglia sono fixture in memoria.
// Il caso di controllo attende il termine della chiusura, il caso regressione
// esegue il clic utente appena la UI restituisce i pointer events alla griglia.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer } = require('../e2e-harness');

const reportDir = process.env.LAB_REPORT_DIR || path.resolve(__dirname, '../../.scratch/lab-reports');
const artifactDir = path.join(reportDir, 'dialog-menu');
fs.mkdirSync(artifactDir, { recursive: true });
const report = { suite: 'dialog-menu', startedAt: new Date().toISOString(), results: [] };
let server;
let browser;

async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(10000);
  await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({
    visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true,
  })), require('../../package.json').version);
  await page.goto(server.url);
  await page.waitForSelector('html[data-arc-ready="true"]');
  await page.evaluate(async () => {
    const { createTab, tabs } = await import('/js/tabs.js');
    const { state } = await import('/js/state.js');
    const { impostaSocket } = await import('/js/socket.js');
    const { renderGrid } = await import('/js/grid.js');
    const tab = createTab({ id: 'lab-dialog-menu', connName: null });
    tab.dbType = 'mongodb'; tabs.activeId = tab.id;
    Object.assign(state, { connected: true, dbType: 'mongodb', db: 'laboratorio_ui', coll: 'documenti',
      docs: [{ _id: 'lab-1', nome: 'Documento del laboratorio' }], columns: ['_id', 'nome'], total: 1, exhausted: true });
    // Nessuna scrittura viene eseguita: il dialogo è annullato. L'anteprima di
    // duplicazione serve soltanto a montare lo stesso pannello dinamico della UI.
    impostaSocket({ on() {}, off() {}, emit(event, payload, cb) {
      if (event === 'doc:duplicate') return cb?.({ ok: true, doc: JSON.stringify({ nome: 'Copia del laboratorio' }) });
      if (event === 'collection:find') return cb?.({ ok: true, docs: state.docs, columns: state.columns, total: 1 });
      cb?.({ ok: true });
    } });
    for (const id of ['tab-body', 'workspace', 'view-data']) document.getElementById(id)?.classList.remove('hidden');
    for (const id of ['welcome', 'placeholder']) document.getElementById(id)?.classList.add('hidden');
    renderGrid();
    window.labContext = { tabId: tab.id, db: state.db, coll: state.coll, dbType: 'mongodb', isStillActive: () => false, onSaveSuccess: () => renderGrid() };
  });
  return page;
}

async function openDialog(page, kind) {
  if (kind === 'edit') {
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      (await import('/js/inlineEdit.js')).openEditDoc(state.docs[0], window.labContext);
    });
    await page.waitForSelector('#editdoc-overlay[data-arc-dialog="open"]');
    return { overlay: 'editdoc-overlay', close: '#editdoc-cancel' };
  }
  await page.locator('#grid tbody td[data-c="1"]').click({ button: 'right' });
  await page.locator('#context-menu li').filter({ hasText: 'Duplica riga' }).click();
  await page.locator('#context-menu li').filter({ hasText: 'Duplica e modifica' }).click();
  await page.waitForSelector('#duprow-overlay[data-arc-dialog="open"]');
  return { overlay: 'duprow-overlay', close: '#duprow-cancel' };
}

async function scenario(kind, waitUntilClosed) {
  const id = `UI-MENU-${kind}-${waitUntilClosed ? 'CONTROLLO' : 'REGRESSIONE'}`;
  const started = Date.now();
  let page;
  let evidence;
  try {
    page = await fixture();
    const dialog = await openDialog(page, kind);
    // Osserviamo toggle/parent reali per distinguere una mancata apertura da
    // un popover aperto e poi chiuso dal riordino DOM del portal.
    await page.evaluate(() => {
      window.labMenuEvents = [];
      const menu = document.getElementById('context-menu');
      menu.addEventListener('toggle', event => window.labMenuEvents.push({
        oldState: event.oldState, newState: event.newState, time: performance.now(),
        overlay: menu.closest('.overlay')?.id || null,
      }));
    });
    await page.locator(dialog.close).click();
    await page.waitForSelector(`#${dialog.overlay}.hidden`, { state: 'attached' });
    if (waitUntilClosed) await page.waitForFunction(id => !document.getElementById(id).dataset.arcDialog, dialog.overlay);
    const transition = await page.locator(`#${dialog.overlay}`).getAttribute('data-arc-dialog');
    await page.locator('#grid tbody td[data-c="1"]').click({ button: 'right' });
    const opened = await page.evaluate(() => ({ popover: document.getElementById('context-menu').matches(':popover-open'),
      overlay: document.getElementById('context-menu').closest('.overlay')?.id || null }));
    await page.waitForFunction(id => !document.getElementById(id).dataset.arcDialog, dialog.overlay);
    const finished = await page.evaluate(() => {
      const menu = document.getElementById('context-menu');
      return { popover: menu.matches(':popover-open'), hidden: menu.classList.contains('hidden'),
        overlay: menu.closest('.overlay')?.id || null, events: window.labMenuEvents };
    });
    evidence = { kind, waitUntilClosed, transition, opened, finished };
    fs.writeFileSync(path.join(artifactDir, `${id}.json`), JSON.stringify(evidence, null, 2));
    assert.equal(opened.popover, true, 'Il clic deve avere aperto davvero il menu.');
    if (!waitUntilClosed) assert.equal(transition, 'closing', 'Il test deve intercettare la transizione reale, altrimenti non prova questa regressione.');
    assert.equal(finished.popover, true, `Il menu aperto dalla griglia scompare dopo la chiusura di ${dialog.overlay}: ${JSON.stringify(evidence)}`);
    await page.locator('#context-menu li').filter({ hasText: 'Duplica riga' }).click();
    await page.locator('#context-menu li').filter({ hasText: 'Duplica e modifica' }).waitFor({ state: 'visible' });
    report.results.push({ id, status: 'passed', durationMs: Date.now() - started, evidence });
    console.log(`PASS ${id}`);
  } catch (error) {
    report.results.push({ id, status: 'failed', durationMs: Date.now() - started, evidence, error: error.stack || String(error) });
    await page?.screenshot({ path: path.join(artifactDir, `${id}.png`), fullPage: true }).catch(() => {});
    console.error(`FAIL ${id}: ${error.stack || error}`);
    process.exitCode = 1;
  } finally { await page?.close(); }
}

(async () => {
  try {
    server = await startTestServer({ port: Number(process.env.LAB_DIALOG_MENU_PORT || 39368) });
    browser = await chromium.launch(process.env.LAB_BROWSER_CHANNEL ? { channel: process.env.LAB_BROWSER_CHANNEL } : {});
    for (const kind of ['edit', 'duplicate']) {
      await scenario(kind, true);
      await scenario(kind, false);
    }
  } catch (error) {
    report.results.push({ id: 'UI-MENU-SETUP', status: 'failed', error: error.stack || String(error) });
    console.error(error.stack || error); process.exitCode = 1;
  } finally {
    await browser?.close();
    await server?.stop();
    report.finishedAt = new Date().toISOString();
    report.passed = report.results.filter(row => row.status === 'passed').length;
    report.failed = report.results.filter(row => row.status === 'failed').length;
    fs.writeFileSync(path.join(reportDir, 'dialog-menu.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Dialog/menu: ${report.passed} superati, ${report.failed} falliti.`);
  }
})();
