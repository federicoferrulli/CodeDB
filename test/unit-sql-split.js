'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario di `splitStatementsDetailed` (db/sqlText.js).
 *
 * È il pezzo su cui poggia tutto il runner di script: se sbaglia a decidere
 * quali `;` separano due istruzioni, un pezzo di stringa finisce eseguito come
 * comando a sé (o, peggio, uno statement viene spezzato a metà). Nessun
 * database richiesto.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { splitStatementsDetailed, splitStatements, hasMultipleStatements } = require('../db/sqlText');

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

console.log('--- Test unitari divisione statement SQL ---');

prova('Istruzione singola, con e senza punto e virgola', () => {
  assert.deepStrictEqual(splitStatementsDetailed('SELECT 1').map((s) => s.sql), ['SELECT 1']);
  assert.deepStrictEqual(splitStatementsDetailed('SELECT 1;').map((s) => s.sql), ['SELECT 1']);
  assert.deepStrictEqual(splitStatementsDetailed('  SELECT 1 ;  ').map((s) => s.sql), ['SELECT 1']);
});

prova('Il testo restituito è quello ORIGINALE, non normalizzato', () => {
  const st = splitStatementsDetailed("INSERT INTO t VALUES ('ciao mondo')");
  assert.strictEqual(st[0].sql, "INSERT INTO t VALUES ('ciao mondo')");
});

prova('Punto e virgola dentro una stringa non divide', () => {
  const st = splitStatementsDetailed("SELECT * FROM note WHERE testo = 'a;b'; SELECT 2");
  assert.strictEqual(st.length, 2);
  assert.strictEqual(st[0].sql, "SELECT * FROM note WHERE testo = 'a;b'");
  assert.strictEqual(st[1].sql, 'SELECT 2');
});

prova('Apice raddoppiato dentro una stringa', () => {
  const st = splitStatementsDetailed("SELECT 'l''isola; qui'; SELECT 2");
  assert.strictEqual(st.length, 2);
  assert.strictEqual(st[0].sql, "SELECT 'l''isola; qui'");
});

prova('Punto e virgola dentro i commenti non divide', () => {
  const st = splitStatementsDetailed('SELECT 1 -- commento; finto\n; SELECT 2');
  assert.strictEqual(st.length, 2);
  assert.strictEqual(st[1].sql, 'SELECT 2');

  const st2 = splitStatementsDetailed('SELECT 1 /* a; b */; SELECT 2');
  assert.strictEqual(st2.length, 2);
});

prova('Dollar-quoting PostgreSQL: il corpo non viene diviso', () => {
  const src = [
    'CREATE FUNCTION f() RETURNS int AS $$',
    'BEGIN',
    '  RAISE NOTICE \'x\';',
    '  RETURN 1;',
    'END;',
    '$$ LANGUAGE plpgsql;',
    'SELECT f()',
  ].join('\n');
  const st = splitStatementsDetailed(src);
  assert.strictEqual(st.length, 2, `attese 2 istruzioni, ottenute ${st.length}`);
  assert.ok(st[0].sql.startsWith('CREATE FUNCTION'));
  assert.strictEqual(st[1].sql, 'SELECT f()');
});

prova('Identificatori quotati con backtick e virgolette', () => {
  const st = splitStatementsDetailed('SELECT `col;x` FROM t; SELECT "a;b" FROM u');
  assert.strictEqual(st.length, 2);
  assert.strictEqual(st[0].sql, 'SELECT `col;x` FROM t');
});

prova('Numero di riga corretto per puntare l\'errore', () => {
  const src = 'SELECT 1;\nSELECT 2;\n\nSELECT 3';
  const st = splitStatementsDetailed(src);
  assert.deepStrictEqual(st.map((s) => s.line), [1, 2, 4]);
});

prova('Gli offset ritagliano esattamente il sorgente', () => {
  const src = "SELECT 1;\n  INSERT INTO t VALUES ('x;y');\nSELECT 3";
  for (const st of splitStatementsDetailed(src)) {
    assert.strictEqual(src.slice(st.start, st.end).trim(), st.sql);
  }
});

prova('Punti e virgola vuoti e commenti isolati non producono istruzioni', () => {
  assert.deepStrictEqual(splitStatementsDetailed(';;;').map((s) => s.sql), []);
  assert.deepStrictEqual(splitStatements('-- solo un commento'), []);
  assert.deepStrictEqual(splitStatements(''), []);
  assert.deepStrictEqual(splitStatements('SELECT 1; -- coda'), ['SELECT 1']);
});

prova('splitStatements resta normalizzata (compatibilità con isWriteSql)', () => {
  // Il chiamante storico si aspetta testo SENZA stringhe letterali: è ciò che
  // evita di scambiare 'DELETE' dentro una stringa per una scrittura.
  const parti = splitStatements("SELECT * FROM audit WHERE azione = 'DELETE'");
  assert.strictEqual(parti.length, 1);
  assert.ok(!/DELETE/.test(parti[0]), `la stringa letterale non deve sopravvivere: ${parti[0]}`);
});

prova('hasMultipleStatements invariato sui casi storici', () => {
  assert.strictEqual(hasMultipleStatements("SELECT * FROM note WHERE t = 'a;b'"), false);
  assert.strictEqual(hasMultipleStatements('SELECT 1; DROP TABLE users'), true);
  assert.strictEqual(hasMultipleStatements('SELECT 1;'), false);
});

if (falliti) {
  console.error(`\n${falliti} test falliti.`);
  process.exitCode = 1;
} else {
  console.log('\nTutti i test di divisione statement superati!');
}
