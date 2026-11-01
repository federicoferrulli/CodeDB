'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const filename = require.resolve('../db/importPlan');
let engine = require(filename);
if (process.argv.includes('--mutant')) {
  const Module = require('node:module'), source = fs.readFileSync(filename, 'utf8');
  const changed = source.replace('await adapter.finalize(plan, staging, recovery);', '/* commit saltato intenzionalmente */');
  assert.notEqual(changed, source);
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(changed, filename); engine = mod.exports;
}
const { creaPianoImport, eseguiPianoImport } = engine;
const plan = creaPianoImport({ artifact: { formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
  collections: [{ name: 'righe', indexes: [], docs: [{ _id: 1 }] }] }, expectedDbType: 'mongodb', connection: 'prova', targetDb: 'dest', drop: true });
module.exports = (async () => {
  for (const failure of [null, 'verifica', 'conferma', 'annullamento']) {
    const calls = [], controller = new AbortController();
    const adapter = {
      validatePlan: async () => {}, destinationExists: async () => true,
      createRecovery: async () => ({ verified: true }), prepareStaging: async () => ({ db: 'staging' }), apply: async () => {},
      promote: async () => { calls.push('promozione'); },
      verify: async (_plan, where) => {
        if (where === 'destinazione') {
          calls.push('verifica');
          if (failure === 'annullamento') controller.abort();
          if (failure === 'verifica') return { ok: false };
        }
        return { ok: true, schemaObjects: true };
      },
      finalize: async () => { calls.push('conferma'); if (failure === 'conferma') throw new Error('Conferma fallita'); },
      restore: async () => { calls.push('rollback'); },
    };
    const result = await eseguiPianoImport(plan, { adapter, signal: controller.signal });
    assert.equal(result.status, failure ? 'ripristinato_dopo_errore' : 'completato', '[IMPORT-CONFERMA] esito ' + failure);
    assert.deepEqual(calls, failure === null ? ['promozione', 'verifica', 'conferma']
      : failure === 'conferma' ? ['promozione', 'verifica', 'conferma', 'rollback'] : ['promozione', 'verifica', 'rollback'],
    '[IMPORT-CONFERMA] solo una verifica positiva consente il commit: ' + failure);
  }
  console.log('OK conferma import: dopo verifica, rollback su errore e annullamento prima del commit');
})();
