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
        window.cf.answer = (ok, error = 'Il server non risponde. Controlla host e porta.') => {
          const request = window.cf.queue.shift();
          request.ack(ok ? { ok: true, databases: [], dbType: 'mongodb', label: request.payload.saved }
            : { ok: false, error });
        };
      });
      await page.evaluate(() => { window.cf.start('Prima'); window.cf.start('Seconda'); });
      await page.waitForFunction(() => window.cf.queue.length === 2);
      const progress = page.locator('.connection-progress');
      await progress.waitFor();
      await page.evaluate(() => window.cf.answer(true));
      assert(await progress.isVisible(), 'Il progresso resta finché una connessione è in corso');
      await page.waitForFunction(() => window.cf.results.includes('ok'));
      const misuraLayout = () => page.evaluate(() => Object.fromEntries(
        ['#app', '#navigator', '#navigator-tools', '.main-area'].map(selector => {
          const { top, bottom } = document.querySelector(selector).getBoundingClientRect();
          return [selector, { top, bottom }];
        })
      ));
      const layout = await misuraLayout();
      assert.equal(layout['#app'].bottom, page.viewportSize().height);
      await page.evaluate(() => window.cf.answer(false, 'Il server non risponde. Controlla host e porta. (dettaglio tecnico: ECONNREFUSED)'));
      await progress.waitFor({ state: 'detached' });
      const notice = page.locator('#feedback-container .feedback-message').filter({ hasText: 'Il server non risponde' });
      await notice.waitFor();
      assert.equal(await page.locator('.illustrated-error-snackbar').count(), 0, 'Nessun dialog per un errore recuperabile');
      assert.equal(await notice.getByRole('button', { name: 'Modifica connessione' }).count(), 1);
      assert.equal(await page.locator('#toast-container [data-tone="error"]').count(), 0);
      assert.deepEqual(await misuraLayout(), layout, 'La notifica di connessione conserva la geometria del workspace e del navigatore');
      await notice.getByText('Mostra altro', { exact: true }).click();
      assert(await notice.getByText('ECONNREFUSED', { exact: true }).isVisible());
      assert.deepEqual(await misuraLayout(), layout, 'Espandere il dettaglio conserva la geometria');
      await notice.getByRole('button', { name: 'Chiudi messaggio' }).click();
      assert.deepEqual(await misuraLayout(), layout, 'Chiudere la notifica conserva la geometria');
      await page.evaluate(() => window.cf.start('Terza'));
      await progress.waitFor();
      await page.evaluate(() => window.cf.answer(true));
      await progress.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#feedback-container .feedback-message').count(), 0, 'Il successo non produce un errore');
      await page.evaluate(async () => (await import('/js/connection.js')).openConnModal());
      const confirm = page.locator('#connect-btn');
      await confirm.click();
      await page.locator('#connect-form [name="saveAs"]').fill('Nuova');
      await confirm.click();
      await page.waitForFunction(() => window.cf.queue.length === 1);
      const panel = page.locator('#connect-overlay .modal');
      const height = await panel.evaluate(el => el.scrollHeight);
      await page.evaluate(() => window.cf.answer(false, 'Connessione rifiutata su localhost:27017. Cosa fare: verifica che il database sia avviato e che host e porta siano corretti. (dettaglio tecnico: ECONNREFUSED)'));
      await progress.waitFor({ state: 'detached' });
      const wizardError = page.locator('#feedback-container [role="alert"]').filter({ hasText: 'Nuova' });
      await wizardError.waitFor({ timeout: 4000 });
      assert.equal(await panel.evaluate(el => el.scrollHeight), height, 'L’errore non allunga il pannello');
      assert.equal(await page.locator('#connect-form [role="alert"]:visible').count(), 0);
      assert.equal(await wizardError.getByRole('button', { name: 'Modifica connessione' }).count(), 0);
      assert.equal(await wizardError.locator('.feedback-hint').count(), 0, 'Il rimedio del server è già nel messaggio');
      const dismiss = wizardError.getByRole('button', { name: 'Chiudi messaggio' });
      assert(await dismiss.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), 'Il messaggio è subito visibile e raggiungibile senza scorrere');
      await wizardError.getByText('Mostra altro', { exact: true }).click();
      assert(await wizardError.getByText('ECONNREFUSED', { exact: true }).isVisible());
      assert(await wizardError.getByRole('button', { name: 'Copia errore' }).isVisible());
      assert.equal(await panel.evaluate(el => el.scrollHeight), height);
      await dismiss.click();
      assert.equal(await page.locator('#connect-form [name="saveAs"]').inputValue(), 'Nuova');
      assert(await confirm.isEnabled());
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`OK connessioni ${width}px: concorrenza, successo, notifica fuori dal form e riepilogo conservato`);
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
