'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/dialog-motion-2026-10-11/${mutant ? 'mutante' : 'dopo'}`;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const server = await startTestServer({ port: 3201 });
  const browser = await chromium.launch();
  const report = { checks: [], motion: [], errors: [] };
  let page;
  try {
    for (const width of [1440, 390]) for (const reducedMotion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion, hasTouch: width < 900 });
      page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.addInitScript(version => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      await page.evaluate(async () => {
        window.motionUtils = await import('/js/utils.js');
        window.motionArc = await import('/arc/ui.js');
        window.motionResponsive = await import('/js/responsive.js');
        window.motionOpener = document.getElementById('command-palette-open');
        window.motionOpener.focus();
      });
      if (mutant) await page.addStyleTag({ content: 'html body .overlay[data-arc-dialog="closing"] { display:none !important; }' });
      const measure = action => page.evaluate(async action => {
        const frames = [], start = performance.now();
        if (action === 'open') window.motionUtils.openModal('connect-overlay');
        if (action === 'close') void window.motionUtils.closeModal('connect-overlay', { saved: true });
        if (action === 'nav-open') window.motionResponsive.toggleDrawer('#conn-sidebar');
        if (action === 'nav-close') window.motionArc.closeNavigationSheet();
        await new Promise(resolve => {
          const sample = now => {
            const owner = document.getElementById('connect-overlay');
            const node = action.startsWith('nav') ? document.querySelector('.arc-navigation-sheet') : owner.querySelector('.arc-dialog-sheet') || owner.querySelector('.modal');
            if (node?.getClientRects().length) {
              const css = getComputedStyle(node), bounds = node.getBoundingClientRect();
              const body = node.classList.contains('arc-dialog-sheet') || node.classList.contains('arc-navigation-sheet') ? node.children[1] : null;
              frames.push({ ms: now - start, y: bounds.y, opacity: css.opacity, ownerOpacity: getComputedStyle(owner).opacity, transform: css.transform, bodyHeight: body?.getBoundingClientRect().height });
            }
            if (now - start < 500) requestAnimationFrame(sample); else resolve();
          };
          requestAnimationFrame(sample);
        });
        return frames;
      }, action);
      const entry = await measure('open');
      assert(entry.length > 2, 'L’apertura produce fotogrammi visibili');
      const ys = entry.filter(frame => frame.ms > 35).map(frame => frame.y);
      if (reducedMotion === 'reduce') assert(Math.max(...ys) - Math.min(...ys) < 1, 'Movimento ridotto: nessuno spostamento spaziale');
      else assert(Math.max(...ys) - Math.min(...ys) > 1, 'Ingresso realmente animato');
      if (width < 900) {
        const heights = entry.filter(frame => frame.ms > 60).map(frame => frame.bodyHeight);
        assert(Math.max(...heights) - Math.min(...heights) < 1, 'Il contenuto del drawer non cambia altezza a ogni frame');
      }
      if (!checksOnly && reducedMotion === 'no-preference') await page.screenshot({ path: `${dir}/dialog-${width}.png` });
      const exit = await measure('close');
      assert(exit.some(frame => frame.ms > 20), 'Il pannello resta visibile durante l’uscita');
      assert(exit.every(frame => frame.ms < 400), 'Uscita breve e rimozione completata');
      assert.equal(await page.locator('#connect-overlay [role="dialog"]').count(), 0);
      await page.waitForFunction(() => document.activeElement === window.motionOpener);
      report.motion.push({ width, reducedMotion, entry, exit });

      await page.evaluate(() => window.motionUtils.openModal('connect-overlay'));
      await page.locator('#connect-form [name="host"]').fill('bozza.example');
      await page.evaluate(async () => {
        void window.motionUtils.closeModal('connect-overlay', { saved: true });
        await new Promise(resolve => setTimeout(resolve, 35));
        window.motionUtils.openModal('connect-overlay');
      });
      await page.waitForTimeout(450);
      assert.equal(await page.locator('#connect-form [name="host"]').inputValue(), 'bozza.example');
      assert.equal(await page.locator('#connect-overlay').getAttribute('data-arc-dialog'), 'open');
      await page.keyboard.press('Escape');
      await page.locator('#connect-overlay [role="dialog"]').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement === window.motionOpener);
      report.checks.push(`${width}, ${reducedMotion}: entrata/uscita, interruzione, bozza e focus conservati`);

      await page.evaluate(() => window.motionUtils.openModal('connect-overlay'));
      await page.waitForTimeout(350);
      await page.evaluate(() => { void window.motionUtils.closeModal('connect-overlay', { saved: true }); });
      await page.setViewportSize({ width: width > 900 ? 390 : 1440, height: 900 });
      await page.waitForFunction(() => !document.getElementById('connect-overlay').dataset.arcDialog);
      assert.equal(await page.locator('#connect-overlay [role="dialog"]').count(), 0, 'Cambio formato durante l’uscita: nessun overlay residuo');
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      report.checks.push(`${width}, ${reducedMotion}: cambio breakpoint durante la chiusura`);

      if (width < 900) {
        const navEntry = await measure('nav-open');
        assert(navEntry.length > 2, 'Il drawer si apre dopo il completamento del cambio viewport');
        if (!checksOnly && reducedMotion === 'no-preference') await page.screenshot({ path: `${dir}/drawer-${width}.png` });
        const navExit = await measure('nav-close');
        report.motion.push({ width, reducedMotion, navEntry, navExit });
        assert(navExit.some(frame => frame.ms > 20), 'Anche il drawer di navigazione completa l’uscita');
        assert.equal(await page.locator('.arc-navigation-sheet').count(), 0);
        assert(await page.locator('#conn-sidebar').evaluate(el => !el.closest('.arc-navigation-slot')), 'Nodi restituiti al navigatore');
        await page.evaluate(async () => {
          window.motionResponsive.toggleDrawer('#conn-sidebar');
          await new Promise(resolve => setTimeout(resolve, 50));
          window.motionArc.closeNavigationSheet();
          window.motionResponsive.toggleDrawer('#sidebar');
        });
        await page.waitForTimeout(450);
        assert.equal(await page.locator('.arc-navigation-slot > #sidebar').count(), 1, 'Cambio rapido di pannello senza chiusure tardive');
        await page.evaluate(() => window.motionArc.closeNavigationSheet());
        await page.locator('.arc-navigation-sheet').waitFor({ state: 'detached' });
        report.checks.push('Drawer di navigazione: uscita, restituzione dei nodi e cambio rapido');
        const schema = await page.evaluate(async () => {
          // Il controller e il CSS reali si provano senza aprire una connessione database.
          const sidebar = document.getElementById('query-schema-sidebar');
          document.body.append(sidebar);
          sidebar.classList.remove('collapsed');
          window.motionResponsive.toggleDrawer('#query-schema-sidebar');
          await new Promise(resolve => setTimeout(resolve, 380));
          const startX = sidebar.getBoundingClientRect().x;
          window.motionResponsive.closeDrawers();
          await new Promise(resolve => setTimeout(resolve, 90));
          const during = { x: sidebar.getBoundingClientRect().x, visibility: getComputedStyle(sidebar).visibility };
          await new Promise(resolve => setTimeout(resolve, 250));
          return { startX, during, end: getComputedStyle(sidebar).visibility, backdrop: getComputedStyle(document.getElementById('drawer-backdrop')).visibility };
        });
        if (reducedMotion === 'no-preference') {
          assert.equal(schema.during.visibility, 'visible');
          assert(schema.during.x < schema.startX, 'Il drawer schema scorre anche in uscita');
        }
        assert.equal(schema.end, 'hidden'); assert.equal(schema.backdrop, 'hidden');
        report.checks.push('Drawer laterale schema: uscita nella direzione corretta e sfondo rimosso');
      }
      await context.close();
    }
    assert.deepEqual(report.errors, []);
    console.log('OK', report.checks.join('\nOK '));
  } catch (error) {
    report.failure = error.stack;
    await page?.screenshot({ path: `${dir}/failure.png` }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
