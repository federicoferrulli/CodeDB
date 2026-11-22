'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Long, EJSON } = require('bson');
const { creaPianoExport } = require('../db/exportPlan');
const { esportaDatabase, insertSql, scritturaRighe, statement } = require('../db/databaseExport');
const { creaFileExport } = require('../db/exportFile');
const { createArchivioUpload } = require('../db/uploadDisco');
const { preparaTabelle, seRichiesto, seAssenteMySql } = require('../db/exportSqlTabelle');
const { quotaSempre } = require('../db/identificatori');

function verificaStrutturaCondizionale() {
  for (const dbType of ['postgresql', 'mysql']) {
    const mysql = dbType === 'mysql';
    const q = n => quotaSempre(n, dbType);
    const literal = v => require('../db/databaseExport').letterale(v, mysql);
    const nome = mysql ? 'con`apice' : 'con"apice';
    const tables = [
      { nome, struttura: true },
      { nome: 'richiesta_dalla_vista', struttura: true, aggiuntoPerDipendenza: true },
      { nome: 'solo_dati', dati: true },
    ];
    const plan = { dbType, sourceDb: 'schema', ordine: { creazione: [] }, oggetti: tables, opzioniSql: {} };
    const prepara = tabelle => {
      plan.opzioniSql.tabelle = tabelle;
      return preparaTabelle({ plan, tables, objects: { views: [] }, q, literal });
    };
    assert.deepStrictEqual(prepara('crea').preambolo, []);
    const condizionale = prepara('se-assente');
    assert.deepStrictEqual([...condizionale.nuove.keys()], [nome, 'richiesta_dalla_vista']);
    assert(!condizionale.preambolo.join('').includes('DROP TABLE'));
    const ricrea = prepara('ricrea');
    const drops = ricrea.preambolo.filter(sql => sql.startsWith('DROP TABLE'));
    assert.deepStrictEqual(drops, ['DROP TABLE IF EXISTS ' + q('schema') + '.' + q(nome) + ';\n']);
    assert.deepStrictEqual([...ricrea.nuove.keys()], ['richiesta_dalla_vista']);
    const flag = condizionale.nuove.get(nome);
    const ddl = seRichiesto('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES p(id)', flag, { mysql, literal, statement });
    assert(ddl.includes(flag), 'il vincolo segue la creazione effettiva della tabella');
  }
  assert.match(seAssenteMySql('CREATE DEFINER=`TRIGGER`@`localhost` TRIGGER `t` BEFORE INSERT ON a FOR EACH ROW SET NEW.n=1'),
    /@`localhost` TRIGGER IF NOT EXISTS `t`/);
}

function fixture(modalita, selezione) {
  const plan = creaPianoExport({ connection: 'locale', formato: 'codedb-json', modalita, selezione,
    catalogo: { db: 'demo', dbType: 'mongodb', oggetti: [
      { tipo: 'collection', nome: 't' }, { tipo: 'vista', nome: 'esclusa' },
    ], dipendenze: [] } });
  let reads = 0;
  const collection = {
    indexes: async () => [{ name: '_id_', key: { _id: 1 } }, { name: 'ttl', key: { data: 1 }, expireAfterSeconds: 60 }],
    countDocuments: async () => 1,
    estimatedDocumentCount: async () => 1,
    find() { reads++; return { batchSize() { return this; }, async close() {},
      async *[Symbol.asyncIterator]() { yield { _id: 1, n: Long.fromString('9007199254740993') }; } }; },
  };
  const strategy = { client: { db: () => ({ collection: () => collection,
    listCollections: () => ({ toArray: async () => [
      { name: 't', type: 'collection', options: { validator: { n: { $exists: true } } } },
      { name: 'esclusa', type: 'view', options: { viewOn: 't', pipeline: [] } },
    ] }),
  }) } };
  return { plan, strategy, collection, reads: () => reads };
}

function verificaStrutturaMongo() {
  const { strutturaMongosh } = require('../db/exportMongoStruttura');
  const t = { id: 'collection:t', tipo: 'collection', nome: 't', struttura: false, dati: true };
  const plan = { oggetti: [t], ordine: { creazione: [] }, opzioniMongo: { documenti: 'aggiorna' } };
  const catalogoMongo = new Map([['t', { type: 'timeseries' }]]);
  const crea = () => strutturaMongosh({ plan, tables: [t], meta: new Map(), catalogoMongo,
    espressioneBson: bytes => EJSON.stringify(require('bson').deserialize(bytes)) });
  assert.throws(crea, /time-series/, 'lo script di upsert non può aggiornare misure per _id');
  catalogoMongo.set('t', { type: 'view' });
  assert.throws(crea, /tipo/, 'un nome diventato una vista richiede un nuovo piano');
  catalogoMongo.set('t', { type: 'collection', options: { encryptedFields: {} } });
  assert.throws(crea, /Queryable Encryption/);
}

