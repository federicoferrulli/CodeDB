'use strict';

// Il seam registra i byte effettivamente consegnati al comando ordinato del driver.
const assert = require('node:assert/strict');
const B = require('bson');
const MongoDbStrategy = require('../db/MongoDbStrategy');

module.exports = (async () => {
  console.log('--- Test insert MongoDB singolo e multiplo ---');
  const calls = [];
  const strategy = new MongoDbStrategy();
  strategy.client = { db: () => ({ collection: () => ({}), listCollections: () => ({ toArray: async () => [] }), command: async cmd => {
    const docs = cmd.documents.chunks.slice(1).map(bytes => B.deserialize(bytes, { promoteValues: false }));
    calls.push({ cmd, docs });
    return { ok: 1, n: docs.length };
  } }) };
  const first = '64b64c0f0000000000000011', second = '64b64c0f0000000000000012';
  const result = await strategy.docInsert('catalogo', 'eventi', { doc: JSON.stringify([
    { _id: { $oid: first }, quando: { $date: '2026-08-29T00:00:00.000Z' } },
    { _id: { $oid: second }, totale: { $numberLong: '9007199254740993' } },
  ]) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd.insert, 'eventi');
  assert.equal(calls[0].cmd.ordered, true);
  assert(calls[0].docs[0]._id instanceof B.ObjectId);
  assert(calls[0].docs[0].quando instanceof Date);
  assert.equal(calls[0].docs[1].totale.toString(), '9007199254740993');
  assert.equal(result.insertedCount, 2);
  assert.deepEqual(result.insertedIds.map(id => JSON.parse(id).$oid), [first, second]);
  const single = await strategy.docInsert('catalogo', 'eventi', { doc: '{"nome":"Ada"}' });
  assert.equal(calls[1].docs[0].nome, 'Ada');
  assert.equal(JSON.parse(single.insertedId).$oid, calls[1].docs[0]._id.toHexString());
  const before = calls.length;
  for (const doc of ['[]', '[{"nome":"Ada"},42]', '[{"$date":"2026-08-29T00:00:00.000Z"}]']) {
    await assert.rejects(strategy.docInsert('catalogo', 'eventi', { doc }), /elenco non vuoto di documenti/);
  }
  for (const value of [{ $numberInt: '2147483648' }, { $numberLong: '9223372036854775808' }, { $numberInt: '1e3' }, { $binary: { base64: '???', subType: '00' } }, { $timestamp: { t: -1, i: 0 } }]) {
    await assert.rejects(strategy.docInsert('catalogo', 'eventi', { doc: JSON.stringify({ value }) }));
  }
  assert.equal(calls.length, before, 'nessuna richiesta per input malformati');
  strategy.client = { db: () => ({ collection: () => ({}), listCollections: () => ({ toArray: async () => [] }), command: async () => ({ n: 1, writeErrors: [{ errmsg: 'E11000 duplicate key' }] }) }) };
  await assert.rejects(strategy.docInsert('catalogo', 'eventi', { doc: '[{"_id":1},{"_id":1}]' }),
    e => e.auditResult.insertedCount === 1 && JSON.parse(e.auditResult.insertedIds[0]) === 1);
  console.log('  OK   BSON esatto, risultato singolo/bulk, validazione prima della scrittura e audit parziale');
})();
