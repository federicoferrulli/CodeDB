'use strict';

const assert = require('assert');
const { createE2eTargetRegistry } = require('./e2e-harness');

module.exports = (async () => {
  const disabled = createE2eTargetRegistry({ prefix: 'prova' });
  const disabledTarget = disabled.target('db');
  await assert.rejects(disabled.drop(disabledTarget, async () => {}), /flag esplicito/i);

  const fixture = createE2eTargetRegistry({ destructive: true, prefix: 'prova' });
  const current = fixture.target('db');
  const historical = current.replace(fixture.marker, 'abcdef123456');
  assert.throws(() => fixture.assertOwned(historical), /non posseduto/i);
  assert.strictEqual(fixture.assertOwned(current), true);
  const removed = [];
  await fixture.cleanup(async (name) => removed.push(name));
  assert.deepStrictEqual(removed, [current]);
  assert.throws(() => fixture.assertOwned(current), /non posseduto/i, 'il cleanup svuota il registro della fixture');

  console.log('  OK   Target E2E casuali, flag e proprietà distruttiva passed');
})().catch((err) => {
  console.error('  FAIL Target E2E:', err.stack || err);
  process.exitCode = 1;
});

