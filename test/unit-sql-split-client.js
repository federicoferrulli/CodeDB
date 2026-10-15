'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario dello splitter LATO CLIENT (public/js/sql-split.js).
 *
 * Il client non decide cosa viene eseguito — quello lo fa il server — ma decide
 * su quale evento instradare il testo (`query:execute` o `script:execute`). Se
 * sbaglia a contare, una query singola che contiene un `;` dentro una stringa
 * finirebbe nel runner di script (o viceversa). Il confronto con il gemello
 * server è parte del test: le due implementazioni non devono divergere.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
if (process.argv.includes('--mutant=handler')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/sql-blocchi.mjs')) return result;
  const from = "if (handler && ['IF'";
  assert.ok(String(result.source).includes(from), 'Mutazione handler non applicata');
  return { ...result, source: String(result.source).replace(from, "if (false && ['IF'") };
} });
const path = require('path');
const { pathToFileURL } = require('url');
const { splitStatementsDetailed } = require('../db/sqlText');

let falliti = 0;
function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

(async () => {
  const modUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'sql-split.js')).href;
  const { splitStatements, isScript, countStatements } = await import(modUrl);

  console.log('--- Test unitari splitter client ---');

  prova('Query singola: non è uno script', () => {
    assert.strictEqual(isScript('SELECT 1'), false);
    assert.strictEqual(isScript('SELECT 1;'), false);
    assert.strictEqual(isScript("db.users.find({ a: 1 })"), false);
  });

  prova('Due istruzioni: è uno script', () => {
    assert.strictEqual(isScript('SELECT 1; SELECT 2'), true);
    assert.strictEqual(countStatements('SELECT 1; SELECT 2; SELECT 3'), 3);
  });

  prova('Punto e virgola dentro stringhe e commenti non conta', () => {
    assert.strictEqual(isScript("SELECT * FROM note WHERE t = 'a;b'"), false);
    assert.strictEqual(isScript('SELECT 1 -- commento; finto'), false);
    assert.strictEqual(isScript('SELECT 1 /* a; b */'), false);
    assert.strictEqual(isScript("SELECT 'l''isola; qui'"), false);
  });

  prova('Righe corrette', () => {
    const st = splitStatements('SELECT 1;\nSELECT 2;\n\nSELECT 3');
    assert.deepStrictEqual(st.map((x) => x.line), [1, 2, 4]);
  });

  prova('Le procedure restano intere prima della CALL successiva', () => {
    for (const body of ['UPDATE t SET n=1; INSERT INTO t(n) VALUES(2);',
      'DECLARE i INT DEFAULT 0; WHILE i<2 DO IF (i=0) THEN UPDATE t SET n=1; ELSE UPDATE t SET n=2; END IF; SET i=i+1; END WHILE;',
      'SELECT CASE WHEN n=1 THEN 2 ELSE 3 END FROM t;']) {
      const code = `CREATE PROCEDURE p() BEGIN ${body} END; CALL p();`;
      const server = splitStatementsDetailed(code).map(x => x.sql);
      const client = splitStatements(code).map(x => x.sql);
      assert.equal(server.length, 2); assert.deepEqual(client, server);
    }
  });

  prova('Coerenza con il gemello server su un ventaglio di casi', () => {
    const casi = [
      'SELECT 1',
      'SELECT 1; SELECT 2',
      "INSERT INTO t VALUES ('a;b'); SELECT 2",
      'SELECT 1 -- x;\n; SELECT 2',
      'SELECT `col;x` FROM t; SELECT "a;b" FROM u',
      'CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n RETURN 1;\nEND;\n$$ LANGUAGE plpgsql;\nSELECT f()',
      ';;;',
      '',
      "db.users.find({ a: 1 });\ndb.users.count()",
      'SELECT 1; -- coda',
      // CDB-A15: la barra rovesciata dentro un literal e il prefisso E'…' di
      // PostgreSQL. Sono il caso in cui i due splitter possono divergere senza
      // che nulla lo segnali, ed è anche quello che decide se una DROP viene
      // vista o resta nascosta dentro una stringa.
      `SELECT 'x${String.fromCharCode(92)}'; DROP TABLE utenti; SELECT '`,
      `SELECT E'x${String.fromCharCode(92)}'; SELECT 1`,
    ];
    for (const caso of casi) {
      const client = splitStatements(caso).map((x) => x.sql);
      const server = splitStatementsDetailed(caso).map((x) => x.sql);
      assert.deepStrictEqual(client, server, `divergenza su: ${JSON.stringify(caso)}`);
    }
  });

  prova('Coerenza anche sui numeri di riga', () => {
    const src = "SELECT 1;\n\n  INSERT INTO t VALUES ('x;y');\nSELECT 3";
    const client = splitStatements(src).map((x) => x.line);
    const server = splitStatementsDetailed(src).map((x) => x.line);
    assert.deepStrictEqual(client, server);
  });
  prova('REPEAT, ELSEIF e trigger conservano i punti e virgola interni', () => {
    const source = 'CREATE PROCEDURE p() BEGIN DECLARE i INT DEFAULT 0; REPEAT SET i=i+1; IF i=1 THEN CALL a(); ELSEIF i=2 THEN CALL b(); END IF; UNTIL i=2 END REPEAT; END; CREATE TRIGGER t AFTER INSERT ON c FOR EACH ROW BEGIN INSERT INTO log VALUES(NEW.id); END; CALL p();';
    const client = splitStatements(source).map(x => x.sql);
    assert.strictEqual(client.length, 3);
    assert.deepStrictEqual(client, splitStatementsDetailed(source).map(x => x.sql));
  });
  prova('Handler con IF e cursore restano nella stessa procedura', () => {
    const source = 'CREATE PROCEDURE p() BEGIN DECLARE v INT; DECLARE c CURSOR FOR SELECT n FROM t; DECLARE CONTINUE HANDLER FOR NOT FOUND IF v IS NULL THEN SET v=0; END IF; OPEN c; FETCH c INTO v; CLOSE c; END; CALL p();';
    const client = splitStatements(source).map(x => x.sql);
    assert.strictEqual(client.length, 2);
    assert.deepStrictEqual(client, splitStatementsDetailed(source).map(x => x.sql));
  });
  prova('Handler SQLSTATE, classi e condizioni nominate conservano il corpo IF', () => {
    for (const condition of ["SQLSTATE '45001'", 'SQLWARNING', 'SQLEXCEPTION', 'errore_locale', "SQLSTATE '45001', SQLSTATE '45002'"]) {
      const source = `CREATE PROCEDURE p() BEGIN DECLARE v INT; DECLARE CONTINUE HANDLER FOR ${condition} IF v IS NULL THEN SET v=0; END IF; SET v=1; END; CALL p();`;
      const client = splitStatements(source).map(x => x.sql);
      assert.strictEqual(client.length, 2, condition);
      assert.deepStrictEqual(client, splitStatementsDetailed(source).map(x => x.sql));
    }
  });

  prova('DELIMITER MySQL conserva routine, stringhe, commenti e righe', () => {
    for (const delimiter of ['$$', '//', ';;', 'fine']) {
      const source = `-- inizio\nDELIMITER ${delimiter}\nCREATE PROCEDURE p() BEGIN SELECT '${delimiter};'; /* ${delimiter} */ SELECT 2; END${delimiter}\nDELIMITER ;\nCALL p();`;
      const opts = { dbms: 'mysql', backslashEscape: true };
      const server = splitStatementsDetailed(source, opts);
      const client = splitStatements(source, opts);
      assert.equal(client.length, 2);
      assert.deepEqual(client, server.map(({ sql, line }) => ({ sql, line })));
      assert.deepEqual(client.map(s => s.line), [3, 5]);
      assert.match(client[0].sql, /^CREATE PROCEDURE.*END$/);
      assert.equal(client[1].sql, 'CALL p()');
      assert.equal(isScript(`DELIMITER ${delimiter}\nSELECT 1${delimiter}`, opts), true);
    }
  });

  prova('Le stringhe MySQL con doppi apici conservano gli escape', () => {
    const source = String.raw`SELECT "a\";b"; SELECT 2;`;
    const opts = { dbms: 'mysql', backslashEscape: true };
    const server = splitStatementsDetailed(source, opts).map(s => s.sql);
    assert.equal(server.length, 2);
    assert.deepEqual(splitStatements(source, opts).map(s => s.sql), server);
  });

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test dello splitter client superati!');
  }
})();
