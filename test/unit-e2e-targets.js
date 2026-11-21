'use strict';

const assert = require('assert');
const { createE2eTargetRegistry } = require('./e2e-harness');
const { createDatabaseFixture } = require('./database-fixture');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const MySqlStrategy = require('../db/MySqlStrategy');

async function verificaDatabaseFixture() {
  const esistenti = new Set();
  const eliminati = [];
  const fixture = createDatabaseFixture('prova', async (evento, { db, newName }) => {
    if (evento === 'db:list') return { ok: true, databases: [...esistenti].map(name => ({ name })) };
    if (evento === 'db:drop') {
      eliminati.push(db);
      esistenti.delete(db);
    } else if (evento === 'db:rename' && newName === copiaIncerta) {
      esistenti.add(newName);
      throw new Error('Conferma persa');
    } else {
      esistenti.add(newName || db);
    }
    return { ok: true };
  });
  const preesistente = fixture.target('preesistente');
  const origine = fixture.target('origine');
  const copia = fixture.target('copia');
  const copiaIncerta = fixture.target('incerta');
  esistenti.add(preesistente);
  await assert.rejects(fixture.create(preesistente), /già esistente/);
  await assert.rejects(fixture.drop(preesistente), /non creato dalla prova/);
  await fixture.create(origine);
  await assert.rejects(fixture.copy(origine, preesistente), /già esistente/);
  await assert.rejects(fixture.copy(origine, copiaIncerta), /Conferma persa/);
  await fixture.copy(origine, copia);
  await fixture.cleanup();
  await fixture.cleanup();
  assert.deepStrictEqual(eliminati, [copia, origine]);
  assert.deepStrictEqual([...esistenti], [preesistente, copiaIncerta]);
}

async function verificaDropDiSistema() {
  // Questi nomi reali arrivano solo alle strategie con driver finti.
  const mongo = new MongoDbStrategy();
  mongo.client = { db: () => assert.fail('Il DROP MongoDB ha raggiunto il driver') };
  await assert.rejects(mongo.dropDatabase('admin'), /database di sistema/);
  const mysql = new MySqlStrategy();
  mysql.pool = { query: () => assert.fail('Il DROP MySQL ha raggiunto il driver') };
  await assert.rejects(mysql.dropDatabase('mysql'), /database di sistema/);
}

module.exports = (async () => {
  const previous = process.env.CODEDB_E2E_DESTRUCTIVE;
  delete process.env.CODEDB_E2E_DESTRUCTIVE;
  const disabled = createE2eTargetRegistry({ prefix: 'prova' });
  const disabledTarget = disabled.target('db');
  await assert.rejects(disabled.drop(disabledTarget, async () => {}), /CODEDB_E2E_DESTRUCTIVE/i);

  const blockedByEnvironment = createE2eTargetRegistry({ destructive: true, prefix: 'prova' });
  const blockedTarget = blockedByEnvironment.target('db');
  assert.throws(() => blockedByEnvironment.assertOwned(blockedTarget), /CODEDB_E2E_DESTRUCTIVE/i);
  process.env.CODEDB_E2E_DESTRUCTIVE = '1';

  const fixture = createE2eTargetRegistry({ destructive: true, prefix: 'prova' });
  const current = fixture.target('db');
  const historical = current.replace(fixture.marker, 'abcdef123456');
  assert.throws(() => fixture.assertOwned(historical), /non posseduto/i);
  assert.strictEqual(fixture.assertOwned(current), true);
  const removed = [];
  await fixture.cleanup(async (name) => removed.push(name));
  assert.deepStrictEqual(removed, [current]);
  assert.throws(() => fixture.assertOwned(current), /non posseduto/i, 'il cleanup svuota il registro della fixture');
  await verificaDatabaseFixture();
  await verificaDropDiSistema();
  if (previous == null) delete process.env.CODEDB_E2E_DESTRUCTIVE;
  else process.env.CODEDB_E2E_DESTRUCTIVE = previous;

  console.log('  OK   Target E2E casuali, flag e proprietà distruttiva passed');
})().catch((err) => {
  console.error('  FAIL Target E2E:', err.stack || err);
  process.exitCode = 1;
});
