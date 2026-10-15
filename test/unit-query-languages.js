'use strict';

// Regressioni fra dialetti: esercitano gli stessi moduli usati nell'editor.
const assert = require('node:assert/strict');

(async () => {
  if (process.argv.includes('--mutant')) {
    require('node:module').registerHooks({ load(url, context, nextLoad) {
      const r = nextLoad(url, context);
      if (url.endsWith('/query-lexer.js')) {
        const source = String(r.source);
        assert(source.includes('if (operatore) {'));
        return { ...r, source: source.replace('if (operatore) {', "if (operatore && operatore[0] !== '->>') {") };
      }
      return r;
    } });
  }
  const { suggerisci, motoreDalTesto, applicaSuggerimento } = await import('../public/js/intellisense.js');
  const { formatCode, minifyCode } = await import('../public/js/query-formatter.js');
  const { highlightQueryCode } = await import('../public/js/query-highlighter.js');
  const { splitStatements } = await import('../public/js/sql-split.js');
  const { splitStatementsDetailed } = require('../db/sqlText');
  const schema = { tabelle: [
    { nome: 'utenti', campi: [{ nome: 'nome' }, { nome: 'email' }] },
    { nome: 'ordini', campi: [{ nome: 'totale' }] },
  ] };
  let falliti = 0;
  function prova(nome, fn) {
    try { fn(); console.log(`  OK   ${nome}`); }
    catch (err) { falliti++; console.error(`  FAIL ${nome}: ${err.message}`); }
  }
  function voci(testo, dbms = 'postgresql', altre = {}) {
    const cursore = testo.indexOf('|');
    return suggerisci({ testo: testo.replace('|', ''), cursore, motore: 'auto',
      ripiego: dbms === 'mongodb' ? 'mongo' : 'sql', dbms, schema, limite: 1000, ...altre }).map(x => x.testo);
  }
  prova('PostgreSQL non eredita funzioni di data MySQL', () => {
    for (const parola of ['YEAR', 'MONTH', 'DAY', 'IFNULL', 'GROUP_CONCAT']) {
      const testo = `SELECT ${parola.slice(0, -1)}`;
      assert(!suggerisci({ testo, cursore: testo.length, dbms: 'postgresql', limite: 1000 })
        .some(v => v.testo === parola && v.tipo === 'funzione'), parola);
    }
    assert(voci('SELECT YEA|', 'mysql').includes('YEAR'));
  });
  prova('Cataloghi estesi: finestre, JSON, DDL e amministrazione', () => {
    for (const [dbms, parole] of [
      ['mysql', ['JSON_TABLE', 'CUME_DIST', 'NTH_VALUE', 'SQL_CALC_FOUND_ROWS', 'RESIGNAL']],
      ['postgresql', ['JSONB_PATH_QUERY', 'CUME_DIST', 'NTH_VALUE', 'TABLESAMPLE', 'VACUUM']],
    ]) for (const parola of parole) assert(voci(`SELECT ${parola.slice(0, -1)}|`, dbms).includes(parola), `${dbms}: ${parola}`);
  });
  prova('SQL→MQL non promette costrutti non traducibili', () => {
    for (const parola of ['GRANT']) {
      assert(!voci(`SELECT ${parola.slice(0, -1)}|`, 'mongodb').includes(parola), parola);
    }
    for (const parola of ['WITH', 'CASE', 'UPPER', 'OVER', 'RETURNING', 'ROW_NUMBER']) assert(voci(`SELECT ${parola.slice(0, -1)}|`, 'mongodb').includes(parola), parola);
  });
  prova('Punto e virgola nei valori e nei commenti non cambia linguaggio', () => {
    for (const testo of ["SELECT ';' FROM utenti WH", 'SELECT $$;$$ FROM utenti WH', 'SELECT 1 /* ; */ FROM utenti WH']) {
      assert.equal(motoreDalTesto(testo, testo.length), 'sql', testo);
    }
  });
  prova('Alias limitati alla propria istruzione, ignorando stringhe e commenti', () => {
    assert.deepEqual(voci('SELECT u.| FROM utenti u; SELECT * FROM ordini u'), ['nome', 'email']);
    assert.deepEqual(voci("SELECT 'FROM ordini u', u.| FROM utenti u /* JOIN ordini u */"), ['nome', 'email']);
    assert(voci('SELECT tot| FROM utenti JOIN ordini ON 1 = 1').includes('totale'));
  });
  prova('Completamento silenzioso nei commenti e nei valori SQL', () => {
    assert.deepEqual(voci('SELECT 1 -- SEL|'), []);
    assert.deepEqual(voci("SELECT 'SEL|"), []);
    assert.deepEqual(voci('SELECT $$SEL|'), []);
  });
  prova('MongoDB: stadi, espressioni, aggiornamenti e variabili', () => {
    for (const parola of ['$unionWith', '$fill', '$dateTrunc', '$percentile', '$setOnInsert', '$bit', '$$ROOT']) {
      assert(voci(`db.utenti.aggregate([{ ${parola.slice(0, -1)}|`, 'mongodb').includes(parola), parola);
    }
    assert(voci('db.getCollection("utenti").agg|', 'mongodb').includes('aggregate'));
    assert(voci('db.utenti.find({}).so|', 'mongodb').includes('sort'));
    assert(voci('db.utenti.aggregate([{ $project: { x: "$no|" } }])', 'mongodb').includes('$nome'));
  });
  prova('Sostituzione al centro del token e nome quotato', () => {
    assert.equal(applicaSuggerimento('SELECT SELCT', 10, 'SELECT').testo, 'SELECT SELECT');
    assert.equal(applicaSuggerimento('SELECT "NoVecchio"', 10, 'Nome', { tipo: 'campo', dbms: 'postgresql' }).testo, 'SELECT "Nome"');
  });
  prova('Operatori, parametri e numeri restano unità indivisibili', () => {
    assert.match(formatCode('select 1 from utenti', 'postgresql'), /^SELECT 1\nFROM utenti$/);
    for (const [dbms, testo, frammenti] of [
      ['postgresql', "SELECT doc->>'nome', doc#>>'{a,b}', $1, 1e-9, E'\\n', doc @> '{}' FROM utenti", ['->>', '#>>', '$1', '1e-9', "E'\\n'", '@>']],
      ['mysql', "SELECT doc->>'$.nome', 0xff, 1e+9, @x:=2 FROM utenti", ['->>', '0xff', '1e+9', ':=']],
    ]) for (const fn of [formatCode, minifyCode]) {
      const out = fn(testo, dbms);
      for (const frammento of frammenti) assert(out.includes(frammento), out);
    }
    assert.match(formatCode('select date, point from json', 'mysql'), /SELECT date, point\nFROM json/);
  });
  prova('Script: operatori PostgreSQL e stringhe MySQL non nascondono separatori', () => {
    for (const [dbms, testo] of [
      ['postgresql', "SELECT doc #>> '{a,b}' FROM utenti; SELECT 2"],
      ['postgresql', 'SELECT 5 # 2; SELECT 2'],
      ['postgresql', 'SELECT /* esterno /* interno */ ; commento */ 1; SELECT 2'],
      ['mysql', "SELECT 'l\\'isola; qui'; SELECT 2"],
    ]) {
      const opts = { dbms, backslashEscape: dbms === 'mysql' };
      assert.equal(splitStatements(testo, opts).length, 2, `client ${testo}`);
      assert.equal(splitStatementsDetailed(testo, opts).length, 2, `server ${testo}`);
    }
  });
  prova('Commenti eseguibili e hint MySQL sopravvivono', () => {
    for (const fn of [formatCode, minifyCode]) {
      const out = fn('SELECT /*+ MAX_EXECUTION_TIME(1000) */ /*! STRAIGHT_JOIN */ * FROM utenti', 'mysql');
      assert(out.includes('/*+ MAX_EXECUTION_TIME(1000) */'), out);
      assert(out.includes('/*! STRAIGHT_JOIN */'), out);
    }
  });
  prova('Il commento di riga non inghiotte il codice successivo', () => {
    const out = formatCode('SELECT 1 -- nota\n+ 2', 'postgresql');
    assert.match(out, /-- nota\n\s*\+ 2/);
  });
  prova('La shell MongoDB non subisce mai la riscrittura SQL', () => {
    const testo = 'db.utenti.find({in: 1, date: "x"}).limit(2)';
    assert.equal(formatCode(testo, 'mongodb'), testo);
    assert.equal(minifyCode(testo, 'mongodb'), testo);
  });
  prova('Evidenziatore: dialetti, commenti e stringhe PostgreSQL', () => {
    assert.match(highlightQueryCode('SELECT JSONB_PATH_QUERY(doc, \'$\')', 'postgresql'), /hl-function">JSONB_PATH_QUERY/);
    assert.match(highlightQueryCode('SELECT $$select; from$$', 'postgresql'), /hl-string">\$\$select; from\$\$/);
    assert.match(highlightQueryCode('db.utenti.find({}) // nota', 'mongodb'), /hl-comment">\/\/ nota/);
    assert.match(highlightQueryCode('SELECT 1 # nota', 'mysql'), /hl-comment"># nota/);
  });
  if (falliti) process.exitCode = 1;
  else console.log('Tutte le regressioni dei linguaggi Query & Aggregate superate.');
})().catch(err => { console.error(err); process.exitCode = 1; });
