'use strict';
const assert = require('node:assert/strict');
const { schemaMergeConColonneLocali: actual } = require('../db/schema-merge');
const merge = process.argv.includes('--mutant') ? incoming => incoming : actual;
const source = 'CREATE TABLE t (id integer NOT NULL, valore numeric(10,2), CONSTRAINT pk PRIMARY KEY (id));';
for (const extra of ["nota text DEFAULT 'locale, (test)'", 'nota text DEFAULT $$test,),$$',
  '"nota,)" text DEFAULT E\'a\\\'b,c\'', '`nota,)` varchar(30) DEFAULT \'x,y\'']) {
  const baseline = source.replace(', CONSTRAINT', () => ', ' + extra + ', CONSTRAINT');
  assert.equal(merge(source, baseline), baseline, '[MERGE-COLONNE] preserva colonna e default locale');
}
for (const changed of [source.replace('integer', 'bigint'), source.replace('numeric(10,2)', 'numeric(10,3)'),
  source.replace('PRIMARY KEY (id)', 'PRIMARY KEY (valore)'), source.replace('valore numeric(10,2)', 'valore numeric(10,2) DEFAULT 5'),
  source.replace(');', ', CHECK (valore>0));'), source.replace('TABLE t', 'TABLE altro')]) {
  assert.equal(merge(source, changed), source, 'Una divergenza reale resta visibile al gate');
}
assert.equal(merge(source, null), source);
assert.equal(merge(source, source), source);
console.log('OK schema merge: colonne locali, espressioni e incompatibilità distinte');
