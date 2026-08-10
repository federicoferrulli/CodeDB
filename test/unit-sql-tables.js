'use strict';

/* ---------------------------------------------------------------------------
 * Scope dei permessi su SQL libero: si guardano le tabelle CITATE (CDB-A03).
 *
 * Prima il confronto avveniva su un bersaglio dedotto — una regex sul primo
 * `FROM`, o il `coll` scelto dal client quando il FROM non c'era — mentre la
 * stringa SQL veniva eseguita verbatim. Due uscite dal perimetro con una sola
 * richiesta: una JOIN per leggere una tabella altrui, una UPDATE senza FROM per
 * scriverci.
 *
 * Le prove sono divise in tre gruppi, e servono tutti e tre: quali nomi vengono
 * ESTRATTI, cosa viene RIFIUTATO, e soprattutto cosa deve continuare a
 * FUNZIONARE — una barriera che nega il lavoro legittimo viene disattivata dal
 * primo amministratore che la incontra, e allora non protegge più nulla.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { tabelleCitate, assertTabelleNelloScope } = require('../auth/sqlTables');

const nomi = (sql) => tabelleCitate(sql).tabelle.map((t) => t.nome);

// --- 1. Estrazione ---------------------------------------------------------
{
  const atteso = [
    ['SELECT * FROM ordini', ['ordini']],
    ['SELECT * FROM ordini JOIN utenti ON 1=1', ['ordini', 'utenti']],
    ["UPDATE utenti SET ruolo='admin'", ['utenti']],
    ['DELETE FROM utenti', ['utenti']],
    ['select * from a, b, c', ['a', 'b', 'c']],
    ['SELECT * FROM shop.ordini o, shop.righe r WHERE o.id = r.oid', ['shop.ordini', 'shop.righe']],
    ['SELECT * FROM ordini AS o LEFT JOIN utenti u ON o.uid = u.id', ['ordini', 'utenti']],
    ['SELECT * FROM ordini WHERE id IN (SELECT oid FROM righe)', ['ordini', 'righe']],
    ['SELECT * FROM ordini UNION SELECT * FROM archivio', ['ordini', 'archivio']],
    ['INSERT INTO ordini (a, b) VALUES (1, 2)', ['ordini']],
    ['INSERT INTO ordini SELECT * FROM staging', ['ordini', 'staging']],
    ['TRUNCATE ordini', ['ordini']],
    ['TRUNCATE TABLE ordini', ['ordini']],
    ['CREATE TABLE nuova (id INT)', ['nuova']],
    ['DROP TABLE ordini', ['ordini']],
    ['ALTER TABLE ordini ADD COLUMN x INT', ['ordini']],
    // `ON` introduce una tabella solo qui: negli altri casi segue una JOIN e
    // porterebbe a scambiare una colonna qualificata per una tabella.
    ['CREATE INDEX idx ON utenti (email)', ['utenti']],
    ['SELECT * FROM ONLY ordini', ['ordini']],
    ['SELECT a INTO @x FROM ordini', ['ordini']],
    ['SELECT * FROM information_schema.tables', ['information_schema.tables']],
    // Nessuna tabella: non c'è nulla da confrontare, e va bene così.
    ['SELECT 1', []],
    ['SHOW TABLES', []],
  ];
  for (const [sql, exp] of atteso) {
    assert.deepStrictEqual(nomi(sql), exp, `estrazione errata per: ${sql}`);
  }

  // Il rumore non conta: stringhe, commenti e identificatori quotati.
  assert.deepStrictEqual(nomi("SELECT * FROM `ordini` WHERE nome = 'FROM utenti'"), ['ordini'],
    'una parola dentro una stringa non è una tabella');
  assert.deepStrictEqual(nomi('SELECT * FROM ordini -- FROM utenti'), ['ordini'],
    'una parola in un commento non è una tabella');
  assert.deepStrictEqual(nomi('SELECT * FROM ordini /* JOIN utenti */'), ['ordini'],
    'nemmeno in un commento a blocco');

  // Nomi dichiarati NELLA query: CTE e tabelle derivate sono alias locali, ma
  // il contenuto della CTE viene analizzato lo stesso — lì sta il bypass.
  assert.deepStrictEqual(nomi('WITH x AS (SELECT * FROM ordini) SELECT * FROM x'), ['ordini'],
    'la CTE non è una tabella, il suo contenuto sì');
  assert.deepStrictEqual(nomi('WITH x AS (SELECT * FROM segreti) SELECT * FROM x'), ['segreti'],
    'una CTE non nasconde la tabella che legge');
  assert.deepStrictEqual(nomi('SELECT * FROM (SELECT * FROM ordini) s'), ['ordini'],
    'tabella derivata: conta ciò che c\'è dentro');
  console.log('  OK   Estrazione dei nomi di tabella dallo statement (CDB-A03)');
}

