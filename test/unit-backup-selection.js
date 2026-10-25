'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = (async () => {
  const util = require('../backup/lib/util');
  const engine = require('../backup/lib/engine');
  const restore = require('../db/backupRestoreAdapter');
  const originalRestore = restore.runRestoreViaPlan;
  const originalParse = util.parseCollectionSelection, originalRun = engine.runBackup;
  const modulePath = require.resolve('../server/eventi-backup');
  const cached = require.cache[modulePath];
  const registryPath = require.resolve('../db/restoreOperations');
  const cachedRegistry = require.cache[registryPath];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-selezione-backup-'));
  try {
    if (process.argv.includes('--mutant')) util.parseCollectionSelection = value => originalParse(Array.isArray(value) ? value.join(',') : value);
    const parse = util.parseCollectionSelection;
    const names = ['vendite, archivio', ' nome con spazi ', 'Ordini', '日本語'];
    assert.deepEqual(parse(names), names, 'I nomi selezionati arrivano letterali, comprese virgole e spazi');
    assert.deepEqual(parse(['utenti', 'utenti']), ['utenti']);
    assert.deepEqual(parse(' utenti, ordini, '), ['utenti', 'ordini'], 'Compatibilità con i client precedenti');
    for (const value of [null, undefined, '', [], ' , ']) assert.equal(parse(value), null, 'Senza selezione si include tutto');
    for (const value of [5, {}, [''], ['valido', null], ['a\0b'], [5]]) assert.throws(() => parse(value), /Selezione.*non valida/);
    let sent;
    engine.runBackup = async options => { sent = options; return { id: 'test', totalDocs: 0, totalBytes: 0 }; };
    delete require.cache[modulePath];
    const handlers = new Map();
    require(modulePath).createModule({
      lock: { normTabId: id => id }, identita: { assertWholeConnection() {}, assertManage() {} },
      operazioni: { resolveBackupPath: () => dir, backupRootOf: () => dir }, audit: { auditWrite() {} },
      errori: { errMsg: e => e.message }, config: { env: {} },
    })({ sessions: new Map([['a', { connName: 'Prova', dbType: 'postgresql', strategy: {} }]]) },
      { safeOn: (name, handler) => handlers.set(name, handler) });
    for (const collections of [names, [], 'utenti, ordini']) {
      await handlers.get('backup:run')({ tabId: 'a', db: 'public', collections }, result => assert.equal(result.ok, true));
      assert.deepEqual(sent.onlyCollections, parse(collections), 'Il gestore passa la selezione al motore di backup');
    }
    sent = null;
    await assert.rejects(handlers.get('backup:run')({ tabId: 'a', db: 'public', collections: [false] }, () => {}), /Selezione.*non valida/);
    assert.equal(sent, null, 'Un payload invalido non avvia il backup');
    console.log('OK selezione backup: array, nomi letterali, compatibilità, validazione e passaggio al motore');

    const summary = { status: 'completato', targetDb: 'destinazione', totalDocs: 3, layers: 2,
      equivalenza: { completa: false, motivo: 'Fotografia storica incompleta.' },
      equivalenzaDati: { completa: true }, coerenzaSchema: { completa: false, layers: ['storico'] } };
    restore.runRestoreViaPlan = async () => summary;
    // Carichiamo il vero registratore con il solo motore sostituito: la nota
    // deve attraversare il contratto pubblico e arrivare al client intatta.
    delete require.cache[modulePath];
    if (process.argv.includes('--mutant-summary')) {
      const Module = require('node:module');
      const source = fs.readFileSync(registryPath, 'utf8');
      const altered = source.replace('equivalenza: summary.equivalenza,', '');
      assert.notEqual(altered, source, 'Il mutante deve togliere il campo dalla risposta');
      const mod = new Module(registryPath, module);
      mod.filename = registryPath; mod.paths = Module._nodeModulePaths(path.dirname(registryPath));
      mod._compile(altered, registryPath); require.cache[registryPath] = mod;
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    require(modulePath).createModule({
      lock: { normTabId: id => id }, identita: { assertWholeConnection() {}, assertManage() {} },
      operazioni: { resolveBackupPath: () => dir, backupRootOf: () => dir }, audit: { auditWrite() {} },
      errori: { errMsg: e => e.message }, config: { env: {} },
    })({ principal: { ownerId: 'test', id: 'test' }, sessions: new Map([['a', { connName: 'Prova', dbType: 'postgresql', strategy: {} }]]), socket: { emit() {} } },
      { safeOn: (name, handler) => handlers.set(name, handler) });
    let restored;
    await handlers.get('backup:restore')({ tabId: 'a', from: dir }, result => { restored = result; });
    assert.equal(restored.ok, true);
    for (const field of ['equivalenza', 'equivalenzaDati', 'coerenzaSchema']) {
      assert.deepEqual(restored.summary[field], summary[field], `[BACKUP-RISPOSTA-SCHEMA] ${field} resta disponibile al client`);
    }
    console.log('OK ripristino: il protocollo conserva la verifica dei dati e i limiti dello schema');
  } finally {
    util.parseCollectionSelection = originalParse; engine.runBackup = originalRun; restore.runRestoreViaPlan = originalRestore;
    if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
    if (cachedRegistry) require.cache[registryPath] = cachedRegistry; else delete require.cache[registryPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
