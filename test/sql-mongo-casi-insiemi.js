'use strict';
module.exports = [
  ['INTERSECT DISTINCT e nomi posizionali', 'SELECT n AS x FROM t INTERSECT SELECT n AS y FROM t WHERE id<=2 ORDER BY x', [{ x: 10 }]],
  ['INTERSECT ALL conserva la molteplicità minima', 'SELECT n FROM t INTERSECT ALL SELECT n FROM t WHERE id<=2 ORDER BY n', [{ n: 10 }, { n: 10 }]],
  ['EXCEPT ALL sottrae le molteplicità', 'SELECT n FROM t EXCEPT ALL SELECT n FROM t WHERE id=1 ORDER BY n NULLS FIRST', [{ n: null }, { n: 10 }, { n: 20 }]],
  ['EXCEPT DISTINCT esclude tutte le copie', 'SELECT n FROM t EXCEPT DISTINCT SELECT n FROM t WHERE id=1 ORDER BY n NULLS FIRST', [{ n: null }, { n: 20 }]],
  ['NULL coincide negli insiemi', 'SELECT n FROM t WHERE id=4 INTERSECT SELECT n FROM t WHERE id=4', [{ n: null }]],
  ['INTERSECT ha precedenza su UNION', 'SELECT 1 AS n UNION SELECT 2 AS n INTERSECT SELECT 2 AS n ORDER BY n', [{ n: 1 }, { n: 2 }]],
  ['Parentesi cambiano la precedenza', '(SELECT 1 AS n UNION SELECT 2 AS n) INTERSECT SELECT 2 AS n', [{ n: 2 }]],
  ['EXCEPT associa a sinistra', 'SELECT n FROM t EXCEPT SELECT n FROM t WHERE id=1 EXCEPT SELECT n FROM t WHERE id=4', [{ n: 20 }]],
  ['Operando con limite locale', '(SELECT n FROM t ORDER BY id LIMIT 1) EXCEPT SELECT n FROM t WHERE id=3', [{ n: 10 }]],
  ['Sorgente sinistra vuota', 'SELECT n FROM t WHERE id=999 INTERSECT ALL SELECT n FROM t', []],
];
