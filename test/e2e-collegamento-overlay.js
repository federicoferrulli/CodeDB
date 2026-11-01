'use strict';

// Frontend e immagine reali; eventi Socket.IO controllati, nessun database utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');

(async () => {
  const server = await startTestServer({ port: 3190 });
  const browser = await chromium.launch();
  const dir = 'test-reports/collegamento-overlay';
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const width of [390, 1440]) {
      const height = width <= 900 ? 844 : 900;
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: width <= 900,
        reducedMotion: 'reduce', serviceWorkers: 'block' });
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let holdDiagnostic = false;
      let heldDiagnostic;
      let onHeld;
      await page.route('**/handshake-check', async route => {
        if (holdDiagnostic) { heldDiagnostic = route; onHeld?.(); return; }
        await route.fulfill({ json: { ok: true } });
      });
      if (process.argv.includes('--mutant')) await page.route('**/js/collegamento.js', async route => {
        const response = await route.fetch();
        const source = await response.text();
        const original = 'if (dismissed || socket.connected) return;';
        assert(source.includes(original), 'Il mutante deve eliminare la memoria della chiusura');
        await route.fulfill({ response, body: source.replaceAll(original, 'if (socket.connected) return;') });
      });
      await page.goto(server.url);
      await page.waitForSelector('html[data-arc-ready="true"]');
      const onboarding = page.locator('#onboarding-overlay [data-azione="chiudi"]');
      if (await onboarding.isVisible()) await onboarding.click();
      await page.waitForFunction(() => !document.querySelector('.overlay[data-arc-dialog="closing"]'));
      await page.evaluate(async () => {
        // Il controller in prova riceve soltanto gli eventi del socket controllato.
        const real = (await import('/js/socket.js')).socketReale();
        for (const name of ['connect', 'disconnect', 'connect_error']) real.removeAllListeners(name);
        real.disconnect();
        const callbacks = new Map();
        const fixture = window.netFixture = {
          session: true, attempts: 0, diagnostics: 0, pendingChecks: 0, clicks: 0,
          push(name, error) {
            if (name === 'connect') socket.connected = true;
            else if (name === 'disconnect' || name === 'connect_error') socket.connected = false;
            callbacks.get(name)?.forEach(callback => callback(error));
          },
        };
        const socket = {
          connected: true,
          on(name, callback) {
            if (!callbacks.has(name)) callbacks.set(name, new Set());
            callbacks.get(name).add(callback); return socket;
          },
          off(name, callback) { callbacks.get(name)?.delete(callback); return socket; },
          connect() { fixture.attempts++; return socket; },
        };
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          if (!String(args[0]).includes('handshake-check')) return nativeFetch(...args);
          fixture.diagnostics++; fixture.pendingChecks++;
          try { return await nativeFetch(...args); }
          finally { fixture.pendingChecks--; }
        };
        const form = document.createElement('div');
        form.id = 'net-underlying';
        form.style.cssText = 'position:fixed;top:12px;left:12px;width:180px;z-index:9000;background:var(--surface)';
        form.innerHTML = '<button type="button" id="net-underlying-action">Azione disponibile</button><input id="net-underlying-input" aria-label="Bozza locale">';
        form.querySelector('button').addEventListener('click', () => fixture.clicks++);
        document.body.append(form);
        (await import('/js/collegamento.js')).initCollegamento(socket, () => fixture.session);
      });
      const overlay = page.getByRole('dialog', { name: 'Collegamento a CodeDB interrotto', exact: true });
      const activate = locator => width <= 900 ? locator.tap() : locator.click();
      const push = (name, error) => page.evaluate(({ name, error }) => window.netFixture.push(name, error), { name, error });
      const settle = async () => {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForFunction(() => window.netFixture.pendingChecks === 0);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      const transportErrors = () => page.evaluate(() => {
        for (let i = 0; i < 3; i++) window.netFixture.push('connect_error', { message: 'websocket error' });
      });

      await page.context().setOffline(true);
      await push('disconnect', 'transport close');
      await overlay.waitFor();
      assert.notEqual(await overlay.getAttribute('aria-modal'), 'true', 'L’avviso non rende inerte il resto dell’app');
      assert.equal(await page.locator('.feedback-banner').count(), 0, 'La perdita di collegamento non genera più un banner');
      const illustration = overlay.locator('svg.connection-lost-art');
      await illustration.waitFor();
      const asset = await illustration.locator('.connection-lost-base').getAttribute('href');
      assert(asset.startsWith('data:image/'), 'L’illustrazione è disponibile senza richieste al server');
      await page.evaluate(async src => {
        const img = new Image(); img.src = src; await img.decode();
      }, asset);
      assert.equal(await illustration.locator('.connection-cable').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations()).length), 0, 'Movimento ridotto: cavo fermo');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      if (process.argv.includes('--mutant-motion')) await page.addStyleTag({ content: '.connection-cable { animation: none !important; }' });
      const motion = await illustration.evaluate(svg => {
        const cables = [...svg.querySelectorAll('.connection-cable')];
        const animations = cables.flatMap(node => node.getAnimations());
        animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
        const initial = cables.map(node => node.getCTM().a);
        animations.forEach(animation => { animation.currentTime = 1400; });
        const peak = cables.map(node => node.getCTM().a);
        animations.forEach(animation => { animation.currentTime = 3000; });
        const resting = cables.map(node => node.getCTM().a);
        animations.forEach(animation => { animation.currentTime = 1400; });
        return { count: animations.length, initial, peak, resting };
      });
      assert.equal(motion.count, 2, 'Entrambi i connettori tentano la riconnessione');
      motion.peak.forEach((scale, index) => {
        assert(scale > motion.initial[index] * 1.06, 'Il connettore si avvicina al centro');
        assert(Math.abs(motion.resting[index] - motion.initial[index]) < 0.001, 'Il cavo torna a riposo tra i tentativi');
      });
      await page.screenshot({ path: `${dir}/${width}-cable-motion.png` });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await illustration.locator('.connection-cable').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations()).length), 0, 'Il cambio di preferenza ferma subito il cavo');
      await page.context().setOffline(false);
      const bounds = await overlay.boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, 'Overlay entro il viewport');
      const copy = overlay.getByRole('button', { name: 'Copia errore', exact: true });
      await activate(copy);
      await overlay.getByRole('status').filter({ hasText: 'Messaggio copiato.' }).waitFor({ state: 'attached' });
      assert(await overlay.isVisible(), 'La copia non chiude l’overlay');
      await page.evaluate(() => {
        window.netCopyFallbacks = 0;
        window.netExecCommand = document.execCommand;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = command => { window.netCopyFallbacks++; return window.netExecCommand.call(document, command); };
      });
      await activate(copy);
      await overlay.getByRole('status').filter({ hasText: 'Messaggio copiato.' }).waitFor({ state: 'attached' });
      assert.equal(await page.evaluate(() => window.netCopyFallbacks), 1, 'La copia usa il fallback quando manca Clipboard API');
      assert(await overlay.isVisible(), 'Il cambio di focus del fallback non chiude l’overlay');
      await page.evaluate(() => { delete navigator.clipboard; document.execCommand = window.netExecCommand; });
      await page.evaluate(async () => (await import('/js/theme.js')).applicaTema('dark'));
      await page.screenshot({ path: `${dir}/${width}-dark.png` });
      await page.evaluate(async () => (await import('/js/theme.js')).applicaTema('light'));
      await page.screenshot({ path: `${dir}/${width}-light.png` });
      await page.locator('#net-underlying-input').fill('Modificabile anche con avviso aperto');
      assert(await overlay.isVisible(), 'Il cambio di focus non chiude l’avviso né blocca la modifica');
      await activate(overlay.getByRole('button', { name: 'Riconnetti', exact: true }));
      assert.equal(await page.evaluate(() => window.netFixture.attempts), 1);
      assert(await overlay.isVisible(), 'Il tentativo manuale non equivale a una riconnessione riuscita');

      await activate(overlay.getByRole('button', { name: 'Chiudi messaggio', exact: true }));
      await overlay.waitFor({ state: 'detached' });
      await transportErrors();
      await settle();
      assert.equal(await overlay.count(), 0, 'I tentativi automatici non riaprono un avviso già chiuso');
      await push('connect_error', { message: 'Origine di test rifiutata dopo la chiusura' });
      await settle();
      assert.equal(await overlay.count(), 0, 'Anche un motivo diverso resta riconosciuto fino alla riconnessione');
      await page.locator('#net-underlying-input').fill('La bozza rimane modificabile');
      assert.equal(await page.locator('#net-underlying-input').inputValue(), 'La bozza rimane modificabile');

      await push('connect');
      await push('disconnect', 'transport close');
      await overlay.waitFor();
      await activate(overlay.getByRole('button', { name: 'Continua a lavorare', exact: true }));
      await overlay.waitFor({ state: 'detached' });
      await transportErrors(); await settle();
      assert.equal(await overlay.count(), 0, 'Anche Continua a lavorare riconosce l’interruzione corrente');

      await push('connect'); await push('disconnect');
      await overlay.waitFor();
      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'detached' });
      await transportErrors(); await settle();
      assert.equal(await overlay.count(), 0, 'Escape chiude per tutta l’interruzione corrente');

      await push('connect'); await push('disconnect');
      await overlay.waitFor();
      await activate(page.locator('#net-underlying-action'));
      assert.equal(await page.evaluate(() => window.netFixture.clicks), 1, 'Il clic esterno raggiunge già l’app sottostante');
      await overlay.waitFor({ state: 'detached' });

      await push('connect'); await push('disconnect');
      await overlay.waitFor();
      await push('connect');
      await overlay.waitFor({ state: 'detached' });
      await page.evaluate(() => { window.netFixture.session = false; });
      await transportErrors();
      await overlay.waitFor();
      assert(await overlay.isVisible(), 'Dopo tre errori l’avviso appare anche al primo collegamento');
      await activate(overlay.getByRole('button', { name: 'Chiudi messaggio', exact: true }));
      await overlay.waitFor({ state: 'detached' });

      await push('connect');
      await push('connect_error', { message: 'auth_required' });
      await settle();
      assert.equal(await overlay.count(), 0, 'L’autenticazione resta nel percorso di login');

      await push('connect');
      holdDiagnostic = true;
      let diagnosticTimer;
      const diagnosticHeld = new Promise((resolve, reject) => {
        onHeld = () => { clearTimeout(diagnosticTimer); resolve(); };
        diagnosticTimer = setTimeout(() => reject(new Error('Diagnostica HTTP non avviata')), 10000);
      });
      try { await Promise.all([transportErrors(), diagnosticHeld]); }
      finally { clearTimeout(diagnosticTimer); }
      assert.equal(await page.evaluate(() => window.netFixture.pendingChecks), 1);
      await push('connect');
      await heldDiagnostic.fulfill({ json: { ok: false, reason: 'Rifiuto ricevuto in ritardo' } });
      holdDiagnostic = false;
      await settle();
      assert.equal(await overlay.count(), 0, 'Una diagnostica tardiva non riapre l’avviso dopo la riconnessione');
      assert.equal(await page.locator('#net-underlying-input').inputValue(), 'La bozza rimane modificabile');
      assert.deepEqual(errors, [], 'Nessun errore JavaScript');
      await page.close();
      console.log(`OK collegamento ${width}px: immagine, chiusura, riconnessione, app utilizzabile, primo avvio e diagnostica tardiva`);
    }
    // Verifica anche il cablaggio reale initConnection → initCollegamento.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const integrationErrors = [];
    page.on('pageerror', error => integrationErrors.push(error.message));
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    const onboarding = page.locator('#onboarding-overlay [data-azione="chiudi"]');
    if (await onboarding.isVisible()) await onboarding.click();
    await page.waitForFunction(() => !document.querySelector('.overlay[data-arc-dialog="closing"]'));
    await page.evaluate(async () => { window.netReal = (await import('/js/socket.js')).socketReale(); });
    await page.waitForFunction(() => window.netReal.connected);
    await page.evaluate(async () => {
      const { createTab, tabs } = await import('/js/tabs.js');
      const tab = createTab({ id: 'collegamento-reale-non-salvato' });
      tab.label = 'Sessione di prova non salvata'; tab.state.connected = true;
      tabs.activeId = tab.id;
      window.netReal.io.reconnection(false);
      window.netReal.io.engine.close();
    });
    const realOverlay = page.getByRole('dialog', { name: 'Collegamento a CodeDB interrotto', exact: true });
    await realOverlay.waitFor();
    assert.equal(await page.locator('.feedback-banner').count(), 0);
    await realOverlay.getByRole('button', { name: 'Riconnetti', exact: true }).click();
    await page.waitForFunction(() => window.netReal.connected);
    await realOverlay.waitFor({ state: 'detached' });
    assert.deepEqual(integrationErrors, [], 'Nessun errore nel percorso reale del socket');
    await page.close();
    console.log('OK integrazione reale: perdita trasporto e riconnessione Socket.IO, nessun database collegato');
  } finally { await browser.close(); await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
