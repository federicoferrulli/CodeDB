'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3181 });
  const browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (process.argv.includes('--mutant')) await page.route('**/js/connection.js', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('const feedbackConnection = startConnection(', 'const feedbackConnection = null; void (') });
      });
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      const onboarding = page.locator('#onboarding-overlay [data-azione="chiudi"]');
      if (await onboarding.isVisible()) await onboarding.click();
      await page.evaluate(async () => {
        const { impostaSocket } = await import('/js/socket.js');
        window.cf = { queue: [], results: [] };
        const fake = {
          connected: true, on() { return fake; }, off() { return fake; },
          emit(name, payload, ack) {
            if (name === 'mongo:connect') { window.cf.queue.push({ payload, ack }); return; }
            ack?.({ ok: true, connections: ['Locale', 'Non raggiungibile'].map(name => ({ name, label: name, dbType: 'mongodb' })), databases: [], collections: [] });
          },
          timeout() { return { emit(name, payload, ack) { fake.emit(name, payload, res => ack(null, res)); } }; },
        };
        impostaSocket(fake);
        await (await import('/js/connmanager.js')).loadSavedConnections();
        window.cf.start = async name => {
          const { connectAndOpenTab } = await import('/js/connection.js');
          connectAndOpenTab({ saved: name }).then(() => window.cf.results.push('ok')).catch(() => window.cf.results.push('error'));
        };
        window.cf.answer = ok => {
          const request = window.cf.queue.shift();
          request.ack(ok ? { ok: true, databases: [], dbType: 'mongodb', label: request.payload.saved }
            : { ok: false, error: 'Il server non risponde. Controlla host e porta.' });
        };
      });
      await page.evaluate(() => { window.cf.start('Prima'); window.cf.start('Seconda'); });
      await page.waitForFunction(() => window.cf.queue.length === 2);
      const progress = page.locator('.connection-progress');
      await progress.waitFor();
      await page.evaluate(() => window.cf.answer(true));
      assert(await progress.isVisible(), 'Il progresso resta finché una connessione è in corso');
      await page.evaluate(() => window.cf.answer(false));
      await progress.waitFor({ state: 'detached' });
      const notice = page.locator('#feedback-container .feedback-message').filter({ hasText: 'Il server non risponde' });
      await notice.waitFor();
      assert.equal(await page.locator('.illustrated-error-snackbar').count(), 0, 'Nessun dialog per un errore recuperabile');
      assert.equal(await notice.getByRole('button', { name: 'Modifica connessione' }).count(), 1);
      assert.equal(await page.locator('#toast-container [data-tone="error"]').count(), 0);
      await notice.getByRole('button', { name: 'Chiudi messaggio' }).click();
      await page.evaluate(() => window.cf.start('Terza'));
      await progress.waitFor();
      await page.evaluate(() => window.cf.answer(true));
      await progress.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#feedback-container .feedback-message').count(), 0, 'Il successo non produce un errore');
      // Lo stesso errore dal wizard resta vicino ai campi, senza coprire il form.
      await page.evaluate(async () => {
        (await import('/js/connection.js')).openConnModal();
        const { startConnection } = await import('/arc/ui.js');
        startConnection('Nuova', undefined, true)('Credenziali non valide.');
      });
      await page.locator('#connect-form .feedback-message').waitFor();
      assert.equal(await page.locator('#feedback-container .feedback-message').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`OK connessioni ${width}px: concorrenza, successo, snackbar con azione, errore inline nel wizard`);
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
