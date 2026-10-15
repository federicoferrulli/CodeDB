'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  async function all(sql, pgSql = sql, mySql = sql) {
    await query(sql); count++;
    if (pg && pgSql) { await pg.query(pgSql); npg++; }
    if (my && mySql) { await my.query(mySql); nmy++; }
  }
  await all('CREATE TABLE eventi_trigger(id INT PRIMARY KEY,n INT)');
  await all('CREATE TABLE registro_trigger(id INT,evento TEXT,prima INT,dopo INT)');
  for (const [event, old, next, ret] of [['INSERT', 'NULL', 'NEW.n', 'NEW'], ['UPDATE', 'OLD.n', 'NEW.n', 'NEW'], ['DELETE', 'OLD.n', 'NULL', 'OLD']]) {
    const name = `tr_${event.toLowerCase()}`, body = `INSERT INTO registro_trigger(id,evento,prima,dopo) VALUES(${ret}.id,'${event}',${old},${next});`;
    await all(`CREATE TRIGGER ${name} AFTER ${event} ON eventi_trigger FOR EACH ROW BEGIN ${body} END`,
      `CREATE FUNCTION f_${name}() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN ${body} RETURN ${ret}; END;$$; CREATE TRIGGER ${name} AFTER ${event} ON eventi_trigger FOR EACH ROW EXECUTE FUNCTION f_${name}()`);
  }
  await all('INSERT INTO eventi_trigger VALUES(1,10),(2,20)');
  await all('UPDATE eventi_trigger SET n=n+1 WHERE id=1');
  await all('UPDATE eventi_trigger SET n=n WHERE id=2');
  await all('DELETE FROM eventi_trigger WHERE id=2');
  const text = 'SELECT id,evento,prima,dopo FROM registro_trigger ORDER BY id,evento';
  const rows = await query(text); assert.equal(rows.length, 5); count++;
  if (pg) { assert.deepEqual(rows, (await pg.query(text)).rows); npg++; }
  if (my) { assert.deepEqual(rows, (await my.query(text))[0]); nmy++; }
  await all("CREATE TRIGGER tr_rifiuta AFTER INSERT ON eventi_trigger FOR EACH ROW BEGIN IF NEW.n<0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='numero vietato'; END IF; END",
    "CREATE FUNCTION f_rifiuta() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN IF NEW.n<0 THEN RAISE EXCEPTION 'numero vietato'; END IF; RETURN NEW; END;$$; CREATE TRIGGER tr_rifiuta AFTER INSERT ON eventi_trigger FOR EACH ROW EXECUTE FUNCTION f_rifiuta()");
  await query('INSERT INTO eventi_trigger VALUES(3,30),(4,-1)', /numero vietato/); count++;
  if (pg) { await assert.rejects(pg.query('INSERT INTO eventi_trigger VALUES(3,30),(4,-1)'), /numero vietato/); npg++; }
  if (my) { await assert.rejects(my.query('INSERT INTO eventi_trigger VALUES(3,30),(4,-1)'), /numero vietato/); nmy++; }
  assert.deepEqual(await query(text), rows, 'Rollback comprende anche gli effetti dei trigger precedenti');
  assert.equal(await database.collection('eventi_trigger').countDocuments(), 1);
  await query('CREATE TRIGGER invalido AFTER UPDATE ON eventi_trigger FOR EACH ROW SET NEW.n=5', /sola lettura/); count++;
  await all('DROP TRIGGER tr_rifiuta ON eventi_trigger', undefined, 'DROP TRIGGER tr_rifiuta');
  await all('INSERT INTO eventi_trigger VALUES(4,-1)');
  await query('CREATE TRIGGER ricorsivo AFTER UPDATE ON eventi_trigger FOR EACH ROW UPDATE eventi_trigger SET n=n+1 WHERE id=NEW.id');
  await query('UPDATE eventi_trigger SET n=100 WHERE id=1', /32 chiamate/); count++;
  assert.equal((await database.collection('eventi_trigger').findOne({ id: 1 })).n, 11);
  await query('DROP TRIGGER ricorsivo ON eventi_trigger');
  await all('DELETE FROM registro_trigger');
  await all('INSERT INTO eventi_trigger VALUES(1,20),(1,30) ON DUPLICATE KEY UPDATE n=VALUES(n)',
    'INSERT INTO eventi_trigger VALUES(1,20) ON CONFLICT(id) DO UPDATE SET n=excluded.n; INSERT INTO eventi_trigger VALUES(1,30) ON CONFLICT(id) DO UPDATE SET n=excluded.n');
  const conflicts = await query('SELECT prima,dopo FROM registro_trigger ORDER BY dopo');
  assert.deepEqual(conflicts, [{ prima: 11, dopo: 20 }, { prima: 20, dopo: 30 }]); count++;
  if (pg) { assert.deepEqual(conflicts, (await pg.query('SELECT prima,dopo FROM registro_trigger ORDER BY dopo')).rows); npg++; }
  if (my) { assert.deepEqual(conflicts, (await my.query('SELECT prima,dopo FROM registro_trigger ORDER BY dopo'))[0]); nmy++; }
  await all('CREATE TABLE prima_trigger(id INT PRIMARY KEY,n INT CHECK(n>=0))');
  await all('CREATE TABLE vista_trigger(id INT,n INT)');
  await all('CREATE TRIGGER normalizza BEFORE INSERT ON prima_trigger FOR EACH ROW SET NEW.n=ABS(COALESCE(NEW.n,0))+1',
    'CREATE FUNCTION f_normalizza() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN NEW.n:=ABS(COALESCE(NEW.n,0))+1; RETURN NEW; END;$$; CREATE TRIGGER normalizza BEFORE INSERT ON prima_trigger FOR EACH ROW EXECUTE FUNCTION f_normalizza()');
  await all('CREATE TRIGGER correggi BEFORE UPDATE ON prima_trigger FOR EACH ROW BEGIN INSERT INTO vista_trigger SELECT id,n FROM prima_trigger WHERE id=OLD.id; SET NEW.n=NEW.n+1; END',
    'CREATE FUNCTION f_correggi() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN INSERT INTO vista_trigger SELECT id,n FROM prima_trigger WHERE id=OLD.id; NEW.n:=NEW.n+1; RETURN NEW; END;$$; CREATE TRIGGER correggi BEFORE UPDATE ON prima_trigger FOR EACH ROW EXECUTE FUNCTION f_correggi()');
  await all('INSERT INTO prima_trigger VALUES(1,-10),(2,NULL)');
  await all('UPDATE prima_trigger SET n=n+1 WHERE id=1');
  await all('INSERT INTO prima_trigger VALUES(1,20) ON DUPLICATE KEY UPDATE n=VALUES(n)', 'INSERT INTO prima_trigger VALUES(1,20) ON CONFLICT(id) DO UPDATE SET n=excluded.n');
  for (const [text, expected] of [
    ['SELECT id,n FROM prima_trigger ORDER BY id', [{ id: 1, n: 22 }, { id: 2, n: 1 }]],
    ['SELECT id,n FROM vista_trigger ORDER BY n', [{ id: 1, n: 11 }, { id: 1, n: 13 }]],
  ]) {
    const rows = await query(text); assert.deepEqual(rows, expected); count++;
    if (pg) { assert.deepEqual(rows, (await pg.query(text)).rows); npg++; }
    if (my) { assert.deepEqual(rows, (await my.query(text))[0]); nmy++; }
  }
  await query('CREATE TRIGGER old_vietato BEFORE UPDATE ON prima_trigger FOR EACH ROW SET OLD.n=5', /sola lettura/); count++;
  await all("CREATE TRIGGER blocca_prima BEFORE DELETE ON prima_trigger FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='non cancellare'",
    "CREATE FUNCTION f_blocca_prima() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN RAISE EXCEPTION 'non cancellare'; END;$$; CREATE TRIGGER blocca_prima BEFORE DELETE ON prima_trigger FOR EACH ROW EXECUTE FUNCTION f_blocca_prima()");
  await query('DELETE FROM prima_trigger WHERE id=1', /non cancellare/); count++;
  if (pg) { await assert.rejects(pg.query('DELETE FROM prima_trigger WHERE id=1'), /non cancellare/); npg++; }
  if (my) { await assert.rejects(my.query('DELETE FROM prima_trigger WHERE id=1'), /non cancellare/); nmy++; }
  assert.equal(await database.collection('prima_trigger').countDocuments(), 2);
  console.log('  OK   Trigger AFTER per riga: INSERT/UPDATE/DELETE, OLD/NEW, no-op, errore, rollback e limite di ricorsione');
  console.log('  OK   Trigger BEFORE: normalizzazione NEW prima dei CHECK, visibilità OLD, conflitti e annullamento DELETE');
  return { count, pg: npg, mysql: nmy };
};
