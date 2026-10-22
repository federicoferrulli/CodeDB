'use strict';

// Test unitari del traduttore SQL→MQL (db/SqlToMql.js). Non richiede alcun
// database né il server: pura trasformazione. Eseguire con:  node test/sql-to-mql.js

const assert = require('assert');
const { translate } = require('../db/SqlToMql');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    process.exitCode = 1;
    console.error('  ✗ ' + name + '\n    ' + err.message);
  }
}

function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg || 'Piano SQL inatteso');
}

console.log('SQL→MQL — find semplici');

check('SELECT * FROM users', () => {
  const p = translate('SELECT * FROM users');
  eq(p.kind, 'find');
  eq(p.coll, 'users');
  eq(p.filter, {});
  eq(p.projection, {});
  eq(p.limit, null);
});

check('proiezione colonne esclude _id', () => {
  const p = translate('SELECT name, age FROM users');
  eq(p.projection, { name: 1, age: 1, _id: 0 });
});

check('WHERE con operatori', () => {
  const p = translate('SELECT * FROM users WHERE age > 30');
  eq(p.filter, { age: { $gt: 30 } });
});

check('WHERE uguaglianza stringa', () => {
  const p = translate("SELECT * FROM users WHERE city = 'Roma'");
  eq(p.filter, { city: 'Roma' });
});

check('WHERE != e <>', () => {
  eq(translate('SELECT * FROM t WHERE a != 1').filter, { $and: [{ a: { $ne: null } }, { a: { $ne: 1 } }] });
  eq(translate('SELECT * FROM t WHERE a <> 1').filter, { $and: [{ a: { $ne: null } }, { a: { $ne: 1 } }] });
});

check('AND combina in $and', () => {
  const p = translate("SELECT * FROM users WHERE age >= 18 AND city = 'Roma'");
  eq(p.filter, { $and: [{ age: { $gte: 18 } }, { city: 'Roma' }] });
});

check('OR combina in $or', () => {
  const p = translate("SELECT * FROM t WHERE a = 1 OR b = 2");
  eq(p.filter, { $or: [{ a: 1 }, { b: 2 }] });
});

check('precedenza: AND lega più di OR', () => {
  const p = translate('SELECT * FROM t WHERE a = 1 AND b = 2 OR c = 3');
  eq(p.filter, { $or: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }] });
});

check('parentesi forzano il raggruppamento', () => {
  const p = translate('SELECT * FROM t WHERE a = 1 AND (b = 2 OR c = 3)');
  eq(p.filter, { $and: [{ a: 1 }, { $or: [{ b: 2 }, { c: 3 }] }] });
});

check('IN e NOT IN', () => {
  eq(translate("SELECT * FROM t WHERE s IN ('a','b')").filter, { s: { $in: ['a', 'b'] } });
  assert(translate('SELECT * FROM t WHERE n NOT IN (1,2,3)').filter.$expr);
});

// CDB-A19 — il flag `i` costa l'INDICE: una regex case-insensitive non è
// sargable. Un pattern ancorato a un prefisso è esattamente il caso in cui
// l'indice servirebbe, quindi lì il confronto resta sensibile alle maiuscole
// (che su MongoDB è anche il comportamento naturale); dove la scansione è
// comunque inevitabile il flag resta.
check('LIKE ancorato a un prefisso: nessun flag "i", così l\'indice è usabile', () => {
  const p = translate("SELECT * FROM t WHERE name LIKE 'Mar%'");
  eq(p.filter, { name: { $regex: '^Mar.*$' } });
});

check('LIKE con _ singolo carattere (ancorato)', () => {
  const p = translate("SELECT * FROM t WHERE code LIKE 'A_C'");
  eq(p.filter, { code: { $regex: '^A.C$' } });
});

