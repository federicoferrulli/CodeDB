'use strict';

const { quotaSempre } = require('./identificatori');
const qid = name => quotaSempre(name,'postgresql');

async function catalogoPartizioni(query, schema) {
  const { rows } = await query(`SELECT c.relname AS name, pg_get_partkeydef(c.oid) AS key,
      (SELECT cn.nspname FROM pg_inherits h JOIN pg_class ch ON ch.oid=h.inhrelid
        JOIN pg_namespace cn ON cn.oid=ch.relnamespace WHERE h.inhparent=c.oid AND cn.oid<>n.oid LIMIT 1) AS "schemaFigliaEsterna",
      parent.relname AS parent, pn.nspname AS "parentSchema", pg_get_expr(c.relpartbound,c.oid) AS bound
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_inherits i ON i.inhrelid=c.oid AND c.relispartition
    LEFT JOIN pg_class parent ON parent.oid=i.inhparent LEFT JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('p','r') AND (c.relkind='p' OR c.relispartition)`,[schema]);
  return new Map(rows.map(row=>[row.name,row]));
}

function ordinaPartizioni(nomi, catalogo) {
  const ordinati = new Set();
  const visit = nome => {
    if (ordinati.has(nome)) return;
    const parent = catalogo.get(nome)?.parent;
    if (parent && nomi.includes(parent)) visit(parent);
    ordinati.add(nome);
  };
  for (const nome of nomi) visit(nome);
  return [...ordinati];
}

async function ddlFiglia(query, schema, table, part, qualificato) {
  const id = name => qualificato ? qid(schema)+'.'+qid(name) : qid(name);
  const { rows } = await query(`SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS ddl
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname=$2 AND c.conislocal AND c.conparentid=0
      AND c.contype IN ('c','p','u','x') ORDER BY c.conname`,[schema,table]);
  const options = rows.map(c => 'CONSTRAINT '+qid(c.name)+' '+c.ddl);
  const overrides = await query(`SELECT a.attname AS name, a.attnotnull AND NOT p.attnotnull AS nn,
      pg_get_expr(d.adbin,d.adrelid) AS def, a.attgenerated AS generated,
      pg_get_expr(pd.adbin,pd.adrelid) AS parentdef
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_inherits i ON i.inhrelid=t.oid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
    JOIN pg_attribute p ON p.attrelid=i.inhparent AND p.attname=a.attname AND NOT p.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_attrdef pd ON pd.adrelid=p.attrelid AND pd.adnum=p.attnum
    WHERE n.nspname=$1 AND t.relname=$2 ORDER BY a.attnum`,[schema,table]);
  for (const c of overrides.rows) {
    if (!c.nn && c.def === c.parentdef) continue;
    let col = qid(c.name) + ' WITH OPTIONS';
    if (c.nn) col += ' NOT NULL';
    if (c.def !== c.parentdef) col += c.generated
      ? ' GENERATED ALWAYS AS ('+c.def+') '+(c.generated==='v'?'VIRTUAL':'STORED')
      : ' DEFAULT '+(c.def ?? 'NULL');
    options.unshift(col);
  }
  const padre = part.parentSchema && part.parentSchema !== schema ? qid(part.parentSchema)+'.'+qid(part.parent) : id(part.parent);
  return 'CREATE TABLE '+id(table)+' PARTITION OF '+padre+(options.length?' ('+options.join(', ')+')':'')
    +' '+part.bound+(part.key?' PARTITION BY '+part.key:'')+';';
}

function selezionePartizioni(chain, selected) {
  if (!selected) return selected;
  const names = new Set(selected), parents = new Map();
  for (const layer of chain) for (const f of layer.manifest.files) if (f.kind === 'data') parents.set(f.collection,f.partitionParent);
  for (const name of names) for (const [child,parent] of parents) if (parent === name) names.add(child);
  return [...names];
}
function valoriAutonomi(chain, selected, esistenti = new Set()) {
  const latest = new Map();
  for (const layer of chain) for (const f of layer.manifest.files) if (f.kind === 'data') latest.set(f.collection,f);
  return [...latest.values()].filter(f => (!selected || selected.includes(f.collection)) && f.valoriAutonomi?.length
    && (!f.partitionParent || (selected && !selected.includes(f.partitionParent) && !esistenti.has(f.partitionParent))))
    .flatMap(f=>f.valoriAutonomi);
}

module.exports = { catalogoPartizioni, ordinaPartizioni, ddlFiglia, selezionePartizioni, valoriAutonomi };
