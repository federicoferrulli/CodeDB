'use strict';

const { quotaSempre } = require('./identificatori');
const qid = n => quotaSempre(n, 'postgresql');

async function columnReferences(q, schema, table) {
  const types = (await q(`SELECT t.oid, t.typtype, t.typelem, t.typbasetype, t.typrelid, t.typname, n.nspname
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace`)).rows;
  const byId = new Map(types.map(t => [Number(t.oid), t]));
  const memo = new Map();
  async function shape(oid, seen = new Set()) {
    oid = Number(oid);
    if (memo.has(oid)) return memo.get(oid);
    if (seen.has(oid)) throw new Error('Tipo PostgreSQL ricorsivo non descrivibile.');
    const t = byId.get(oid); if (!t) return null;
    let node = null;
    const next = new Set([...seen, oid]);
    if (t.nspname === 'pg_catalog' && t.typname === 'oid') node = { kind: 'oid' };
    else if (t.nspname === 'pg_catalog' && /^reg(class|type|proc|procedure|oper|operator|namespace|role|config|dictionary|collation)$/.test(t.typname)) node = { kind: 'reg', type:t.typname };
    else if (t.typtype === 'd') node = await shape(t.typbasetype, next);
    else if (t.typelem) { const child = await shape(t.typelem, next); if (child) node = { kind: 'array', child }; }
    else if (t.typtype === 'c') {
      const attrs = (await q('SELECT attname, atttypid FROM pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped ORDER BY attnum', [t.typrelid])).rows;
      const children = []; for (const a of attrs) children.push(await shape(a.atttypid, next));
      if (children.some(Boolean)) node = { kind: 'record', children, names:attrs.map(a=>a.attname) };
    }
    memo.set(oid, node); return node;
  }
  const cols = (await q(`SELECT a.attname, a.atttypid FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum`, [schema, table])).rows;
  const result = {};
  for (const c of cols) { const s = await shape(c.atttypid); if (s) {const t=byId.get(Number(c.atttypid));result[c.attname] = {...s,pgCast:qid(t.nspname)+'.'+qid(t.typname)};} }
  return result;
}