check('LIKE non ancorato: il flag "i" resta, l\'indice non era usabile comunque', () => {
  const p = translate("SELECT * FROM t WHERE name LIKE '%mar%'");
  eq(p.filter, { name: { $regex: '^.*mar.*$', $options: 'i' } });
});

check('ILIKE chiede esplicitamente il confronto insensibile', () => {
  const p = translate("SELECT * FROM t WHERE name ILIKE 'Mar%'");
  eq(p.filter, { name: { $regex: '^Mar.*$', $options: 'i' } });
});

check('IS NULL / IS NOT NULL', () => {
  eq(translate('SELECT * FROM t WHERE x IS NULL').filter, { x: null });
  eq(translate('SELECT * FROM t WHERE x IS NOT NULL').filter, { x: { $ne: null } });
});

check('BETWEEN', () => {
  const p = translate('SELECT * FROM t WHERE age BETWEEN 18 AND 65');
  eq(p.filter, { age: { $gte: 18, $lte: 65 } });
});

check('NOT su condizione', () => {
  const p = translate('SELECT * FROM t WHERE NOT a = 1');
  assert(p.filter.$expr, 'NOT conserva il risultato sconosciuto dei valori NULL');
});

check('numeri negativi negli operatori di confronto', () => {
  const p = translate('SELECT * FROM t WHERE balance < -100');
  eq(p.filter, { balance: { $lt: -100 } });
});

check('numeri negativi in BETWEEN e IN', () => {
  const p = translate('SELECT * FROM t WHERE x BETWEEN -10 AND -5');
  eq(p.filter, { x: { $gte: -10, $lte: -5 } });
  const q = translate('SELECT * FROM t WHERE tags IN (-1, -2, 3)');
  eq(q.filter, { tags: { $in: [-1, -2, 3] } });
});

check('negativo con notazione esponenziale', () => {
  const p = translate('SELECT * FROM t WHERE a > -1.5e2');
  eq(p.filter, { a: { $gt: -150 } });
});

check("l'alias di colonna rinomina la proiezione", () => {
  const p = translate('SELECT nome AS n FROM t');
  eq(p.pipeline, [{ $project: { _id: 0, n: '$nome' } }]);
});

check('ORDER BY e LIMIT/OFFSET', () => {
  const p = translate('SELECT * FROM t WHERE a = 1 ORDER BY name DESC, age ASC LIMIT 10 OFFSET 5');
  eq(p.pipeline[0], { $match: { a: 1 } });
  eq(p.pipeline.find(s=>s.$sort), { $sort: { 'chiavi.k0': -1, 'chiavi.k1': 1 } });
  eq(p.pipeline.find(s=>s.$limit), { $limit: 10 });
  eq(p.pipeline.find(s=>s.$skip), { $skip: 5 });
});

check('LIMIT offset, count (stile MySQL)', () => {
  const p = translate('SELECT * FROM t LIMIT 20, 10');
  eq(p.skip, 20);
  eq(p.limit, 10);
});

console.log('SQL→MQL — aggregazioni');

check('COUNT(*) senza GROUP BY', () => {
  const p = translate('SELECT COUNT(*) AS n FROM users');
  eq(p.kind, 'aggregate');
  assert(p.pipeline[0].$facet.gruppo[0].$group.v0.$sum);
  eq(p.pipeline[1].$replaceWith.$ifNull[1].$literal.v0, 0);
  eq(p.columns, ['n']);
});

check('GROUP BY con COUNT', () => {
  const p = translate('SELECT city, COUNT(*) AS n FROM users GROUP BY city');
  eq(p.pipeline[0].$group._id, { g0: { $ifNull: ['$city', null] } });
  assert(p.pipeline[0].$group.v0.$sum);
  eq(p.columns, ['city', 'n']);
});

