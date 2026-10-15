'use strict';

// Attraversa gli ingressi usati dall'editor, con sintassi valida dei due DBMS.
const assert = require('node:assert/strict');

module.exports = (async () => {
  if (process.argv.includes('--mutant')) require('node:module').registerHooks({ load(url, context, next) {
    const r = next(url, context);
    return url.endsWith('/query-formatter.js') ? { ...r, source: String(r.source).replace('tokenizzaSql(sql, dbms)', "tokenizzaSql(sql, '')") } : r;
  } });
  const { formatCode, minifyCode } = await import('../public/js/query-formatter.js');
  const { highlightQueryCode } = await import('../public/js/query-highlighter.js');
  const cataloghi = await import('../public/js/query-cataloghi.mjs');
  const { suggerisci } = await import('../public/js/intellisense.js');
  const { vocabolarioSql, OPERATORI_MQL } = await import('../public/js/sql-dialetti.js');
  let falliti = 0;
  function prova(nome, fn) {
    try { fn(); console.log(`  OK   ${nome}`); }
    catch (err) { falliti++; console.error(`  FAIL ${nome}: ${err.message}`); }
  }
  prova('PostgreSQL: la minificazione conserva XOR e la seconda istruzione', () => {
    assert.equal(minifyCode('SELECT 5 # 2; SELECT 3;', 'postgresql'), 'SELECT 5 # 2; SELECT 3;');
  });
  prova('MySQL: due meno senza spazio non aprono un commento', () => {
    assert.equal(minifyCode('SELECT 1--2; SELECT 3;', 'mysql'), 'SELECT 1 - - 2; SELECT 3;');
  });
  prova('PostgreSQL: operatori composti e personalizzati restano indivisibili', () => {
    for (const op of ['|/', '||/', '#', '#>>', '@@', '?|', '!~~*', '<^>']) {
      for (const fn of [formatCode, minifyCode]) assert(fn(`SELECT a ${op} b FROM t`, 'postgresql').includes(op), op);
    }
  });
  prova('PostgreSQL: gli a capo fra stringhe concatenate sono significativi', () => {
    for (const fn of [formatCode, minifyCode]) {
      assert.match(fn("SELECT 'prima'\n'seconda'", 'postgresql'), /'prima'\s*\n\s*'seconda'/);
    }
  });
  prova('Tutte le keyword dei cataloghi hanno una classificazione nell’evidenziatore', () => {
    for (const [motore, nome] of [['mysql', 'KEYWORDS_MYSQL'], ['postgresql', 'KEYWORDS_POSTGRESQL']]) {
      for (const parola of cataloghi[nome]) {
        assert.match(highlightQueryCode(`SELECT ${parola}`, motore), new RegExp(`hl-(?:keyword|type|function|bool)">${parola}</span>`), `${motore}: ${parola}`);
      }
    }
  });
  prova('I nomi di funzioni usati come tabelle conservano le maiuscole originali', () => {
    for (const fn of [formatCode, minifyCode]) {
      assert.match(fn('select * from MyFunction(1)', 'postgresql'), /MyFunction\(1\)/);
      assert.match(fn('select * from date', 'mysql'), /from date/i);
    }
  });
  prova('Tutte le funzioni dei dialetti sono riconosciute e suggerite', () => {
    for (const dbms of ['mysql', 'postgresql', 'mongodb']) {
      for (const nome of vocabolarioSql(dbms).funzioni) {
        assert(highlightQueryCode(`SELECT ${nome}(a) FROM t`, dbms).includes(`hl-function">${nome}</span>`), `${dbms}: ${nome}`);
        const testo = `SELECT ${nome.slice(0, -1)}`;
        assert(suggerisci({ testo, cursore: testo.length, dbms, limite: 2000 }).some(v => v.testo.toUpperCase() === nome.toUpperCase()), `${dbms}: ${nome}`);
      }
    }
  });
  prova('Tutti gli operatori MQL nominali del catalogo sono raggiungibili nel completamento', () => {
    for (const nome of OPERATORI_MQL.filter(n => /^\$\w+$/.test(n))) {
      const testo = `db.c.aggregate([{ ${nome.slice(0, -1)}`;
      assert(suggerisci({ testo, cursore: testo.length, dbms: 'mongodb', motore: 'auto', ripiego: 'mongo', limite: 2000 }).some(v => v.testo === nome), nome);
    }
  });
  if (falliti) process.exitCode = 1;
  else console.log('Copertura lessicale e conservazione della sintassi superate.');
})().catch(err => { console.error(err); process.exitCode = 1; });
