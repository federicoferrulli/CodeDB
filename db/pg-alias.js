'use strict';
const aliases = {regproc:'regprocedure',regoper:'regoperator','regproc[]':'regprocedure[]','regoper[]':'regoperator[]'};
const qid = n => require('./identificatori').quotaSempre(n,'postgresql');
const kindOf = column => String(column?.ctype || column?.type || '').toLowerCase().replace(/^_(regproc|regoper)$/,'$1[]');
const ambiguous = node => node?.kind==='reg' && ['regproc','regoper'].includes(node.type);
const containsAlias = node => ambiguous(node) || (node?.child && containsAlias(node.child)) || node?.children?.some(containsAlias);
function nestedProjection(id,node,depth=0) {
  if(!containsAlias(node))return "'[]'::jsonb";
  if(ambiguous(node))return `CASE WHEN ${id} IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('kind','${node.type}','value',(${id})::oid::${aliases[node.type]}::text)) END`;
  if(node.kind==='record')return '('+node.children.map((child,i)=>nestedProjection(`(${id}).${qid(node.names[i])}`,child,depth+1)).join(' || ')+')';
  const v=`codedb_alias_${depth}`, item=`codedb_item_${depth}`;
  const fields=node.child.kind==='record'?node.child.names.map(qid).join(','):'value';
  const child=node.child.kind==='record'?v:`${v}.value`;
  return `(SELECT COALESCE(jsonb_agg(${item}.value ORDER BY ${v}.ord,${item}.ord),'[]'::jsonb) FROM unnest(${id}) WITH ORDINALITY AS ${v}(${fields},ord) CROSS JOIN LATERAL jsonb_array_elements(${nestedProjection(child,node.child,depth+1)}) WITH ORDINALITY AS ${item}(value,ord))`;
}
function attach(columns,shapes) {
  for(const c of columns)if(!aliases[kindOf(c)] && containsAlias(shapes[c.name]))c.references=shapes[c.name];
}
function projection(id, column) {
  if(column.references)return `CASE WHEN (${id})::text IS NULL THEN NULL ELSE jsonb_build_object('text',(${id})::text,'refs',${nestedProjection(id,column.references)}) END`;
  const alias=aliases[kindOf(column)];
  if(alias?.endsWith('[]')) return `CASE WHEN ${id} IS NULL THEN NULL ELSE jsonb_build_object('dims',array_dims(${id}),'values',(SELECT jsonb_agg(v::oid::${alias.slice(0,-2)}::text ORDER BY ord) FROM unnest(${id}) WITH ORDINALITY AS codedb_ref(v,ord))) END`;
  return alias ? `${id}::oid::${alias}::text` : null;
}
function encode(row, columns) {
  const out={...row};
  for(const c of columns || []) if(c.references && out[c.name]!=null && !out[c.name].$pgReference) {
    const data=out[c.name], refs=[];let index=0;
    const prefix='codedb_ref_'+require('crypto').randomBytes(16).toString('hex')+'_';
    const value=require('./pg-references').transform(data.text,c.references,v=>v,(v,node)=>{
      if(!ambiguous(node))return v;
      const ref=data.refs[index];if(!ref || ref.kind!==node.type)throw new Error('Riferimenti PostgreSQL annidati incoerenti.');
      const marker=prefix+index++;refs.push({...ref,marker});return marker;
    });
    if(index!==data.refs.length)throw new Error('Riferimenti PostgreSQL annidati incompleti.');
    out[c.name]={$pgReference:{kind:'nested',value,refs,cast:c.references.pgCast}};
  }
  for(const c of columns || []) if(aliases[kindOf(c)] && out[c.name]!=null && !out[c.name].$pgReference) out[c.name]={$pgReference:{kind:kindOf(c),value:kindOf(c).endsWith('[]')?arrayText(out[c.name]):String(out[c.name])}};
  return out;
}
function arrayText({dims,values}) {
  if(!dims)return '{}';
  const sizes=[...dims.matchAll(/\[(-?\d+):(-?\d+)\]/g)].map(m=>Number(m[2])-Number(m[1])+1);let offset=0;
  const quote=v=>v==null?'NULL':'"'+v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
  const level=n=>'{'+Array.from({length:sizes[n]},()=>n+1<sizes.length?level(n+1):quote(values[offset++])).join(',')+'}';
  const text=level(0);if(offset!==values.length)throw new Error('Dimensioni del riferimento array PostgreSQL incoerenti.');
  return dims+'='+text;
}
function validate(value) {
  const ref=value?.$pgReference;
  if(!ref || (!aliases[ref.kind] && ref.kind!=='nested') || typeof ref.value!=='string') throw new Error('Riferimento PostgreSQL non valido.');
  if(ref.kind==='nested' && (!Array.isArray(ref.refs)||ref.refs.some(r=>!['regproc','regoper'].includes(r.kind)||typeof r.value!=='string'||!/^codedb_ref_[a-f0-9]{32}_\d+$/.test(r.marker))||new Set(ref.refs.map(r=>r.marker)).size!==ref.refs.length))throw new Error('Riferimenti PostgreSQL annidati non validi.');
  return ref;
}
async function resolveNested(q,rows,shapes) {
  const values={regproc:new Set(),regoper:new Set()}, pending=[];
  for(const row of rows)for(const [col,shape]of Object.entries(shapes))if(row[col]?.$pgReference?.kind==='nested'){
    const ref=validate(row[col]),seen=new Set();
    const lookup=new Map(ref.refs.map(r=>[r.marker,r]));
    require('./pg-references').transform(ref.value,shape,v=>v,(v,node)=>{if(ambiguous(node)){const r=lookup.get(v);if(!r||r.kind!==node.type)throw new Error('Riferimento annidato incompatibile con la colonna.');seen.add(v);values[r.kind].add(r.value);}return v;});
    if(seen.size!==ref.refs.length)throw new Error('Riferimenti annidati estranei alla colonna.');
    pending.push({row,col,shape,ref,lookup});
  }
  const resolved={};
  for(const kind of Object.keys(values))if(values[kind].size)resolved[kind]=new Map((await q(`SELECT v, v::pg_catalog.${aliases[kind]}::oid::text AS oid FROM unnest($1::text[]) AS v`,[[...values[kind]]])).rows.map(r=>[r.v,r.oid]));
  for(const {row,col,shape,ref,lookup}of pending)row[col]=require('./pg-references').transform(ref.value,shape,v=>v,(v,node)=>{if(!ambiguous(node))return v;const r=lookup.get(v);return resolved[r.kind].get(r.value);});
}
function sqlNested(value,literal) {
  const ref=validate(value);
  if(!/^"(?:[^"]|"")+"\."(?:[^"]|"")+"$/.test(ref.cast))throw new Error('Tipo PostgreSQL composto non valido.');
  let format=ref.value.replace(/%/g,'%%');
  for(let i=0;i<ref.refs.length;i++)format=format.replaceAll(ref.refs[i].marker,`%${i+1}$s`);
  return `pg_catalog.format(${[literal(format),...ref.refs.map(r=>`${literal(r.value)}::pg_catalog.${aliases[r.kind]}::oid`)].join(',')})::${ref.cast}`;
}
function parseNested(format,args,cast) {
  const prefix='codedb_ref_'+require('crypto').randomBytes(16).toString('hex')+'_';
  const refs=args.map((r,i)=>({...r,marker:prefix+i}));
  const value=format.replace(/%%|%(\d+)\$s/g,(m,n)=>{if(m==='%%')return '%';if(!refs[Number(n)-1])throw new Error('Riferimento SQL composto assente.');return refs[Number(n)-1].marker;});
  return {$pgReference:{kind:'nested',value,refs,cast}};
}
function binding(value) {
  const ref=validate(value);
  return {sql:`$1::pg_catalog.${aliases[ref.kind]}::oid${ref.kind.endsWith('[]')?'[]':''}::pg_catalog.${ref.kind}`,param:ref.value};
}

// I marker sono un dettaglio di trasporto casuale. Il confronto delle identità
// usa invece marker ordinali, soltanto quando i metadati della colonna provano
// che si tratta davvero di un riferimento PostgreSQL composto.
function identitaStabile(value, shape) {
  if (!shape || value?.$pgReference?.kind !== 'nested') return value;
  const ref = validate(value), lookup = new Map(ref.refs.map(item => [item.marker, item]));
  const refs = [], seen = new Set();
  const text = require('./pg-references').transform(ref.value, shape, item => item, (item, node) => {
    if (!ambiguous(node)) return item;
    const original = lookup.get(item);
    if (!original || original.kind !== node.type) throw new Error('Identità PostgreSQL: riferimento composto incoerente.');
    seen.add(item);
    const marker = `codedb_ref_${'0'.repeat(32)}_${refs.length}`;
    refs.push({ kind: original.kind, value: original.value, marker });
    return marker;
  });
  if (seen.size !== ref.refs.length) throw new Error('Identità PostgreSQL: riferimenti estranei alla colonna.');
  return { $pgReference: { ...ref, value: text, refs } };
}

module.exports={projection,encode,validate,binding,attach,resolveNested,sqlNested,parseNested,identitaStabile};
