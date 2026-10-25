'use strict';
const { formattaOutputMutante } = require('./lab/output-mutanti.cjs');

// LAB009/AUD015: il browser carica un bundle compilato soltanto in memoria.
// La barriera trattiene la conclusione dell'animazione, senza cambiare stack,
// annullamento o spostamenti DOM. Il test decide quando lasciarla completare.
// LAB_BROWSER_CHANNEL=msedge node test/e2e-dialog-lifecycle.js [--sensitivity]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const repo = path.resolve(__dirname, '..');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-009/dialog-lifecycle');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { suite: 'dialog-lifecycle', iniziato: new Date().toISOString(), risultati: [], sensibilita: [], sorgenti: {} };
for (const file of ['ui/dialogs.tsx', 'ui/prompt.tsx', 'ui/components/arc/bottom-sheet/bottom-sheet.tsx',
  'public/js/utils.js', 'public/arc/ui.js', 'test/e2e-dialog-lifecycle.js']) report.sorgenti[file] = hash(fs.readFileSync(path.join(repo, file)));
let server, browser;

function sostituisci(source, from, to, label) {
  assert.equal(source.split(from).length - 1, 1, `La strumentazione ${label} deve individuare un solo punto reale`);
  return source.replace(from, to);
}
async function buildUi(mutant) {
  const result = await require('esbuild').build({ absWorkingDir: repo, entryPoints: ['ui/main.tsx'],
    outdir: path.join(reportDir, 'bundle-in-memoria'), entryNames: 'ui', write: false, bundle: true, minify: true,
    format: 'esm', target: ['chrome120', 'firefox120', 'safari17'], jsx: 'automatic', legalComments: 'none', logLevel: 'silent',
    plugins: [{ name: 'barriera-uscita-fixture', setup(build) {
      build.onLoad({ filter: /(?:dialogs|bottom-sheet)\.tsx$/ }, async args => {
        let source = fs.readFileSync(args.path, 'utf8');
        if (args.path.endsWith('dialogs.tsx')) {
          source = sostituisci(source,
            'Promise.all(layers.map(animation => animation.finished)).then(() => {',
            'Promise.all(layers.map(animation => animation.finished)).then(() => open ? undefined : (window as any).__labExitGate(overlay.id)).then(() => {', 'animazione desktop');
          if (mutant === 'menu') source += `\n// Mutante locale: una restituzione tardiva sposta un popover già aperto.\n`
            + `document.addEventListener('codedb:dialog-closed', () => { const menu = document.getElementById('context-menu'); if (menu?.matches(':popover-open')) { (window as any).__labMutationHits++; document.body.append(menu); } }, true);\n`;
          if (mutant === 'prompt') source = sostituisci(source,
            "const top = opened.filter(overlay => !overlay.classList.contains('hidden')).at(-1);",
            "const wizard = opened.find(overlay => overlay.id === 'connect-overlay' && !overlay.classList.contains('hidden')); if (wizard) (window as any).__labMutationHits++; const top = wizard || opened.filter(overlay => !overlay.classList.contains('hidden')).at(-1);",
            'priorità Escape del prompt');
          if (mutant === 'generation') source = sostituisci(source,
            "if (isOpen || version !== revision || overlay.dataset.arcDialog !== 'closing') return;",
            "if (isOpen || overlay.dataset.arcDialog !== 'closing') return; if (version !== revision) (window as any).__labMutationHits++;", 'generazione della chiusura');
          if (mutant === 'resize') source = sostituisci(source,
            "if (isOpen || version !== revision || overlay.dataset.arcDialog !== 'closing') return;",
            "if (isOpen || version !== revision) return; if (overlay.dataset.arcDialog !== 'closing') (window as any).__labMutationHits++;", 'chiusura idempotente');
        } else {
          const gate = "() => (window as any).__labExitGate(sheetRef.current?.closest('.overlay')?.id).then(completeExit)";
          source = sostituisci(source, 'onComplete: completeExit', `onComplete: ${gate}`, 'animazione mobile ridotta');
          source = sostituisci(source, 'arrive.current = completeExit;', `arrive.current = ${gate};`, 'animazione mobile interrotta');
          source = sostituisci(source, 'go("closed", undefined, completeExit);', `go("closed", undefined, ${gate});`, 'animazione mobile');
          if (mutant === 'generation') source = sostituisci(source, 'if (active) safeToRemove?.();',
            'if (!active) (window as any).__labMutationHits++; safeToRemove?.();', 'generazione mobile della chiusura');
        }
        return { contents: source, loader: 'tsx', resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  return Object.fromEntries(result.outputFiles.map(file => [path.basename(file.path), file.text]));
}
async function fixture(bundle, width) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, hasTouch: width < 900, reducedMotion: 'no-preference' });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.labErrors = [];
  page.on('pageerror', error => page.labErrors.push(error.message));
  page.on('dialog', async dialog => { page.labErrors.push(`Dialog nativo inatteso: ${dialog.message()}`); await dialog.dismiss(); });
  await page.route('**/arc/ui.js*', route => route.fulfill({ contentType: 'text/javascript', body: bundle['ui.js'] }));
  await page.route('**/arc/ui.css*', route => route.fulfill({ contentType: 'text/css', body: bundle['ui.css'] }));
  await page.addInitScript(version => {
    localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true }));
    window.__labMutationHits = 0;
    window.__labHolds = new Map();
    window.__labExitGate = id => {
      const hold = window.__labHolds.get(id);
      if (!hold) return Promise.resolve();
      hold.arrived++; return hold.promise;
    };
    window.__labArm = id => {
      if (window.__labHolds.has(id)) throw new Error(`Barriera ${id} già armata`);
      let release; const promise = new Promise(resolve => { release = resolve; });
      window.__labHolds.set(id, { promise, release, arrived: 0 });
    };
    window.__labRelease = id => { const hold = window.__labHolds.get(id); window.__labHolds.delete(id); hold?.release(); };
  }, require('../package.json').version);
  await page.goto(server.url); await page.waitForSelector('html[data-arc-ready="true"]');
  await page.evaluate(async () => {
    window.labUtils = await import('/js/utils.js'); window.labConnection = await import('/js/connection.js');
  });
  return { page, context };
}
async function griglia(page) {
  await page.evaluate(async () => {
    const [{ createTab, tabs }, { state }, { impostaSocket }, { renderGrid }] = await Promise.all([
      import('/js/tabs.js'), import('/js/state.js'), import('/js/socket.js'), import('/js/grid.js'),
    ]);
    const tab = createTab({ id: 'lab-dialog-lifecycle', connName: null }); tab.dbType = 'mongodb'; tabs.activeId = tab.id;
    Object.assign(state, { connected: true, dbType: 'mongodb', db: 'laboratorio_ui', coll: 'documenti',
      docs: [{ _id: 'lab-1', nome: 'Documento del laboratorio' }], columns: ['_id', 'nome'], total: 1, exhausted: true });
    window.labWrites = [];
    impostaSocket({ on() {}, off() {}, emit(event, payload, cb) {
      if (event === 'doc:duplicate') return cb?.({ ok: true, doc: JSON.stringify({ nome: 'Copia del laboratorio' }) });
      if (event === 'collection:find') return cb?.({ ok: true, docs: state.docs, columns: state.columns, total: 1 });
      window.labWrites.push(event); cb?.({ ok: true });
    } });
    for (const id of ['tab-body', 'workspace', 'view-data']) document.getElementById(id)?.classList.remove('hidden');
    for (const id of ['welcome', 'placeholder']) document.getElementById(id)?.classList.add('hidden');
    renderGrid();
    window.labContext = { tabId: tab.id, db: state.db, coll: state.coll, dbType: 'mongodb', isStillActive: () => false, onSaveSuccess: () => renderGrid() };
  });
}
async function chiudiConBarriera(page, overlay, cancel, waitUntilClosed) {
  await page.evaluate(id => window.__labArm(id), overlay);
  await page.locator(cancel).click();
  await page.waitForFunction(id => window.__labHolds.get(id)?.arrived > 0, overlay);
  assert.equal(await page.locator(`#${overlay}`).getAttribute('data-arc-dialog'), 'closing', '[DIALOG-PRECONDIZIONE] uscita reale sospesa');
  if (waitUntilClosed) {
    await page.evaluate(id => window.__labRelease(id), overlay);
    await page.waitForFunction(id => !document.getElementById(id).dataset.arcDialog, overlay);
  }
}
async function menuCase(page, kind, waitUntilClosed) {
  await griglia(page);
  let overlay, cancel;
  if (kind === 'edit') {
    await page.evaluate(async () => { const { state } = await import('/js/state.js'); (await import('/js/inlineEdit.js')).openEditDoc(state.docs[0], window.labContext); });
    overlay = 'editdoc-overlay'; cancel = '#editdoc-cancel';
  } else {
    await page.locator('#grid tbody td[data-c="1"]').click({ button: 'right' });
    await page.locator('#context-menu li').filter({ hasText: 'Duplica riga' }).click();
    await page.locator('#context-menu li').filter({ hasText: 'Duplica e modifica' }).click();
    overlay = 'duprow-overlay'; cancel = '#duprow-cancel';
  }
  await page.waitForSelector(`#${overlay}[data-arc-dialog="open"]`);
  await page.evaluate(() => {
    window.labMenuEvents = [];
    document.getElementById('context-menu').addEventListener('toggle', event => window.labMenuEvents.push({
      before: event.oldState, after: event.newState, parent: event.target.parentElement?.className,
    }));
  });
  await chiudiConBarriera(page, overlay, cancel, waitUntilClosed);
  await page.locator('#grid tbody td[data-c="1"]').click({ button: 'right' });
  const read = () => page.evaluate(id => {
    const menu = document.getElementById('context-menu');
    return { state: document.getElementById(id).dataset.arcDialog || null, open: menu.matches(':popover-open'),
      hidden: menu.classList.contains('hidden'), overlay: menu.closest('.overlay')?.id || null, events: [...window.labMenuEvents] };
  }, overlay);
  const opened = await read(); assert.equal(opened.open, true, '[DIALOG-MENU-APERTURA] il clic deve aprire realmente il popover');
  if (!waitUntilClosed) assert.equal(opened.state, 'closing', '[DIALOG-PRECONDIZIONE] aprire prima della fine della chiusura');
  await page.evaluate(id => window.__labRelease(id), overlay);
  await page.waitForFunction(id => !document.getElementById(id).dataset.arcDialog, overlay);
  const finished = await read(); page.labEvidence = { overlay, waitUntilClosed, opened, finished };
  assert.equal(finished.open, true, `[DIALOG-MENU-PERSISTENZA] il menu deve restare aperto: ${JSON.stringify(page.labEvidence)}`);
  assert.equal(finished.hidden, false);
  await page.locator('#context-menu li').filter({ hasText: 'Duplica riga' }).click();
  await page.locator('#context-menu li').filter({ hasText: 'Duplica e modifica' }).waitFor({ state: 'visible' });
  assert.deepEqual(await page.evaluate(() => window.labWrites), [], 'Nessuna scrittura durante annullamento e apertura del menu');
  return page.labEvidence;
}
async function promptCase(page, waitUntilClosed) {
  await page.evaluate(() => {
    window.labFirst = 'pending'; window.labSecond = 'pending';
    window.labUtils.chiediTesto({ titolo: 'Prima richiesta' }).then(value => { window.labFirst = value; });
  });
  await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
  await chiudiConBarriera(page, 'askinput-overlay', '#askinput-cancel', waitUntilClosed);
  assert.equal(await page.evaluate(() => window.labFirst), null, 'La prima richiesta annullata deve risolvere null');
  await page.evaluate(() => window.labConnection.openConnModal());
  await page.waitForSelector('#connect-overlay[data-arc-dialog="open"]');
  await page.locator('#connect-form [name="host"]').fill('bozza.lifecycle.example');
  await page.evaluate(() => {
    window.labUtils.chiediTesto({ titolo: 'Seconda richiesta sopra il wizard', valore: 'seconda bozza' })
      .then(value => { window.labSecond = value; });
  });
  await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
  const opened = await page.evaluate(() => ({ askZ: getComputedStyle(document.getElementById('askinput-overlay')).zIndex,
    wizardZ: getComputedStyle(document.getElementById('connect-overlay')).zIndex, focused: document.activeElement?.id,
    first: window.labFirst, second: window.labSecond }));
  await page.evaluate(() => window.__labRelease('askinput-overlay'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#askinput-overlay').getAttribute('data-arc-dialog'), 'open', '[DIALOG-PROMPT-RIAPERTURA] nessuna chiusura tardiva della nuova richiesta');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.labSecond !== 'pending' || document.getElementById('connect-overlay').classList.contains('hidden'));
  const finished = await page.evaluate(() => ({ first: window.labFirst, second: window.labSecond,
    askHidden: document.getElementById('askinput-overlay').classList.contains('hidden'),
    wizardHidden: document.getElementById('connect-overlay').classList.contains('hidden'),
    draft: document.querySelector('#connect-form [name="host"]').value, focused: document.activeElement?.id }));
  page.labEvidence = { waitUntilClosed, opened, finished };
  assert.equal(finished.second, null, `[DIALOG-PROMPT-ESCAPE] Escape deve risolvere la seconda richiesta: ${JSON.stringify(page.labEvidence)}`);
  assert.equal(finished.wizardHidden, false, '[DIALOG-PROMPT-WIZARD] Escape non deve chiudere il wizard sottostante');
  assert.equal(finished.askHidden, true); assert.equal(finished.draft, 'bozza.lifecycle.example');
  assert(Number(opened.askZ) > Number(opened.wizardZ), '[DIALOG-PROMPT-STACK] il prompt deve stare sopra il wizard');
  await page.waitForFunction(() => !document.getElementById('askinput-overlay').dataset.arcDialog);
  await page.waitForFunction(() => document.getElementById('connect-overlay').contains(document.activeElement));
  return page.labEvidence;
}
async function generationCase(page) {
  await page.evaluate(() => {
    window.labClosed = 0;
    document.getElementById('askinput-overlay').addEventListener('codedb:dialog-closed', () => window.labClosed++);
    window.labUtils.chiediTesto({ titolo: 'Prima generazione' });
  });
  await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
  await chiudiConBarriera(page, 'askinput-overlay', '#askinput-cancel', false);
  await page.evaluate(() => {
    window.labOldExit = window.__labHolds.get('askinput-overlay');
    window.__labHolds.delete('askinput-overlay');
    window.labUtils.chiediTesto({ titolo: 'Seconda generazione' });
  });
  await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
  await chiudiConBarriera(page, 'askinput-overlay', '#askinput-cancel', false);
  await page.evaluate(async () => {
    window.labOldExit.release();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const pending = await page.evaluate(() => ({ state: document.getElementById('askinput-overlay').dataset.arcDialog,
    inPortal: !!document.querySelector('#askinput-overlay .arc-panel-slot .modal'), closed: window.labClosed }));
  page.labEvidence = pending;
  assert.deepEqual(pending, { state: 'closing', inPortal: true, closed: 0 },
    '[DIALOG-GENERAZIONE] la vecchia uscita non deve terminare la nuova chiusura');
  await page.evaluate(() => window.__labRelease('askinput-overlay'));
  await page.waitForFunction(() => !document.getElementById('askinput-overlay').dataset.arcDialog);
  assert.equal(await page.evaluate(() => window.labClosed), 1, '[DIALOG-GENERAZIONE] un solo completamento valido');
  return pending;
}
async function resizeCase(page, width) {
  await page.evaluate(() => {
    window.labClosed = 0;
    document.getElementById('askinput-overlay').addEventListener('codedb:dialog-closed', () => window.labClosed++);
    window.labUtils.chiediTesto({ titolo: 'Chiusura durante il cambio formato' });
  });
  await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
  await chiudiConBarriera(page, 'askinput-overlay', '#askinput-cancel', false);
  await page.setViewportSize({ width: width < 900 ? 1440 : 390, height: 960 });
  await page.waitForFunction(() => !document.getElementById('askinput-overlay').dataset.arcDialog);
  assert.equal(await page.evaluate(() => window.labClosed), 1, '[DIALOG-RIDIMENSIONAMENTO] il cambio formato completa la chiusura');
  await page.evaluate(async () => {
    window.__labRelease('askinput-overlay');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const closed = await page.evaluate(() => window.labClosed); page.labEvidence = { closed };
  assert.equal(closed, 1, '[DIALOG-RIDIMENSIONAMENTO] il vecchio callback non deve chiudere due volte');
  return page.labEvidence;
}
async function run(mutant) {
  const bundle = await buildUi(mutant), results = [], dir = path.join(reportDir, mutant ? `mutante-${mutant}` : 'controllo');
  fs.mkdirSync(dir, { recursive: true });
  const kinds = mutant === 'menu' ? ['edit', 'duplicate'] : mutant ? [mutant] : ['edit', 'duplicate', 'prompt', 'generation', 'resize'];
  for (const width of [1440, 390]) for (const kind of kinds) for (const waitUntilClosed of [true, false]) {
    if (['generation', 'resize'].includes(kind) && waitUntilClosed) continue;
    const id = `${width}-${kind}-${waitUntilClosed ? 'chiuso' : 'closing'}`, start = Date.now(); let fixtureResult;
    const item = { id, width, kind, waitUntilClosed, ok: false };
    try {
      fixtureResult = await fixture(bundle, width); const { page } = fixtureResult;
      item.evidence = kind === 'resize' ? await resizeCase(page, width) : kind === 'generation' ? await generationCase(page)
        : kind === 'prompt' ? await promptCase(page, waitUntilClosed) : await menuCase(page, kind, waitUntilClosed);
      assert.deepEqual(page.labErrors, [], '[DIALOG-ERRORI] nessun errore JavaScript'); item.ok = true;
    } catch (error) {
      item.errore = error.stack; item.evidence = fixtureResult?.page.labEvidence;
      await fixtureResult?.page.screenshot({ path: path.join(dir, `${id}.png`), fullPage: true }).catch(() => {});
    } finally {
      item.mutazioni = fixtureResult ? await fixtureResult.page.evaluate(() => window.__labMutationHits).catch(() => 0) : 0;
      item.erroriPagina = fixtureResult?.page.labErrors || []; item.durationMs = Date.now() - start;
      results.push(item); fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(results, null, 2));
      console.log(formattaOutputMutante(mutant || null,
        `${item.ok ? 'OK' : 'FAIL'} ${mutant || 'controllo'}/${id}${item.ok ? '' : ': ' + item.errore.split('\n')[0]}`));
      await fixtureResult?.context.close();
    }
  }
  const expected = kinds.reduce((count, kind) => count + (['generation', 'resize'].includes(kind) ? 2 : 4), 0);
  return { risultati: results, bundleSha256: hash(bundle['ui.js']), ok: results.length === expected && results.every(item => item.ok) };
}
(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  try {
    server = await startTestServer({ port: Number(process.env.LAB_DIALOG_LIFECYCLE_PORT || 39369) });
    browser = await chromium.launch(process.env.LAB_BROWSER_CHANNEL ? { channel: process.env.LAB_BROWSER_CHANNEL } : {});
    const control = await run(null); report.risultati = control.risultati; report.bundleSha256 = control.bundleSha256;
    if (process.argv.includes('--sensitivity')) for (const mutant of ['menu', 'prompt', 'generation', 'resize']) {
      const result = await run(mutant), failed = result.risultati.filter(item => !item.ok);
      report.sensibilita.push({ mutante: mutant, ...result, rilevata: result.risultati.some(item => item.mutazioni > 0)
        && failed.length === ({ menu: 4, prompt: 4, generation: 2, resize: 2 })[mutant]
        && failed.every(item => item.errore.includes(mutant === 'menu' ? '[DIALOG-MENU-PERSISTENZA]'
          : mutant === 'prompt' ? '[DIALOG-PROMPT-ESCAPE]' : mutant === 'generation' ? '[DIALOG-GENERAZIONE]' : '[DIALOG-RIDIMENSIONAMENTO]')) });
    }
    report.ok = control.ok && report.sensibilita.every(item => item.rilevata);
  } catch (error) { report.erroreFatale = error.stack; report.ok = false; console.error(error.stack); }
  finally {
    await browser?.close(); await server?.stop();
    report.fontiIntatte = Object.entries(report.sorgenti).every(([file, before]) => hash(fs.readFileSync(path.join(repo, file))) === before);
    report.ok &&= report.fontiIntatte; report.terminato = new Date().toISOString();
    fs.writeFileSync(path.join(reportDir, 'dialog-lifecycle.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
})();
