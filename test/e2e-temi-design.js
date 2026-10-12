'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/temi-2026-10-12/${mutant ? 'mutante' : 'dopo'}`;

(async () => {
  const server = await startTestServer({ port: 3209 });
  const browser = await chromium.launch();
  const report = { checks: [], layouts: [], motion: [], errors: [] };
  fs.mkdirSync(dir, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page.setDefaultTimeout(7000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.addInitScript(version => {
      localStorage.setItem('codedb:tema', 'dark');
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { scelteIniziali } = await import('/js/theme-colori.js');
      localStorage.setItem('codedb:temi', JSON.stringify({ personale: {
        id: 'personale', nome: 'La mia palette', base: 'dark', scelte: { ...scelteIniziali('dark'), accent: '#da8df4' },
      } }));
    });
    const open = async () => {
      await page.evaluate(() => { document.getElementById('command-palette-open').focus(); document.getElementById('btn-theme').click(); });
      await page.waitForSelector('#modal-theme[data-arc-dialog="open"]');
      await page.waitForTimeout(360);
    };
    const close = async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('modal-theme').dataset.arcDialog);
    };
    const choose = id => page.locator(`[data-tema="${id}"]`).click();
    const current = () => page.evaluate(() => localStorage.getItem('codedb:tema'));
    await open();
    if (mutant) await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) { return animate.call(this, frames, this.matches('.tema-selezione') ? { ...options, duration: 0 } : options); };
    });
    report.motion = await page.evaluate(async () => {
      const values = [];
      document.querySelector('[data-tema="light"]').click();
      const start = performance.now();
      await new Promise(resolve => {
        function sample(now) {
          values.push(getComputedStyle(document.querySelector('.tema-selezione')).transform);
          if (now - start < 400) requestAnimationFrame(sample); else resolve();
        }
        requestAnimationFrame(sample);
      });
      return values;
    });
    assert(new Set(report.motion).size > 3, 'La cornice accompagna la selezione con una vera animazione');
    assert.equal(await current(), 'light');
    await page.locator('[data-tema="dark"]').focus();
    await page.keyboard.press('Space');
    assert.equal(await current(), 'dark');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tema), 'dark', 'Il cambio tema conserva il focus');
    assert.equal(await page.locator('[data-tema][aria-pressed="true"]').count(), 1);
    await choose('light'); await choose('personale'); await choose('dark');
    await page.waitForTimeout(360);
    assert.equal(await page.locator('.tema-selezione').evaluate(el => el.getAnimations().length), 0, 'Nessuna animazione residua');
    report.checks.push('Selezione persistente, tastiera/focus, movimento misurato e cambi rapidi');

    await page.locator('[data-azione="modifica"][data-id="personale"]').click();
    await page.locator('[data-scelta-hex="accent"]').fill('#bb88ee');
    await page.locator('[data-scelta-hex="accent"]').fill('#cc99ff');
    const editorHeight = await page.locator('#modal-theme .modal').evaluate(el => el.getBoundingClientRect().height);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(40);
    assert.equal(await page.locator('#modal-theme').getAttribute('data-arc-dialog'), 'closing');
    assert.equal(await page.locator('#theme-editor').evaluate(el => el.classList.contains('hidden')), false, 'Il contenuto dell’editor resta montato durante l’uscita');
    const closingHeight = await page.locator('#modal-theme .modal').evaluate(el => el.getBoundingClientRect().height);
    assert(Math.abs(closingHeight - editorHeight) < 6, 'La finestra non cambia altezza durante l’uscita');
    await page.waitForFunction(() => !document.getElementById('modal-theme').dataset.arcDialog);
    await page.waitForTimeout(180);
    assert.equal(await page.locator('html').getAttribute('data-theme-custom'), null, 'Chiudere annulla anche anteprime in coda');
    assert.equal(await current(), 'dark');
    await open();
    await page.locator('[data-azione="duplica"][data-id="light"]').click();
    await page.locator('#tema-nome').fill('Tema di prova');
    await page.locator('[data-editor="salva"]').click();
    await page.waitForSelector('[data-tema="tema"][aria-pressed="true"]');
    assert.equal(await current(), 'tema');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-azione="esporta"][data-id="tema"]').click();
    const download = await downloadPromise;
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.nome, 'Tema di prova');
    await page.locator('#tema-import-file').setInputFiles({ name: 'tema.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await page.waitForSelector('#theme-editor:not(.hidden)');
    await page.locator('[data-editor="salva"]').click();
    await page.waitForSelector('[data-tema="tema-2"]');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-azione="elimina"][data-id="tema-2"]').click();
    await page.waitForSelector('[data-tema="tema-2"]', { state: 'detached' });
    assert.equal(await current(), 'auto', 'Eliminando il tema attivo si torna ad Automatico');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-azione="elimina"][data-id="tema"]').click();
    await page.waitForSelector('[data-tema="tema"]', { state: 'detached' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.match(await page.locator('[data-tema="auto"]').textContent(), /chiaro/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await close();
    report.checks.push('Anteprima annullata, duplicazione/salvataggio, export/import senza sovrascrittura, eliminazione e Automatico dal sistema');
    // Le notifiche delle prove CRUD non coprono le anteprime nelle immagini.
    if (await page.getByRole('button', { name: 'Chiudi notifica' }).count()) await page.getByRole('button', { name: 'Chiudi notifica' }).click();

    for (const [width, height, theme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [390, 844, 'dark'], [320, 740, 'light'], [844, 430, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await open();
      const layout = await page.locator('#theme-list').evaluate(el => {
        const card = el.querySelector('.tema-card.attiva').getBoundingClientRect(), ring = el.querySelector('.tema-selezione').getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button')];
        return {
          overflow: el.scrollWidth > el.clientWidth + 1,
          ring: ['left', 'top', 'width', 'height'].every(k => Math.abs(card[k] - ring[k]) <= 2),
          actionsSeparate: buttons.every(button => !button.querySelector('button')),
          touch: buttons.every(b => b.getBoundingClientRect().width >= 44 && b.getBoundingClientRect().height >= 44),
          labels: [...el.querySelectorAll('.tema-card-testo')].every(node => node.scrollWidth <= node.clientWidth + 1),
        };
      });
      report.layouts.push({ width, theme, ...layout });
      assert(!layout.overflow && layout.ring && layout.actionsSeparate && layout.labels, JSON.stringify(report.layouts.at(-1)));
      const contrast = await page.locator('#theme-list').evaluate(el => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const lum = rgb => rgb.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((s, n, i) => s + n * [.2126, .7152, .0722][i], 0);
        return [...el.querySelectorAll('.tema-card-testo small')].map(label => {
          const chain = []; for (let node = label; node; node = node.parentElement) chain.unshift(node);
          ctx.clearRect(0, 0, 1, 1);
          for (const node of chain) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
          const bg = lum([...ctx.getImageData(0, 0, 1, 1).data]);
          ctx.fillStyle = getComputedStyle(label).color; ctx.fillRect(0, 0, 1, 1);
          const fg = lum([...ctx.getImageData(0, 0, 1, 1).data]);
          return (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
        });
      });
      report.layouts.at(-1).contrast = Math.min(...contrast);
      assert(contrast.every(c => c >= 4.5), 'Descrizioni dei temi leggibili sullo sfondo effettivo');
      if (width <= 900) assert(layout.touch, 'Tutti i controlli mobile, anche in orizzontale, hanno bersagli di almeno 44px');
      assert.equal(await page.locator('#modal-theme .arc-dialog-sheet').count(), width <= 900 ? 1 : 0);
      assert.equal(await page.locator('#btn-close-theme-modal:visible').count(), width <= 900 ? 0 : 1, 'Un solo comando di chiusura');
      if (width > 900) {
        const gap = await page.locator('.tema-personali .tema-choice').evaluate(button => button.querySelector('.tema-preview').getBoundingClientRect().left - button.getBoundingClientRect().left);
        assert(gap <= 20, 'Anteprima personale allineata all’inizio della riga');
      }
      if (!checksOnly) await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
      await close();
    }
    report.checks.push('Temi chiaro/scuro, desktop e drawer Arc a 320/390px e landscape, cornice allineata e nessun overflow');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem', { name: /^Tema/ }).click();
    await page.waitForSelector('#modal-theme[data-arc-dialog="open"]');
    assert.equal(await page.locator('.arc-navigation-sheet').count(), 0);
    await choose('personale');
    await page.locator('[data-azione="modifica"][data-id="personale"]').click();
    await page.locator('[data-editor="annulla"]').click();
    assert.equal(await current(), 'personale');
    await page.locator('[data-azione="modifica"][data-id="personale"]').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(40);
    assert.equal(await page.locator('#theme-editor').evaluate(el => el.classList.contains('hidden')), false, 'Editor conservato anche durante l’uscita mobile');
    await open();
    assert.equal(await page.locator('#theme-editor:visible').count(), 0, 'Riapertura rapida pulita');
    assert.equal(await current(), 'personale');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await choose('dark');
    assert.equal(await page.locator('#theme-list').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await close();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    assert.equal(await current(), 'dark');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.deepEqual(report.errors, []);
    report.checks.push('Percorso reale mobile, editor/annulla, movimento ridotto e tema conservato al riavvio');
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    report.checks.forEach(s => console.log('OK', s));
  } finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
