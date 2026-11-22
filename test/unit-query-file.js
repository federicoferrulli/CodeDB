'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contestoFinto, sessioneFinta } = require('./contesto-finto');

module.exports = (async () => {
  const {
    ACCEPT_QUERY_SQL, ACCEPT_QUERY_MONGO, ACCEPT_QUERY_TUTTI,
    acceptFileQuery, azioneApriFileQuery, acceptPerRipresaFile,
    estensioneSalvaQuery, nomeFileSalvaQuery, usaChunkingSql,
  } = await import('../public/js/query-file.js');
  const { SqlChunker } = await import('../public/js/sql-chunker.js');
  const { MAX_SQL_STATEMENT_BYTES } = await import('../public/js/sql-file-limits.mjs');

  // 1. Adattamento di accept ed etichetta al DBMS attivo
  assert.equal(acceptFileQuery('mysql'), ACCEPT_QUERY_SQL);
  assert.equal(acceptFileQuery('postgresql'), ACCEPT_QUERY_SQL);
  assert.equal(acceptFileQuery('postgres'), ACCEPT_QUERY_SQL);
  assert.equal(acceptFileQuery('mongodb'), ACCEPT_QUERY_MONGO);
  assert.equal(acceptFileQuery(''), ACCEPT_QUERY_TUTTI);

  const azioneSql = azioneApriFileQuery('mysql');
  assert.equal(azioneSql.label, 'Apri file SQL…');
  assert.equal(azioneSql.accept, ACCEPT_QUERY_SQL);

  const azioneMongo = azioneApriFileQuery('mongodb');
  assert.equal(azioneMongo.label, 'Apri file query…');
  assert.equal(azioneMongo.accept, ACCEPT_QUERY_MONGO);
  for (const ext of ['.js', '.mongodb', '.json', '.mql', '.sql', '.txt', '.queries']) {
    assert.ok(azioneMongo.accept.split(',').includes(ext), `MongoDB deve accettare ${ext}`);
  }

  // Ripresa dal registro dopo F5: conserva sempre l'estensione del file originale
  assert.ok(acceptPerRipresaFile('migrazione.mongodb', 'mongodb').includes('.mongodb'));
  assert.ok(acceptPerRipresaFile('pipeline.mql', '').includes('.mql'));
  assert.ok(acceptPerRipresaFile('custom.bsonjs', 'mysql').includes('.bsonjs'));

  // 2. Estensione e nome file per "Salva query…"
  assert.equal(estensioneSalvaQuery({ code: 'SELECT 1;', dbType: 'mysql' }), '.sql');
  assert.equal(estensioneSalvaQuery({ code: '{ "a": 1 }', dbType: 'postgresql' }), '.sql');
  assert.equal(estensioneSalvaQuery({ code: '{ "attivo": true }', dbType: 'mongodb' }), '.json');
  assert.equal(estensioneSalvaQuery({ code: '/* commento */\n[ { "$match": {} } ]', dbType: 'mongodb' }), '.json');
  assert.equal(estensioneSalvaQuery({ code: 'db.utenti.find({ attivo: true })', dbType: 'mongodb' }), '.js');
  assert.equal(estensioneSalvaQuery({ code: 'const n = 1; print(n);', dbType: 'mongodb' }), '.js');
  assert.equal(estensioneSalvaQuery({ code: '', dbType: 'mongodb' }), '.js');
  assert.equal(estensioneSalvaQuery({ code: 'SELECT * FROM utenti;', dbType: 'mongodb' }), '.sql');
  assert.equal(estensioneSalvaQuery({ code: '{ "a": 1 }', dbType: 'mongodb', engine: 'mongosh' }), '.js');
  assert.equal(estensioneSalvaQuery({ code: 'db.utenti.find({})', dbType: 'mongodb', engine: 'sql' }), '.sql');
  assert.equal(nomeFileSalvaQuery({ db: 'negozio', code: '[{"$limit": 5}]', dbType: 'mongodb' }), 'negozio.json');
  assert.equal(nomeFileSalvaQuery({ db: 'negozio', code: 'db.ordini.find()', dbType: 'mongodb' }), 'negozio.js');
  assert.equal(nomeFileSalvaQuery({ db: 'negozio', code: 'SELECT 1;', dbType: 'mongodb' }), 'negozio.sql');

  // 3. Decisione chunking SQL vs file intero (file > 1 MB)
  assert.equal(usaChunkingSql({ fileName: 'dump.sql', dbType: 'mysql' }), true);
  assert.equal(usaChunkingSql({ fileName: 'dump.js', dbType: 'postgresql' }), true);
  assert.equal(usaChunkingSql({ fileName: 'dump.sql', dbType: 'mongodb' }), true);
  for (const nome of ['migrazione.js', 'playground.mongodb', 'playground.mongodb.js', 'filtro.json', 'pipeline.mql']) {
    assert.equal(usaChunkingSql({ fileName: nome, dbType: 'mongodb' }), false, `${nome} su MongoDB non deve passare dallo splitter SQL`);
  }
  assert.equal(usaChunkingSql({ fileName: 'dump.sql', dbType: 'mongodb', engine: 'mongosh' }), false);
  assert.equal(usaChunkingSql({ fileName: 'note.txt', dbType: 'mongodb' }), null, 'Senza prefisso, .txt su MongoDB richiede ispezione iniziale');
  assert.equal(usaChunkingSql({ fileName: 'note.txt', dbType: 'mongodb', prefix: 'SELECT * FROM ordini;' }), true);
  assert.equal(usaChunkingSql({ fileName: 'note.txt', dbType: 'mongodb', prefix: 'for (let i = 0; i < 3; i++) { print(i); }' }), false);
  assert.equal(usaChunkingSql({ fileName: 'note.txt', dbType: 'mongodb', prefix: '[{ "$match": {} }]' }), false);

  // 4. SqlChunker in modalità file intero (splitStatements: false)
  const scriptJs = 'for (let i = 0; i < 3; i++) {\n  db.log.insertOne({ i, nota: "a;b" });\n}\n' + '// ' + 'x'.repeat(200 * 1024);
  const fakeJsFile = {
    name: 'seed.mongodb.js',
    size: Buffer.byteLength(scriptJs, 'utf8'),
    slice(start, end) { return new Blob([Buffer.from(scriptJs, 'utf8').subarray(start, end)]); },
  };
  const chunkerJs = new SqlChunker(fakeJsFile, 64 * 1024, 'mongodb', { splitStatements: false });
  await chunkerJs.init();
  assert.equal(chunkerJs.complete, true);
  assert.equal(chunkerJs.getChunkCount(), 1, 'Uno script JS MongoDB deve restare un unico blocco indivisibile');
  assert.equal(chunkerJs.getFileInfo().splitStatements, false);
  const blocco = await chunkerJs.readChunk(0);
  assert.equal(blocco.text, scriptJs);
  assert.equal(blocco.statements, 1);

  // Rifiuta file MongoDB non-SQL oltre il limite di 64 MiB senza leggere il disco
  let lettoOltreLimite = false;
  const troppoGrande = {
    name: 'enorme.js',
    size: MAX_SQL_STATEMENT_BYTES + 1,
    slice() { lettoOltreLimite = true; return new Blob([]); },
  };
  const chunkerTroppoGrande = new SqlChunker(troppoGrande, 1024 * 1024, 'mongodb', { splitStatements: false });
  await assert.rejects(() => chunkerTroppoGrande.init(), /supera il limite di 64 MB/);
  assert.equal(lettoOltreLimite, false, 'Oltre 64 MiB il rifiuto deve avvenire prima di leggere il file');

  // Rifiuta UTF-8 non valido anche in modalità file intero
  const badUtf8 = Buffer.from([0xff, 0xfe, 0x00]);
  const fakeBad = { name: 'rotto.json', size: badUtf8.length, slice(s, e) { return new Blob([badUtf8.subarray(s, e)]); } };
  await assert.rejects(() => new SqlChunker(fakeBad, 1024 * 1024, 'mongodb', { splitStatements: false }).init(), /UTF-8/);

  // 5. Server `script:execute`: un documento/pipeline JSON MongoDB con `\" ;` non viene spezzato sul `;`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-query-file-'));
  const server = require('../server/createServer').createServer({ config: { desktop: null, env: {
    CODEDB_RBAC: 'off', CODEDB_CONNECTIONS_FILE: path.join(root, 'connections.ini'),
    CODEDB_CONNECTIONS_DIR: path.join(root, 'conns'), CODEDB_BACKUPS_DIR: path.join(root, 'backups'),
    CODEDB_SCRIPT_RESULTS_DIR: path.join(root, 'results'),
    CODEDB_UI_AUDIT_FILE: path.join(root, 'ui.log'), CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } } });
  try {
    const ricevuti = [];
    const strategyMongo = {
      type: 'mongodb',
      currentDb: 'negozio',
      async collectionFind(db, coll, opts) {
        ricevuti.push({ kind: 'find', db, coll, filter: opts.filter });
        return { docs: [{ ok: 1 }], columns: ['ok'], total: 1 };
      },
      async collectionAggregate(db, coll, opts) {
        ricevuti.push({ kind: 'aggregate', db, coll, pipeline: opts.pipeline });
        return { docs: [{ ok: 2 }], columns: ['ok'], total: 1 };
      },
    };
    const sessions = new Map([['mongo', sessioneFinta({ strategy: strategyMongo, dbType: 'mongodb' })]]);
    const ctx = contestoFinto({ sessioni: [...sessions] });
    server.registraEventi(ctx);

    const filtro = '{ "nota": "ciao \\" ; mondo" }';
    const ackFiltro = await ctx.socket.chiama('script:execute', {
      tabId: 'mongo', db: 'negozio', coll: 'note', code: filtro, runId: 'mongo-json-filter',
    });
    assert.equal(ackFiltro.ok, true, ackFiltro.error);
    assert.equal(ackFiltro.total, 1, 'Il filtro JSON MongoDB con \\" e ; deve restare una sola istruzione');
    await sessions.get('mongo').scripts.get('mongo-json-filter').completion;
    assert.equal(ricevuti[0].kind, 'find');
    assert.equal(ricevuti[0].filter, filtro);

    const pipeline = '/* pipeline */\n[ { "$match": { "nota": "a\\" ; b" } } ]';
    const ackPipe = await ctx.socket.chiama('script:execute', {
      tabId: 'mongo', db: 'negozio', coll: 'note', code: pipeline, runId: 'mongo-json-pipeline',
    });
    assert.equal(ackPipe.ok, true, ackPipe.error);
    assert.equal(ackPipe.total, 1, 'La pipeline JSON MongoDB con \\" e ; deve restare una sola istruzione');
    await sessions.get('mongo').scripts.get('mongo-json-pipeline').completion;
    assert.equal(ricevuti[1].kind, 'aggregate');
    assert.match(ricevuti[1].pipeline, /\$match/);
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('  OK   Adattamento file query SQL/MongoDB, salvataggio, chunker file intero e JSON server superati');
})().catch((err) => { console.error(err); process.exitCode = 1; });
