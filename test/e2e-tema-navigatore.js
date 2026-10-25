'use strict';
const { formattaOutputMutante } = require('./lab/output-mutanti.cjs');

// UX001: percorso pubblico Strumenti → Tema → chiusura, con stato persistente.
// LAB_BROWSER_CHANNEL=msedge node test/e2e-tema-navigatore.js [--sensitivity]
// Il renderer è reale, i soli dati sono fixture; bundle e mutante restano in RAM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const repo = path.resolve(__dirname, '..');
const dir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/ux-001/baseline');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['public/js/theme.js', 'public/js/responsive.js', 'ui/navigation-sheet.tsx', 'ui/dialogs.tsx', 'public/arc/ui.js'];
const report = { suite: 'tema-navigatore', iniziato: new Date().toISOString(), risultati: [], sensibilita: [],
  sorgenti: Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))])) };
let browser, server, bundle;

async function fixture(width, panel, mutant) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, hasTouch: width < 900 });
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.labErrors = []; page.on('pageerror', error => page.labErrors.push(error.message));
  await page.route('**/arc/ui.js*', route => route.fulfill({ contentType: 'text/javascript', body: bundle['ui.js'] }));
  await page.route('**/arc/ui.css*', route => route.fulfill({ contentType: 'text/css', body: bundle['ui.css'] }));
  if (mutant) await page.route('**/js/theme.js*', async route => {
    const response = await route.fetch(), original = await response.text();
    assert.ok(original.includes('function chiudiModale()'), '[TEMA-MUTANTE] modulo reale del tema');
    await route.fulfill({ response, body: original + `\nimport { closeNavigationSheet } from '../arc/ui.js';\n// Mutante locale: perdere il navigatore al termine del tema.\n`
      + `document.getElementById('modal-theme').addEventListener('codedb:dialog-closed', () => queueMicrotask(() => {\n`
      + `window.__labThemeMutationHits++; closeNavigationSheet(true);\n`
      + `if (!matchMedia('(max-width: 900px)').matches) document.getElementById('navigator').classList.add('collapsed');\n}));\n` });
  });
  await page.addInitScript(version => {
    localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true }));
    window.__labThemeMutationHits = 0;
  }, require('../package.json').version);
  await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
  await page.evaluate(async () => {
    const [tabs, socket, bar, workspace, colls, manager] = await Promise.all(['tabs', 'socket', 'tabbar', 'workspace', 'colltabs', 'connmanager'].map(name => import(`/js/${name}.js`)));
    const connections = Array.from({ length: 80 }, (_, i) => ({ name: `Connessione prova ${i}`, label: `Mongo prova ${i}`, dbType: 'mongodb' }));
    const collections = Array.from({ length: 80 }, (_, i) => ({ name: `misure_${i}` }));
    const databases = [{ name: 'laboratorio_ui', collections }];
    const docs = Array.from({ length: 20 }, (_, i) => ({ _id: i + 1, nome: `Misura ${i + 1}` }));
    window.__labRequests = [];
    const fake = { connected: true, on() {}, off() {}, emit(name, payload, ack) {
      window.__labRequests.push(name); ack?.({ ok: true, connections, databases, collections, docs, data: docs,
        columns: ['_id', 'nome'], fields: [], indexes: [], skip: 0, limit: 20, total: docs.length, stats: { count: docs.length } });
    }, timeout() { return { emit: (name, payload, ack) => fake.emit(name, payload, result => ack(null, result)) }; } };
    socket.impostaSocket(fake);
    const tab = tabs.createTab({ id: 'tema-navigatore', connName: connections[0].name });
    tab.label = connections[0].name; tab.dbType = 'mongodb';
    Object.assign(tab.state, { connected: true, connLabel: tab.label, dbType: 'mongodb', databases, limit: 20 });
    tabs.tabs.activeId = tab.id; bar.renderTabBar(); workspace.renderWorkspace(); colls.openCollTab('laboratorio_ui', 'misure_0');
    tab.state.editDrafts = new Map([['bozza-fixture', 'contenuto da conservare']]);
    window.__labModules = { tabs, colls }; manager.loadSavedConnections();
    window.__labThemeClosed = 0;
    document.getElementById('modal-theme').addEventListener('codedb:dialog-closed', () => window.__labThemeClosed++);
  });
  await page.locator('#conn-tree .conn-item').first().waitFor({ state: 'attached' });
  await page.locator('#grid tbody tr:not(.v-spacer)').first().waitFor({ state: 'attached' });
  if (width < 900) {
    await page.locator(panel === 'database' ? '#mobile-nav-dbs' : '#mobile-nav-conns').click();
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'visible' });
    await page.locator('.arc-navigation-sheet [data-grabber]').press('Home');
    await page.waitForFunction(() => document.querySelector('.arc-navigation-sheet').getBoundingClientRect().top < 100);
  }
  const search = panel === 'database' ? '#db-search' : '#conn-search';
  const tree = panel === 'database' ? '#db-tree' : '#conn-tree';
  await page.locator(search).fill(panel === 'database' ? 'misure' : 'prova');
  if (panel === 'database') await page.waitForFunction(() => window.__labRequests.includes('db:search') && !document.querySelector('#db-tree .loading'));
  await page.waitForFunction(selector => document.querySelector(selector).scrollHeight > document.querySelector(selector).clientHeight + 200, tree);
  await page.evaluate(selector => { document.querySelector(selector).scrollTop = 216; }, tree);
  await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 150, tree);
  await page.evaluate(({ tree, search }) => {
    window.__labTreeNode = document.querySelector(tree); window.__labSearchNode = document.querySelector(search);
  }, { tree, search });
  return { page, context, tree, search };
}

