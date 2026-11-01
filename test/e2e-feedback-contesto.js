'use strict';

// Browser e renderer reali, solo gli ACK del catalogo sono controllati.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

async function prepara(context, url) {
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.errori = [];
  page.on('pageerror', error => page.errori.push(error.message));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(url);
  await page.waitForSelector('html[data-arc-ready="true"]');
  const onboarding = page.locator('#onboarding-overlay [data-azione="chiudi"]');
  if (await onboarding.isVisible()) await onboarding.click();
  await page.waitForFunction(() => !document.querySelector('.overlay[data-arc-dialog="closing"]'));
  return page;
}

async function albero(page) {
  await page.evaluate(async () => {
    const { impostaSocket } = await import('/js/socket.js');
    const { tabs, createTab, switchTab, closeTab } = await import('/js/tabs.js');
    const { renderWorkspace, saveWorkspaceInputs } = await import('/js/workspace.js');
    const { refreshDbTree } = await import('/js/dbtree.js');
    const a = createTab({ id: 'contesto-A' }), b = createTab({ id: 'contesto-B' });
    for (const tab of [a, b]) {
      tab.label = tab.id;
      Object.assign(tab.state, { connected: true, databases: [{ name: `db-${tab.id}` }] });
    }
    const f = window.contesto = { calls: [], fail: 'db:collections', refreshDbTree,
      switch(id) { saveWorkspaceInputs(); switchTab(id); }, closeTab };
    const fake = { connected: true, on() { return fake; }, off() { return fake; }, emit(event, payload, ack) {
      f.calls.push({ event, tabId: payload.tabId, db: payload.db });
      ack?.(event === f.fail ? { ok: false, error: `Errore ${event} su ${payload.tabId}` }
        : { ok: true, databases: [{ name: `db-${payload.tabId}` }], collections: [{ name: `tabella-${payload.tabId}` }], docs: [] });
      return fake;
    }, timeout() { return { emit(event, payload, ack) { fake.emit(event, payload, res => ack(null, res)); } }; } };
    impostaSocket(fake);
    tabs.activeId = a.id; renderWorkspace();
  });
  if (page.viewportSize().width <= 900) await page.locator('#mobile-nav-dbs').click();
  await page.locator('#db-tree .node-label[data-db="db-contesto-A"]').click();
  const errore = page.locator('.feedback-message').filter({ hasText: 'Errore db:collections su contesto-A' });
  await errore.waitFor({ state: 'attached' });
  await page.evaluate(() => { contesto.switch('contesto-B'); contesto.calls = []; contesto.fail = null; });
  await page.locator('#feedback-container').locator('.feedback-message').filter({ hasText: 'Errore db:collections su contesto-A' })
    .getByRole('button', { name: 'Riprova', exact: true }).click();
  const calls = await page.evaluate(() => contesto.calls);
  assert(calls.length && calls.every(call => call.tabId === 'contesto-A'), '[ALBERO-ORIGINE] Riprova deve leggere solo la connessione A');
  assert.equal(await page.evaluate(async () => (await import('/js/tabs.js')).tabs.activeId), 'contesto-B');
  assert.equal(await page.locator('#db-tree [data-db="db-contesto-A"]').count(), 0, 'Il tentativo in background non ridisegna B');
  await page.evaluate(() => contesto.switch('contesto-A'));
  await page.locator('#db-tree [data-coll="tabella-contesto-A"]').waitFor({ state: 'attached' });

  // Anche il retry dell'elenco e quello della ricerca devono conservare l'origine.
  for (const event of ['db:list', 'db:search']) {
    if (page.viewportSize().width <= 900 && !await page.locator('#sidebar').evaluate(el => el.classList.contains('open'))) {
      await page.locator('#mobile-nav-dbs').click();
    }
    await page.evaluate(async event => {
      contesto.fail = event;
      if (event === 'db:list') await contesto.refreshDbTree();
      else {
        const search = document.getElementById('db-search'); search.value = 'prova';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, event);
    const message = page.locator('.feedback-message').filter({ hasText: `Errore ${event} su contesto-A` });
    await message.waitFor({ state: 'attached' });
    await page.evaluate(() => { contesto.switch('contesto-B'); contesto.calls = []; contesto.fail = null; });
    await message.getByRole('button', { name: /Riprova|Ricarica elenco/ }).click();
    const retried = await page.evaluate(() => contesto.calls);
    assert(retried.length && retried.every(call => call.tabId === 'contesto-A'), `[ALBERO-ORIGINE] Retry ${event} vincolato ad A`);
    await page.evaluate(() => contesto.switch('contesto-A'));
  }
  await page.evaluate(async () => { contesto.fail = 'db:list'; await contesto.refreshDbTree(); });
  const closed = page.locator('.feedback-message').filter({ hasText: 'Errore db:list su contesto-A' });
  await closed.waitFor({ state: 'attached' });
  await page.evaluate(async () => { contesto.switch('contesto-B'); await contesto.closeTab('contesto-A'); contesto.calls = []; });
  await closed.getByRole('button', { name: 'Riprova', exact: true }).click();
  await closed.getByText(/connessione.*chiusa/i).waitFor();
  assert.equal(await page.evaluate(() => contesto.calls.length), 0, 'Il tab chiuso non viene sostituito con quello attivo');
}

async function modale(page) {
  await page.evaluate(async () => {
    (await import('/js/avvisi.js')).notifica('Errore precedente alla finestra.', { id: 'precedente' });
    document.getElementById('btn-theme').click();
  });
  await page.waitForSelector('#modal-theme[data-arc-dialog="open"]');
  await page.locator('#btn-tema-importa').focus();
  await page.locator('#tema-import-file').setInputFiles({ name: 'non-valido.json', mimeType: 'application/json', buffer: Buffer.from('{errore') });
  const error = page.locator('#feedback-container .feedback-message').filter({ hasText: 'Il file non è un JSON valido.' });
  await error.waitFor();
  const copy = error.getByRole('button', { name: 'Copia errore', exact: true });
  await copy.focus();
  assert(await copy.evaluate(el => el === document.activeElement), '[MODALE-FOCUS] Copia errore deve ricevere il focus nella modale');
  await page.keyboard.press('Enter');
  await error.getByText('Messaggio copiato.', { exact: true }).waitFor({ state: 'attached' });
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Il file non è un JSON valido\./);
  await copy.focus(); await page.keyboard.press('Tab');
  assert(await error.getByRole('button', { name: 'Chiudi messaggio' }).evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter');
  await error.waitFor({ state: 'detached' });
  const previous = page.locator('#feedback-container .feedback-message').filter({ hasText: 'Errore precedente' });
  await previous.getByRole('button', { name: 'Copia errore', exact: true }).focus();
  assert(await previous.getByRole('button', { name: 'Copia errore', exact: true }).evaluate(el => el === document.activeElement), 'Anche gli errori preesistenti restano accessibili');
  assert.equal(await previous.evaluate(el => !!el.closest('[aria-hidden="true"]')), false);
  await page.evaluate(async () => {
    window.rispostaPrompt = (await import('/js/utils.js')).chiediTesto({ titolo: 'Finestra sovrapposta' });
  });
  await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
  await previous.getByRole('button', { name: 'Copia errore', exact: true }).focus();
  assert(await previous.getByRole('button', { name: 'Copia errore', exact: true }).evaluate(el => el === document.activeElement), 'Accessibile anche nella finestra sovrapposta');
  await page.locator('#askinput-cancel').click();
  await page.waitForFunction(() => !document.getElementById('askinput-overlay').dataset.arcDialog);
  await page.setViewportSize({ width: page.viewportSize().width <= 900 ? 1440 : 390, height: 900 });
  await previous.getByRole('button', { name: 'Copia errore', exact: true }).focus();
  assert(await previous.getByRole('button', { name: 'Copia errore', exact: true }).evaluate(el => el === document.activeElement), 'Il cambio formato conserva il focus accessibile');
  const bounds = await previous.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1, 'Messaggio entro la finestra');
  await page.evaluate(() => document.getElementById('btn-close-theme-modal').click());
  await page.waitForFunction(() => !document.getElementById('modal-theme').dataset.arcDialog);
  assert(await page.locator('body > #feedback-container').count(), 'La chiusura restituisce il contenitore alla pagina');
  await page.keyboard.press('Control+p');
  await page.waitForSelector('#palette-overlay[data-arc-dialog="open"]');
  await previous.getByRole('button', { name: 'Copia errore', exact: true }).focus();
  assert(await previous.getByRole('button', { name: 'Copia errore', exact: true }).evaluate(el => el === document.activeElement), 'Anche la palette conserva l’accesso alle notifiche');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('palette-overlay'));
  assert.equal(await page.locator('body > #feedback-container').count(), 1);
  await previous.getByRole('button', { name: 'Chiudi messaggio' }).focus();
  await page.keyboard.press('Enter');
  await previous.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#feedback-container').count(), 1, 'Nessun contenitore duplicato');
}

