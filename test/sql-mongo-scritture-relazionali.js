'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  const coll = 'relazionali';
  await database.createCollection(coll);
  for (const c of [pg, my].filter(Boolean)) await c.query(`CREATE TABLE ${coll}(_id int PRIMARY KEY,n int)`);
  let count = 0, npg = 0, nmy = 0;
  async function compare(sql, pgSql = sql, mySql = sql) {
    await query(sql);
    if (pg) { await pg.query(pgSql); npg++; }
    if (my) { await my.query(mySql); nmy++; }
    const rows = await query(`SELECT _id,n FROM ${coll} ORDER BY _id`);
    if (pg) assert.deepEqual(rows, (await pg.query(`SELECT _id,n FROM ${coll} ORDER BY _id`)).rows, sql);
    if (my) assert.deepEqual(rows, (await my.query(`SELECT _id,n FROM ${coll} ORDER BY _id`))[0], sql);
    count++;
  }
  await compare('INSERT INTO relazionali(_id,n) SELECT id,n FROM t');
  await compare('INSERT INTO relazionali(_id,n) SELECT id+10,n FROM t EXCEPT SELECT id+10,n FROM t WHERE id>2');
  await compare('UPDATE relazionali r SET n=t.n+1 FROM t WHERE r._id=t.id', undefined,
    'UPDATE relazionali r JOIN t ON r._id=t.id SET r.n=t.n+1');
  await compare('UPDATE relazionali r JOIN t ON r._id=t.id SET r.n=t.n+2',
    'UPDATE relazionali r SET n=t.n+2 FROM t WHERE r._id=t.id');
  await compare('UPDATE relazionali SET n=(SELECT MAX(t.n) FROM t WHERE t.id=relazionali._id) WHERE _id<10');
  await compare('DELETE FROM relazionali r USING t WHERE r._id=t.id AND t.id=4', undefined,
    'DELETE r FROM relazionali r JOIN t ON r._id=t.id WHERE t.id=4');
  await compare('DELETE r FROM relazionali r JOIN t ON r._id=t.id WHERE t.id=3',
    'DELETE FROM relazionali r USING t WHERE r._id=t.id AND t.id=3');
  await compare('INSERT INTO relazionali(_id,n) SELECT id,n FROM t WHERE id=999');
  const before = await query('SELECT _id,n FROM relazionali ORDER BY _id');
  await query('INSERT INTO relazionali(_id,n) SELECT id,n FROM t', /duplic|E11000/i);
  assert.deepEqual(await query('SELECT _id,n FROM relazionali ORDER BY _id'), before); count++;
  await query('UPDATE relazionali r JOIN t ON r._id=t.id SET r.n=1/0', /zero|divide/i);
  assert.deepEqual(await query('SELECT _id,n FROM relazionali ORDER BY _id'), before); count++;
  console.log('  OK   INSERT SELECT, insiemi nelle transazioni, UPDATE/DELETE con sorgenti e rollback');
  return { count, pg: npg, mysql: nmy };
};
