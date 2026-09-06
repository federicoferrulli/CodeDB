'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { createServer } = require('../server');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');
const { giuntura } = require('./server-fixture');
const { ROOT_PRINCIPAL } = require('../auth/principal');

function differita() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function get(server, route = '/handshake-check') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: route }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

module.exports = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-modulare-'));
  const servers = [];
  function instance(name, env = {}, dependencies = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const server = createServer({
      config: { desktop: null, env: {
        HOST: '127.0.0.1', PORT: 0, CODEDB_PUBLIC_BIND: '127.0.0.1',
        CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '',
        CODEDB_CONNECTIONS_FILE: path.join(dir, 'connections.ini'),
        CODEDB_CONNECTIONS_DIR: path.join(dir, 'conns'),
        CODEDB_BACKUPS_DIR: path.join(dir, 'backups'),
        CODEDB_SCRIPT_RESULTS_DIR: path.join(dir, 'results'),
        CODEDB_UI_AUDIT_FILE: path.join(dir, 'ui.log'),
        CODEDB_MCP_AUDIT_FILE: path.join(dir, 'mcp.log'),
        ...env,
      } }, dependencies,
    });
    servers.push(server);
    return server;
  }
  async function prova(nome, fn) {
    await fn();
    console.log('  OK   Server modulare: ' + nome);
  }
  try {
    await prova('informazioni licenza delle dipendenze installate', async () => {
      const { datiLicenza } = require('../server/informazioni').createModule({
        config: { rootDir: path.resolve(__dirname, '..') },
      });
      const elenco = datiLicenza().dipendenze;
      for (const nome of Object.keys(require('../package.json').dependencies)) {
        const voce = elenco.find(d => d.nome === nome);
        assert(voce && voce.versione && voce.licenza !== '—', `Metadati mancanti: ${nome}`);
      }
    });
    await prova('indici RBAC su un database vuoto e propagazione degli errori reali', async () => {
      const { AppStore } = require('../auth/AppStore');
      const store = new AppStore({ uri: '', dbName: 'test' });
      let errore = Object.assign(new Error('collezione assente'), { code: 26 });
      let indicePreferenze = false;
      store.db = { collection: name => ({
        async dropIndex() { throw errore; },
        async createIndex() { if (name === 'prefs') indicePreferenze = true; },
      }) };
      await store.ensureIndexes();
      assert(indicePreferenze);
      errore = new Error('permesso negato');
      await assert.rejects(store.ensureIndexes(), /permesso negato/);
    });

    await prova('tetti delle strategie indipendenti dalla configurazione globale', async () => {
      const { conTetti } = require('../db/tetti');
      const DbFactory = require('../db/DbFactory');
      const rows = [{ valore: 'a'.repeat(1200) }, { valore: 'b'.repeat(1200) }];
      for (const type of ['mongodb', 'mysql', 'postgresql']) {
        const a = DbFactory.getStrategy(type, { env: { CODEDB_MAX_RESULT_BYTES: '1600' } });
        const b = DbFactory.getStrategy(type, { env: { CODEDB_MAX_RESULT_BYTES: '6000' } });
        a.collectionFind = b.collectionFind = async () => ({ docs: rows });
        assert.strictEqual((await conTetti(a).collectionFind('db', 'coll', {})).docs.length, 1);
        assert.strictEqual((await conTetti(b).collectionFind('db', 'coll', {})).docs.length, 2);
      }
    });

    await prova('stop attende il login accettato prima di chiudere il control plane', async () => {
      const ready = differita();
      const gate = differita();
      let closed = false;
      const s = instance('login-pendente', { CODEDB_RBAC: 'on' }, {
        AppStore: class {
          async connect() {}
          async close() { closed = true; }
          async createSession() { assert(!closed); return 'token'; }
          async principalFor() { return ROOT_PRINCIPAL; }
        },
        createEntitlementProvider: () => ({
          bootstrap: async () => ({ email: 'test@locale' }),
          async verifyOwner() { ready.resolve(); await gate.promise; return ROOT_PRINCIPAL; },
        }),
      });
      await s.start();
      const request = new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: s.server.address().port,
          path: '/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
          let body = ''; res.on('data', c => { body += c; });
          res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject); req.end('{}');
      });
      await ready.promise;
      const stop = s.stop();
      assert.strictEqual(closed, false);
      gate.resolve();
      assert.strictEqual((await request).token, 'token');
      await stop; assert.strictEqual(closed, true);
    });

    await prova('due istanze ascoltano su porte distinte senza installare listener globali', async () => {
      const prima = process.listenerCount('SIGTERM');
      const a = instance('a');
      const b = instance('b');
      assert.strictEqual(a.server.listening, false);
      const start = a.start();
      assert.strictEqual(a.start(), start, 'avvii concorrenti condividono la stessa Promise');
      await Promise.all([start, b.start()]);
      assert.strictEqual(await a.start(), a);
      assert.notStrictEqual(a.server.address().port, b.server.address().port);
      assert.strictEqual(process.listenerCount('SIGTERM'), prima);
      assert.strictEqual(JSON.parse((await get(a.server)).body).app, 'codedb');
      const stop = a.stop();
      assert.strictEqual(a.stop(), stop);
      await stop;
      assert.strictEqual((await get(b.server)).status, 200, 'la seconda istanza resta viva');
      await assert.rejects(a.start(), /arrestato/);
    });

    await prova('script reali conservano i risultati per istanza e li eliminano alla chiusura', async () => {
      const a = instance('script-a');
      const b = instance('script-b');
      await Promise.all([a.start(), b.start()]);
      const crea = valore => sessioneFinta({ dbType: 'mysql', strategy: {
        type: 'mysql', async disconnect() {},
        async collectionAggregate() { return { docs: [{ valore }], columns: ['valore'], resultSet: true }; },
      } });
      const sa = crea('istanza-a'); const sb = crea('istanza-b');
      const ca = contestoFinto({ sessioni: [['tab', sa]] });
      const cb = contestoFinto({ sessioni: [['tab', sb]] });
      a.registraEventi(ca); b.registraEventi(cb);
      for (const ctx of [ca, cb]) {
        const res = await ctx.socket.chiama('script:execute', {
          tabId: 'tab', runId: 'stesso-id', db: 'test', engine: 'mysql', code: 'SELECT 1; SELECT 2;',
        });
        assert(res.ok, res.error);
        const run = ctx.sessions.get('tab').scripts.get('stesso-id');
        await run.completion;
        assert.strictEqual(run.status, 'done');
        assert.strictEqual(run.deposito.schede, 2);
      }
      const leggi = ctx => ctx.socket.chiama('script:result', { tabId: 'tab', runId: 'stesso-id', pos: 0 });
      const prima = await leggi(ca); const seconda = await leggi(cb);
      assert(prima.ok && seconda.ok);
      assert(JSON.stringify(prima).includes('istanza-a'));
      assert(!JSON.stringify(seconda).includes('istanza-a'));
      await a.stop();
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'script-a', 'results')), []);
      assert.strictEqual((await leggi(cb)).ok, true);
    });

    await prova('UI e MCP condividono la quota e rilasciano tutte le connessioni', async () => {
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      let vive = 0;
      const s = instance('quota', {}, { DbFactory: {
        ...require('../db/DbFactory'),
        getStrategy: () => ({ type: 'mongodb', async connect() { vive++; },
          async disconnect() { vive--; }, async listDatabases() { return []; },
        }),
      } });
      await s.start();
      const contesti = Array.from({ length: 13 }, () => contestoFinto());
      for (const ctx of contesti) s.registraEventi(ctx);
      const saved = await contesti[0].socket.chiama('connections:save', { name: 'finta', cfg: { dbType: 'mongodb', host: 'localhost' } });
      assert(saved.ok, saved.error);
      for (let i = 0; i < 100; i++) {
        const res = await contesti[Math.floor(i / 8)].socket.chiama('mongo:connect', { saved: 'finta', tabId: String(i) });
        assert(res.ok, res.error);
      }
      const client = new Client({ name: 'quota-test', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.server.address().port}/mcp`)));
        const bloccato = await client.callTool({ name: 'connect_database', arguments: { saved: 'finta' } });
        assert.strictEqual(bloccato.isError, true);
        assert.match(JSON.stringify(bloccato), /limite globale/);
        await contesti[0].socket.chiama('mongo:disconnect', { tabId: '0' });
        await contesti[0].socket.chiama('mongo:disconnect', { tabId: '0' });
        const aperto = await client.callTool({ name: 'connect_database', arguments: { saved: 'finta' } });
        assert(!aperto.isError, JSON.stringify(aperto));
        assert.strictEqual(vive, 100, 'il doppio disconnect non libera una quota aggiuntiva');
        let scadenza;
        try { await Promise.race([s.stop(), new Promise((_r, reject) => { scadenza = setTimeout(() => reject(new Error('Arresto bloccato con un client MCP attivo')), 3000); })]); }
        finally { clearTimeout(scadenza); }
        assert.strictEqual(vive, 0, 'stop chiude sia le strategie UI sia quelle MCP');
      } finally { await client.close(); }
    });

    await prova('connessioni salvate, passphrase, upload e audit non attraversano le istanze', async () => {
      const a = instance('vault-a');
      const b = instance('vault-b');
      await Promise.all([a.start(), b.start()]);
      const ca = contestoFinto();
      const cb = contestoFinto();
      a.registraEventi(ca); b.registraEventi(cb);
      const saved = await ca.socket.chiama('connections:save', {
        name: 'privata', cfg: { dbType: 'mongodb', host: 'localhost', password: 'segreto-a' },
      });
      assert(saved.ok, saved.error);
      assert.strictEqual((await cb.socket.chiama('connections:list')).connections.length, 0);
      const change = await ca.socket.chiama('vault:setPassphrase', { current: '', next: 'passphrase-istanza-a' });
      assert(change.ok, change.error);
      assert.notDeepStrictEqual(await ca.socket.chiama('vault:status'), await cb.socket.chiama('vault:status'));
      const sa = sessioneFinta({ strategy: { type: 'mongodb' } });
      const sb = sessioneFinta({ strategy: { type: 'mongodb' } });
      ca.sessions.set('tab', sa); cb.sessions.set('tab', sb);
      const upload = await ca.socket.chiama('database:import:upload:start', { tabId: 'tab' });
      assert(upload.ok, upload.error);
      const stolen = await cb.socket.chiama('database:import:upload:chunk', {
        tabId: 'tab', uploadId: upload.uploadId, index: 0, chunk: '{}',
      });
      assert.strictEqual(stolen.ok, false);
      await Promise.all([a.stop(), b.stop()]);
      const logA = fs.readFileSync(path.join(root, 'vault-a/ui.log'), 'utf8');
      assert(logA.includes('connections:save'));
      assert(!fs.existsSync(path.join(root, 'vault-b/ui.log')) || !fs.readFileSync(path.join(root, 'vault-b/ui.log'), 'utf8').includes('connections:save'));
      assert(!fs.readFileSync(path.join(root, 'vault-a/connections.ini'), 'utf8').includes('segreto-a'));
    });

    await prova('porta occupata e inizializzazione fallita rigettano e rilasciano le risorse', async () => {
      const occupante = instance('occupante');
      await occupante.start();
      const collisione = instance('collisione', { PORT: occupante.server.address().port });
      await assert.rejects(collisione.start(), { code: 'EADDRINUSE' });
      await collisione.stop();
      let closed = 0;
      const fallito = instance('fallito', { CODEDB_RBAC: 'on' }, {
        AppStore: class {
          async connect() { throw new Error('control plane guasto'); }
          async close() { closed++; }
        },
      });
      await assert.rejects(fallito.start(), /control plane guasto/);
      await fallito.stop();
      assert.strictEqual(closed, 1);
      assert.strictEqual(fallito.server.listening, false);
      assert.strictEqual((await get(occupante.server)).status, 200);
    });

    await prova('arresto durante l’avvio attende l’inizializzazione senza lasciare un listener', async () => {
      const gate = differita();
      const ready = differita();
      const s = instance('stop-avvio', {}, { ScriptResults: {
        async puliziaVecchi() { ready.resolve(); await gate.promise; },
      } });
      const start = s.start();
      await ready.promise;
      const stop = s.stop();
      gate.resolve();
      await Promise.all([start, stop]);
      assert.strictEqual(s.server.listening, false);
      await assert.rejects(s.start(), /arrestato/);
    });

    await prova('la rivalidazione concorrente attende una sola verifica e applica i nuovi grant', async () => {
      let time = 0;
      let calls = 0;
      const gate = differita();
      const ctx = contestoFinto();
      let executions = 0;
      const socket = giuntura([(_ctx, lifecycle) => lifecycle.safeOn('prova', (_p, cb, current) => {
        executions++; cb({ ok: true, id: current.principal.id });
      })], {
        now: () => time,
        config: { env: { CODEDB_REVALIDATE_PRINCIPAL_MS: 100 }, rbacOn: () => true },
        identita: { resolvePrincipalFromToken: () => { calls++; return gate.promise; } },
      });
      socket.registraEventi(ctx);
      time = 101;
      const a = ctx.socket.chiama('prova');
      const b = ctx.socket.chiama('prova');
      await Promise.resolve();
      assert.strictEqual(executions, 0, 'nessun evento supera la verifica in corso');
      assert.strictEqual(calls, 1);
      gate.resolve({ ...ROOT_PRINCIPAL, id: 'aggiornato' });
      assert.deepStrictEqual(await Promise.all([a, b]), [{ ok: true, id: 'aggiornato' }, { ok: true, id: 'aggiornato' }]);
      await socket.close();
    });

    await prova('errore di rivalidazione produce ack e non rende valida la cache', async () => {
      let time = 0;
      let calls = 0;
      const ctx = contestoFinto();
      const s = giuntura([(_ctx, lifecycle) => lifecycle.safeOn('prova', (_p, cb) => cb({ ok: true }))], {
        now: () => time,
        config: { env: { CODEDB_REVALIDATE_PRINCIPAL_MS: 100 }, rbacOn: () => true },
        identita: { resolvePrincipalFromToken: async () => { calls++; throw new Error('verifica indisponibile'); } },
      });
      s.registraEventi(ctx); time = 101;
      for (let i = 0; i < 2; i++) {
        const result = await ctx.socket.chiama('prova');
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /verifica indisponibile/);
      }
      assert.strictEqual(calls, 2);
      await s.close();
    });

    await prova('ack monouso, payload non oggetto e handler duplicati', async () => {
      let count = 0;
      const ctx = contestoFinto();
      const s = giuntura([(_ctx, l) => l.safeOn('prova', (_p, cb) => { cb({ ok: true }); cb({ ok: false }); })]);
      s.registraEventi(ctx);
      await ctx.socket.handler.get('prova')[0]({}, () => { count++; });
      assert.strictEqual(count, 1);
      for (const payload of [true, 42, [], 'testo']) assert.strictEqual((await ctx.socket.chiama('prova', payload)).ok, false);
      const duplicate = giuntura([(_ctx, l) => { l.safeOn('prova', () => {}); l.safeOn('prova', () => {}); }]);
      assert.throws(() => duplicate.registraEventi(contestoFinto()), /già registrato/);
      await s.close();
    });

    await prova('arresto attende un handler accettato e rifiuta i nuovi', async () => {
      const gate = differita();
      const ready = differita();
      const ctx = contestoFinto();
      const s = giuntura([(_ctx, l) => l.safeOn('prova', async (_p, cb) => { ready.resolve(); await gate.promise; cb({ ok: true }); })]);
      s.registraEventi(ctx);
      const work = ctx.socket.chiama('prova');
      await ready.promise;
      s.beginShutdown();
      let drained = false;
      const drain = s.drain().then(() => { drained = true; });
      assert.strictEqual((await ctx.socket.chiama('prova')).ok, false);
      assert.strictEqual(drained, false);
      gate.resolve(); await work; await drain; await s.close();
    });

    await prova('chiusura driver sincrona fallita libera comunque il tunnel', async () => {
      const conn = require('../server/connessioni').createModule({});
      let closed = false;
      await conn.teardownConnection({ strategy: { disconnect() { throw new Error('driver chiuso'); } }, tunnel: { async close() { closed = true; } } });
      assert(closed);
    });

    await prova('apertura fallita chiude driver parziale e attende il tunnel', async () => {
      let disconnected = false;
      let tunnelClosed = false;
      const conn = require('../server/connessioni').createModule({
        vault: { preserveConnSecrets: cfg => cfg, connDbType: () => 'mongodb', sshEnabled: () => true },
        dependencies: {
          DbFactory: { defaultPort: () => 27017, getStrategy: () => ({
            async connect() { throw new Error('apertura fallita'); },
            async disconnect() { disconnected = true; },
          }) },
          openSshTunnel: async () => ({ host: '127.0.0.1', port: 1234,
            async close() { await new Promise(resolve => setImmediate(resolve)); tunnelClosed = true; },
          }),
        },
      });
      await assert.rejects(conn.establishConnection({ host: 'destinazione' }), /apertura fallita/);
      assert(disconnected, 'il driver parzialmente aperto viene chiuso');
      assert(tunnelClosed, 'la chiusura del tunnel termina prima del rigetto');
    });

    await prova('listener del processo idempotenti e rimovibili', async () => {
      const emitter = new EventEmitter();
      const lifecycle = require('../server/processo').creaProcesso(() => ({}), emitter);
      const remove = lifecycle.registerGlobalExceptionHandlers();
      lifecycle.registerGlobalExceptionHandlers();
      assert.strictEqual(emitter.listenerCount('SIGTERM'), 1);
      remove(); assert.strictEqual(emitter.listenerCount('SIGTERM'), 0);
    });
  } finally {
    await Promise.allSettled(servers.map(s => s.stop()));
    // La directory è quella creata da questa fixture, mai un percorso del chiamante.
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
