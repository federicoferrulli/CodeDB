'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario della traduzione SQL di SCRITTURA/DDL → MongoDB
 * (`translateWrite` in db/SqlToMql.js). Nessun database.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { translateWrite, looksLikeSqlWrite } = require('../db/SqlToMql');

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

function deveFallire(sql, atteso) {
  let err = null;
  try { translateWrite(sql); } catch (e) { err = e; }
  assert.ok(err, `doveva fallire: ${sql}`);
  if (atteso) assert.ok(atteso.test(err.message), `messaggio inatteso: ${err.message}`);
}

console.log('--- Test unitari SQL di scrittura → MongoDB ---');

prova('Riconoscimento dei comandi di scrittura', () => {
  assert.strictEqual(looksLikeSqlWrite('INSERT INTO t (a) VALUES (1)'), true);
  assert.strictEqual(looksLikeSqlWrite('  update t set a = 1'), true);
  assert.strictEqual(looksLikeSqlWrite('SELECT * FROM t'), false);
  assert.strictEqual(looksLikeSqlWrite('db.t.find({})'), false);
});

prova('INSERT con una riga', () => {
  const r = translateWrite("INSERT INTO utenti (nome, eta) VALUES ('Ada', 36)");
  assert.strictEqual(r.kind, 'write');
  assert.strictEqual(r.op, 'insertOne');
  assert.strictEqual(r.coll, 'utenti');
  assert.deepStrictEqual(r.docs, [{ nome: 'Ada', eta: 36 }]);
});

prova('INSERT con più righe', () => {
  const r = translateWrite("INSERT INTO utenti (nome, attivo) VALUES ('Ada', true), ('Bob', false)");
  assert.strictEqual(r.op, 'insertMany');
  assert.deepStrictEqual(r.docs, [{ nome: 'Ada', attivo: true }, { nome: 'Bob', attivo: false }]);
});

prova('INSERT senza colonne rifiutato con spiegazione', () => {
  deveFallire("INSERT INTO utenti VALUES ('Ada', 36)", /elenco di colonne/);
});

prova('INSERT con conteggio valori sbagliato', () => {
  deveFallire("INSERT INTO utenti (a, b) VALUES (1)", /Numero di valori/);
});

prova('UPDATE con WHERE', () => {
  const r = translateWrite("UPDATE utenti SET attivo = false, note = 'x' WHERE eta > 60");
  assert.strictEqual(r.op, 'updateMany');
  assert.strictEqual(r.coll, 'utenti');
  assert.deepStrictEqual(r.update, { $set: { attivo: false, note: 'x' } });
  assert.deepStrictEqual(r.filter, { eta: { $gt: 60 } });
  assert.strictEqual(r.note, null);
});

prova('UPDATE senza WHERE avvisa che tocca tutto', () => {
  const r = translateWrite('UPDATE utenti SET attivo = true');
  assert.deepStrictEqual(r.filter, {});
  assert.ok(/TUTTI/.test(r.note), 'deve avvisare');
});

prova('DELETE con e senza WHERE', () => {
  const r = translateWrite("DELETE FROM utenti WHERE nome = 'Ada'");
  assert.strictEqual(r.op, 'deleteMany');
  assert.deepStrictEqual(r.filter, { nome: 'Ada' });

  const tutti = translateWrite('DELETE FROM utenti');
  assert.deepStrictEqual(tutti.filter, {});
  assert.ok(/TUTTI/.test(tutti.note));
});

prova('WHERE complessa riusa il parser delle SELECT', () => {
  const r = translateWrite("DELETE FROM t WHERE (a = 1 OR b = 2) AND c IS NOT NULL");
  assert.deepStrictEqual(r.filter, {
    $and: [{ $or: [{ a: 1 }, { b: 2 }] }, { c: { $ne: null } }],
  });
});

prova('TRUNCATE', () => {
  const r = translateWrite('TRUNCATE TABLE utenti');
  assert.strictEqual(r.op, 'deleteMany');
  assert.deepStrictEqual(r.filter, {});
});

prova('CREATE TABLE crea la collezione e avvisa sui tipi', () => {
  const r = translateWrite('CREATE TABLE prodotti (id INT PRIMARY KEY, nome VARCHAR(50))');
  assert.strictEqual(r.kind, 'ddl');
  assert.strictEqual(r.op, 'createCollection');
  assert.strictEqual(r.coll, 'prodotti');
  assert.ok(/schema fisso/.test(r.note), 'deve dire che i tipi sono ignorati');
});

prova('CREATE TABLE IF NOT EXISTS senza definizioni', () => {
  const r = translateWrite('CREATE TABLE IF NOT EXISTS vuota');
  assert.strictEqual(r.coll, 'vuota');
  assert.strictEqual(r.note, null);
});

prova('CREATE / DROP DATABASE', () => {
  const c = translateWrite('CREATE DATABASE negozio');
  assert.strictEqual(c.op, 'createDatabase');
  assert.strictEqual(c.db, 'negozio');
  assert.ok(/almeno una collezione/.test(c.note));

  const d = translateWrite('DROP DATABASE IF EXISTS negozio');
  assert.strictEqual(d.op, 'dropDatabase');
  assert.strictEqual(d.db, 'negozio');
});

prova('DROP TABLE', () => {
  const r = translateWrite('DROP TABLE vecchia');
  assert.strictEqual(r.op, 'dropCollection');
  assert.strictEqual(r.coll, 'vecchia');
});

prova('Comandi senza equivalente rifiutati con spiegazione', () => {
  deveFallire('ALTER TABLE t ADD COLUMN x INT', /schema fisso|ALTER/);
  deveFallire('REPLACE INTO t (a) VALUES (1)', /REPLACE/);
  deveFallire('CREATE INDEX i ON t (a)', /createIndex/);
  deveFallire('GRANT ALL ON t TO x', /non riconosciuto/);
});

if (falliti) {
  console.error(`\n${falliti} test falliti.`);
  process.exitCode = 1;
} else {
  console.log('\nTutti i test di traduzione SQL→MongoDB in scrittura superati!');
}