check('GROUP BY con WHERE, SUM e ORDER BY', () => {
  const p = translate("SELECT city, SUM(amount) AS tot FROM orders WHERE status = 'paid' GROUP BY city ORDER BY tot DESC LIMIT 5");
  eq(p.pipeline[0], { $match: { status: 'paid' } });
  eq(p.pipeline[1].$group.v0, { $sum: { $ifNull: ['$amount', null] } });
  eq(p.pipeline.find(s => s.$sort), { $sort: { 'chiavi.k0': -1 } });
  eq(p.pipeline.find(s => s.$limit), { $limit: 5 });
});

check('GROUP BY multiplo', () => {
  const p = translate('SELECT country, city, AVG(age) AS avg_age FROM users GROUP BY country, city');
  eq(p.pipeline[0].$group._id, { g0: { $ifNull: ['$country', null] }, g1: { $ifNull: ['$city', null] } });
  eq(p.pipeline[0].$group.v0, { $avg: { $ifNull: ['$age', null] } });
});

console.log('SQL→MQL — JOIN ($lookup)');

check('INNER JOIN base → $lookup + $unwind', () => {
  const p = translate('SELECT * FROM orders o JOIN customers c ON o.cust_id = c._id');
  eq(p.kind, 'aggregate');
  eq(p.coll, 'orders');
  eq(p.pipeline, [
    { $lookup: { from: 'customers', let: { chiave: '$cust_id' }, pipeline: [{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: ['$_id', '$$chiave'] }] } } }], as: 'c' } },
    { $unwind: '$c' },
  ]);
});

check('JOIN senza INNER equivale a INNER', () => {
  const p = translate('SELECT * FROM a JOIN b ON a.bid = b.id');
  eq(p.pipeline[1], { $unwind: '$b' });
});

check('LEFT JOIN preserva i documenti senza corrispondenza', () => {
  const p = translate('SELECT * FROM a LEFT JOIN b ON a.bid = b.id');
  eq(p.pipeline, [
    { $lookup: { from: 'b', let: { chiave: '$bid' }, pipeline: [{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: ['$id', '$$chiave'] }] } } }], as: 'b' } },
    { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } },
  ]);
});

check('LEFT OUTER JOIN accetta OUTER opzionale', () => {
  const p = translate('SELECT * FROM a LEFT OUTER JOIN b ON a.bid = b.id');
  eq(p.pipeline[1], { $unwind: { path: '$b', preserveNullAndEmptyArrays: true } });
});

check('JOIN con proiezione di colonne qualificate', () => {
  const p = translate('SELECT o.total AS t, c.name FROM orders o JOIN customers c ON o.cust_id = c._id');
  eq(p.pipeline, [
    { $lookup: { from: 'customers', let: { chiave: '$cust_id' }, pipeline: [{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: ['$_id', '$$chiave'] }] } } }], as: 'c' } },
    { $unwind: '$c' },
    { $project: { _id: 0, t: '$total', name: '$c.name' } },
  ]);
});

check('JOIN con WHERE su campi base e uniti', () => {
  const p = translate("SELECT o.id FROM orders o JOIN customers c ON o.cust_id = c._id WHERE o.total > 100 AND c.city = 'Roma'");
  eq(p.pipeline, [
    { $lookup: { from: 'customers', let: { chiave: '$cust_id' }, pipeline: [{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: ['$_id', '$$chiave'] }] } } }], as: 'c' } },
    { $unwind: '$c' },
    { $match: { $and: [{ total: { $gt: 100 } }, { 'c.city': 'Roma' }] } },
    { $project: { _id: 0, id: '$id' } },
  ]);
});

check('ON con ordine invertito (foreign a sinistra)', () => {
  const p = translate('SELECT * FROM a JOIN b ON b.id = a.bid');
  eq(p.pipeline[0], { $lookup: { from: 'b', let: { chiave: '$bid' }, pipeline: [{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: ['$id', '$$chiave'] }] } } }], as: 'b' } });
});

