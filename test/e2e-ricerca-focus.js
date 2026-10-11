'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const mutantShortcut = process.argv.includes('--mutant-shortcut');
const dir = `${process.env.CODEDB_REPORT_ROOT || 'test-reports/ricerca-focus-2026-10-11'}/ricerca${mutant ? '-mutante' : mutantShortcut ? '-richiamo-mutante' : ''}`;
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const server = await startTestServer({ port: 3192 }), browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  const report = { checks: [], errors: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    if (mutant) await page.route('**/arc/ui.js', async route => {
      const response = await route.fetch(), code = await response.text(), guard = '.id!=="palette-overlay"';
      assert.equal(code.split(guard).length, 2, 'Una sola condizione per la chiusura esterna della palette');
      await route.fulfill({ response, body: code.replace(guard, '.id') });
    });
    if (mutantShortcut) await page.route('**/js/palette.js', async route => {
      const response = await route.fetch(), code = await response.text();
      const update = "pulsante.querySelector('kbd').textContent = richiamo";
      assert(code.includes(update));
      await route.fulfill({ response, body: code.replace(update, "pulsante.querySelector('kbd').textContent = 'Ctrl+P'") });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]', { timeout: 30000 });
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    for (const theme of ['dark', 'light']) for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      await page.mouse.move(0, 100);
      await page.locator('.header').screenshot({ path: `${dir}/header-${theme}-${width}.png`, animations: 'disabled' });
      const box = await page.locator('#command-palette-open').boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width, `${theme}, ${width}: ricerca entro la testata`);
      assert.equal(await page.locator('#command-palette-open kbd').isVisible(), width > 900);
      if (width <= 900) assert(box.width >= 44 && box.height >= 44, 'Area touch minima');
      if (width === 1440) {
        await page.locator('#command-palette-open').hover();
        await page.locator('.header').screenshot({ path: `${dir}/header-${theme}-hover.png`, animations: 'disabled' });
        await page.mouse.move(0, 100);
        await page.locator('#command-palette-open').focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await page.locator('.header').screenshot({ path: `${dir}/header-${theme}-focus.png`, animations: 'disabled' });
        assert(await page.locator('#command-palette-open').evaluate(el => el.matches(':focus-visible')));
        await page.locator('#command-palette-open').evaluate(el => el.blur());
      }
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    for (const [width, height] of [[1440, 900], [390, 844], [320, 650], [844, 390]]) {
      await page.setViewportSize({ width, height });
      for (const close of ['Escape', 'Control+p', 'esterno', 'pulsante']) {
        report.phase = `${width}×${height}, ${close}`;
        if (close === 'Control+p') { await page.locator('#command-palette-open').focus(); await page.keyboard.press('Control+p'); }
        else await page.locator('#command-palette-open').click();
        await page.locator('#palette-overlay [role="dialog"]').waitFor();
        await page.waitForTimeout(200);
        assert(await page.locator('#palette-input').evaluate(el => document.activeElement === el), `${report.phase}: focus automatico nella ricerca`);
        await page.keyboard.type('tema');
        assert.equal(await page.locator('#palette-input').inputValue(), 'tema');
        if (close === 'pulsante') {
          await page.screenshot({ path: `${dir}/ricerca-${width}.png` });
          await page.locator('#palette-overlay').getByRole('button', { name: width > 900 ? 'Chiudi ricerca' : 'Chiudi finestra', exact: true }).click();
        } else if (close === 'esterno') await page.mouse.click(4, 4);
        else await page.keyboard.press(close);
        await page.locator('#palette-overlay').waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement === document.getElementById('command-palette-open'));
        report.checks.push(`${report.phase}: scrittura immediata, chiusura e focus restituito`);
      }
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => { import('/js/utils.js').then(m => m.chiediTesto({ titolo: 'Bozza di prova', valore: 'testo da conservare' })).then(value => window.searchDraft = value); });
      await page.locator('#askinput-value').waitFor();
      await page.keyboard.press('Control+p');
      await page.locator('#palette-input').waitFor();
      await page.waitForTimeout(200);
      assert(await page.locator('#palette-input').evaluate(el => document.activeElement === el));
      await page.mouse.click(4, 4);
      await page.locator('#palette-overlay').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement === document.getElementById('askinput-value'));
      assert.equal(await page.locator('#askinput-value').inputValue(), 'testo da conservare');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.searchDraft === null);
      report.checks.push(`${width}px: ricerca annidata, clic esterno chiude solo la ricerca e restituisce il focus alla bozza`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => (await import('/js/scorciatoie-ui.js')).apriPannelloScorciatoie());
    await page.locator('[data-registra="paletteComandi"]').click();
    await page.keyboard.press('Control+Alt+9');
    await page.locator('#scorciatoie-chiudi').click();
    await page.waitForFunction(() => document.querySelector('#command-palette-open kbd').textContent === 'Ctrl+Alt+9');
    await page.keyboard.press('Control+Alt+9');
    await page.locator('#palette-input').waitFor();
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForFunction(() => document.querySelector('#command-palette-open kbd').textContent === 'Ctrl+Alt+9');
    await page.evaluate(async () => (await import('/js/scorciatoie-ui.js')).apriPannelloScorciatoie());
    await page.locator('#scorciatoie-ripristina').click();
    await page.waitForFunction(() => document.querySelector('#command-palette-open kbd').textContent === 'Ctrl+P');
    await page.locator('#scorciatoie-chiudi').click();
    report.checks.push('Richiamo nella testata aggiornato al salvataggio, al ricaricamento e al ripristino delle scorciatoie');
    assert.deepEqual(report.errors, []);
    console.log('OK', report.checks.join('\nOK '));
  } catch (error) {
    report.failure = error.stack;
    report.focus = await page.evaluate(() => ({ id: document.activeElement?.id, role: document.activeElement?.getAttribute('role') }));
    await page.screenshot({ path: `${dir}/failure.png` });
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
