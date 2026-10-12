'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3211 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.addInitScript(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(() => document.getElementById('btn-theme').click());
    await page.locator('#btn-tema-nuovo').click();
    if (process.argv.includes('--mutant')) await page.evaluate(() => {
      // Reintroduce solo nella pagina di prova l'attivazione predefinita della label.
      const preventDefault = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function () {
        if (this.type === 'click' && this.currentTarget instanceof HTMLLabelElement && this.target.closest('[data-arc-color-popup]')) return;
        return preventDefault.call(this);
      };
    });
    // Intercetta l'attivazione nativa prima che apra una finestra esterna al DOM.
    await page.evaluate(() => {
      window.colorNativeClicks = 0;
      document.addEventListener('click', event => {
        if (event.target.matches('input[type="color"][data-arc-model]')) {
          window.colorNativeClicks++;
          event.preventDefault();
        }
      });
    });
    const trigger = page.locator('[data-scelta="success"] + .arc-field-host [data-arc-component="color-picker"]');
    const popup = page.locator('[data-arc-color-popup]:popover-open');
    const area = popup.getByRole('slider', { name: 'Saturazione e luminosità', exact: true }).locator('..');
    const model = page.locator('[data-scelta="success"]');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await trigger.click();
      await popup.getByRole('textbox').fill('#128abc');
      await popup.getByRole('textbox').press('Enter');
      assert.equal(await model.inputValue(), '#128abc');
      await area.click({ position: { x: 80, y: 60 } });
      assert.equal(await page.evaluate(() => window.colorNativeClicks), 0, 'Il gradiente Arc non deve attivare anche il selettore colore nativo');
      assert.notEqual(await model.inputValue(), '#128abc', 'Il gradiente modifica davvero il colore');
      const selected = await model.inputValue();
      assert.equal(await page.locator('[data-scelta-hex="success"]').inputValue(), selected);
      const hue = popup.getByRole('slider', { name: 'Tonalità', exact: true });
      await hue.locator('..').click({ position: { x: 40, y: 6 } });
      await hue.press('ArrowRight');
      assert.notEqual(await model.inputValue(), selected, 'Tonalità modificabile con clic e tastiera');
      assert.equal(await page.evaluate(() => window.colorNativeClicks), 0, 'Anche il cursore tonalità usa soltanto Arc');
      const rect = await popup.boundingBox();
      assert(rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= 1001, 'Popup dentro lo schermo');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-arc-color-popup]:popover-open'));
      assert(await trigger.evaluate(el => el === document.activeElement), 'Escape restituisce il focus al colore');
      assert.equal(await page.locator('#modal-theme').getAttribute('data-arc-dialog'), 'open');
      await model.locator('xpath=ancestor::label').locator('.tema-campo-nome').click();
      await popup.getByRole('button', { name: 'Conferma colore' }).click();
      await page.waitForFunction(() => !document.querySelector('[data-arc-color-popup]:popover-open'));
      assert.equal(await page.evaluate(() => window.colorNativeClicks), 0, 'Il clic sull’etichetta apre soltanto Arc');
      await trigger.focus();
      await page.keyboard.press('Space');
      await popup.getByRole('button', { name: 'Conferma colore' }).click();
      await page.waitForFunction(() => !document.querySelector('[data-arc-color-popup]:popover-open'));
      console.log(`OK ${width}px: un solo selettore, gradiente, tonalità, Hex, tastiera, etichetta e focus`);
    }
    assert.deepEqual(errors, [], 'Nessun errore JavaScript');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