check('JOIN + GROUP BY con aggregato su campo unito', () => {
  const p = translate('SELECT c.city, SUM(o.total) AS tot FROM orders o JOIN customers c ON o.cust_id = c._id GROUP BY c.city');
  eq(p.pipeline[0].$lookup.from, 'customers');
  eq(p.pipeline[2].$group._id, { g0: { $ifNull: ['$c.city', null] } });
  eq(p.pipeline[2].$group.v0, { $sum: { $ifNull: ['$total', null] } });
});

check('due JOIN concatenate', () => {
  const p = translate('SELECT * FROM a JOIN b ON a.bid = b.id JOIN c ON b.cid = c.id');
  eq(p.pipeline, [
    { $lookup: { from: 'b', let: { chiave: '$bid' }, pipeline: [{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: ['$id', '$$chiave'] }] } } }], as: 'b' } },
    { $unwind: '$b' },
    { $lookup: { from: 'c', let: { chiave: '$b.cid' }, pipeline: [{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: ['$id', '$$chiave'] }] } } }], as: 'c' } },
    { $unwind: '$c' },
  ]);
});

check('RIGHT JOIN include il ramo anti-join', () => assert(translate('SELECT * FROM a RIGHT JOIN b ON a.x=b.y').pipeline.some(s => s.$unionWith)));
check('FULL JOIN conserva il lato sinistro', () => assert(translate('SELECT * FROM a FULL JOIN b ON a.x=b.y').pipeline.some(s => s.$unwind?.preserveNullAndEmptyArrays)));
check('CROSS JOIN produce un lookup senza filtro', () => { const p = translate('SELECT * FROM a CROSS JOIN b'); assert(p.pipeline?.length); });
check('JOIN USING risolve la colonna condivisa', () => { const p = translate('SELECT * FROM a JOIN b USING (id)'); assert(p.pipeline?.length); });
check('ON non di uguaglianza usa un lookup correlato', () => { const p = translate('SELECT * FROM a JOIN b ON a.x > b.y'); assert(p.pipeline?.length); });
check('ON multi-condizione conserva entrambi i predicati', () => { const p = translate('SELECT * FROM a JOIN b ON a.x = b.y AND a.z = b.w'); assert(p.pipeline?.length); });
check('ON fra colonne locali usa un predicato correlato', () => {
  const p = translate('SELECT * FROM a JOIN b ON a.x=a.y');
  assert(p.pipeline[0].$lookup.pipeline[0].$match.$expr);
});

console.log('SQL→MQL — DISTINCT e HAVING');

check('SELECT DISTINCT su una colonna', () => {
  const p = translate('SELECT DISTINCT city FROM users');
  eq(p.pipeline[0].$group, { _id: { g0: { $ifNull: ['$city', null] } } });
  eq(p.columns, ['city']);
});

check('SELECT DISTINCT su più colonne', () => {
  const p = translate('SELECT DISTINCT country, city FROM users');
  eq(p.pipeline[0].$group, { _id: { g0: { $ifNull: ['$country', null] }, g1: { $ifNull: ['$city', null] } } });
  eq(p.columns, ['country', 'city']);
});

check('HAVING su alias di aggregato del SELECT', () => {
  const p = translate('SELECT city, COUNT(*) AS n FROM t GROUP BY city HAVING n > 5');
  eq(p.pipeline.find(s => s.$match), { $match: { a0: { $gt: 5 } } });
  assert(p.pipeline.findIndex(s => s.$match) > p.pipeline.findIndex(s => s.$group));
});

check('HAVING con COUNT(*) non presente nel SELECT', () => {
  const p = translate('SELECT city FROM t GROUP BY city HAVING COUNT(*) > 1');
  assert(p.pipeline[0].$group.v0.$sum);
  eq(p.pipeline.find(s => s.$match), { $match: { a0: { $gt: 1 } } });
  eq(p.columns, ['city']);
});