function parts(text) {
  const out = []; let start = 0, depth = 0, quoted = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (c==='\\') { i++; continue; }
    if(c==='"') { if(quoted && text[i+1]==='"'){i++;continue;} quoted=!quoted; }
    if(quoted) continue;
    if(c==='{')depth++; if(c==='}')depth--;
    if(c===',' && !depth){out.push(text.slice(start,i));start=i+1;}
  }
  if(quoted || depth)throw new Error('Riferimento PostgreSQL composto non valido.');
  out.push(text.slice(start)); return out;
}
function unquote(s) { return s[0]==='"'?s.slice(1,-1).replace(/\\([\s\S])|""/g, (_m,c)=>c??'"'):s.replace(/\\([\s\S])/g,'$1'); }
function quote(s) { return '"'+s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'; }

function transform(value, node, oid, reg = v=>v) {
  if(value == null || !node)return value;
  if(value?.$pgReference) return {$pgReference:{...value.$pgReference,value:transform(value.$pgReference.value,node,oid,reg),...(value.$pgReference.refs?{refs:value.$pgReference.refs.map(r=>({...r,value:reg(r.value,{kind:'reg',type:r.kind})}))}:{})}};
  const text=String(value);
  if(node.kind==='oid') return oid(text);
  if(node.kind==='reg') return reg(text,node);
  const start=node.kind==='array'?text.indexOf('{'):0;
  const open=node.kind==='array'?'{':'(', close=node.kind==='array'?'}':')';
  if(start<0 || text[start]!==open || !text.endsWith(close))throw new Error('Valore PostgreSQL composto non valido.');
  const body=text.slice(start+1,-1); if(!body)return text;
  const values=parts(body);
  if(node.kind==='record' && values.length!==node.children.length)throw new Error('Numero campi del tipo composito incoerente.');
  let changed=false;
  const updated=values.map((raw,i)=>{
    if(raw==='' || (node.kind==='array' && raw==='NULL'))return raw;
    if(node.kind==='array' && raw[0]==='{') { const next=transform(raw,node,oid,reg);changed ||=next!==raw;return next; }
    const v=unquote(raw), next=transform(v,node.kind==='array'?node.child:node.children[i],oid,reg);
    if(next===v)return raw;
    changed=true;return quote(String(next));
  });
  return changed?text.slice(0,start+1)+updated.join(',')+close:text;
}

function rowReferences(row, shapes, visit, reg) {
  const out={...row};
  for(const [col,shape] of Object.entries(shapes||{}))out[col]=transform(row[col],shape,visit,reg);
  return out;
}

async function* streamLargeObjects(q, ids) {
  if(!ids.size)return;
  const existing=(await q('SELECT oid::text AS oid FROM pg_largeobject_metadata WHERE oid=ANY($1::oid[]) ORDER BY oid',[[...ids]])).rows;
  for(const {oid} of existing){
    const fd=(await q('SELECT lo_open($1::oid, 262144) AS fd',[oid])).rows[0].fd;
    let size;
    try { size=Number((await q('SELECT lo_lseek64($1,0,2)::text AS size',[fd])).rows[0].size); }
    finally { await q('SELECT lo_close($1)',[fd]); }
    if(!Number.isSafeInteger(size)||size<0)throw new Error('Dimensione Large Object non valida.');
    yield {oid,size,chunks:(async function*(){
      for(let offset=0;offset<size;offset+=1024*1024){
        const data=(await q('SELECT lo_get($1::oid,$2::bigint,$3::integer) AS data',[oid,String(offset),Math.min(1024*1024,size-offset)])).rows[0].data;
        if(data.length!==Math.min(1024*1024,size-offset))throw new Error('Large Object troncato durante la lettura.');
        yield data;
      }
    })()};
  }
}

function validateLargeObjects(objects) {
  if(objects==null)return;
  if(!Array.isArray(objects))throw new Error('Large Objects non validi.');
  const seen=new Set();
  for(const o of objects){
    if(!o || typeof o.oid !== 'string' || !/^[1-9]\d*$/.test(o.oid) || BigInt(o.oid)>0xffffffffn || seen.has(o.oid) || !Number.isSafeInteger(o.size) || o.size<0 || !Array.isArray(o.chunks))throw new Error('Metadati Large Object non validi.');
    seen.add(o.oid);let size=0;
    for(const c of o.chunks){if(typeof c!=='string'||Buffer.from(c,'base64').toString('base64')!==c)throw new Error('Contenuto Large Object non valido.');size+=Buffer.byteLength(c,'base64');}
    if(size!==o.size)throw new Error('Dimensione Large Object incoerente.');
  }
}

async function importLargeObjects(pool, objects, previous = new Map()) {
  validateLargeObjects(objects);
  return writeLargeObjects(pool, objects, previous);
}

async function importLargeObjectFiles(pool, files, previous = new Map()) {
  return writeLargeObjects(pool, files.map(f=>({...f,chunks:(async function*(){yield*require('fs').createReadStream(f.path,{highWaterMark:1024*1024});})()})),previous);
}

async function writeLargeObjects(pool, objects, previous) {
  const map=new Map(previous);if(!objects?.length)return map;
  const conn=await pool.connect();
  try {
    await conn.query('BEGIN');
    for(const o of objects){
      const id=map.get(o.oid)||String((await conn.query('SELECT lo_create(0) AS oid')).rows[0].oid);map.set(o.oid,id);
      if (previous.has(o.oid)) {
        const fd=(await conn.query('SELECT lo_open($1::oid,131072) AS fd',[id])).rows[0].fd;
        await conn.query('SELECT lo_truncate64($1,0)',[fd]);await conn.query('SELECT lo_close($1)',[fd]);
      }
      let offset=0;
      const hash=o.sha256?require('crypto').createHash('sha256'):null;
      for await(const chunk of o.chunks){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,'base64');await conn.query('SELECT lo_put($1::oid,$2::bigint,$3::bytea)',[id,String(offset),data]);offset+=data.length;hash?.update(data);}
      if (offset !== o.size || (hash && hash.digest('hex') !== o.sha256)) throw new Error('Large Object incompleto o modificato durante il ripristino.');
    }
    await conn.query('COMMIT');return map;
  }catch(e){await conn.query('ROLLBACK');throw e;}finally{conn.release();}
}

module.exports={columnReferences,rowReferences,transform,streamLargeObjects,importLargeObjects,importLargeObjectFiles,validateLargeObjects};
