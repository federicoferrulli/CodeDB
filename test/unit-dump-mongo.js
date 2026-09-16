'use strict';

// Il dump MongoDB si prova senza server: il client è finto ma il percorso è
// quello vero — `runBackup` scrive il manifest e i dati su disco. Ciò che si
// prova è il contratto §5: topologia e modalità di lettura DICHIARATE nel
// manifest, tipi BSON intatti nel file, conteggi che tornano.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Long, Double, Decimal128, ObjectId, Binary } = require('bson');
const { classificaTopologia, leggiTopologia } = require('../db/mongoTopologia');
const { parseRiga } = require('../db/codecFedele');
const { runBackup } = require('../backup/lib/engine');

function clientFinto({ documenti, hello = { isWritablePrimary: true } }) {
  const collezioni = new Map(Object.entries(documenti));
  const collection = (nome) => ({
    find: () => ({
      batchSize: () => ({
        async *[Symbol.asyncIterator]() {
          for (const doc of collezioni.get(nome) || []) yield doc;
        },
      }),
    }),
    countDocuments: async () => (collezioni.get(nome) || []).length,
    indexes: async () => [],
  });
  return {
    db: (nome) => (nome === 'admin'
      ? { command: async () => ({ ...hello }) }
      : {
        collection,
        listCollections: () => ({
          toArray: async () => [...collezioni.keys()].map((name) => ({ name, type: 'collection', options: {} })),
        }),
      }),
  };
}

(async () => {
  /* --- Classificazione -------------------------------------------------------- */

  assert.strictEqual(classificaTopologia({ msg: 'isdbgrid' }), 'sharded');
  assert.strictEqual(classificaTopologia({ setName: 'rs0' }), 'replica');
  assert.strictEqual(classificaTopologia({ secondary: true }), 'replica');
  assert.strictEqual(classificaTopologia({ isWritablePrimary: true }), 'standalone');
  assert.strictEqual(classificaTopologia({}), 'sconosciuta', 'hello vuoto: non si indovina');
  assert.strictEqual(classificaTopologia(null), 'sconosciuta');
  const senzaHello = await leggiTopologia({ db: () => ({ command: async () => { throw new Error('no hello'); } }) });
  assert.strictEqual(senzaHello.topologia, 'sconosciuta');
  assert.strictEqual(senzaHello.snapshot, false);
  assert.match(senzaHello.avviso, /non rilevata/);
  console.log('  OK   topologie classificate, hello assente mai fatale');

  /* --- Dump completo con finto --------------------------------------------------- */

  const documenti = [
    { _id: new ObjectId('68c4a1b2c3d4e5f607182930'), intero: 7, lungo: Long.fromNumber(5), doppio: new Double(3), prezzo: Decimal128.fromString('19.90'), quando: new Date('2026-01-02T03:04:05.006Z'), bin: new Binary(Buffer.from([0, 255])) },
    { _id: new ObjectId('68c4a1b2c3d4e5f607182931'), intero: 8, lungo: Long.fromString('9007199254740993'), doppio: new Double(3.5), prezzo: Decimal128.fromString('0.1'), quando: new Date('2026-06-07T08:09:10.000Z'), bin: new Binary(Buffer.from([1])) },
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-dump-'));
  try {
    const strategia = {
      client: clientFinto({ documenti: { ordini: documenti } }),
      listCollections: async () => [{ name: 'ordini', type: 'collection' }],
    };
    const esito = await runBackup({
      session: { strategy: strategia, dbType: 'mongodb' },
      connName: 'locale', db: 'negozio', type: 'full', destRoot: tmp, compress: false, log: { info() {} },
    });
    assert.strictEqual(esito.totalDocs, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(esito.backupDir, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.coerenza, {
      motore: 'mongodb', topologia: 'standalone', snapshot: false,
    }, 'il manifest dichiara come si è letto');
    assert.ok(manifest.notes.some((n) => /cursore ordinario/.test(n)), 'e lo dice anche nelle note');
    const dati = manifest.files.find((f) => f.kind === 'data');
    assert.ok(dati.sha256 && dati.bytes > 0);
    const righe = fs.readFileSync(path.join(esito.backupDir, dati.path), 'utf8').trim().split('\n').map(parseRiga);
    assert.strictEqual(righe.length, 2);
    assert.strictEqual(righe[0].lungo._bsontype, 'Long', 'Long(5) resta Long sul disco');
    assert.strictEqual(righe[0].doppio._bsontype, 'Double', 'Double(3) resta Double sul disco');
    assert.strictEqual(String(righe[1].lungo), '9007199254740993', 'oltre 2^53 intatto');
    assert.ok(righe[0]._id instanceof ObjectId, '_id per la verifica di identità');
    assert.strictEqual(righe[0].quando.getTime(), new Date('2026-01-02T03:04:05.006Z').getTime());
    console.log('  OK   dump finto: manifest con coerenza, tipi intatti, conteggi');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  OK   Dump MongoDB con coerenza dichiarata passed');
})().catch((err) => {
  console.error('  FAIL Dump MongoDB:', err.stack || err);
  process.exitCode = 1;
});
