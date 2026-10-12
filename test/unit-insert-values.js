'use strict';
const assert = require('node:assert/strict');
const B = require('bson');
const { parseSqlInsert } = require('../db/insertValues');
const { preparaDocumenti } = require('../db/insertBson');
module.exports = (async () => {
  const { campiJson, leggiJsonEsatto } = await import('../public/js/insert-json.mjs');
  const { valoreInserimento } = await import('../public/js/insert-types.js');
  const fields = campiJson('{"a":{"x":[1,{"s":"}\\\""}]},"b":[2,3],"c":9007199254740993}');
  assert.equal(fields.get('c'), '9007199254740993'); assert.equal(fields.get('b'), '[2,3]');
  assert.throws(() => campiJson('{"a":1,"a":2}'), /duplicato/);
  assert.throws(() => leggiJsonEsatto('{"a":[{"x":1,"x":2}]}'), /duplicato/);
  assert.deepEqual(leggiJsonEsatto('9007199254740993'), { $numberLong: '9007199254740993' });
  const text = '  testo\nseconda riga\t🦊  ';
  assert.equal(valoreInserimento(text, 'text'), text);
  assert.deepEqual(valoreInserimento(text, 'code'), { $code: text });
  assert.deepEqual(valoreInserimento('', 'bytes'), { $binary: { base64: '', subType: '00' } });
  assert.deepEqual(valoreInserimento('1'.repeat(64), 'bits', { dbType: 'mysql' }, true), { $numberDecimal: '18446744073709551615' });
  assert.deepEqual(valoreInserimento('-9223372036854775808', 'datetime'), { $date: { $numberLong: '-9223372036854775808' } });
  assert.throws(() => valoreInserimento('2026-02-30', 'datetime'), /Giorno/);
  assert.throws(() => valoreInserimento('2026-10-12T12:30:00.123456Z', 'datetime'), /millisecondi/);
  await assert.rejects(preparaDocumenti('{"n":{"$date":"2026-02-30T12:00:00Z"}}'), /Giorno/);
  const long = '12345678901234567890123456789012345.123456789012345678901234567890';
  const json = '{ "n":9007199254740993,"n":1 }';
  const doc = await parseSqlInsert(`{"n":${long},"j":${json},"x":null}`, [{ name: 'n', types: ['numeric'] }, { name: 'j', types: ['json'] }, { name: 'x', types: ['text'] }]);
  assert.equal(doc.n, long); assert.equal(doc.j, json); assert.equal(doc.x, null);
  for (const malformed of [{ $numberInt: '1.2' }, { $numberLong: '9223372036854775808' }, { $binary: { base64: '*', subType: '00' } }, { $timestamp: { t: 1, i: -1 } }]) {
    await assert.rejects(preparaDocumenti(JSON.stringify({ n: malformed })));
  }
  const raw = (await preparaDocumenti('{"_id":"0123456789abcdef01234567","n":{"$numberDouble":"-0"}}')).raw[0];
  const native = B.deserialize(raw, { promoteValues: false });
  assert.equal(typeof native._id, 'string'); assert(Object.is(native.n.value, -0));
  console.log('  OK   Inserimento: sorgente JSON esatta, duplicati, multilinea, bit, binari e limiti BSON.');
})();
