'use strict';
const assert = require('node:assert/strict');
const sql = require('../db/SqlToMql');
let failed = 0;
for (const query of [
  'SELECT SUM(n*prezzo) AS totale,COUNT(DISTINCT categoria) AS categorie FROM t',
  'SELECT COALESCE(SUM(n),0)+COUNT(*) AS totale FROM t HAVING SUM(n)>0 OR COUNT(*)=0',
  'SELECT SUM(n) FILTER(WHERE valido=TRUE) AS totale FROM t',
  'SELECT UPPER(categoria) AS c,SUM(n) AS n FROM t GROUP BY UPPER(categoria) HAVING SUM(n)>1 ORDER BY SUM(n) DESC',
  'SELECT id FROM t WHERE id IN(SELECT id FROM u)',
  'SELECT id FROM t WHERE EXISTS(SELECT 1 FROM u WHERE u.id=t.id)',
  'SELECT id,(SELECT MAX(n) FROM u WHERE u.id=t.id) AS massimo FROM t',
]) {
  try { assert(sql.translate(query)); console.log(`OK ${query}`); }
  catch (e) { failed++; console.error(`FAIL ${query}: ${e.message}`); }
}
if (failed) process.exitCode = 1;
