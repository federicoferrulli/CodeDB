'use strict';

const assert = require('assert');
const { creaPianoImport, eseguiPianoImport } = require('../db/importPlan');

const artifact = {
  formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
  collections: [{ name: 'clienti', indexes: [], docs: [{ _id: 1, nome: 'Ada' }] }],
};

function adapterRegistrante({ failAt = null, recoveryFails = false } = {}) {
  const calls = [];
  const call = async (name, result) => {
    calls.push(name);
    if (failAt === name) throw new Error(`guasto ${name}`);
    return typeof result === 'function' ? result() : result;
  };
  return {
    calls,
    validatePlan: () => call('validatePlan'),
    destinationExists: () => call('destinationExists', true),
    createRecovery: () => call('createRecovery', { id: 'rec-1', verified: true }),
    prepareStaging: () => call('prepareStaging', { db: 'stage-1' }),
    apply: () => call('apply'),
    verify: (_plan, where) => call(`verify:${where}`, { ok: true, collections: 1, rows: 1, schemaObjects: true }),
    promote: () => call('promote'),
    restore: async () => {
      calls.push('restore');
      if (recoveryFails) throw new Error('recupero fallito');
    },
  };
}

module.exports = (async () => {
  const plan = creaPianoImport({
    artifact, expectedDbType: 'mongodb', connection: 'locale', targetDb: 'destinazione', drop: true,
  });
  assert(Object.isFrozen(plan) && Object.isFrozen(plan.collections), 'il piano e le sue collezioni sono immutabili');
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.strictEqual(plan.promotion.kind, 'staging-con-recupero');
  assert.strictEqual(plan.collections[0].identity.columns[0], '_id');
  const fromJson = creaPianoImport({
    artifact: JSON.stringify(artifact), expectedDbType: 'mongodb', connection: 'locale',
    targetDb: 'destinazione', drop: true,
  });
  assert.strictEqual(
    fromJson.fingerprint, plan.fingerprint,
    'UI (oggetto), CLI e MCP (JSON) producono lo stesso piano e la stessa impronta',
  );

  const okAdapter = adapterRegistrante();
  const ok = await eseguiPianoImport(plan, { adapter: okAdapter });
  assert.strictEqual(ok.status, 'completato');
  assert.deepStrictEqual(okAdapter.calls.slice(0, 3), ['validatePlan', 'destinationExists', 'createRecovery']);
  assert(okAdapter.calls.indexOf('validatePlan') < okAdapter.calls.indexOf('createRecovery'), 'nessuna mutazione precede la validazione');
  assert.strictEqual(ok.recovery.id, 'rec-1', 'la copia di recupero resta nell’esito');

  const broken = adapterRegistrante({ failAt: 'apply' });
  const recovered = await eseguiPianoImport(plan, { adapter: broken });
  assert.strictEqual(recovered.status, 'ripristinato_dopo_errore');
  assert(broken.calls.includes('restore'));

  for (const failAt of ['prepareStaging', 'verify:staging', 'verify:destinazione']) {
    const phaseAdapter = adapterRegistrante({ failAt });
    const phaseResult = await eseguiPianoImport(plan, { adapter: phaseAdapter });
    assert.strictEqual(
      phaseResult.status, 'ripristinato_dopo_errore',
      `un errore in ${failAt} non deve diventare completato`,
    );
    assert(phaseAdapter.calls.includes('restore'), `un errore in ${failAt} attiva il recupero`);
  }

  for (const failAt of ['validatePlan', 'destinationExists', 'createRecovery']) {
    const preMutation = adapterRegistrante({ failAt });
    await assert.rejects(eseguiPianoImport(plan, { adapter: preMutation }), new RegExp(`guasto ${failAt}`));
    assert(!preMutation.calls.includes('prepareStaging'), `${failAt} ferma il piano prima dello staging`);
  }

  const invalidVerification = adapterRegistrante();
  invalidVerification.verify = async (_plan, where) => {
    invalidVerification.calls.push(`verify:${where}`);
    return { ok: false, collections: 0, rows: 0, schemaObjects: false };
  };
  const rejectedVerification = await eseguiPianoImport(plan, { adapter: invalidVerification });
  assert.strictEqual(rejectedVerification.status, 'ripristinato_dopo_errore');
  assert(!invalidVerification.calls.includes('promote'), 'oggetti o conteggi divergenti impediscono la promozione');

  const unrecoverable = adapterRegistrante({ failAt: 'promote', recoveryFails: true });
  const intervention = await eseguiPianoImport(plan, { adapter: unrecoverable });
  assert.strictEqual(intervention.status, 'intervento_richiesto');
  assert.match(intervention.error, /guasto promote/);
  assert.match(intervention.recoveryError, /recupero fallito/);

  const tampered = { ...plan, targetDb: 'altro' };
  await assert.rejects(eseguiPianoImport(tampered, { adapter: adapterRegistrante() }), /impronta/i);

  console.log('  OK   Motore piano, staging e recupero passed');
})().catch((err) => {
  console.error('  FAIL Motore piano import:', err.stack || err);
  process.exitCode = 1;
});
