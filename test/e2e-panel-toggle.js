'use strict';

// Renderer e controller reali; connessioni dimostrative, nessun database richiesto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const screenshots = !process.argv.includes('--checks-only') && !mutant;
const dir = 'test-reports/pannello-2026-10-12';
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3216 });
  const browser = await chromium.launch();
  const errors = [], checks = [];
  const check = text => { checks.push(text); console.log('OK', text); };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    if (mutant) await page.route('**/js/responsive.js', async route => {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes('if (reducedMotion.matches || !navigator.animate) return;'));
      await route.fulfill({ response, body: source.replace('if (reducedMotion.matches || !navigator.animate) return;', 'return;') });
    });
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    const seedConnections = () => page.evaluate(async () => {
      const conns = await import('/js/connmanager.js');
      (await import('/js/socket.js')).impostaSocket({ connected: true, on() {}, off() {}, emit(name, msg, cb) {
        cb?.({ ok: true, connections: [
          { name: 'MongoDB · demo', label: 'localhost:27017', dbType: 'mongodb', folder: 'Locale' },
          { name: 'PostgreSQL · demo', label: 'localhost:5432', dbType: 'postgresql', folder: 'Locale' },
          { name: 'MySQL · demo', label: 'localhost:3306', dbType: 'mysql', folder: 'Locale' },
        ] });
      } });
      conns.loadSavedConnections();
      window.panelTree = document.querySelector('#conn-tree');
    });
    await seedConnections();
    await page.waitForSelector('#conn-tree .conn-item');
    const settle = () => page.waitForFunction(() => !document.querySelector('#navigator').getAnimations().length && !document.querySelector('.main-area').getAnimations().length);
    const button = page.locator('#menu-conns-btn');
    const sample = await page.evaluate(() => {
      const nav = document.querySelector('#navigator'), main = document.querySelector('.main-area');
      const before = main.getBoundingClientRect().left;
      document.querySelector('#menu-conns-btn').click();
      const animations = [nav, main].map(el => el.getAnimations()[0]);
      if (animations.some(a => !a)) return null;
      animations.forEach(a => { a.pause(); a.currentTime = 0; });
      const start = main.getBoundingClientRect().left;
      animations.forEach(a => { a.currentTime = 80; });
      const middle = main.getBoundingClientRect().left;
      const keys = animations.flatMap(a => a.effect.getKeyframes().flatMap(Object.keys));
      const navMiddle = nav.getBoundingClientRect().left;
      document.querySelector('#menu-conns-btn').click();
      const reversed = [nav, main].map(el => el.getAnimations()[0]);
      reversed.forEach(a => { a.pause(); a.currentTime = 0; });
      const restart = main.getBoundingClientRect().left, navRestart = nav.getBoundingClientRect().left;
      reversed.forEach(a => a.finish());
      return { before, start, middle, restart, navMiddle, navRestart, keys };
    });
    assert(sample, 'La chiusura deve animare pannello e workspace');
    assert(Math.abs(sample.before - sample.start) < 1);
    assert(sample.middle > 0 && sample.middle < sample.start);
    assert(Math.abs(sample.middle - sample.restart) < 1 && Math.abs(sample.navMiddle - sample.navRestart) < 1, 'L’inversione deve ripartire dalla posizione visibile');
    assert(sample.keys.every(key => ['offset', 'computedOffset', 'easing', 'composite', 'transform'].includes(key)));
    await settle();
    check('Chiusura coordinata e inversione continua, senza animare il layout');

    await page.locator('#conn-search').fill('Mongo');
    await page.keyboard.press('Control+b');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert(await page.locator('#navigator').evaluate(el => el.inert));
    assert(await button.evaluate(el => el === document.activeElement));
    await settle();
    assert.equal(await page.locator('#conn-sidebar').isVisible(), false);
    await page.reload();
    await page.waitForSelector('html[data-arc-ready="true"]');
    await seedConnections();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    await button.press('Enter'); await settle();
    await page.locator('#conn-search').fill('bozza da conservare');
    await button.click(); await settle(); await button.click(); await settle();
    assert.equal(await page.locator('#conn-search').inputValue(), 'bozza da conservare');
    await page.locator('#conn-search').fill('');
    check('Tastiera, focus, inert, stato persistente e ricerca conservata');

    await page.evaluate(async () => {
      const shortcuts = await import('/js/scorciatoie.js');
      shortcuts.impostaMappaAttiva(shortcuts.mappaEffettiva({ sidebarConnessioni: 'Alt+B' }).mappa);
      document.dispatchEvent(new CustomEvent('codedb:scorciatoie'));
    });
    assert.equal(await button.locator('kbd').innerText(), 'Alt+B');
    await page.keyboard.press('Alt+b'); await settle();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    await button.click(); await settle();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await button.click();
    assert.equal(await page.locator('#navigator').evaluate(el => el.getAnimations().length), 0);
    assert.equal(await page.locator('#conn-sidebar').isVisible(), false);
    await button.click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await button.click();
    await page.emulateMedia({ reducedMotion: 'reduce' }); await settle();
    assert.equal(await page.locator('#navigator.navigator-departing').count(), 0);
    await button.click();
    check('Scorciatoia rimappata e movimento ridotto anche durante la transizione');
    await page.evaluate(async () => {
      const shortcuts = await import('/js/scorciatoie.js');
      shortcuts.impostaMappaAttiva(shortcuts.mappaEffettiva(null).mappa);
      document.dispatchEvent(new CustomEvent('codedb:scorciatoie'));
      document.activeElement.blur();
    });

    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['dark', 'light']) {
        await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
        assert(await page.locator('.header').evaluate(el => el.scrollWidth <= el.clientWidth));
        if (screenshots) {
          await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
          if (width === 1440) await page.screenshot({ path: `${dir}/dettaglio-${theme}.png`, clip: { x: 0, y: 0, width: 350, height: 180 } });
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await button.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-nav-conns').click();
    await page.locator('.arc-navigation-sheet').waitFor();
    assert(await page.locator('#conn-search').isVisible());
    assert.equal(await page.locator('#conn-sidebar .navigator-section-title').isVisible(), false);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async theme => (await import('/js/theme.js')).scegliTema(theme), theme);
      await page.waitForTimeout(400);
      if (screenshots) await page.screenshot({ path: `${dir}/mobile-${theme}.png` });
    }
    await page.keyboard.press('Escape');
    await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator('#navigator.navigator-departing').count(), 0);
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    await button.click(); await settle();
    check('Temi, larghezze desktop e passaggio al mobile durante la chiusura');
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${dir}/checks.json`, JSON.stringify({ checks, motion: sample, errors }, null, 2));
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
