'use strict';
// Diagnostica reale nel browser, misure sintetiche: nessuna connessione esterna.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { spuntaArc } = require('./arc-controls');
const mutant = process.argv.includes('--mutant');
const checksOnly = process.argv.includes('--checks-only');
const dir = `test-reports/salute-design-2026-10-12/${mutant ? 'mutante' : process.argv.includes('--confirm') ? 'conferma' : 'dopo'}`;
(async () => {
  const server = await startTestServer({ port: 3211 });
  const browser = await chromium.launch();
  const report = { checks: [], layouts: [], frames: [], errors: [], environment: 'Chromium, risposte diagnostiche sintetiche' };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => report.errors.push(e.message));
  fs.mkdirSync(dir, { recursive: true });
  const ok = text => { report.checks.push(text); console.log('OK', text); };
  try {
    await page.addInitScript(version => {
      localStorage.setItem('codedb:tema', 'dark');
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    await page.evaluate(async () => {
      const { impostaSocket } = await import('/js/socket.js');
      window.healthFixture = { calls: 0, hold: false, fail: false, pending: [], connections: [
        { tabId: 'mongo', connName: 'mongodb', dbType: 'mongodb', status: 'ok', latencyMs: 2, ssh: { active: false }, extra: { servers: 1 } },
        { tabId: 'pg', connName: 'PostgreSQL · Analisi', dbType: 'postgresql', status: 'ok', latencyMs: 82, ssh: { active: true, alive: true, host: 'bastion.interno.example', port: 22 }, pool: { active: 3, limit: 10, idle: 5, waiting: 0 } },
        { tabId: 'mysql', connName: 'Archivio <img src=x> & storico', dbType: 'mysql', status: 'error', error: 'Connessione rifiutata. Controlla host e porta del server.', ssh: { active: true, alive: false, lastError: 'Timeout del tunnel SSH.' } },
      ] };
      const fake = { connected: true, on() {}, off() {}, timeout() { return { emit: (name, payload, cb) => fake.emit(name, payload, r => cb(null, r)) }; }, emit(name, payload, cb) {
        const f = window.healthFixture;
        if (name !== 'health:connections') return cb?.({ ok: true, databases: [], collections: [] });
        f.calls++;
        const response = f.fail ? { ok: false, error: 'Server non raggiungibile' } : { ok: true, connections: structuredClone(f.connections) };
        if (f.hold) f.pending.push(() => cb(response)); else cb(response);
      } };
      impostaSocket(fake);
    });
    const open = async () => { await page.locator('#btn-health').evaluate(el => el.click()); await page.waitForSelector('#modal-health[data-arc-dialog="open"]'); await page.waitForTimeout(450); };
    const close = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('modal-health').dataset.arcDialog); };
    const refresh = async () => { await page.locator('#btn-refresh-health').click(); await page.waitForFunction(() => !document.querySelector('#health-list').hasAttribute('aria-busy')); };
    await open();
    assert.equal(await page.locator('.health-table tbody tr').count(), 3);
    assert.equal(await page.locator('#health-list img').count(), 0);
    assert.match(await page.locator('#health-list').textContent(), /Archivio <img src=x> & storico/);
    await spuntaArc(page, '#health-auto-refresh', false);
    if (mutant) await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) { return animate.call(this, frames, this.matches('.health-value') ? { ...options, duration: 0 } : options); };
    });
    report.frames = await page.evaluate(async () => {
      const row = document.querySelector('[data-key="mongo"]');
      window.healthStable = { row, name: row.cells[0].firstElementChild.firstElementChild };
      window.healthFixture.connections[0].latencyMs = 14;
      const frames = [], start = performance.now(); document.getElementById('btn-refresh-health').click();
      await new Promise(resolve => { function sample(now) {
        frames.push(getComputedStyle(row.cells[1].querySelector('.health-value')).transform);
        if (now - start < 300) requestAnimationFrame(sample); else resolve();
      } requestAnimationFrame(sample); });
      return frames;
    });
    assert(new Set(report.frames).size > 3, 'Il nuovo valore attraversa fotogrammi intermedi');
    assert(await page.evaluate(() => window.healthStable.row === document.querySelector('[data-key="mongo"]') && window.healthStable.name === document.querySelector('[data-key="mongo"]').cells[0].firstElementChild.firstElementChild));
    await refresh();
    assert.equal(await page.locator('#health-list').evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'Dati invariati senza animazioni');
    ok('Aggiornamento animato solo dei dati cambiati, nodi stabili, nomi escaped e dettagli SSH/pool');
    await page.evaluate(() => { window.healthFixture.hold = true; });
    await page.locator('#btn-refresh-health').click();
    await page.waitForFunction(() => window.healthFixture.pending.length === 1);
    const calls = await page.evaluate(() => window.healthFixture.calls);
    await spuntaArc(page, '#health-auto-refresh', true);
    await page.waitForTimeout(4300);
    assert.equal(await page.evaluate(() => window.healthFixture.calls), calls, 'Un solo ping in volo');
    assert(await page.locator('#btn-refresh-health').isDisabled());
    await close();
    await open();
    await page.evaluate(() => { window.healthFixture.connections[0].latencyMs = 55; window.healthFixture.pending.shift()(); });
    await page.waitForFunction(() => window.healthFixture.pending.length === 1);
    assert.match(await page.locator('[data-key="mongo"] .health-ping').textContent(), /14/);
    await page.evaluate(() => { window.healthFixture.hold = false; window.healthFixture.pending.shift()(); });
    await page.waitForFunction(() => document.querySelector('[data-key="mongo"] .health-ping').textContent.includes('55'));
    await close();
    const afterClose = await page.evaluate(() => window.healthFixture.calls);
    await page.waitForTimeout(4300);
    assert.equal(await page.evaluate(() => window.healthFixture.calls), afterClose, 'Polling fermo dopo Escape');
    await open();
    await spuntaArc(page, '#health-auto-refresh', false);
    ok('Ping lento senza sovrapposizioni, risposta obsoleta scartata, riapertura fresca e polling fermo a finestra chiusa');
    await page.evaluate(() => { window.healthFixture.fail = true; });
    await refresh();
    assert(await page.locator('#health-error').isVisible());
    assert.equal(await page.locator('.health-table tbody tr').count(), 3);
    assert.match(await page.locator('#health-checked').textContent(), /Ultima riuscita · \d{2}:\d{2}:\d{2}/);
    await page.evaluate(() => { window.healthFixture.fail = false; });
    await refresh();
    assert(!(await page.locator('#health-error').isVisible()));
    await page.evaluate(() => { window.healthFixture.saved = window.healthFixture.connections; window.healthFixture.connections = []; });
    await refresh();
    await page.getByText('Nessuna connessione da monitorare', { exact: true }).waitFor();
    await page.evaluate(() => { window.healthFixture.connections = [{ ...window.healthFixture.saved[0], latencyMs: null }]; });
    await refresh();
    assert.equal(await page.locator('.health-ping').textContent(), '—');
    await page.evaluate(() => { window.healthFixture.connections[0].latencyMs = 450; });
    await refresh();
    assert.match(await page.locator('#health-summary').textContent(), /Latenza elevata/);
    await page.evaluate(() => { window.healthFixture.connections = [{ ...window.healthFixture.saved[1], pool: { active: 10, limit: 10, idle: 0, waiting: 2 } }]; });
    await refresh();
    assert.match(await page.locator('#health-summary').textContent(), /Richieste in attesa/);
    ok('Errori recuperabili senza perdere gli ultimi dati, stato vuoto, ping sconosciuto/lento e pool in coda');
    await page.evaluate(() => { window.healthFixture.connections = window.healthFixture.saved; });
    await refresh();
    await spuntaArc(page, '#health-auto-refresh', true);
    const beforeHidden = await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return window.healthFixture.calls;
    });
    await page.waitForTimeout(4300);
    assert.equal(await page.evaluate(() => window.healthFixture.calls), beforeHidden, 'Polling sospeso in background');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(previous => window.healthFixture.calls > previous, beforeHidden);
    await spuntaArc(page, '#health-auto-refresh', false);
    for (const [width, height, theme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [390, 844, 'dark'], [320, 720, 'light'], [844, 390, 'dark']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForTimeout(400);
      const layout = await page.locator('#modal-health .modal').evaluate(el => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, panelWidth: b.width, panelHeight: b.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, shellWidth: document.documentElement.scrollWidth };
      });
      assert(layout.x >= -1 && layout.x + layout.panelWidth <= width + 1 && layout.y >= -1, 'Pannello contenuto nel viewport');
      assert(layout.scrollWidth <= layout.clientWidth + 1 && layout.shellWidth <= width + 1, 'Nessun overflow orizzontale');
      if (width <= 900) {
        assert(await page.locator('#modal-health .arc-dialog-sheet[data-fit-content]').isVisible());
        assert((await page.locator('#btn-refresh-health').boundingBox()).height >= 44);
        const checkbox = await page.locator('#modal-health .health-auto').boundingBox();
        const button = await page.locator('#btn-refresh-health').boundingBox();
        assert(Math.abs(checkbox.y - button.y) < 2, 'Controlli compatti sulla stessa riga');
      }
      const contrast = await page.evaluate(() => {
        const luminance = color => {
          const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const background = luminance(getComputedStyle(document.querySelector('#modal-health .modal')).backgroundColor);
        return [...document.querySelectorAll('#modal-health .health-ok, #modal-health .health-err, #modal-health .health-warn, #modal-health .health-detail, #health-checked')].map(el => {
          const fg = luminance(getComputedStyle(el).color);
          return { text: el.textContent, ratio: (Math.max(background, fg) + .05) / (Math.min(background, fg) + .05) };
        });
      });
      assert(contrast.every(c => c.ratio >= 4.5), JSON.stringify(contrast.filter(c => c.ratio < 4.5)));
      report.layouts.push({ width, height, theme, contrast, ...layout });
      if (!checksOnly) await page.screenshot({ path: `${dir}/salute-${theme}-${width}.png` });
      if (width === 320) {
        await page.locator('[data-key="mysql"]').scrollIntoViewIfNeeded();
        if (!checksOnly) await page.screenshot({ path: `${dir}/errore-light-320.png` });
        await page.locator('#modal-health .modal').evaluate(el => { el.scrollTop = 0; });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { window.healthFixture.connections = [{ ...window.healthFixture.saved[0], latencyMs: 2 }]; });
    await refresh();
    await page.waitForTimeout(400);
    if (!checksOnly) await page.screenshot({ path: `${dir}/singola-dark-390.png` });
    await page.evaluate(() => { window.healthFixture.connections = []; });
    await refresh();
    await page.waitForTimeout(400);
    if (!checksOnly) await page.screenshot({ path: `${dir}/vuoto-dark-390.png` });
    await close();
    await page.locator('#mobile-nav-conns').click();
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem', { name: /Salute/ }).click();
    await page.waitForSelector('#modal-health[data-arc-dialog="open"]');
    assert.equal(await page.locator('.arc-navigation-sheet').count(), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { window.healthFixture.connections = window.healthFixture.saved; });
    await refresh();
    assert.equal(await page.locator('#health-list').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.getByRole('button', { name: 'Chiudi finestra', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('modal-health').dataset.arcDialog);
    assert.equal(await page.locator('#health-list').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    assert.deepEqual(report.errors, []);
    ok('Desktop/mobile/landscape, temi, chiusura Arc, percorso Strumenti, movimento ridotto e nessun errore JS');
  } catch (e) { report.failure = e.stack; throw e; }
  finally { fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
