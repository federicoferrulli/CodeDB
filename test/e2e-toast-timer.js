'use strict';

// Timer reali del componente, con orologio controllato e server isolato.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  let mutantBundle;
  if (process.argv.includes('--mutant')) {
    const { build } = require('esbuild');
    const fs = require('node:fs');
    const result = await build({ entryPoints: ['ui/main.tsx'], bundle: true, minify: true, write: false, outdir: 'public/arc', format: 'esm', jsx: 'automatic', loader: { '.webp': 'dataurl' },
      plugins: [{ name: 'regressione-timer-toast', setup(builder) {
        builder.onLoad({ filter: /toast\.tsx$/ }, args => {
          const source = fs.readFileSync(args.path, 'utf8');
          assert(source.includes('[visible, duration]'), 'Il mutante deve alterare il timer verificato');
          return { contents: source.replace('[visible, duration]', '[visible, onOpenChange, duration]'), loader: 'tsx' };
        });
      } }] });
    mutantBundle = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  }
  const server = await startTestServer();
  let browser;
  try {
    browser = await chromium.launch();
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (mutantBundle) await page.route('**/arc/ui.js', route => route.fulfill({ contentType: 'text/javascript', body: mutantBundle }));
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      await page.clock.install();
      const show = (message, duration = 3500) => page.evaluate(async ({ message, duration }) => {
        (await import('/js/utils.js')).showToast(message, 'success', duration);
      }, { message, duration });
      const toast = message => page.locator('#toast-container').getByText(message, { exact: true });

      await page.evaluate(async () => (await import('/js/avvisi.js')).toast('Toast semplice'));
      await toast('Toast semplice').waitFor();
      await page.clock.runFor(3200);
      assert.equal(await toast('Toast semplice').count(), 0, 'Il toast semplice scade dopo 3 secondi');

      await show('Primo messaggio');
      await toast('Primo messaggio').waitFor();
      await page.clock.runFor(3000);
      await show('Secondo messaggio', 10000);
      await toast('Secondo messaggio').waitFor();
      await page.clock.runFor(700);
      assert.equal(await toast('Primo messaggio').count(), 0, 'Un nuovo toast non deve rinviare la scadenza di quelli precedenti');
      assert(await toast('Secondo messaggio').isVisible(), 'Ogni toast conserva la propria durata');

      await show('Chiusura manuale', 10000);
      await toast('Chiusura manuale').waitFor();
      await page.clock.runFor(5800);
      await toast('Chiusura manuale').locator('xpath=ancestor::*[@role="status"]').getByRole('button', { name: 'Chiudi notifica' }).click();
      await page.clock.runFor(3700);
      assert.equal(await toast('Secondo messaggio').count(), 0, 'Chiudere un toast non deve riavviare il timer degli altri');
      assert.deepEqual(errors, [], 'Nessun errore JavaScript');
      console.log(`OK: scadenza automatica e timer indipendenti (${width}px)`);
      await page.close();
    }
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
