'use strict';

// UI, socket, vault e SSH reali; il DB è un endpoint echo dietro il tunnel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server');
const { sshFixture, roundTrip } = require('./ssh-fixture');
const { scegliArc, spuntaArc } = require('./arc-controls');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-ui-ssh-'));
  const reportDir = path.resolve('test-reports/ssh-keys-2026-10-11');
  fs.mkdirSync(reportDir, { recursive: true });
  const fixture = await sshFixture();
  const keyPath = path.join(root, 'chiave con spazi');
  fs.writeFileSync(keyPath, fixture.key.private);
  const server = createServer({ config: { desktop: null, env: {
    HOST: '127.0.0.1', PORT: 0, CODEDB_PUBLIC_BIND: '127.0.0.1', CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '',
    CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(root, 'conns'),
    CODEDB_BACKUPS_DIR: path.join(root, 'backups'), CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: path.join(root, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } }, dependencies: { DbFactory: { ...require('../db/DbFactory'), getStrategy: type => ({
    type, async connect(cfg) { assert.equal(await roundTrip({ host: cfg.host, port: Number(cfg.port) }), 'codedb-tunnel-fixture'); },
    async listDatabases() { return []; }, async disconnect() {},
  }) } } });
  let browser, page;
  const report = { checks: [], layouts: [], errors: [] };
  try {
    await server.start();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: process.argv.includes('--mobile') ? { width: 320, height: 844 } : { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    const field = name => page.locator(`#connect-form [name="${name}"]`);
    const ack = (event, payload) => page.evaluate(async ({ event, payload }) => {
      const { socket } = await import('/js/socket.js');
      return new Promise(resolve => socket.emit(event, payload, resolve));
    }, { event, payload });
    const upload = async (name, text) => {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#conn-ssh-key-select').click();
      await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
      await page.waitForFunction(() => !document.querySelector('#conn-ssh-key-status').textContent.startsWith('Lettura del file'));
    };
    const testConnection = async () => {
      const before = fixture.stats.forwarded;
      await page.locator('#conn-test-btn').click();
      await page.locator('#connect-test-msg:not(.hidden), #connect-error:not(.hidden)').waitFor();
      assert(await page.locator('#connect-error').isHidden(), await page.locator('#connect-error').textContent());
      assert.equal(fixture.stats.forwarded, before + 1, 'Testa deve attraversare il tunnel reale');
    };
    await page.goto(`http://127.0.0.1:${server.server.address().port}`);
    await page.waitForSelector('html[data-arc-ready="true"]');
    if (await page.locator('#onboarding-close').isVisible()) await page.locator('#onboarding-close').click();
    await page.evaluate(async () => (await import('/js/connection.js')).openConnModal());
    await field('host').fill(fixture.target.host);
    await field('port').fill(String(fixture.target.port));
    await spuntaArc(page, '#conn-ssh-toggle', true);
    await page.locator('#wizard-next-btn').click();
    for (const name of ['sshHost', 'sshPort', 'sshUser', 'sshHostKey']) await field(name).fill(fixture.ssh[name]);
    await scegliArc(page, '#conn-ssh-auth', 'upload');
    await upload('id_ed25519.pub', fixture.key.public);
    await page.locator('#conn-test-btn').click();
    assert.match(await page.locator('#connect-error').textContent(), /chiave pubblica/);
    assert.equal(fixture.stats.authentications, 0);
    await upload('troppo-grande', 'x'.repeat(65537));
    await page.locator('#conn-test-btn').click();
    assert.match(await page.locator('#connect-error').textContent(), /64 KB/);
    await upload('id_ed25519', fixture.key.private);
    await testConnection();
    report.checks.push('Selezione file senza estensione; rifiuto .pub e file troppo grande; autenticazione e inoltro SSH reali');

    for (const theme of process.argv.includes('--checks-only') ? [] : ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width > 900 ? 1000 : 844 });
        await page.locator(`#connect-overlay ${width <= 900 ? '.arc-dialog-sheet' : '.arc-dialog-shell'}`).waitFor();
        await page.locator('#conn-ssh-key-select').scrollIntoViewIfNeeded();
        const size = await page.locator('#connect-overlay .modal').evaluate(el => [el.clientWidth, el.scrollWidth]);
        assert(size[1] <= size[0] + 1, `Overflow SSH a ${width}`);
        await page.screenshot({ path: path.join(reportDir, `ssh-${theme}-${width}.png`), animations: 'disabled' });
        report.layouts.push({ theme, width });
      }
    }
    await page.locator('#connect-btn').click();
    const summary = await page.locator('#wizard-summary-box').textContent();
    assert(summary.includes('id_ed25519') && summary.includes('File dal dispositivo'));
    assert(!summary.includes('BEGIN OPENSSH'));
    await field('saveAs').fill('SSH dal dispositivo');
    await page.locator('#connect-btn').click();
    await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
    assert.equal(fixture.stats.forwarded, 2);
    const raw = fs.readFileSync(path.join(root, 'connections.ini'), 'utf8');
    assert.match(raw, /sshPrivateKey=ENC:/);
    assert(!raw.includes('BEGIN OPENSSH'));
    const saved = await ack('connections:get', { name: 'SSH dal dispositivo' });
    assert(saved.ok && saved.hasSshPrivateKey && !saved.fields.sshPrivateKey);
    const state = await page.evaluate(async () => ({
      configs: (await import('/js/tabs.js')).tabs.list.map(t => t.connCfg), storage: { ...localStorage, ...sessionStorage },
      file: document.querySelector('#conn-ssh-key-upload').value,
    }));
    assert(!JSON.stringify(state).includes('BEGIN OPENSSH'));
    assert.equal(state.file, '');
    report.checks.push('Riepilogo senza chiave in chiaro; file cifrato; get restituisce solo presenza; nessuna chiave nei tab/storage');

    await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('SSH dal dispositivo'));
    await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
    await page.locator('#wizard-next-btn').click();
    assert.match(await page.locator('#conn-ssh-key-status').textContent(), /Chiave già salvata: id_ed25519/);
    await testConnection();
    await page.locator('#conn-cancel-btn').click();
    await page.evaluate(async () => (await import('/js/connection.js')).connectAndOpenTab({ saved: 'SSH dal dispositivo' }));
    assert.equal(fixture.stats.forwarded, 4);
    await page.evaluate(() => { window.sshPreviousDocument = true; });
    await page.reload();
    await page.evaluate(async () => { window.sshRestoreModules = await Promise.all([import('/js/session-restore.js'), import('/js/tabs.js')]); });
    await page.waitForFunction(() => !window.sshPreviousDocument && !window.sshRestoreModules[0].restoreInProgress()
      && window.sshRestoreModules[1].tabs.list.filter(t => t.state.connected).length === 2);
    assert.equal(fixture.stats.forwarded, 6);
    report.checks.push('Modifica con chiave conservata e riconnessione salvata, anche dopo ricaricamento');

    await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('SSH dal dispositivo'));
    await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
    await page.locator('#wizard-next-btn').click();
    await upload('id_rsa_protetta', fixture.encrypted.private);
    await field('sshPassphrase').fill('errata');
    await page.locator('#conn-test-btn').click();
    await page.locator('#connect-error:not(.hidden)').waitFor();
    assert.match(await page.locator('#connect-error').textContent(), /passphrase/);
    await field('sshPassphrase').fill('passphrase-fixture');
    await testConnection();
    await page.locator('#conn-save-btn').click();
    await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
    const encryptedSaved = await ack('connections:get', { name: 'SSH dal dispositivo' });
    assert(encryptedSaved.hasSshPrivateKey && encryptedSaved.hasSshPassphrase && !encryptedSaved.fields.sshPrivateKey && !encryptedSaved.fields.sshPassphrase);
    await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('SSH dal dispositivo'));
    await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
    await page.locator('#wizard-next-btn').click();
    assert.match(await field('sshPassphrase').getAttribute('placeholder'), /invariata/);
    await testConnection();
    await upload('id_ed25519', fixture.key.private);
    assert(!/invariata/.test(await field('sshPassphrase').getAttribute('placeholder')));
    await scegliArc(page, '#conn-ssh-auth', 'path');
    await field('sshKeyFile').fill(`"${keyPath}"`);
    await field('sshPassphrase').fill('');
    await testConnection();
    report.checks.push('Passphrase errata spiegata, chiave cifrata accettata e percorso Windows tra virgolette funzionante');
    report.checks.push('Passphrase salvata riutilizzata senza rinviarla al browser; sostituzione della chiave aggiorna il suggerimento');
    assert.deepEqual(report.errors, []);
    console.log(`OK: ${report.checks.length} scenari SSH reali, ${report.layouts.length} layout, ${fixture.stats.forwarded} inoltri`);
  } catch (error) {
    report.failure = error.stack;
    await page?.screenshot({ path: path.join(reportDir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    const reportName = process.argv.includes('--checks-only') ? (process.argv.includes('--mobile') ? 'checks-mobile.json' : 'checks-desktop.json') : 'report.json';
    fs.writeFileSync(path.join(reportDir, reportName), JSON.stringify(report, null, 2));
    await browser?.close();
    await server.stop();
    await fixture.close();
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
