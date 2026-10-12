'use strict';

// Caricato solo dai processi usa-e-getta delle prove --mutant.
if (process.env.CODEDB_TEST_TYPE_FAULT === 'bson') {
  const codec = require('../db/mongoBson'), original = codec.encode;
  codec.encode = doc => original(require('bson').deserialize(doc));
} else if (process.env.CODEDB_TEST_TYPE_FAULT === 'sql') {
  const codec = require('../db/sqlTransfer'), original = codec.encodeRow;
  codec.encodeRow = (row,...args) => original({ ...row, ...(row.c13 != null ? { c13: String(Number(row.c13).toFixed(2)) } : {}) },...args);
} else if (process.env.CODEDB_TEST_TYPE_FAULT === 'enum') {
  const codec = require('../db/mysql-ordinal'), original = codec.binding;
  codec.binding = (value,column) => {const b=original(value,column);return b?.zero?{sql:'?',param:'',zero:false}:b;};
} else if (process.env.CODEDB_TEST_TYPE_FAULT === 'lo') {
  const codec = require('../db/pg-references'), original = codec.importLargeObjects;
  codec.importLargeObjects = (pool, objects, previous) => original(pool, objects?.map(o => ({ ...o,
    chunks: o.chunks.map((c,i) => { if(i)return c;const b=Buffer.from(c,'base64');b[0]^=1;return b.toString('base64'); }),
  })), previous);
} else if(process.env.CODEDB_TEST_TYPE_FAULT === 'nested') {
  const codec=require('../db/pg-alias'),original=codec.encode;
  codec.encode=(...args)=>{const row=original(...args);for(const v of Object.values(row))for(const r of v?.$pgReference?.refs||[])r.value=r.value.replace('.f(integer)','.f(text)');return row;};
}
