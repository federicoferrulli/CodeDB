'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAuditor } = require('../db/AuditLog');

function righe(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

module.exports = (async () => {
  console.log('--- Test audit serializzato ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-audit-queue-'));
  const file = path.join(dir, 'audit.log');
  const auditor = makeAuditor(file, 180, { maxGenerations: 50 });
  const esiti = await Promise.all(Array.from({ length: 30 }, (_, n) => auditor.audit({ event: 'unit', n })));
  assert(esiti.every((esito) => esito.persisted), 'ogni append deve risultare persistito');
  await auditor.flush();

  const files = fs.readdirSync(dir)
    .filter((name) => /^audit\.log(?:\.\d+)?$/.test(name))
    .sort((a, b) => {
      const ga = Number(a.split('.')[2] || 0);
      const gb = Number(b.split('.')[2] || 0);
      return gb - ga;
    });
  const persisted = files.flatMap((name) => righe(path.join(dir, name)));
  assert.deepStrictEqual(persisted.map((entry) => entry.n), Array.from({ length: 30 }, (_, n) => n),
    'ordine e cardinalità devono sopravvivere alle rotazioni concorrenti');
  assert(files.length > 2, 'il test deve attraversare più generazioni ruotate');

  const parentMancante = path.join(dir, 'mancante');
  const failing = makeAuditor(path.join(parentMancante, 'audit.log'), 1024);
  const fallito = await failing.audit({ event: 'non-persistito' });
  assert.strictEqual(fallito.persisted, false);
  assert.strictEqual(failing.statoSalute().ok, false, 'l’errore disco deve essere visibile nello stato di salute');
  assert.strictEqual(failing.readRecent().total, 0, 'la cache non deve presentare la voce fallita come persistita');
  fs.mkdirSync(parentMancante);
  assert.strictEqual((await failing.audit({ event: 'ripresa' })).persisted, true);
  assert.strictEqual(failing.readRecent().total, 1, 'la coda deve tornare riutilizzabile dopo il guasto');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  OK   ordine, generazioni, errore fail-visible e ripresa');
})();