async function snapshot(page, panel) {
  return page.evaluate(panel => {
    const search = document.querySelector(panel === 'database' ? '#db-search' : '#conn-search');
    const tree = document.querySelector(panel === 'database' ? '#db-tree' : '#conn-tree');
    const nav = document.getElementById('navigator'), sheet = document.querySelector('.arc-navigation-sheet');
    const surface = matchMedia('(max-width: 900px)').matches ? sheet : nav;
    const visible = element => !!element && !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const tab = window.__labModules.tabs.activeTab();
    const selected = window.__labModules.colls.currentCollTab();
    return { panel, surfaceVisible: visible(surface), treeVisible: visible(tree), containsTree: !!surface?.contains(tree),
      focusInSurface: !!surface?.contains(document.activeElement), focused: document.activeElement?.id || document.activeElement?.tagName,
      inert: !!search.closest('[inert]'), input: search.value, scroll: tree.scrollTop, treeText: tree.textContent,
      sameTree: tree === window.__labTreeNode, sameInput: search === window.__labSearchNode,
      tab: tab.id, collection: selected?.coll, drafts: [...tab.state.editDrafts],
      theme: document.documentElement.getAttribute('data-theme'), themeClosed: window.__labThemeClosed,
      desktopCollapsed: nav.classList.contains('collapsed'),
      sheets: document.querySelectorAll('.arc-navigation-sheet').length,
      requests: [...window.__labRequests] };
  }, panel);
}

async function scenario(page, width, panel, close) {
  const result = { cycles: [] }; page.labEvidence = result;
  for (let cycle = 0; cycle < 2; cycle++) {
    const before = await snapshot(page, panel);
    assert.equal(before.surfaceVisible && before.treeVisible && before.containsTree, true, '[TEMA-PRECONDIZIONE] navigazione realmente aperta');
    assert.equal(before.inert, false, '[TEMA-PRECONDIZIONE] navigatore interattivo');
    const entry = { before }; result.cycles.push(entry);
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem', { name: 'Tema', exact: true }).click();
    await page.waitForSelector('#modal-theme[data-arc-dialog="open"]');
    entry.during = await snapshot(page, panel);
    assert.equal(await page.locator('#theme-list .tema-choice').count(), 3, '[TEMA-FUNZIONE] temi base disponibili');
    // Selezione reale: resta applicata dopo la chiusura e non perde la navigazione.
    await page.locator(`#theme-list [data-tema="${cycle ? 'dark' : 'light'}"]`).click();
    await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, cycle ? 'dark' : 'light');
    if (close === 'escape') await page.keyboard.press('Escape');
    else if (width < 900) await page.locator('#modal-theme').getByRole('button', { name: 'Chiudi finestra', exact: true }).click();
    else await page.locator('#btn-close-theme-modal').click();
    await page.waitForFunction(count => window.__labThemeClosed > count && !document.getElementById('modal-theme').dataset.arcDialog, before.themeClosed);
    // Fine della vera animazione e due frame di layout, senza attese fisse.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    entry.after = await snapshot(page, panel);
    assert.equal(entry.after.surfaceVisible && entry.after.treeVisible && entry.after.containsTree, true,
      `[TEMA-NAVIGATORE] tornando da Tema deve essere aperto lo stesso pannello ${panel}: ${JSON.stringify({ width, close, after: { ...entry.after, treeText: '<catalogo>' } })}`);
    assert.equal(entry.after.inert, false, '[TEMA-NAVIGATORE] pannello interattivo dopo la modale');
    assert.equal(entry.after.sameTree && entry.after.sameInput, true, '[TEMA-NODI] controller e nodi originali');
    assert.equal(entry.after.input, before.input, '[TEMA-FILTRO] filtro conservato');
    assert.equal(entry.after.treeText, before.treeText, '[TEMA-CATALOGO] stesso catalogo filtrato');
    assert.ok(Math.abs(entry.after.scroll - before.scroll) < 2, `[TEMA-SCROLL] ${before.scroll} → ${entry.after.scroll}`);
    assert.deepEqual([entry.after.tab, entry.after.collection, entry.after.drafts], [before.tab, before.collection, before.drafts], '[TEMA-DATI] documento e bozza conservati');
    assert.equal(entry.after.theme, cycle ? 'dark' : 'light', '[TEMA-FUNZIONE] scelta conservata');
    assert.equal(entry.after.sheets, width < 900 ? 1 : 0, '[TEMA-NAVIGATORE] un solo pannello mobile');
    await page.waitForFunction(mobile => {
      const surface = mobile ? document.querySelector('.arc-navigation-sheet') : document.getElementById('navigator');
      return !!surface?.contains(document.activeElement);
    }, width < 900, { timeout: 2000 }).catch(() => {});
    entry.focus = (await snapshot(page, panel)).focused;
    assert.equal((await snapshot(page, panel)).focusInSurface, true, '[TEMA-FOCUS] il focus torna nel navigatore');
  }
  assert.deepEqual(page.labErrors, [], '[TEMA-ERRORI] nessun errore JavaScript');
  return result;
}

