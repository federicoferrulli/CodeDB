'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  for (const table of ['conflittipg', 'conflittimy']) {
    await database.collection(table).createIndex({ id: 1 }, { unique: true });
    await database.collection(table).insertOne({ id: 1, n: 10, altro: 0 });
    const connection = table.endsWith('pg') ? pg : my;
    if (connection) {
      await connection.query(`CREATE TABLE ${table}(id int PRIMARY KEY,n int,altro int)`);
      await connection.query(`INSERT INTO ${table} VALUES(1,10,0)`);
    }
  }
  const pgCases = [
    'INSERT INTO conflittipg(id,n,altro) VALUES(1,99,0) ON CONFLICT DO NOTHING RETURNING id,n,altro',
    'INSERT INTO conflittipg(id,n,altro) VALUES(1,20,0),(2,30,0) ON CONFLICT(id) DO UPDATE SET n=excluded.n WHERE conflittipg.n<excluded.n RETURNING id,n,altro',
    'INSERT INTO conflittipg(id,n,altro) VALUES(1,5,0) ON CONFLICT(id) DO UPDATE SET n=excluded.n WHERE conflittipg.n<excluded.n RETURNING id,n,altro',
    'INSERT INTO conflittipg(id,n,altro) VALUES(1,50,0) ON CONFLICT(id) DO UPDATE SET n=excluded.n,altro=conflittipg.n RETURNING id,n,altro',
  ];
  for (const sql of pgCases) {
    const rows = await query(sql);
    if (pg) assert.deepEqual(rows.sort((a, b) => a.id-b.id), (await pg.query(sql)).rows.sort((a, b) => a.id-b.id), sql);
  }
  const snapshot = await query('SELECT id,n,altro FROM conflittipg ORDER BY id');
  const double = 'INSERT INTO conflittipg(id,n,altro) VALUES(1,99,0),(1,999,0) ON CONFLICT(id) DO UPDATE SET n=excluded.n RETURNING id';
  await query(double, /stessa riga due volte/);
  if (pg) await assert.rejects(pg.query(double), /second time/);
  await query('INSERT INTO conflittipg(id,n) VALUES(3,3) ON CONFLICT(n) DO NOTHING', /indice univoco/);
  await query('INSERT INTO conflittipg(id,n) VALUES(1,999) ON CONFLICT(id) DO UPDATE SET n=excluded.n RETURNING 1/0 AS errore', /zero|divide/i);
  assert.deepEqual(await query('SELECT id,n,altro FROM conflittipg ORDER BY id'), snapshot);
  for (const sql of [
    'INSERT INTO conflittimy(id,n,altro) VALUES(1,20,0),(2,30,0) ON DUPLICATE KEY UPDATE n=VALUES(n),altro=n',
    'INSERT INTO conflittimy(id,n,altro) VALUES(1,40,0),(1,50,0) ON DUPLICATE KEY UPDATE n=VALUES(n),altro=n+1',
  ]) {
    await query(sql);
    if (my) await my.query(sql);
    const rows = await query('SELECT id,n,altro FROM conflittimy ORDER BY id');
    if (my) assert.deepEqual(rows, (await my.query('SELECT id,n,altro FROM conflittimy ORDER BY id'))[0]);
  }
  assert.deepEqual(await query('SELECT id,n,altro FROM conflittimy ORDER BY id'), [{ id: 1, n: 50, altro: 51 }, { id: 2, n: 30, altro: 0 }]);
  console.log('  OK   Conflitti PostgreSQL/MySQL: vincoli, esclusioni, SET simultanea/sequenziale e rollback');
  return { count: 10, pg: pg ? 4 : 0, mysql: my ? 2 : 0 };
};
