'use strict';
const assert = require('node:assert/strict');
if (process.argv.includes('--mutant')) require('node:module').registerHooks({ load(url, context, next) {
  const r = next(url, context);
  if (!url.endsWith('/sqlSchemaMongo.js')) return r;
  const source = String(r.source), from = "return Decimal128.fromString(raw);";
  assert.ok(source.includes(from));
  return { ...r, source: source.replace(from, 'return value;') };
} });
const { normalizzaJson } = require('../db/sqlSchemaMongo');
const { serializza } = require('../db/mongoEjson');
const { Long } = require('bson');
const schema = { columns: [{ name: 'j', type: 'JSON' }] };
const row = normalizzaJson(schema, { j: '{"n":9007199254740993,"d":1.1234567890123456789,"small":42,"s":"9007199254740993"}' });
assert.equal(row.j.n.toString(), '9007199254740993');
assert.equal(row.j.d.toString(), '1.1234567890123456789');
assert.equal(row.j.small, 42);
assert.equal(row.j.s, '9007199254740993');
assert.throws(() => normalizzaJson(schema, { j: '{"rotto":' }), /JSON non valido/);
assert.deepEqual(serializza({ nested: [Long.fromString('9007199254740993'), Long.fromNumber(42)] }),
  { nested: [{ $numberLong: '9007199254740993' }, 42] });
console.log('  OK   Precisione JSON e Long annidati conservata senza cambiare numeri piccoli o stringhe');
