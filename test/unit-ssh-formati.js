'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { utils } = require('ssh2');
const { preparaChiaveSsh, decodificaChiave } = require('../db/SshKey');
const { openSshTunnel } = require('../db/SshTunnel');
const { sshFixture, roundTrip } = require('./ssh-fixture');
const { generaFormati } = require('./ssh-formati-fixture');
const { makePpk } = require('./ssh-ppk-fixture');

function verificaChiave(result, expected) {
  let parsed = utils.parseKey(result.privateKey);
  if (Array.isArray(parsed)) parsed = parsed[0];
  assert(!(parsed instanceof Error));
  assert(parsed.getPublicSSH().equals(expected.getPublicSSH()), 'La conversione deve conservare esattamente l’identità');
  const challenge = Buffer.from('CodeDB: prova della chiave convertita');
  assert.equal(expected.verify(challenge, parsed.sign(challenge)), true, 'La chiave convertita firma correttamente');
}

module.exports = (async () => {
  const rows = generaFormati();
  for (const type of ['rsa', 'dsa', 'ecdsa', 'ed25519']) {
    const source = rows.find(row => row.name === `openssh_new_${type}`);
    for (const version of [2, 3]) for (const passphrase of ['', 'PPK protetta 🔑']) {
      rows.push({ name: `PPK${version}-${type}-${passphrase ? 'protetta' : 'libera'}`, data: Buffer.from(await makePpk(source.data.toString(), { version, passphrase })), passphrase, publicKey: source.publicKey });
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-formati-ssh-'));
  const fixture = await sshFixture({ additionalKeys: rows.map(row => row.publicKey) });
  let checks = 0;
  try {
    for (const row of rows) {
      const encoded = row.name.includes('-der-') || row.name.includes('PKCS12') ? 'base64:' + row.data.toString('base64') : row.data.toString();
      const cfg = { ...fixture.ssh, sshAuth: 'upload', sshPrivateKey: encoded, sshPassphrase: row.passphrase };
      const result = await preparaChiaveSsh(cfg);
      verificaChiave(result, row.publicKey);
      const tunnel = await openSshTunnel(cfg, fixture.target);
      try { assert.equal(await roundTrip(tunnel), 'codedb-tunnel-fixture'); }
      finally { await tunnel.close(); }
      if (row.name.includes('-der-') || row.name.includes('PKCS12') || row.name === 'PPK3-ed25519-protetta') {
        const filename = path.join(dir, 'chiave binaria con spazi');
        fs.writeFileSync(filename, row.data);
        const fromPath = await preparaChiaveSsh({ sshAuth: 'path', sshKeyFile: `"${filename}"`, sshPassphrase: row.passphrase });
        verificaChiave(fromPath, row.publicKey);
      }
      checks++;
    }
    const before = fixture.stats.authentications;
    for (const row of rows.filter(row => row.passphrase && /PKCS8|PKCS12|PPK3/.test(row.name))) {
      const encoded = 'base64:' + row.data.toString('base64');
      await assert.rejects(openSshTunnel({ ...fixture.ssh, sshAuth: 'upload', sshPrivateKey: encoded }, fixture.target), /passphrase/i);
      await assert.rejects(openSshTunnel({ ...fixture.ssh, sshAuth: 'upload', sshPrivateKey: encoded, sshPassphrase: 'errata' }, fixture.target), /passphrase/i);
      checks += 2;
    }
    assert.equal(fixture.stats.authentications, before, 'Nessuna autenticazione con credenziali invalide');
    assert.throws(() => decodificaChiave('base64:' + Buffer.alloc(65537).toString('base64')), /64 KB/);
    assert.throws(() => decodificaChiave('base64:!!!!'), /non valido/);
    assert.throws(() => decodificaChiave('base64:AB=='), /non valida/);
    assert.equal(decodificaChiave('base64:' + Buffer.alloc(65536, 42).toString('base64')).length, 65536);
    const workerPath = require.resolve('../db/SshKeyWorker');
    const source = fs.readFileSync(workerPath, 'utf8');
    const broken = source.replace("if (key.asymmetricKeyType === 'ed25519')", 'if (false)');
    assert.notEqual(broken, source);
    const sandbox = { module: { exports: {} }, require: createRequire(workerPath), Buffer };
    vm.runInNewContext(broken, sandbox, { filename: workerPath });
    const ed = rows.find(row => row.name === 'PKCS8-ed25519-der-libera');
    await assert.rejects(async () => verificaChiave(await sandbox.module.exports.normalizza(ed.data), ed.publicKey), /algoritmo/, 'La prova deve scoprire una conversione rimossa');
    console.log(`  OK   SSH formati: ${checks + 5} verifiche, ${rows.length} tunnel reali, binari da percorso e sensibilità Ed25519`);
  } finally {
    await fixture.close();
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; throw err; });
