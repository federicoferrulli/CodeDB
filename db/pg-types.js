'use strict';

const { quotaSempre } = require('./identificatori');
const qid = n => quotaSempre(n, 'postgresql');
const literal = s => "'" + String(s).replace(/'/g, "''") + "'";

async function readTypes(q, schema) {
  const rows = (await q(`SELECT t.oid, t.typname AS name, t.typtype AS kind,
      t.typrelid, t.typnotnull, t.typdefault, format_type(t.typbasetype,t.typtypmod) AS base,
      t.typlen,t.typbyval,t.typalign,t.typstorage,t.typcategory,t.typispreferred,t.typdelim,t.typcollation,
      t.typinput::regproc::text AS input,t.typoutput::regproc::text AS output,t.typreceive::regproc::text AS receive,
      t.typsend::regproc::text AS send,t.typmodin::regproc::text AS typmodin,t.typmodout::regproc::text AS typmodout,t.typsubscript::regproc::text AS subscript,
      CASE WHEN t.typcollation<>b.typcollation THEN t.typcollation::regcollation::text END AS collation
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_type b ON b.oid=t.typbasetype LEFT JOIN pg_class c ON c.oid=t.typrelid
    WHERE n.nspname=$1 AND (t.typtype IN ('e','d','r','b') OR (t.typtype='c' AND c.relkind='c'))
      AND NOT EXISTS (SELECT 1 FROM pg_type a WHERE a.typarray=t.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
    ORDER BY t.oid`, [schema])).rows;
  const types = [];
  for (const t of rows) {
    let ddl = `CREATE ${t.kind === 'd' ? 'DOMAIN' : 'TYPE'} ${qid(t.name)}`;
    if (t.kind === 'e') {
      const labels = (await q('SELECT enumlabel FROM pg_enum WHERE enumtypid=$1 ORDER BY enumsortorder', [t.oid])).rows;
      ddl += ` AS ENUM (${labels.map(r => literal(r.enumlabel)).join(', ')})`;
    } else if (t.kind === 'd') {
      ddl += ` AS ${t.base}${t.collation ? ' COLLATE ' + t.collation : ''}${t.typdefault != null ? ' DEFAULT ' + t.typdefault : ''}${t.typnotnull ? ' NOT NULL' : ''}`;
      const constraints = (await q('SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contypid=$1 ORDER BY conname', [t.oid])).rows;
      for (const c of constraints) ddl += ` CONSTRAINT ${qid(c.conname)} ${c.def}`;
    } else if (t.kind === 'c') {
      const attrs = (await q(`SELECT a.attname, format_type(a.atttypid,a.atttypmod) AS type,
          CASE WHEN a.attcollation<>t.typcollation THEN a.attcollation::regcollation::text END AS collation
        FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [t.typrelid])).rows;
      ddl += ` AS (${attrs.map(a => `${qid(a.attname)} ${a.type}${a.collation ? ' COLLATE ' + a.collation : ''}`).join(', ')})`;
    } else if (t.kind === 'b') {
      const opts=[`INPUT = ${t.input}`,`OUTPUT = ${t.output}`,`INTERNALLENGTH = ${t.typlen<0?'VARIABLE':t.typlen}`,
        `ALIGNMENT = ${{c:'char',s:'int2',i:'int4',d:'double'}[t.typalign]}`,`STORAGE = ${{p:'plain',e:'external',m:'main',x:'extended'}[t.typstorage]}`,
        `CATEGORY = ${literal(t.typcategory)}`,`DELIMITER = ${literal(t.typdelim)}`];
      for(const key of ['receive','send','typmodin','typmodout','subscript'])if(t[key]!=='-')opts.push(`${{typmodin:'TYPMOD_IN',typmodout:'TYPMOD_OUT'}[key]||key.toUpperCase()} = ${t[key]}`);
      if(t.typbyval)opts.push('PASSEDBYVALUE');if(t.typispreferred)opts.push('PREFERRED = true');if(t.typcollation)opts.push('COLLATABLE = true');
      if(t.typdefault!=null)opts.push(`DEFAULT = ${literal(t.typdefault)}`);
      ddl+=` (${opts.join(', ')})`;
    } else {
      const r = (await q(`SELECT rngsubtype::regtype::text AS subtype, rngcollation::regcollation::text AS collation,
          rngcanonical::regproc::text AS canonical, rngsubdiff::regproc::text AS subdiff,
          m.typname AS multirange, o.opcname, n.nspname AS opcschema
        FROM pg_range r JOIN pg_type m ON m.oid=r.rngmultitypid JOIN pg_opclass o ON o.oid=r.rngsubopc
        JOIN pg_namespace n ON n.oid=o.opcnamespace WHERE rngtypid=$1`, [t.oid])).rows[0];
      const opts = [`SUBTYPE = ${r.subtype}`, `SUBTYPE_OPCLASS = ${qid(r.opcschema)}.${qid(r.opcname)}`, `MULTIRANGE_TYPE_NAME = ${qid(r.multirange)}`];
      if (r.collation !== '-') opts.push(`COLLATION = ${r.collation}`);
      if (r.canonical !== '-') opts.push(`CANONICAL = ${r.canonical}`);
      if (r.canonical !== '-') t.shell = true;
      if (r.subdiff !== '-') opts.push(`SUBTYPE_DIFF = ${r.subdiff}`);
      ddl += ` AS RANGE (${opts.join(', ')})`;
    }
    const dependencies = (await q(`SELECT DISTINCT CASE WHEN d.refclassid='pg_proc'::regclass THEN 'routine:'||p.proname ELSE 'type:'||COALESCE(parent.typname,rt.typname) END AS name
      FROM pg_depend d LEFT JOIN pg_proc p ON d.refclassid='pg_proc'::regclass AND p.oid=d.refobjid
      LEFT JOIN pg_type rt ON d.refclassid='pg_type'::regclass AND rt.oid=d.refobjid
      LEFT JOIN pg_type parent ON parent.typarray=rt.oid
      WHERE ((d.classid='pg_type'::regclass AND d.objid=$1) OR (d.classid='pg_class'::regclass AND d.objid=$2)
        OR (d.classid='pg_constraint'::regclass AND d.objid IN(SELECT oid FROM pg_constraint WHERE contypid=$1)))
        AND ((p.pronamespace=(SELECT oid FROM pg_namespace WHERE nspname=$3)) OR (rt.typnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$3)))`, [t.oid,t.typrelid,schema])).rows.map(r=>r.name).sort();
    types.push({ name: t.name, kind: t.kind === 'd' ? 'domain' : 'type', ddl, dependencies: dependencies.filter(d=>d!=='type:'+t.name), ...(t.kind==='b'||t.shell?{shell:true}:{}) });
  }
  return types;
}

async function readCollations(q, schema) {
  const rows = (await q(`SELECT c.collname AS name, to_jsonb(c) AS properties FROM pg_collation c
    JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname=$1
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_collation'::regclass AND d.objid=c.oid AND d.deptype='e')
    ORDER BY c.collname`, [schema])).rows;
  return rows.map(({name, properties: c}) => {
    const provider = {i:'icu',c:'libc',b:'builtin'}[c.collprovider];
    if (!provider) throw new Error(`Provider della collation "${name}" non riconosciuto: ${c.collprovider}.`);
    const options = [`provider = ${provider}`, `deterministic = ${c.collisdeterministic !== false}`];
    if (provider === 'libc') options.push(`lc_collate = ${literal(c.collcollate)}`, `lc_ctype = ${literal(c.collctype)}`);
    else options.push(`locale = ${literal(c.colllocale ?? c.colliculocale)}`);
    if (c.collicurules) options.push(`rules = ${literal(c.collicurules)}`);
    if (c.collversion) options.push(`version = ${literal(c.collversion)}`);
    return {name, ddl:`CREATE COLLATION ${qid(name)} (${options.join(', ')})`};
  });
}

// Le estensioni contengono codice nativo: il file dichiara le dipendenze, non
// trasferisce librerie eseguibili o modifica estensioni condivise con altri schemi.
async function readExtensions(q, schema) {
  return (await q(`WITH RECURSIVE used(oid) AS (
      SELECT a.atttypid FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped
      UNION SELECT d.refobjid FROM used u JOIN pg_depend d ON d.objid=u.oid AND d.classid='pg_type'::regclass AND d.refclassid='pg_type'::regclass
    ) SELECT DISTINCT e.extname AS name, e.extversion AS version, n.nspname AS schema
    FROM used u JOIN pg_depend d ON d.objid=u.oid AND d.classid='pg_type'::regclass AND d.refclassid='pg_extension'::regclass
    JOIN pg_extension e ON e.oid=d.refobjid JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname`, [schema])).rows;
}

async function checkExtensions(strategy, required) {
  if (!required?.length) return;
  const installed = (await strategy.pool.query('SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace')).rows;
  for (const e of required) if (!installed.some(i => i.name === e.name && i.version === e.version && i.schema === e.schema)) {
    throw new Error(`Il trasferimento richiede l'estensione PostgreSQL ${e.name} ${e.version} nello schema ${e.schema}. Installare la stessa estensione prima del ripristino.`);
  }
}

function prelude(objects) {
  if(!objects.types?.length)return [];
  const types=objects.types, shell=new Set(types.filter(t=>t.shell).map(t=>'type:'+t.name));
  const nodes=[...types.map(t=>({...t,key:'type:'+t.name})),...(objects.routines||[]).map(r=>({...r,key:'routine:'+r.name}))];
  const keys=new Set(nodes.map(n=>n.key));
  const done=new Set();const out=types.filter(t=>t.shell).map(t=>`CREATE TYPE ${qid(t.name)}`);
  let pending=nodes;
  while(pending.length){
    const next=[];
    for(const n of pending){
      const ready=(n.dependencies||[]).every(d=>!keys.has(d)||done.has(d)||(n.key.startsWith('routine:')&&shell.has(d)));
      if(ready){out.push(n.ddl);done.add(n.key);}else next.push(n);
    }
    if(next.length===pending.length)throw new Error('Dipendenze cicliche fra tipi e routine PostgreSQL: '+next.map(n=>n.name).join(', '));
    pending=next;
  }
  return out;
}

module.exports = { readTypes, readCollations, readExtensions, checkExtensions, prelude };
