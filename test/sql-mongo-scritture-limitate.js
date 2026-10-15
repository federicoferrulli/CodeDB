'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  await database.collection('limitate').insertMany([{ _id: 1, n: 10 }, { _id: 2, n: 20 }, { _id: 3, n: 30 }]);
  for (const connection of [pg, my].filter(Boolean)) {
    await connection.query('CREATE TABLE limitate(_id int PRIMARY KEY,n int)');
    await connection.query('INSERT INTO limitate VALUES(1,10),(2,20),(3,30)');
  }
  const cases = [
    ['UPDATE limitate SET n=n+1 ORDER BY _id DESC LIMIT 1', 'UPDATE limitate SET n=n+1 WHERE _id IN(SELECT _id FROM limitate ORDER BY _id DESC LIMIT 1)', 1],
    ['DELETE FROM limitate WHERE n>10 ORDER BY _id LIMIT 1', 'DELETE FROM limitate WHERE _id IN(SELECT _id FROM limitate WHERE n>10 ORDER BY _id LIMIT 1)', 1],
    ['UPDATE limitate SET n=0 LIMIT 0', 'UPDATE limitate SET n=0 WHERE FALSE', 0],
    ['DELETE FROM limitate LIMIT 0', 'DELETE FROM limitate WHERE FALSE', 0],
  ];
  for (const [sql, postgres, count] of cases) {
    const result = await query(sql);
    assert.equal(result[0].affectedRows, count, sql);
    if (pg) await pg.query(postgres);
    if (my) await my.query(sql);
    const rows = await query('SELECT _id,n FROM limitate ORDER BY _id');
    if (pg) assert.deepEqual(rows, (await pg.query('SELECT _id,n FROM limitate ORDER BY _id')).rows);
    if (my) assert.deepEqual(rows, (await my.query('SELECT _id,n FROM limitate ORDER BY _id'))[0]);
  }
  assert.deepEqual(await query('UPDATE limitate SET n=n+1 ORDER BY _id DESC LIMIT 1 RETURNING _id,n'), [{ _id: 3, n: 32 }]);
  assert.deepEqual(await query('DELETE FROM limitate ORDER BY _id LIMIT 1 RETURNING _id,n'), [{ _id: 1, n: 10 }]);
  await query('UPDATE limitate SET n=999 LIMIT 1 RETURNING (SELECT id FROM t) AS errore', /Sottoquery scalare/i);
  assert.deepEqual(await query('SELECT _id,n FROM limitate'), [{ _id: 3, n: 32 }]);
  console.log('  OK   ORDER/LIMIT sulle scritture: quattro confronti con i DB SQL, limite zero, RETURNING e rollback');
  return { count: 7, pg: pg ? 4 : 0, mysql: my ? 4 : 0 };
};
