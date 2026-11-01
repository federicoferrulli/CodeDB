'use strict';

// Browser, validazione, vault e tunnel reali con chiavi usa-e-getta e traffico loopback.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server');
const { sshFixture, roundTrip } = require('./ssh-fixture');
const { makePpk } = require('./ssh-ppk-fixture');
const { scegliArc, spuntaArc } = require('./arc-controls');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-ui-formati-ssh-'));
  const fixture = await sshFixture();
  const der = crypto.createPrivateKey(fixture.pem.privateKey).export({ format: 'der', type: 'pkcs8' });
  const privatePath = path.join(root, 'chiave binaria con spazi.der');
  fs.writeFileSync(privatePath, der);
  const server = createServer({ config: { desktop: null, env: {
    HOST: '127.0.0.1', PORT: 0, CODEDB_PUBLIC_BIND: '127.0.0.1', CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '',
    CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(root, 'conns'),
    CODEDB_BACKUPS_DIR: path.join(root, 'backups'), CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: path.join(root, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } }, dependencies: { DbFactory: { ...require('../db/DbFactory'), getStrategy: type => ({
    type, async connect(cfg) { assert.equal(await roundTrip({ host: cfg.host, port: Number(cfg.port) }), 'codedb-tunnel-fixture'); },
    async listDatabases() { return []; }, async disconnect() {},
  }) } } });
  let browser, page, validationCount = 0, delayedCount = 0;
  const pageErrors = [];
  const checks = [];
  try {
    await server.start();
    server.io.on('connection', socket => {
      socket.use((packet, next) => {
        if (packet[0] === 'ssh:key:validate') {
          validationCount++;
          if (packet[1].cfg.sshPassphrase === 'risposta-tardiva') {
            // Si ritarda solo il trasporto della risposta reale, senza sostituire il parser.
            const ack = packet[packet.length - 1];
            packet[packet.length - 1] = (...args) => setTimeout(() => { delayedCount++; ack(...args); }, 1000);
          }
        }
        next();
      });
    });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => pageErrors.push(error.message));
    if (process.argv.includes('--mutant')) {
      // Prova di sensibilità: si rompe solo il codice servito al browser, ripristinando la lettura binaria come testo.
      await page.route('**/js/connection.js', async route => {
        const response = await route.fetch();
        const source = await response.text();
        const original = "text = 'base64:' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));";
        assert(source.includes(original), 'Il mutante deve cambiare davvero la serializzazione binaria');
        await route.fulfill({ response, body: source.replace(original, 'text = new TextDecoder().decode(bytes);') });
      });
    }
    const field = name => page.locator(`#connect-form [name="${name}"]`);
    const status = page.locator('#conn-ssh-key-status');
    const waitState = state => page.waitForFunction(state => document.querySelector('#conn-ssh-key-status').dataset.state === state, state);
    const upload = async (name, data) => {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#conn-ssh-key-select').click();
      await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(data) });
    };
    const ack = (event, payload) => page.evaluate(async ({ event, payload }) => {
      const { socket } = await import('/js/socket.js');
      return new Promise(resolve => socket.emit(event, payload, resolve));
    }, { event, payload });
    const testConnection = async () => {
      const before = fixture.stats.forwarded;
      await page.locator('#conn-test-btn').click();
      await page.locator('#connect-test-msg:not(.hidden), #connect-error:not(.hidden)').waitFor();
      assert(await page.locator('#connect-error').isHidden(), await page.locator('#connect-error').textContent());
      assert.equal(fixture.stats.forwarded, before + 1, 'Testa deve attendere la verifica e attraversare il tunnel');
      assert.equal(await status.getAttribute('data-state'), 'valid');
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

    await upload('chiave.der', der);
    await testConnection();
    assert.match(await status.textContent(), /verificata/i);
    assert.match(await status.textContent(), /Impronta chiave: SHA256:/);
    checks.push('DER binario preservato e autenticazione SSH reale');

    if (!process.argv.includes('--binary-only')) {
      await upload('non-una-chiave.ppk', 'PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\nPrivate-Lines: 0\n');
      await waitState('error');
      assert(!/Chiave verificata|Chiave caricata/.test(await status.textContent()));
      const beforeInvalid = fixture.stats.authenticationRequests;
      await page.locator('#conn-test-btn').click();
      await page.locator('#connect-error:not(.hidden)').waitFor();
      assert.equal(fixture.stats.authenticationRequests, beforeInvalid, 'Un file non valido non deve arrivare a SSH');
      checks.push('File incompleto rifiutato subito, senza connessioni SSH');

      await upload('putty3.ppk', await makePpk(fixture.key.private, { version: 3 }));
      await testConnection();
      await upload('putty3-protetta.ppk', await makePpk(fixture.key.private, { version: 3, passphrase: 'passphrase-fixture' }));
      await waitState('passphrase');
      assert.match(await status.textContent(), /passphrase/i);
      await field('sshPassphrase').fill('risposta-tardiva');
      await waitState('checking');
      await field('sshPassphrase').fill('passphrase-fixture');
      await testConnection();
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(delayedCount, 1, 'La risposta obsoleta è realmente arrivata');
      assert.equal(await status.getAttribute('data-state'), 'valid', 'Una risposta obsoleta non deve invalidare la passphrase nuova');
      checks.push('PPK3 cifrato e in chiaro reali, passphrase richiesta e risposta tardiva scartata');

      await field('sshPassphrase').fill('');
      await upload('id_ed25519', fixture.key.private);
      await testConnection();
      checks.push('OpenSSH senza estensione ancora funzionante');

      const { generaFormati } = require('./ssh-formati-fixture');
      for (const item of await generaFormati()) {
        if (!/pfx|p12|pkcs.?12/i.test(item.name)) continue;
        await field('sshPassphrase').fill(item.passphrase || '');
        await upload(item.name, item.data);
        await waitState('valid');
        checks.push(`Validazione upload ${item.name}`);
      }

      await field('sshPassphrase').fill('');
      await upload('chiave.der', der);
      await page.locator('#connect-btn').click();
      await field('saveAs').fill('Formati SSH UI');
      await page.locator('#connect-btn').click();
      await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
      const savedFile = fs.readFileSync(path.join(root, 'connections.ini'), 'utf8');
      assert.match(savedFile, /sshPrivateKey=ENC:/);
      assert(!savedFile.includes(der.toString('base64')));
      const saved = await ack('connections:get', { name: 'Formati SSH UI' });
      assert(saved.ok && saved.hasSshPrivateKey && !saved.fields.sshPrivateKey);

      await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('Formati SSH UI'));
      await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
      await page.locator('#wizard-next-btn').click();
      const priorValidation = validationCount;
      await page.locator('#conn-save-btn').click();
      await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
      assert.equal(validationCount, priorValidation, 'Salvare la chiave invariata non richiede di ricollegare l’hardware');
      await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('Formati SSH UI'));
      await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
      await page.locator('#wizard-next-btn').click();
      const beforeInvalidSave = fs.readFileSync(path.join(root, 'connections.ini'), 'utf8');
      await upload('non-valida', Buffer.from([0, 255, 254, 1]));
      await page.locator('#conn-save-btn').click();
      await page.locator('#connect-error:not(.hidden)').waitFor();
      assert(await page.locator('#connect-overlay').isVisible());
      assert.equal(fs.readFileSync(path.join(root, 'connections.ini'), 'utf8'), beforeInvalidSave, 'Una sostituzione invalida non deve sovrascrivere la chiave salvata');
      await upload('sostituzione.der', der);
      await page.locator('#conn-save-btn').click();
      await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
      checks.push('Connetti e Salva attendono verifica, vault cifrato e sostituzione invalida senza perdita dei dati');

      await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('Formati SSH UI'));
      await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
      await page.locator('#wizard-next-btn').click();
      await scegliArc(page, '#conn-ssh-auth', 'path');
      await field('sshKeyFile').fill(`"${privatePath}"`);
      await testConnection();
      assert(await status.isVisible(), 'Anche il percorso server deve mostrare l’esito della verifica');
      checks.push('Percorso server binario con spazi verificato e collegato');

      const { keyPair, securityKey, privateHandle } = require('./ssh-agent-fixture');
      await scegliArc(page, '#conn-ssh-auth', 'upload');
      assert(await page.locator('#conn-ssh-security-key-pin-row').isHidden());
      await field('sshPassphrase').fill('');
      await upload('id_fido_protetto', privateHandle(securityKey(keyPair()), 'passphrase-fixture'));
      await waitState('passphrase');
      assert(await page.locator('#conn-ssh-security-key-pin-row').isHidden());
      await field('sshPassphrase').fill('passphrase-fixture');
      await waitState('valid');
      assert(await page.locator('#conn-ssh-security-key-pin-row').isVisible());
      assert.equal(await field('sshSecurityKeyPin').getAttribute('type'), 'password');
      const hardwarePin = 'PIN-ui-fixture-4918';
      await field('sshSecurityKeyPin').fill(hardwarePin);
      await field('sshPassphrase').fill('errata');
      await waitState('error');
      assert(await page.locator('#conn-ssh-security-key-pin-row').isVisible(), 'Cambiare passphrase non deve nascondere il PIN della stessa identità');
      assert.equal(await field('sshSecurityKeyPin').inputValue(), hardwarePin);
      await field('sshPassphrase').fill('passphrase-fixture');
      await waitState('valid');
      await page.locator('#conn-save-btn').click();
      await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
      const pinSaved = await ack('connections:get', { name: 'Formati SSH UI' });
      assert.equal(pinSaved.hasSshSecurityKeyPin, true);
      assert.equal(pinSaved.fields.sshSecurityKeyPin, undefined);
      const pinFile = fs.readFileSync(path.join(root, 'connections.ini'), 'utf8');
      assert.match(pinFile, /sshSecurityKeyPin=ENC:/);
      assert(!pinFile.includes(hardwarePin));
      checks.push('PIN FIDO mostrato solo per hardware, distinto dalla passphrase e cifrato al salvataggio');

      await page.evaluate(async () => (await import('/js/connection.js')).startEditConn('Formati SSH UI'));
      await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
      await page.locator('#wizard-next-btn').click();
      await waitState('valid');
      assert(await page.locator('#conn-ssh-security-key-pin-row').isVisible());
      assert.equal(await field('sshSecurityKeyPin').inputValue(), '');
      assert.match(await field('sshSecurityKeyPin').getAttribute('placeholder'), /invariato/);
      await field('sshSecurityKeyPin').fill('PIN-da-non-trasferire');
      await upload('identita-diversa.der', der);
      await waitState('valid');
      assert(await page.locator('#conn-ssh-security-key-pin-row').isHidden());
      assert.equal(await field('sshSecurityKeyPin').inputValue(), '');
      await page.locator('#conn-save-btn').click();
      await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
      assert.equal((await ack('connections:get', { name: 'Formati SSH UI' })).hasSshSecurityKeyPin, false);
      checks.push('PIN salvato mai rimandato al browser, preservato solo per la stessa identità e azzerato al cambio file');
    }
    assert.deepEqual(pageErrors, []);
    console.log(`OK: ${checks.length} scenari formati SSH UI, ${validationCount} verifiche e ${fixture.stats.forwarded} inoltri reali`);
  } catch (error) {
    fs.mkdirSync(path.resolve('test-reports'), { recursive: true });
    await page?.screenshot({ path: path.resolve('test-reports/ssh-formati-ui-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    await server.stop();
    await fixture.close();
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
