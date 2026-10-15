'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  async function all(text, ptext = text, mtext = text) {
    await query(text); count++;
    if (pg && ptext) { await pg.query(ptext); npg++; }
    if (my && mtext) { await my.query(mtext); nmy++; }
  }
  async function rows(text, expected, ptext = text, mtext = text) {
    assert.deepEqual(await query(text), expected); count++;
    if (pg && ptext) { assert.deepEqual((await pg.query(ptext)).rows, expected); npg++; }
    if (my && mtext) { assert.deepEqual((await my.query(mtext))[0], expected); nmy++; }
  }
  async function invalid(text, pattern) {
    await query(text, pattern); count++;
    if (text.startsWith('ALTER')) assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(), 0, 'Il recupero deve essere completo');
  }
  await all('CREATE TABLE varianti(id INT PRIMARY KEY,n INT,CONSTRAINT ck_var CHECK(n>=0),CONSTRAINT uq_var UNIQUE(n))');
  await all('INSERT INTO varianti VALUES(1,10)');
  await all('ALTER TABLE varianti RENAME CONSTRAINT ck_var TO ck_nuovo', undefined,
    'ALTER TABLE varianti DROP CHECK ck_var,ADD CONSTRAINT ck_nuovo CHECK(n>=0)');
  await all('ALTER TABLE varianti RENAME INDEX uq_var TO uq_nuovo', 'ALTER TABLE varianti RENAME CONSTRAINT uq_var TO uq_nuovo');
  await invalid('UPDATE varianti SET n=-1', /valid|schema/i);
  await invalid('INSERT INTO varianti VALUES(2,10)', /duplic|E11000/i);
  await invalid('ALTER TABLE varianti DROP CHECK uq_nuovo', /inesistente/i);
  await invalid('ALTER TABLE varianti RENAME CONSTRAINT ck_nuovo TO uq_nuovo', /duplic/i);
  await all('CREATE INDEX ix_var ON varianti(n)');
  await all('CREATE INDEX ck_nuovo ON varianti(id,n)');
  await all('ALTER TABLE varianti RENAME KEY ix_var TO ix_nuovo', 'ALTER INDEX ix_var RENAME TO ix_nuovo');
  assert.ok((await database.collection('varianti').listIndexes().toArray()).some(i => i.name === 'ix_nuovo'));
  assert.ok((await database.collection('varianti').listIndexes().toArray()).some(i => i.name === 'ck_nuovo'), 'Un indice con lo stesso nome di un CHECK deve restare distinto dal vincolo');
  await invalid('ALTER TABLE varianti RENAME INDEX ix_nuovo TO uq_nuovo', /utilizzato/i);
  await invalid('ALTER TABLE varianti RENAME INDEX assente TO fantasma', /inesistente/i);
  // Un errore dopo aver rinominato l'indice deve recuperare il nome originale.
  await invalid('ALTER TABLE varianti RENAME INDEX ix_nuovo TO ix_fallito,ADD CONSTRAINT impossibile CHECK(n<0)', /schema/i);
  const indexes = await database.collection('varianti').listIndexes().toArray();
  assert.ok(indexes.some(i => i.name === 'ix_nuovo')); assert.ok(!indexes.some(i => i.name === 'ix_fallito'));
  await all('ALTER TABLE varianti ADD COLUMN IF NOT EXISTS n TEXT', undefined, null);
  await all('ALTER TABLE varianti ADD COLUMN IF NOT EXISTS extra INT DEFAULT 7', undefined, 'ALTER TABLE varianti ADD COLUMN extra INT DEFAULT 7');
  await rows('SELECT id,n,extra FROM varianti', [{ id: 1, n: 10, extra: 7 }]);
  await all('ALTER TABLE varianti ALTER COLUMN extra SET DATA TYPE BIGINT USING extra+1', undefined, 'ALTER TABLE varianti MODIFY COLUMN extra BIGINT; UPDATE varianti SET extra=extra+1');
  await rows('SELECT extra FROM varianti', [{ extra: 8 }]);
  await all('ALTER TABLE varianti DROP CHECK ck_nuovo', 'ALTER TABLE varianti DROP CONSTRAINT ck_nuovo');
  await all('UPDATE varianti SET n=-1');
  await rows('SELECT n FROM varianti', [{ n: -1 }]);
  console.log('  OK   Varianti ALTER: rinomina vincoli/indici, collisioni, recupero, IF NOT EXISTS, SET DATA TYPE, DROP CHECK');

  await all('CREATE TABLE cond_trigger(id INT PRIMARY KEY,n INT)');
  await all('CREATE TABLE cond_log(id INT,prima INT,dopo INT)');
  const first = 'CREATE TRIGGER a_correggi BEFORE INSERT OR UPDATE ON cond_trigger FOR EACH ROW WHEN (NEW.n<0) SET NEW.n=ABS(NEW.n)';
  await all(first, 'CREATE FUNCTION f_cond_prima() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN NEW.n:=ABS(NEW.n); RETURN NEW; END;$$; CREATE TRIGGER a_correggi BEFORE INSERT OR UPDATE ON cond_trigger FOR EACH ROW WHEN (NEW.n<0) EXECUTE FUNCTION f_cond_prima()',
    'CREATE TRIGGER a_correggi BEFORE INSERT ON cond_trigger FOR EACH ROW BEGIN IF NEW.n<0 THEN SET NEW.n=ABS(NEW.n); END IF; END; CREATE TRIGGER a_correggi_up BEFORE UPDATE ON cond_trigger FOR EACH ROW BEGIN IF NEW.n<0 THEN SET NEW.n=ABS(NEW.n); END IF; END');
  await all('CREATE TRIGGER b_incrementa BEFORE INSERT OR UPDATE ON cond_trigger FOR EACH ROW WHEN (NEW.n=3) SET NEW.n=NEW.n+1',
    'CREATE FUNCTION f_cond_inc() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN NEW.n:=NEW.n+1; RETURN NEW; END;$$; CREATE TRIGGER b_incrementa BEFORE INSERT OR UPDATE ON cond_trigger FOR EACH ROW WHEN (NEW.n=3) EXECUTE FUNCTION f_cond_inc()',
    'CREATE TRIGGER b_incrementa BEFORE INSERT ON cond_trigger FOR EACH ROW BEGIN IF NEW.n=3 THEN SET NEW.n=NEW.n+1; END IF; END; CREATE TRIGGER b_incrementa_up BEFORE UPDATE ON cond_trigger FOR EACH ROW BEGIN IF NEW.n=3 THEN SET NEW.n=NEW.n+1; END IF; END');
  await all('CREATE TRIGGER cond_dopo AFTER UPDATE ON cond_trigger FOR EACH ROW WHEN (OLD.n IS DISTINCT FROM NEW.n) INSERT INTO cond_log VALUES(NEW.id,OLD.n,NEW.n)',
    'CREATE FUNCTION f_cond_dopo() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN INSERT INTO cond_log VALUES(NEW.id,OLD.n,NEW.n); RETURN NEW; END;$$; CREATE TRIGGER cond_dopo AFTER UPDATE ON cond_trigger FOR EACH ROW WHEN (OLD.n IS DISTINCT FROM NEW.n) EXECUTE FUNCTION f_cond_dopo()',
    'CREATE TRIGGER cond_dopo AFTER UPDATE ON cond_trigger FOR EACH ROW BEGIN IF NOT (OLD.n <=> NEW.n) THEN INSERT INTO cond_log VALUES(NEW.id,OLD.n,NEW.n); END IF; END');
  await all('INSERT INTO cond_trigger VALUES(1,-3),(2,NULL)');
  await rows('SELECT id,n FROM cond_trigger ORDER BY id', [{ id: 1, n: 4 }, { id: 2, n: null }]);
  await all('UPDATE cond_trigger SET n=n');
  await rows('SELECT id,prima,dopo FROM cond_log', []);
  await all('UPDATE cond_trigger SET n=-5 WHERE id=2');
  await rows('SELECT id,prima,dopo FROM cond_log', [{ id: 2, prima: null, dopo: 5 }]);
  await rows('SELECT NULL IS DISTINCT FROM NULL AS a,1 IS DISTINCT FROM NULL AS b,1 IS NOT DISTINCT FROM 1 AS c', [{ a: false, b: true, c: true }], undefined, null);
  await invalid('CREATE TRIGGER cond_err AFTER INSERT OR DELETE ON cond_trigger FOR EACH ROW WHEN (NEW.n>0) INSERT INTO cond_log VALUES(1,1,1)', /non disponibile/);
  await invalid('CREATE TRIGGER cond_err AFTER UPDATE ON cond_trigger FOR EACH ROW WHEN (n>0) INSERT INTO cond_log VALUES(1,1,1)', /OLD o NEW/);
  await invalid('CREATE TRIGGER cond_err AFTER UPDATE OR UPDATE ON cond_trigger FOR EACH ROW INSERT INTO cond_log VALUES(1,1,1)', /duplicato/);
  await all('CREATE TRIGGER tutti_eventi AFTER INSERT OR UPDATE OR DELETE ON cond_trigger FOR EACH ROW INSERT INTO cond_log SELECT COALESCE(NEW.id,OLD.id),OLD.n,NEW.n',
    'CREATE FUNCTION f_tutti_eventi() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN INSERT INTO cond_log VALUES(COALESCE(NEW.id,OLD.id),OLD.n,NEW.n); RETURN COALESCE(NEW,OLD); END;$$; CREATE TRIGGER tutti_eventi AFTER INSERT OR UPDATE OR DELETE ON cond_trigger FOR EACH ROW EXECUTE FUNCTION f_tutti_eventi()', null);
  await all('DELETE FROM cond_log');
  await all('INSERT INTO cond_trigger VALUES(3,9)', undefined, null);
  await all('UPDATE cond_trigger SET n=n WHERE id=3', undefined, null);
  await all('DELETE FROM cond_trigger WHERE id=3', undefined, null);
  await rows('SELECT id,prima,dopo FROM cond_log ORDER BY prima NULLS FIRST,dopo NULLS LAST',
    [{ id: 3, prima: null, dopo: 9 }, { id: 3, prima: 9, dopo: 9 }, { id: 3, prima: 9, dopo: null }], undefined, null);
  console.log('  OK   WHEN, NULL, NEW modificato dal trigger precedente, eventi multipli e IS DISTINCT FROM');

  await all('CREATE TABLE ordine_trigger(id INT PRIMARY KEY,n INT)');
  await all('CREATE TRIGGER z_base BEFORE INSERT ON ordine_trigger FOR EACH ROW SET NEW.n=NEW.n*10+1', null);
  await all('CREATE TRIGGER a_dopo BEFORE INSERT ON ordine_trigger FOR EACH ROW FOLLOWS z_base SET NEW.n=NEW.n*10+2', null);
  await all('CREATE TRIGGER m_prima BEFORE INSERT ON ordine_trigger FOR EACH ROW PRECEDES a_dopo SET NEW.n=NEW.n*10+3', null);
  await all('INSERT INTO ordine_trigger VALUES(1,0)', null);
  await rows('SELECT n FROM ordine_trigger WHERE id=1', [{ n: 132 }], null);
  await all('DROP TRIGGER z_base ON ordine_trigger', null, 'DROP TRIGGER z_base');
  await all('INSERT INTO ordine_trigger VALUES(2,0)', null);
  await rows('SELECT n FROM ordine_trigger WHERE id=2', [{ n: 32 }], null);
  await invalid('CREATE TRIGGER non_valido BEFORE UPDATE ON ordine_trigger FOR EACH ROW FOLLOWS a_dopo SET NEW.n=0', /stessa tabella/);
  console.log('  OK   Ordine FOLLOWS/PRECEDES confrontato con MySQL e conservato dopo DROP del riferimento');

  await all('CREATE TABLE handler_log(n INT)');
  const routine = `CREATE PROCEDURE condizioni() BEGIN
    DECLARE n INT DEFAULT 0;
    DECLARE specifica CONDITION FOR SQLSTATE '45001';
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET n=n+100;
    DECLARE CONTINUE HANDLER FOR specifica,SQLSTATE '45002' IF n=0 THEN SET n=1; ELSE SET n=n+2; END IF;
    DECLARE CONTINUE HANDLER FOR SQLWARNING SET n=n+10;
    SIGNAL specifica; SIGNAL SQLSTATE '45002'; SIGNAL SQLSTATE '01000'; SIGNAL SQLSTATE '45003';
    INSERT INTO handler_log VALUES(n);
  END`;
  await all(routine, null); await all('CALL condizioni()', null);
  await rows('SELECT n FROM handler_log', [{ n: 113 }], null);
  await all(`CREATE PROCEDURE uscita_condizione() BEGIN
    DECLARE EXIT HANDLER FOR SQLSTATE '45004' INSERT INTO handler_log VALUES(4);
    IF TRUE THEN SIGNAL SQLSTATE '45004'; END IF;
    INSERT INTO handler_log VALUES(999);
  END`, null);
  await all('CALL uscita_condizione()', null);
  await all("CREATE PROCEDURE rilancia() BEGIN DECLARE EXIT HANDLER FOR SQLSTATE '45005' RESIGNAL SQLSTATE '45006' SET MESSAGE_TEXT='rilanciato'; IF TRUE THEN SIGNAL SQLSTATE '45005'; END IF; END", null);
  await all("CREATE PROCEDURE intercetta() BEGIN DECLARE CONTINUE HANDLER FOR SQLSTATE '45006' INSERT INTO handler_log VALUES(6); CALL rilancia(); INSERT INTO handler_log VALUES(7); END", null);
  await all('CALL intercetta()', null);
  await all("CREATE PROCEDURE stesso_stato() BEGIN DECLARE EXIT HANDLER FOR SQLSTATE '45008' BEGIN INSERT INTO handler_log VALUES(9); RESIGNAL; END; IF TRUE THEN SIGNAL SQLSTATE '45008'; END IF; END", null);
  await all("CREATE PROCEDURE esterno() BEGIN DECLARE CONTINUE HANDLER FOR SQLSTATE '45008' INSERT INTO handler_log VALUES(10); CALL stesso_stato(); END", null);
  await all('CALL esterno()', null);
  await all("CREATE PROCEDURE avviso_libero() BEGIN SIGNAL SQLSTATE '01001'; INSERT INTO handler_log VALUES(8); END", null);
  await all('CALL avviso_libero()', null);
  await rows('SELECT n FROM handler_log ORDER BY n', [{ n: 4 }, { n: 6 }, { n: 7 }, { n: 8 }, { n: 9 }, { n: 10 }, { n: 113 }], null);
  await invalid("CREATE PROCEDURE duplicata() BEGIN DECLARE CONTINUE HANDLER FOR NOT FOUND SET x=1; DECLARE CONTINUE HANDLER FOR NOT FOUND SET x=2; END", /duplicato|sconosciuta/);
  await invalid("CREATE PROCEDURE stato_errato() BEGIN SIGNAL SQLSTATE '00000'; END", /SQLSTATE/);
  await all('CREATE PROCEDURE fuori_handler() BEGIN RESIGNAL; END', null);
  await invalid('CALL fuori_handler()', /handler attivo/);
  if (my) { await assert.rejects(my.query('CALL fuori_handler()'), /handler/i); nmy++; }
  await query("CREATE TRIGGER errore_in_scrittura AFTER INSERT ON cond_trigger FOR EACH ROW SIGNAL SQLSTATE '45007' SET MESSAGE_TEXT='rifiuto riga'");
  await query("CREATE PROCEDURE errore_atomico() BEGIN DECLARE CONTINUE HANDLER FOR SQLEXCEPTION INSERT INTO handler_log VALUES(999); INSERT INTO cond_trigger VALUES(8,8); END");
  await query('CALL errore_atomico()'); count++;
  assert.equal(await database.collection('cond_trigger').countDocuments({ id: 8 }), 0);
  assert.equal(await database.collection('handler_log').countDocuments({ n: 999 }), 1);
  console.log('  OK   Handler SQLSTATE/classi/nominati, precedenza, CONTINUE/EXIT, RESIGNAL annidato e rollback su trigger fallito');
  return { count, pg: npg, mysql: nmy };
};
