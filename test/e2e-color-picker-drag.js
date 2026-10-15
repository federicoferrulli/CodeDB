'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3212 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    // Una griglia aperta rende visibile il costo dell'anteprima sull'intero documento.
    await page.evaluate(() => {
      const table = document.createElement('table');
      table.id = 'griglia-prova-colore';
      table.style.cssText = 'position:fixed;inset:0;color:var(--fg);background:var(--bg)';
      table.innerHTML = Array.from({ length: 200 }, () => `<tr>${'<td>Dato</td>'.repeat(30)}</tr>`).join('');
      document.body.prepend(table);
      document.getElementById('btn-theme').click();
    });
    await page.locator('#btn-tema-nuovo').click();
    if (process.argv.includes('--mutant')) await page.evaluate(() => {
      // Reintroduce nella sola pagina il vecchio change a ogni colore intermedio.
      document.addEventListener('input', event => {
        if (event.target.matches('input[type="color"][data-arc-model]')) {
          event.target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, true);
    });
    const model = page.locator('[data-scelta="success"]');
    const trigger = page.locator('[data-scelta="success"] + .arc-field-host [data-arc-component="color-picker"]');
    const popup = page.locator('[data-arc-color-popup]:popover-open');
    const results = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await trigger.click();
      const thumb = popup.getByRole('slider', { name: 'Saturazione e luminosità', exact: true });
      const area = thumb.locator('..');
      await area.click({ position: { x: 40, y: 40 } });
      await page.waitForTimeout(400);
      await model.evaluate(el => {
        window.colorDrag = { inputs: 0, changes: 0, previews: 0, started: performance.now() };
        if (!el.hasAttribute('data-drag-listening')) {
          el.dataset.dragListening = '';
          el.addEventListener('input', () => window.colorDrag.inputs++);
          el.addEventListener('change', () => window.colorDrag.changes++);
        }
        if (!window.colorDragListening) document.addEventListener('codedb:tema', () => window.colorDrag.previews++);
        window.colorDragListening = true;
      });
      const box = await area.boundingBox();
      await page.mouse.move(box.x + 20, box.y + 30);
      await page.mouse.down();
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(box.x + 20 + i * 8, box.y + 30 + i * 3);
      }
      const during = await page.evaluate(() => ({ ...window.colorDrag, elapsed: performance.now() - window.colorDrag.started }));
      // Il cursore deve raggiungere il puntatore entro il fotogramma successivo.
      const center = await thumb.evaluate(async el => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const thumb = el.getBoundingClientRect();
        return thumb.left + thumb.width / 2;
      });
      const lag = Math.abs(center - (box.x + 180));
      // Rilascia oltre i limiti del popup: la cattura conserva il gesto nel selettore.
      await page.mouse.move(width - 2, 2);
      await page.mouse.up();
      const after = await page.evaluate(() => ({ ...window.colorDrag }));
      const selected = await model.inputValue();
      assert.equal(await page.locator('[data-scelta-hex="success"]').inputValue(), selected);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--success').trim()), selected,
        'Il rilascio applica subito al workspace il valore definitivo');
      const staysOpen = await trigger.getAttribute('aria-expanded') === 'true'
        && await page.locator('#modal-theme').getAttribute('data-arc-dialog') === 'open';
      // Anche gli altri cursori concludono il gesto su perdita di cattura.
      const hue = popup.getByRole('slider', { name: 'Tonalità', exact: true }).locator('..');
      const hueBox = await hue.boundingBox();
      const previousChanges = after.changes;
      await page.mouse.move(hueBox.x + 20, hueBox.y + 7);
      await page.mouse.down();
      await page.mouse.move(hueBox.x + 140, hueBox.y + 7);
      await hue.evaluate(el => {
        el.addEventListener('pointermove', event => el.releasePointerCapture(event.pointerId), { once: true });
      });
      await page.mouse.move(hueBox.x + 180, hueBox.y + 7);
      await page.mouse.up();
      assert.equal(await page.evaluate(() => window.colorDrag.changes), previousChanges + 1, 'Perdere la cattura conclude il gesto una volta sola');
      await hue.click({ position: { x: 70, y: 7 } });
      assert.equal(await page.evaluate(() => window.colorDrag.changes), previousChanges + 2, 'Il cursore resta utilizzabile dopo la perdita di cattura');
      const text = popup.getByRole('textbox');
      const beforeDraft = await model.inputValue();
      await text.fill('#123');
      await text.press('Escape');
      assert.equal(await model.inputValue(), beforeDraft, 'Escape annulla il testo incompleto senza cambiare colore');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'Annullare il testo conserva il selettore');
      // Tab può portare il focus fuori dal popup senza un clic esterno.
      await popup.getByRole('button', { name: /^Salva #/ }).focus();
      await page.keyboard.press('Tab');
      const outside = await page.evaluate(() => !document.activeElement.closest('[data-arc-color-popup]'));
      assert(outside, 'Il focus deve essere uscito dal popup con Tab');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const dialogOpen = await page.locator('#modal-theme').getAttribute('data-arc-dialog') === 'open';
      const result = { width, during, after, lag, staysOpen, dialogOpen };
      console.log(JSON.stringify(result));
      results.push(result);
      if (!dialogOpen) {
        await page.evaluate(() => document.getElementById('btn-theme').click());
        await page.locator('#btn-tema-nuovo').click();
      }
    }
    for (const result of results) {
      assert(result.staysOpen, 'Trascinare e rilasciare fuori conserva selettore e dialogo');
      assert(result.dialogOpen, 'Escape dopo Tab chiude soltanto il selettore, anche con focus fuori dal popup');
      assert(result.during.inputs >= 15, 'La prova deve attraversare una raffica di colori reali');
      assert.equal(result.during.changes, 0, 'Durante il trascinamento ci sono anteprime, non conferme a ogni movimento');
      assert.equal(result.after.changes, 1, 'Il rilascio conferma una sola volta il colore definitivo');
      assert(result.during.previews <= Math.ceil(result.during.elapsed / 120) + 1, 'Le anteprime del workspace rispettano il limite di frequenza');
      assert(result.lag < 2, `Il cursore deve seguire il puntatore senza ritardo (${result.lag}px)`);
    }
    const finalColor = await model.inputValue();
    await page.locator('[data-editor="salva"]').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('codedb:temi')).tema.scelte.success), finalColor,
      'Salvare conserva l’ultimo colore scelto');
    assert.deepEqual(errors, [], 'Nessun errore JavaScript');
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
