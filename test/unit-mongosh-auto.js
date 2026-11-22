'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { richiedeMongoshNativo } = require('../db/mongoshRouting');
const { eseguiScript } = require('../db/MongoScriptRunner');
const { preamboloMongosh } = require('../db/exportMongoScript');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');

module.exports = (async () => {
  // 1. Classificazione `richiedeMongoshNativo` (zero falsi positivi, zero falsi negativi)
  const exportScript = preamboloMongosh({
    sourceDb: 'gestione_presenze_db',
    opzioniMongo: { documenti: 'mantieni' },
  }) + '  await scrivi("presenze", bson("{\\"_id\\":{\\"$oid\\":\\"507f1f77bcf86cd799439011\\"}}"));\n})();\n';
  assert.equal(richiedeMongoshNativo(exportScript), true, 'Lo script esportato da CodeDB deve essere instradato a mongosh');
  assert.equal(richiedeMongoshNativo('(async () => {\n  const m = new Map([["a", 1]]);\n  const x = { ...({ a: 1 }) };\n})();'), true);
  assert.equal(richiedeMongoshNativo('rs.status()'), true);
  assert.equal(richiedeMongoshNativo('sh.status()'), true);
  assert.equal(richiedeMongoshNativo('db.eventi.watch()'), true);
  assert.equal(richiedeMongoshNativo('show collections'), true);
  assert.equal(richiedeMongoshNativo('const [a, b] = [1, 2]; print(a, b);'), true);
  assert.equal(richiedeMongoshNativo('process.cwd()'), true);

  // NON devono attivare mongosh: SQL, JSON, USE, comandi semplici, script sandbox, errori di sintassi reali
  for (const normale of [
    '',
    'SELECT * FROM utenti WHERE attivo = true;',
    'INSERT INTO utenti (nome) VALUES (\'Ada\');',
    'USE negozio;',
    '{ "stato": "aperto" }',
    '[{ "$match": { "stato": "aperto" } }]',
    'db.utenti.find({ stato: "aperto" })',
    'const x = 1; db.utenti.insertOne({ x }); print(x);',
    'const err = { a: [10] }; print(err.a?.[0], Object.hasOwn(err, "a"));',
    'const doc = EJSON.parse(\'{"_id":{"$oid":"507f1f77bcf86cd799439011"}}\', { relaxed: false }); print(doc._id);',
    'const rs = { status: () => 1 }; print(rs.status());',
    'db.utenti.find({ eta:', // errore di sintassi reale: NON deve passare a mongosh
  ]) {
    assert.equal(richiedeMongoshNativo(normale), false, `Non deve richiedere mongosh: ${normale}`);
  }

  // 2. Interprete controllato: optional chaining (?.), Object.hasOwn, EJSON
  const eseguito = await eseguiScript(`
    const esito = { writeErrors: [{ code: 11000, keyPattern: { _id: 1 }, errmsg: 'dup' }] };
    const vuoto = {};
    const fn = x => x * 2;
    const nulla = null;
    const a = esito.writeErrors?.[0]?.keyPattern?._id;
    const b = vuoto.writeErrors?.[0]?.keyPattern.inesistente;
    const c = fn?.(21);
    const d = nulla?.(21);
    const e = true ? .5 : 1;
    const f = Object.hasOwn(esito, 'writeErrors');
    const g = Object.hasOwn(esito, '__proto__');
    const doc = EJSON.parse('{"_id":{"$oid":"507f1f77bcf86cd799439011"},"n":{"$numberLong":"42"}}', { relaxed: false });
    const roundtrip = EJSON.stringify(doc, { relaxed: false });
    print(a, b, c, d, e, f, g, roundtrip);
  `, {}, { db: 'test' });
  assert.equal(
    eseguito.output[0],
    '1 undefined 42 undefined 0.5 true false {"_id":{"$oid":"507f1f77bcf86cd799439011"},"n":{"$numberLong":"42"}}'
  );
  await assert.rejects(() => eseguiScript('const o = {}; o?.x = 1;', {}, { db: 'test' }), /Assegnamento a un bersaglio non valido/);

  // 3. Auto-instradamento end-to-end su server (query:execute e script:execute) + confine RBAC
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-mongosh-auto-'));
  const server = require('../server/createServer').createServer({ config: { desktop: null, env: {
    CODEDB_RBAC: 'off', CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'),
    CODEDB_CONNECTIONS_DIR: path.join(root, 'conns'), CODEDB_BACKUPS_DIR: path.join(root, 'backups'),
    CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: path.join(root, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } } });
  try {
    const chiamateMongosh = [];
    const chiamateSandbox = [];
    const fakeMongosh = {
      closed: false,
      closing: null,
      async evaluate(code, db) {
        chiamateMongosh.push({ code, db });
        return { docs: [{ instradato: 'mongosh' }], scriptOutput: ['ok'], activeDb: db, runtime: 'mongosh' };
      },
      async close() { this.closed = true; },
    };
    const strategyMongo = {
      type: 'mongodb',
      uri: 'mongodb://127.0.0.1:27017',
      currentDb: 'gestione_presenze_db',
      async collectionFind(db, coll, opts) {
        chiamateSandbox.push({ db, coll, opts });
        return { docs: [{ ok: 1 }], columns: ['ok'], total: 1 };
      },
    };
    const sessAdmin = sessioneFinta({ strategy: strategyMongo, dbType: 'mongodb' });
    sessAdmin.mongosh = fakeMongosh;
    const sessViewer = sessioneFinta({ strategy: strategyMongo, dbType: 'mongodb' });
    sessViewer.principal = { email: 'viewer@local', owner: false, root: false, grants: [] };

    const sessions = new Map([['admin', sessAdmin], ['viewer', sessViewer]]);
    const ctx = contestoFinto({ sessioni: [...sessions] });
    server.registraEventi(ctx);

    // 3a. Admin + engine: 'auto' + export mongosh (via script:execute come fa la UI!) -> instrada automaticamente a mongosh
    const ackAuto = await ctx.socket.chiama('script:execute', {
      tabId: 'admin', db: 'gestione_presenze_db', engine: 'auto', code: exportScript, runId: 'auto-export-1',
    });
    assert.equal(ackAuto.ok, true, ackAuto.error);
    assert.equal(ackAuto.total, 1);
    const run = sessions.get('admin').scripts.get('auto-export-1');
    await run.completion;
    assert.equal(run.falliti, 0, JSON.stringify(run.results));
    assert.equal(chiamateMongosh.length, 1, 'In modalità Auto lo script export deve essere instradato a mongosh');
    assert.equal(chiamateMongosh[0].code, exportScript.trim());

    // 3b. Admin + engine: 'auto' + script semplice sandbox -> NON usa mongosh
    const resNormale = await ctx.socket.chiama('query:execute', {
      tabId: 'admin', db: 'gestione_presenze_db', coll: 'note', engine: 'auto', code: 'db.note.find({ a: 1 })',
    });
    assert.equal(resNormale.ok, true, resNormale.error);
    assert.equal(chiamateMongosh.length, 1, 'Una find ordinaria non deve attivare mongosh');
    assert.equal(chiamateSandbox.length, 1);

    // 3c. Utente NON admin sotto RBAC + engine: 'auto' + codice mongosh -> bloccato dal confine di sicurezza
    const resBloccato = await ctx.socket.chiama('query:execute', {
      tabId: 'viewer', db: 'gestione_presenze_db', engine: 'auto', code: 'process.cwd()',
    });
    assert.equal(resBloccato.ok, false);
    assert.match(resBloccato.error, /amministratore dell.installazione/);
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('  OK   Auto-instradamento mongosh, confine RBAC, optional chaining (?.), Object.hasOwn ed EJSON superati');
})().catch((err) => { console.error(err); process.exitCode = 1; });
