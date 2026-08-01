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

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test dello splitter client superati!');
  }
})();
