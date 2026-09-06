'use strict';

// Percorsi reali, database e DOM finti: nessuna connessione o configurazione utente.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { creaPianoImport, eseguiPianoImport } = require('../db/importPlan');
const { mysqlSchemaObjects } = require('../backup/lib/engine');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');

const artifact = {
  formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
  collections: [{ name: 'clienti', indexes: [], docs: [{ _id: 1 }] }],
};

function frontend(extra = {}) {
  const nodes = new Map();
  const notices = [];
  const context = vm.createContext({
    console, Blob, URL, setTimeout, clearTimeout, crypto: require('crypto').webcrypto,
    $: (id) => {
      if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, classList: { add() {}, remove() {} }, innerHTML: '' });
      return nodes.get(id);
    },
    toast: (message) => notices.push(message), esc: (v) => String(v), showError() {},
    isSqlType: (type) => type !== 'mongodb',
    state: {}, tabs: { list: [{ id: 'tab-a' }] },
    iniziaCaricamento: () => () => {}, marcaDatiSporchi() {}, refreshDbTree: async () => {},
    captureContext: () => ({ tabId: 'tab-a', st: { dbType: 'postgresql' } }),
    eseguiInParalleloOrdinato: async (items, fn) => Promise.all(items.map(fn)),
    ...extra,
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/exportimport.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  return { context, nodes, notices };
}

