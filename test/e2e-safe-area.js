'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3162 });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    // Il mock nasce prima dell'app: un solo viewport e un solo insieme di
    // listener. Gli eventi reali tardivi leggono gli stessi dati simulati.
    await page.addInitScript(() => {
      const native = window.visualViewport, vv = new EventTarget();
      const keys = ['width', 'height', 'offsetTop', 'offsetLeft', 'scale'];
      let simulated;
      for (const key of keys) Object.defineProperty(vv, key, {
        get: () => simulated ? simulated[key] : native[key],
        set: value => { simulated ||= Object.fromEntries(keys.map(k => [k, native[k]])); simulated[key] = value; },
      });
      for (const event of ['resize', 'scroll']) native.addEventListener(event, () => vv.dispatchEvent(new Event(event)));
      Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if(await page.locator('#onboarding-close').isVisible())await page.locator('#onboarding-close').click();
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--pagina-altezza'));
    await page.evaluate(() => document.querySelectorAll('.overlay').forEach(el => el.classList.add('hidden')));
    const cdp = await page.context().newCDPSession(page);
    const dentro = (r, area, nome) => {
      assert(r && r.width > 0 && r.height > 0, `${nome}: visibile`);
      assert(r.x >= area.left - 1 && r.y >= area.top - 1
        && r.x + r.width <= area.right + 1 && r.y + r.height <= area.bottom + 1,
      `${nome}: ${JSON.stringify(r)} fuori da ${JSON.stringify(area)}`);
    };
    for (const [width, height, top, right, bottom, left] of [
      [390, 844, 59, 0, 34, 0], [844, 390, 0, 59, 21, 59],
      [1024, 768, 24, 0, 24, 0], [1440, 900, 0, 0, 0, 0],
    ]) {
      await page.setViewportSize({ width, height });
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, right, bottom, left } });
      const area = { left, top, right: width - right, bottom: height - bottom };
      dentro(await page.locator('#app > header').boundingBox(), area, 'Header');
      await page.evaluate(async () => (await import('/js/utils.js')).toast('Verifica download e safe area'));
      await page.locator('#toast-container > *').waitFor();
      dentro(await page.locator('#toast-container').boundingBox(), area, 'Notifiche');
      if (width <= 900) {
        dentro(await page.locator('.mobile-bottom-nav').boundingBox(), area, 'Navigazione inferiore');
        for (const selector of ['#conn-sidebar', '#sidebar']) {
          await page.evaluate(async selector => {
            document.querySelector(selector).classList.remove('hidden');
            (await import('/js/responsive.js')).toggleDrawer(selector);
          },selector);
          await page.locator(selector).waitFor({state:'visible'});
          await page.locator('.arc-navigation-sheet [data-grabber]').press('Home');
          await page.waitForTimeout(400);
          dentro(await page.locator(selector).boundingBox(), area, selector);
          dentro(await page.locator('.arc-navigation-sheet #mobile-bottom-nav').boundingBox(), area, 'Navigazione nel drawer');
          await page.evaluate(async () => (await import('/js/responsive.js')).closeDrawers());
        }
      }
      // Prova tutte le modali statiche, incluse quelle con minimi fissi e
      // stili specifici: nessuna deve poter scavalcare il limite condiviso.
      const modals = await page.locator('.overlay .modal').all();
      assert(modals.length > 10);
      for (const modal of modals) {
        await modal.evaluate(el => { el.style.animation = 'none'; el.closest('.overlay').classList.remove('hidden'); });
        if (width <= 900) { await modal.locator('xpath=ancestor::*[@role="dialog"]').waitFor(); await page.waitForTimeout(160); }
        const nome = await modal.evaluate(el => el.closest('.overlay').id);
        const sheet = modal.locator('xpath=ancestor::*[@data-fit-content]');
        if (await sheet.count()) {
          // Nei pannelli adattati al contenuto scorre il corpo del drawer:
          // la modale può essere più alta della sua finestra visibile.
          const corpo = sheet.locator(':scope > div:nth-child(2)');
          dentro(await sheet.locator(':scope > div:first-child').boundingBox(), area, `${nome}: intestazione`);
          const visibile = await corpo.boundingBox();
          dentro(visibile, area, `${nome}: area scorrevole`);
          const areaCorpo = { left: visibile.x, top: visibile.y, right: visibile.x + visibile.width, bottom: visibile.y + visibile.height };
          const scroll = await corpo.evaluate(el => ({
            necessario: el.scrollHeight > el.clientHeight + 1,
            overflow: getComputedStyle(el).overflowY,
          }));
          if (scroll.necessario) assert(['auto', 'scroll'].includes(scroll.overflow), `${nome}: il contenuto deve essere scorribile`);
          for (const azione of await modal.locator('button, input, select, textarea, a[href], [tabindex="0"]').all()) {
            if (!await azione.isVisible()) continue;
            await azione.scrollIntoViewIfNeeded();
            dentro(await azione.boundingBox(), areaCorpo, `${nome}: azione raggiungibile`);
          }
        } else dentro(await modal.boundingBox(), area, nome);
        await modal.evaluate(el => el.closest('.overlay').classList.add('hidden'));
      }
      await page.evaluate(async () => {
        const { showContextMenu } = await import('/js/utils.js');
        showContextMenu(0, 0, Array.from({ length: 35 }, (_, i) => ({ label: `Comando ${i}`, action() {} })));
      });
      dentro(await page.locator('#context-menu').boundingBox(), area, 'Menu contestuale');
      await page.evaluate(async () => (await import('/js/utils.js')).hideContextMenu());
      await page.evaluate(async () => {
        const { positionFixedDropdown } = await import('/js/utils.js');
        const menu = document.querySelector('.toolbar-dropdown-menu').cloneNode(true);
        menu.id = 'safe-menu';
        document.body.appendChild(menu);
        positionFixedDropdown(document.querySelector(innerWidth <= 900 ? '#mobile-nav-conns' : '#menu-conns-btn'), menu);
      });
      dentro(await page.locator('#safe-menu').boundingBox(), area, 'Menu a tendina');
      await page.locator('#safe-menu').evaluate(el => el.remove());
      await page.screenshot({ path: path.join(os.tmpdir(), `codedb-safe-area-${width}.png`) });
      console.log(`  OK safe area ${width}×${height}: header, navigazione, drawer, ${modals.length} modali e menu`);
    }
    // La tastiera modifica visualViewport senza ridurre innerHeight. Un
    // EventTarget controllabile riproduce anche il pan di Safari e la chiusura.
    await page.setViewportSize({ width: 390, height: 844 });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, right: 0, bottom: 34, left: 0 } });
    await page.evaluate(() => {
      Object.assign(window.visualViewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    });
    for (const [height, offsetTop] of [[430, 0], [430, 70], [844, 0]]) {
      await page.locator('#fk-pannello').evaluate(el => { el.classList.add('hidden'); el.classList.remove('aperto'); });
      await page.evaluate(({ height, offsetTop }) => {
        Object.assign(window.visualViewport, { height, offsetTop });
        window.visualViewport.dispatchEvent(new Event('resize'));
        window.visualViewport.dispatchEvent(new Event('scroll'));
      }, { height, offsetTop });
      const area = { left: 0, top: offsetTop + 59, right: 390, bottom: Math.min(height + offsetTop, 810) };
      dentro(await page.locator('.mobile-bottom-nav').boundingBox(), area, 'Navigazione con tastiera');
      await page.evaluate(async () => (await import('/js/utils.js')).toast('Verifica download con tastiera'));
      await page.locator('#toast-container > *').waitFor();
      dentro(await page.locator('#toast-container').boundingBox(), area, 'Notifiche con tastiera');
      await page.locator('#mobile-nav-conns').click();
      await page.locator('.arc-navigation-sheet [data-grabber]').press('Home');
      await page.waitForTimeout(400);
      dentro(await page.locator('.arc-navigation-sheet #mobile-bottom-nav').boundingBox(), area, 'Navigazione nel drawer con tastiera');
      await page.keyboard.press('Escape');
      const modal = page.locator('#modal-audit-log .modal');
      await modal.evaluate(el => el.closest('.overlay').classList.remove('hidden'));
      await page.waitForTimeout(160);
      dentro(await modal.boundingBox(), area, 'Modale con tastiera');
      await modal.evaluate(el => el.closest('.overlay').classList.add('hidden'));
      await page.keyboard.press('Control+p');
      await page.waitForTimeout(160);
      dentro(await page.locator('.palette').boundingBox(), area, 'Palette con tastiera');
      await page.keyboard.press('Escape');
      await page.locator('#fk-pannello').evaluate(el => { el.classList.remove('hidden'); el.classList.add('aperto'); el.style.transition = 'none'; });
      dentro(await page.locator('#fk-pannello').boundingBox(), area, 'Relazioni con tastiera');
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, right: 59, bottom: 21, left: 59 } });
    await page.evaluate(() => {
      Object.assign(window.visualViewport, { width: 844, height: 150, offsetTop: 0 });
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    const orizzontale = { left: 59, top: 0, right: 785, bottom: 150 };
    dentro(await page.locator('#fk-pannello').boundingBox(), orizzontale, 'Relazioni con tastiera in orizzontale');
    assert.strictEqual(await page.locator('#fk-pannello').evaluate(el => getComputedStyle(el).overflowY), 'auto', 'Ricerca e azioni restano raggiungibili scorrendo');
    await page.locator('#fk-cerca').evaluate(el => el.scrollIntoView({ block: 'nearest' }));
    dentro(await page.locator('#fk-cerca').boundingBox(), orizzontale, 'Ricerca raggiungibile in orizzontale');
    const prima = await page.locator('#app').boundingBox();
    await page.evaluate(() => { window.visualViewport.scale = 2; window.visualViewport.height = 422; window.visualViewport.dispatchEvent(new Event('resize')); });
    assert.deepStrictEqual(await page.locator('#app').boundingBox(), prima, 'Il pinch zoom non ridispone la pagina');
    console.log('  OK tastiera: apertura, pan, chiusura e pinch zoom');
  } finally {
    await browser?.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