check('HAVING con SUM sintetizzato', () => {
  const p = translate('SELECT city FROM t GROUP BY city HAVING SUM(amount) >= 100');
  eq(p.pipeline.find(s => s.$match), { $match: { a0: { $gte: 100 } } });
});

console.log('SQL→MQL — UNION ($unionWith)');

check('UNION ALL non deduplica', () => {
  const p = translate('SELECT name FROM a UNION ALL SELECT name FROM b');
  eq(p.kind, 'aggregate');
  eq(p.coll, 'a');
  eq(p.pipeline, [
    { $project: { name: 1, _id: 0 } },
    { $unionWith: { coll: 'b', pipeline: [{ $project: { name: 1, _id: 0 } }] } },
  ]);
});

check('UNION deduplica sull\'intero documento', () => {
  const p = translate('SELECT name FROM a UNION SELECT name FROM b');
  eq(p.pipeline, [
    { $project: { name: 1, _id: 0 } },
    { $unionWith: { coll: 'b', pipeline: [{ $project: { name: 1, _id: 0 } }] } },
    { $group: { _id: '$$ROOT' } },
    { $replaceRoot: { newRoot: '$_id' } },
  ]);
});

check('UNION a tre vie con WHERE su un operando', () => {
  const p = translate('SELECT id FROM a WHERE x = 1 UNION ALL SELECT id FROM b UNION ALL SELECT id FROM c');
  eq(p.pipeline, [
    { $match: { x: 1 } },
    { $project: { id: 1, _id: 0 } },
    { $unionWith: { coll: 'b', pipeline: [{ $project: { id: 1, _id: 0 } }] } },
    { $unionWith: { coll: 'c', pipeline: [{ $project: { id: 1, _id: 0 } }] } },
  ]);
});

check('operando UNION non impone il LIMIT di default', () => {
  const p = translate('SELECT * FROM a UNION ALL SELECT * FROM b');
  // Nessuno stadio $limit negli operandi né in coda.
  eq(p.pipeline.some((s) => s.$limit != null), false);
  const uw = p.pipeline.find((s) => s.$unionWith);
  eq(uw.$unionWith.pipeline.some((s) => s.$limit != null), false);
});

console.log('SQL→MQL — sotto-query (derived table nella FROM)');

check('derived table con GROUP BY interno e WHERE esterno', () => {
  const p = translate('SELECT city, n FROM (SELECT city, COUNT(*) AS n FROM users GROUP BY city) AS s WHERE n > 5');
  eq(p.coll, 'users');
  eq(p.pipeline.find(s => s.$match), { $match: { n: { $gt: 5 } } });
  assert(p.pipeline.findIndex(s => s.$match) > p.pipeline.findIndex(s => s.$group));
  eq(p.columns, ['city', 'n']);
});

check('derived table con ORDER BY e LIMIT esterni', () => {
  const p = translate('SELECT * FROM (SELECT name, age FROM users WHERE age > 18) t ORDER BY age DESC LIMIT 3');
  eq(p.pipeline.slice(0,2), [
    { $match: { age: { $gt: 18 } } },
    { $project: { name: 1, age: 1, _id: 0 } },
  ]);
  eq(p.pipeline.find(s=>s.$sort), { $sort: { 'chiavi.k0': -1 } });
  eq(p.pipeline.find(s=>s.$limit), { $limit: 3 });
});

console.log('SQL→MQL — errori attesi');

function throws(name, sql, rx) {
  check(name, () => {
    assert.throws(() => translate(sql), rx);
  });
}

