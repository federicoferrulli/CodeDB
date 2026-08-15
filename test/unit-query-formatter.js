'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario del formattatore dell'editor (public/js/query-formatter.js).
 *
 * La proprietà più importante non è l'estetica: è che formattare **non
 * cambi il significato** del codice. Stringhe, commenti e identificatori
 * devono uscire identici a come sono entrati, e un testo non analizzabile deve
 * tornare indietro intatto invece di essere corrotto.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

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
  const url = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'query-formatter.js')).href;
  const {
    formatSql, formatCode, reindentJs, sembraJs, formatJsonLike, minifyCode, minifySql,
  } = await import(url);

  console.log('--- Test unitari formattatore editor ---');

  /* --- SQL ------------------------------------------------------------- */

  prova('Le clausole vanno a capo', () => {
    const out = formatSql("select id, nome from utenti where attivo = true order by nome limit 10");
    assert.deepStrictEqual(out.split('\n'), [
      'SELECT id, nome',
      'FROM utenti',
      'WHERE attivo = true',
      'ORDER BY nome',
      'LIMIT 10',
    ]);
  });

  prova('AND e OR rientrano sotto la WHERE', () => {
    const out = formatSql("SELECT * FROM t WHERE a = 1 AND b = 2 OR c = 3");
    assert.deepStrictEqual(out.split('\n'), [
      'SELECT *',
      'FROM t',
      'WHERE a = 1',
      '  AND b = 2',
      '  OR c = 3',
    ]);
  });

  prova('Le parole chiave vanno in maiuscolo, gli identificatori no', () => {
    const out = formatSql('select NomeUtente from Clienti where Citta = 1');
    assert.ok(out.includes('SELECT NomeUtente'), `identificatore alterato: ${out}`);
    assert.ok(out.includes('FROM Clienti'), out);
    assert.ok(out.includes('WHERE Citta = 1'), out);
  });

  prova('Il contenuto delle stringhe non viene toccato', () => {
    const out = formatSql("SELECT * FROM t WHERE nota = 'select from where AND'");
    assert.ok(out.includes("'select from where AND'"), `stringa alterata: ${out}`);
    assert.strictEqual(out.split('\n').length, 3, `la stringa non deve produrre a capo: ${out}`);
  });

  prova('I commenti sopravvivono', () => {
    const out = formatSql("SELECT 1 -- nota importante\nFROM t");
    assert.ok(out.includes('-- nota importante'), out);
  });

  prova('JOIN e ON su righe proprie', () => {
    const out = formatSql('SELECT a.id FROM a INNER JOIN b ON a.id = b.a_id WHERE a.x = 1');
    const righe = out.split('\n');
    assert.ok(righe.some((r) => r.startsWith('INNER JOIN b')), out);
    assert.ok(righe.some((r) => r.trim().startsWith('ON a.id = b.a_id')), out);
  });

  prova('I punti dei nomi qualificati non prendono spazi', () => {
    const out = formatSql('SELECT a.id, b.nome FROM a');
    assert.ok(out.includes('a.id, b.nome'), out);
    assert.ok(!/a \. id/.test(out), out);
  });

  prova('Le funzioni restano attaccate alla parentesi', () => {
    const out = formatSql('select count(*) from t');
    assert.ok(out.includes('COUNT(*)'), out);
  });

  prova('GROUP BY e ORDER BY riconosciute come una cosa sola', () => {
    const out = formatSql('SELECT c, COUNT(*) FROM t GROUP BY c ORDER BY c DESC');
    const righe = out.split('\n');
    assert.ok(righe.includes('GROUP BY c'), out);
    assert.ok(righe.includes('ORDER BY c DESC'), out);
  });

  prova('CREATE TABLE: una colonna per riga', () => {
    const out = formatSql('create table prodotti (id int primary key, nome varchar(50), prezzo decimal(10,2))');
    const righe = out.split('\n');
    assert.strictEqual(righe[0], 'CREATE TABLE prodotti (');
    assert.strictEqual(righe[1], '  id INT PRIMARY KEY,');
    assert.strictEqual(righe[2], '  nome VARCHAR(50),');
    // Le virgole prendono uno spazio dopo, anche dentro i tipi parametrici.
    assert.strictEqual(righe[3], '  prezzo DECIMAL(10, 2)');
    assert.strictEqual(righe[4], ')');
  });

  prova('Più istruzioni: una riga vuota fra loro, il ";" resta', () => {
    const out = formatSql('SELECT 1; SELECT 2');
    assert.deepStrictEqual(out.split('\n'), ['SELECT 1;', '', 'SELECT 2']);
  });

  prova('Le parentesi non spezzano le sotto-espressioni', () => {
    const out = formatSql('SELECT * FROM t WHERE (a = 1 AND b = 2) OR c = 3');
    const righe = out.split('\n');
    assert.ok(righe.some((r) => r.includes('(a = 1 AND b = 2)')), `AND dentro parentesi non deve andare a capo: ${out}`);
  });

  prova('Formattare due volte dà lo stesso risultato', () => {
    const sql = 'select id, nome from utenti where attivo = true and eta > 18 order by nome';
    const una = formatSql(sql);
    assert.strictEqual(formatSql(una), una, 'la formattazione non è stabile');
  });

  /* --- JSON / MQL ------------------------------------------------------- */

  prova('Filtro MQL indentato', () => {
    const out = formatJsonLike('{"stato":"attivo","eta":{"$gt":30}}');
    assert.ok(out.includes('\n  "stato": "attivo"'), out);
  });

  prova('formatCode riconosce JSON, SQL e JS', () => {
    assert.ok(formatCode('{"a":1}').includes('\n'), 'JSON deve essere indentato');
    assert.ok(formatCode('select 1 from t').startsWith('SELECT'), 'SQL deve essere formattato');
    assert.strictEqual(sembraJs('const a = 1;'), true);
    assert.strictEqual(sembraJs('SELECT * FROM t'), false);
    assert.strictEqual(sembraJs('{ "a": 1 }'), false);
  });

  prova('Un testo non analizzabile torna indietro intatto', () => {
    const rotto = '{ questo non è JSON valido';
    assert.strictEqual(formatCode(rotto), rotto);
  });

  /* --- Minificazione ----------------------------------------------------- */

  prova('minifyCode comprime un documento MQL', () => {
    assert.strictEqual(minifyCode('{\n  "stato": "attivo"\n}'), '{"stato":"attivo"}');
  });

  prova('minifyCode comprime l\'SQL su una riga', () => {
    assert.strictEqual(
      minifyCode('SELECT id, nome\nFROM utenti\nWHERE attivo = true'),
      'SELECT id, nome FROM utenti WHERE attivo = true',
    );
  });

  prova('La minificazione SQL non tocca il contenuto delle stringhe', () => {
    assert.strictEqual(minifySql("SELECT * FROM t WHERE s = 'a  b'"), "SELECT * FROM t WHERE s = 'a  b'");
  });

  prova('La minificazione SQL toglie i commenti', () => {
    assert.strictEqual(minifySql('SELECT 1 -- nota\nFROM t'), 'SELECT 1 FROM t');
  });

  prova('Uno script JavaScript NON viene minificato', () => {
    // Togliere gli a capo a uno script ne cambia il significato (punto e
    // virgola automatico, commenti di riga): meglio non fare nulla.
    const src = 'const a = 1\nprint(a) // nota\n';
    assert.strictEqual(minifyCode(src), src);
  });

  prova('Un testo non analizzabile torna indietro intatto anche minificando', () => {
    const rotto = '{ "a": ';
    assert.strictEqual(minifyCode(rotto), rotto);
  });

  /* --- Script JavaScript ------------------------------------------------ */

  prova('Rientri ricalcolati sui blocchi', () => {
    const src = [
      'for (const d of db.c.find({}).toArray()) {',
      'if (d.n > 1) {',
      'print(d.n);',
      '}',
      '}',
    ].join('\n');
    assert.deepStrictEqual(reindentJs(src).split('\n'), [
      'for (const d of db.c.find({}).toArray()) {',
      '  if (d.n > 1) {',
      '    print(d.n);',
      '  }',
      '}',
    ]);
  });

  prova('Rientri eccessivi vengono corretti', () => {
    const src = '        const a = 1;\n            print(a);';
    assert.deepStrictEqual(reindentJs(src).split('\n'), ['const a = 1;', 'print(a);']);
  });

  prova('Le graffe dentro le stringhe non contano', () => {
    const src = "const s = '{';\nprint(s);";
    assert.deepStrictEqual(reindentJs(src).split('\n'), ["const s = '{';", 'print(s);']);
  });

  prova('Il contenuto dei template literal multilinea è intoccabile', () => {
    const src = 'const t = `riga1\n      spazi   voluti\n`;\nprint(t);';
    const out = reindentJs(src).split('\n');
    assert.strictEqual(out[1], '      spazi   voluti', `il testo del template è stato alterato: ${out[1]}`);
    assert.strictEqual(out[3], 'print(t);');
  });

  prova('I commenti di blocco non alterano la profondità', () => {
    const src = '/* apre { qui */\nconst a = 1;';
    assert.deepStrictEqual(reindentJs(src).split('\n'), ['/* apre { qui */', 'const a = 1;']);
  });

  prova('Reindentare due volte dà lo stesso risultato', () => {
    const src = 'function f() {\nif (true) {\nreturn 1;\n}\n}';
    const una = reindentJs(src);
    assert.strictEqual(reindentJs(una), una);
  });

  prova('Il codice non viene riscritto, solo rientrato', () => {
    const src = 'const a=1;\nif(a){print( a )}';
    const out = reindentJs(src);
    assert.deepStrictEqual(out.split('\n').map((r) => r.trim()), ['const a=1;', 'if(a){print( a )}']);
  });

  if (falliti) {
    console.error(`\n${falliti} test falliti.`);
    process.exitCode = 1;
  } else {
    console.log('\nTutti i test del formattatore superati!');
  }
})();
