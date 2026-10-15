'use strict';

// Browser, handshake SSH e archivio reali; il database è un echo isolato.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');
const { createServer } = require('../server');
const { openSshTunnel } = require('../db/SshTunnel');
const { sshFixture, roundTrip } = require('./ssh-fixture');
const { scegliArc, spuntaArc } = require('./arc-controls');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-ssh-impronta-'));
  const fixture = await sshFixture();
  const previousStrict = process.env.CODEDB_SSH_STRICT_HOST_KEY;
  delete process.env.CODEDB_SSH_STRICT_HOST_KEY;
  const server = createServer({ config: { desktop: null, env: {
    HOST: '127.0.0.1', PORT: 0, CODEDB_PUBLIC_BIND: '127.0.0.1', CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '',
    CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(root, 'conns'),
    CODEDB_BACKUPS_DIR: path.join(root, 'backups'), CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: path.join(root, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } }, dependencies: {
    openSshTunnel: (ssh, target, options) => openSshTunnel(ssh, target, process.argv.includes('--mutant-trust')
      ? { persistNewHostKey: () => {} } : options),
    DbFactory: { ...require('../db/DbFactory'), getStrategy: type => ({
      type, async connect(cfg) { assert.equal(await roundTrip({ host: cfg.host, port: Number(cfg.port) }), 'codedb-tunnel-fixture'); },
      async listDatabases() { return []; }, async disconnect() {},
    }) },
  } });
  let browser;
  try {
    await server.start();
    browser = await chromium.launch();
    const mobile = process.argv.includes('--mobile');
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.addInitScript(versione => localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, traguardi: {}, checklistChiusa: true })), require('../package.json').version);
    await page.goto(`http://127.0.0.1:${server.server.address().port}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-arc-ready="true"]');
    const ack = (event, payload) => page.evaluate(async ({ event, payload }) => {
      const { socket } = await import('/js/socket.js');
      return new Promise(resolve => socket.emit(event, payload, resolve));
    }, { event, payload });
    const cfg = { ...fixture.ssh, dbType: 'mongodb', host: fixture.target.host, port: String(fixture.target.port),
      connectionMode: 'fields', sshAuth: 'upload', sshPrivateKey: fixture.key.private, sshHostKey: '' };
    for (const event of ['connections:test', 'mongo:connect']) {
      const pending = await ack(event, cfg);
      assert.equal(fixture.stats.authenticationRequests, 0, 'Il rilevamento non invia alcuna richiesta di autenticazione');
      assert.equal(pending.ok, false);
      assert.equal(pending.code, 'SSH_HOST_KEY_UNKNOWN');
      assert.equal(pending.sshHostKey, fixture.ssh.sshHostKey);
    }
    process.env.CODEDB_SSH_STRICT_HOST_KEY = 'on';
    const strict = await ack('connections:test', cfg);
    assert.equal(strict.ok, false);
    assert.equal(strict.sshHostKey, undefined, 'La modalità rigorosa non propone fiducia al primo uso');
    assert.equal(fixture.stats.authenticationRequests, 0);
    delete process.env.CODEDB_SSH_STRICT_HOST_KEY;

    const field = name => page.locator(`#connect-form [name="${name}"]`);
    const prepare = async () => {
      await page.evaluate(async () => (await import('/js/connection.js')).openConnModal());
      await field('host').fill(cfg.host);
      await field('port').fill(cfg.port);
      await spuntaArc(page, '#conn-ssh-toggle', true);
      await page.locator('#wizard-next-btn').click();
      for (const name of ['sshHost', 'sshPort', 'sshUser']) await field(name).fill(cfg[name]);
      await scegliArc(page, '#conn-ssh-auth', 'upload');
      await page.locator('#conn-ssh-key-upload').setInputFiles({ name: 'id_fixture', mimeType: 'text/plain', buffer: Buffer.from(fixture.key.private) });
      await page.waitForFunction(() => !document.querySelector('#conn-ssh-key-status').textContent.startsWith('Lettura del file'));
      assert.equal(await field('sshHostKey').inputValue(), '');
    };
    const confirm = async (accept, action) => {
      const before = fixture.stats.authenticationRequests;
      const pending = mobile ? null : page.waitForEvent('dialog');
      const clicking = action();
      let dialog, message;
      if (mobile) {
        await page.locator('#confirm-overlay[data-arc-dialog="open"]').waitFor();
        message = await page.locator('.arc-confirm-message').textContent();
      } else {
        dialog = await pending;
        message = dialog.message();
      }
      assert(message.includes(fixture.ssh.sshHostKey), 'La conferma mostra l’impronta realmente presentata');
      assert(message.includes(`${cfg.sshHost}:${cfg.sshPort}`), 'La conferma identifica il server');
      assert.equal(fixture.stats.authenticationRequests, before, 'Nessuna autenticazione prima della decisione');
      if (mobile) await page.locator(accept ? '#confirm-ok' : '#confirm-cancel').click();
      else if (accept) await dialog.accept(); else await dialog.dismiss();
      await clicking;
    };
    await prepare();
    await confirm(false, () => page.locator('#conn-test-btn').click());
    await page.locator('#connect-error:not(.hidden)').waitFor();
    assert.equal(await field('sshHostKey').inputValue(), '', 'Annullare non registra l’impronta');
    assert.equal(fixture.stats.authenticationRequests, 0);
    await confirm(true, () => page.locator('#conn-test-btn').click());
    await page.locator('#connect-test-msg:not(.hidden)').waitFor();
    assert.equal(await field('sshHostKey').inputValue(), fixture.ssh.sshHostKey, 'Il campo viene compilato automaticamente');
    assert.equal(fixture.stats.authentications, 1);
    assert.equal(fixture.stats.forwarded, 1);
    await page.locator('#conn-test-btn').click();
    await page.locator('#connect-test-msg:not(.hidden)').waitFor();
    assert.equal(fixture.stats.authentications, 2, 'Il test successivo riusa il pin senza chiedere di nuovo');
    await field('sshHostKey').fill('SHA256:diversa');
    const authenticated = fixture.stats.authenticationRequests;
    await page.locator('#conn-test-btn').click();
    await page.locator('#connect-error:not(.hidden)').waitFor();
    assert.match(await page.locator('#connect-error').textContent(), /NON corrisponde/);
    assert.equal(fixture.stats.authenticationRequests, authenticated, 'Un’impronta diversa blocca prima dell’autenticazione');
    await page.locator('#conn-cancel-btn').click();

    // Anche Conferma e connetti deve acquisire il pin senza un Testa preliminare.
    await prepare();
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const localPort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    await field('sshLocalPort').fill(String(localPort));
    await page.locator('#connect-btn').click();
    assert((await page.locator('#wizard-summary-box').textContent()).includes(`127.0.0.1:${localPort}`), 'Il riepilogo mostra il forwarding richiesto');
    await field('saveAs').fill('Impronta automatica');
    await confirm(true, () => page.locator('#connect-btn').click());
    await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
    const saved = await ack('connections:get', { name: 'Impronta automatica' });
    assert.equal(saved.fields.sshHostKey, fixture.ssh.sshHostKey, 'Il salvataggio conserva il pin approvato');
    assert.equal(saved.fields.sshLocalPort, String(localPort));
    assert.equal(await roundTrip({ host: '127.0.0.1', port: localPort }), 'codedb-tunnel-fixture', 'Un client esterno usa la porta configurata dalla UI');
    const tabId = await page.evaluate(async () => (await import('/js/tabs.js')).activeTab().id);
    await ack('mongo:disconnect', { tabId });
    const checked = await ack('connections:test', { saved: 'Impronta automatica' });
    assert.equal(checked.ok, true, 'La connessione salvata riusa l’impronta');
    await assert.rejects(roundTrip({ host: '127.0.0.1', port: localPort }), /ECONNREFUSED/, 'Il test non lascia la porta aperta');
    await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('Impronta automatica'));
    await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
    await page.locator('#wizard-next-btn').click();
    assert.equal(await field('sshLocalPort').inputValue(), String(localPort), 'Modifica ricarica la porta');
    await field('sshLocalPort').fill('');
    await page.locator('#conn-save-btn').click();
    await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
    assert.equal((await ack('connections:get', { name: 'Impronta automatica' })).fields.sshLocalPort, undefined,
      'Salvare il campo vuoto disattiva il forwarding');
    assert.deepEqual(errors, []);
    console.log('OK: rilevamento senza autenticazione, annullamento, conferma, test e connessione, salvataggio, pin diverso e modalità rigorosa.');
  } finally {
    await browser?.close();
    await server.stop();
    await fixture.close();
    if (previousStrict === undefined) delete process.env.CODEDB_SSH_STRICT_HOST_KEY;
    else process.env.CODEDB_SSH_STRICT_HOST_KEY = previousStrict;
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
