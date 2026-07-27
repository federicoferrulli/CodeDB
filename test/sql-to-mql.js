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
  assert.deepStrictEqual(actual, expected, msg);
}

console.log('SQL→MQL — find semplici');

check('SELECT * FROM users', () => {
  const p = translate('SELECT * FROM users');
  eq(p.kind, 'find');
  eq(p.coll, 'users');
  eq(p.filter, {});
  eq(p.projection, {});
  eq(p.limit, 50);
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
  eq(translate('SELECT * FROM t WHERE a != 1').filter, { a: { $ne: 1 } });
  eq(translate('SELECT * FROM t WHERE a <> 1').filter, { a: { $ne: 1 } });
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
  eq(translate('SELECT * FROM t WHERE n NOT IN (1,2,3)').filter, { n: { $nin: [1, 2, 3] } });
});

check('LIKE → regex con jolly', () => {
  const p = translate("SELECT * FROM t WHERE name LIKE 'Mar%'");
  eq(p.filter, { name: { $regex: '^Mar.*$', $options: 'i' } });
});

check('LIKE con _ singolo carattere', () => {
  const p = translate("SELECT * FROM t WHERE code LIKE 'A_C'");
  eq(p.filter, { code: { $regex: '^A.C$', $options: 'i' } });
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
  eq(p.filter, { $nor: [{ a: 1 }] });
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

check("l'alias di colonna non rinomina la proiezione del find", () => {
  const p = translate('SELECT nome AS n FROM t');
  eq(p.projection, { nome: 1, _id: 0 });
});

check('ORDER BY e LIMIT/OFFSET', () => {
  const p = translate('SELECT * FROM t WHERE a = 1 ORDER BY name DESC, age ASC LIMIT 10 OFFSET 5');
  eq(p.filter, { a: 1 });
  eq(p.sort, { name: -1, age: 1 });
  eq(p.limit, 10);
  eq(p.skip, 5);
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
  eq(p.pipeline, [
    { _id: null, n: { $sum: 1 } },
    { $project: { _id: 0, n: 1 } },
  ]);
});

check('GROUP BY con COUNT', () => {
  const p = translate('SELECT city, COUNT(*) AS n FROM users GROUP BY city');
  eq(p.kind, 'aggregate');
  eq(p.pipeline, [
    { _id: '$city', n: { $sum: 1 } },
    { $project: { _id: 0, city: '$_id', n: 1 } },
  ]);
});

check('GROUP BY con WHERE, SUM e ORDER BY', () => {
  const p = translate("SELECT city, SUM(amount) AS tot FROM orders WHERE status = 'paid' GROUP BY city ORDER BY tot DESC LIMIT 5");
  eq(p.pipeline, [
    { $match: { status: 'paid' } },
    { _id: '$city', tot: { $sum: '$amount' } },
    { $project: { _id: 0, city: '$_id', tot: 1 } },
    { $sort: { tot: -1 } },
    { $limit: 5 },
  ]);
});

check('GROUP BY multiplo', () => {
  const p = translate('SELECT country, city, AVG(age) AS avg_age FROM users GROUP BY country, city');
  eq(p.pipeline, [
    { _id: { country: '$country', city: '$city' }, avg_age: { $avg: '$age' } },
    { $project: { _id: 0, country: '$_id.country', city: '$_id.city', avg_age: 1 } },
  ]);
});

console.log('SQL→MQL — errori attesi');

function throws(name, sql, rx) {
  check(name, () => {
    assert.throws(() => translate(sql), rx);
  });
}

throws('non-SELECT viene rifiutata', 'DELETE FROM users', /solo le query select/i);
throws('JOIN non supportato', 'SELECT * FROM a JOIN b ON a.x = b.y', /join/i);
throws('HAVING non supportato', 'SELECT city FROM t GROUP BY city HAVING COUNT(*) > 1', /having/i);
throws('colonna fuori da GROUP BY', 'SELECT name, COUNT(*) FROM t GROUP BY city', /group by/i);
throws('manca FROM', 'SELECT *', /from/i);
throws('identificatore non quotato come valore', 'SELECT * FROM t WHERE a = b', /apici|valore non valido/i);
throws('confronto colonna-colonna rifiutato', 'SELECT * FROM t WHERE a > other_col', /apici|valore non valido/i);
throws('identificatore non quotato dentro IN', 'SELECT * FROM t WHERE a IN (1, b, 3)', /apici|valore non valido/i);
throws('identificatore non quotato dentro NOT IN', 'SELECT * FROM t WHERE a NOT IN (x, y)', /apici|valore non valido/i);
throws('pattern LIKE non quotato', 'SELECT * FROM t WHERE name LIKE pattern', /apici|valore non valido/i);
throws('BETWEEN con estremo non quotato (basso)', 'SELECT * FROM t WHERE a BETWEEN x AND 5', /apici|valore non valido/i);
throws('BETWEEN con estremo non quotato (alto)', 'SELECT * FROM t WHERE a BETWEEN 1 AND hi', /apici|valore non valido/i);
throws('funzione come valore rifiutata', 'SELECT * FROM t WHERE a = UPPER(b)', /apici|valore non valido/i);
throws('letterale a sinistra del confronto rifiutato', 'SELECT * FROM t WHERE 5 = a', /identificatore/i);

check('TRUE/FALSE/NULL restano validi in una lista IN', () => {
  eq(translate('SELECT * FROM t WHERE a IN (TRUE, FALSE, NULL)').filter, { a: { $in: [true, false, null] } });
});
throws('aritmetica tra letterali non è tradotta come segno unario', 'SELECT * FROM t WHERE a = 1 - 2', /non riconosciuto/i);
throws('LIMIT negativo rifiutato', 'SELECT * FROM t LIMIT -5', /non può essere negativo/i);
throws('OFFSET negativo rifiutato', 'SELECT * FROM t LIMIT 10 OFFSET -3', /non può essere negativo/i);

console.log(`\n${passed} test superati.`);
if (process.exitCode) console.error('ALCUNI TEST FALLITI.');
