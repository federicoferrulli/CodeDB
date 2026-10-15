'use strict';
const range = require('./sqlRangeMongo');
const TYPES = Object.fromEntries(Object.keys(range.TYPES).map(t => [t.replace('RANGE', 'MULTIRANGE'), t]));
const nil = v => ({ $eq: [{ $ifNull: [v, null] }, null] });
const bind = (vars, expression) => ({ $let: { vars, in: expression } });
const object = v => ({ $cond: [{ $eq: [{ $type: v }, 'object'] }, v, {}] });
const field = (v, name) => ({ $getField: { field: name, input: object(v) } });
const tag = v => ({ $in: [field(v, '_sqlMultirange'), Object.keys(TYPES)] });
const isRange = v => ({ $or: [tag(v), { $in: [field(v, '_sqlRange'), Object.keys(range.TYPES)] }] });
const type = v => ({ $ifNull: [field(v, '_sqlRange'), { $replaceOne: { input: field(v, '_sqlMultirange'), find: 'MULTIRANGE', replacement: 'RANGE' } }] });
const empty = t => ({ _sqlRange: t, empty: true, lower: null, upper: null, lowerInc: false, upperInc: false });
const nonempty = a => ({ $filter: { input: a, as: 'r', cond: { $not: ['$$r.empty'] } } });
const list = v => ({ $cond: [tag(v), field(v, 'ranges'), nonempty([v])] });
const requireValid = (condition, value) => require('./sqlArrayMongo').richiedi(condition, value, '22000', 'operazione sugli intervalli non valida');
const lowerBefore = (a, b) => ({ $or: [nil(`${a}.lower`), { $and: [{ $not: [nil(`${b}.lower`)] }, { $or: [{ $lt: [`${a}.lower`, `${b}.lower`] }, { $and: [{ $eq: [`${a}.lower`, `${b}.lower`] }, { $gte: [`${a}.lowerInc`, `${b}.lowerInc`] }] }] }] }] });
const upperAfter = (a, b) => ({ $or: [nil(`${a}.upper`), { $and: [{ $not: [nil(`${b}.upper`)] }, { $or: [{ $gt: [`${a}.upper`, `${b}.upper`] }, { $and: [{ $eq: [`${a}.upper`, `${b}.upper`] }, { $gte: [`${a}.upperInc`, `${b}.upperInc`] }] }] }] }] });
const adjacent = (a,b) => ({ $and: [{ $not: [nil(`${a}.upper`)] }, { $eq: [`${a}.upper`, `${b}.lower`] }, { $ne: [`${a}.upperInc`, `${b}.lowerInc`] }] });
function interval(t, lo, hi, li, ui) {
  return bind({ lo,hi,li,ui }, { $cond: [{ $and: [{ $not: [nil('$$lo')] }, { $not: [nil('$$hi')] }, { $or: [{ $gt: ['$$lo','$$hi'] }, { $and: [{ $eq: ['$$lo','$$hi'] }, { $not: [{ $and: ['$$li','$$ui'] }] }] }] }] }, empty(t),
    { _sqlRange:t,empty:false,lower:'$$lo',upper:'$$hi',lowerInc:{ $and:[{ $not:[nil('$$lo')] },'$$li'] },upperInc:{ $and:[{ $not:[nil('$$hi')] },'$$ui'] } },
  ] });
}
function envelope(a,b,intersection=false) {
  return bind({ lowerLeft: lowerBefore(a,b),upperLeft:upperAfter(a,b) },
    interval(`${a}._sqlRange`, { $cond: ['$$lowerLeft',`${intersection?b:a}.lower`,`${intersection?a:b}.lower`] },
      { $cond: ['$$upperLeft',`${intersection?b:a}.upper`,`${intersection?a:b}.upper`] },
      { $cond: ['$$lowerLeft',`${intersection?b:a}.lowerInc`,`${intersection?a:b}.lowerInc`] },
      { $cond: ['$$upperLeft',`${intersection?b:a}.upperInc`,`${intersection?a:b}.upperInc`] }));
}
function normalize(t, ranges) {
  return bind({ sorted: { $sortArray: { input: nonempty(ranges), sortBy: { lower:1,lowerInc:-1 } } } }, { _sqlMultirange:t, ranges:{
    $reduce: { input:'$$sorted',initialValue:[],in:bind({ last:{ $arrayElemAt:['$$value',-1] } }, { $cond:[
      { $or:[{ $eq:['$$value',[]] },{ $not:[{ $or:[range.operatore('&&','$$last','$$this'),adjacent('$$last','$$this')] }] }] },
      { $concatArrays:['$$value',['$$this']] },
      { $concatArrays:[{ $slice:['$$value',{ $max:[0,{ $subtract:[{ $size:'$$value' },1] }] }] },[envelope('$$last','$$this')]] },
    ] }) },
  } });
}
function converti(t,value) {
  const rt = TYPES[t], pattern = '(?:empty|[\\[(][^,{}]*,[^,{}]*[\\])])';
  return bind({ input:value }, { $cond:[nil('$$input'),null,bind({ source:{ $cond:[{ $eq:[{ $type:'$$input' },'string'] },'$$input',''] } },
    { $cond:[{ $eq:[{ $type:'$$input' },'string'] },requireValid({ $regexMatch:{input:'$$source',regex:`^\\s*\\{\\s*(?:${pattern}(?:\\s*,\\s*${pattern})*)?\\s*\\}\\s*$`} },
      normalize(t,{ $map:{input:{$regexFindAll:{input:'$$source',regex:pattern}},as:'match',in:range.converti(rt,'$$match.match')} })),
      normalize(t,{ $map:{input:list('$$input'),as:'r',in:range.converti(rt,'$$r')} }),
    ] })] });
}
function proprieta(t,nullable) {
  return { bsonType:['object',...(nullable?['null']:[])],required:['_sqlMultirange','ranges'],additionalProperties:false,
    properties:{_sqlMultirange:{enum:[t]},ranges:{bsonType:'array',items:range.proprieta(TYPES[t],false)}} };
}
function algebra(op,a,b) {
  let result;
  if(op==='+') result={ $concatArrays:['$$left','$$right'] };
  if(op==='*') result={ $reduce:{input:'$$left',initialValue:[],in:bind({ l:'$$this' },{ $concatArrays:['$$value',{ $map:{input:'$$right',as:'r',in:envelope('$$l','$$r',true)} }] })} };
  if(op==='-') result={ $reduce:{input:'$$right',initialValue:'$$left',in:bind({ r:'$$this' },{ $reduce:{input:'$$value',initialValue:[],in:bind({ l:'$$this' },{ $concatArrays:['$$value',
    { $cond:[range.operatore('&&','$$l','$$r'),bind({ intersection:envelope('$$l','$$r',true) },nonempty({ $concatArrays:[
      { $cond:[nil('$$intersection.lower'),[],[interval('$$rt','$$l.lower','$$intersection.lower','$$l.lowerInc',{ $not:['$$intersection.lowerInc'] })]] },
      { $cond:[nil('$$intersection.upper'),[],[interval('$$rt','$$intersection.upper','$$l.upper',{ $not:['$$intersection.upperInc'] },'$$l.upperInc')]] },
    ] })),['$$l']] },
  ] })} })} };
  return bind({ a,b },{ $cond:[{ $or:[nil('$$a'),nil('$$b')] },null,bind({ left:list('$$a'),right:list('$$b'),rt:type('$$a') },
    requireValid({ $eq:['$$rt',type('$$b')] },bind({ normalized:normalize({ $replaceOne:{input:'$$rt',find:'RANGE',replacement:'MULTIRANGE'} },result) },
      { $cond:[{ $or:[tag('$$a'),tag('$$b')] },'$$normalized',requireValid({ $lte:[{ $size:'$$normalized.ranges' },1] },{ $ifNull:[{ $arrayElemAt:['$$normalized.ranges',0] },empty('$$rt')] })] }))) ] });
}
function operatore(op,a,b) {
  if(['+','-','*'].includes(op)) return algebra(op,a,b);
  if(op==='<@') return operatore('@>',b,a);
  if(['<<','>>','&<','&>','-|-'].includes(op)) {
    if(op==='>>')return operatore('<<',b,a);
    return bind({a,b},{$cond:[{$or:[nil('$$a'),nil('$$b')]},null,bind({left:list('$$a'),right:list('$$b')},
      {$cond:[{$or:[{$eq:['$$left',[]]},{$eq:['$$right',[]]}]},false,bind({
        firstLeft:{$arrayElemAt:['$$left',0]},lastLeft:{$arrayElemAt:['$$left',-1]},firstRight:{$arrayElemAt:['$$right',0]},lastRight:{$arrayElemAt:['$$right',-1]},
      },op==='&<'?upperAfter('$$lastRight','$$lastLeft'):op==='&>'?lowerBefore('$$firstRight','$$firstLeft'):op==='-|-'?{$or:[adjacent('$$lastLeft','$$firstRight'),adjacent('$$lastRight','$$firstLeft')]}:
        {$and:[{$not:[nil('$$lastLeft.upper')]},{$not:[nil('$$firstRight.lower')]},{$or:[{$lt:['$$lastLeft.upper','$$firstRight.lower']},{$and:[{$eq:['$$lastLeft.upper','$$firstRight.lower']},{$not:[{$and:['$$lastLeft.upperInc','$$firstRight.lowerInc']}]}]}]}]})]})]});
  }
  return bind({ a,b },{ $cond:[{ $or:[nil('$$a'),nil('$$b')] },null,bind({ left:list('$$a'),right:{ $cond:[isRange('$$b'),list('$$b'),['$$b']] } },
    op==='@>' ? { $allElementsTrue:[{ $map:{input:'$$right',as:'r',in:{ $anyElementTrue:[{ $map:{input:'$$left',as:'l',in:range.operatore('@>','$$l','$$r')} }] }} }] }
      : { $anyElementTrue:[{ $map:{input:'$$right',as:'r',in:{ $anyElementTrue:[{ $map:{input:'$$left',as:'l',in:range.operatore('&&','$$l','$$r')} }] }} }] }
  )] });
}
function funzione(name,args) {
  if(TYPES[name]) return bind({ inputs:args },{ $cond:[{ $in:[null,'$$inputs'] },null,normalize(name,{ $map:{input:'$$inputs',as:'r',in:range.converti(TYPES[name],'$$r')} })] });
  if(name==='MULTIRANGE') return bind({ input:args[0] },{ $cond:[nil('$$input'),null,normalize({ $replaceOne:{input:type('$$input'),find:'RANGE',replacement:'MULTIRANGE'} },list('$$input'))] });
  if(name==='RANGE_MERGE' && args.length===2) return bind({ a:args[0],b:args[1] },{ $cond:[{ $or:[nil('$$a'),nil('$$b')] },null,{ $cond:['$$a.empty','$$b',{ $cond:['$$b.empty','$$a',envelope('$$a','$$b')] }] }] });
  return bind({ input:args[0] },{ $cond:[nil('$$input'),null,bind({ ranges:list('$$input') },
    name==='ISEMPTY' ? { $eq:['$$ranges',[]] } : name==='RANGE_MERGE' ? { $cond:[{ $eq:['$$ranges',[]] },empty(type('$$input')),bind({ first:{ $arrayElemAt:['$$ranges',0] },last:{ $arrayElemAt:['$$ranges',-1] } },envelope('$$first','$$last'))] }
    : range.proprietaValore(name,[{ $ifNull:[{ $arrayElemAt:['$$ranges',name.startsWith('UPPER')?-1:0] },empty(type('$$input'))] }])
  )] });
}
function chiave(v) {
  return {$map:{input:list(v),as:'r',in:{lowerFinite:{$not:[nil('$$r.lower')]},lower:'$$r.lower',lowerExclusive:{$not:['$$r.lowerInc']},upperInfinite:nil('$$r.upper'),upper:'$$r.upper',upperInclusive:'$$r.upperInc'}}};
}
function aggregato(name, values) {
  return bind({ intervalli: { $filter: { input: values, as: 'v', cond: { $not: [nil('$$v')] } } } },
    { $cond: [{ $eq: ['$$intervalli', []] }, null, requireValid({ $allElementsTrue: [{ $map: { input: '$$intervalli', as: 'v', in: isRange('$$v') } }] }, bind({ primo: { $arrayElemAt: ['$$intervalli', 0] } },
      name === 'RANGE_AGG'
        ? normalize({ $replaceOne: { input: type('$$primo'), find: 'RANGE', replacement: 'MULTIRANGE' } }, {
          $reduce: { input: '$$intervalli', initialValue: [], in: requireValid({ $eq: [type('$$this'), type('$$primo')] }, { $concatArrays: ['$$value', list('$$this')] }) },
        })
        : { $reduce: { input: '$$intervalli', initialValue: '$$primo', in: algebra('*', '$$value', '$$this') } }))] });
}
module.exports={TYPES,tag,isRange,converti,proprieta,operatore,funzione,chiave,aggregato};
