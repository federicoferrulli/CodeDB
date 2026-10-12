'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('bson');
const { GridFSBucket } = require('mongodb');
const raw = require('../db/mongoBson');
const { roundtripJson } = require('./e2e-export-formati');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');
const quiet = { info() {}, error() {} };
if(process.argv.includes('--mutant')) { process.env.CODEDB_TEST_TYPE_FAULT='bson'; process.env.NODE_OPTIONS=`--require "${path.join(__dirname,'fault-tipi.cjs').replace(/\\/g,'/')}"`; }

function fixture() {
  const values = {
    _id: new B.Int32(1), stringa: 'à 🦊\0', vuota: '', documento: { a: 1, b: { $date: 'letterale', $numberLong: 'testo' } },
    array: [null, true, new B.Long('9007199254740993'), []], bool: true, nullo: null,
    int: new B.Int32(-2147483648), long: B.Long.MIN_VALUE, longMax: B.Long.MAX_VALUE,
    double: new B.Double(1.2345678901234567), menoZero: new B.Double(-0), nan: new B.Double(NaN), inf: new B.Double(Infinity), menoInf: new B.Double(-Infinity),
    decimal: B.Decimal128.fromString('1234567890123456789012345678901234'), decimalInf: B.Decimal128.fromString('Infinity'), decimalNan: B.Decimal128.fromString('NaN'),
    data: new Date(-62167219200000), oid: new B.ObjectId(), timestamp: new B.Timestamp({ t: 0xffffffff, i: 0xffffffff }), regex: new B.BSONRegExp('a.*', 'imsux'),
    codice: new B.Code('return 1'), scope: new B.Code('return x', { x: B.Long.MAX_VALUE }), simbolo: new B.BSONSymbol('simbolo'), min: new B.MinKey(), max: new B.MaxKey(),
  };
  for (const subtype of [0, 1, 2, 3, 4, 5, 6, 7, 8, 128]) values['bin' + subtype] = new B.Binary(Buffer.alloc(subtype === 3 || subtype === 4 ? 16 : 32, subtype), subtype);
  values.bin7 = new B.Binary(Buffer.from([0]), 7);
  values.bin9 = new B.Binary(Buffer.from([3, 0, 1, 2, 127]), 9);
  const original = B.serialize(values);
  const field = (tag, name, value = Buffer.alloc(0)) => Buffer.concat([Buffer.from([tag]), Buffer.from(name + '\0'), value]);
  const str = B.serialize({ x: 'namespace' }).subarray(7, -1);
  const extras = [field(6, 'undefined'), field(12, 'dbPointer', Buffer.concat([str, new B.ObjectId().id])),
    field(9, 'dataMassima', Buffer.from('ffffffffffffff7f', 'hex')), field(9, 'dataMinima', Buffer.from('0000000000000080', 'hex'))];
  const doc = Buffer.concat([original.subarray(0, -1), ...extras, Buffer.from([0])]);
  doc.writeInt32LE(doc.length);
  assert.deepEqual([...new Set(B.onDemand.parseToElements(doc).map(e=>e[0]))].sort((a,b)=>a-b),[...Array.from({length:19},(_,i)=>i+1),127,255],'la fixture deve contenere tutti i tag BSON');
  return doc;
}

(async () => {
  const port = Number(process.env.EXPORT_MONGO_PORT); assert(port, 'Porta MongoDB usa-e-getta obbligatoria.');
  const st = new (require('../db/MongoDbStrategy'))();
  await st.connect({ uri: `mongodb://127.0.0.1:${port}` });
  const db = 'codedb_bson_' + crypto.randomBytes(6).toString('hex'), target = db + '_copy';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-bson-'));
  const read = async name => (await st.client.db(name).collection('tipi').find({}, { raw: true }).sort({ _id: 1 }).toArray()).map(b => b.toString('hex'));
  try {
    assert.equal((await raw.importRows(st.client, db, 'tipi', [raw.encode(fixture())])).inserted, 1);
    const grande=B.serialize({_id:new B.Int32(3),data:new B.Binary(Buffer.alloc(16*1024*1024-128,255))});
    assert.equal((await raw.importRows(st.client,db,'tipi',[raw.encode(grande)])).inserted,1);
    const payload = crypto.randomBytes(1024 * 1024 + 31);
    const bucket = new GridFSBucket(st.client.db(db));
    const stream = bucket.openUploadStream('tutti-i-byte.bin', { chunkSizeBytes: 65536 });
    await new Promise((resolve, reject) => { stream.on('finish', resolve).on('error', reject); stream.end(payload); });
    const expected = await read(db);
    await roundtripJson('mongodb', port, db, target);
    assert.deepEqual(await read(target), expected, 'BSON byte per byte, inclusi tag storici e date fuori dal range JS');
    const chunks = []; for await (const c of new GridFSBucket(st.client.db(target)).openDownloadStream(stream.id)) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), payload, 'GridFS: contenuto, metadati e chunk');
    const full = await runBackup({ session: { strategy: st, dbType: 'mongodb' }, connName: 'bson', db, type: 'full', destRoot: root, compress: true, log: quiet });
    await st.client.db(target).dropDatabase();
    await runRestore({ session: { strategy: st, dbType: 'mongodb' }, backupDir: full.backupDir, targetDb: target, drop: true, log: quiet });
    assert.deepEqual(await read(target), expected, 'backup BSON senza conversioni');
    await st.client.db(db).collection('tipi').insertOne({ _id: 2, bin: Buffer.from([0, 255]) });
    await st.client.db(db).collection('tipi').deleteOne({ _id: 1 });
    const delta = await runBackup({ session: { strategy: st, dbType: 'mongodb' }, connName: 'bson', db, type: 'incremental', destRoot: root, compress: true, log: quiet });
    await st.client.db(target).dropDatabase();
    await runRestore({ session: { strategy: st, dbType: 'mongodb' }, backupDir: delta.backupDir, targetDb: target, drop: true, log: quiet });
    assert.deepEqual(await read(target), await read(db), 'incrementale: upsert e cancellazioni con identità BSON');
    console.log('OK BSON: tutti i tag BSON memorizzabili, byte esatti, GridFS, backup full e incrementale.');
  } finally { await st.client.db(db).dropDatabase(); await st.client.db(target).dropDatabase(); await st.disconnect(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
