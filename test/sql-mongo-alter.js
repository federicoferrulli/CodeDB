'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  async function all(sql, pgSql = sql, mySql = sql) {
    await query(sql); count++;
    if (pg && pgSql) { await pg.query(pgSql); npg++; }
    if (my && mySql) { await my.query(mySql); nmy++; }
  }
  async function rows(sql) {
    const actual = await query(sql); count++;
    if (pg) { assert.deepEqual(actual, (await pg.query(sql)).rows); npg++; }
    if (my) { assert.deepEqual(actual, (await my.query(sql))[0]); nmy++; }
    return actual;
  }
  await all('CREATE TABLE evoluzione (id INT PRIMARY KEY, n INT, testo VARCHAR(30))');
  await all("INSERT INTO evoluzione VALUES(1,10,'uno'),(2,20,'due')");
  await all('ALTER TABLE evoluzione ADD COLUMN extra INT NOT NULL DEFAULT 7');
  await all("ALTER TABLE evoluzione ADD COLUMN parentesi VARCHAR(3) DEFAULT '(', ADD COLUMN z INT");
  assert.deepEqual(await rows('SELECT id,parentesi FROM evoluzione ORDER BY id'), [{ id: 1, parentesi: '(' }, { id: 2, parentesi: '(' }]);
  await all('ALTER TABLE evoluzione DROP COLUMN parentesi, DROP COLUMN z');
  assert.deepEqual(await rows('SELECT id,extra FROM evoluzione ORDER BY id'), [{ id: 1, extra: 7 }, { id: 2, extra: 7 }]);
  await all('ALTER TABLE evoluzione ALTER COLUMN extra SET DEFAULT 9');
  await all("INSERT INTO evoluzione(id,n,testo) VALUES(3,30,'tre')");
  assert.deepEqual(await rows('SELECT id,extra FROM evoluzione ORDER BY id'), [{ id: 1, extra: 7 }, { id: 2, extra: 7 }, { id: 3, extra: 9 }]);
  await all('ALTER TABLE evoluzione ADD CONSTRAINT n_positivo CHECK(n>0)');
  await query('UPDATE evoluzione SET n=-1', /valid|schema/i); count++;
  await all('ALTER TABLE evoluzione RENAME COLUMN n TO numero', undefined,
    'ALTER TABLE evoluzione DROP CHECK n_positivo; ALTER TABLE evoluzione RENAME COLUMN n TO numero; ALTER TABLE evoluzione ADD CONSTRAINT n_positivo CHECK(numero>0)');
  await all('ALTER TABLE evoluzione ALTER COLUMN numero TYPE BIGINT', undefined, 'ALTER TABLE evoluzione MODIFY COLUMN numero BIGINT');
  await rows('SELECT id,numero FROM evoluzione ORDER BY id');
  await query('UPDATE evoluzione SET numero=-1', /valid|schema/i); count++;
  const before = await rows('SELECT id,numero,testo,extra FROM evoluzione ORDER BY id');
  for (const command of [
    'ALTER TABLE evoluzione ADD COLUMN obbligatorio INT NOT NULL',
    'ALTER TABLE evoluzione ADD CONSTRAINT extra_unico UNIQUE(extra)',
    'ALTER TABLE evoluzione ADD CONSTRAINT troppo_stretto CHECK(numero<15)',
    'ALTER TABLE evoluzione ALTER COLUMN testo TYPE VARCHAR(2)',
  ]) {
    await query(command, /schema|valid|duplic|E11000/i); count++;
    assert.deepEqual(await query('SELECT id,numero,testo,extra FROM evoluzione ORDER BY id'), before);
    assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(), 0, 'Il recupero deve chiudere il registro');
    await query('UPDATE evoluzione SET extra=extra WHERE id=1');
  }
  await all('ALTER TABLE evoluzione ADD CONSTRAINT numero_unico UNIQUE(numero)');
  await query('UPDATE evoluzione SET numero=10 WHERE id=2', /duplic|E11000/i); count++;
  await all('ALTER TABLE evoluzione DROP CONSTRAINT numero_unico', undefined, 'ALTER TABLE evoluzione DROP INDEX numero_unico');
  await all('ALTER TABLE evoluzione DROP CONSTRAINT n_positivo', undefined, 'ALTER TABLE evoluzione DROP CHECK n_positivo');
  await all('ALTER TABLE evoluzione DROP COLUMN testo');
  await all('ALTER TABLE evoluzione ALTER COLUMN extra DROP DEFAULT');
  await all('ALTER TABLE evoluzione ALTER COLUMN extra DROP NOT NULL', undefined, 'ALTER TABLE evoluzione MODIFY COLUMN extra INT NULL');
  await all('INSERT INTO evoluzione(id,numero) VALUES(4,-4)');
  await rows('SELECT id,numero,extra FROM evoluzione ORDER BY id');
  await all('CREATE TABLE alter_padre(id INT PRIMARY KEY)');
  await all('CREATE TABLE alter_figlio(id INT PRIMARY KEY,pid INT)');
  await all('INSERT INTO alter_padre VALUES(1)');
  await all('INSERT INTO alter_figlio VALUES(1,1)');
  await all('ALTER TABLE alter_figlio ADD CONSTRAINT fk_alter FOREIGN KEY(pid) REFERENCES alter_padre(id) ON DELETE CASCADE');
  await query('INSERT INTO alter_figlio VALUES(2,99)', /FOREIGN KEY/); count++;
  await query('db.alter_figlio.insertOne({id:2,pid:99})', /FOREIGN KEY/); count++;
  await query('db.alter_figlio.updateOne({id:1},{$set:{pid:99}})', /FOREIGN KEY/); count++;
  await query('ALTER TABLE alter_padre DROP COLUMN id', /almeno una colonna|FOREIGN KEY/); count++;
  await all('DELETE FROM alter_padre WHERE id=1');
  assert.deepEqual(await rows('SELECT id,pid FROM alter_figlio'), []);
  await all('ALTER TABLE alter_figlio DROP CONSTRAINT fk_alter', undefined, 'ALTER TABLE alter_figlio DROP FOREIGN KEY fk_alter');
  await all('INSERT INTO alter_figlio VALUES(2,99)');
  await rows('SELECT id,pid FROM alter_figlio');
  await query('ALTER TABLE alter_figlio ADD CONSTRAINT fk_invalida FOREIGN KEY(pid) REFERENCES alter_padre(id)', /FOREIGN KEY/); count++;
  assert.deepEqual(await query('SELECT id,pid FROM alter_figlio'), [{ id: 2, pid: 99 }]);
  await query('ALTER TABLE evoluzione CHANGE COLUMN numero valore BIGINT');
  assert.deepEqual(await query('SELECT valore FROM evoluzione WHERE id=4'), [{ valore: -4 }]); count++;
  console.log('  OK   ALTER TABLE: dati preesistenti, default, rinomina, tipi, indici, CHECK, FK e ripristino dopo errore');
  return { count, pg: npg, mysql: nmy };
};
