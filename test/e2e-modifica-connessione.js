'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { startTestServer } = require('./e2e-harness');
const dir = path.resolve('test-reports/modifica-connessione-2026-10-12', process.argv.includes('--before') ? 'prima' : 'dopo');

(async () => {
  const server = await startTestServer({ port: 3212 });
  const browser = await chromium.launch();
  try {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'passphrase-di-prova' });
    const keyFile = path.join(server.dir, 'chiave di prova.pem');
    const otherKeyFile = path.join(server.dir, 'altra chiave.pem');
    fs.writeFileSync(keyFile, privateKey);
    fs.writeFileSync(otherKeyFile, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }));
    const vault = require('../server/vault').createModule({
      config: require('../server/configurazione').configurazione({ env: {
        CODEDB_CONNECTIONS_FILE: path.join(server.dir, 'connections.ini'),
        CODEDB_CONNECTIONS_DIR: path.join(server.dir, 'conns'), GUI_MONGO_PASSPHRASE: '',
      } }), errori: { errMsg: e => e.message }, dependencies: { DbFactory: require('../db/DbFactory') },
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.addInitScript(version => {
      localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: version, checklistChiusa: true }));
    }, require('../package.json').version);
    await page.goto(server.url);
    await page.waitForSelector('html[data-arc-ready="true"]');
    const ack = (event, payload) => page.evaluate(async ({ event, payload }) => {
      const { socket } = await import('/js/socket.js');
      return new Promise(resolve => socket.emit(event, payload, resolve));
    }, { event, payload });
    const cfg = { dbType: 'postgresql', connectionMode: 'fields', host: 'db.example.test', port: '27017',
      username: 'utente-prova', password: 'password-di-prova', database: 'archivio', folder: 'Collaudo', readOnly: 'false',
      ssh: 'true', sshHost: 'ssh.example.test', sshPort: '2222', sshUser: 'tunnel-prova', sshAuth: 'path',
      sshKeyFile: keyFile, sshPassphrase: 'passphrase-di-prova', sshHostKey: 'SHA256:impronta-di-prova' };
    const fixtures = [
      ['PostgreSQL SSH chiave', cfg],
      ['MySQL SSH password', { ...cfg, dbType: 'mysql', port: '5432', sshAuth: 'password', sshPassword: 'ssh-di-prova' }],
      ['MongoDB SSH file', { ...cfg, dbType: 'mongodb', port: '27019', database: '', authSource: 'autenticazione', sshAuth: 'upload', sshPrivateKey: privateKey, sshKeyName: 'id_prova' }],
      ['MongoDB URI', { dbType: 'mongodb', connectionMode: 'uri', uri: 'mongodb://utente:segreto-uri@host-a:27017,host-b:27018/archivio?authSource=admin&tls=true&authMechanismProperties=TOKEN:segreto-opzione', folder: 'Collaudo', readOnly: 'false' }],
      ['Postgres alias', { ...cfg, dbType: 'postgres', port: '5544', ssh: '' }],
    ];
    fs.mkdirSync(dir, { recursive: true });
    const failures = [];
    const capture = async file => {
      for (const close of await page.getByRole('button', { name: 'Chiudi notifica' }).all()) await close.click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(dir, file) });
    };
    for (const [index, [name, params]] of fixtures.entries()) {
      assert.equal((await ack('connections:save', { name, cfg: params })).ok, true);
      const before = vault.loadConnections()[name];
      await page.setViewportSize({ width: index === 2 ? 390 : 1440, height: 1000 });
      await page.evaluate(async name => (await import('/js/connection.js')).startEditConn(name), name);
      await page.locator('#connect-overlay[data-arc-dialog="open"]').waitFor();
      if (!process.argv.includes('--before')) {
        assert(await page.locator('#conn-edit-hint').isVisible(), 'Le credenziali conservate sono dichiarate nel form');
        if (before.uri) {
          const summary = await page.locator('#conn-uri-saved').textContent();
          assert(summary.includes('host-a:27017,host-b:27018/archivio') && summary.includes('authSource=admin'), 'URI salvata leggibile');
          assert(!summary.includes('segreto-uri') && !summary.includes('segreto-opzione'), 'URI salvata mascherata');
        }
      }
      for (const key of ['host', 'port', 'username', 'database', 'folder', 'sshHost', 'sshPort', 'sshUser', 'sshKeyFile', 'sshHostKey']) {
        if (!before[key]) continue;
        if (await page.locator(`#connect-form [name="${key}"]`).inputValue() !== before[key]) failures.push(`${name}: ${key} non caricato`);
      }
      await capture(`${index}-parametri.png`);
      if (before.ssh === 'true') {
        await page.locator('#wizard-next-btn').click();
        await capture(`${index}-ssh.png`);
      }
      await page.locator('#connect-btn').click();
      await capture(`${index}-riepilogo.png`);
      if (index === 2) {
        await page.locator('#conn-save-btn').scrollIntoViewIfNeeded();
        await capture(`${index}-riepilogo-scorrimento.png`);
        assert(await page.locator('#conn-save-btn').isVisible(), 'Il salvataggio mobile resta raggiungibile');
      }
      await page.locator('#conn-save-btn').click();
      await page.locator('#connect-overlay').waitFor({ state: 'hidden' });
      const after = vault.loadConnections()[name];
      for (const key of Object.keys(before)) {
        const expected = key === 'dbType' && before[key] === 'postgres' ? 'postgresql' : before[key];
        if (expected !== after[key]) failures.push(`${name}: ${key} cambiato senza modifica`);
      }
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ failures }, null, 2));
    assert.deepEqual(failures, [], 'Salvare senza modifiche deve conservare tutti i parametri e i segreti');
    console.log('OK Cinque configurazioni: caricamento e salvataggio senza reinserire campi o segreti');
    const name = fixtures[0][0];
    const before = vault.loadConnections()[name];
    assert.equal((await ack('connections:save', { name, oldName: name, cfg: { folder: 'Spostata' } })).ok, true);
    let after = vault.loadConnections()[name];
    assert(Object.keys(before).every(key => key === 'folder' ? after[key] === 'Spostata' : before[key] === after[key]), 'Aggiornamento parziale conserva tutti i campi omessi');
    assert.equal((await ack('connections:save', { name, oldName: name, cfg: { username: '', database: '', folder: '', password: '' } })).ok, true);
    after = vault.loadConnections()[name];
    for (const key of ['username', 'database', 'folder']) assert(!after[key], `Rimozione esplicita di ${key}`);
    assert(after.password === before.password && after.sshPassphrase === before.sshPassphrase, 'I segreti vuoti rimangono invariati');
    assert.equal((await ack('connections:save', { name, oldName: name, cfg: { password: 'password-sostitutiva', sshKeyFile: otherKeyFile } })).ok, true);
    after = vault.loadConnections()[name];
    assert(after.password === 'password-sostitutiva' && !after.sshPassphrase, 'Nuova password sostituita e passphrase non riusata su una chiave diversa');
    assert.equal((await ack('connections:save', { name, oldName: name, cfg: { ssh: '' } })).ok, true);
    assert(!vault.loadConnections()[name].sshPrivateKey && !vault.loadConnections()[name].sshPassphrase, 'Disattivazione SSH esplicita rispettata');
    console.log('OK Aggiornamenti parziali, vuoti espliciti, password sostituita e cambio chiave SSH');
    assert.deepEqual(errors, [], 'Nessun errore JavaScript');
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ failures, errors,
      checks: ['Cinque configurazioni salvate senza perdita di parametri o segreti', 'Porte personalizzate e alias postgres',
        'URI leggibile e mascherata', 'Aggiornamenti parziali e cancellazioni esplicite', 'Cambio password e chiave SSH',
        'Screenshot desktop e mobile, salvataggio raggiungibile dopo scorrimento'] }, null, 2));
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
