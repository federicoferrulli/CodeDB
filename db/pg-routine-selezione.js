'use strict';

// La selezione delle routine deve essere la stessa nel piano atteso e nel
// pre-caricamento. Le dipendenze native includono default, vincoli e trigger.
async function routineSelettivePg({ query, targetDb, collections, objects, ddl, references = [] }) {
  const dependencies = await query(`WITH RECURSIVE selected AS (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
  ), roots(classid,objid) AS (
    SELECT 'pg_class'::regclass::oid,oid FROM selected
    UNION SELECT 'pg_attrdef'::regclass::oid,oid FROM pg_attrdef WHERE adrelid IN (SELECT oid FROM selected)
    UNION SELECT 'pg_constraint'::regclass::oid,oid FROM pg_constraint WHERE conrelid IN (SELECT oid FROM selected)
    UNION SELECT 'pg_trigger'::regclass::oid,oid FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM selected)
  ), dependencies(classid,objid) AS (
    SELECT classid,objid FROM roots
    UNION SELECT d.refclassid,d.refobjid FROM dependencies x JOIN pg_depend d ON d.classid=x.classid AND d.objid=x.objid
  ) SELECT DISTINCT p.proname AS name FROM dependencies d JOIN pg_proc p ON d.classid='pg_proc'::regclass AND d.objid=p.oid
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`, [targetDb, collections]);
  const existing = await query(`SELECT DISTINCT p.proname AS name FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`, [targetDb]);
  const present = new Set(existing.rows.map(item => item.name));
  const needed = new Set(dependencies.rows.map(item => item.name));
  const { stripSqlNoise } = require('./sqlText');
  const sourceDdl = stripSqlNoise([ddl, ...references, ...(objects.triggers || []).filter(item => collections.includes(item.table)).map(item => item.ddl)].join('\n'),
    { keepIdentifiers: true, dbms: 'postgresql' });
  const calls = (text, routine) => {
    const escaped = routine.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quoted = ('"' + routine.name.replaceAll('"', '""') + '"').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:' + quoted + '|(?:^|[^\\w$])' + escaped + ')\\s*\\(', 'u').test(text);
  };
  for (const routine of objects.routines || []) if (calls(sourceDdl, routine)) needed.add(routine.name);
  // Le routine SQL con corpo stringa e quelle PL/pgSQL non registrano tutte
  // le chiamate in pg_depend. Seguiamo anche i corpi sorgente fino a punto fisso.
  const pending = (objects.routines || []).filter(item => !present.has(item.name) || needed.has(item.name));
  const visited = new Set();
  while (pending.length) {
    const routine = pending.shift();
    if (visited.has(routine.ddl)) continue;
    visited.add(routine.ddl);
    const definition = String(routine.ddl || '');
    if (!/\bLANGUAGE\s+(?:sql|plpgsql)\b/i.test(definition)) continue;
    const body = /\bAS\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*?)\1/i.exec(definition)?.[2]
      ?? /\bAS\s+'((?:[^']|'')*)'/i.exec(definition)?.[1]?.replaceAll("''", "'")
      ?? definition;
    const code = stripSqlNoise(body, { keepIdentifiers: true, dbms: 'postgresql' });
    for (const callee of objects.routines || []) if (calls(code, callee)) {
      needed.add(callee.name);
      if (!visited.has(callee.ddl)) pending.push(callee);
    }
  }
  return (objects.routines || []).filter(item => !present.has(item.name) || needed.has(item.name));
}

// I valori reg* non generano dipendenze in pg_depend. Leggiamo soltanto i
// file delle tabelle scelte con colonne di riferimento, senza accumulare righe.
async function riferimentiRoutineBackup(chain, collections) {
  const { readLines, fileDelBackup } = require('../backup/lib/util');
  const { transform } = require('./pg-references');
  const refs = new Set();
  const add = value => { if (value != null) refs.add(String(value)); return value; };
  const kind = column => String(column.type || '').replace(/^pg_catalog\./, '').replaceAll('"', '').toLowerCase();
  for (const layer of chain) for (const file of layer.manifest.files) {
    if (file.kind !== 'data' || !collections.includes(file.collection)) continue;
    const columns = (file.columnSchema || []).filter(column => /^regproc(?:edure)?(?:\[\])?$/.test(kind(column)) || column.references || column.referenceShape);
    if (!columns.length) continue;
    for await (const line of readLines(fileDelBackup(layer.dir, file.path))) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      for (const column of columns) {
        const value = row[column.name];
        if (value == null) continue;
        if (value.$pgReference?.kind === 'nested') {
          for (const ref of value.$pgReference.refs || []) if (ref.kind === 'regproc') add(ref.value);
          if (column.referenceShape) transform(value.$pgReference.value, column.referenceShape, v => v,
            (v, node) => node.type === 'regprocedure' ? add(v) : v);
        } else if (column.referenceShape) {
          transform(value, column.referenceShape, v => v,
            (v, node) => /^regproc(?:edure)?$/.test(node.type) ? add(v) : v);
        } else {
          const type = value.$pgReference?.kind || kind(column);
          if (!/^regproc(?:edure)?(?:\[\])?$/.test(type)) continue;
          const node = { kind: 'reg', type: type.replace('[]', '') };
          transform(value.$pgReference?.value ?? value, type.endsWith('[]') ? { kind: 'array', child: node } : node, v => v, add);
        }
      }
    }
  }
  return [...refs];
}

module.exports = { routineSelettivePg, riferimentiRoutineBackup };
