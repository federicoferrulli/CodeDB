'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { openSshTunnel } = require('../db/SshTunnel');
const { sshFixture, roundTrip } = require('./ssh-fixture');

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const stop = server => new Promise(resolve => server.close(resolve));

(async () => {
  const fixture = await sshFixture();
  const blocker = net.createServer();
  let tunnel, client, fixtureClosed = false;
  try {
    const port = await listen(blocker);
    await stop(blocker);
    const ssh = { ...fixture.ssh, sshPrivateKey: fixture.key.private, sshLocalPort: String(port) };
    tunnel = await openSshTunnel(ssh, fixture.target);
    assert.equal(tunnel.port, port, 'La porta scelta deve essere quella realmente esposta');
    assert.equal(tunnel.host, '127.0.0.1', 'Il forwarding resta locale');
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, () => roundTrip({ host: '127.0.0.1', port }))),
      Array(3).fill('codedb-tunnel-fixture'), 'Altri client riusano la stessa sessione SSH');
    assert.equal(fixture.stats.authentications, 1);
    client = net.connect({ host: '127.0.0.1', port });
    client.on('error', () => {});
    await once(client, 'connect', { signal: AbortSignal.timeout(3000) });
    const closed = once(client, 'close', { signal: AbortSignal.timeout(3000) });
    await tunnel.close();
    await closed;
    await tunnel.close();
    assert.equal(tunnel.alive, false, 'Chiudere termina anche i client esterni');
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', resolve);
    });
    await assert.rejects(openSshTunnel(ssh, fixture.target), /porta locale.*già in uso/i);
    await stop(blocker);
    tunnel = await openSshTunnel(ssh, fixture.target);
    assert.equal(await roundTrip(tunnel), 'codedb-tunnel-fixture', 'Dopo la chiusura la porta è riutilizzabile');
    await tunnel.close();
    for (const value of ['0', '-1', '65536', '2.5', '12abc', '1e3', true, []]) {
      const before = fixture.stats.authenticationRequests;
      await assert.rejects(openSshTunnel({ ...ssh, sshLocalPort: value }, fixture.target), /porta locale.*1.*65535/i);
      assert.equal(fixture.stats.authenticationRequests, before, 'Una porta invalida viene rifiutata prima di collegarsi');
    }
    for (const value of ['', undefined]) {
      tunnel = await openSshTunnel({ ...ssh, sshLocalPort: value }, fixture.target);
      assert(tunnel.port > 0, 'Senza porta configurata resta il tunnel interno automatico');
      assert.equal(await roundTrip(tunnel), 'codedb-tunnel-fixture');
      await tunnel.close();
    }
    tunnel = await openSshTunnel(ssh, fixture.target);
    client = net.connect({ host: '127.0.0.1', port });
    client.on('error', () => {});
    await once(client, 'connect', { signal: AbortSignal.timeout(3000) });
    const dropped = once(client, 'close', { signal: AbortSignal.timeout(3000) });
    await fixture.close();
    fixtureClosed = true;
    await dropped;
    assert.equal(tunnel.alive, false, 'Una caduta SSH termina il forwarding');
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', resolve);
    });
    await stop(blocker);
    console.log('OK: porta scelta, client esterni simultanei, chiusura e caduta SSH, riapertura, conflitti, validazione e campo vuoto.');
  } finally {
    client?.destroy();
    await tunnel?.close();
    if (blocker.listening) await stop(blocker);
    if (!fixtureClosed) await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
