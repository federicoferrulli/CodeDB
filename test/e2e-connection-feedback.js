'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3181 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (process.argv.includes('--mutant')) await page.route('**/js/connection.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('const feedbackConnection = startConnection(', 'const feedbackConnection = null; void (') });
    });
    if (process.argv.includes('--mutant-focus')) await page.route('**/js/responsive.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('restoreFocus && !dialogAttivo &&', 'restoreFocus &&') });
    });
    if (process.argv.includes('--mutant-desktop')) await page.route('**/css/workbench.css', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + '\n@media (min-width: 901px) { .connection-progress { display: none; } }' });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.locator('#onboarding-overlay [data-azione="chiudi"]').click();
    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      window.cf = { queue: [], notices: [], results: [] };
      document.addEventListener('codedb:toast', e => window.cf.notices.push(e.detail.message));
      const fake = {
        connected: true, on() { return fake; }, off() { return fake; },
        emit(name, payload, ack) {
          if (name === 'mongo:connect') { window.cf.queue.push({ payload, ack }); return; }
          ack?.({ ok: true, connections: ['Locale', 'Non raggiungibile'].map(name => ({ name, label: name, dbType: 'mongodb' })), databases: [], collections: [] });
        },
        timeout() { return { emit(name, payload, ack) { fake.emit(name, payload, res => ack(null, res)); } }; },
      };
      impostaSocket(fake);
      (await import('/js/connmanager.js')).loadSavedConnections();
      window.cf.start = async name => {
        const { connectAndOpenTab } = await import('/js/connection.js');
        connectAndOpenTab({ saved: name }).then(() => window.cf.results.push('ok')).catch(() => window.cf.results.push('error'));
      };
      window.cf.answer = ok => window.cf.queue.shift().ack(ok
        ? { ok: true, dbType: 'mongodb', label: 'Locale', databases: [] }
        : { ok: false, error: 'Il server non risponde. Verifica host, porta e rete.' });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.cf.start('Desktop iniziale'));
    const initialProgress = page.getByRole('progressbar', { name: 'Connessione in corso' });
    await initialProgress.waitFor({ timeout: 5000 });
    assert.equal((await initialProgress.boundingBox()).width, 1440);
    await page.evaluate(() => window.cf.start('Desktop simultanea'));
    await page.waitForFunction(() => window.cf.queue.length === 2);
    await page.evaluate(() => window.cf.answer(true));
    await initialProgress.waitFor();
    await page.evaluate(() => window.cf.answer(false));
    await initialProgress.waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.cf.notices.some(message => message.includes('Il server non risponde')));
    assert.deepEqual(errors, []);
    if (process.argv.includes('--desktop-only')) {
      console.log('OK: progress desktop, concorrenza, successo ed errore');
      return;
    }
    await page.evaluate(() => { window.cf.notices = []; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-tree .node-label').filter({ hasText: 'Locale' }).click();
    const progress = page.getByRole('progressbar', { name: 'Connessione in corso' });
    await progress.waitFor();
    const geometry = await page.evaluate(() => {
      const bar = document.querySelector('.connection-progress');
      const nav = document.getElementById('mobile-bottom-nav');
      return { bar: bar.getBoundingClientRect().toJSON(), nav: nav.getBoundingClientRect().toJSON(), animation: getComputedStyle(bar, '::before').animationName };
    });
    assert(geometry.bar.height <= 3);
    assert(Math.abs(geometry.bar.bottom - geometry.nav.top) <= 2);
    assert.equal(geometry.animation, 'none');
    assert.deepEqual(await page.evaluate(() => window.cf.notices), []);
    // Due tentativi sovrapposti: il primo esito non deve spegnere la barra del secondo.
    await page.evaluate(() => window.cf.start('Non raggiungibile'));
    await page.waitForFunction(() => window.cf.queue.length === 2);
    await page.evaluate(() => window.cf.answer(true));
    await progress.waitFor();
    await page.evaluate(() => window.cf.answer(false));
    const dialog = page.getByRole('dialog', { name: 'Connessione non riuscita' });
    await dialog.waitFor({ timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('.arc-navigation-sheet'));
    assert(await dialog.isVisible(), 'La chiusura del drawer non deve chiudere il dialog di errore');
    assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'Il focus resta nel dialog di errore');
    assert.equal(await progress.count(), 0);
    assert.equal(await dialog.locator('.data-empty-art').count(), 1);
    const bounds = await dialog.boundingBox();
    assert(Math.abs(bounds.y + bounds.height / 2 - 844 / 2) < 2, 'Dialog centrato verticalmente');
    assert(Math.abs(bounds.x + bounds.width / 2 - 390 / 2) < 2, 'Dialog centrato orizzontalmente');
    assert((await dialog.locator('.data-empty-art').boundingBox()).width >= 200, 'Illustrazione protagonista');
    assert.deepEqual(await page.evaluate(() => window.cf.notices), []);
    fs.mkdirSync('test-reports/connection-feedback', { recursive: true });
    await page.screenshot({ path: 'test-reports/connection-feedback/mobile-error.png' });
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.evaluate(async () => (await import('/arc/ui.js')).closeNavigationSheet());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#mobile-nav-conns').click();
    await page.locator('.arc-navigation-sheet').waitFor();
    await page.evaluate(async () => (await import('/arc/ui.js')).closeNavigationSheet());
    await page.waitForFunction(() => !document.querySelector('.arc-navigation-sheet'));
    assert(await page.locator('#mobile-nav-conns').evaluate(el => el === document.activeElement), 'Senza altri dialog la chiusura restituisce il focus al pulsante');
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-tree .node-label').filter({ hasText: 'Non raggiungibile' }).click();
    await progress.waitFor();
    await page.evaluate(() => window.cf.answer(false));
    await dialog.waitFor({ timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('.arc-navigation-sheet'));
    assert(await dialog.isVisible(), 'Anche con animazioni complete il dialog sopravvive alla chiusura del drawer');
    assert(await dialog.evaluate(el => el.contains(document.activeElement)));
    await dialog.getByRole('button', { name: 'Ho capito' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.evaluate(() => window.cf.start('Locale'));
    await progress.waitFor();
    assert.equal(await progress.evaluate(el => getComputedStyle(el, '::before').animationName), 'connection-progress');
    await page.screenshot({ path: 'test-reports/connection-feedback/mobile-loading.png' });
    await page.evaluate(() => window.cf.answer(true));
    await progress.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.cf.start('Desktop'));
    await page.waitForFunction(() => window.cf.queue.length === 1);
    await progress.waitFor();
    const desktopBounds = await progress.boundingBox();
    assert.equal(desktopBounds.y, 0);
    assert.equal(desktopBounds.width, 1440);
    assert.equal(desktopBounds.height, 3);
    assert.deepEqual(await page.evaluate(() => window.cf.notices), []);
    await page.screenshot({ path: 'test-reports/connection-feedback/desktop-loading.png' });
    await page.evaluate(() => window.cf.start('Seconda desktop'));
    await page.waitForFunction(() => window.cf.queue.length === 2);
    await page.evaluate(() => window.cf.answer(true));
    await progress.waitFor();
    await page.evaluate(() => window.cf.answer(false));
    await page.waitForFunction(() => window.cf.notices.some(message => message.includes('Il server non risponde')));
    assert.equal(await dialog.count(), 0);
    await progress.waitFor({ state: 'detached' });
    await page.screenshot({ path: 'test-reports/connection-feedback/desktop.png' });
    assert.deepEqual(errors, []);
    console.log('OK: mobile, drawer, progress, concorrenza, successo/errore, illustrazione, chiusura, movimento ridotto e desktop');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