module.exports = (async () => {
  verificaStrutturaCondizionale();
  verificaStrutturaMongo();
  for (const mode of ['solo-struttura', 'solo-dati', 'personalizzata']) {
    const f = fixture(mode, mode === 'personalizzata' ? { 'collection:t': { struttura: true, dati: true } } : null);
    let text = '';
    await esportaDatabase({ ...f, write: part => { text += part; } });
    const artifact = JSON.parse(text);
    assert.strictEqual(artifact.collections.length, 1, 'anche una collection solo struttura deve esistere nel file');
    assert.strictEqual(artifact.collections[0].docs.length, mode === 'solo-struttura' ? 0 : 1);
    assert.strictEqual(f.reads(), mode === 'solo-struttura' ? 0 : 1, 'solo struttura non legge i documenti');
    assert.strictEqual(artifact.objects.views.length, mode === 'solo-struttura' ? 1 : 0);
    assert.strictEqual(artifact.collections[0].indexes === null, mode === 'solo-dati');
    if (mode !== 'solo-struttura') assert.strictEqual(require('bson').deserialize(require('../db/mongoBson').decode(artifact.collections[0].docs[0]), { promoteLongs: false }).n.toString(), '9007199254740993');
  }
  const broken = fixture('struttura-e-dati');
  broken.collection.indexes = async () => { throw new Error('listIndexes negato'); };
  await assert.rejects(esportaDatabase({ ...broken, write() {} }), /listIndexes negato/);
  const truncated = fixture('struttura-e-dati');
  truncated.collection.countDocuments = async () => 2;
  await assert.rejects(esportaDatabase({ ...truncated, write() {} }), /conteggio cambiato/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-export-test-'));
  const archivio = createArchivioUpload({ radicePer: () => root, maxBytes: 10, maxChunkBytes: 128 });
  try {
    const f = fixture('struttura-e-dati');
    const { manifest } = await creaFileExport({ ...f, archivio, ownerId: 'owner', actorId: 'actor' });
    assert(manifest.dimensione > 10, 'l’export supera il limite degli upload, anche su più blocchi');
    assert.strictEqual(JSON.parse(fs.readFileSync(archivio.percorsoDati(manifest.id, 'owner').file, 'utf8')).collections.length, 1);
    const guasto = fixture('struttura-e-dati');
    guasto.collection.find = () => { throw new Error('Lettura interrotta'); };
    await assert.rejects(creaFileExport({ ...guasto, archivio, ownerId: 'owner', actorId: 'actor' }), /Lettura interrotta/);
    const bson = require('bson');
    const raw = bson.serialize({ _id: 1, x: 2, y: 3 });
    raw[bson.onDemand.parseToElements(raw).at(-1)[1]] = 'x'.charCodeAt(0); // due campi con lo stesso nome
    const ambiguo = fixture('solo-dati');
    ambiguo.collection.find = () => ({ batchSize() { return this; }, async close() {},
      async *[Symbol.asyncIterator]() { yield raw; } });
    const piano = creaPianoExport({ connection: 'test', formato: 'mongosh', modalita: 'solo-dati',
      catalogo: { db: 'demo', dbType: 'mongodb', oggetti: [{ tipo: 'collection', nome: 't' }], dipendenze: [] } });
    await assert.rejects(creaFileExport({ ...ambiguo, plan: piano, archivio, ownerId: 'owner', actorId: 'actor' }), /rappresentare fedelmente.*\.codedb\.json/);
    assert.strictEqual(archivio.elenca('owner').length, 1, 'un export fallito non pubblica file parziali');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'caricamenti')), [], 'i parziali vengono rimossi');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  await verificaExportServer();
  const info = { columns: [], geo: new Map(), geoNativo: new Map() };
  assert(insertSql('mysql', '`t`', JSON.stringify({ v: "$&'\\\n" }), info).includes('CONVERT(X\''));
  const cols = [{ name: 'ID', identity: 'a' }, { name: 'con"to' }, { name: 'd`ato' }, { name: 'doppio', generated: 's' }];
  const riga = JSON.stringify({ ID: 10, 'con"to': 2, 'd`ato': 7 });
  info.columns = cols;
  info.scrittura = scritturaRighe('postgresql', 'excluded', cols, 'aggiorna', ['con"to']);
  assert.equal(insertSql('postgresql', '"demo"."excluded"', riga, info),
    'INSERT INTO "demo"."excluded" AS codedb_destinazione ("ID", "con""to", "d`ato") OVERRIDING SYSTEM VALUE VALUES (10, 2, 7) ON CONFLICT ("con""to") DO UPDATE SET "d`ato" = EXCLUDED."d`ato";\n');
  info.scrittura = scritturaRighe('mysql', 't', cols, 'aggiorna', ['con"to']);
  assert(insertSql('mysql', '`db`.`t`', riga, info).endsWith('ON DUPLICATE KEY UPDATE `d``ato` = VALUES(`d``ato`);\n'));
  assert.equal(scritturaRighe('postgresql', 't', [cols[1]], 'aggiorna', ['con"to']).coda, ' ON CONFLICT ("con""to") DO NOTHING');
  assert(statement("CREATE PROCEDURE p() BEGIN SELECT '$codedb$'; END", 'mysql').includes('DELIMITER $codedb$$'));
  console.log('  OK   Export: perimetro, tipi, indici, conteggi e pubblicazione verificata');
})().catch(err => { console.error(err); process.exitCode = 1; });

