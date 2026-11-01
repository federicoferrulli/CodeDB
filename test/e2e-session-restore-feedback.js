'use strict';

// UI e ripristino reali, ACK controllati: nessuna connessione ai database utente.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3191 });
  const browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width <= 900,
        reducedMotion: 'no-preference', serviceWorkers: 'block' });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (process.argv.includes('--mutant')) await page.route('**/js/session-restore.js', async route => {
        const response = await route.fetch();
        const source = await response.text();
        const original = "const finishProgress = startProgress('Ripristino sessione in corso');";
        assert(source.includes(original), 'Il mutante deve rimuovere l’avvio della barra');
        await route.fulfill({ response, body: source.replace(original, 'const finishProgress = () => {};') });
      });
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      const onboarding = page.locator('#onboarding-overlay [data-azione="chiudi"]');
      if (await onboarding.isVisible()) await onboarding.click();
      await page.waitForFunction(() => !document.querySelector('.overlay[data-arc-dialog="closing"]'));
      await page.evaluate(async () => {
        const { impostaSocket, socketReale } = await import('/js/socket.js');
        const { tabs } = await import('/js/tabs.js');
        const { restoreSession, restoreInProgress } = await import('/js/session-restore.js');
        const real = socketReale();
        for (const name of ['connect', 'disconnect', 'connect_error']) real.removeAllListeners(name);
        real.disconnect();
        const fixture = window.restoreFeedback = { queue: [], sent: [], notices: [], samePromise: false,
          settled: false, result: null, restoreInProgress };
        document.addEventListener('codedb:toast', event => fixture.notices.push(event.detail.message));
        const fake = {
          connected: true, on() { return fake; }, off() { return fake; },
          emit(name, payload, ack) {
            fixture.sent.push({ name, payload });
            if (name === 'mongo:connect') { fixture.queue.push({ payload, ack }); return; }
            ack?.({ ok: true, databases: [], collections: [], connections: [], fields: [], docs: [] });
          },
          timeout() { return { emit(name, payload, ack) { fake.emit(name, payload, result => ack(null, result)); } }; },
        };
        impostaSocket(fake);
        fixture.begin = name => {
          tabs.list.length = 0; tabs.activeId = null;
          fixture.sent = []; fixture.queue = []; fixture.notices = [];
          fixture.settled = false; fixture.result = null;
          sessionStorage.setItem('codedb:session', JSON.stringify({ v: 1, activeId: `${name}-prima`, skippedUnsaved: 0,
            tabs: ['prima', 'seconda'].map(suffix => ({ id: `${name}-${suffix}`, connName: `Ripristino ${name} ${suffix}`,
              expandedDbs: [], activeCollId: null, collTabs: [] })) }));
          const first = restoreSession();
          fixture.samePromise = first === restoreSession();
          fixture.promise = first;
          first.then(result => { fixture.result = result; fixture.settled = true; });
        };
        fixture.answer = ok => {
          const request = fixture.queue.shift();
          if (!request) throw new Error('Nessuna connessione in attesa');
          request.ack(ok ? { ok: true, databases: [], dbType: 'mongodb', label: request.payload.saved }
            : { ok: false, error: 'Lettura della connessione salvata negata.' });
        };
        fixture.withoutSnapshot = () => {
          sessionStorage.removeItem('codedb:session');
          fixture.progressInserted = false;
          const inspect = records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (node.matches?.('.connection-progress') || node.querySelector?.('.connection-progress')) fixture.progressInserted = true;
            }
          };
          const observer = new MutationObserver(inspect);
          observer.observe(document.body, { childList: true, subtree: true });
          fixture.promise = restoreSession().finally(() => { inspect(observer.takeRecords()); observer.disconnect(); });
        };
      });
      const progress = page.locator('.connection-progress');
      const restoreProgress = page.getByRole('progressbar', { name: 'Ripristino sessione in corso', exact: true });
      const start = name => page.evaluate(name => window.restoreFeedback.begin(name), name);
      const answer = ok => page.evaluate(ok => window.restoreFeedback.answer(ok), ok);
      const pending = () => page.waitForFunction(() => window.restoreFeedback.queue.length === 1);
      const settled = () => page.waitForFunction(() => window.restoreFeedback.settled);
      const noRestoreToast = async () => {
        assert(!(await page.evaluate(() => window.restoreFeedback.notices)).some(message => /Ripristino della sessione in corso/.test(message)),
          'Il progresso della sessione non viene più mostrato con un toast');
      };

      await start('completo');
      await pending();
      await restoreProgress.waitFor();
      assert.equal(await progress.count(), 1);
      assert.equal(await page.evaluate(() => window.restoreFeedback.samePromise), true, 'I ripristini concorrenti condividono la stessa Promise');
      assert.equal(await page.evaluate(() => window.restoreFeedback.restoreInProgress()), true);
      await noRestoreToast();
      assert.equal(await progress.evaluate(el => getComputedStyle(el, '::before').animationName), 'connection-progress', 'Il progresso scorre normalmente');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await progress.evaluate(el => ({ animation: getComputedStyle(el, '::before').animationName,
        fill: parseFloat(getComputedStyle(el, '::before').width), width: el.getBoundingClientRect().width }));
      assert.equal(reduced.animation, 'none');
      assert(Math.abs(reduced.fill - reduced.width) <= 1, 'Con movimento ridotto la barra piena resta visibile');
      await answer(true);
      await pending();
      assert(await restoreProgress.isVisible(), 'La barra rimane fra gli ACK delle due connessioni');
      assert.equal(await page.evaluate(() => window.restoreFeedback.sent.filter(event => event.name === 'mongo:connect').length), 2, 'Nessuna connessione duplicata');
      await answer(true);
      await settled();
      await progress.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.restoreFeedback.result), true);
      assert.equal(await page.evaluate(() => window.restoreFeedback.restoreInProgress()), false);
      await noRestoreToast();

      await start('parziale');
      await restoreProgress.waitFor(); await pending();
      await answer(false);
      await pending();
      const partialError = page.locator('.feedback-message').filter({ hasText: 'Lettura della connessione salvata negata.' });
      await partialError.waitFor();
      assert(await restoreProgress.isVisible(), 'L’errore di una connessione non interrompe il ripristino delle altre');
      await answer(true); await settled();
      await progress.waitFor({ state: 'detached' });
      assert(await partialError.isVisible(), 'L’errore parziale resta consultabile dopo la fine del progresso');
      await partialError.getByRole('button', { name: 'Chiudi messaggio', exact: true }).click();
      await noRestoreToast();

      await page.evaluate(async () => { window.restoreManualEnd = (await import('/arc/ui.js')).startConnection('Manuale'); });
      await start('sovrapposto');
      await pending();
      assert.equal(await progress.count(), 1, 'Ripristino e connessione manuale condividono una sola barra');
      assert(/ripristino/i.test(await progress.getAttribute('aria-label')), 'Il nome accessibile include il ripristino attivo');
      await answer(true); await pending(); await answer(true); await settled();
      assert.equal(await progress.count(), 1, 'La conclusione del ripristino non rimuove il progresso della connessione manuale');
      assert.equal(await progress.getAttribute('aria-label'), 'Connessione in corso');
      await page.evaluate(() => window.restoreManualEnd());
      await progress.waitFor({ state: 'detached' });

      const previousConnections = await page.evaluate(() => window.restoreFeedback.sent.filter(event => event.name === 'mongo:connect').length);
      await page.evaluate(() => window.restoreFeedback.withoutSnapshot());
      assert.equal(await page.evaluate(() => window.restoreFeedback.promise), false, 'Nessuno snapshot non avvia un ripristino');
      assert.equal(await progress.count(), 0);
      assert.equal(await page.evaluate(() => window.restoreFeedback.progressInserted), false, 'Nessuna comparsa momentanea della barra senza snapshot');
      assert.equal(await page.evaluate(() => window.restoreFeedback.sent.filter(event => event.name === 'mongo:connect').length), previousConnections);
      await noRestoreToast();
      assert.deepEqual(errors, [], 'Nessun errore JavaScript');
      await page.close();
      console.log(`OK ripristino sessione ${width}px: progresso condiviso, ACK sequenziali, errore parziale, concorrenza, movimento ridotto e snapshot assente`);
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
