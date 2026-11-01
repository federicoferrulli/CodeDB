'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openSshTunnel } = require('../db/SshTunnel');
const { sshFixture, roundTrip } = require('./ssh-fixture');

module.exports = (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-ssh-keys-'));
  const fixture = await sshFixture();
  const keyPath = path.join(dir, 'chiave con spazi');
  fs.writeFileSync(keyPath, fixture.key.private);
  try {
    const vault = require('../server/vault').createModule({
      config: require('../server/configurazione').configurazione({ env: { CODEDB_CONNECTIONS_FILE: path.join(dir, 'connections.ini'), CODEDB_CONNECTIONS_DIR: path.join(dir, 'conns'), GUI_MONGO_PASSPHRASE: 'vault-fixture' } }),
      errori: { errMsg: e => e.message }, dependencies: { DbFactory: require('../db/DbFactory') },
    });
    const previous = vault.sanitizeConnCfg({ ...fixture.ssh, connectionMode: 'fields', sshAuth: 'upload', sshPrivateKey: fixture.key.private, sshKeyName: 'id_ed25519', sshPassphrase: ' con spazi ', sshLocalPort: '15432' });
    assert.equal(previous.sshPrivateKey === fixture.key.private, true, 'La chiave deve restare integra');
    assert.equal(previous.sshPassphrase, ' con spazi ');
    vault.saveConnections({ prova: previous });
    assert(!fs.readFileSync(path.join(dir, 'connections.ini'), 'utf8').includes('BEGIN OPENSSH'));
    assert.equal(vault.loadConnections().prova.sshPrivateKey === fixture.key.private, true, 'Chiave cifrata rileggibile');
    assert.equal(vault.loadConnections().prova.sshPassphrase, ' con spazi ');
    assert.equal(vault.loadConnections().prova.sshLocalPort, '15432', 'La porta locale si salva insieme alla connessione');
    assert.equal(vault.sanitizeConnCfg({}, previous).sshLocalPort, '15432', 'Gli aggiornamenti parziali conservano la porta');
    assert.equal(vault.sanitizeConnCfg({ sshLocalPort: '' }, previous).sshLocalPort, undefined, 'Svuotare rimuove la porta salvata');
    assert.throws(() => vault.sanitizeConnCfg({ sshLocalPort: '123x' }), /porta locale/);
    assert.equal(vault.sanitizeConnCfg({ ...previous, sshKeyName: 'nome\nsshHost=altro' }).sshKeyName, 'nome sshHost=altro');
    const next = { ...fixture.ssh, sshAuth: 'upload' };
    assert.equal(vault.preserveConnSecrets(next, previous).sshPrivateKey === fixture.key.private, true);
    assert.equal(vault.preserveConnSecrets({ ...next, sshPrivateKey: fixture.encrypted.private }, previous).sshPassphrase, undefined);
    for (const change of [{ sshAuth: 'password' }, { sshAuth: 'path', sshKeyFile: keyPath }, { ssh: '' }, { connectionMode: 'uri', uri: 'mongodb://localhost' }]) {
      assert.equal(vault.preserveConnSecrets({ ...previous, ...change }, previous).sshPrivateKey, undefined);
    }
    assert.throws(() => vault.sanitizeConnCfg({ ...next, sshPrivateKey: 'x'.repeat(65537) }), /64 KB/);
    const cliPath = require.resolve('../backup/lib/connstore');
    const cached = require.cache[cliPath], oldEnv = process.env.CODEDB_CONNECTIONS_FILE;
    try {
      process.env.CODEDB_CONNECTIONS_FILE = path.join(dir, 'connections.ini');
      delete require.cache[cliPath];
      assert.equal(require(cliPath).loadConnections('vault-fixture', 'local').prova.sshPrivateKey === fixture.key.private, true, 'Anche la CLI decifra la chiave');
    } finally {
      delete require.cache[cliPath];
      if (cached) require.cache[cliPath] = cached;
      if (oldEnv === undefined) delete process.env.CODEDB_CONNECTIONS_FILE; else process.env.CODEDB_CONNECTIONS_FILE = oldEnv;
    }
    console.log('  OK   SSH: vault, riuso, cambio modalità e CLI');
    for (const [name, cfg] of [
      ['percorso sul server', { sshKeyFile: keyPath }],
      ['percorso copiato con virgolette', { sshKeyFile: `"${keyPath}"` }],
      ['file caricato dal dispositivo', { sshPrivateKey: fixture.key.private }],
      ['file caricato con passphrase', { sshPrivateKey: fixture.encrypted.private, sshPassphrase: 'passphrase-fixture' }],
      ['chiave PEM PKCS8', { sshPrivateKey: fixture.pem.privateKey }],
    ]) {
      const tunnel = await openSshTunnel({ ...fixture.ssh, ...cfg }, fixture.target);
      try { assert.equal(await roundTrip(tunnel), 'codedb-tunnel-fixture'); }
      finally { tunnel.close(); }
      console.log('  OK   SSH: ' + name);
    }
    const home = os.homedir;
    os.homedir = () => dir;
    try {
      const tunnel = await openSshTunnel({ ...fixture.ssh, sshKeyFile: '~/chiave con spazi' }, fixture.target);
      try { assert.equal(await roundTrip(tunnel), 'codedb-tunnel-fixture'); } finally { tunnel.close(); }
    } finally { os.homedir = home; }
    for (const [cfg, expected] of [
      [{ sshPrivateKey: fixture.key.public }, /chiave pubblica/],
      [{ sshAuth: 'upload', sshPrivateKey: '' }, /vuoto/],
      [{ sshPrivateKey: 'x'.repeat(65537) }, /64 KB/],
      [{ sshPrivateKey: fixture.encrypted.private }, /passphrase/],
      [{ sshPrivateKey: fixture.encrypted.private, sshPassphrase: 'errata' }, /passphrase/],
      [{ sshKeyFile: path.join(dir, 'inesistente') }, /percorso sul server CodeDB/],
      [{ sshPrivateKey: fixture.key.private, sshHostKey: 'SHA256:errata' }, /NON corrisponde/],
      [{ sshPrivateKey: 'PuTTY-User-Key-File-3: ssh-ed25519' }, /PPK|PuTTY|formato/i],
    ]) await assert.rejects(openSshTunnel({ ...fixture.ssh, ...cfg }, fixture.target), expected);
    assert.equal(fixture.stats.authentications, 6, 'Nessuna autenticazione per chiavi invalide o host non fidato');
    assert.equal(fixture.stats.forwarded, 6);
    console.log('  OK   SSH: home, errori file/passphrase e host key prima delle credenziali');
  } finally {
    await fixture.close();
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
