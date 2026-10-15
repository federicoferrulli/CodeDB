'use strict';
const array=require('./sqlArrayMongo'), value=require('./sqlArrayValore');
const bind=(vars,expression)=>({$let:{vars,in:expression}});
const at=(v,i)=>({$arrayElemAt:[v,i]});
const nil=v=>({$eq:[{$ifNull:[v,null]},null]});
function assegna(input,indices,replacement) {
  indices=require('./sqlArrayIndici').normalizza(indices);
  const slicing=indices.some(i=>i.slice);
  if(slicing) replacement=require('./sqlArrayTesto').parse(replacement);
  const low=[],high=[];
  for(let d=0;d<6;d++) {
    const i=indices[d],lo=at('$$bounds',d),hi={$subtract:[{$add:[lo,at('$$dims',d)]},1]};
    low.push(!i?lo:i.slice?i.lower??lo:slicing?1:i.index);
    high.push(!i?hi:i.slice?i.upper??hi:i.index);
  }
  const lengths=(lo,hi)=>({$map:{input:{$range:[0,'$$rank']},as:'d',in:{$add:[{$subtract:[at(hi,'$$d'),at(lo,'$$d')]},1]}}});
  const count=dims=>({$reduce:{input:dims,initialValue:1,in:{$multiply:['$$value','$$this']}}});
  const inside=(coords,lo,dims)=>({$allElementsTrue:[{$map:{input:{$range:[0,'$$rank']},as:'d',in:{$and:[{$gte:[at(coords,'$$d'),at(lo,'$$d')]},{$lt:[at(coords,'$$d'),{$add:[at(lo,'$$d'),at(dims,'$$d')]}]}]}}}]});
  const offset=(coords,lo,dims)=>({$reduce:{input:{$range:[0,'$$rank']},initialValue:0,in:{$add:[{$multiply:['$$value',at(dims,'$$this')]},{$subtract:[at(coords,'$$this'),at(lo,'$$this')]}]}}});
  function leaf(coords) {
    return {$cond:[inside(coords,'$$lo','$$selection'),slicing?at('$$source',offset(coords,'$$lo','$$selection')):'$$replacement',
      {$cond:[inside(coords,'$$bounds','$$dims'),at('$$old',offset(coords,'$$bounds','$$dims')),null]}]};
  }
  function build(depth=0,coords=[]) {
    if(depth===6) return leaf(coords);
    return {$cond:[{$gt:['$$rank',depth]},{$map:{input:{$range:[at('$$newLow',depth),{$add:[at('$$newLow',depth),at('$$newDims',depth)]}]},as:`cell${depth}`,in:build(depth+1,[...coords,`$$cell${depth}`])}},leaf(coords)]};
  }
  const result=bind({newDims:lengths('$$newLow','$$newHigh'),selection:lengths('$$lo','$$hi')},array.richiedi({$and:[
    {$lte:[count('$$newDims'),1000000]},...(slicing?[{$gte:[{$size:'$$source'},count('$$selection')]}]:[]),
  ]},value.impacchetta(build(),'$$newLow'),'2202E','array sorgente troppo piccolo o budget di elementi superato'));
  const dimensions = expression => ({$map:{input:{$range:[0,'$$rank']},as:'d',in:expression}});
  const oldEmpty = {$or:[{$eq:['$$old',[]]},nil('$$original')]};
  const oldEnd = {$add:[at('$$bounds','$$d'),at('$$dims','$$d')]};
  const validBounds = {$allElementsTrue:[dimensions({$and:[
    {$lte:[at('$$lo','$$d'),at('$$hi','$$d')]},
    {$or:[{$lte:['$$rank',1]},oldEmpty,{$and:[
      {$gte:[at('$$lo','$$d'),at('$$bounds','$$d')]},{$lt:[at('$$hi','$$d'),oldEnd]},
    ]}]},
  ]})]};
  const extend = bind({
    newLow:dimensions({$cond:[oldEmpty,at('$$lo','$$d'),{$min:[at('$$lo','$$d'),at('$$bounds','$$d')]}]}),
    newHigh:dimensions({$cond:[oldEmpty,at('$$hi','$$d'),{$max:[at('$$hi','$$d'),{$subtract:[oldEnd,1]}]}]}),
  },result);
  const selection = bind({lo:{$slice:[low,'$$rank']},hi:{$slice:[high,'$$rank']}},
    array.richiedi({$not:[{$or:[{$in:[null,'$$lo']},{$in:[null,'$$hi']}]}]},
      array.richiedi(validBounds,extend,'2202E','limiti della slice non validi o estensione multidimensionale'),
      '22004','un indice di assegnazione non può essere NULL'));
  const rank = bind({rank:{$cond:[oldEmpty,indices.length,{$size:'$$dims'}]}},
    array.richiedi({$and:[{$lte:['$$rank',6]},slicing?{$lte:[indices.length,'$$rank']}:{$eq:[indices.length,'$$rank']}]},
      selection,'2202E','numero di indici non corrispondente alle dimensioni'));
  return bind({original:input,replacement},{$cond:[slicing?nil('$$replacement'):false,'$$original',
    bind({dims:array.dimensioni('$$original'),bounds:value.limiti('$$original'),old:array.piatta('$$original'),source:slicing?array.piatta('$$replacement'):[]},rank)]});
}
module.exports={assegna};
