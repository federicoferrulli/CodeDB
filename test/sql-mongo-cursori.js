'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  async function all(text, ptext = text, mtext = text) {
    await query(text); count++;
    if (pg && ptext) { await pg.query(ptext); npg++; }
    if (my && mtext) { await my.query(mtext); nmy++; }
  }
  await all('CREATE TABLE sorgente_cursore(id INT PRIMARY KEY,n BIGINT)');
  await all('CREATE TABLE risultato_cursore(id INT,n BIGINT)');
  await all('INSERT INTO sorgente_cursore VALUES(1,10),(2,20),(3,30)');
  const mysql = `CREATE PROCEDURE leggi_cursore(IN p_min INT) BEGIN
    DECLARE finito BOOLEAN DEFAULT FALSE; DECLARE v_id INT; DECLARE v_n BIGINT;
    DECLARE lettura CURSOR FOR SELECT id,n FROM sorgente_cursore WHERE id>=p_min ORDER BY id;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET finito=TRUE;
    OPEN lettura;
    WHILE NOT finito DO
      FETCH lettura INTO v_id,v_n;
      IF NOT finito THEN INSERT INTO risultato_cursore VALUES(v_id,v_n); END IF;
    END WHILE;
    CLOSE lettura;
  END`;
  const postgres = `CREATE PROCEDURE leggi_cursore(IN p_min INT) LANGUAGE PLPGSQL AS $$
    DECLARE v_id INT; v_n BIGINT; lettura CURSOR FOR SELECT id,n FROM sorgente_cursore WHERE id>=p_min ORDER BY id;
    BEGIN OPEN lettura;
      LOOP FETCH NEXT FROM lettura INTO v_id,v_n; EXIT WHEN NOT FOUND;
        INSERT INTO risultato_cursore VALUES(v_id,v_n);
      END LOOP;
      CLOSE lettura;
    END;$$`;
  await all(mysql, postgres);
  await all('CALL leggi_cursore(2)');
  let expected = [{ id: 2, n: 20 }, { id: 3, n: 30 }];
  async function compare() {
    const text = 'SELECT id,n FROM risultato_cursore ORDER BY id,n', rows = await query(text);
    assert.deepEqual(rows, expected); count++;
    if (pg) { assert.deepEqual(rows, (await pg.query(text)).rows); npg++; }
    if (my) { assert.deepEqual(rows, (await my.query(text))[0]); nmy++; }
  }
  await compare(); await all('CALL leggi_cursore(99)'); await compare();
  await query(postgres.replace('leggi_cursore', 'leggi_pg')); count++;
  await query('CALL leggi_pg(3)'); count++;
  assert.deepEqual(await query('SELECT id,n FROM risultato_cursore ORDER BY id,n'), [...expected, { id: 3, n: 30 }]); count++;
  await query('DELETE FROM risultato_cursore WHERE id=3');
  await query('INSERT INTO risultato_cursore VALUES(3,30)');
  await all(`CREATE PROCEDURE esci_handler() BEGIN
    DECLARE v_id INT; DECLARE vuoto CURSOR FOR SELECT id FROM sorgente_cursore WHERE id>99;
    DECLARE EXIT HANDLER FOR NOT FOUND BEGIN INSERT INTO risultato_cursore VALUES(9,90); END;
    OPEN vuoto; FETCH vuoto INTO v_id; INSERT INTO risultato_cursore VALUES(10,100);
  END`, null);
  await all('CALL esci_handler()', null);
  expected.push({ id: 9, n: 90 });
  if (pg) await pg.query('INSERT INTO risultato_cursore VALUES(9,90)');
  await compare();
  await all(`CREATE PROCEDURE riapri() BEGIN
    DECLARE v_id INT; DECLARE lettura CURSOR FOR SELECT id FROM sorgente_cursore ORDER BY id;
    OPEN lettura; FETCH lettura INTO v_id; CLOSE lettura;
    OPEN lettura; FETCH lettura INTO v_id; CLOSE lettura;
    INSERT INTO risultato_cursore VALUES(10,v_id);
  END`, null);
  await all('CALL riapri()', null); expected.push({ id: 10, n: 1 });
  if (pg) await pg.query('INSERT INTO risultato_cursore VALUES(10,1)');
  await compare();
  await query('CREATE PROCEDURE cursore_chiuso() BEGIN DECLARE v_id INT; DECLARE c CURSOR FOR SELECT id FROM sorgente_cursore; INSERT INTO risultato_cursore VALUES(99,99); FETCH c INTO v_id; END'); count++;
  await query('CALL cursore_chiuso()', /non aperto/); count++;
  assert.equal(await database.collection('risultato_cursore').countDocuments({ id: 99 }), 0);
  await query('CREATE PROCEDURE doppio_open() BEGIN DECLARE c CURSOR FOR SELECT id FROM sorgente_cursore; OPEN c; OPEN c; END'); count++;
  await query('CALL doppio_open()', /già aperto/); count++;
  await query('CREATE PROCEDURE arita() BEGIN DECLARE v_id INT; DECLARE c CURSOR FOR SELECT id,n FROM sorgente_cursore; OPEN c; FETCH c INTO v_id; END'); count++;
  await query('CALL arita()', /numero di variabili/); count++;
  console.log('  OK   Cursori MySQL/PLpgSQL: OPEN/FETCH/CLOSE, parametri, FOUND, handler CONTINUE/EXIT, riapertura e rollback');
  return { count, pg: npg, mysql: nmy };
};
