'use strict';
const assert = require('node:assert/strict');
let routineSelettivePg;
if (process.argv.includes('--mutant')) {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  const file = require.resolve('../db/pg-routine-selezione');
  const source = fs.readFileSync(file, 'utf8'), changed = source.replace('while (pending.length)', 'while (false)');
  assert.notEqual(source, changed);
  const mod = new Module(file, module); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file)); mod._compile(changed, file);
  routineSelettivePg = mod.exports.routineSelettivePg;
} else ({ routineSelettivePg } = require('../db/pg-routine-selezione'));
module.exports = (async () => {
  const routines = [
    { name: 'radice', ddl: 'CREATE FUNCTION s.radice() RETURNS integer LANGUAGE plpgsql AS $$BEGIN RETURN s."aiuto preciso"(); /* estranea() */ END$$' },
    { name: 'aiuto preciso', ddl: "CREATE FUNCTION s.\"aiuto preciso\"() RETURNS integer LANGUAGE sql AS 'SELECT s.ultima()'" },
    { name: 'ultima', ddl: "CREATE FUNCTION s.ultima() RETURNS integer LANGUAGE sql AS $$SELECT 1 /* radice() */$$" },
    { name: 'estranea', ddl: 'CREATE FUNCTION s.estranea() RETURNS integer LANGUAGE sql AS $$SELECT 5$$' },
  ];
  const result = await routineSelettivePg({ query: async sql => ({ rows: sql.startsWith('WITH') ? [] : routines.map(({ name }) => ({ name })) }),
    targetDb: 's', collections: ['dati'], objects: { routines }, ddl: 'CREATE TABLE s.dati(valore integer DEFAULT s.radice())' });
  assert.deepEqual(result.map(r => r.name), ['radice', 'aiuto preciso', 'ultima'], '[PG-ROUTINE] includere la chiusura transitiva, escludere i commenti');
  console.log('OK routine PostgreSQL: dipendenze transitive, nomi quotati e commenti');
})().catch(error => { console.error(error); process.exitCode = 1; });
