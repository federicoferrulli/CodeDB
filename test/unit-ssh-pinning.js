'use strict';

const assert = require('assert');
const { creaVerificaHostKey, hostKeyFingerprint } = require('../db/SshTunnel');

console.log('--- Test protocollo unico pinning SSH ---');
const previous = process.env.CODEDB_SSH_STRICT_HOST_KEY;
delete process.env.CODEDB_SSH_STRICT_HOST_KEY;
try {
  const keyA = Buffer.from('host-key-a');
  const keyB = Buffer.from('host-key-b');
  const fpA = hostKeyFingerprint(keyA);
  let saved = null;
  const nuova = creaVerificaHostKey({}, { persistNewHostKey: (fingerprint) => { saved = fingerprint; } });
  assert.strictEqual(nuova.verify(keyA, 'bastion'), true);
  assert.strictEqual(saved, fpA);
  assert.strictEqual(nuova.known, true);

  const nota = creaVerificaHostKey({ sshHostKey: fpA });
  assert.strictEqual(nota.verify(keyA, 'bastion'), true);
  const cambiata = creaVerificaHostKey({ sshHostKey: fpA });
  assert.strictEqual(cambiata.verify(keyB, 'bastion'), false);
  assert.match(cambiata.error.message, /prima dell.autenticazione|man-in-the-middle/i);

  const nonScrivibile = creaVerificaHostKey({}, { persistNewHostKey: () => { throw new Error('sola lettura'); } });
  assert.strictEqual(nonScrivibile.verify(keyA, 'bastion'), false);
  assert.match(nonScrivibile.error.message, /Impossibile persistere/);
  const nonApprovata = creaVerificaHostKey({});
  assert.strictEqual(nonApprovata.verify(keyA, 'bastion'), false,
    'una connessione non salvata senza pin esplicito non deve fare TOFU volatile');
  console.log('  OK   chiave nuova, nota, cambiata e archivio non scrivibile');
} finally {
  if (previous == null) delete process.env.CODEDB_SSH_STRICT_HOST_KEY;
  else process.env.CODEDB_SSH_STRICT_HOST_KEY = previous;
}
