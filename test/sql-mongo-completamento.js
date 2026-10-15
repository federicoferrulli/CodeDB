'use strict';
const assert = require('node:assert/strict');
module.exports = async ({ query, database, strategy, base, pg, my }) => {
  let count = 0, npg = 0, nmy = 0;
  const all = async (text, ptext = text, mtext = text) => {
    await query(text); count++;
    if (pg && ptext) { await pg.query(ptext); npg++; }
    if (my && mtext) { await my.query(mtext); nmy++; }
  };
  const rows = async (text, expected, ptext = text, mtext = text) => {
    assert.deepEqual(await query(text), expected); count++;
    if (pg && ptext) { assert.deepEqual((await pg.query(ptext)).rows, expected); npg++; }
    if (my && mtext) { assert.deepEqual((await my.query(mtext))[0], expected); nmy++; }
  };
  await all('CREATE TABLE sp_dati(id INT PRIMARY KEY,n INT UNIQUE,CONSTRAINT positivo CHECK(n>0))');
  await all('CREATE TABLE sp_log(id INT,n INT)');
  await all('INSERT INTO sp_dati VALUES(1,10)');
  await all(`CREATE PROCEDURE sp_vincoli() BEGIN
    DECLARE CONTINUE HANDLER FOR SQLSTATE '23000',SQLSTATE 'HY000' INSERT INTO sp_log VALUES(1,1);
    INSERT INTO sp_dati VALUES(2,20);
    INSERT INTO sp_dati VALUES(3,30),(4,10);
    INSERT INTO sp_dati VALUES(5,-1);
    INSERT INTO sp_dati VALUES(6,60);
  END`, null);
  await all('CALL sp_vincoli()', null);
  await rows('SELECT id,n FROM sp_dati ORDER BY id', [{ id: 1, n: 10 }, { id: 2, n: 20 }, { id: 6, n: 60 }], null);
  await rows('SELECT id,n FROM sp_log', [{ id: 1, n: 1 }, { id: 1, n: 1 }], null);
  await all(`CREATE TRIGGER sp_rifiuta AFTER INSERT ON sp_dati FOR EACH ROW BEGIN
    INSERT INTO sp_log VALUES(NEW.id,NEW.n);
    IF NEW.id=8 THEN SIGNAL SQLSTATE '45001' SET MESSAGE_TEXT='riga rifiutata'; END IF;
  END`, null);
  await all(`CREATE PROCEDURE sp_trigger() BEGIN
    DECLARE CONTINUE HANDLER FOR SQLSTATE '45001' INSERT INTO sp_log VALUES(99,99);
    INSERT INTO sp_dati VALUES(7,70),(8,80);
    INSERT INTO sp_dati VALUES(9,90);
  END`, null);
  await all('CALL sp_trigger()', null);
  await rows('SELECT id FROM sp_dati ORDER BY id', [{ id: 1 }, { id: 2 }, { id: 6 }, { id: 9 }], null);
  await rows('SELECT id FROM sp_log ORDER BY id', [{ id: 1 }, { id: 1 }, { id: 9 }, { id: 99 }], null);
  await all(`CREATE PROCEDURE sp_espliciti() BEGIN
    SAVEPOINT primo; UPDATE sp_dati SET n=n+1; SAVEPOINT secondo;
    DELETE FROM sp_dati WHERE id=2; ROLLBACK TO secondo; RELEASE SAVEPOINT secondo;
    ROLLBACK TO SAVEPOINT primo; INSERT INTO sp_dati VALUES(10,100);
    ROLLBACK TO primo; RELEASE SAVEPOINT primo;
  END`, null);
  await all('CALL sp_espliciti()', null, 'START TRANSACTION; CALL sp_espliciti(); COMMIT');
  await rows('SELECT id,n FROM sp_dati ORDER BY id', [{ id: 1, n: 10 }, { id: 2, n: 20 }, { id: 6, n: 60 }, { id: 9, n: 90 }], null);
  await rows('SELECT id FROM sp_log WHERE id=10', [], null);
  // Il rollback attraversa la cascata e i trigger delle tabelle figlie.
  await query('CREATE TABLE sp_figli(id INT PRIMARY KEY,pid INT REFERENCES sp_dati(id) ON DELETE CASCADE)');
  await query('INSERT INTO sp_figli VALUES(1,1)');
  await query("CREATE TRIGGER sp_blocca AFTER DELETE ON sp_figli FOR EACH ROW SIGNAL SQLSTATE '45002'");
  await query("CREATE PROCEDURE sp_cascata() BEGIN DECLARE CONTINUE HANDLER FOR SQLSTATE '45002' INSERT INTO sp_log VALUES(88,88); DELETE FROM sp_dati WHERE id=1; END");
  await query('CALL sp_cascata()');
  assert.equal(await database.collection('sp_figli').countDocuments(), 1);
  assert.equal(await database.collection('sp_dati').countDocuments({ id: 1 }), 1);
  assert.equal(await database.collection('sp_log').countDocuments({ id: 88 }), 1); count += 8;
  console.log('  OK savepoint, vincoli, handler, trigger, cascate e istruzioni precedenti');

  await all('CREATE TABLE pg_sp_dati(id INT PRIMARY KEY)');
  await all('CREATE TABLE pg_sp_log(n INT)');
  await all(`CREATE PROCEDURE pg_sp() LANGUAGE PLPGSQL AS $$
    DECLARE v INT DEFAULT 0;
    BEGIN
      INSERT INTO pg_sp_dati VALUES(1);
      BEGIN
        INSERT INTO pg_sp_dati VALUES(2); v:=7;
        INSERT INTO pg_sp_dati VALUES(1);
      EXCEPTION WHEN unique_violation THEN INSERT INTO pg_sp_log VALUES(v);
      END;
      BEGIN
        INSERT INTO pg_sp_dati VALUES(3);
        BEGIN INSERT INTO pg_sp_dati VALUES(4); RAISE EXCEPTION 'annulla';
        EXCEPTION WHEN raise_exception THEN RAISE; END;
      EXCEPTION WHEN OTHERS THEN INSERT INTO pg_sp_log VALUES(8); END;
      BEGIN INSERT INTO pg_sp_dati VALUES(5); v:=1/0;
      EXCEPTION WHEN division_by_zero THEN INSERT INTO pg_sp_log VALUES(9); END;
      INSERT INTO pg_sp_dati VALUES(6);
    END $$`, undefined, null);
  await all('CALL pg_sp()', undefined, null);
  await rows('SELECT id FROM pg_sp_dati ORDER BY id', [{ id: 1 }, { id: 6 }], undefined, null);
  await rows('SELECT n FROM pg_sp_log ORDER BY n', [{ n: 7 }, { n: 8 }, { n: 9 }], undefined, null);
  console.log('  OK blocchi EXCEPTION PostgreSQL, variabili preservate, RAISE annidato e divisione per zero');
  await all(`CREATE PROCEDURE sp_nomi() BEGIN
    DECLARE CONTINUE HANDLER FOR SQLSTATE '42000' INSERT INTO sp_log VALUES(55,55);
    SAVEPOINT ripetuto; SAVEPOINT ripetuto; RELEASE SAVEPOINT ripetuto; ROLLBACK TO ripetuto;
  END`, null);
  await all('CALL sp_nomi()', null, 'START TRANSACTION; CALL sp_nomi(); COMMIT');
  await rows('SELECT id FROM sp_log WHERE id=55', [{ id: 55 }], null);
  await all("CREATE PROCEDURE sp_dup_interno() BEGIN DECLARE EXIT HANDLER FOR SQLSTATE '23000' RESIGNAL; INSERT INTO sp_dati VALUES(1,10); END", null);
  await all("CREATE PROCEDURE sp_dup_esterno() BEGIN DECLARE CONTINUE HANDLER FOR SQLSTATE '23000' INSERT INTO sp_log VALUES(56,56); CALL sp_dup_interno(); END", null);
  await all('CALL sp_dup_esterno()', null);
  await rows('SELECT id FROM sp_log WHERE id=56', [{ id: 56 }], null);
  const { Int32, Double, Long, Decimal128, Binary } = require('bson');
  await database.collection('sp_bson').insertOne({ _id: new Int32(1), n: new Int32(1), double: new Double(1), lungo: Long.fromString('9007199254740993'), decimale: Decimal128.fromString('1.230000'), binario: new Binary(Buffer.from([0, 255])) });
  const raw = await database.collection('sp_bson').findOne({}, { raw: true });
  await query('CREATE PROCEDURE sp_bytes() BEGIN SAVEPOINT s; UPDATE sp_bson SET n=99; ROLLBACK TO s; END');
  await query('CALL sp_bytes()');
  assert.deepEqual(await database.collection('sp_bson').findOne({}, { raw: true }), raw); count += 4;
  await query('CREATE PROCEDURE sp_tags() BEGIN UPDATE sp_bson SET n=1; END'); await query('CALL sp_tags()');
  assert.deepEqual(await database.collection('sp_bson').findOne({}, { raw: true }), raw); count += 3;
  await database.collection('_codedb_sql_dati_test').insertOne({ n: 1 });
  await query('CREATE PROCEDURE sp_prefisso() BEGIN SAVEPOINT s; UPDATE _codedb_sql_dati_test SET n=2; ROLLBACK TO s; END');
  await query('CALL sp_prefisso()');
  assert.equal((await database.collection('_codedb_sql_dati_test').findOne()).n, 1); count += 3;
  await database.collection('sp_parziale').createIndex({ n: 1 }, { unique: true, partialFilterExpression: { attivo: true } });
  await database.collection('sp_parziale').insertOne({ n: 1, attivo: false });
  await query('CREATE PROCEDURE sp_indice() BEGIN INSERT INTO sp_parziale(n,attivo) VALUES(1,TRUE); END');
  await query('CALL sp_indice()');
  assert.equal(await database.collection('sp_parziale').countDocuments({ n: 1 }), 2); count += 3;
  await assert.rejects(strategy.mongoSqlProcedure(database.databaseName, 'sp_espliciti', { sql: 'CALL sp_espliciti()', maxRows: 1 }), /limite/); count++;
  const restricted = collections => require('../auth/guardStrategy').guardStrategy(base, { connName: 'test', principal: require('../auth/principal').makePrincipal(
    { _id: 'limitato', type: 'subuser', ownerId: 'owner' }, [{ connName: 'test', capabilities: ['read', 'write', 'delete', 'ddl'], scope: { databases: [database.databaseName], collections } }]) });
  await assert.rejects(restricted(['pg_sp_dati']).mongoSqlProcedure(database.databaseName, 'pg_sp', { sql: 'CALL pg_sp()' }), /Permesso negato/); count++;
  await query('CREATE TABLE sp_trigger_diretto(id INT PRIMARY KEY)');
  await query(`CREATE TRIGGER sp_eccezione AFTER INSERT ON sp_trigger_diretto FOR EACH ROW BEGIN
    BEGIN INSERT INTO pg_sp_log VALUES(999); INSERT INTO pg_sp_dati VALUES(1);
    EXCEPTION WHEN unique_violation THEN INSERT INTO pg_sp_log VALUES(NEW.id); END;
  END`);
  await query('INSERT INTO sp_trigger_diretto VALUES(20)');
  await strategy.shellWrite(database.databaseName, 'sp_trigger_diretto', { op: 'insertOne', doc: '{"id":21}' });
  assert.deepEqual(await query('SELECT n FROM pg_sp_log WHERE n>=20 ORDER BY n'), [{ n: 20 }, { n: 21 }]); count += 5;

  await all('CREATE TABLE dep_padre(id INT PRIMARY KEY,n INT)');
  await all('CREATE TABLE dep_figlio(id INT PRIMARY KEY,pid INT,CONSTRAINT fk_dep FOREIGN KEY(pid) REFERENCES dep_padre(id) ON UPDATE CASCADE)');
  await all('INSERT INTO dep_padre VALUES(1,4)'); await all('INSERT INTO dep_figlio VALUES(1,1)');
  await all('CREATE INDEX dep_ix ON dep_padre(id,n)');
  await assert.rejects(restricted(['dep_padre']).mongoSqlSchema(database.databaseName, 'dep_padre', { sql: 'ALTER TABLE dep_padre RENAME COLUMN id TO nuovo' }), /Permesso negato/); count++;
  await all('ALTER TABLE dep_padre RENAME COLUMN id TO nuovo');
  await all('UPDATE dep_padre SET nuovo=2');
  await rows('SELECT pid FROM dep_figlio', [{ pid: 2 }]);
  assert.deepEqual((await database.collection('dep_padre').listIndexes().toArray()).find(i => i.name === 'dep_ix').key, { nuovo: 1, n: 1 }); count++;
  await query('ALTER TABLE dep_padre DROP COLUMN nuovo', /FOREIGN KEY/); count++;
  await all('ALTER TABLE dep_padre DROP COLUMN nuovo CASCADE', undefined, null);
  assert.equal((await database.collection('dep_padre').listIndexes().toArray()).some(i => i.name === 'dep_ix'), false); count++;
  await all('INSERT INTO dep_figlio VALUES(2,999)', undefined, null);
  assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(), 0); count++;
  console.log('  OK dipendenze ALTER, rinomina FK/indici, RESTRICT e CASCADE');
  await query('CREATE TABLE dep_self(id INT PRIMARY KEY,pid INT REFERENCES dep_self(id),n INT)');
  await query('INSERT INTO dep_self VALUES(1,1,9)');
  await query('ALTER TABLE dep_self DROP COLUMN id', /FOREIGN KEY/);
  await query('ALTER TABLE dep_self DROP COLUMN id CASCADE');
  assert.deepEqual(await query('SELECT pid,n FROM dep_self'), [{ pid: 1, n: 9 }]); count += 5;

  await all('CREATE TABLE of_dati(id INT PRIMARY KEY,a INT,b INT)');
  await all('CREATE TABLE of_log(n INT)');
  await all('INSERT INTO of_dati VALUES(1,1,1)');
  await all('CREATE TRIGGER of_t AFTER UPDATE OF a ON of_dati FOR EACH ROW INSERT INTO of_log VALUES(NEW.a)',
    'CREATE FUNCTION of_fn() RETURNS trigger LANGUAGE PLPGSQL AS $$BEGIN INSERT INTO of_log VALUES(NEW.a); RETURN NEW; END;$$; CREATE TRIGGER of_t AFTER UPDATE OF a ON of_dati FOR EACH ROW EXECUTE FUNCTION of_fn()', null);
  await all('UPDATE of_dati SET b=2', undefined, null);
  await rows('SELECT n FROM of_log', [], undefined, null);
  await all('UPDATE of_dati SET a=a', undefined, null);
  await rows('SELECT n FROM of_log', [{ n: 1 }], undefined, null);
  await strategy.shellWrite(database.databaseName, 'of_dati', { op: 'updateMany', filter: '{}', update: '{"$inc":{"b":0}}' });
  assert.deepEqual(await query('SELECT n FROM of_log'), [{ n: 1 }]);
  await strategy.shellWrite(database.databaseName, 'of_dati', { op: 'updateMany', filter: '{}', update: '{"$inc":{"a":0}}' });
  assert.deepEqual(await query('SELECT n FROM of_log'), [{ n: 1 }, { n: 1 }]);
  await query('DELETE FROM of_log'); count += 5;
  await query('ALTER TABLE of_dati RENAME COLUMN a TO valore');
  await query('UPDATE of_dati SET valore=3');
  assert.deepEqual(await query('SELECT n FROM of_log ORDER BY n'), [{ n: 3 }]); count += 3;
  await query('ALTER TABLE of_dati DROP COLUMN valore', /trigger/);
  await query('ALTER TABLE of_dati DROP COLUMN valore CASCADE');
  assert.equal(await database.collection('_codedb_sql_triggers').countDocuments({ coll: 'of_dati' }), 0); count += 3;
  console.log('  OK trigger UPDATE OF, assegnazione invariata e dipendenza da colonna rinominata/eliminata');

  await all("CREATE TABLE binari(id INT PRIMARY KEY,b BINARY(4),v VARBINARY(8),x BLOB)", null);
  await all("INSERT INTO binari VALUES(1,X'00ff',X'000020ff',X'')", null);
  await rows("SELECT HEX('è') AS s,HEX(14.5) AS a,HEX(-1) AS b,HEX(0) AS z,HEX(18446744073709551615) AS u,HEX(NULL) AS n",
    [{ s: 'C3A8', a: 'F', b: 'FFFFFFFFFFFFFFFF', z: '0', u: 'FFFFFFFFFFFFFFFF', n: null }], null);
  await rows('SELECT HEX(b) AS b,HEX(v) AS v,OCTET_LENGTH(x) AS n FROM binari', [{ b: '00FF0000', v: '000020FF', n: 0 }], null);
  await all("UPDATE binari SET b=X'ff',v=X'ff00'", null);
  await rows('SELECT HEX(b) AS b,HEX(v) AS v FROM binari', [{ b: 'FF000000', v: 'FF00' }], null);
  await query("INSERT INTO binari VALUES(2,X'0000000000',NULL,NULL)", /valid|schema/); count++;
  await all("CREATE PROCEDURE param_bin(IN x VARBINARY(8)) BEGIN INSERT INTO binari VALUES(3,x,x,x); END", null);
  await all("CALL param_bin(X'00ff')", null);
  await rows('SELECT HEX(b) AS b,HEX(v) AS v FROM binari WHERE id=3', [{ b: '00FF0000', v: '00FF' }], null);
  await all("CREATE TABLE bytea_dati(id INT PRIMARY KEY,b BYTEA DEFAULT X'00ff')", "CREATE TABLE bytea_dati(id INT PRIMARY KEY,b BYTEA DEFAULT decode('00ff','hex'))", null);
  await all('INSERT INTO bytea_dati(id) VALUES(1)', undefined, null);
  await rows('SELECT HEX(b) AS b,OCTET_LENGTH(b) AS n FROM bytea_dati', [{ b: '00FF', n: 2 }], "SELECT UPPER(encode(b,'hex')) AS b,octet_length(b) AS n FROM bytea_dati", null);
  await query('ALTER TABLE binari ALTER COLUMN v TYPE BINARY(8)');
  assert.deepEqual(await query('SELECT HEX(v) AS v FROM binari WHERE id=1'), [{ v: 'FF00000000000000' }]); count += 2;
  await assert.rejects(database.collection('binari').insertOne({ id: 8, b: new (require('bson').Binary)(Buffer.alloc(5)) }), /validation/i); count++;
  console.log('  OK tipi binari, zero byte, padding, parametri, default, ALTER e validatore nativo');
  return { count, pg: npg, mysql: nmy };
};
