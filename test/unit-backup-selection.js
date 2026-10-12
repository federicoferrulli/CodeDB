'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = (async () => {
  const util = require('../backup/lib/util');
  const engine = require('../backup/lib/engine');
  const originalParse = util.parseCollectionSelection, originalRun = engine.runBackup;
  const modulePath = require.resolve('../server/eventi-backup');
  const cached = require.cache[modulePath];
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
      lock: { normTabId: id => id }, identita: { assertWholeConnection() {} },
      operazioni: { resolveBackupPath: () => dir }, audit: { auditWrite() {} },
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
  } finally {
    util.parseCollectionSelection = originalParse; engine.runBackup = originalRun;
    if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
