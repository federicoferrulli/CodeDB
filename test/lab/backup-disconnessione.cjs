'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// AUD013: socket e MongoDB veri, pausa di scheduling dopo il restore dello staging.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-disconnessione.cjs [--sensitivity]
// Il DB nativo è indipendente dal driver del server; il vault e tutti i file sono isolati.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createE2eTargetRegistry } = require('../e2e-harness');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-013/reali-host');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = data => createHash('sha256').update(data).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
async function bounded(promise, label, ms = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(test, label, ms = 10000) {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() >= end) throw new Error(`Timeout: ${label}`); await pause(20); }
}

async function worker(mutant) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-disconnessione', motore: 'mongodb', mutante: mutant, iniziato: new Date().toISOString(), verifiche: [], operazioni: [], sorgenti: {} };
  const sourceFiles = ['server/eventi-backup.js', 'server/socket.js', 'server/operazioni.js', 'server/createServer.js',
    'db/importOperations.js', 'db/restoreOperations.js', 'db/backupRestoreAdapter.js', 'db/importPlan.js', 'backup/lib/restore.js', 'test/lab/backup-disconnessione.cjs'];
  for (const file of sourceFiles) report.sorgenti[file] = hash(fs.readFileSync(path.join(__dirname, '../..', file)));
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_lease' });
  const source = registry.target('origine');
  const contexts = new Map(), sockets = new Set(), executions = new Map(), completed = new Map();
  const barriers = [];
  let current = null, server, native;
  const uri = process.env.MONGO_URI || `mongodb://127.0.0.1:${Number(process.env.MONGO_PORT || 37017)}/?directConnection=true`;
  async function check(id, action) {
    const start = Date.now();
    try { const details = await action(); report.verifiche.push({ id, ok: true, ms: Date.now() - start, dettagli: details }); console.log(`OK ${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, ms: Date.now() - start, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message}`); return false; }
  }
  function stageOwner(name) {
    const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
    return suffix && registry.targets().find(base => name === base.slice(0, 63 - suffix.length) + suffix);
  }
  const data = async db => plain(await native.db(db).collection('righe').find({}).sort({ _id: 1 }).toArray());
  async function snapshot(db) {
    const infos = await native.db(db).listCollections().toArray();
    return {
      righe: await data(db),
      indici: (await native.db(db).collection('righe').listIndexes().toArray()).map(({ v, ns, ...index }) => index).sort((a, b) => a.name.localeCompare(b.name)),
      vista: infos.find(info => info.name === 'vista_righe')?.options || null,
      righeVista: infos.some(info => info.name === 'vista_righe') ? plain(await native.db(db).collection('vista_righe').find({}).sort({ _id: 1 }).toArray()) : [],
    };
  }
  async function seedTarget(db) {
    registry.assertOwned(db);
    await native.db(db).collection('righe').insertOne({ _id: 90, nome: 'sentinella', valore: 900 });
    await native.db(db).collection('righe').createIndex({ valore: -1 }, { name: 'ix_locale' });
  }
  const emit = (socket, event, payload, ms = 30000) => bounded(new Promise(resolve => socket.emit(event, payload, resolve)), event, ms);
  async function client() {
    const { io } = require('socket.io-client');
    const socket = io(`http://127.0.0.1:${server.server.address().port}`, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.add(socket);
    await bounded(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }), 'connessione socket');
    return socket;
  }
  async function connect(socket, tabId) {
    const result = await emit(socket, 'mongo:connect', { tabId, dbType: 'mongodb', uri, saveAs: 'lab-disconnessione' });
    assert.equal(result.ok, true, result.error);
    const context = contexts.get(socket.id), session = context.sessions.get(tabId);
    assert(session, 'Sessione reale osservabile nel registratore');
    const disconnect = session.strategy.disconnect.bind(session.strategy);
    const observation = { context, session, teardown: 0 };
    session.strategy.disconnect = async (...args) => { observation.teardown++; return disconnect(...args); };
    return observation;
  }
  async function state(socket, operationId) {
    const result = await emit(socket, 'backup:restore:state', { operationId }, 1500);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.operation?.operationId, operationId);
    return result.operation;
  }
  async function list(socket) {
    const result = await emit(socket, 'backup:restore:list', {}, 1500);
    assert.equal(result.ok, true, result.error);
    assert(Array.isArray(result.operations), 'Elenco operazioni esplicito');
    return result.operations;
  }

  // Il solo scheduling viene controllato: la funzione originale ha già scritto
  // righe, vista e indici nello staging, e l'adapter deve ancora verificarli.
  const restoreModule = require('../../backup/lib/restore'), restoreOriginal = restoreModule.runRestore;
  restoreModule.runRestore = async options => {
    const result = await restoreOriginal(options);
    if (current && !current.entered && stageOwner(options.targetDb) === current.target) {
      current.entered = true; current.stage = options.targetDb;
      const barrier = current; barrier.ready.resolve(); await barrier.release.promise;
    }
    return result;
  };
  const adapter = require('../../db/backupRestoreAdapter'), adapterOriginal = adapter.runRestoreViaPlan;
  adapter.runRestoreViaPlan = async options => {
    executions.set(options.targetDb, (executions.get(options.targetDb) || 0) + 1);
    try {
      const result = await adapterOriginal(options); completed.set(options.targetDb, { summary: plain(result) }); return result;
    } catch (error) { completed.set(options.targetDb, { error: error.message }); throw error; }
  };
  const eventModule = require('../../server/eventi-backup'), factoryOriginal = eventModule.createModule;
  eventModule.createModule = dependencies => {
    const register = factoryOriginal(dependencies);
    return (context, lifecycle) => {
      contexts.set(context.socket.id, context);
      const accepted = new Set();
      const altered = { ...lifecycle, safeOn(event, handler) {
        lifecycle.safeOn(event, async (payload, cb) => {
          if (event === 'backup:restore') accepted.add(payload.operationId);
          if (mutant === 'stato-socket' && event === 'backup:restore:state' && !accepted.has(payload.operationId)) {
            cb({ ok: false, error: 'Mutante: stato conservato sul solo socket originale' }); return;
          }
          return handler(payload, response => {
            if (mutant === 'stato-socket' && event === 'backup:restore:list' && response.operations) {
              response = { ...response, operations: response.operations.filter(op => accepted.has(op.operationId)) };
            }
            if (mutant === 'errore-successo' && event === 'backup:restore:state' && response.operation?.status === 'ripristinato_dopo_errore') {
              response = { ...response, operation: { ...response.operation, status: 'completato', error: null } };
            }
            cb(response);
          });
        });
      } };
      if (mutant === 'senza-lease') {
        altered.acquisisciLeaseOperazione = () => {};
        altered.rilasciaLeaseOperazione = async () => {};
      }
      register(context, altered);
    };
  };

  try {
    registry.assertOwned(source);
    const { MongoClient } = require('mongodb');
    native = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await native.connect();
    await native.db(source).collection('righe').insertMany([
      { _id: 1, nome: 'prima', valore: 10 }, { _id: 2, nome: 'seconda', valore: 20 },
    ]);
    await native.db(source).collection('righe').createIndex({ nome: 1 }, { unique: true, name: 'ix_nome_unico' });
    await native.db(source).createCollection('vista_righe', { viewOn: 'righe', pipeline: [{ $project: { nome: 1, valore: { $multiply: ['$valore', 2] } } }] });
    const expected = await snapshot(source);
    const isolated = fs.mkdtempSync(path.join(reportDir, 'server-'));
    const ini = path.join(isolated, 'connections.ini'); fs.writeFileSync(ini, '');
    server = require('../../server/createServer').createServer({ config: { env: {
      PORT: '0', HOST: '127.0.0.1', CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '',
      CODEDB_CONNECTIONS_FILE: ini, CODEDB_CONNECTIONS_DIR: path.join(isolated, 'conns'),
      CODEDB_BACKUPS_DIR: path.join(isolated, 'backups'), CODEDB_SCRIPT_RESULTS_DIR: path.join(isolated, 'script-results'),
      CODEDB_UI_AUDIT_FILE: path.join(isolated, 'ui-audit.log'), CODEDB_MCP_AUDIT_FILE: path.join(isolated, 'mcp-audit.log'),
    } } });
    await server.start();
    const initial = await client(); await connect(initial, 'controllo');
    const backup = await emit(initial, 'backup:run', { tabId: 'controllo', db: source, type: 'full', operationId: randomUUID() });
    assert.equal(backup.ok, true, backup.error); assert(backup.summary.backupDir);
    const control = registry.target('controllo'); await seedTarget(control);
    const controlId = randomUUID();
    const basePayload = { from: backup.summary.backupDir, drop: true };
    let controlResult;
    await check('controllo-ack-legacy', async () => {
      controlResult = await emit(initial, 'backup:restore', { ...basePayload, tabId: 'controllo', targetDb: control, operationId: controlId });
      assert.equal(controlResult.ok, true, controlResult.error); assert.equal(controlResult.summary.status, 'completato');
      return controlResult;
    });
    await check('controllo-dati-catalogo-nativi', async () => assert.deepEqual(await snapshot(control), expected));
    await check('idempotenza-operationId-concluso', async () => {
      const before = executions.get(control);
      const replay = await emit(initial, 'backup:restore', { ...basePayload, tabId: 'controllo', targetDb: control, operationId: controlId });
      assert.equal(executions.get(control), before, 'Lo stesso operationId non deve eseguire un secondo ripristino');
      assert.equal(replay.ok, true, 'Il replay equivalente riusa l’esito finale');
      assert.deepEqual(replay.summary, controlResult.summary, 'L’ACK finale del replay conserva lo stesso riepilogo');
      assert.deepEqual(await snapshot(control), expected);
    });
    initial.close();

    const terminalIds = [];
    for (const failed of [false, true]) {
      const label = failed ? 'errore' : 'successo';
      const target = registry.target(label); await seedTarget(target); const before = await snapshot(target);
      const operationId = randomUUID(), socket = await client(), observation = await connect(socket, label);
      const barrier = { target, operationId, ready: deferred(), release: deferred(), entered: false }; barriers.push(barrier); current = barrier;
      const progress = []; socket.on('backup:progress', event => { if (event.operationId === operationId) progress.push(event); });
      socket.emit('backup:restore', { ...basePayload, tabId: label, targetDb: target, operationId }, response => { barrier.ack = response; });
      await bounded(barrier.ready.promise, `staging reale ${label}`);
      await check(`${label}-barriera-dopo-dati-reali`, async () => {
        assert.deepEqual(await snapshot(barrier.stage), expected); assert.deepEqual(await snapshot(target), before);
        assert(progress.length, 'Il socket ha ricevuto progresso correlato prima della disconnessione');
      });
      if (failed) {
        assert.equal(stageOwner(barrier.stage), target); registry.assertOwned(target);
        await native.db(barrier.stage).collection('righe').dropIndex('ix_nome_unico');
      }
      const originalSocketId = socket.id; socket.close();
      await until(() => observation.context.sessions.size === 0, 'distacco sessione sul server');
      await check(`${label}-lease-driver-vivo`, async () => {
        assert.equal(observation.teardown, 0, 'Il driver non viene chiuso con il restore sospeso');
        assert(observation.session.operationLeases > 0, 'Lease acquisita');
        assert.equal(observation.session.closed, false);
        assert.equal(await observation.session.strategy.requireClient().db('admin').command({ ping: 1 }).then(result => result.ok), 1);
      });
      const observer = await client(); assert.notEqual(observer.id, originalSocketId);
      assert.equal(contexts.get(observer.id).sessions.size, 0, 'L’osservatore non deve aprire una sessione DB');
      await check(`${label}-stato-in-corso-nuova-socket`, async () => {
        const operation = await state(observer, operationId);
        assert.equal(operation.status, 'in_corso'); assert.equal(operation.targetDb, target); return operation;
      });
      await check(`${label}-elenco-in-corso-nuova-socket`, async () => {
        const operations = await list(observer); const operation = operations.find(item => item.operationId === operationId);
        assert.equal(operation?.status, 'in_corso'); assert.equal(operation.targetDb, target);
      });
      barrier.release.resolve();
      await until(() => completed.has(target), `termine reale ${label}`, 30000);
      await until(() => observation.session.closed, `chiusura driver finale ${label}`);
      current = null;
      const actual = completed.get(target); report.operazioni.push({ operationId, target, stage: barrier.stage, ...actual });
      await check(`${label}-esito-reale`, async () => {
        assert.equal(actual.summary?.status, failed ? 'ripristinato_dopo_errore' : 'completato', actual.error || actual.summary?.error);
        if (failed) {
          assert(actual.summary.verification?.schemaDifferences?.some(item => JSON.stringify(item.missing).includes('ix_nome_unico')),
            'Il fallimento deve derivare dall’indice realmente rimosso, non da un driver distrutto');
        }
        assert.equal(executions.get(target), 1);
      });
      await check(`${label}-dati-catalogo-nativi`, async () => assert.deepEqual(await snapshot(target), failed ? before : expected));
      await check(`${label}-lease-rilasciata-una-volta`, async () => {
        assert.equal(observation.teardown, 1); assert.equal(observation.session.operationLeases, 0);
        assert.equal(observation.context.sessions.size, 0); assert.equal(observation.session.strategy.client, null);
      });
      await check(`${label}-stato-terminale-nuova-socket`, async () => {
        const operation = await state(observer, operationId);
        assert.equal(operation.status, failed ? 'ripristinato_dopo_errore' : 'completato'); assert.equal(operation.targetDb, target);
        assert(operation.endedAt, 'Il termine deve essere osservabile');
        if (failed) { assert.match(operation.error, /schema|staging/i); assert(operation.recovery?.verified); }
        assert(!JSON.stringify(operation).includes(isolated), 'Lo stato pubblico non espone percorsi filesystem');
        return operation;
      });
      terminalIds.push({ operationId, status: failed ? 'ripristinato_dopo_errore' : 'completato' }); observer.close();
    }
    const last = await client();
    await check('elenco-esiti-dopo-chiusura-di-tutti-i-socket', async () => {
      const operations = await list(last);
      for (const expectedOperation of terminalIds) assert.equal(operations.find(item => item.operationId === expectedOperation.operationId)?.status, expectedOperation.status);
    });
    await check('stato-id-ignoto-rifiutato', async () => {
      const response = await emit(last, 'backup:restore:state', { operationId: randomUUID() }, 1500);
      assert.equal(response.ok, false); assert.equal(typeof response.error, 'string');
    });
    await check('origine-inalterata', async () => assert.deepEqual(await snapshot(source), expected));
    last.close();
  } catch (error) {
    report.fatale = { errore: error.message, stack: error.stack }; console.error(error.stack);
  } finally {
    for (const barrier of barriers) barrier.release.resolve();
    for (const socket of sockets) socket.close();
    try { if (server) await bounded(server.stop(), 'arresto server', 30000); }
    catch (error) { report.arrestoErrore = error.message; }
    try {
      if (native) {
        const names = (await native.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(item => item.name);
        const technical = names.filter(name => stageOwner(name));
        for (const name of technical) { registry.assertOwned(stageOwner(name)); await native.db(name).dropDatabase(); }
        const owned = registry.targets(); await registry.cleanup(name => native.db(name).dropDatabase());
        const remaining = (await native.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(item => item.name);
        assert(!remaining.some(name => owned.includes(name) || technical.includes(name)), 'Nessun database fixture residuo');
        report.pulizia = { completata: true, database: [...owned, ...technical] };
      }
    } catch (error) { report.pulizia = { completata: false, errore: error.message }; }
    if (native) await native.close();
    restoreModule.runRestore = restoreOriginal; adapter.runRestoreViaPlan = adapterOriginal; eventModule.createModule = factoryOriginal;
    report.sorgentiStabili = sourceFiles.every(file => report.sorgenti[file] === hash(fs.readFileSync(path.join(__dirname, '../..', file))));
    report.terminato = new Date().toISOString();
    report.ok = !report.fatale && !report.arrestoErrore && report.pulizia?.completata === true && report.sorgentiStabili && report.verifiche.every(item => item.ok);
    fs.writeFileSync(path.join(reportDir, 'backup-disconnessione.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

async function launch(mutant) {
  const dir = path.join(reportDir, mutant || 'base'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-disconnessione.json'); fs.rmSync(file, { force: true });
  const child = spawn(process.execPath, [__filename, '--worker', ...(mutant ? ['--mutant', mutant] : [])], {
    cwd: path.resolve(__dirname, '../..'), env: { ...process.env, LAB_REPORT_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = fs.createWriteStream(path.join(dir, 'esecuzione.log'));
  inoltraOutputFiglio(child, { log: output, mutante: mutant || null });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => output.end(resolve));
  return { code, report: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

async function main() {
  if (process.argv.includes('--worker')) {
    const index = process.argv.indexOf('--mutant'); const result = await worker(index < 0 ? null : process.argv[index + 1]);
    if (!result.ok) process.exitCode = 1; return;
  }
  const base = await launch(null), mutants = [];
  if (process.argv.includes('--sensitivity') && base.report?.ok) {
    for (const name of ['senza-lease', 'stato-socket', 'errore-successo']) {
      const outcome = await launch(name), failures = outcome.report?.verifiche.filter(item => !item.ok).map(item => item.id) || [];
      // Ogni mutazione riguarda entrambi gli scenari: controlliamo anche gli
      // effetti terminali e l'elenco, senza accettare fallimenti estranei.
      const expected = name === 'senza-lease' ? [
        'successo-lease-driver-vivo', 'successo-esito-reale', 'successo-dati-catalogo-nativi',
        'successo-lease-rilasciata-una-volta', 'successo-stato-terminale-nuova-socket',
        'errore-lease-driver-vivo', 'errore-esito-reale', 'errore-lease-rilasciata-una-volta',
        'errore-stato-terminale-nuova-socket', 'elenco-esiti-dopo-chiusura-di-tutti-i-socket',
      ] : name === 'stato-socket' ? [
        'successo-stato-in-corso-nuova-socket', 'successo-elenco-in-corso-nuova-socket',
        'successo-stato-terminale-nuova-socket', 'errore-stato-in-corso-nuova-socket',
        'errore-elenco-in-corso-nuova-socket', 'errore-stato-terminale-nuova-socket',
        'elenco-esiti-dopo-chiusura-di-tutti-i-socket',
      ] : ['errore-stato-terminale-nuova-socket'];
      mutants.push({ nome: name, rilevato: outcome.code === 1 && !outcome.report?.fatale && !outcome.report?.arrestoErrore
        && outcome.report?.pulizia?.completata === true && outcome.report?.sorgentiStabili === true
        && expected.every(id => base.report.verifiche.some(item => item.id === id && item.ok))
        && JSON.stringify(failures.slice().sort()) === JSON.stringify(expected.slice().sort()), fallimenti: failures });
    }
  }
  const result = { suite: 'backup-disconnessione', base: base.report, mutanti: mutants,
    sensibilitaNonEseguita: process.argv.includes('--sensitivity') && !base.report?.ok ? 'Baseline rossa: prima correggere produzione' : null,
    ok: base.code === 0 && base.report?.ok && mutants.every(item => item.rilevato) };
  fs.writeFileSync(path.join(reportDir, 'backup-disconnessione.json'), JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
