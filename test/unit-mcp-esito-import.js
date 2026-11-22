'use strict';

const assert = require('node:assert/strict');
const { registraStrumentiArtefatti } = require('../mcp/strumenti-artefatti');

module.exports = (async () => {
  let importa, status;
  registraStrumentiArtefatti({
    tool(nome, _opzioni, fn) { if (nome === 'import_database_artifact') importa = fn; },
    requireDbSession: () => ({ name: 'locale', dbType: 'mongodb', strategy: {} }),
    session: { id: 'prova' }, deps: {}, env: {}, audit() {},
    sessionPrincipal: () => ({ root: true }), refreshWritesAllowed: () => true,
    confirmFlow: { consume() {} }, backupRootOf: () => require('node:os').tmpdir(),
    eseguiImport: async () => ({ status }),
  });
  const artifact_json = JSON.stringify({ formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
    collections: [{ name: 'righe', docs: [{ _id: 1 }] }] });
  for (status of ['ripristinato_dopo_errore', 'intervento_richiesto', 'completato']) {
    const risposta = await importa({ connection_id: '1', target_db: 'dest', artifact_json, confirm_token: 'confermato' });
    const esito = JSON.parse(risposta.content[0].text);
    assert.equal(esito.status, status);
    assert.equal(esito.executed, status === 'completato', status);
  }
  console.log('OK esito MCP per i tre stati terminali di import');
})();
