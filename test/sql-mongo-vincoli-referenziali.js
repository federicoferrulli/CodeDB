'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  async function all(sql) {
    await query(sql);
    if (pg) { await pg.query(sql); npg++; }
    if (my) { await my.query(sql); nmy++; }
    count++;
  }
  await all('CREATE TABLE genitori (id INT PRIMARY KEY, n INT)');
  await all('CREATE TABLE figli (id INT PRIMARY KEY, padre INT, FOREIGN KEY(padre) REFERENCES genitori(id) ON UPDATE CASCADE ON DELETE CASCADE)');
  await all('CREATE TABLE referenti (id INT PRIMARY KEY, padre INT REFERENCES genitori(id))');
  await all('INSERT INTO genitori(id,n) VALUES(1,10),(2,20)');
  await all('INSERT INTO figli(id,padre) VALUES(10,1),(20,2),(30,NULL)');
  // MySQL ignora REFERENCES inline: la prova negativa usa la forma di tabella,
  // che ha un vincolo effettivo anche sul DBMS di riferimento.
  if (my) await my.query('ALTER TABLE referenti ADD FOREIGN KEY(padre) REFERENCES genitori(id)');
  await all('INSERT INTO referenti(id,padre) VALUES(1,1)');
  for (const sql of ['INSERT INTO figli(id,padre) VALUES(40,999)', 'DELETE FROM genitori WHERE id=1', 'UPDATE genitori SET id=9 WHERE id=1']) {
    await query(sql, /FOREIGN KEY/);
    if (pg) { await assert.rejects(pg.query(sql)); npg++; }
    if (my) { await assert.rejects(my.query(sql)); nmy++; }
    assert.equal(await database.collection('genitori').countDocuments({ id: 1 }), 1); count++;
  }
  await all('UPDATE genitori SET id=3 WHERE id=2');
  await all('DELETE FROM genitori WHERE id=3');
  const rows = await query('SELECT id,padre FROM figli ORDER BY id');
  if (pg) { assert.deepEqual(rows, (await pg.query('SELECT id,padre FROM figli ORDER BY id')).rows); npg++; }
  if (my) { assert.deepEqual(rows, (await my.query('SELECT id,padre FROM figli ORDER BY id'))[0]); nmy++; }
  assert.deepEqual(rows, [{ id: 10, padre: 1 }, { id: 30, padre: null }]); count++;
  await all('CREATE TABLE opzionali (id INT PRIMARY KEY, padre INT, FOREIGN KEY(padre) REFERENCES genitori(id) ON DELETE SET NULL)');
  await all('INSERT INTO opzionali(id,padre) VALUES(1,1)');
  await all('DELETE FROM referenti WHERE id=1');
  await all('DELETE FROM genitori WHERE id=1');
  assert.deepEqual(await query('SELECT id,padre FROM opzionali'), [{ id: 1, padre: null }]); count++;
  await query('DROP TABLE genitori', /FOREIGN KEY/); count++;
  await query('TRUNCATE TABLE genitori', /FOREIGN KEY/); count++;
  await query('DROP INDEX genitori_primary_1 ON genitori', /vincolo SQL/); count++;
  console.log('  OK   FOREIGN KEY, RESTRICT, CASCADE e SET NULL, con rollback delle cascata già avviate');
  return { count, pg: npg, mysql: nmy };
};