// --- 2. Nel dubbio si rifiuta ---------------------------------------------
{
  const r = tabelleCitate('SELECT * FROM generate_series(1,10)');
  assert.ok(r.nonAnalizzabile, 'una funzione tabella non è riconducibile a un nome: va dichiarata');
  assert.ok(/generate_series/.test(r.nonAnalizzabile), 'il motivo deve nominare ciò che non si è potuto verificare');
  console.log('  OK   Le forme non analizzabili sono dichiarate, non ammesse');
}

// --- 3. Applicazione dello scope ------------------------------------------
{
  const scope = { databases: ['shop'], collections: ['ordini'] };
  const ok = (sql, db = 'shop') => assert.doesNotThrow(
    () => assertTabelleNelloScope(sql, scope, db), `doveva passare: ${sql}`);
  const no = (sql, atteso, db = 'shop') => assert.throws(
    () => assertTabelleNelloScope(sql, scope, db), atteso, `doveva essere rifiutata: ${sql}`);

  // I due scenari del rilievo, entrambi con una sola richiesta.
  no('SELECT * FROM ordini JOIN utenti ON 1=1', /"utenti" è fuori dal tuo ambito/);
  no("UPDATE utenti SET ruolo='admin'", /"utenti" è fuori dal tuo ambito/);

  // Altre uscite dallo stesso perimetro.
  no('SELECT * FROM information_schema.tables', /fuori dal tuo ambito/);
  no('SELECT * FROM altro.ordini', /"altro"/);
  no('SELECT * FROM ordini WHERE id IN (SELECT oid FROM utenti)', /"utenti"/);
  no('WITH x AS (SELECT * FROM utenti) SELECT * FROM x', /"utenti"/);
  no('INSERT INTO utenti (a) VALUES (1)', /"utenti"/);
  no('SELECT * FROM ordini UNION SELECT * FROM utenti', /"utenti"/);
  no('SELECT * FROM generate_series(1,10)', /non è possibile verificare l'ambito/);

  // …e ciò che deve continuare a funzionare.
  ok('SELECT * FROM ordini');
  ok('SELECT * FROM shop.ordini');
  ok('SELECT * FROM ordini AS o WHERE o.totale > 100 ORDER BY o.data LIMIT 10');
  ok('SELECT COUNT(*) FROM ordini');
  ok('WITH x AS (SELECT * FROM ordini) SELECT * FROM x');
  ok('SELECT 1');
  ok("UPDATE ordini SET stato = 'chiuso' WHERE id = 1");
  ok('DELETE FROM ordini WHERE id = 1');

  // Il messaggio deve dire cosa fare, non solo negare.
  try {
    assertTabelleNelloScope('SELECT * FROM utenti', scope, 'shop');
    assert.fail('doveva essere rifiutata');
  } catch (err) {
    assert.ok(/Cosa fare:/.test(err.message), 'il rifiuto deve spiegare come procedere');
  }

  // Senza scope non si applica nulla: è la regola già adottata per le clausole
  // libere, e senza di essa owner e sottoutenti senza limiti perderebbero SQL.
  assert.doesNotThrow(() => assertTabelleNelloScope('SELECT * FROM qualsiasi', null, 'x'),
    'nessuno scope attivo: nessuna restrizione');
  assert.doesNotThrow(() => assertTabelleNelloScope('SELECT * FROM qualsiasi', {}, 'x'),
    'scope vuoto (nessun elenco): nessuna restrizione');

  // Glob: lo scope li usa già altrove, qui devono valere allo stesso modo.
  const conGlob = { databases: ['shop*'], collections: ['ord*'] };
  assert.doesNotThrow(() => assertTabelleNelloScope('SELECT * FROM ordini_2026', conGlob, 'shop_it'));
  assert.throws(() => assertTabelleNelloScope('SELECT * FROM utenti', conGlob, 'shop_it'));
  console.log('  OK   Scope applicato a ogni tabella citata, lavoro legittimo intatto (CDB-A03)');
}
