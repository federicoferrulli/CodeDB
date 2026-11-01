'use strict';

const assert = require('node:assert/strict');
const { Client } = require('ssh2');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { identificaChiaveAgente, preparaAgente } = require('../db/SshAgent');
const { apriTunnelNativo, rispostaAskpass } = require('../db/SshNativeTunnel');
const { openSshTunnel, hostKeyFingerprint } = require('../db/SshTunnel');
const { keyPair, certificate, securityKey, privateHandle, multipleKeys, agentFixture, sshServerFixture, publicText } = require('./ssh-agent-fixture');
const { roundTrip } = require('./ssh-fixture');

module.exports = (async () => {
  const askpassEnv = { CODEDB_SSH_KEY_PASSPHRASE: 'passphrase-diversa-dal-pin', CODEDB_SSH_KEY_PIN: '123456' };
  assert.equal(rispostaAskpass('Enter passphrase for key identity', askpassEnv), askpassEnv.CODEDB_SSH_KEY_PASSPHRASE);
  assert.equal(rispostaAskpass('Enter passphrase for key /tmp/pin/identity', askpassEnv), askpassEnv.CODEDB_SSH_KEY_PASSPHRASE);
  assert.equal(rispostaAskpass('Enter PIN for ED25519-SK key identity', askpassEnv), askpassEnv.CODEDB_SSH_KEY_PIN);
  assert.equal(rispostaAskpass(path.join(process.cwd(), 'Enter passphrase: '), askpassEnv), askpassEnv.CODEDB_SSH_KEY_PASSPHRASE);
  assert.equal(rispostaAskpass(path.join(process.cwd(), 'Enter PIN for ED25519-SK key: '), askpassEnv), askpassEnv.CODEDB_SSH_KEY_PIN);
  assert.equal(rispostaAskpass('Are you sure you want to continue connecting?', askpassEnv), null);
  const key = keyPair(), other = keyPair(), ca = keyPair();
  const cert = certificate(key, ca), certInfo = identificaChiaveAgente(publicText(cert));
  assert.equal(certInfo.certificate, true);
  assert.equal(certInfo.type, 'ssh-ed25519-cert-v01@openssh.com');
  assert(certInfo.plainPublicKey.equals(key.blob));
  assert.deepEqual(certInfo.principals, ['fixture']);
  assert.equal(identificaChiaveAgente(key.private), null);
  const rfc = ['---- BEGIN SSH2 PUBLIC KEY ----', 'Comment: prima ' + String.fromCharCode(92),
    'seconda', key.blob.toString('base64'), '---- END SSH2 PUBLIC KEY ----'].join('\n');
  assert(identificaChiaveAgente(rfc).publicKey.equals(key.blob));
  assert.throws(() => identificaChiaveAgente(rfc.replace(key.blob.toString('base64'), key.blob.toString('base64') + '\nSubject: inatteso')), /codifica/i);
  const multiple = multipleKeys([key, other]);
  assert.equal(identificaChiaveAgente(multiple), null);
  const normalized = await require('../db/SshKey').preparaChiaveSsh({ sshAuth: 'upload', sshPrivateKey: multiple });
  assert.equal(normalized.fingerprint, hostKeyFingerprint(key.blob), 'I contenitori OpenSSH ordinari con più chiavi mantengono la prima identità');
  const broken = Buffer.from(cert); broken[broken.length - 1] ^= 0xff;
  assert.throws(() => identificaChiaveAgente(publicText(broken)), /firma.*non.*valida/);
  assert.throws(() => identificaChiaveAgente(publicText(certificate(key, ca, { validBefore: 1 }))), /scaduto/);
  assert.throws(() => identificaChiaveAgente(publicText(certificate(key, ca, { certificateType: 2 }))), /certificato host/);
  assert.throws(() => identificaChiaveAgente(publicText(cert).toString().replace('ssh-ed25519-cert-', 'ssh-rsa-cert-')), /non corrisponde/);
  assert.throws(() => identificaChiaveAgente(key.public + '\n' + other.public), /una sola chiave/);
  console.log('  OK   SSH agente: chiavi pubbliche, certificati firmati, scadenza e manomissioni');

  const agent = await agentFixture([other, key]), server = await sshServerFixture([key]);
  try {
    const prepared = await preparaAgente(key.public, { agentPath: agent.agentPath });
    assert.equal(prepared.type, 'ssh-ed25519');
    const identities = await new Promise((resolve, reject) => prepared.agent.getIdentities((err, keys) => err ? reject(err) : resolve(keys)));
    assert.equal(identities.length, 1);
    assert(identities[0].getPublicSSH().equals(key.blob));
    await assert.rejects(preparaAgente(keyPair().public, { agentPath: agent.agentPath }), /non.*presente/);
    await assert.rejects(preparaAgente(key.public, { env: {}, platform: 'linux' }), /chiave pubblica.*agente SSH/);
    const client = new Client();
    try {
      await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: server.host, port: server.port, username: 'fixture', agent: prepared.agent, hostVerifier: raw => raw.equals(server.hostKey), readyTimeout: 5000 }); });
      assert.equal(server.stats.authentications, 1);
    } finally { client.end(); }
    await assert.rejects(new Promise((resolve, reject) => prepared.agent.sign(other.blob, Buffer.from('test'), {}, err => err ? reject(err) : resolve())), /soltanto.*selezionata/);
    assert(agent.stats.signedBlobs.every(blob => blob.equals(key.blob)));
    console.log('  OK   SSH agente: identità filtrata e autenticazione SSH reale con firma valida');
  } finally { await agent.close(); await server.close(); }

  for (const mode of ['corruptSignature', 'oversized', 'idle']) {
    const fixture = await agentFixture([key], { [mode]: true });
    try {
      if (mode === 'corruptSignature') {
        const prepared = await preparaAgente(key.public, { agentPath: fixture.agentPath });
        await assert.rejects(new Promise((resolve, reject) => prepared.agent.sign(key.blob, Buffer.from('test'), {}, err => err ? reject(err) : resolve())), /firma non valida/);
      } else await assert.rejects(preparaAgente(key.public, { agentPath: fixture.agentPath, timeoutMs: 50 }), /agente SSH/);
    } finally { await fixture.close(); }
  }
  console.log('  OK   SSH agente: firma alterata, risposta eccessiva e timeout');

  for (const [type, bits] of [['rsa'], ['ecdsa', 256], ['ecdsa', 384], ['ecdsa', 521]]) {
    const typedKey = keyPair(type, bits), typedAgent = await agentFixture([typedKey]), typedServer = await sshServerFixture([typedKey]);
    const client = new Client();
    try {
      const prepared = await preparaAgente(typedKey.public, { agentPath: typedAgent.agentPath });
      await new Promise((resolve, reject) => {
        client.once('ready', resolve); client.once('error', reject);
        client.connect({ host: typedServer.host, port: typedServer.port, username: 'fixture', agent: prepared.agent, hostVerifier: raw => raw.equals(typedServer.hostKey), readyTimeout: 5000 });
      });
      assert.equal(typedServer.stats.authentications, 1);
      assert.equal(identificaChiaveAgente(publicText(certificate(key, typedKey))).certificate, true, 'Firma CA con algoritmo differente');
    } finally { client.end(); await typedAgent.close(); await typedServer.close(); }
  }
  console.log('  OK   SSH agente: firme RSA SHA-2 ed ECDSA P-256/P-384/P-521 e relative CA');

  let openssh = true;
  try { execFileSync('ssh', ['-V'], { windowsHide: true, stdio: 'ignore' }); } catch { openssh = false; }
  if (!openssh) { console.log('  SKIP SSH nativo: OpenSSH non installato; test certificato/FIDO su rete non eseguiti'); return; }
  const ecdsa = keyPair('ecdsa'), rsa = keyPair('rsa'), fidoEd = securityKey(keyPair()), fidoEc = securityKey(ecdsa);
  const handle = privateHandle(fidoEd), encryptedHandle = privateHandle(fidoEc, 'passphrase-fixture');
  assert.equal((await preparaAgente(handle)).privateHandle, true);
  await assert.rejects(preparaAgente(encryptedHandle), { code: 'SSH_KEY_PASSPHRASE_REQUIRED' });
  const encryptedPrepared = await preparaAgente(encryptedHandle, { passphrase: 'passphrase-fixture', securityKeyPin: '123456' });
  assert.equal(encryptedPrepared.privateHandle, true);
  assert.equal(encryptedPrepared.encrypted, true);
  assert.equal(encryptedPrepared.securityKeyPin, '123456');
  await assert.rejects(preparaAgente(encryptedHandle, { passphrase: 'errata' }), /passphrase/i);
  console.log('  OK   SSH nativo: riferimenti FIDO OpenSSH in chiaro e cifrati, passphrase errata');
  for (const [kind, nativeKey] of [
    ['certificato Ed25519', { ...key, cert }], ['certificato RSA', { ...rsa, cert: certificate(rsa, ca) }],
    ['certificato ECDSA', { ...ecdsa, cert: certificate(ecdsa, ca) }], ['FIDO Ed25519', fidoEd], ['FIDO ECDSA', fidoEc],
    ['certificato FIDO', { ...fidoEd, cert: certificate(fidoEd, ca) }],
  ]) {
    const nativeAgent = await agentFixture([nativeKey]), nativeServer = await sshServerFixture([nativeKey]);
    try {
      const input = publicText(nativeKey.cert || nativeKey.blob);
      const prepared = await preparaAgente(input, { agentPath: nativeAgent.agentPath });
      assert.equal(prepared.native, true);
      const tunnel = await apriTunnelNativo(prepared, nativeServer);
      try {
        assert.equal(tunnel.alive, true);
        assert.equal(await roundTrip(tunnel), 'codedb-tunnel-fixture');
        assert.equal(nativeServer.stats.authentications, 1);
        if (nativeKey.cert) assert(nativeServer.stats.attempts.every(type => type.includes('-cert-')), 'Il certificato non deve degradare a chiave semplice');
        if (kind === 'certificato Ed25519') {
          nativeServer.disconnect();
          await new Promise((resolve, reject) => {
            const until = Date.now() + 3000;
            const poll = () => !tunnel.alive ? resolve() : Date.now() >= until ? reject(new Error('Il tunnel non rileva la disconnessione')) : setTimeout(poll, 20);
            poll();
          });
        }
      } finally { await tunnel.close(); }
      assert.equal(tunnel.alive, false);
      if (kind === 'certificato Ed25519') assert.equal(typeof tunnel.lastError, 'string');
      else assert.equal(tunnel.lastError, null);
      await assert.rejects(apriTunnelNativo(prepared, { ...nativeServer, hostKey: other.blob }), /NON corrisponde/);
      assert.equal(nativeServer.stats.authentications, 1, 'Host non fidato: nessuna firma/autenticazione aggiuntiva');
      console.log(`  OK   SSH nativo: ${kind}, firma reale via agente, forwarding e rifiuto host non fidato`);
      if (kind === 'certificato Ed25519' || kind === 'FIDO Ed25519') {
        const cfg = { sshAuth: 'upload', sshPrivateKey: input.toString(), sshHost: nativeServer.host,
          sshPort: String(nativeServer.port), sshUser: nativeServer.username, sshHostKey: hostKeyFingerprint(other.blob) };
        const signaturesBefore = nativeAgent.stats.signatures;
        await assert.rejects(openSshTunnel(cfg, nativeServer.target, { agentPath: nativeAgent.agentPath }), /NON corrisponde/);
        assert.equal(nativeAgent.stats.signatures, signaturesBefore, 'Il probe deve fermarsi prima di qualsiasi firma');
        assert.equal(nativeServer.stats.authentications, 1, 'Il probe non deve autenticare con il pin errato');
        cfg.sshHostKey = hostKeyFingerprint(nativeServer.hostKey);
        const integrated = await openSshTunnel(cfg, nativeServer.target, { agentPath: nativeAgent.agentPath });
        try {
          assert.equal(integrated.hostKey, cfg.sshHostKey);
          assert.equal(integrated.hostKeyKnown, true);
          assert.equal(await roundTrip(integrated), 'codedb-tunnel-fixture');
          assert.equal(nativeServer.stats.authentications, 2);
        } finally { await integrated.close(); }
        assert.equal(integrated.alive, false);
        console.log(`  OK   SshTunnel integrato: ${kind}, probe senza firma, pin e forwarding nativo`);
      }
    } finally { await nativeAgent.close(); await nativeServer.close(); }
  }
})();
