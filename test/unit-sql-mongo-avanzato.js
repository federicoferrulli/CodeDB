'use strict';
const assert = require('node:assert/strict');
const { translate, translateWrite } = require('../db/SqlToMql');
let falliti = 0;
function prova(nome, fn) {
  try { fn(); console.log(`  OK   ${nome}`); }
  catch (e) { falliti++; console.error(`  FAIL ${nome}: ${e.message}`); }
}
prova('RIGHT e FULL JOIN includono il ramo delle righe destre senza corrispondenza', () => {
  for (const tipo of ['RIGHT', 'FULL OUTER']) {
    const p = translate(`SELECT a.id AS sinistra, b.id AS destra FROM a ${tipo} JOIN b ON a.k = b.k`);
    const ramo = p.pipeline.find(s => s.$unionWith)?.$unionWith;
    assert.equal(ramo?.coll, 'b');
    assert(ramo.pipeline.some(s => s.$lookup?.from === 'a'));
  }
});
prova('Funzioni finestra e frame ROWS vengono tradotti', () => {
  const p = translate('SELECT reparto, ROW_NUMBER() OVER (PARTITION BY reparto ORDER BY n) AS pos, SUM(n) OVER (PARTITION BY reparto ORDER BY n ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS totale FROM t');
  assert(p.pipeline.some(s => s.$setWindowFields));
  assert(JSON.stringify(p.pipeline).includes('"documents":[-1,"current"]'));
});
prova('WITH RECURSIVE produce un programma iterativo senza JavaScript sul server', () => {
  const p = translate('WITH RECURSIVE numeri(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numeri WHERE n < 4) SELECT n FROM numeri ORDER BY n');
  assert.equal(p.kind, 'program');
  assert(!JSON.stringify(p).includes('$function'));
});
prova('RETURNING fa parte del piano di INSERT, UPDATE e DELETE', () => {
  for (const sql of ["INSERT INTO t (nome) VALUES ('Ada') RETURNING nome", 'UPDATE t SET n=n+1 WHERE n=1 RETURNING n', 'DELETE FROM t WHERE n=1 RETURNING *']) {
    assert(translateWrite(sql).returning, sql);
  }
});
prova('SELECT senza FROM è indipendente dalle collezioni', () => {
  const p = translate('SELECT 1 AS n, UPPER(\'ciao\') AS saluto');
  assert.equal(p.coll, null);
  assert(p.pipeline[0].$documents);
});
if (falliti) process.exitCode = 1;
