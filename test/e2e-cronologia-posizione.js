'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3257 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, hasTouch: true });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // La prova della geometria non dipende dal servizio esterno dei font.
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    if (process.argv.includes('--mutant-click') || process.argv.includes('--mutant-escape')) {
      await page.route('**/js/qe-history.js', async route => {
        const response = await route.fetch();
        const source = await response.text();
        const original = process.argv.includes('--mutant-click')
          ? "document.addEventListener('pointerdown', (e) => {" : 'e.defaultPrevented';
        const replacement = process.argv.includes('--mutant-click')
          ? "document.addEventListener('click', (e) => {" : 'false';
        assert(source.includes(original), 'La mutazione deve colpire il gestore della cronologia');
        await route.fulfill({ response, body: source.replace(original, replacement) });
      });
    }
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('html[data-arc-ready="true"]');
    // La cronologia non richiede un database: basta rendere visibile la vista Query.
    await page.evaluate(() => {
      for (const id of ['welcome', 'placeholder']) document.getElementById(id).classList.add('hidden');
      for (const id of ['tab-body', 'workspace', 'view-query']) document.getElementById(id).classList.remove('hidden');
      for (const panel of document.querySelectorAll('#workspace .view-panel')) panel.classList.toggle('hidden', panel.id !== 'view-query');
    });
    const panel = page.locator('#qe-history-panel');
    const trigger = page.locator('[data-arc-for="qe-history-conn"] [role="combobox"]');
    const popup = page.locator('[data-arc-select-popup]');
    const more = page.locator('#query-editor-more-btn');
    const openHistory = async () => {
      await more.click();
      await page.locator('#qe-history-btn').click();
      await panel.waitFor();
    };
    const openConnections = async (gesture = 'mouse') => {
      const before = await panel.boundingBox();
      assert(before && before.x > 100 && before.y > 50, 'Il pannello parte accanto alla barra Query');
      if (gesture === 'touch') await trigger.tap();
      else if (gesture === 'keyboard') { await trigger.focus(); await trigger.press('ArrowDown'); }
      else await trigger.click();
      await popup.waitFor();
      await page.waitForTimeout(250);
      const after = await panel.boundingBox();
      assert(after && Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2,
        `Aprire Tutte le connessioni conserva la posizione: ${JSON.stringify({ gesture, before, after })}`);
      const t = await trigger.boundingBox(), p = await popup.boundingBox();
      assert(p && t && p.x < t.x + t.width && p.x + p.width > t.x
        && Math.min(Math.abs(p.y - t.y - t.height), Math.abs(t.y - p.y - p.height)) < 12,
      `Il menu resta ancorato al selettore: ${JSON.stringify({ t, p })}`);
    };

    // Stesso caso della segnalazione: cronologia vuota, un'unica opzione.
    await openHistory();
    await openConnections();
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' });
    assert(await panel.isVisible(), 'Il primo Escape chiude soltanto le connessioni');
    assert(await trigger.evaluate(el => el === document.activeElement), 'Il focus torna al selettore');
    await page.keyboard.press('Escape');
    assert(!await panel.isVisible(), 'Il secondo Escape chiude la cronologia');
    assert(await more.evaluate(el => el === document.activeElement), 'Il focus torna alle azioni Query');

    await page.evaluate(async () => {
      const { registra } = await import('/js/query-history-store.js');
      registra(localStorage, { code: 'SELECT 1', conn: 'Locale', db: 'esempio' });
      registra(localStorage, { code: 'SELECT 2', conn: 'Collaudo', db: 'esempio' });
    });
    await openHistory();
    await openConnections();
    await page.getByRole('option', { name: 'Locale', exact: true }).click();
    await popup.waitFor({ state: 'detached' });
    assert(await panel.isVisible(), 'Scegliere una connessione conserva la cronologia');
    assert.equal(await panel.locator('.query-history-item').count(), 1, 'La connessione filtra le voci');
    assert.equal(await panel.locator('.query-history-text').textContent(), 'SELECT 1');

    await openConnections('keyboard');
    await page.keyboard.press('Home');
    // Radix sposta il focus in un task successivo: Enter immediato poteva
    // selezionare ancora Locale. Aspettiamo l'effetto di Home, non un ritardo.
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option'
      && document.activeElement.textContent === 'Tutte le connessioni');
    await page.keyboard.press('Enter');
    await popup.waitFor({ state: 'detached' });
    assert.equal(await panel.locator('.query-history-item').count(), 2, 'Tutte le connessioni ripristina entrambe le voci');
    await openConnections('touch');
    await page.getByRole('option', { name: 'Collaudo', exact: true }).tap();
    await popup.waitFor({ state: 'detached' });
    assert(await panel.isVisible(), 'La scelta con tocco conserva la cronologia');
    assert.equal(await panel.locator('.query-history-text').textContent(), 'SELECT 2');

    await openConnections();
    await page.mouse.click(600, 650);
    await popup.waitFor({ state: 'detached' });
    assert(!await panel.isVisible(), 'Un clic esterno chiude entrambi i livelli');
    await openHistory();
    assert.equal(await panel.locator('.query-history-item').count(), 2, 'Riaprire azzera i filtri');
    await page.locator('#qe-history-search').fill('SELECT 1');
    assert.equal(await panel.locator('.query-history-item').count(), 1, 'La ricerca resta utilizzabile');
    await page.locator('#qe-history-clear').click();
    assert(await panel.isVisible(), 'Svuota lascia il pannello aperto');
    assert.equal(await panel.locator('.query-history-item').count(), 0, 'Svuota elimina le voci');
    assert.deepEqual(errors, [], 'Nessun errore JavaScript');
    console.log('OK: posizione stabile, filtri, mouse/tocco/tastiera, Escape progressivo, focus, clic esterno e riapertura.');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
