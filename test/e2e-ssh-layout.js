'use strict';

// Form e controlli Arc reali, su un server con configurazione e vault isolati.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { scegliArc, spuntaArc } = require('./arc-controls');

const mutant = process.argv.includes('--mutant');
const reportDir = path.join(process.env.CODEDB_REPORT_ROOT || 'test-reports', 'ssh-layout', mutant ? 'mutante' : 'dopo');
const sizes = [[1440, 1000], [1024, 768], [390, 844], [320, 640], [844, 390]];

(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const server = await startTestServer({ port: Number(process.env.E2E_PORT) || 3198 });
  let browser;
  const report = { layouts: [], errors: [] };
  try {
    browser = await chromium.launch();
    for (const theme of ['dark', 'light']) for (const [width, height] of sizes) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: width <= 900 });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.route('https://fonts.googleapis.com/**', route => route.abort());
      await page.addInitScript(({ theme, version }) => {
        localStorage.setItem('codedb:tema', theme);
        localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true }));
      }, { theme, version: require('../package.json').version });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('html[data-arc-ready="true"]');
      await page.evaluate(async () => (await import('/js/connection.js')).openConnModal());
      await spuntaArc(page, '#conn-ssh-toggle', true);
      await page.locator('#wizard-next-btn').click();
      const field = name => page.locator(`#connect-form [name="${name}"]`);
      const modal = page.locator('#connect-overlay .modal');
      const summary = page.locator('.ssh-verification-details summary');
      const geometry = async () => modal.evaluate(modal => {
        const panel = modal.querySelector('.ssh-panel');
        const rect = modal.getBoundingClientRect();
        const outside = [...panel.querySelectorAll('input, button, summary, [role="combobox"]')]
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .filter(el => { const r = el.getBoundingClientRect(); return r.left < rect.left - 1 || r.right > rect.right + 1; })
          .map(el => el.name || el.id || el.textContent.trim());
        return { width: rect.width, height: rect.height, scrollHeight: modal.scrollHeight, clientHeight: modal.clientHeight,
          overflow: modal.scrollWidth > modal.clientWidth + 1, outside };
      });
      if (mutant) await page.addStyleTag({ content: '.ssh-local-address input { min-width: 900px !important; }' });
      const initial = await geometry();
      assert(!initial.overflow && !initial.outside.length, `Campi fuori dal pannello a ${width}×${height}: ${JSON.stringify(initial)}`);
      if (width === 1440) assert(initial.scrollHeight <= initial.clientHeight + 1, 'Il pannello SSH compatto deve stare interamente nel desktop alto 1000px');
      const steps = await page.locator('.wizard-step-badge').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
      assert(Math.max(...steps) - Math.min(...steps) < 2, 'I tre passi restano allineati anche sullo schermo più stretto');
      const inputHeight = (await field('sshUser').boundingBox()).height;
      const selectHeight = (await page.locator('.ssh-panel [role="combobox"]').boundingBox()).height;
      assert(Math.abs(inputHeight - selectHeight) < 1, 'Campo utente e selettore di autenticazione devono avere la stessa altezza');
      const prefix = `${theme}-${width}x${height}`;
      await modal.evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: path.join(reportDir, `${prefix}.png`) });
      await summary.focus();
      await summary.press('Enter');
      assert(await page.locator('.ssh-verification-details').evaluate(el => el.open), 'La spiegazione si apre dalla tastiera');
      assert.match(await page.locator('.ssh-verification-details p').innerText(), /modalità rigorosa/);
      await summary.press('Space');
      assert(!await page.locator('.ssh-verification-details').evaluate(el => el.open), 'La spiegazione si richiude dalla tastiera');
      if (width <= 900) assert((await summary.boundingBox()).height >= 44, 'I dettagli hanno un bersaglio touch di almeno 44px');

      await field('sshHost').fill('bastion.example.com');
      await field('sshUser').fill('utente-prova');
      await field('sshPassword').fill('password-di-prova');
      const pin = 'SHA256:esempio-di-impronta-verificata';
      await field('sshHostKey').fill(pin);
      await field('sshLocalPort').fill('15432');
      assert.equal(await page.getByRole('spinbutton', { name: 'Porta locale', exact: true }).inputValue(), '15432', 'La porta conserva una etichetta accessibile');
      for (const mode of ['upload', 'path', 'password']) {
        await scegliArc(page, '#conn-ssh-auth', mode);
        assert.equal(await page.locator('#conn-ssh-password-row').isVisible(), mode === 'password');
        assert.equal(await page.locator('#conn-ssh-upload-row').isVisible(), mode === 'upload');
        assert.equal(await page.locator('#conn-ssh-path-row').isVisible(), mode === 'path');
        assert.equal(await page.locator('#conn-ssh-passphrase-row').isVisible(), mode !== 'password');
        if (mode === 'path') await field('sshKeyFile').fill('~/.ssh/id_ed25519');
        const layout = await geometry();
        assert(!layout.overflow && !layout.outside.length, `La modalità ${mode} non deve tagliare campi a ${prefix}`);
      }
      assert.equal(await field('sshPassword').inputValue(), 'password-di-prova');
      for (const port of ['0', '65536']) {
        await field('sshLocalPort').fill(port);
        await page.locator('#connect-btn').click();
        assert(await page.locator('.ssh-panel').isVisible(), 'Una porta fuori intervallo non avanza al riepilogo');
        assert(!await field('sshLocalPort').evaluate(el => el.checkValidity()));
      }
      await field('sshLocalPort').fill('15432');
      await page.locator('#conn-test-btn').scrollIntoViewIfNeeded();
      assert(await page.locator('#conn-test-btn').isEnabled(), 'Il test connessione resta raggiungibile');
      await page.locator('#connect-btn').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(reportDir, `${prefix}-azioni.png`) });
      await page.locator('#connect-btn').click();
      assert.match(await page.locator('#wizard-summary-box').innerText(), /127\.0\.0\.1:15432/);
      await page.locator('#wizard-prev-btn').click();
      assert.equal(await field('sshHostKey').inputValue(), pin, 'La navigazione conserva l’impronta');
      assert.equal(await field('sshLocalPort').inputValue(), '15432', 'La navigazione conserva la porta');
      await field('sshLocalPort').fill('');
      await page.locator('#connect-btn').click();
      assert(!/127\.0\.0\.1:15432/.test(await page.locator('#wizard-summary-box').innerText()), 'Svuotare la porta disattiva il forwarding nel riepilogo');
      report.layouts.push({ theme, viewport: { width, height }, modal: initial });
      await page.locator('#conn-cancel-btn').click();
      await context.close();
    }
    assert.deepEqual(report.errors, [], 'Nessun errore JavaScript nel percorso');
    fs.writeFileSync(path.join(reportDir, 'risultati.json'), JSON.stringify(report, null, 2));
    console.log(`OK: ${report.layouts.length} combinazioni di tema e viewport; tastiera, tre autenticazioni, validazione, riepilogo e conservazione dei valori. Screenshot: ${reportDir}`);
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
