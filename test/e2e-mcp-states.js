'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
(async () => {
  const server = await startTestServer({ port: 3198 });
  const browser = await chromium.launch();
  const output = path.join(__dirname, '..', 'test-reports', 'mcp-states');
  fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    page.on('console', msg => { if (msg.type() === 'error') console.log('BROWSER', msg.text()); });
    page.on('pageerror', err => console.log('PAGEERROR', err.message));
    if (process.env.MCP_STATES_MUTANT === '1') await page.route('**/js/mcp-panel.js', async route => {
      const response = await route.fetch(), source = await response.text();
      const body = source.replace('seq !== settingsSequence || edits !== settingsEdits || ', '');
      assert.notEqual(body, source);
      await route.fulfill({ response, body });
    });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(async () => {
      const { socketReale, impostaSocket } = await import('/js/socket.js');
      const real = socketReale();
      const saved = await new Promise(resolve => real.emit('mcp:settings:get', {}, resolve));
      window.review = { fail: 'mcp:status', held: [], hold: false, saved };
      impostaSocket(new Proxy(real, { get(target, key) {
        if (key === 'timeout') return undefined;
        if (key === 'emit') return (event, payload, cb) => {
          const f = window.review;
          if (event === f.fail) { cb({ ok: false, error: 'Errore controllato di lettura' }); return target; }
          if (event === 'mcp:settings:get' && f.hold) { f.held.push(() => cb(structuredClone(saved))); return target; }
          const responses = {
            'auth:me': { ok: true, user: { id: 'review', rbac: true } },
            'mcp:status': { ok: true, state: 'active', rbac: true, permissions: { manageSettings: true, manageAccess: true }, sessions: [], auditHealth: { ok: true } },
            'mcp:activity:list': { ok: true, entries: [], total: 0 },
            'mcp:connections:list': { ok: true, connections: [] },
            'apikeys:list': { ok: true, keys: [] },
            'users:list': { ok: true, users: [] },
            'mcp:settings:get': structuredClone(saved),
          };
          if (responses[event]) { cb(responses[event]); return target; }
          return target.emit(event, payload, cb);
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } }));
      await (await import('/js/mcp-panel.js')).openMcpPanel();
    });
    assert.match(await page.locator('#mcp-message').innerText(), /Errore controllato/);
    assert.equal(await page.locator('#mcp-overview-content .data-empty-art').count(), 1);
    assert.doesNotMatch(await page.locator('#mcp-overview-content').innerText(), /Caricamento/);
    await page.screenshot({ path: path.join(output, 'errore-servizio-desktop.png') });
    await page.setViewportSize({ width: 375, height: 844 });
    await page.screenshot({ path: path.join(output, 'errore-servizio-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { window.review.fail = null; });
    await page.locator('#mcp-overview-content').getByRole('button', { name: 'Riprova' }).click();
    await page.getByRole('heading', { name: /Gateway MCP/ }).waitFor();
    await page.locator('[data-action="close"]').click();
    await page.evaluate(async () => { window.review.fail = 'mcp:activity:list'; await (await import('/js/mcp-panel.js')).openMcpPanel(); });
    await page.locator('#mcp-tab-activity').click();
    await page.locator('#mcp-message').waitFor();
    assert.equal(await page.locator('#mcp-activity-list .data-empty-art').count(), 1);
    assert.doesNotMatch(await page.locator('#mcp-activity-list').innerText(), /Caricamento/);
    await page.evaluate(() => { window.review.fail = null; });
    await page.locator('#mcp-activity-list').getByRole('button', { name: 'Riprova' }).click();
    await page.getByText('Nessuna attività registrata', { exact: true }).waitFor();
    assert.equal(await page.locator('#mcp-message').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'attivita-vuote.png') });
    await page.locator('#mcp-filters [name="search"]').fill('assente');
    await page.getByText('Nessuna attività con questi filtri', { exact: true }).waitFor();
    await page.locator('#mcp-activity-list').getByRole('button', { name: 'Azzera filtri' }).click();
    await page.getByText('Nessuna attività registrata', { exact: true }).waitFor();
    await page.locator('#mcp-tab-access').click();
    assert.match(await page.locator('#mcp-connections').innerText(), /Nessuna connessione/);
    assert.match(await page.locator('#mcp-keys').innerText(), /Nessuna API key/);
    await page.evaluate(() => { window.review.hold = true; });
    await page.locator('#mcp-tab-settings').click();
    await page.waitForFunction(() => window.review.held.length === 1);
    await page.evaluate(() => { window.review.hold = false; });
    await page.locator('#mcp-tab-settings').click();
    await page.locator('#mcp-setting-maxSessions').fill('17');
    assert.equal(await page.locator('#mcp-save-settings').isEnabled(), true);
    await page.evaluate(() => window.review.held.shift()());
    assert.equal(await page.locator('#mcp-setting-maxSessions').inputValue(), '17', 'Una risposta superata non deve sovrascrivere la bozza');
    assert.equal(await page.locator('#mcp-save-settings').isEnabled(), true);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await page.setViewportSize({ width: 375, height: 844 });
      await page.locator('#mcp-tab-activity').click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.equal(await page.locator('#mcp-activity-list .data-empty-art').count(), 1);
    }
    console.log('OK: errori illustrati, ripresa, vuoti distinti, bozze protette e mobile nei due temi.');
  } finally { await browser.close(); await server.stop(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