(async () => {
  let mutantBundle;
  if (process.argv.includes('--mutant-modale')) {
    const fs = require('node:fs');
    const result = await require('esbuild').build({ entryPoints: ['ui/main.tsx'], bundle: true, minify: true,
      write: false, outdir: 'public/arc', format: 'esm', jsx: 'automatic', loader: { '.webp': 'dataurl' },
      plugins: [{ name: 'feedback-fuori-modale', setup(build) {
        build.onLoad({ filter: /dialogs\.tsx$/ }, args => {
          const source = fs.readFileSync(args.path, 'utf8');
          assert(source.includes(', #feedback-container'), 'Il mutante deve rimuovere il contenitore dal focus trap');
          return { contents: source.replace(', #feedback-container', ''), loader: 'tsx' };
        });
      } }] });
    mutantBundle = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  }
  const server = await startTestServer({ port: Number(process.env.E2E_PORT || 3193) });
  let browser;
  let failed = false;
  try {
    browser = await chromium.launch();
    const cases = process.argv.includes('--albero') ? { albero } : process.argv.includes('--modale') ? { modale } : { albero, modale };
    for (const [name, run] of Object.entries(cases)) for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      if (mutantBundle) await context.route('**/arc/ui.js', route => route.fulfill({ contentType: 'text/javascript', body: mutantBundle }));
      if (process.argv.includes('--mutant-albero')) await context.route('**/js/dbtree.js', async route => {
        const response = await route.fetch(), source = await response.text();
        assert(source.includes("emit('db:list', { tabId })"), 'Il mutante deve eliminare il vincolo alla connessione');
        await route.fulfill({ response, body: source.replace("emit('db:list', { tabId })", "emit('db:list', {})") });
      });
      const page = await prepara(context, server.url);
      try { await run(page); assert.deepEqual(page.errori, []); console.log(`OK ${name} ${width}px`); }
      catch (error) { failed = true; console.error(`FAIL ${name} ${width}px`, error); }
      finally { await context.close(); }
    }
  } finally { await browser?.close(); await server.stop(); }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
