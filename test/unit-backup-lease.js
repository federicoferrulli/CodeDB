'use strict';

// Registratore e lifecycle reali: il solo restore è sospeso su una barriera.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { giuntura } = require('./server-fixture');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const adapter = require('../db/backupRestoreAdapter');
const modulePath = require.resolve('../server/eventi-backup');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function scenario(chiusura, errore, paralleli) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-restore-lease-'));
  const original = adapter.runRestoreViaPlan, cached = require.cache[modulePath];
  const barriers = Array.from({ length: paralleli }, () => ({ start: deferred(), release: deferred() }));
  let active = 0, teardown = 0, lifecycle, module, pending = [];
  fs.writeFileSync(path.join(temp, 'manifest.json'), '{}');
  try {
    adapter.runRestoreViaPlan = async () => {
      const barrier = barriers[active++]; barrier.start.resolve(); await barrier.release.promise;
      if (teardown) throw new Error('Driver distrutto durante ripristino');
      if (errore) throw new Error('Errore di ripristino controllato');
      return { status: 'completato', targetDb: 'destinazione', totalDocs: 1, layers: 1 };
    };
    delete require.cache[modulePath];
    const register = require(modulePath).createModule({
      lock: { normTabId: value => value }, identita: { assertManage() {}, assertWholeConnection() {} },
      operazioni: { resolveBackupPath: () => temp, backupRootOf: () => temp }, config: { env: {} },
      audit: { auditWrite() {} }, errori: { errMsg: error => error.message },
    });
    const session = sessioneFinta({ tabId: 'tab', connName: 'prova' });
    const ctx = contestoFinto({ sessioni: [['tab', session]] });
    module = giuntura([(context, actual) => {
      lifecycle = actual;
      register(context, process.argv.includes('--mutant') ? { ...actual, acquisisciLeaseOperazione() {}, async rilasciaLeaseOperazione() {} } : actual);
    }], { connessioni: { teardownConnection: async () => { teardown++; } } });
    module.registraEventi(ctx);
    pending = barriers.map((_, index) => ctx.socket.chiama('backup:restore', { tabId: 'tab', from: temp, operationId: 'restore-' + index }));
    await Promise.all(barriers.map(barrier => barrier.start.promise));
    if (chiusura === 'tab') await lifecycle.closeSession('tab');
    else {
      for (const fn of ctx.socket.handler.get('disconnect') || []) fn();
      await lifecycle.closeAllSessions();
    }
    const during = teardown;
    barriers[0].release.resolve(); const first = await pending[0];
    const afterFirst = teardown;
    for (const barrier of barriers.slice(1)) barrier.release.resolve();
    const results = await Promise.all(pending); await module.drain();
    assert.equal(during, 0, '[RESTORE-LEASE] il driver resta vivo dopo la chiusura durante il ripristino');
    if (paralleli > 1) assert.equal(afterFirst, 0, '[RESTORE-LEASE] la prima fine non chiude il driver del secondo ripristino');
    assert.equal(teardown, 1, '[RESTORE-LEASE] il driver viene chiuso una sola volta dopo tutte le operazioni');
    assert.equal(session.operationLeases, 0, '[RESTORE-LEASE] nessuna lease trattenuta');
    assert.equal(ctx.sessions.size, 0);
    for (const result of results) {
      assert.equal(result.ok, !errore);
      if (errore) assert.match(result.error, /Errore di ripristino controllato/);
      else assert.equal(result.summary.status, 'completato');
    }
    return first;
  } finally {
    for (const barrier of barriers) barrier.release.resolve();
    await Promise.allSettled(pending);
    if (module) await module.close();
    adapter.runRestoreViaPlan = original;
    if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^codedb-restore-lease-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
async function preparazioneFallita() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-restore-lease-'));
  const cached = require.cache[modulePath];
  let lifecycle, module, teardown = 0;
  try {
    fs.writeFileSync(path.join(temp, 'manifest.json'), '{}');
    const destination = path.join(temp, 'non-directory'); fs.writeFileSync(destination, 'fixture');
    delete require.cache[modulePath];
    if (process.argv.includes('--mutant-preparazione')) {
      const Module = require('node:module'), altered = new Module(modulePath);
      altered.filename = modulePath; altered.paths = Module._nodeModulePaths(path.dirname(modulePath));
      const source = fs.readFileSync(modulePath, 'utf8');
      const needle = 'await lifecycle.rilasciaLeaseOperazione?.(sess);';
      const index = source.lastIndexOf(needle); assert(index >= 0);
      altered._compile(source.slice(0, index) + 'if (log) ' + source.slice(index), modulePath);
      require.cache[modulePath] = altered;
    }
    const register = require(modulePath).createModule({
      lock: { normTabId: value => value }, identita: { assertWholeConnection() {} },
      operazioni: { resolveBackupPath: (_principal, _raw, purpose) => purpose === 'destinazione' ? destination : temp, backupRootOf: () => temp },
      config: { env: {} }, audit: { auditWrite() {} }, errori: { errMsg: error => error.message },
    });
    const session = sessioneFinta({ tabId: 'tab', connName: 'prova' });
    const ctx = contestoFinto({ sessioni: [['tab', session]] });
    module = giuntura([(context, actual) => { lifecycle = actual; register(context, actual); }],
      { connessioni: { teardownConnection: async () => { teardown++; } } });
    module.registraEventi(ctx);
    const result = await ctx.socket.chiama('backup:restore', { tabId: 'tab', from: temp, operationId: 'preparazione-fallita' });
    assert.equal(result.ok, false); assert.match(result.error, /EEXIST|ENOTDIR/);
    assert(!result.error.includes(temp), '[RESTORE-PREPARAZIONE] percorso privato redatto');
    await lifecycle.closeSession('tab');
    assert.equal(session.operationLeases, 0, '[RESTORE-PREPARAZIONE] rilascio anche prima di avviare il piano');
    assert.equal(teardown, 1, '[RESTORE-PREPARAZIONE] driver chiuso dopo errore di preparazione');
  } finally {
    if (module) await module.close();
    if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = (async () => {
  const results = [];
  for (const closing of ['tab', 'socket']) for (const [error, parallel] of [[false, 1], [true, 1], [false, 2]]) {
    const id = `${closing}/${error ? 'errore' : 'successo'}/${parallel}`;
    try { await scenario(closing, error, parallel); results.push({ id, ok: true }); console.log(`OK ${id}`); }
    catch (error) { results.push({ id, ok: false, errore: error.message }); console.error(`FAIL ${id}: ${error.message}`); process.exitCode = 1; }
  }
  try { await preparazioneFallita(); results.push({ id: 'preparazione-fallita', ok: true }); console.log('OK preparazione-fallita'); }
  catch (error) { results.push({ id: 'preparazione-fallita', ok: false, errore: error.message }); console.error('FAIL preparazione-fallita: ' + error.message); process.exitCode = 1; }
  if (process.env.LAB_REPORT_DIR) {
    fs.mkdirSync(process.env.LAB_REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.LAB_REPORT_DIR, 'backup-lease.json'), JSON.stringify({ verifiche: results, ok: results.every(item => item.ok) }, null, 2));
  }
})();