async function run(mutant) {
  const results = [], output = path.join(dir, mutant ? 'mutante' : 'controllo'); fs.mkdirSync(output, { recursive: true });
  for (const width of [1440, 390]) for (const panel of ['database', 'connessioni']) for (const close of ['escape', 'pulsante']) {
    const item = { id: `${width}-${panel}-${close}`, width, panel, close, ok: false }; let current;
    try {
      current = await fixture(width, panel, mutant); item.evidence = await scenario(current.page, width, panel, close); item.ok = true;
    } catch (error) {
      item.errore = error.stack; item.evidence = current?.page.labEvidence;
      await current?.page.screenshot({ path: path.join(output, `${item.id}.png`), fullPage: true }).catch(() => {});
    } finally {
      item.erroriPagina = current?.page.labErrors || [];
      item.mutazioni = current ? await current.page.evaluate(() => window.__labThemeMutationHits).catch(() => 0) : 0;
      await current?.context.close(); results.push(item);
      console.log(formattaOutputMutante(mutant ? 'tema' : null,
        `${item.ok ? 'PASS' : 'FAIL'} ${mutant ? 'mutante' : 'controllo'}/${item.id}${item.errore ? ': ' + item.errore.split('\n')[0].slice(0, 200) : ''}`));
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
    }
  }
  return results;
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  try {
    const built = await require('esbuild').build({ absWorkingDir: repo, entryPoints: ['ui/main.tsx'], outdir: path.join(dir, 'bundle-in-memoria'),
      entryNames: 'ui', write: false, bundle: true, minify: true, format: 'esm', target: ['chrome120', 'firefox120', 'safari17'], jsx: 'automatic', logLevel: 'silent', legalComments: 'none' });
    bundle = Object.fromEntries(built.outputFiles.map(file => [path.basename(file.path), file.text])); report.bundleSha256 = hash(bundle['ui.js']);
    server = await startTestServer({ port: Number(process.env.LAB_TEMA_NAV_PORT || 39372) });
    browser = await chromium.launch(process.env.LAB_BROWSER_CHANNEL ? { channel: process.env.LAB_BROWSER_CHANNEL } : {});
    report.risultati = await run(false);
    if (process.argv.includes('--sensitivity')) {
      const mutated = await run(true);
      report.sensibilita = mutated.map(result => ({ ...result, rilevata: report.risultati.find(control => control.id === result.id)?.ok
        && result.mutazioni > 0 && !result.ok && result.errore.includes('[TEMA-NAVIGATORE]') }));
    }
    report.ok = report.risultati.length === 8 && report.risultati.every(item => item.ok) && report.sensibilita.every(item => item.rilevata);
  } catch (error) { report.erroreFatale = error.stack; report.ok = false; console.error(error); }
  finally {
    await browser?.close(); await server?.stop();
    report.fontiIntatte = Object.entries(report.sorgenti).every(([file, previous]) => hash(fs.readFileSync(path.join(repo, file))) === previous);
    report.ok &&= report.fontiIntatte; report.terminato = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'tema-navigatore.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
})();
