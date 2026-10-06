'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Long, EJSON } = require('bson');
const { creaPianoExport } = require('../db/exportPlan');
const { esportaDatabase, insertSql, statement } = require('../db/databaseExport');
const { creaFileExport } = require('../db/exportFile');
const { createArchivioUpload } = require('../db/uploadDisco');

function fixture(modalita, selezione) {
  const plan = creaPianoExport({ connection: 'locale', formato: 'codedb-json', modalita, selezione,
    catalogo: { db: 'demo', dbType: 'mongodb', oggetti: [
      { tipo: 'collection', nome: 't' }, { tipo: 'vista', nome: 'esclusa' },
    ], dipendenze: [] } });
  let reads = 0;
  const collection = {
    indexes: async () => [{ name: '_id_', key: { _id: 1 } }, { name: 'ttl', key: { data: 1 }, expireAfterSeconds: 60 }],
    countDocuments: async () => 1,
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

module.exports = (async () => {
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
    if (mode !== 'solo-struttura') assert.strictEqual(EJSON.deserialize(artifact.collections[0].docs[0], { relaxed: false }).n.toString(), '9007199254740993');
  }
  const broken = fixture('struttura-e-dati');
  broken.collection.indexes = async () => { throw new Error('listIndexes negato'); };
  await assert.rejects(esportaDatabase({ ...broken, write() {} }), /listIndexes negato/);
  const truncated = fixture('struttura-e-dati');
  truncated.collection.countDocuments = async () => 2;
  await assert.rejects(esportaDatabase({ ...truncated, write() {} }), /conteggio cambiato/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-export-test-'));
  const archivio = createArchivioUpload({ radicePer: () => root });
  try {
    const f = fixture('struttura-e-dati');
    await assert.rejects(creaFileExport({ ...f, archivio, ownerId: 'owner', actorId: 'actor', maxBytes: 10 }), /limite configurato/);
    assert.strictEqual(archivio.elenca('owner').length, 0, 'nessun file parziale deve essere scaricabile');
    const { manifest } = await creaFileExport({ ...f, archivio, ownerId: 'owner', actorId: 'actor' });
    assert.strictEqual(JSON.parse(fs.readFileSync(archivio.percorsoDati(manifest.id, 'owner').file, 'utf8')).collections.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const info = { columns: [], geo: new Map(), geoNativo: new Map() };
  assert(insertSql('mysql', '`t`', JSON.stringify({ v: "$&'\\\n" }), info).includes('CONVERT(X\''));
  assert(statement("CREATE PROCEDURE p() BEGIN SELECT '$codedb$'; END", 'mysql').includes('DELIMITER $codedb$$'));
  console.log('  OK   Export: perimetro, tipi, indici, conteggi e pubblicazione verificata');
})().catch(err => { console.error(err); process.exitCode = 1; });