async function verificaExportServer() {
  // Database simulato, ma eventi, motore, disco, checksum e download HTTP reali.
  const { createServer } = require('../server/createServer');
  const { contestoFinto, sessioneFinta } = require('./contesto-finto');
  const crypto = require('crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-export-volume-'));
  const server = createServer({ config: { env: {
    CODEDB_RBAC: 'off', CODEDB_MAX_IMPORT_BYTES: '10', CODEDB_MAX_IMPORT_TOTAL_BYTES: '10',
    CODEDB_ARTEFATTI_MAX_BYTES: '10', CODEDB_BACKUPS_DIR: root,
    CODEDB_UI_AUDIT_FILE: path.join(root, 'audit.log'),
    CODEDB_MCP_AUDIT_FILE: path.join(root, 'mcp.log'),
  } } });
  const f = fixture('struttura-e-dati');
  const righe = 49, testo = 'x'.repeat(1024 * 1024);
  f.strategy.type = 'mongodb';
  f.collection.countDocuments = f.collection.estimatedDocumentCount = async () => righe;
  f.collection.find = () => ({ batchSize() { return this; }, async close() {},
    async *[Symbol.asyncIterator]() { for (let i = 0; i < righe; i++) yield { _id: i, testo }; },
  });
  const sess = sessioneFinta({ strategy: f.strategy, connName: 'locale' });
  const ctx = contestoFinto({ sessioni: [['tab-1', sess]] });
  server.registraEventi(ctx);
  await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  try {
    const preview = await ctx.socket.chiama('database:export:plan', { tabId: 'tab-1', db: 'demo' });
    assert.strictEqual(preview.ok, true, preview.error);
    const started = await ctx.socket.chiama('database:export:start', { tabId: 'tab-1', fingerprint: preview.plan.fingerprint });
    assert.strictEqual(started.ok, true, started.error);
    const deadline = Date.now() + 30000;
    let operation;
    do {
      assert(Date.now() < deadline, 'l’export deve terminare entro 30 secondi');
      await new Promise(resolve => setTimeout(resolve, 10));
      const status = await ctx.socket.chiama('database:export:status', { tabId: 'tab-1', operationId: started.operation.id });
      assert.strictEqual(status.ok, true, status.error);
      operation = status.operation;
    } while (operation.status === 'in_corso');
    assert.strictEqual(operation.status, 'completato', operation.error);
    assert.strictEqual(operation.rows, righe);
    const manifest = sess.exportOperation.manifest;
    assert(manifest.dimensione > 64 * 1024 * 1024, 'il file supera il precedente limite JSON predefinito');
    const url = `http://127.0.0.1:${server.server.address().port}${operation.url}`;
    const response = await fetch(url);
    assert.strictEqual(response.status, 200);
    const hash = crypto.createHash('sha256');
    let ricevuti = 0;
    for await (const bytes of response.body) { hash.update(bytes); ricevuti += bytes.length; }
    assert.strictEqual(ricevuti, manifest.dimensione);
    assert.strictEqual(hash.digest('hex'), manifest.digest, 'tutti i byte scaricati corrispondono al file verificato');
    const parziale = await fetch(url, { headers: { Range: `bytes=${ricevuti - 16}-` } });
    assert.strictEqual(parziale.status, 206);
    assert.strictEqual((await parziale.arrayBuffer()).byteLength, 16);
    console.log(`  OK   export server e download HTTP: ${ricevuti} byte, ${righe} documenti, limiti import/upload a 10 byte`);
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
