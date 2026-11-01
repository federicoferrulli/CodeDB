'use strict';

// AUD013: eventi, autorizzazioni, registri e lifecycle reali; soltanto il
// motore di restore è sospeso. Nessuna sessione DB è aperta dagli osservatori.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { giuntura } = require('./server-fixture');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { makePrincipal } = require('../auth/principal');
const { formattaOutputMutante } = require('./lab/output-mutanti.cjs');
const adapter = require('../db/backupRestoreAdapter');
const mutant = process.argv.find(arg => arg.startsWith('--mutant='))?.slice(9) || null;
const mutanti = ['ripetizione', 'payload-ignorato', 'identita-ignorata', 'permessi-ignorati'];
if (mutant && !mutanti.includes(mutant)) throw new Error('Mutante sconosciuto: ' + mutant);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const owner = (id = 'tenant-a', actor = id, connScope = null) => makePrincipal({ _id: actor, ownerId: id, type: 'owner' }, [], connScope);
const main = owner();
const eventFile = require.resolve('../server/eventi-backup');

async function fixture(action, { status = 'completato', thrown = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-registro-restore-'));
  const original = adapter.runRestoreViaPlan, cached = require.cache[eventFile];
  const gate = deferred(), calls = [], pending = [], lifecycles = new Map(), tokenPrincipals = new Map();
  let module, operations, hits = 0, now = 0, tokens = 0;
  const result = { status, targetDb: 'destinazione', totalDocs: 7, layers: 2,
    equivalenza: { completa: true }, coerenzaSchema: { ok: status === 'completato' },
    ...(status === 'completato' ? {} : { error: 'Indice mancante nello staging',
      recovery: { id: 'recupero-013', verified: true, backupDir: '/segreto/recupero' },
      staging: { db: 'staging-013', retained: true } }) };
  try {
    adapter.runRestoreViaPlan = async options => {
      calls.push(options); options.onProgress?.({ phase: 'applicazione', status: 'in_corso' });
      await gate.promise;
      if (thrown) throw new Error('Errore controllato prima del completamento');
      return { ...result, targetDb: options.targetDb };
    };
    const config = { env: { CODEDB_BACKUPS_DIR: dir, CODEDB_REVALIDATE_PRINCIPAL_MS: '100' }, rootDir: dir, rbacOn: () => true };
    const identita = require('../server/identita').createModule({ config,
      trasporto: { app: { post() {} }, io: { use() {}, sockets: { sockets: new Map() } } },
      audit: {}, errori: {}, dependencies: {} });
    const realPermission = identita.assertWholeConnection;
    if (mutant === 'permessi-ignorati') identita.assertWholeConnection = (...args) => { hits++; };
    operations = require('../server/operazioni').createModule({ config, identita });
    const root = operations.backupRootOf(main);
    const from = path.join(root, 'gruppo', 'backup-a'), otherFrom = path.join(root, 'gruppo', 'backup-b');
    for (const source of [from, otherFrom]) { fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'manifest.json'), '{}'); }
    delete require.cache[eventFile];
    const register = require(eventFile).createModule({ lock: { normTabId: value => value }, identita,
      operazioni: operations, config, audit: { auditWrite() {} }, errori: { errMsg: error => error.message } });
    const accepted = new Map();
    module = giuntura([(context, lifecycle) => {
      lifecycles.set(context, lifecycle);
      const intercept = method => (event, handler) => lifecycle[method](event, async (payload, cb, ctx) => {
        if (event === 'backup:restore') {
          const previous = accepted.get(payload.operationId);
          if (previous && mutant === 'ripetizione') { payload = { ...payload, operationId: payload.operationId + '-duplicato' }; hits++; }
          else if (previous && mutant === 'payload-ignorato') { payload = { ...previous }; hits++; }
          else accepted.set(payload.operationId, { ...payload });
        }
        const old = context.principal;
        if (mutant === 'identita-ignorata' && /^backup:restore:(state|list)$/.test(event)
          && (old.ownerId !== main.ownerId || old.id !== main.id)) { context.principal = main; hits++; }
        try { return await handler(payload, cb, ctx); }
        finally { context.principal = old; }
      });
      register(context, { ...lifecycle, safeOn: intercept('safeOn'), operazioneLunga: intercept('operazioneLunga') });
    }], { config, now: () => now,
      // Il provider token sostituisce il control plane; la decisione e la
      // rivalidazione nel lifecycle sono quelle reali del server.
      identita: { ...identita, resolvePrincipalFromToken: async token => tokenPrincipals.get(token) || null } });
    function client(principal = main, connected = false, connection = 'collaudo') {
      const session = sessioneFinta({ tabId: 'tab', connName: connection, principal });
      session.effectiveCfg.password = 'segreto-db-013'; session.effectiveCfg.uri = 'mongodb://utente:segreto-db-013@localhost';
      const context = contestoFinto({ principal, sessioni: connected ? [['tab', session]] : [] });
      context.socket.handshake.auth.token = 'token-' + (++tokens);
      tokenPrincipals.set(context.socket.handshake.auth.token, principal);
      module.registraEventi(context); return context;
    }
    const origin = client(main, true);
    const payload = { tabId: 'tab', operationId: 'restore-013', from, targetDb: 'destinazione', drop: false, collections: ['righe'] };
    const send = (context, event, body = {}) => context.socket.chiama(event, body);
    function start(body = payload, context = origin) {
      const request = send(context, 'backup:restore', body); pending.push(request);
      // L'handler contiene await: la barriera di un giro del loop rende
      // osservabile l'avvio, senza affidare l'oracolo a un ritardo fisso.
      return request;
    }
    async function finish(request) { gate.resolve(); const response = await request; await module.drain(); return response; }
    async function read(context, id = payload.operationId, extra = {}) {
      assert.equal(context.sessions.size, 0, '[REGISTRO-NO-SESSIONE] osservatore senza driver');
      const response = await send(context, 'backup:restore:state', { operationId: id, ...extra });
      assert.equal(response.ok, true, response.error); assert.equal(response.operation.operationId, id); return response.operation;
    }
    async function list(context) {
      assert.equal(context.sessions.size, 0, '[REGISTRO-NO-SESSIONE] elenco senza driver');
      const response = await send(context, 'backup:restore:list', {});
      assert.equal(response.ok, true, response.error); assert(Array.isArray(response.operations)); return response.operations;
    }
    const details = await action({ calls, result, client, origin, payload, otherFrom, start, finish, send, read, list, lifecycles, gate,
      revalidate(context, principal) { tokenPrincipals.set(context.socket.handshake.auth.token, principal); now += 101; },
      assertActualPermission: (principal, connection) => realPermission(principal, connection, 'manage', 'vedere un ripristino') });
    return { ...details, esecuzioni: calls.length, mutazioni: hits };
  } catch (error) {
    error.mutationHits = hits;
    throw error;
  } finally {
    gate.resolve(); await Promise.allSettled(pending);
    if (module) await module.close();
    await operations?.restoreOperations?.close?.(); await operations?.importOperations?.close?.();
    adapter.runRestoreViaPlan = original;
    if (cached) require.cache[eventFile] = cached; else delete require.cache[eventFile];
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^codedb-registro-restore-/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [];
const test = (id, body, options) => cases.push({ id, body, options });
test('ack-finale-legacy', async f => {
  let done = false; const request = f.start(); request.then(() => { done = true; }); await tick();
  assert.equal(f.calls.length, 1); assert.equal(done, false, '[REGISTRO-ACK] nessun ACK di sola accettazione');
  const ack = await f.finish(request); assert.equal(ack.ok, true); assert.equal(ack.summary.status, 'completato');
  assert.equal(ack.summary.totalDocs, 7); assert.equal(ack.summary.layers, 2);
});
for (const phase of ['in-corso', 'concluso']) test('idempotenza-' + phase, async f => {
  const first = f.start(); await tick(); if (phase === 'concluso') await f.finish(first);
  let duplicateAck = false;
  const second = f.start(); second.then(() => { duplicateAck = true; }); await tick();
  assert.equal(f.calls.length, 1, '[REGISTRO-IDEMPOTENZA] stessa ID: un solo restore');
  if (phase === 'in-corso') {
    assert.equal(duplicateAck, false, '[REGISTRO-IDEMPOTENZA] anche il duplicato attende l’esito finale');
    assert.equal(f.origin.sessions.get('tab').operationLeases, 1, '[REGISTRO-IDEMPOTENZA] stessa ID: una sola lease');
  }
  const a = await f.finish(first), b = await second;
  assert.equal(a.ok, true); assert.equal(b.ok, true, '[REGISTRO-IDEMPOTENZA] il replay restituisce il medesimo esito');
  assert.deepEqual(b.summary, a.summary);
  assert.equal(f.origin.sessions.get('tab').operationLeases, 0, '[REGISTRO-IDEMPOTENZA] nessuna lease residua');
});
test('idempotenza-richiesta-equivalente', async f => {
  const first = await f.finish(f.start());
  const equivalent = Object.fromEntries(Object.entries(f.payload).reverse());
  delete equivalent.drop; equivalent.connName = 'etichetta-client-diversa';
  const duplicate = await f.start(equivalent);
  assert.equal(f.calls.length, 1, '[REGISTRO-IDEMPOTENZA] conta la richiesta normalizzata, non ordine proprietà o etichetta client');
  assert.equal(duplicate.ok, true); assert.deepEqual(duplicate.summary, first.summary);
});
const altered = {
  destinazione: f => ({ targetDb: 'diversa' }), drop: f => ({ drop: true }),
  selezione: f => ({ collections: ['altre_righe'] }), origine: f => ({ from: f.otherFrom }),
};
for (const [name, change] of Object.entries(altered)) test('payload-diverso-' + name, async f => {
  const first = f.start(); await f.finish(first);
  const duplicate = await f.start({ ...f.payload, ...change(f) });
  assert.equal(duplicate.ok, false, '[REGISTRO-PAYLOAD] stessa ID con richiesta diversa rifiutata');
  assert.equal(f.calls.length, 1, '[REGISTRO-PAYLOAD] nessuna seconda mutazione');
});
test('payload-diverso-connessione', async f => {
  await f.finish(f.start());
  const other = f.client(main, true, 'produzione');
  const duplicate = await f.start(f.payload, other);
  assert.equal(duplicate.ok, false, '[REGISTRO-PAYLOAD] stessa ID su connessione diversa rifiutata');
  assert.equal(f.calls.length, 1, '[REGISTRO-PAYLOAD] nessuna mutazione su altro server');
});
test('payload-diverso-in-corso', async f => {
  const first = f.start(); await tick();
  let denied;
  const duplicate = f.start({ ...f.payload, targetDb: 'diversa' }); duplicate.then(value => { denied = value; }); await tick();
  assert.equal(f.calls.length, 1, '[REGISTRO-PAYLOAD] il conflitto non avvia un secondo restore');
  assert.equal(denied?.ok, false, '[REGISTRO-PAYLOAD] rifiuto immediato prima della fine del primo restore');
  assert.equal(f.origin.sessions.get('tab').operationLeases, 1, '[REGISTRO-PAYLOAD] il conflitto non acquisisce una lease');
  await f.finish(first); await duplicate;
});
test('stato-in-corso-senza-sessione', async f => {
  const request = f.start(); await tick(); const observer = f.client();
  const operation = await f.read(observer); assert.equal(operation.status, 'in_corso'); assert.equal(operation.endedAt, null);
  assert.equal(operation.connection, 'collaudo'); assert.equal(operation.targetDb, 'destinazione');
  assert.equal((await f.list(observer)).filter(item => item.operationId === f.payload.operationId).length, 1);
  await f.finish(request); assert.equal(f.calls.length, 1, 'La lettura non rilancia il restore');
});
for (const status of ['completato', 'ripristinato_dopo_errore', 'intervento_richiesto']) test('stato-terminale-' + status, async f => {
  const ack = await f.finish(f.start()); assert.equal(ack.ok, true); assert.equal(ack.summary.status, status);
  const observer = f.client(), operation = await f.read(observer);
  assert.equal(operation.status, status); assert(operation.endedAt, '[REGISTRO-ESITO] data finale presente');
  assert.equal(operation.targetDb, 'destinazione');
  if (status !== 'completato') {
    assert.equal(operation.error, f.result.error); assert.equal(operation.recovery.id, 'recupero-013');
    assert.equal(operation.recovery.verified, true); assert.equal(operation.staging.db, 'staging-013');
    assert.equal(operation.recovery.backupDir, undefined, 'Il percorso privato non attraversa il confine pubblico');
  }
  const listed = (await f.list(observer)).find(item => item.operationId === f.payload.operationId);
  assert.equal(listed.status, status); assert.equal(listed.endedAt, operation.endedAt); assert.equal(f.calls.length, 1);
}, { status });
test('errore-conservato-dopo-ack', async f => {
  const ack = await f.finish(f.start()); assert.equal(ack.ok, false); assert.match(ack.error, /Errore controllato/);
  const operation = await f.read(f.client()); assert.equal(operation.status, 'intervento_richiesto');
  assert.match(operation.error, /Errore controllato/); assert(operation.endedAt); assert.equal(f.calls.length, 1);
}, { thrown: true });
for (const [kind, principal] of [['owner', owner('tenant-b')], ['actor', owner('tenant-a', 'altro-attore')]]) {
  test('isolamento-' + kind, async f => {
    await f.finish(f.start()); const observer = f.client(principal);
    const denied = await f.send(observer, 'backup:restore:state', { operationId: f.payload.operationId,
      ownerId: main.ownerId, actorId: main.id, connName: 'collaudo' });
    const absent = await f.send(observer, 'backup:restore:state', { operationId: 'inesistente-013' });
    assert.equal(denied.ok, false, '[REGISTRO-IDENTITA] owner e attore dal contesto');
    assert.equal(denied.operation, undefined); assert.equal(denied.error, absent.error, 'Non rivela l’esistenza di operazioni altrui');
    assert.deepEqual(await f.list(observer), [], '[REGISTRO-IDENTITA] elenco isolato');
  });
}
test('permesso-connessione-rivalutato', async f => {
  await f.finish(f.start()); const observer = f.client(owner('tenant-a', 'tenant-a', ['collaudo']));
  await f.read(observer);
  const restricted = owner('tenant-a', 'tenant-a', ['altra']);
  assert.throws(() => f.assertActualPermission(restricted, 'collaudo'), /Permesso|permess/);
  f.revalidate(observer, restricted);
  const denied = await f.send(observer, 'backup:restore:state', { operationId: f.payload.operationId, connName: 'altra' });
  assert.equal(observer.principal, restricted, '[REGISTRO-PERMESSI] il lifecycle rilegge il principal dal provider token');
  assert.equal(denied.ok, false, '[REGISTRO-PERMESSI] usa la connessione registrata e i permessi correnti');
  assert.equal(denied.operation, undefined); assert.deepEqual(await f.list(observer), [], '[REGISTRO-PERMESSI] elenco filtra connessioni revocate');
  f.revalidate(observer, main); assert.equal((await f.read(observer)).status, 'completato');
});
test('stato-non-espone-credenziali', async f => {
  await f.finish(f.start()); const observer = f.client();
  const text = JSON.stringify([await f.read(observer), await f.list(observer)]);
  assert(!text.includes('segreto-db-013'), '[REGISTRO-SEGRETI] password e URI del driver restano privati');
  assert(!text.includes(f.payload.from), '[REGISTRO-SEGRETI] percorsi privati del backup non esposti');
  assert(!/"(effectiveCfg|strategy|principal|handshake)"/.test(text), '[REGISTRO-SEGRETI] nessun oggetto sessione nello stato pubblico');
});
test('avvio-rispetta-connScope', async f => {
  const restricted = f.client(owner('tenant-a', 'tenant-a', ['altra']), true);
  const request = f.start({ ...f.payload, connName: 'altra' }, restricted); await tick();
  f.gate.resolve(); const response = await request;
  assert.equal(response.ok, false, '[REGISTRO-PERMESSI] il payload non concede accesso al driver');
  assert.equal(f.calls.length, 0, '[REGISTRO-PERMESSI] rifiuto prima della mutazione');
});
test('identificatore-non-valido', async f => {
  const response = await f.start({ ...f.payload, operationId: '../non-valido' });
  assert.equal(response.ok, false); assert.equal(f.calls.length, 0);
});

module.exports = (async () => {
  const report = { suite: 'backup-registro', mutante: mutant, iniziato: new Date().toISOString(), sorgenti: {}, verifiche: [] };
  for (const file of ['server/eventi-backup.js', 'server/operazioni.js', 'server/socket.js', 'server/identita.js', 'db/importOperations.js',
    'db/restoreOperations.js', 'test/unit-backup-registro.js']) {
    const full = path.join(__dirname, '..', file);
    if (fs.existsSync(full)) report.sorgenti[file] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  for (const { id, body, options } of cases) {
    try { const details = await fixture(body, options); report.verifiche.push({ id, ok: true, dettagli: details }); console.log(formattaOutputMutante(mutant, 'OK ' + id)); }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, mutazioni: error.mutationHits }); console.error(formattaOutputMutante(mutant, 'FAIL ' + id + ': ' + error.message)); }
  }
  report.ok = report.verifiche.every(item => item.ok);
  if (process.env.LAB_REPORT_DIR) {
    fs.mkdirSync(process.env.LAB_REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.LAB_REPORT_DIR, 'backup-registro.json'), JSON.stringify(report, null, 2));
  }
  if (!report.ok) process.exitCode = 1;
  console.log(formattaOutputMutante(mutant, `${report.verifiche.filter(item => item.ok).length}/${cases.length} verifiche superate`));
})();
