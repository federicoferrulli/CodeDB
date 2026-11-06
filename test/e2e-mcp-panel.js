'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// Tutti i cambi reali avvengono nella configurazione usa e getta dell'harness.
async function main() {
  const server = await startTestServer({ port: Number(process.env.E2E_MCP_PANEL_PORT || 3197) });
  const browser = await chromium.launch();
  const clients = [];
  const output = path.join(__dirname, '..', 'test-reports', 'mcp-panel');
  fs.mkdirSync(output, { recursive: true });
  async function client() {
    const value = new Client({ name: 'Verifica interfaccia MCP', version: '1.0' });
    await value.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    clients.push(value); return value;
  }
  try {
    const mcp = await client();
    await mcp.callTool({ name: 'list_saved_connections', arguments: {} });
    await mcp.callTool({ name: 'connect_database', arguments: { name: 'connessione-di-test-inesistente' } });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    if (process.env.MCP_PANEL_SELECTION_MUTANT === '1') await page.route('**/js/mcp-panel.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const mutated = source.replace("row.classList.toggle('selected',", "row.classList.toggle('selezione-rotta',");
      assert.notEqual(source, mutated, 'Il mutante deve rompere la selezione visiva');
      await route.fulfill({ response, body: mutated });
    });
    if (process.env.MCP_PANEL_MUTANT === '1') await page.route('**/js/mcp-panel.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const mutated = source.replace('values: patch, revision: settings.revision', 'values: { ...patch, maxSessions: 32 }, revision: settings.revision');
      assert.notEqual(source, mutated, 'Il mutante deve alterare il salvataggio');
      await route.fulfill({ response, body: mutated });
    });
    page.on('pageerror', err => errors.push(err.message));
    page.on('dialog', d => d.accept());
    await page.goto(server.url, { waitUntil: 'networkidle' });
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    if (await page.getByRole('button', { name: 'Nascondi i primi passi' }).isVisible()) await page.getByRole('button', { name: 'Nascondi i primi passi' }).click();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.locator('#conn-settings-btn').click();
    await page.getByRole('menuitem', { name: 'MCP', exact: true }).click();
    await page.locator('#mcp-panel').waitFor({ state: 'visible' });
    await page.locator('.mcp-session strong').filter({ hasText: 'Verifica interfaccia MCP' }).waitFor();
    console.log('OK: apertura e sessione reale.');
    assert.equal(await page.locator('#welcome').isVisible(), false, 'Il workspace lascia spazio alla sezione MCP');
    assert.match(await page.locator('#mcp-endpoint-value').inputValue(), /\/mcp$/);
    await page.screenshot({ path: path.join(output, 'overview-dark-1440.png') });

    await page.locator('#mcp-tab-activity').click();
    await page.locator('[data-action="detail"]').first().waitFor();
    assert.match(await page.locator('#mcp-activity-list').innerText(), /list_saved_connections/);
    await page.locator('[data-action="detail"]').first().click();
    await page.locator('#mcp-detail h2').waitFor();
    assert.equal(await page.locator('.mcp-activity-list tr.selected').count(), 1, 'Il dettaglio deve evidenziare la riga selezionata');
    assert.match(await page.locator('#mcp-detail').innerText(), /Invocazione/);
    await page.screenshot({ path: path.join(output, 'activity-dark-1440.png') });
    await page.locator('[data-action="close-detail"]').click();
    assert.equal(await page.locator('.mcp-activity-list tr.selected').count(), 0, 'Chiudere il dettaglio rimuove la selezione visiva');
    await page.locator('#mcp-filters [name="search"]').fill('nessun-evento-corrispondente');
    await page.getByText('Nessuna attività con questi filtri').waitFor();
    await page.locator('[data-action="reset-filters"]').click();
    await page.locator('[data-action="detail"]').first().waitFor();
    await page.locator('[data-action="live"]').click();
    assert.equal(await page.locator('[data-action="live"]').getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('#mcp-live-state').innerText(), /in pausa/);
    await page.locator('[data-action="live"]').click();
    const download = page.waitForEvent('download');
    await page.locator('[data-action="export-json"]').click();
    const file = await download;
    const exported = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    assert(exported.some(e => e.tool === 'list_saved_connections'), 'Esportazione dello storico reale');
    console.log('OK: elenco, dettaglio, ricerca, pausa ed esportazione.');

    await page.locator('#mcp-tab-access').click();
    await page.getByText(/CodeDB è in modalità locale/).waitFor();
    await page.locator('#mcp-tab-settings').click();
    await page.locator('#mcp-setting-maxSessions').waitFor();
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Impostazioni senza overflow a ${width}px`);
      await page.locator('#mcp-setting-auditGenerations').scrollIntoViewIfNeeded();
      const bar = await page.locator('.mcp-settings-footer').boundingBox();
      assert(bar && bar.y >= 0 && bar.y + bar.height < 1000, `Salvataggio sempre raggiungibile a ${width}px`);
    }
    await page.locator('#mcp-setting-maxSessions').fill('17');
    assert.equal(await page.locator('#mcp-save-settings').isEnabled(), true);
    await page.locator('#mcp-tab-overview').click();
    await page.locator('#mcp-tab-settings').click();
    assert.equal(await page.locator('#mcp-setting-maxSessions').inputValue(), '17', 'Il cambio sezione conserva la bozza');
    page.removeAllListeners('dialog');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('[data-action="close"]').click();
    assert.equal(await page.locator('#mcp-panel').isVisible(), true, 'Annullare la chiusura conserva la bozza');
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#mcp-save-settings').click();
    await page.waitForFunction(() => document.querySelector('#mcp-dirty')?.textContent === 'Impostazioni salvate' && document.querySelector('#mcp-save-settings')?.disabled);
    const persisted = JSON.parse(fs.readFileSync(path.join(server.dir, 'mcp-settings.json'), 'utf8'));
    assert.equal(persisted.values.maxSessions, 17, 'Il salvataggio UI modifica realmente il file isolato');
    console.log('OK: configurazione persistente.');
    await page.screenshot({ path: path.join(output, 'settings-dark-1440.png') });
    await page.getByRole('checkbox', { name: 'Abilita MCP', exact: true }).uncheck();
    await page.locator('#mcp-save-settings').click();
    await page.waitForFunction(() => document.querySelector('#mcp-dirty')?.textContent === 'Impostazioni salvate' && document.querySelector('#mcp-save-settings')?.disabled);
    await page.locator('#mcp-tab-overview').click();
    await page.locator('.mcp-service-state[data-state="disabled"]').waitFor();
    const disabledResponse = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'disabled-probe', version: '1' } } }) });
    assert.equal(disabledResponse.status, 503, 'Disabilitare MCP cambia il comportamento HTTP reale');
    await page.locator('#mcp-tab-settings').click();
    await page.getByRole('checkbox', { name: 'Abilita MCP', exact: true }).check();
    await page.locator('#mcp-save-settings').click();
    await page.waitForFunction(() => document.querySelector('#mcp-dirty')?.textContent === 'Impostazioni salvate' && document.querySelector('#mcp-save-settings')?.disabled);
    const resumed = await client();
    await resumed.callTool({ name: 'list_saved_connections', arguments: {} });
    await page.locator('#mcp-tab-overview').click();
    await page.locator('.mcp-service-state[data-state="active"]').waitFor();

    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#mcp-tab-activity').click();
      await page.locator('[data-action="detail"]').first().waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Nessuno scorrimento orizzontale della pagina mobile');
      await page.locator('[data-action="detail"]').first().click();
      await page.locator('#mcp-detail h2').waitFor();
      assert.equal(await page.locator('#mcp-activity-list').isVisible(), false, 'Il dettaglio mobile sostituisce l’elenco');
      await page.screenshot({ path: path.join(output, `activity-${theme}-390.png`) });
      await page.locator('[data-action="close-detail"]').click();
      await page.locator('#mcp-tab-settings').click();
      await page.locator('#mcp-setting-maxSessions').waitFor();
      assert.equal(await page.locator('.mcp-content').evaluate(el => el.scrollTop), 0, 'Una sezione diversa si apre dall’inizio');
      await page.screenshot({ path: path.join(output, `settings-${theme}-390.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.locator('#mcp-tab-settings').focus();
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#mcp-tab-overview').getAttribute('aria-selected'), 'true', 'Navigazione delle schede da tastiera');
    await page.screenshot({ path: path.join(output, 'overview-light-1440.png') });
    await page.locator('[data-action="close"]').click();
    assert.equal(await page.locator('#mcp-panel').isVisible(), false);
    assert.equal(await page.locator('#welcome').isVisible(), true, 'Il ritorno ripristina il workspace');

    // Le diramazioni UI RBAC usano risposte controllate; autorizzazioni e persistenza
    // delle chiavi sono verificate separatamente nei test del backend.
    await page.evaluate(async () => {
      const { socketReale, impostaSocket } = await import('/js/socket.js');
      const real = socketReale();
      const saved = await new Promise(resolve => real.emit('mcp:settings:get', {}, resolve));
      const fixture = window.mcpUiFixture = { keys: [], created: [], revoked: [], denySettings: false, runtimeFailure: false, saved };
      const reply = (event, payload) => {
        if (event === 'auth:me') return { ok: true, user: { id: 'ui-admin', rbac: true } };
        if (event === 'mcp:status') return { ok: true, state: 'active', endpoint: `${location.origin}/mcp`, rbac: true, permissions: { manageSettings: !fixture.denySettings, manageAccess: true }, sessions: [], auditHealth: { ok: true } };
        if (event === 'mcp:connections:list') return { ok: true, connections: [{ name: 'demo', label: 'Connessione demo', dbType: 'mongodb', readOnly: true, canManage: true, permissions: { read: true, write: false, ddl: false } }] };
        if (event === 'users:list') return { ok: true, users: [{ id: 'ui-user', email: 'utente@example.test' }] };
        if (event === 'apikeys:list') return { ok: true, keys: fixture.keys };
        if (event === 'apikeys:create') {
          fixture.created.push(payload);
          const key = { id: 'ui-key', label: payload.label, subjectId: payload.subjectId || 'ui-admin', prefix: 'cdb_test', connScope: payload.connScope };
          fixture.keys.push(key);
          return { ok: true, key: 'cdb_segreto_solo_fixture', apiKey: key };
        }
        if (event === 'apikeys:revoke') { fixture.revoked.push(payload.id); fixture.keys = fixture.keys.filter(key => key.id !== payload.id); return { ok: true }; }
        if (event === 'mcp:settings:get') return { ...fixture.saved, overrides: { auditMaxMiB: 'CODEDB_MCP_AUDIT_MAX_MIB' }, applied: !fixture.runtimeFailure, applyError: fixture.runtimeFailure ? 'Impostazioni salvate, applicazione incompleta: errore controllato.' : null };
        if (event === 'mcp:settings:update') { fixture.saved.values = { ...fixture.saved.values, ...payload.values }; fixture.runtimeFailure = true; return { ...fixture.saved, applied: false, applyError: 'Impostazioni salvate, applicazione incompleta: errore controllato.' }; }
        return null;
      };
      impostaSocket(new Proxy(real, { get(target, key) {
        if (key === 'timeout') return undefined;
        if (key === 'emit') return (event, payload, callback) => {
          const result = reply(event, payload);
          if (result) { setTimeout(() => callback(result), event === 'apikeys:create' ? 250 : 0); return target; }
          return target.emit(event, payload, callback);
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } }));
      await (await import('/js/mcp-panel.js')).openMcpPanel();
    });
    await page.locator('#mcp-tab-access').click();
    await page.locator('#mcp-key-form input[name="label"]').fill('Client di prova');
    await page.getByRole('checkbox', { name: 'Tutte quelle concesse al soggetto' }).uncheck();
    await page.getByRole('checkbox', { name: 'Connessione demo' }).check();
    await page.locator('#mcp-key-form button[type="submit"]').click();
    await page.locator('#mcp-tab-activity').click();
    assert.equal(await page.locator('#mcp-tab-access').getAttribute('aria-selected'), 'true', 'La creazione protegge il segreto dal cambio sezione');
    await page.locator('#mcp-secret').waitFor();
    assert.equal(await page.locator('#mcp-secret').inputValue(), 'cdb_segreto_solo_fixture');
    assert.deepEqual(await page.evaluate(() => window.mcpUiFixture.created[0].connScope), ['demo'], 'Lo scope scelto raggiunge il server');
    await page.locator('#mcp-tab-activity').click();
    assert.equal(await page.locator('#mcp-secret').count(), 0, 'La chiave sparisce lasciando la sezione');
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('cdb_segreto_solo_fixture')), false, 'La chiave non è salvata nello storage');
    await page.locator('#mcp-tab-access').click();
    await page.locator('[data-action="revoke-key"]').click();
    await page.waitForFunction(() => window.mcpUiFixture.revoked.length === 1);
    await page.locator('#mcp-tab-settings').click();
    assert.equal(await page.locator('#mcp-setting-auditMaxMiB').isDisabled(), true, 'Override ambiente non editabile');
    await page.locator('#mcp-setting-maxSessions').fill('18');
    await page.locator('#mcp-save-settings').click();
    await page.getByRole('alert').filter({ hasText: 'applicazione incompleta' }).waitFor();
    await page.locator('[data-action="close"]').click();
    await page.evaluate(() => { window.mcpUiFixture.denySettings = true; });
    await page.evaluate(async () => (await import('/js/mcp-panel.js')).openMcpPanel());
    await page.locator('#mcp-tab-settings').click();
    assert.equal(await page.locator('#mcp-setting-maxSessions').isDisabled(), true, 'Permessi in sola consultazione');
    await page.locator('[data-action="close"]').click();
    assert.deepEqual(errors, [], 'Nessun errore JavaScript');
    console.log('OK: MCP UI, attività reali, esportazione, persistenza, disattivazione/riattivazione, tastiera e responsive; UI chiavi, scope, revoca, permessi e applicazione incompleta con fixture.');
  } finally {
    for (const value of clients) await value.close().catch(() => {});
    await browser.close(); await server.stop();
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
