'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBackup } = require('../backup/lib/engine');
const controlloModule = require('../backup/lib/controllo');
const originaleControllo = controlloModule.creaControllo;
if (process.argv.includes('--mutant')) controlloModule.creaControllo = options => originaleControllo({ ...options, signal: undefined });

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-backup-reattivo-'));
  const controller = new AbortController();
  let lette = 0, chiuso = false;
  const progressi = [];
  const client = { db: () => ({
    command: async () => ({ isWritablePrimary: true }),
    listCollections: () => ({ toArray: async () => [{ name: 'righe', options: {} }] }),
    collection: () => ({
      find: () => ({ batchSize() { return this; }, async close() { chiuso = true; },
        async *[Symbol.asyncIterator]() { for (let i = 0; i < 10000; i++) { lette++; yield { _id: i, nome: 'Prova' }; } } }),
      countDocuments: async () => 10000, indexes: async () => [],
    }),
  }) };
  try {
    const strategy = { client, listCollections: async (_db, options) => {
      assert.equal(options.includeCounts, false, 'Preparare il backup non deve contare prima tutte le righe');
      return [{ name: 'righe' }];
    } };
    await assert.rejects(runBackup({ session: { dbType: 'mongodb', strategy },
      connName: 'Prova', db: 'fixture', type: 'full', destRoot: root, log: { info() {} }, signal: controller.signal,
      onProgress(event) { progressi.push(event); if (event.count >= 1000) controller.abort(new Error('Backup annullato.')); },
    }), /Backup annullato/, 'L’annullamento deve fermare il motore prima della fine del backup');
    assert(progressi.some(e => e.collection === 'righe' && e.count >= 1000), 'Avanzamento durante la lettura, non solo al termine');
    assert(lette < 10000, 'Le letture cessano dopo l’annullamento');
    assert(chiuso, 'Il cursore viene chiuso');
    for (const group of fs.readdirSync(root)) assert.deepEqual(fs.readdirSync(path.join(root, group)), [], 'Nessun backup parziale o catalogo pubblicato');
    console.log('OK backup: avanzamento, annullamento, chiusura cursore e rimozione del parziale');

    for (const mysql of [true, false]) {
      const abort = new AbortController(), chiusure = [], rilasci = [];
      const originale = { query: () => new Promise(() => {}),
        destroy() { chiusure.push('mysql'); }, end() { chiusure.push('pg'); return Promise.resolve(); },
        release(guasta) { rilasci.push(guasta); } };
      const controllo = controlloModule.creaControllo({ signal: abort.signal });
      const collegamento = await controllo.acquisisciSql(Promise.resolve(originale), mysql);
      const attesa = collegamento.conn.query('SELECT lunga');
      abort.abort(new Error('Backup annullato.'));
      let timer;
      try { await assert.rejects(Promise.race([attesa, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Query ancora bloccata')), 1000);
      })]), /Backup annullato/); } finally { clearTimeout(timer); }
      collegamento.libera();
      assert.deepEqual(chiusure, [mysql ? 'mysql' : 'pg']);
      assert.deepEqual(rilasci, mysql ? [] : [true], 'Una connessione interrotta non torna utilizzabile nel pool');

      const coda = new AbortController(); let consegna, rilasciTardivi = 0;
      const attesaPool = controlloModule.creaControllo({ signal: coda.signal }).acquisisciSql(new Promise(resolve => { consegna = resolve; }), mysql);
      coda.abort(new Error('Backup annullato.'));
      await assert.rejects(attesaPool, /Backup annullato/);
      consegna({ release() { rilasciTardivi++; } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(rilasciTardivi, 1, 'Il pool recupera anche una connessione consegnata dopo l’annullamento');
    }
    console.log('OK backup SQL: annullamento di query ferme e pool saturo, rilascio delle risorse');

    const handlers = new Map(), altroSocket = new Map(), eventi = [];
    let leases = 0, risposta;
    const deps = { lock: { normTabId: id => id }, identita: { assertWholeConnection() {} },
      operazioni: { resolveBackupPath: () => root }, audit: { auditWrite() {} }, errori: { errMsg: e => e.message }, config: { env: {} } };
    const registra = require('../server/eventi-backup').createModule(deps);
    const lifecycle = map => ({ safeOn: (n, fn) => map.set(n, fn),
      acquisisciLeaseOperazione() { leases++; }, rilasciaLeaseOperazione() { leases--; } });
    registra({ sessions: new Map(), socket: { emit() {} } }, lifecycle(altroSocket));
    registra({ sessions: new Map([['a', { connName: 'Prova', dbType: 'mongodb', strategy }]]), socket: { emit(name, event) {
      eventi.push(event);
      if (event.count !== 1000) return;
      altroSocket.get('backup:cancel')({ tabId: 'a', operationId: 'prova' }, r => assert.equal(r.cancelled, false));
      handlers.get('backup:cancel')({ tabId: 'b', operationId: 'prova' }, r => assert.equal(r.cancelled, false));
      assert.equal(leases, 1, 'La connessione resta disponibile al backup mentre il pannello è chiuso');
      handlers.get('backup:cancel')({ tabId: 'a', operationId: 'prova' }, r => assert.equal(r.cancelled, true));
    } } }, lifecycle(handlers));
    await handlers.get('backup:run')({ tabId: 'a', operationId: 'prova', db: 'fixture' }, r => { risposta = r; });
    assert.equal(risposta.cancelled, true);
    assert.equal(leases, 0);
    assert(eventi.some(e => e.tipo === 'backup' && e.operationId === 'prova' && e.tabId === 'a' && e.count === 1000));
    handlers.get('backup:cancel')({ tabId: 'a', operationId: 'prova' }, r => assert.equal(r.cancelled, false, 'Il registro viene ripulito'));
    console.log('OK protocollo backup: avanzamento e annullamento isolati per socket/tab, lease e registro ripuliti');
  } finally { controlloModule.creaControllo = originaleControllo; fs.rmSync(root, { recursive: true, force: true }); }
})();
