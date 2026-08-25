'use strict';

const assert = require('assert');
const { eliminaSePresente } = require('../backup/lib/restore');

module.exports = (async () => {
  let createCalled = false;
  const negato = Object.assign(new Error('permission denied'), { code: '42501' });
  await assert.rejects(
    (async () => {
      await eliminaSePresente(async () => { throw negato; }, { dbType: 'postgresql', target: 'public.clienti' });
      createCalled = true;
    })(),
    (err) => err === negato,
  );
  assert.strictEqual(createCalled, false, 'un drop negato impedisce create e insert successivi');

  await eliminaSePresente(
    async () => { throw Object.assign(new Error('namespace missing'), { code: 26, codeName: 'NamespaceNotFound' }); },
    { dbType: 'mongodb', target: 'test.clienti' },
  );
  await eliminaSePresente(
    async () => { throw Object.assign(new Error('undefined table'), { code: '42P01' }); },
    { dbType: 'postgresql', target: 'public.clienti' },
  );

  for (const err of [
    Object.assign(new Error('rete'), { code: 'ECONNRESET' }),
    Object.assign(new Error('timeout'), { code: 50, codeName: 'MaxTimeMSExpired' }),
    Object.assign(new Error('mongo unauthorized'), { code: 13, codeName: 'Unauthorized' }),
  ]) {
    await assert.rejects(
      eliminaSePresente(async () => { throw err; }, { dbType: 'mongodb', target: 'test.clienti' }),
      (actual) => actual === err,
    );
  }

  console.log('  OK   Drop preparatorio fail-closed passed');
})().catch((err) => {
  console.error('  FAIL Drop fail-closed:', err.stack || err);
  process.exitCode = 1;
});

