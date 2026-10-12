'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const screenshots = !process.argv.includes('--checks-only');
const dir = `test-reports/palette-2026-10-12/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3206 }), browser = await chromium.launch();
  const report = { checks: [], contrast: [], errors: [] };
  const check = text => { report.checks.push(text); console.log('OK', text); };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => report.errors.push(error.message));
    if (mutant) await page.route('**/js/navigator-motion.js', async route => {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes('if (!ridotto.matches)'));
      await route.fulfill({ response, body: source.replace('if (!ridotto.matches)', 'if (false)') });
    });
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('html[data-arc-ready="true"]', { timeout: 30000 });
    await page.evaluate(async () => {
      const t = await import('/js/tabs.js');
      const tab = t.createTab({ id: 'palette-design', connName: 'mongodb' });
      const databases = ['meteo_db', 'archivio', 'openData'].map(name => ({ name }));
      Object.assign(tab.state, { connected: true, connLabel: 'localhost:27017', databases });
      window.paletteFixture = { pending: [], hold: false };
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(name, msg, cb) {
        const collections = [{ name: 'stazioni' }, { name: 'rilevazioni_meteorologiche_storiche_2026' }, ...Array.from({ length: 400 }, (_, i) => ({ name: `misure_${String(i).padStart(4, '0')}` })), { name: '<img src=x onerror=alert(1)>' }];
        if (name === 'db:collections' && window.paletteFixture.hold) { window.paletteFixture.pending.push(() => cb({ ok: true, collections })); return; }
        cb?.({ ok: true, collections, databases, docs: [], total: 0, columns: [],
          connections: [{ name: 'mongodb', label: 'localhost:27017', dbType: 'mongodb' }, { name: 'Postgresql', label: 'localhost:5432', dbType: 'postgresql' }] });
      } });
      (await import('/js/connmanager.js')).loadSavedConnections();
      (await import('/js/workspace.js')).renderWorkspace();
    });
    const settle = () => page.waitForTimeout(340);
    const open = async () => {
      await page.locator('#command-palette-open').click();
      await page.locator('#palette-overlay [role="dialog"]').waitFor();
      await settle();
    };
    await open();
    assert(await page.locator('#palette-input').evaluate(e => e === document.activeElement));
    assert(await page.locator('.palette-voce').count() < 40, 'La nuova riga conserva la virtualizzazione');
    const sample = await page.evaluate(() => {
      const input = document.getElementById('palette-input');
      const before = document.querySelector('#palette-lista .navigator-selection').getBoundingClientRect().top;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const indicator = document.querySelector('#palette-lista .navigator-selection'), a = indicator.getAnimations()[0];
      if (!a) return { animated: false };
      a.pause(); a.currentTime = 0; const start = indicator.getBoundingClientRect().top;
      a.currentTime = 50; const middle = indicator.getBoundingClientRect().top;
      a.currentTime = 160; const end = indicator.getBoundingClientRect().top;
      const keys = a.effect.getKeyframes().flatMap(Object.keys); a.cancel();
      return { animated: true, before, start, middle, end, keys, target: input.getAttribute('aria-activedescendant'), active: document.querySelector('.palette-voce.attiva').id };
    });
    assert(sample.animated, 'La selezione della palette deve animarsi');
    assert(Math.abs(sample.before - sample.start) < 1.1);
    assert(sample.middle > sample.start && sample.middle < sample.end);
    assert.equal(sample.target, sample.active);
    assert(sample.keys.every(k => ['offset', 'computedOffset', 'easing', 'composite', 'transform', 'opacity'].includes(k)));
    await page.locator('#palette-filtro-Tabella').click();
    assert(await page.locator('.palette-filtri .tab-selection').evaluate(e => e.getAnimations().length > 0), 'Anche il cambio categoria anima la selezione');
    assert.equal(await page.locator('#palette-input').inputValue(), '@ ');
    assert.equal(await page.locator('#palette-filtro-Tabella').getAttribute('aria-selected'), 'true');
    await page.locator('#palette-input').fill('# meteo');
    assert.equal(await page.locator('#palette-filtro-Database').getAttribute('aria-selected'), 'true');
    await page.locator('#palette-filtro-Database').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#palette-input').inputValue(), '@ meteo');
    assert(await page.locator('#palette-filtro-Tabella').evaluate(e => e === document.activeElement));
    await page.keyboard.press('ArrowDown');
    assert(await page.locator('#palette-input').evaluate(e => e === document.activeElement));
    await page.locator('#palette-input').fill('<img');
    assert.equal(await page.locator('#palette-lista img').count(), 0, 'I nomi rimangono testo non eseguibile');
    await page.locator('#palette-input').fill('');
    await page.locator('.palette-voce').nth(3).hover();
    assert.equal(await page.locator('.palette-voce.attiva').getAttribute('data-i'), '3', 'Il mouse e la tastiera condividono una selezione');
    await page.locator('#palette-input').evaluate(e => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    assert(await page.locator('#palette-input').isVisible(), 'La composizione IME non esegue una voce');
    check('Schede e richiami sincronizzati, tastiera, selezione animata, ARIA e nomi non fidati');

    for (let i = 0; i < 12; i++) await page.keyboard.press('PageDown');
    const visible = await page.locator('.palette-voce.attiva').evaluate(e => {
      const r = e.getBoundingClientRect(), b = document.getElementById('palette-lista').getBoundingClientRect();
      return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    });
    assert(visible, 'La selezione resta visibile oltre la finestra virtuale');
    await page.keyboard.press('Escape');
    await page.locator('#palette-overlay').waitFor({ state: 'detached' });
    await page.evaluate(() => { window.paletteFixture.hold = true; });
    await open();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    const selected = await page.locator('.palette-voce.attiva .palette-nome').innerText();
    await page.evaluate(() => { window.paletteFixture.pending.shift()(); });
    await settle();
    assert.equal(await page.locator('.palette-voce.attiva .palette-nome').innerText(), selected, 'Le risposte tardive conservano la voce scelta');
    await page.keyboard.press('Escape');
    await page.locator('#palette-overlay').waitFor({ state: 'detached' });
    await page.evaluate(() => { window.paletteFixture.pending.splice(0).forEach(done => done()); window.paletteFixture.hold = false; });
    await open();
    check('Paginazione della lista, chiusura e risposte tardive senza cambiare il bersaglio');

    for (const width of [1440, 390, 320]) for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: width === 320 ? 740 : 900 });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.locator('#palette-input').fill(''); await settle();
      assert.equal(await page.locator('#palette-input').getAttribute('aria-controls'), 'palette-lista');
      assert(await page.locator('.palette').evaluate(e => e.scrollWidth <= e.clientWidth + 1));
      const bounds = await page.locator('.palette-filtro').evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
      if (width < 901) assert(bounds.every(h => h >= 44));
      const contrast = await page.locator('.palette').evaluate(panel => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); canvas.width = canvas.height = 1;
        const color = (css, base) => { ctx.clearRect(0, 0, 1, 1); if (base) { ctx.fillStyle = base; ctx.fillRect(0, 0, 1, 1); } ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const luminance = rgb => rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const bg = getComputedStyle(panel.querySelector('.palette-risultati')).backgroundColor;
        const fg = getComputedStyle(panel.querySelector('.palette-meta')).color;
        const selected = getComputedStyle(panel.querySelector('.navigator-selection')).backgroundColor;
        const a = luminance(color(fg)), b = luminance(color(selected, bg));
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      report.contrast.push({ width, theme, value: contrast });
      assert(contrast >= 4.5, 'Il contesto secondario resta leggibile sulla selezione');
      if (screenshots) await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
    }
    await page.locator('#palette-input').fill('zzzz-nessun-risultato');
    assert(await page.locator('.palette-vuota').isVisible());
    assert.equal(await page.locator('#palette-lista .navigator-selection').count(), 0);
    if (screenshots) await page.screenshot({ path: `${dir}/vuoto-mobile.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#palette-input').fill(''); await settle();
    await page.keyboard.press('ArrowDown');
    await page.locator('#palette-filtro-Comando').click();
    assert.equal(await page.locator('.palette').evaluate(e => e.getAnimations({ subtree: true }).length), 0);
    await page.keyboard.press('Escape');
    await page.locator('#palette-overlay').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement === document.getElementById('command-palette-open'));
    check('Contrasto, nomi lunghi, desktop/mobile, stato vuoto e movimento ridotto');
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