const cases = [
  ['audit: import parziali e incerti non sono successi', async () => {
    const entries = [];
    const audit = require('../server/audit').createModule({
      config: { env: {}, rootDir: '.' }, errori: { errMsg: (err) => err.message },
      dependencies: { makeAuditor: () => ({ audit: (entry) => entries.push(entry) }) },
    });
    const payload = { db: 'db', coll: 'coll', batchId: 'blocco_1234567890' };
    const cls = audit.classifyAudit('collection:import', payload, {});
    audit.auditDelegate(cls, {}, 'collection:import', payload, 'ok', { status: 'incerto', error: 'rete' });
    audit.auditDelegate(cls, {}, 'collection:import', payload, 'ok', { inserted: 1, failed: 1, errors: ['vincolo'] });
    audit.auditDelegate(cls, {}, 'collection:import', { ...payload, statusOnly: true }, 'ok', { status: 'completato' });
    assert.deepStrictEqual(entries.map((entry) => entry.status), ['error', 'error']);
  }],
  ['server: nessuna riconnessione con ripetizione di un import incerto', async () => {
    const connections = require('../server/connessioni').createModule({});
    let attempts = 0;
    const error = Object.assign(new Error('connection lost'), { code: 'ECONNRESET', importOutcomeUnknown: true });
    await assert.rejects(connections.executeWithReconnect({ effectiveCfg: {}, strategy: {} }, async () => {
      attempts++; throw error;
    }), (err) => err === error);
    assert.strictEqual(attempts, 1);
  }],
  ['backup e restore MongoDB completo e selettivo conservano le opzioni', async () => {
    const os = require('os');
    const { EJSON } = require('bson');
    const { runBackup } = require('../backup/lib/engine');
    const { runRestore } = require('../backup/lib/restore');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-opzioni-'));
    const databases = new Map();
    const source = new Map([
      ['clienti', { options: { collation: { locale: 'it', strength: 2 } }, docs: [{ _id: 1 }] }],
      ['log', { options: { capped: true, size: 8192, max: 10 }, docs: [{ _id: 2 }] }],
      ['vuota', { options: { validator: { nome: { $type: 'string' } } }, docs: [] }],
    ]);
    databases.set('origine', source);
    const client = { db(db) {
      if (!databases.has(db)) databases.set(db, new Map());
      const collections = databases.get(db);
      return {
        listCollections() { return { async toArray() {
          return [...collections].map(([name, c]) => ({ name, type: 'collection', options: c.options }));
        } }; },
        async createCollection(name, options = {}) {
          assert(!collections.has(name));
          collections.set(name, { options: EJSON.serialize(options), docs: [] });
        },
        async command(command) {
          assert(!command.collation && !command.capped && !command.size && !command.max,
            'collMod non accetta le opzioni immutabili di creazione');
          const { collMod, ...changes } = command;
          Object.assign(collections.get(collMod).options, EJSON.serialize(changes));
        },
        collection(name) { return {
          find() { return { batchSize() { return this; }, async close() {},
            async *[Symbol.asyncIterator]() { yield* collections.get(name).docs; } }; },
          async indexes() { return [{ name: '_id_', key: { _id: 1 } }]; },
          async countDocuments() { return collections.get(name).docs.length; },
          async insertMany(rows) { collections.get(name).docs.push(...rows); },
          aggregate() { return { async toArray() {
            const n = collections.get(name).docs.length;
            return n ? [{ n }] : [];
          } }; },
          async createIndex() {},
          async drop() { if (!collections.delete(name)) throw Object.assign(new Error('assente'), { code: 26 }); },
        }; },
      };
    } };
    const strategy = { client, async listCollections(db) { return client.db(db).listCollections().toArray(); } };
    const session = { strategy, dbType: 'mongodb' };
    const log = { info() {}, error() {} };
    try {
      const backup = await runBackup({ session, connName: 'finta', db: 'origine', type: 'full', destRoot: root, log });
      for (const onlyCollections of [null, ['clienti']]) {
        const targetDb = onlyCollections ? 'selettivo' : 'completo';
        await runRestore({ session, backupDir: backup.backupDir, targetDb, onlyCollections, drop: true, log });
        const result = databases.get(targetDb);
        assert.strictEqual(result.size, onlyCollections ? 1 : 3);
        for (const [name, collection] of result) {
          assert.deepStrictEqual(collection.options, source.get(name).options);
          assert.deepStrictEqual(EJSON.serialize(collection.docs), source.get(name).docs);
        }
      }
    } finally {
      assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }],
  ['trasporto: timeout e risposta tardiva non ripetono richieste', async () => {
    const sent = [];
    let timer;
    const ctx = vm.createContext({
      socket: { emit(event, payload, ack) { sent.push({ event, payload, ack }); } },
      tabs: { list: [] }, activeTab: () => null, state: {}, toast() {},
      setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {},
    });
    const source = fs.readFileSync(path.join(__dirname, '../public/js/trasporto.js'), 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, ctx);
    const pending = vm.runInContext("emit('collection:import', {}, { timeoutMs: 1 })", ctx);
    const rejected = assert.rejects(pending, /esito da verificare/);
    timer();
    await rejected;
    sent[0].ack({ ok: false, error: 'Nessuna connessione attiva' });
    assert.strictEqual(sent.length, 1);
  }],
  ['evento import: ricevuta condivisa dopo riconnessione e lease rilasciato', async () => {
    const { createModule } = require('../server/eventi-dati');
    const register = createModule({ lock: { normTabId: (v) => v } });
    let writes = 0;
    let leases = 0;
    const strategy = { type: 'mongodb', async collectionImport() { writes++; return { inserted: 1, failed: 0 }; } };
    const sess = { connName: 'locale', strategy };
    const setup = () => {
      const handlers = new Map();
      register({ principal: { id: 'a', ownerId: 'o' }, sessions: new Map([['tab', sess]]) }, {
        delegate: (event, fn) => handlers.set(event, fn), operazioneLunga() {},
        acquisisciLeaseOperazione() { leases++; }, async rilasciaLeaseOperazione() { leases--; },
      });
      return handlers.get('collection:import');
    };
    const payload = { tabId: 'tab', db: 'db', coll: 'coll', batchId: 'blocco_1234567890', docs: [{ x: 1 }] };
    await setup()(strategy, payload);
    const response = await setup()(strategy, { ...payload, statusOnly: true });
    assert.strictEqual(response.inserted, 1);
    assert.strictEqual(response.status, 'completato');
    assert.strictEqual(writes, 1);
    assert.strictEqual(leases, 0);
  }],
  ['risposta persa: il client recupera la ricevuta senza duplicare', async () => {
    const { createImportBatchRegistry } = require('../db/importBatches');
    const { importaBlocco } = await import(require('url').pathToFileURL(path.join(__dirname, '../public/js/import-batch.js')).href);
    const registry = createImportBatchRegistry();
    let writes = 0;
    const requests = [];
    const send = async (_event, payload) => {
      requests.push(payload);
      const result = await registry.request(['owner', 'actor', 'conn', 'db', 'coll'], payload,
        async () => { writes++; return { inserted: 2, failed: 0, errors: [] }; });
      if (!payload.statusOnly) throw new Error('ack perso dopo INSERT');
      return result;
    };
    const result = await importaBlocco(send, { docs: [{ x: 1 }, { x: 2 }] }, { attesa: async () => {} });
    assert.strictEqual(result.inserted, 2);
    assert.strictEqual(writes, 1);
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[1].statusOnly, true);
    assert.strictEqual(requests[1].docs, undefined);
    assert.strictEqual(requests[0].batchId, requests[1].batchId);
  }],
  ['ricevute: concorrenza, isolamento e dati diversi', async () => {
    const { createImportBatchRegistry } = require('../db/importBatches');
    const registry = createImportBatchRegistry();
    const payload = { batchId: 'blocco_1234567890', docs: [{ x: 1 }] };
    let release;
    let writes = 0;
    const execute = async () => { writes++; await new Promise((resolve) => { release = resolve; }); return { inserted: 1 }; };
    const first = registry.request('a', payload, execute);
    const retry = registry.request('a', payload, execute);
    await Promise.resolve();
    assert.strictEqual(writes, 1);
    assert.strictEqual((await registry.request('a', { ...payload, statusOnly: true })).status, 'in_corso');
    assert.strictEqual((await registry.request('b', { ...payload, statusOnly: true })).status, 'sconosciuto');
    await assert.rejects(registry.request('a', { ...payload, docs: [{ x: 2 }] }, execute), /dati diversi/);
    release();
    assert.deepStrictEqual(await first, await retry);
    assert.strictEqual((await registry.request('a', payload, execute)).inserted, 1);
    assert.strictEqual(writes, 1);
  }],
  ['driver: una scrittura incerta non viene ripetuta riga per riga', async () => {
    for (const file of ['MySqlStrategy', 'PostgreSqlStrategy', 'MongoDbStrategy']) {
      const Strategy = require(`../db/${file}`);
      const strategy = new Strategy();
      const error = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
      let writes = 0;
      const fail = async () => { writes++; throw error; };
      strategy.pool = { query: fail };
      strategy.tableColumnsInfo = async () => ({ columns: [{ name: 'x' }], geo: new Map() });
      strategy.colonneScrivibili = async () => new Set(['x']);
      strategy.client = { db: () => ({ collection: () => ({ insertMany: fail }) }) };
      await assert.rejects(strategy.collectionImport('db', 'coll', { docs: [{ x: 1 }, { x: 2 }] }),
        (err) => err.importOutcomeUnknown === true, file);
      assert.strictEqual(writes, 1, file);
    }
  }],
  ['annullamento durante promozione: recupero eseguito', async () => {
    const controller = new AbortController();
    let restored = false;
    let signal;
    const plan = creaPianoImport({ artifact, connection: 'locale', targetDb: 'dest', drop: true });
    const result = await eseguiPianoImport(plan, { signal: controller.signal, adapter: {
      setSignal(next) { signal = next; },
      async validatePlan() {}, async destinationExists() { return true; },
      async createRecovery() { return { verified: true }; },
      async prepareStaging() { return { db: 'staging' }; }, async apply() {},
      async verify() { return { ok: true }; },
      async promote() { controller.abort(); throw new Error('promozione parziale'); },
      async restore() { assert(!signal || !signal.aborted); restored = true; },
    } });
    assert.strictEqual(restored, true, 'annullare non deve impedire il recupero');
    assert.strictEqual(result.status, 'ripristinato_dopo_errore');
  }],
  ['annullamento prima della promozione lascia intatta la destinazione', async () => {
    const controller = new AbortController();
    let mutations = 0;
    const plan = creaPianoImport({ artifact, connection: 'locale', targetDb: 'dest', drop: true });
    await eseguiPianoImport(plan, { signal: controller.signal, adapter: {
      async validatePlan() {}, async destinationExists() { return true; },
      async createRecovery() { return { verified: true }; },
      async prepareStaging() { return { db: 'stage' }; }, async apply() {},
      async verify() { controller.abort(); return { ok: true }; },
      async promote() { mutations++; }, async restore() { mutations++; },
    } });
    assert.strictEqual(mutations, 0);
  }],
  ['errori degli eventi MySQL propagati', async () => {
    await assert.rejects(mysqlSchemaObjects({ async query(sql) {
      if (sql.includes('information_schema.EVENTS')) throw new Error('lettura eventi negata');
      return [[]];
    } }, 'origine'), /lettura eventi negata/);
  }],
  ['DDL MySQL assente non equivale a oggetto assente', async () => {
    await assert.rejects(mysqlSchemaObjects({ async query(sql) {
      if (sql.includes('information_schema.ROUTINES')) return [[{ name: 'f', type: 'FUNCTION' }]];
      if (sql.startsWith('SHOW CREATE FUNCTION')) return [[{ 'Create Function': null }]];
      return [[]];
    } }, 'origine'), /f/);
  }],
  ['export interrotto se mancano indici e FK', async () => {
    let dataRead = false;
    const { context, notices } = frontend({ emit: async (event) => {
      if (event === 'db:collections') return { collections: [{ name: 'clienti' }] };
      if (event === 'database:schema-objects') return { objects: {} };
      if (event === 'collection:ddl') return { ddl: 'CREATE TABLE clienti (id INT)' };
      if (event === 'collection:identity') return { identity: null };
      if (event === 'collection:auxddl') throw new Error('metadati negati');
      if (event === 'collection:export') { dataRead = true; throw new Error('lettura dati'); }
      throw new Error(event);
    } });
    await vm.runInContext("exportDatabase('origine')", context);
    assert.strictEqual(dataRead, false, 'non si esportano dati dopo metadati persi');
    assert(notices.some((s) => s.includes('metadati negati')));
  }],
  ['opzioni MongoDB alla creazione dello staging', async () => {
    const collections = new Map();
    const options = { collation: { locale: 'it', strength: 2 } };
    const mongo = {
      async createCollection(name, opts = {}) { collections.set(name, opts); },
      listCollections() { return { async toArray() { return [...collections].map(([name, opts]) => ({ name, options: opts })); } }; },
      async command(command) { if (command.collation) throw new Error('collation non modificabile'); },
    };
    const strategy = {
      client: { db: () => mongo },
      async listDatabases() { return collections.size ? [{ name: 'staging' }] : []; },
      async listCollections() { return [...collections].map(([name]) => ({ name })); },
      async createDatabase(_db, first) { await mongo.createCollection(first); },
      async createCollection(_db, name, opts) { await mongo.createCollection(name, opts); },
      async collectionImport(_db, name, { docs }) {
        assert.deepStrictEqual(require('bson').EJSON.serialize(collections.get(name)), options,
          'la collation deve precedere le righe');
        return { inserted: docs.length, failed: 0 };
      },
    };
    const plan = creaPianoImport({ artifact: { ...artifact, objects: { collectionOptions: [{ name: 'clienti', options }] } },
      connection: 'locale', targetDb: 'dest', drop: true });
    const adapter = createImportArtifactAdapter({ strategy, dbType: 'mongodb', recoveryRoot: 'unused' });
    const staging = await adapter.prepareStaging(plan, null, false);
    await adapter.apply(plan, staging);
  }],
  ['import: risposta persa non significa righe fallite', async () => {
    const { importaBlocco } = await import(require('url').pathToFileURL(path.join(__dirname, '../public/js/import-batch.js')).href);
    const { context, nodes } = frontend({ emit: async () => { throw new Error('risposta persa'); },
      importaBlocco: (emit, payload) => importaBlocco(emit, payload, { attesa: async () => {}, tentativi: 1 }),
    });
    vm.runInContext(`
      importTarget = { db: 'origine', coll: 'clienti', dbType: 'mongodb',
        ctx: { tabId: 'tab-a', isStillActive: () => false } };
      $('#import-text').value = '[{"_id":1}]';
    `, context);
    await vm.runInContext('runImport()', context);
    assert.match(nodes.get('#import-report').innerHTML, /con esito incerto/i,
      'il report deve distinguere esito incerto da rifiuto certo');
  }],
];

module.exports = (async () => {
  for (const [name, run] of cases) {
    try { await run(); console.log('  OK  ', name); }
    catch (err) { console.error('  FAIL', name, err.message); process.exitCode = 1; }
  }
})();
