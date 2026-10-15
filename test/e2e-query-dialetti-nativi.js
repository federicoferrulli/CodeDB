'use strict';

// Solo SELECT: confronto differenziale sui server reali. Le query originali
// sono l'oracolo, la variante formattata/minificata deve conservare il risultato.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const { MongoClient } = require('mongodb');
const { translate } = require('../db/SqlToMql');

if (process.argv.includes('--mutant')) require('node:module').registerHooks({ load(url, context, next) {
  const r = next(url, context);
  return url.endsWith('/query-formatter.js') ? { ...r, source: String(r.source).replace('tokenizzaSql(sql, dbms)', "tokenizzaSql(sql, '')") } : r;
} });

(async () => {
  const { formatCode, minifyCode } = await import('../public/js/query-formatter.js');
  const my = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306), user: 'root' });
  const pg = new Client({ host: '127.0.0.1', port: Number(process.env.PGPORT || 5432), user: 'postgres', database: 'postgres' });
  const mongo = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.MONGO_PORT || 27017)}`);
  try {
    await pg.connect(); await mongo.connect();
    console.log('MySQL:', (await my.query('SELECT VERSION() AS v'))[0][0].v);
    console.log('PostgreSQL:', (await pg.query('SHOW server_version')).rows[0].server_version);
    const { KEYWORDS_MYSQL, KEYWORDS_POSTGRESQL } = require('../public/js/query-cataloghi.mjs');
    const paroleMy = (await my.query('SELECT WORD FROM INFORMATION_SCHEMA.KEYWORDS'))[0].map(r => r.WORD);
    const parolePg = (await pg.query('SELECT word FROM pg_get_keywords()')).rows.map(r => r.word.toUpperCase());
    assert.deepEqual(paroleMy.filter(p => !KEYWORDS_MYSQL.includes(p)), [], 'Keyword MySQL mancanti dal catalogo');
    assert.deepEqual(parolePg.filter(p => !KEYWORDS_POSTGRESQL.includes(p)), [], 'Keyword PostgreSQL mancanti dal catalogo');
    console.log(`  OK   inventari reali: ${paroleMy.length} keyword MySQL e ${parolePg.length} PostgreSQL coperte`);
    const queries = {
      mysql: [
        'SELECT 1--2 AS risultato',
        "SELECT 'l\\'isola' AS testo, 1e-9 AS numero",
        "SELECT JSON_EXTRACT('{\"a\":2}', '$.a') AS n",
        'WITH t AS (SELECT 1 AS n UNION ALL SELECT 2 AS n) SELECT n, SUM(n) OVER (ORDER BY n) AS somma FROM t ORDER BY n',
        'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1 /*! + 2 */ AS n',
        'SELECT 0xff AS esadecimale, 7 DIV 2 AS divisione, 7 MOD 2 AS resto',
      ],
      postgresql: [
        'SELECT 5 # 2 AS risultato',
        'SELECT |/ 9 AS radice, ||/ 8 AS cubica',
        "SELECT 'prima'\n'seconda' AS testo",
        "SELECT '{\"a\":2}'::jsonb->>'a' AS n, '{\"a\":2}'::jsonb @> '{\"a\":2}' AS incluso",
        "SELECT $$testo;--#$$ AS testo, E'\\n' AS a_capo",
        "WITH t(n) AS (VALUES (1),(2)) SELECT n, SUM(n) OVER (ORDER BY n ROWS UNBOUNDED PRECEDING) AS somma FROM t ORDER BY n",
        "SELECT ARRAY[1,2,3]::integer[] AS vettore, 1 /* fuori /* dentro */ fine */ + 2 AS n",
        "SELECT 'a' !~~* 'B' AS confronto",
      ],
    };
    for (const [dbms, elenco] of Object.entries(queries)) {
      const esegui = sql => dbms === 'mysql' ? my.query(sql).then(r => r[0]) : pg.query(sql).then(r => r.rows);
      for (const q of elenco) {
        const expected = await esegui(q);
        for (const fn of [formatCode, minifyCode]) assert.deepEqual(await esegui(fn(q, dbms)), expected, `${dbms}: ${fn.name}: ${q}`);
      }
      console.log(`  OK   ${dbms}: ${elenco.length} query, originali e due riscritture equivalenti`);
    }
    // Il risultato comune dei tre motori, su dati identici in memoria: $documents
    // evita persino di creare una collezione per questo confronto.
    const righe = [{ a: 2, b: 3, nome: ' ab ' }, { a: 5, b: 1, nome: null }];
    const cte = "WITH t AS (SELECT 2 AS a, 3 AS b, ' ab ' AS nome UNION ALL SELECT 5, 1, NULL) ";
    const comuni = [
      'SELECT a + b AS n FROM t ORDER BY n',
      'SELECT UPPER(TRIM(nome)) AS testo FROM t ORDER BY a',
      'SELECT a FROM t WHERE NOT nome IS NULL ORDER BY a',
      'SELECT a FROM t WHERE a NOT IN (2, NULL)',
      "SELECT CASE WHEN nome IS NULL THEN 0 ELSE a*b END AS n FROM t ORDER BY a",
      'SELECT ABS(a-b) AS n, COALESCE(nome, \'vuoto\') AS testo FROM t ORDER BY a',
    ];
    for (const sql of comuni) {
      const p = translate(sql);
      const stages = p.pipeline || [
        { $match: p.filter }, ...(Object.keys(p.sort || {}).length ? [{ $sort: p.sort }] : []),
        ...(Object.keys(p.projection || {}).length ? [{ $project: p.projection }] : []),
      ];
      const risultato = await mongo.db('admin').aggregate([{ $documents: righe }, ...stages]).toArray();
      const normalizza = rows => JSON.parse(JSON.stringify(rows));
      assert.deepEqual(normalizza(risultato), normalizza((await my.query(cte + sql))[0]), `MySQL/MQL: ${sql}`);
      assert.deepEqual(normalizza(risultato), normalizza((await pg.query(cte + sql)).rows), `PostgreSQL/MQL: ${sql}`);
    }
    console.log(`  OK   ${comuni.length} query SQL comuni: stessi risultati su MySQL, PostgreSQL e MongoDB`);
  } finally { await Promise.allSettled([my.end(), pg.end(), mongo.close()]); }
})().catch(err => { console.error(err); process.exitCode = 1; });
