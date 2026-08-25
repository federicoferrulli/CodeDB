'use strict';

const assert = require('assert');
const { createE2eTargetRegistry } = require('./e2e-harness');

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
  if (previous == null) delete process.env.CODEDB_E2E_DESTRUCTIVE;
  else process.env.CODEDB_E2E_DESTRUCTIVE = previous;

  console.log('  OK   Target E2E casuali, flag e proprietà distruttiva passed');
})().catch((err) => {
  console.error('  FAIL Target E2E:', err.stack || err);
  process.exitCode = 1;
});
