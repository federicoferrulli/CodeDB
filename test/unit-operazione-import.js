'use strict';

const assert = require('assert');
const { createImportOperationRegistry } = require('../db/importOperations');

module.exports = (async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const emitted = [];
  const registry = createImportOperationRegistry({
    execute: async (_plan, { onProgress }) => {
      onProgress({ phase: 'applicazione', status: 'in_corso' });
      await gate;
      return { status: 'completato', recovery: { id: 'rec-1' } };
    },
    id: () => 'op-1',
  });
  const accepted = registry.start({
    plan: { fingerprint: 'abc', connection: 'locale', targetDb: 'dest' }, adapter: {},
    ownerId: 'owner-1', tabId: 'tab-vecchio', onProgress: (state) => emitted.push(state),
  });
  assert.strictEqual(accepted.operationId, 'op-1');
  assert.strictEqual(accepted.status, 'in_corso', 'l’ack precede la fine');
  assert.strictEqual(registry.get('op-1', 'owner-1').status, 'in_corso');
  assert.strictEqual(registry.get('op-1', 'owner-1').tabId, 'tab-vecchio');
  assert.throws(() => registry.get('op-1', 'altro-owner'), /non trovata/i);

  release();
  await registry.wait('op-1');
  const completed = registry.get('op-1', 'owner-1');
  assert.strictEqual(completed.status, 'completato');
  assert.strictEqual(completed.recovery.id, 'rec-1');
  assert(emitted.some((state) => state.phase === 'applicazione'));
  let cleaned = false;
  const cleanedState = await registry.cleanup('op-1', 'owner-1', {
    async cleanup(result) { cleaned = result.recovery.id === 'rec-1'; },
  });
  assert.strictEqual(cleaned, true);
  assert(cleanedState.cleanupAt, 'la rimozione esplicita resta visibile nello stato');

  const cancelling = createImportOperationRegistry({
    id: () => 'op-2',
    execute: async (_plan, { signal }) => {
      if (signal.aborted) return { status: 'ripristinato_dopo_errore', error: 'annullato' };
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ status: 'ripristinato_dopo_errore', error: 'annullato' }));
      });
    },
  });
  cancelling.start({ plan: { fingerprint: 'def' }, adapter: {}, ownerId: 'owner-1', tabId: 'tab-1' });
  assert.strictEqual(cancelling.cancel('op-2', 'owner-1'), true);
  await cancelling.wait('op-2');
  assert.strictEqual(cancelling.get('op-2', 'owner-1').status, 'ripristinato_dopo_errore');

  const denied = Object.assign(new Error('drop negato'), {
    code: 13, codeName: 'Unauthorized', target: 'dest.clienti',
  });
  const failing = createImportOperationRegistry({
    id: () => 'op-3',
    execute: async () => { throw denied; },
  });
  failing.start({ plan: { fingerprint: 'ghi' }, adapter: {}, ownerId: 'owner-1', tabId: 'tab-1' });
  await failing.wait('op-3');
  assert.deepStrictEqual(failing.get('op-3', 'owner-1').originalError, {
    code: 13, codeName: 'Unauthorized', target: 'dest.clienti',
  }, 'codice e bersaglio originali sopravvivono fino all audit');

  console.log('  OK   Operazione lunga import recuperabile fuori dal tab passed');
})().catch((err) => {
  console.error('  FAIL Operazione lunga import:', err.stack || err);
  process.exitCode = 1;
});
