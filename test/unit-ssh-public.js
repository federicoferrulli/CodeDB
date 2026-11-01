'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const forge = require('node-forge');
const { openSshTunnel } = require('../db/SshTunnel');
const { preparaChiaveSsh } = require('../db/SshKey');
const { keyPair, agentFixture } = require('./ssh-agent-fixture');
const { sshFixture, roundTrip } = require('./ssh-fixture');

module.exports = (async () => {
  const keys = [keyPair('rsa'), keyPair('ecdsa'), keyPair('ed25519')];
  const rows = [];
  for (const key of keys) {
    const publicKey = crypto.createPublicKey(key.parsed.getPrivatePEM());
    for (const format of ['pem', 'der']) rows.push({ name: `${key.parsed.type} SPKI ${format}`, key,
      data: Buffer.from(publicKey.export({ format, type: 'spki' })) });
    rows.push({ name: `${key.parsed.type} RFC4716`, key,
      data: Buffer.from(`---- BEGIN SSH2 PUBLIC KEY ----\nComment: "fixture"\n${key.blob.toString('base64').match(/.{1,64}/g).join('\n')}\n---- END SSH2 PUBLIC KEY ----\n`) });
  }
  const rsa = keys[0], publicKey = crypto.createPublicKey(rsa.parsed.getPrivatePEM());
  for (const format of ['pem', 'der']) rows.push({ name: `RSA PKCS1 ${format}`, key: rsa,
    data: Buffer.from(publicKey.export({ format, type: 'pkcs1' })) });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ format: 'pem', type: 'spki' }));
  cert.serialNumber = '01'; cert.validity.notBefore = new Date('2020-01-01'); cert.validity.notAfter = new Date('2100-01-01');
  cert.setSubject([{ name: 'commonName', value: 'fixture.invalid' }]); cert.setIssuer(cert.subject.attributes);
  cert.sign(forge.pki.privateKeyFromPem(rsa.parsed.getPrivatePEM()), forge.md.sha256.create());
  rows.push({ name: 'X509 PEM', key: rsa, data: Buffer.from(forge.pki.certificateToPem(cert)) });
  rows.push({ name: 'X509 DER', key: rsa, data: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary') });
  for (const passphrase of ['', 'certificato protetto è']) {
    const asn = forge.pkcs12.toPkcs12Asn1(null, [cert], passphrase, { algorithm: 'aes256' });
    rows.push({ name: 'PFX solo certificato', key: rsa, passphrase, data: Buffer.from(forge.asn1.toDer(asn).getBytes(), 'binary') });
  }
  const agent = await agentFixture(keys), server = await sshFixture({ additionalKeys: keys.map(key => key.parsed) });
  try {
    for (const row of rows) {
      const cfg = { ...server.ssh, sshAuth: 'upload', sshPrivateKey: 'base64:' + row.data.toString('base64'), sshPassphrase: row.passphrase };
      const before = agent.stats.requests;
      await assert.rejects(preparaChiaveSsh(cfg, { allowHostAgent: false, agentPath: agent.agentPath }), { code: 'SSH_KEY_AGENT_FORBIDDEN' }, row.name);
      assert.equal(agent.stats.requests, before, 'Un tenant non deve interrogare l’agente del servizio');
      const tunnel = await openSshTunnel(cfg, server.target, { agentPath: agent.agentPath });
      try { assert.equal(await roundTrip(tunnel), 'codedb-tunnel-fixture', row.name); }
      finally { await tunnel.close(); }
      assert(agent.stats.signedBlobs.at(-1).equals(row.key.blob), row.name + ': identità esatta');
    }
    assert.equal(server.stats.authentications, rows.length);
    console.log(`  OK   SSH pubblico: ${rows.length} tunnel con SPKI, PKCS1, RFC4716, X509 e PFX senza chiave privata; isolamento agente`);
  } finally { await server.close(); await agent.close(); }
})();