throws('non-SELECT viene rifiutata', 'DELETE FROM users', /solo le query select/i);
check('DISTINCT * deduplica i documenti', () => { const p = translate('SELECT DISTINCT * FROM t'); assert(p.pipeline?.length); });
check('DISTINCT si applica dopo GROUP BY', () => { const p = translate('SELECT DISTINCT city FROM t GROUP BY city'); assert(p.pipeline?.length); });
throws('HAVING senza GROUP BY/aggregato rifiutato', 'SELECT city FROM t HAVING city > 1', /having richiede/i);
check('sotto-query IN (SELECT) diventa lookup', () => { const p = translate('SELECT * FROM t WHERE id IN (SELECT id FROM other)'); eq(p.pipeline.find(s => s.$lookup).$lookup.from, 'other'); });
check('sotto-query scalare limita la cardinalità letta', () => { const p = translate('SELECT * FROM t WHERE age = (SELECT MAX(age) FROM t)'); eq(p.pipeline.find(s => s.$lookup).$lookup.pipeline.at(-1), { $limit: 2 }); });
throws('colonna fuori da GROUP BY', 'SELECT name, COUNT(*) FROM t GROUP BY city', /group by/i);
throws('manca FROM', 'SELECT *', /from/i);
check('Confronto di uguaglianza fra colonne', () => { const p = translate('SELECT * FROM t WHERE a = b'); assert(p.filter.$expr); });
check('Confronto ordinato fra colonne', () => { const p = translate('SELECT * FROM t WHERE a > other_col'); assert(p.filter.$expr); });
check('IN accetta espressioni di colonna', () => { const p = translate('SELECT * FROM t WHERE a IN (1, b, 3)'); assert(p.filter.$expr); });
check('NOT IN accetta espressioni di colonna', () => { const p = translate('SELECT * FROM t WHERE a NOT IN (x, y)'); assert(p.filter.$expr); });
throws('pattern LIKE non quotato', 'SELECT * FROM t WHERE name LIKE pattern', /apici|valore non valido/i);
check('BETWEEN con colonna come estremo basso', () => { const p = translate('SELECT * FROM t WHERE a BETWEEN x AND 5'); assert(p.filter.$expr); });
check('BETWEEN con colonna come estremo alto', () => { const p = translate('SELECT * FROM t WHERE a BETWEEN 1 AND hi'); assert(p.filter.$expr); });
check('Funzioni scalari nei confronti', () => { const p = translate('SELECT * FROM t WHERE a = UPPER(b)'); assert(p.filter.$expr); });
check('Letterale a sinistra del confronto', () => { const p = translate('SELECT * FROM t WHERE 5 = a'); assert(p.filter.$expr); });

check('TRUE/FALSE/NULL restano validi in una lista IN', () => {
  eq(translate('SELECT * FROM t WHERE a IN (TRUE, FALSE, NULL)').filter, { a: { $in: [true, false] } });
});
check('IN esadecimale mantiene stringhe e ObjectId BSON nel piano indicizzabile', () => {
  const id = '668bde07922aa72f6275dcf5';
  const p = translate(`SELECT * FROM t WHERE _id IN ('${id}', 'non-valido', NULL)`);
  const valori = p.filter._id.$in;
  eq(valori.filter(v => typeof v === 'string'), [id, 'non-valido']);
  assert.equal(valori[1]._bsontype, 'ObjectId');
  assert.equal(valori[1].toHexString(), id);
  assert.equal(p.filter.$expr, undefined);
});
check('ObjectId nei confronti anche su campi diversi da _id e con alias', () => {
  const id = '668bde07922aa72f6275dcf5';
  const p = translate(`SELECT * FROM t AS g WHERE g.ref = '${id}'`);
  assert.equal(p.filter.ref.$in[1].toHexString(), id);
});
check('Aritmetica fra letterali nel confronto', () => { const p = translate('SELECT * FROM t WHERE a = 1 - 2'); assert(p.filter.$expr); });
throws('LIMIT negativo rifiutato', 'SELECT * FROM t LIMIT -5', /non può essere negativo/i);
throws('OFFSET negativo rifiutato', 'SELECT * FROM t LIMIT 10 OFFSET -3', /non può essere negativo/i);

console.log(`\n${passed} test superati.`);
if (process.exitCode) console.error('ALCUNI TEST FALLITI.');
