'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/guida-2026-10-12/${mutant ? 'mutante' : 'dopo'}`;
const ids = ['connessione', 'tabella', 'query', 'grafico', 'backup'];

(async () => {
  const server = await startTestServer({ port: 3208 });
  const browser = await chromium.launch();
  const report = { checks: [], motion: [], contrast: [], errors: [] };
  fs.mkdirSync(dir, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(7000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.addInitScript(({ version, ids }) => localStorage.setItem('codedb:onboarding', JSON.stringify({
      visto: true, versioneVista: version, traguardi: Object.fromEntries(ids.map(id => [id, true])), checklistChiusa: true,
    })), { version: require('../package.json').version, ids });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      (await import('/js/theme.js')).scegliTema('dark');
      document.getElementById('command-palette-open').focus();
    });
    if (mutant) await page.addStyleTag({ content: '.onb-hub * { animation: none !important; transition: none !important; }' });
    const open = () => page.evaluate(() => document.getElementById('btn-onboarding').click());
    const close = async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('onboarding-overlay').dataset.arcDialog);
    };
    await open();
    await page.waitForSelector('.onb-hub');
    const frames = await page.evaluate(async () => {
      const values = [];
      const start = performance.now();
      await new Promise(resolve => {
        const sample = now => {
          const compass = document.querySelector('.onb-hub-compass svg');
          const track = document.querySelector('.is-complete .onb-hub-track > span');
          values.push({ ms: now - start, compass: getComputedStyle(compass).transform, track: getComputedStyle(track).transform });
          if (now - start < 720) requestAnimationFrame(sample); else resolve();
        };
        requestAnimationFrame(sample);
      });
      return values;
    });
    report.motion = frames;
    assert(new Set(frames.map(f => f.compass)).size > 3, 'La bussola della guida deve orientarsi con una vera animazione');
    assert(new Set(frames.map(f => f.track)).size > 3, 'Le tappe completate si rivelano in sequenza');
    assert.equal(await page.locator('.onb-hub-step.is-complete').count(), 5);
    assert.match(await page.locator('.onb-hub-completion').textContent(), /5 di 5/);
    assert.match(await page.locator('[data-azione="checklist"] .onb-hub-action-copy').textContent(), /completati/);
    await page.locator('.onb-hub-tour').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.azione), 'checklist');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.azione), 'connessione');
    await close();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'command-palette-open');
    report.checks.push('Animazione bussola/percorso, traguardi reali, tastiera, Escape e ritorno del focus');

    for (const done of [[], ['connessione', 'query'], ids]) {
      await page.evaluate(done => {
        const state = JSON.parse(localStorage.getItem('codedb:onboarding'));
        state.traguardi = Object.fromEntries(done.map(id => [id, true]));
        localStorage.setItem('codedb:onboarding', JSON.stringify(state));
      }, done);
      await open();
      await page.waitForSelector('.onb-hub');
      assert.equal(await page.locator('.onb-hub-step.is-complete').count(), done.length, 'Nessun progresso inventato');
      assert.match(await page.locator('.onb-hub-completion').textContent(), new RegExp(`${done.length} di 5`));
      await close();
    }

    await open();
    await page.locator('.onb-hub-action[data-azione="checklist"]').click();
    await page.waitForSelector('#onb-checklist');
    assert.match(await page.locator('#onb-checklist').textContent(), /5\/5/);
    await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await open();
    await page.locator('.onb-hub-action[data-azione="connessione"]').click();
    await page.waitForSelector('#connect-overlay[data-arc-dialog="open"]');
    await page.locator('#conn-cancel-btn').click();
    await page.waitForFunction(() => !document.getElementById('connect-overlay').dataset.arcDialog);
    await open();
    await page.locator('.onb-hub-tour').click();
    await page.waitForSelector('.onb-fumetto');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.onb-fumetto', { state: 'detached' });
    report.checks.push('0/2/5 traguardi, checklist, nuova connessione e tour realmente funzionanti');

    await page.setViewportSize({ width: 390, height: 844 });
    const openFromTools = async () => {
      await page.locator('#mobile-nav-conns').click();
      await page.locator('#conn-settings-btn').click();
      await page.getByRole('menuitem', { name: /Guida introduttiva/i }).click();
      await page.waitForSelector('.onb-hub');
      assert.equal(await page.locator('.arc-navigation-sheet').count(), 0, 'La guida rilascia il drawer di navigazione sottostante');
    };
    await openFromTools();
    await page.locator('.onb-hub-tour').click();
    await page.waitForSelector('.onb-fumetto');
    assert.match(await page.locator('.onb-fumetto h3').textContent(), /connessioni/);
    let steps = 0;
    while (await page.locator('.onb-fumetto').count()) {
      assert(++steps <= 12, 'Il tour mobile termina');
      await page.locator('[data-tour="succ"]').click();
    }
    assert(steps >= 3, 'Il tour descrive i controlli mobile anche senza connessioni');
    await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await openFromTools();
    await page.locator('.onb-hub-tour').click();
    await page.waitForSelector('.onb-fumetto');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.onb-fumetto', { state: 'detached' });
    await openFromTools();
    await page.locator('.onb-hub-action[data-azione="checklist"]').click();
    await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await openFromTools();
    await page.locator('.onb-hub-action[data-azione="connessione"]').click();
    await page.waitForSelector('#connect-overlay[data-arc-dialog="open"]');
    await page.locator('#conn-cancel-btn').click();
    await page.waitForFunction(() => !document.getElementById('connect-overlay').dataset.arcDialog);
    report.checks.push('Percorso mobile Connessioni → Strumenti → Guida: tour completo/Escape, checklist e connessione utilizzabili');

    for (const [width, height, theme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [390, 844, 'dark'], [320, 740, 'light'], [844, 430, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await open();
      await page.waitForTimeout(760);
      assert.equal(await page.locator('#onboarding-overlay .arc-dialog-sheet').count(), width < 900 ? 1 : 0, 'Drawer Arc su mobile');
      if (width < 900) assert.equal(await page.locator('#onboarding-overlay .arc-dialog-sheet[data-fit-content]').count(), 1, 'La guida compatta usa l’altezza del contenuto');
      const bounds = await page.locator('.onb-hub').evaluate(hub => {
        const modal = hub.closest('.modal');
        return {
          overflow: modal.scrollWidth > modal.clientWidth + 1,
          buttons: [...hub.querySelectorAll('button')].map(b => ({ w: b.clientWidth, h: b.clientHeight })),
          labels: [...hub.querySelectorAll('.onb-hub-step')].every(li => {
            const rect = li.getBoundingClientRect(), label = li.querySelector('span').getBoundingClientRect();
            return label.left >= rect.left - 1 && label.right <= rect.right + 1;
          }),
          visible: [...hub.querySelectorAll('button')].every(b => getComputedStyle(b).visibility !== 'hidden'),
          inViewport: [...hub.querySelectorAll('button')].every(b => b.getBoundingClientRect().bottom <= window.innerHeight),
          headerClear: !hub.querySelector('header') && getComputedStyle(hub.querySelector('.onb-hub-head')).display === 'block',
        };
      });
      assert(!bounds.overflow && bounds.labels && bounds.visible, `${width}/${theme}: contenuti integri senza overflow`);
      assert(bounds.headerClear, 'Il titolo locale non eredita la barra header dell’app');
      if (height >= 700) assert(bounds.inViewport, 'Tutte e tre le azioni sono visibili senza scorrere');
      assert(bounds.buttons.every(b => b.w >= 44 && b.h >= 44), 'Azioni con area tattile almeno 44px');
      const contrast = await page.locator('.onb-hub').evaluate(hub => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const lum = rgb => rgb.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((s, n, i) => s + n * [.2126, .7152, .0722][i], 0);
        return [...hub.querySelectorAll('.onb-hub-head p, .onb-hub-action-copy > span, .onb-hub-footer')].map(el => {
          const chain = []; for (let node = el; node; node = node.parentElement) chain.unshift(node);
          ctx.clearRect(0, 0, 1, 1);
          for (const node of chain) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
          const bg = lum([...ctx.getImageData(0, 0, 1, 1).data]);
          ctx.fillStyle = getComputedStyle(el).color; ctx.globalAlpha = Number(getComputedStyle(el).opacity); ctx.fillRect(0, 0, 1, 1); ctx.globalAlpha = 1;
          const fg = lum([...ctx.getImageData(0, 0, 1, 1).data]);
          return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
        });
      });
      report.contrast.push({ width, theme, min: Math.min(...contrast) });
      assert(contrast.every(c => c >= 4.5), `Testi secondari leggibili ${width}/${theme}: ${contrast}`);
      if (!checksOnly) await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
      await close();
    }
    report.checks.push('Temi scuro/chiaro, desktop e drawer Arc a 390/320px e landscape, zero sovrapposizioni');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.onb-hub').evaluate(h => h.getAnimations({ subtree: true }).length), 0, 'Riduzione movimento rispettata');
    await close();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (let i = 0; i < 3; i++) { await open(); await page.waitForTimeout(40); await close(); }
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.effect?.target?.closest?.('.onb-hub')).length), 0);
    assert.deepEqual(report.errors, []);
    report.checks.push('Movimento ridotto, chiusure durante ingresso, riaperture rapide, nessuna animazione residua o errore JS');
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    report.checks.forEach(s => console.log('OK', s));
  } finally { await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
