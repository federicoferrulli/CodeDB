'use strict';
if (process.env.CODEDB_QUERY_MUTANT) require('./fixtures/query-audit-mutant.cjs');
const assert = require('node:assert/strict');
const { eseguiScript } = require('../db/MongoScriptRunner');
const { parseDocument } = require('../db/MongoShell');
module.exports = (async () => {
  for (const [literal, expected] of [[String.raw`"\u00e8\x41\u{1F600}"`, 'èA😀'], [String.raw`"\uD83D\uDE00"`, '😀'], ['"a\\\r\nb"', 'ab'], [String.raw`"\0\v"`, '\0\v']]) {
    assert.equal(parseDocument(`{valore:${literal}}`).valore, expected);
    const result = await eseguiScript(`print(${literal});`, {}, { db: 'test' });
    assert.deepEqual(result.output, [expected]);
  }
  const source = 'const d=JSON.parse(\'{"__proto__":{"campo":7},"__host":true,"__bson":"long"}\'); printjson(Object.assign({},d));';
  const data = JSON.parse((await eseguiScript(source, {}, { db: 'test' })).output[0]);
  assert(Object.hasOwn(data, '__proto__')); assert.equal(data.__proto__.campo, 7);
  assert.equal(data.__host, true); assert.equal(data.__bson, 'long');
  let writes = 0;
  for (const read of ['find({})', 'aggregate([])']) {
    const host = { find: async () => ({ docs: [{ id: 1 }], truncated: true }), aggregate: async () => ({ docs: [{ id: 1 }], truncated: true }), write: async () => { writes++; } };
    await assert.rejects(() => eseguiScript(`try { const r=db.a.${read}.toArray(); db.b.insertOne({n:r.length}); } catch(e) { db.b.insertOne({errore:1}); }`, host, { db: 'test' }), /incompleta/);
  }
  assert.equal(writes, 0, 'Un risultato parziale non deve alimentare scritture neppure dal catch');
  await assert.rejects(() => eseguiScript('print(db.a.countDocuments({}));', { count: async () => ({ total: null, timedOut: true }) }, { db: 'test' }), /Conteggio MongoDB incompleto/);
  let create = 0;
  await assert.rejects(() => eseguiScript('for(let i=0;i<3;i++) db.createCollection("prova"+i);',
    { createCollection: async () => { create++; } }, { db: 'test', limiti: { chiamateDb: 2 } }), /limite di 2 operazioni/);
  assert.equal(create, 2, 'Il DDL deve rispettare il budget prima della terza chiamata');
  console.log('OK audit MQL: escape, campi BSON, risultati parziali non catturabili e conteggio sconosciuto');
})();
module.exports.catch(err => { console.error(err); process.exitCode = 1; });
