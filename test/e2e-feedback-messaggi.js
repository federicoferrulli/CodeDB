'use strict';

// Componenti reali su browser; le risposte DB sono controllate e non scrivono dati utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  let mutantBundle;
  if (process.argv.includes('--mutant') || process.argv.includes('--mutant-copy') || process.argv.includes('--mutant-copy-timer')) {
    const { build } = require('esbuild');
    const result = await build({ entryPoints: ['ui/main.tsx'], bundle: true, minify: true, write: false, outdir: 'public/arc', format: 'esm', jsx: 'automatic', loader: { '.webp': 'dataurl' },
      plugins: [{ name: 'regressione-timer', setup(builder) {
        builder.onLoad({ filter: /(?:notifiche|copia-errore)\.tsx$/ }, args => {
          const timer = process.argv.includes('--mutant-copy-timer');
          if (!args.path.endsWith(timer ? 'copia-errore.tsx' : 'notifiche.tsx')) return;
          const source = fs.readFileSync(args.path, 'utf8');
          const copy = process.argv.includes('--mutant-copy');
          const original = timer ? 'setCopied(false), 1000' : copy ? '[f.titolo, f.message, f.hint]' : "if (f.tipo !== 'avviso' || paused) return;";
          assert(source.includes(original), 'Il mutante deve alterare il codice verificato');
          return { contents: source.replace(original, timer ? 'setCopied(false), 10000' : copy ? '[f.titolo, "Messaggio troncato", f.hint]' : 'if (paused) return;'), loader: 'tsx' };
        });
      } }] });
    mutantBundle = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  }
  const server = await startTestServer({ port: 3189 });
  const browser = await chromium.launch();
  const dir = 'test-reports/feedback-messaggi';
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width <= 900, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (mutantBundle) await page.route('**/arc/ui.js', async route => {
        // Il test deve rifiutare la regressione: gli errori tornano a scadere come gli avvisi.
        await route.fulfill({ contentType: 'text/javascript', body: mutantBundle });
      });
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      const onboarding = page.locator('#onboarding-overlay [data-azione="chiudi"]');
      if (await onboarding.isVisible()) await onboarding.click();
      await page.clock.install();
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.id = 'feedback-prova';
        form.style.cssText = 'position:fixed;top:80px;left:16px;width:260px;z-index:15000;background:var(--surface)';
        form.innerHTML = '<label>Destinazione<input id="feedback-valore" aria-describedby="feedback-aiuto"></label><p id="feedback-aiuto">Nome del database</p>';
        document.body.append(form);
        document.getElementById('feedback-valore').focus();
        window.feedbackActions = 0;
      });
      const notify = (message, options = {}) => page.evaluate(async ({ message, options }) => {
        const { notifica } = await import('/js/avvisi.js');
        if (options.id === 'persistente') document.getElementById('feedback-valore').focus();
        notifica(message, options);
      }, { message, options });
      const messages = page.locator('#feedback-container .feedback-message');

      await notify('Connessione rifiutata. Controlla host e porta. (dettaglio tecnico: ECONNREFUSED ::1:27017)', { titolo: 'Connessione non riuscita', id: 'persistente' });
      const first = messages.filter({ hasText: 'Connessione rifiutata' });
      await first.waitFor();
      assert.equal(await page.locator('#feedback-valore').evaluate(el => el === document.activeElement), true, 'La snackbar non sottrae il focus');
      assert.equal(await page.getByRole('dialog', { name: 'Connessione non riuscita' }).count(), 0);
      assert.equal(await first.locator('details').getAttribute('open'), null);
      const copiedText = 'Connessione non riuscita\n\nConnessione rifiutata. Controlla host e porta. (dettaglio tecnico: ECONNREFUSED ::1:27017)';
      const copyButton = first.getByRole('button', { name: 'Copia errore', exact: true });
      const copyError = () => width <= 900 ? copyButton.tap() : copyButton.click();
      await copyError();
      await first.getByRole('status').filter({ hasText: 'Messaggio copiato.' }).waitFor({ state: 'attached' });
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), copiedText, 'Copia completa, inclusi i dettagli ancora chiusi');
      await copyButton.locator('span:not([aria-hidden="true"]) > .lucide-check').waitFor();
      assert.equal(await first.getByRole('status').getAttribute('class'), 'visually-hidden', 'La conferma non aggiunge testo visibile');
      await page.clock.runFor(500);
      assert.equal(await copyButton.locator('span:not([aria-hidden="true"]) > .lucide-check').count(), 1, 'Il check resta durante il primo mezzo secondo');
      await page.clock.runFor(600);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await copyButton.locator('span:not([aria-hidden="true"]) > .lucide-copy').count(), 1, 'Dopo un secondo torna l’icona Copia');
      assert.equal(await copyButton.locator('span:not([aria-hidden="true"]) > .lucide-check').count(), 0, 'Dopo un secondo torna l’icona Copia');

      assert.equal(await first.locator('details').getAttribute('open'), null);
      const copyBounds = await copyButton.boundingBox();
      assert(copyBounds.width >= 44 && copyBounds.height >= 44);
      await page.evaluate(() => {
        window.savedClipboard = navigator.clipboard;
        window.savedExecCommand = document.execCommand;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      });
      await copyError();
      await first.getByRole('status').filter({ hasText: 'Messaggio copiato.' }).waitFor({ state: 'attached' });
      assert.equal((await page.evaluate(() => window.savedClipboard.readText())).replace(/\r\n/g, '\n'), copiedText, 'Fallback reale senza Clipboard API');
      assert.equal(await first.locator('textarea').count(), 0, 'Il controllo temporaneo viene rimosso');
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permesso negato'); } } });
      });
      await copyError();
      await first.getByRole('status').filter({ hasText: 'Messaggio copiato.' }).waitFor({ state: 'attached' });
      assert.equal((await page.evaluate(() => window.savedClipboard.readText())).replace(/\r\n/g, '\n'), copiedText, 'Fallback anche dopo il rifiuto dell’API');
      await page.evaluate(() => { document.execCommand = () => false; });
      await copyError();
      await first.getByRole('status').filter({ hasText: 'Copia non riuscita.' }).waitFor();
      assert.equal(await first.getByText('Messaggio copiato.', { exact: true }).count(), 0, 'Un rifiuto non viene dichiarato come successo');
      await page.evaluate(() => { delete navigator.clipboard; document.execCommand = window.savedExecCommand; });
      assert.equal(await first.locator('summary').textContent(), 'Mostra altro');
      await first.locator('summary').click();
      await page.waitForFunction(() => document.querySelector('#feedback-container summary')?.textContent === 'Mostra meno');
      assert(await first.getByText(/ECONNREFUSED/).isVisible());
      await page.locator('#feedback-valore').focus();
      await page.mouse.move(0, 0);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.clock.runFor(13000);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(await first.isVisible(), 'Gli errori non scadono dopo 12 secondi');
      await page.evaluate(async () => (await import('/js/avvisi.js')).toast('Operazione riuscita'));
      await page.locator('#toast-container').getByText('Operazione riuscita').waitFor();
      assert(await first.isVisible(), 'Il successo successivo non sostituisce l’errore');
      await notify('Due righe aggiornate, una fallita: controlla i dati prima di riprovare.', { titolo: 'Scrittura parziale' });
      assert.equal(await messages.count(), 2, 'Gli errori indipendenti vengono conservati');
      assert.equal(await messages.filter({ hasText: 'Scrittura parziale' }).getByRole('button', { name: 'Riprova', exact: true }).count(), 0, 'Nessun nuovo tentativo automatico di scrittura');
      await page.clock.runFor(13000);
      await page.evaluate(async () => (await import('/js/theme.js')).applicaTema('dark'));
      await page.screenshot({ path: `${dir}/${width}-dark.png` });
      const box = await page.locator('#feedback-container').boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900, 'Messaggi entro il viewport');
      const close = await first.getByRole('button', { name: 'Chiudi messaggio' }).boundingBox();
      assert(close.width >= 44 && close.height >= 44, 'Bersaglio touch della chiusura');
      await page.evaluate(async () => (await import('/js/theme.js')).applicaTema('light'));
      await page.screenshot({ path: `${dir}/${width}-light.png` });
      while (await messages.count()) await messages.first().getByRole('button', { name: 'Chiudi messaggio' }).click();

      await notify('Indica la destinazione.', { tipo: 'inline', target: '#feedback-valore' });
      const local = page.locator('#feedback-prova .feedback-message');
      await local.waitFor();
      assert.equal(await messages.count(), 0);
      assert.equal(await page.locator('#feedback-valore').getAttribute('aria-invalid'), 'true');
      assert((await page.locator('#feedback-valore').getAttribute('aria-describedby')).includes('feedback-aiuto'));
      await notify('Destinazione non valida.', { tipo: 'inline', target: '#feedback-valore' });
      assert.equal(await local.count(), 1, 'Un solo errore per campo');
      await page.locator('#feedback-valore').fill('database_prova');
      assert.equal(await local.count(), 0, 'La correzione rimuove il messaggio locale');
      assert.equal(await page.locator('#feedback-valore').getAttribute('aria-invalid'), null);
      assert.equal(await page.locator('#feedback-valore').getAttribute('aria-describedby'), 'feedback-aiuto');
      await page.locator('#feedback-valore').evaluate(el => el.setAttribute('aria-invalid', 'true'));
      await notify('Un secondo controllo sul campo.', { tipo: 'inline', target: '#feedback-valore' });
      await local.getByRole('button', { name: 'Chiudi messaggio' }).click();
      assert.equal(await page.locator('#feedback-valore').getAttribute('aria-invalid'), 'true', 'La chiusura conserva la validazione di altri controlli');
      await page.locator('#feedback-valore').evaluate(el => el.removeAttribute('aria-invalid'));

      await page.evaluate(async () => {
        const { chiediTesto } = await import('/js/utils.js');
        window.promptResult = 'attesa';
        chiediTesto({ titolo: 'Larghezza colonna', valore: '32', valida: text => Number(text) >= 64 && Number(text) <= 1600 ? null : 'Inserisci una larghezza fra 64 e 1600 pixel.' }).then(result => { window.promptResult = result; });
      });
      await page.locator('#askinput-ok').click();
      assert.equal(await page.evaluate(() => window.promptResult), 'attesa', 'Un valore non valido non chiude il form');
      assert(await page.getByText('Inserisci una larghezza fra 64 e 1600 pixel.', { exact: true }).first().isVisible());
      await page.locator('#askinput-value').fill('120');
      await page.locator('#askinput-ok').click();
      assert.equal(await page.evaluate(() => window.promptResult), '120');

      await page.evaluate(async () => {
        (await import('/js/avvisi.js')).notifica('Caricamento non riuscito.', { tipo: 'vista', target: '#feedback-prova',
          onAction: async () => { window.feedbackActions++; if (window.feedbackActions === 1) throw new Error('Servizio ancora assente.'); } });
      });
      const recoveryBounds = await local.getByRole('button', { name: 'Riprova', exact: true }).boundingBox();
      const adjacentCopy = await local.getByRole('button', { name: 'Copia errore', exact: true }).boundingBox();
      assert(adjacentCopy.x >= recoveryBounds.x + recoveryBounds.width && Math.abs(adjacentCopy.y - recoveryBounds.y) < 2, 'Copia a destra dell’azione sulla stessa riga');
      await page.locator('#feedback-prova').getByRole('button', { name: 'Riprova', exact: true }).click();
      assert(await page.getByText('Servizio ancora assente.', { exact: true }).isVisible());
      await page.locator('#feedback-prova').getByRole('button', { name: 'Riprova', exact: true }).click();
      assert.equal(await page.evaluate(() => window.feedbackActions), 2);
      assert.equal(await local.count(), 0, 'Tentativo riuscito chiude lo stato di errore');

      await notify('Errore durante il ridisegno.', { tipo: 'inline', target: '#feedback-valore' });
      await page.evaluate(() => {
        const form = document.getElementById('feedback-prova');
        const replacement = form.cloneNode(true);
        replacement.querySelector('.feedback-host').remove();
        form.replaceWith(replacement);
      });
      await messages.filter({ hasText: 'Errore durante il ridisegno.' }).waitFor();
      await messages.filter({ hasText: 'Errore durante il ridisegno.' }).getByRole('button', { name: 'Chiudi messaggio' }).click();

      // Due pannelli con gli stessi ID non devono sostituire gli errori l’uno dell’altro.
      for (const name of ['pannello-uno', 'pannello-due']) {
        await page.evaluate(name => {
          const frame = document.createElement('iframe');
          frame.name = name; frame.codedbPanel = true;
          frame.style.cssText = 'position:fixed;left:0;top:200px;width:280px;height:100px';
          frame.srcdoc = '<form id="locale"><input aria-label="Valore"></form>';
          document.body.append(frame);
        }, name);
        const frame = await (await page.locator(`iframe[name="${name}"]`).elementHandle()).contentFrame();
        await frame.waitForSelector('#locale');
        await frame.evaluate(async ({ origin, name }) => {
          (await import(`${origin}/js/avvisi.js`)).notifica(name, { tipo: 'inline', target: '#locale', id: 'stesso-id' });
        }, { origin: server.url, name });
      }
      assert.equal(await page.frame({ name: 'pannello-uno' }).locator('.feedback-message').count(), 1);
      assert.equal(await page.frame({ name: 'pannello-due' }).locator('.feedback-message').count(), 1);
      assert.equal(await messages.count(), 0);
      await page.frame({ name: 'pannello-uno' }).evaluate(async origin => (await import(`${origin}/js/avvisi.js`)).chiudiNotifica('stesso-id'), server.url);
      assert.equal(await page.frame({ name: 'pannello-uno' }).locator('.feedback-message').count(), 0);
      assert.equal(await page.frame({ name: 'pannello-due' }).locator('.feedback-message').count(), 1);
      await page.evaluate(() => document.querySelectorAll('iframe[name^="pannello-"]').forEach(frame => frame.remove()));

      await notify('Seleziona almeno una riga.', { tipo: 'avviso' });
      const warning = messages.filter({ hasText: 'Seleziona almeno' });
      await warning.getByRole('button').focus();
      await page.clock.runFor(10000);
      assert(await warning.isVisible(), 'Il focus sospende la scadenza dell’avviso');
      await page.locator('#feedback-valore').focus();
      await page.mouse.move(0, 0);
      await page.clock.runFor(9000);
      assert.equal(await warning.count(), 0);
      await page.locator('#feedback-prova').evaluate(el => el.remove());

      await page.evaluate(async () => {
        (await import('/js/avvisi.js')).notifica('Collegamento al server interrotto.', { tipo: 'banner', id: 'rete', onAction: () => { window.feedbackActions++; } });
      });
      const banner = page.locator('.feedback-banner');
      await banner.getByRole('button', { name: 'Riprova', exact: true }).click();
      assert(await banner.isVisible(), 'Il banner resta fino all’effettiva riconnessione');
      await page.evaluate(async () => (await import('/js/avvisi.js')).chiudiNotifica('rete'));
      assert.equal(await banner.count(), 0);
      await notify('Errore di una vista non più visibile.', { tipo: 'inline', target: '#inesistente' });
      assert(await messages.filter({ hasText: 'vista non più visibile' }).isVisible(), 'L’errore tardivo rimane consultabile');
      await page.setViewportSize({ width: 320, height: 480 });
      await notify('Il caricamento non è riuscito. Controlla la connessione e riprova. '.repeat(40), { titolo: 'Messaggio lungo' });
      await page.evaluate(() => {
        Object.defineProperties(window.visualViewport, { height: { configurable: true, value: 260 }, offsetTop: { configurable: true, value: 30 } });
        window.visualViewport.dispatchEvent(new Event('resize'));
        window.visualViewport.dispatchEvent(new Event('scroll'));
      });
      await page.clock.runFor(100);
      const keyboard = await page.locator('#feedback-container').boundingBox();
      assert(keyboard.x >= 0 && keyboard.x + keyboard.width <= 320 && keyboard.y >= 30 && keyboard.y + keyboard.height <= 290, 'Snackbar entro l’area visibile con tastiera e pan');
      await messages.filter({ hasText: 'Messaggio lungo' }).getByRole('button', { name: 'Chiudi messaggio' }).click();
      assert.deepEqual(errors, [], 'Nessun errore JavaScript');
      await page.close();
      console.log(`OK ${width}px: persistenza, concorrenza, dettagli, focus, inline, validazione, recupero, avvisi, banner e temi`);
    }
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
