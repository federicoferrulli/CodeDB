'use strict';

const assert = require('assert');
const os = require('os');
const { creaPianoImport } = require('../db/importPlan');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');

function artifact(docs, identity = { kind: 'primary-key', columns: ['id'] }) {
  return {
    formato: 'codedb-database', versione: 1, dbType: 'mysql', db: 'origine',
    collections: [{
      name: 'clienti', identity, ddl: 'CREATE TABLE clienti (id INT PRIMARY KEY, nome TEXT);',
      indexes: null, postDdl: null, docs,
    }],
  };
}

function strategy({ primary = ['id'] } = {}) {
  const mutations = [];
  return {
    mutations,
    async listDatabases() { return [{ name: 'destinazione' }]; },
    async tableColumnsInfo() {
      return { columns: [{ name: 'id', nullable: false }, { name: 'nome', nullable: true }] };
    },
    async primaryKey() { return primary; },
    async uniqueIndexes() { return []; },
    async createDatabase() { mutations.push('createDatabase'); },
    async collectionImport() { mutations.push('collectionImport'); },
  };
}

module.exports = (async () => {
  const missingRowIdentity = creaPianoImport({
    artifact: artifact([{ nome: 'Ada' }]), expectedDbType: 'mysql', connection: 'locale',
    targetDb: 'destinazione', drop: false,
  });
  const first = strategy();
  const firstAdapter = createImportArtifactAdapter({
    strategy: first, dbType: 'mysql', connName: 'locale', recoveryRoot: os.tmpdir(),
  });
  await assert.rejects(firstAdapter.validatePlan(missingRowIdentity), /riga 1.*identita stabile/i);
  assert.deepStrictEqual(first.mutations, [], 'tutte le righe sono validate prima della prima mutazione');

  const divergentIdentity = creaPianoImport({
    artifact: artifact([{ id: 1, nome: 'Ada' }]), expectedDbType: 'mysql', connection: 'locale',
    targetDb: 'destinazione', drop: false,
  });
  const second = strategy({ primary: ['codice'] });
  const secondAdapter = createImportArtifactAdapter({
    strategy: second, dbType: 'mysql', connName: 'locale', recoveryRoot: os.tmpdir(),
  });
  await assert.rejects(secondAdapter.validatePlan(divergentIdentity), /diverge dal piano/i);
  assert.deepStrictEqual(second.mutations, [], 'la divergenza del vincolo precede staging e righe');

  console.log('  OK   Adapter import valida identita e righe prima delle mutazioni passed');
})().catch((err) => {
  console.error('  FAIL Adapter import:', err.stack || err);
  process.exitCode = 1;
});
