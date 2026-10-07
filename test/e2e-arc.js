'use strict';

// Verifica il confine React/DOM, i veri callback e il layout senza toccare il vault utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { scegliArc } = require('./arc-controls');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = 'test-reports/arc/after';
fs.mkdirSync(dir, { recursive: true });
const report = { checks: [], layouts: [], errors: [], requests: [] };
function checked(name) { report.checks.push(name); console.log('OK', name); }

(async () => {
  const server = await startTestServer({ port: Number(process.env.E2E_ARC_PORT) || 3157 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error' && !/net::|Failed to load resource/.test(msg.text())) report.errors.push(msg.text()); });
    page.on('response', r => { if (r.status() >= 400) report.requests.push({ url: r.url(), status: r.status() }); });
    page.on('requestfailed', r => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') report.requests.push({ url: r.url(), error: r.failure()?.errorText }); });
    await page.addInitScript(() => { if (!localStorage.getItem('codedb:tema')) localStorage.setItem('codedb:tema', 'dark'); });
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForTimeout(1500);
    if (await page.locator('#onboarding-close').isVisible()) {
      assert.equal(await page.locator('#onboarding-overlay [role="dialog"]').count(), 1);
      await page.screenshot({ path: `${dir}/welcome-1440.png` });
      await page.locator('#onboarding-close').click();
    }
    checked('Avvio React, Arc e moduli CodeDB; onboarding nel portal');
    report.controls = await page.evaluate(() => ({
      buttons: document.querySelectorAll('[data-arc-component="button"]').length,
      inputs: document.querySelectorAll('[data-arc-component="input"]').length,
      unlabeledInputs: [...document.querySelectorAll('[data-arc-component="input"]')].filter(e => !e.labels.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.title).map(e => e.id),
    }));
    assert(report.controls.buttons > 100 && report.controls.inputs > 40, JSON.stringify(report.controls));
    assert.deepEqual(report.controls.unlabeledInputs, []);
    await page.locator('#welcome button').click();
    await page.waitForSelector('#connect-overlay[data-arc-dialog="open"]');
    assert.equal(await page.locator('#connect-form').count(), 1);
    await page.locator('#connect-form [name="host"]').fill('127.0.0.1');
    await scegliArc(page, '#connect-form [name="dbType"]', 'mysql');
    assert.equal(await page.locator('#connect-form [name="port"]').inputValue(), '3306');
    await scegliArc(page, '#connect-form [name="dbType"]', 'postgresql');
    assert.equal(await page.locator('#connect-form [name="port"]').inputValue(), '5432');
    await scegliArc(page, '#connect-form [name="dbType"]', 'mongodb');
    await page.locator('#connect-form [name="username"]').fill('verifica reset');
    await page.evaluate(() => document.getElementById('connect-form').reset());
    assert.equal(await page.locator('#connect-form [name="username"]').inputValue(), '');
    assert.equal(await page.locator('#connect-form [name="host"]').inputValue(), 'localhost');
    await page.locator('#wizard-next-btn').click();
    assert.match(await page.locator('#wizard-subtitle').textContent(), /Passo 3/);
    await page.locator('#wizard-prev-btn').click();
    await page.locator('#connect-form [name="port"]').fill('1');
    await page.locator('#conn-test-btn').click();
    assert(await page.locator('#conn-test-btn').isDisabled());
    await page.waitForSelector('#connect-error:not(.hidden)');
    assert.equal(await page.locator('#conn-test-btn').isDisabled(), false);
    assert.match(await page.locator('#connect-error').textContent(), /Errore|connessione/i);
    assert.equal(await page.locator('#connect-error [role="alert"]').count(), 1);
    checked('Wizard: tre DBMS, porte, salto SSH e errore di connessione reale');
    await page.evaluate(async () => (await import('/js/utils.js')).showToast('Errore annunciato anche nel dialogo.', 'error', 0));
    await page.waitForSelector('.arc-notifications [role="alert"]');
    assert.equal(await page.locator('.arc-notifications [role="alert"]').evaluate(e => !!e.closest('[aria-hidden="true"]')), false);
    // Il focus non deve uscire dal dialogo, nemmeno dopo un intero giro.
    for (let i = 0; i < 22; i++) {
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => document.getElementById('connect-overlay').contains(document.activeElement)));
    }
    assert(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#connect-overlay.hidden', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#welcome button') === document.activeElement);
    checked('Contenimento e ripristino del focus, Escape sul wizard');
    while (await page.locator('.arc-notifications button').count()) await page.locator('.arc-notifications button').first().click();

    await page.evaluate(() => { window.arcValue = undefined; import('/js/utils.js').then(m => m.chiediTesto({ titolo: 'Rinomina tabella', etichetta: 'Nome', valore: 'origine' })).then(v => window.arcValue = v); });
    await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
    await page.locator('#askinput-value').fill('destinazione');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.arcValue === 'destinazione');
    await page.evaluate(() => { window.arcValue = undefined; import('/js/utils.js').then(m => m.chiediTesto({ titolo: 'Annulla operazione', spunta: { etichetta: 'Conserva originale', valore: true } })).then(v => window.arcValue = v); });
    await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
    assert(await page.locator('#askinput-check').isChecked());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.arcValue === null);
    checked('Arc Input/Button: Enter restituisce il valore, Escape risolve null');
    await page.locator('#welcome button').click();
    await page.waitForSelector('#connect-overlay[data-arc-dialog="open"]');
    await page.evaluate(() => { window.arcNested = undefined; import('/js/utils.js').then(m => m.chiediTesto({ titolo: 'Conferma annullabile', valore: 'verifica' })).then(v => window.arcNested = v); });
    await page.waitForSelector('#askinput-overlay[data-arc-dialog="open"]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.arcNested === null);
    assert(await page.locator('#connect-overlay').isVisible());
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.waitForFunction(() => document.getElementById('connect-overlay').contains(document.activeElement));
    await page.keyboard.press('Control+p');
    await page.waitForSelector('#palette-overlay[data-arc-dialog="open"]');
    await page.locator('#palette-input').fill('>tema');
    assert(await page.locator('#palette-input').evaluate(e => e === document.activeElement));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#palette-overlay', { state: 'detached' });
    assert(await page.locator('#connect-overlay').isVisible());
    await page.keyboard.press('Escape');
    checked('Dialoghi e palette annidati: focus utilizzabile, Escape annulla solo quello superiore');
    const stacking = await page.evaluate(async () => {
      const { openModal, closeModal } = await import('/js/utils.js');
      const ids = ['connexport-overlay', 'dbexport-overlay', 'dbimport-overlay', 'explain-overlay'];
      const settle = () => new Promise(r => setTimeout(r, 20));
      for (const id of ids.slice(0, 3)) { openModal(id); await settle(); }
      closeModal(ids[1]); await settle();
      openModal(ids[3]); await settle();
      const above = Number(getComputedStyle(document.getElementById(ids[3])).zIndex) > Number(getComputedStyle(document.getElementById(ids[2])).zIndex);
      for (const id of ids.reverse()) { closeModal(id); await settle(); }
      return above;
    });
    assert(stacking, 'Il nuovo dialogo deve stare sopra gli altri anche dopo una chiusura intermedia');

    await page.locator('#conn-settings-btn').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Tema', exact: true }).click();
    await page.waitForSelector('#modal-theme[data-arc-dialog="open"]');
    await page.screenshot({ path: `${dir}/theme-1440.png` });
    await page.keyboard.press('Escape');
    checked('Arc Dropdown Menu: apertura da tastiera e comando Tema reale');

    await page.evaluate(async () => {
      const { toast, showToast } = await import('/js/utils.js');
      toast('Errore di prova: controlla il collegamento e riprova. '.repeat(5), true);
      showToast('Operazione di prova completata.', 'success', 0);
    });
    await page.waitForSelector('.arc-notifications [role="alert"]');
    assert.match(await page.locator('.arc-notifications [role="alert"]').textContent(), /riprova/);
    assert.equal(await page.locator('.arc-notifications [data-tone="success"]').count(), 1);
    await page.screenshot({ path: `${dir}/notifications-1440.png` });
    while (await page.locator('.arc-notifications button').count()) await page.locator('.arc-notifications button').first().click();
    checked('Notifiche: errore annunciato, testo lungo integro, successo e chiusura');

    // Tutti gli overlay statici attraversano lo stesso bridge: il pannello e
    // gli input devono conservare identità e valori dopo apertura/chiusura.
    const overlays = await page.evaluate(async () => {
      const { openModal, closeModal } = await import('/js/utils.js');
      const output = [];
      for (const overlay of document.querySelectorAll('.overlay')) {
        if (!overlay.querySelector('.modal')) continue;
        const panel = overlay.querySelector('.modal');
        const input = panel.querySelector('input');
        const value = input?.value;
        openModal(overlay);
        await new Promise(r => setTimeout(r, 25));
        const dialog = overlay.querySelector('[role="dialog"]');
        output.push({ id: overlay.id, portal: !!dialog, samePanel: panel === overlay.querySelector('.modal'), sameInput: !input || input === panel.querySelector('input'), value: !input || input.value === value });
        closeModal(overlay);
        await new Promise(r => setTimeout(r, 25));
      }
      return output;
    });
    assert(overlays.every(o => o.portal && o.samePanel && o.sameInput && o.value), JSON.stringify(overlays.filter(o => !o.portal || !o.samePanel || !o.sameInput || !o.value)));
    report.overlays = overlays;
    checked(`${overlays.length} overlay: portal Arc, identità del DOM e valori conservati`);

    // Finestre create dopo l'avvio, come statistiche, grafici e scorciatoie.
    await page.evaluate(async () => { document.getElementById('btn-scorciatoie').click(); });
    await page.waitForSelector('#scorciatoie-overlay[data-arc-dialog="open"]');
    await page.screenshot({ path: `${dir}/shortcuts-1440.png` });
    await page.locator('#scorciatoie-lista [data-registra]').first().click();
    await page.keyboard.press('Escape');
    assert(await page.locator('#scorciatoie-overlay').isVisible());
    assert.equal(await page.locator('.scorciatoie-riga.attiva').count(), 0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scorciatoie-overlay', { state: 'detached' });
    await page.evaluate(() => document.getElementById('btn-scorciatoie').click());
    await page.waitForSelector('#scorciatoie-overlay[data-arc-dialog="open"]');
    await page.keyboard.press('Escape');
    checked('Overlay dinamico delle scorciatoie acquisito dal bridge');
    await page.waitForTimeout(200);
    while (await page.locator('.arc-notifications button').count()) await page.locator('.arc-notifications button').first().click();

    for (const theme of ['dark', 'light']) for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      await page.screenshot({ path: `${dir}/workspace-${theme}-${width}.png`, animations: 'disabled' });
      await page.evaluate(async () => (await import('/js/connection.js')).openConnModal());
      await page.waitForSelector('#connect-overlay[data-arc-dialog="open"]');
      await page.locator('#connect-overlay .modal').waitFor({ state: 'visible' });
      await page.screenshot({ path: `${dir}/connection-${theme}-${width}.png`, animations: 'disabled' });
      const layout = await page.evaluate(({ theme, width }) => {
        const modal = document.querySelector('#connect-overlay .modal');
        const rect = modal.getBoundingClientRect();
        return { theme, width, pageOverflow: document.documentElement.scrollWidth > innerWidth,
          modalOverflow: modal.scrollWidth > modal.clientWidth + 1, fits: rect.width > 200 && rect.height > 100 && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          foreground: getComputedStyle(modal).color, background: getComputedStyle(modal).backgroundColor };
      }, { theme, width });
      report.layouts.push(layout);
      assert(!layout.pageOverflow && !layout.modalOverflow && layout.fits, JSON.stringify(layout));
      await page.keyboard.press('Escape');
    }
    checked('390/768/1024/1440 px, chiaro/scuro, movimento ridotto: nessun overflow');
    report.surfaces = [];
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      const surfaces = await page.evaluate(async width => {
        const { openModal, closeModal } = await import('/js/utils.js');
        const result = [];
        for (const overlay of document.querySelectorAll('.overlay')) {
          const modal = overlay.querySelector('.modal');
          if (!modal) continue;
          openModal(overlay);
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const rect = modal.getBoundingClientRect();
          result.push({ id: overlay.id, width, visible: rect.width > 0 && rect.height > 0,
            overflow: modal.scrollWidth > modal.clientWidth + 1,
            fits: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1 });
          closeModal(overlay);
          await new Promise(r => requestAnimationFrame(r));
        }
        return result;
      }, width);
      report.surfaces.push(...surfaces);
    }
    assert(report.surfaces.every(s => s.visible && s.fits && !s.overflow), JSON.stringify(report.surfaces.filter(s => !s.visible || !s.fits || s.overflow)));
    checked('Tutti i pannelli statici: contenitori visibili e senza overflow a tre larghezze');
    await page.evaluate(async () => {
      const { scelteIniziali } = await import('/js/theme-colori.js');
      const { scegliTema } = await import('/js/theme.js');
      const colors = scelteIniziali('dark');
      colors.accent = '#008060';
      localStorage.setItem('codedb:temi', JSON.stringify({ 'arc-verifica': { id: 'arc-verifica', nome: 'Verifica Arc', base: 'dark', scelte: colors } }));
      scegliTema('arc-verifica');
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload();
    await page.waitForSelector('html[data-arc-ready="true"][data-theme-custom="arc-verifica"]');
    const custom = await page.locator('#welcome button').evaluate(e => ({ background: getComputedStyle(e).backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }));
    assert.equal(custom.accent.toLowerCase(), '#008060');
    assert.equal(custom.background, 'rgb(0, 128, 96)');
    await page.screenshot({ path: `${dir}/workspace-custom-1440.png`, animations: 'disabled' });
    await page.evaluate(async () => (await import('/js/theme.js')).scegliTema('dark'));
    checked('Tema personalizzato: accento Arc collegato e persistente al reload');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.waitForTimeout(1800);
    report.resources = await page.evaluate(() => performance.getEntriesByType('resource').map(r => ({ name: r.name.replace(location.origin, ''), bytes: r.encodedBodySize, duration: Math.round(r.duration) })));
    assert(!report.resources.some(r => r.name.includes('uiarc.dev')), 'Arc non deve essere contattato a runtime');
    checked('Ricaricamento diretto della rotta / e movimento standard');
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.requests, []);
    checked('Nessun errore JavaScript, React o HTTP');
  } finally {
    fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2) + '\n');
    await browser.close(); await server.stop();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
