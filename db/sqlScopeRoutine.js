'use strict';
const {quotaSempre}=require('./identificatori');
const quote=n=>quotaSempre(n,'mongodb');
const word=t=>String(t?.value||'').toUpperCase();
// Ogni query conserva il proprio scope. Gli alias delle proiezioni rimangono
// stabili quando ALTER rinomina la colonna fisica da cui derivano.
function analizza(tokens,schemas,variables=[]) {
  const dependencies=new Map(), ignored=new Set(variables);
  const add=origin=>{if(!dependencies.has(origin.table))dependencies.set(origin.table,new Set());dependencies.get(origin.table).add(origin.column);};
  function physical(name) {
    const schema=schemas.get(name);if(!schema)throw new Error(`La routine BEGIN ATOMIC richiede uno schema SQL per ${name}.`);
    if(!dependencies.has(name))dependencies.set(name,new Set());
    return {physical:name,columns:new Map(schema.columns.map(c=>[c.name,[{table:name,column:c.name}]]))};
  }
  function group(ts,start) {let depth=0;for(let i=start;i<ts.length;i++){if(ts[i].value==='(')depth++;if(ts[i].value===')'&&--depth===0)return i;}throw new Error('Scope SQL non bilanciato.');}
  function top(ts) {const positions=[];for(let i=0;i<ts.length;i++){positions.push(i);if(ts[i].value==='(')i=group(ts,i);}return positions;}
  function query(ts,ctes=new Map(),outer=[]) {
    while(ts[0]?.value==='('&&group(ts,0)===ts.length-1)ts=ts.slice(1,-1);
    if(word(ts[0])==='WITH') {
      ctes=new Map(ctes);let i=1;
      do {
        const name=ts[i++].value;let names;
        if(ts[i]?.value==='('){const end=group(ts,i);names=ts.slice(i+1,end).filter(t=>t.type==='ident').map(t=>t.value);i=end+1;}
        if(word(ts[i++])!=='AS'||ts[i]?.value!=='(')throw new Error('CTE della routine non valida.');
        const end=group(ts,i),source=query(ts.slice(i+1,end),ctes,outer);i=end+1;
        if(names){if(names.length!==source.columns.size)throw new Error('Colonne della CTE non corrispondenti.');source.columns=new Map([...source.columns.values()].map((v,n)=>[names[n],v]));}
        ctes.set(name,source);
      }while(ts[i]?.value===','&&++i);
      ts=ts.slice(i);
    }
    const positions=top(ts),sets=positions.filter(i=>['UNION','INTERSECT','EXCEPT'].includes(word(ts[i])));
    if(sets.length){let start=0,result;for(const end of [...sets,ts.length]){const part=query(ts.slice(start,end),ctes,outer);result||=part;start=end+1;if(['ALL','DISTINCT'].includes(word(ts[start])))start++;}return result;}
    const skip=new Set(),scope=new Map(),nested=new Map();
    let target;
    const kind=word(ts[0]);
    if(kind==='INSERT') {
      const into=positions.find(i=>word(ts[i])==='INTO');target=physical(ts[into+1].value);skip.add(into+1);
      let end=into+2;
      if(ts[end]?.value==='('){const close=group(ts,end);for(let i=end+1;i<close;i++)if(ts[i].type==='ident'){const column=ts[i].value;if(!target.columns.has(column))throw new Error(`Colonna SQL sconosciuta: ${column}.`);add({table:target.physical,column});ts[i].sqlColumn={table:target.physical,column,prefix:''};}for(let i=end;i<=close;i++)skip.add(i);end=close+1;}
      else for(const origins of target.columns.values())origins.forEach(add);
      const select=positions.find(i=>i>=end&&['SELECT','WITH'].includes(word(ts[i])));
      if(select!==undefined){const returning=positions.find(i=>i>select&&word(ts[i])==='RETURNING')??ts.length;query(ts.slice(select,returning),ctes,outer);for(let i=select;i<returning;i++)skip.add(i);}
      scope.set(target.physical,target);
    }
    for(const i of positions) {
      if(skip.has(i)||!['FROM','JOIN','USING','UPDATE'].includes(word(ts[i])))continue;
      if(word(ts[i])==='UPDATE'&&i!==0)continue;
      let start=i+1,source,end=start;
      if(ts[start]?.value==='('){end=group(ts,start);source=query(ts.slice(start+1,end),ctes,outer);nested.set(start,end);}
      else if(ts[start]?.type==='ident'){source=ctes.get(ts[start].value)||physical(ts[start].value);skip.add(start);}
      else continue;
      let next=end+1;if(word(ts[next])==='AS'){skip.add(next++);}
      const alias=ts[next]?.type==='ident'&&!['SET','VALUES','RETURNING'].includes(word(ts[next]))?ts[next].value:null;
      if(alias){skip.add(next);next++;}
      const key=alias||ts[start].value;
      if(scope.has(key))throw new Error(`Alias SQL duplicato: ${key}.`);
      scope.set(key,source);
      if(kind==='UPDATE'&&i===0)target=source;
    }
    const scopes=[scope,...outer];
    function resolve(token) {
      const dot=token.value.lastIndexOf('.'),prefix=dot<0?'':token.value.slice(0,dot),column=token.value.slice(dot+1);
      for(const local of scopes){const found=[...local].filter(([alias,s])=>(!prefix||alias===prefix)&&s.columns.has(column));
        if(found.length>1)throw new Error(`Colonna SQL ambigua nella routine: ${token.value}.`);
        if(found.length){const source=found[0][1],origins=source.columns.get(column);origins.forEach(add);if(source.physical)token.sqlColumn={table:source.physical,column,prefix};return origins;}
        if(prefix&&local.has(prefix))break;
      }
      return [];
    }
    const select=positions.find(i=>word(ts[i])==='SELECT'&&!skip.has(i));
    const from=positions.find(i=>i>select&&word(ts[i])==='FROM')??ts.length;
    const outputs=new Map(),outputAliases=new Set();
    if(select!==undefined){
      let start=select+1;if(word(ts[start])==='DISTINCT')start++;
      const breaks=positions.filter(i=>i>=start&&i<from&&ts[i].value===',');
      for(const end of [...breaks,from]){
        const part=ts.slice(start,end),local=top(part),as=local.find(i=>word(part[i])==='AS');
        const implicit=as===undefined&&part.length>1&&part.at(-1).type==='ident'&&(['ident','num','str'].includes(part.at(-2).type)||[')',']'].includes(part.at(-2).value));
        const alias=as!==undefined?part[as+1]?.value:implicit?part.at(-1).value:null;
        if(alias){const t=as!==undefined?part[as+1]:part.at(-1);skip.add(ts.indexOf(t));outputAliases.add(alias);}
        const expr=part.slice(0,as??(implicit?part.length-1:part.length));
        if(expr.length===1&&expr[0].value==='*'){
          const star=[];
          for(const [prefix,source] of scope)for(const [column,origins] of source.columns){origins.forEach(add);outputs.set(column,origins);star.push({prefix,column,table:source.physical});}
          expr[0].sqlStar=star;
        }else {
          const direct=expr.length===1&&expr[0].type==='ident',origins=direct?resolve(expr[0]):[];
          const label=alias||(direct?expr[0].value.split('.').at(-1):`expr${outputs.size+1}`);
          outputs.set(label,origins);
          if(direct&&!alias)expr[0].sqlOutputName=label;
        }
        start=end+1;
      }
    }
    let clause='';
    for(let i=0;i<ts.length;i++){
      if(skip.has(i))continue;
      if(nested.has(i)){i=nested.get(i);continue;}
      if(ts[i].value==='('&&['SELECT','WITH'].includes(word(ts[i+1]))){const end=group(ts,i);query(ts.slice(i+1,end),ctes,scopes);i=end;continue;}
      if(positions.includes(i)&&['WHERE','GROUP','HAVING','ORDER','LIMIT'].includes(word(ts[i])))clause=word(ts[i]);
      const t=ts[i];if(t.type!=='ident'||ignored.has(t.value)||ts[i+1]?.value==='('||['AS','::'].includes(word(ts[i-1])))continue;
      if(outputAliases.has(t.value)&&['ORDER','GROUP'].includes(clause))continue;
      resolve(t);
    }
    return {columns:outputs};
  }
  query(tokens);
  return [...dependencies].map(([name,columns])=>({name,columns:[...columns]}));
}
function rinomina(tokens,table,from,to) {
  let changed=false;
  for(const t of tokens){
    if(t.sqlColumn?.table===table&&t.sqlColumn.column===from){
      const prefix=t.sqlColumn.prefix;t.value=(prefix?prefix+'.':'')+to;
      if(t.sqlOutputName)t.sqlReplacement=`${quote(t.value)} AS ${quote(t.sqlOutputName)}`;
      changed=true;
    }
    if(t.sqlStar?.some(c=>c.table===table&&c.column===from)){
      t.sqlReplacement=t.sqlStar.map(c=>`${quote((c.prefix?c.prefix+'.':'')+(c.table===table&&c.column===from?to:c.column))} AS ${quote(c.column)}`).join(', ');changed=true;
    }
  }
  return changed;
}
module.exports={analizza,rinomina};
