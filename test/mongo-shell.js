'use strict';

// Test unitari del parser shell mongosh (db/MongoShell.js). Non richiede DB né
// server: pura trasformazione in un "plan". Eseguire con: node test/mongo-shell.js

const assert = require('assert');
const { translate, looksLikeShell } = require('../db/MongoShell');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { process.exitCode = 1; console.error('  ✗ ' + name + '\n    ' + err.message); }
}
function eq(a, b, m) { assert.deepStrictEqual(a, b, m); }

console.log('MongoShell — find');

check('find semplice con filtro', () => {
  const p = translate('db.users.find({ age: { $gt: 30 } })');
  eq(p.kind, 'find');
  eq(p.coll, 'users');
  eq(p.filter, { age: { $gt: 30 } });
  eq(p.limit, 50);
});

check('find() vuoto', () => {
  const p = translate('db.users.find()');
  eq(p.filter, {});
  eq(p.projection, {});
});

check('find con proiezione e catena sort/skip/limit', () => {
  const p = translate('db.users.find({ active: true }, { name: 1, _id: 0 }).sort({ name: 1 }).skip(10).limit(5)');
  eq(p.filter, { active: true });
  eq(p.projection, { name: 1, _id: 0 });
  eq(p.sort, { name: 1 });
  eq(p.skip, 10);
  eq(p.limit, 5);
});

check('chiavi non quotate e apici singoli', () => {
  const p = translate("db.t.find({ city: 'Roma', tags: ['a', 'b'] })");
  eq(p.filter, { city: 'Roma', tags: ['a', 'b'] });
});

check('findOne → limit 1', () => {
  const p = translate('db.t.findOne({ a: 1 })');
  eq(p.limit, 1);
  eq(p.filter, { a: 1 });
});

check('ObjectId → $oid', () => {
  const p = translate('db.users.find({ _id: ObjectId("507f1f77bcf86cd799439011") })');
  eq(p.filter, { _id: { $oid: '507f1f77bcf86cd799439011' } });
});

check('ISODate → $date', () => {
  const p = translate('db.t.find({ created: { $gte: ISODate("2020-01-01T00:00:00Z") } })');
  eq(p.filter, { created: { $gte: { $date: '2020-01-01T00:00:00Z' } } });
});

check('NumberLong / NumberDecimal', () => {
  const p = translate('db.t.find({ big: NumberLong("90071992547409910"), price: NumberDecimal("9.99") })');
  eq(p.filter, { big: { $numberLong: '90071992547409910' }, price: { $numberDecimal: '9.99' } });
});

check('regex letterale → $regularExpression', () => {
  const p = translate('db.t.find({ name: /^mar/i })');
  eq(p.filter, { name: { $regularExpression: { pattern: '^mar', options: 'i' } } });
});

check('numeri negativi e virgola finale', () => {
  const p = translate('db.t.find({ balance: { $lt: -100 }, })');
  eq(p.filter, { balance: { $lt: -100 } });
});

console.log('MongoShell — aggregate / count / distinct');

check('aggregate pipeline', () => {
  const p = translate('db.orders.aggregate([ { $group: { _id: "$city", n: { $sum: 1 } } } ])');
  eq(p.kind, 'aggregate');
  eq(p.coll, 'orders');
  eq(p.pipeline, [{ $group: { _id: '$city', n: { $sum: 1 } } }]);
});

check('aggregate con catena limit → stadio $limit', () => {
  const p = translate('db.o.aggregate([{ $match: { a: 1 } }]).limit(3)');
  eq(p.pipeline, [{ $match: { a: 1 } }, { $limit: 3 }]);
});

check('countDocuments → pipeline $count', () => {
  const p = translate('db.users.countDocuments({ active: true })');
  eq(p.kind, 'aggregate');
  eq(p.pipeline, [{ $match: { active: true } }, { $count: 'count' }]);
});

check('count() senza filtro', () => {
  const p = translate('db.users.count()');
  eq(p.pipeline, [{ $count: 'count' }]);
});

check('find().count() in catena', () => {
  const p = translate('db.users.find({ a: 1 }).count()');
  eq(p.pipeline, [{ $match: { a: 1 } }, { $count: 'count' }]);
});

check('distinct → pipeline group', () => {
  const p = translate('db.users.distinct("city", { country: "IT" })');
  eq(p.kind, 'aggregate');
  eq(p.pipeline, [
    { $match: { country: 'IT' } },
    { $group: { _id: '$city' } },
    { $project: { _id: 0, city: '$_id' } },
    { $sort: { city: 1 } },
  ]);
});

check('distinct su campo annidato → colonna piatta', () => {
  const p = translate('db.users.distinct("address.city")');
  eq(p.pipeline, [
    { $group: { _id: '$address.city' } },
    { $project: { _id: 0, address_city: '$_id' } },
    { $sort: { address_city: 1 } },
  ]);
});

console.log('MongoShell — euristica ed errori');

check('looksLikeShell riconosce db.x.y', () => {
  assert.ok(looksLikeShell('db.users.find({})'));
  assert.ok(looksLikeShell('  db . users . aggregate([])'));
  assert.ok(!looksLikeShell('SELECT * FROM users'));
  assert.ok(!looksLikeShell('{ "a": 1 }'));
});

function throws(name, code, rx) {
  check(name, () => assert.throws(() => translate(code), rx));
}

throws('scrittura insertOne rifiutata', 'db.t.insertOne({ a: 1 })', /scrittura|vista dati/i);
throws('updateMany rifiutata', 'db.t.updateMany({}, { $set: { a: 1 } })', /scrittura|vista dati/i);
throws('metodo sconosciuto', 'db.t.foo({})', /non supportato/i);
throws('non inizia con db', 'users.find({})', /devono iniziare con "db\."/i);
throws('valore non quotato non valido', 'db.t.find({ a: pippo })', /valore non valido/i);
throws('aggregate senza array', 'db.t.aggregate({})', /pipeline/i);

console.log(`\n${passed} test superati.`);
if (process.exitCode) console.error('ALCUNI TEST FALLITI.');
