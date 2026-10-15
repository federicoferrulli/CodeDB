'use strict';
const valore = require('./sqlArrayValore');
const nil = v => ({ $eq: [{ $ifNull: [v, null] }, null] });
function leggi(input, indices) {
  const items = normalizza(indices.map(i => Object.hasOwn(i, 'slice') ? i : { slice: false, index: i }));
  const slicing = items.some(i => i.slice);
  const array = require('./sqlArrayMongo');
  let result = '$$dati';
  if (!slicing) {
    for (const [depth, item] of items.entries()) {
      const index = { $subtract: [item.index, { $arrayElemAt: ['$$limiti', depth] }] };
      result = { $let: { vars: { vettore: result, indice: index }, in: { $cond: [
        { $and: [{ $isArray: '$$vettore' }, { $gte: ['$$indice', 0] }, { $not: [nil(item.index)] }] },
        { $ifNull: [{ $arrayElemAt: ['$$vettore', '$$indice'] }, null] }, null,
      ] } } };
    }
    result = { $let: { vars: { elemento: result }, in: { $cond: [{ $isArray: '$$elemento' }, null, '$$elemento'] } } };
  } else {
    function slice(v, depth) {
      if (depth >= items.length) return v;
      const item = items[depth], lower = { $arrayElemAt: ['$$limiti', depth] };
      const upper = { $subtract: [{ $add: [lower, { $arrayElemAt: ['$$forma', depth] }] }, 1] };
      const lo = item.slice ? item.lower ?? lower : 1, hi = item.slice ? item.upper ?? upper : item.index;
      const start = { $max: [0, { $subtract: [lo, lower] }] }, end = { $min: [{ $arrayElemAt: ['$$forma', depth] }, { $add: [{ $subtract: [hi, lower] }, 1] }] };
      return { $let: { vars: { start, end }, in: { $cond: [{ $or: [{ $not: [{ $isArray: v }] }, { $lte: ['$$end', '$$start'] }] }, [],
        { $map: { input: { $slice: [v, '$$start', { $max: [1, { $subtract: ['$$end', '$$start'] }] }] }, as: `fetta${depth}`, in: slice(`$$fetta${depth}`, depth + 1) } },
      ] } } };
    }
    result = slice(result, 0);
    result = { $let: { vars: { fetta: result }, in: { $cond: [{ $in: [0, array.dimensioni('$$fetta')] }, [], '$$fetta'] } } };
  }
  const nulls = items.flatMap(i => i.slice ? [i.lower, i.upper].filter(v => v !== undefined) : [i.index]);
  return { $let: { vars: { originale: input }, in: { $let: { vars: { dati: valore.dati('$$originale'), limiti: valore.limiti('$$originale'), forma: array.dimensioni('$$originale') }, in:
    { $cond: [{ $or: [nil('$$originale'), ...nulls.map(nil)] }, null, result] },
  } } } };
}
function riempi(element, dimensions, lower) {
  const dims = valore.dati(dimensions), limits = lower === undefined ? { $map: { input: dims, as: 'd', in: 1 } } : valore.dati(lower);
  const { richiedi } = require('./sqlArrayMongo');
  const integral = (v, min, max) => ({ $and: [{ $isNumber: v }, { $eq: [v, { $trunc: v }] }, { $gte: [v, min] }, { $lte: [v, max] }] });
  const valid = { $and: [{ $isArray: '$$dims' }, { $isArray: '$$bounds' }, { $lte: [{ $size: '$$dims' }, 6] }, { $eq: [{ $size: '$$dims' }, { $size: '$$bounds' }] },
    { $allElementsTrue: [{ $map: { input: '$$dims', as: 'd', in: integral('$$d', 0, 1000000) } }] },
    { $allElementsTrue: [{ $map: { input: '$$bounds', as: 'b', in: integral('$$b', -2147483648, 2147483647) } }] },
    { $lte: [{ $reduce: { input: '$$dims', initialValue: 1, in: { $multiply: ['$$value', '$$this'] } } }, 1000000] },
  ] };
  let result = element;
  for (let depth = 5; depth >= 0; depth--) result = { $cond: [{ $gt: [{ $size: '$$dims' }, depth] }, { $map: { input: { $range: [0, { $ifNull: [{ $arrayElemAt: ['$$dims', depth] }, 0] }] }, as: `riempi${depth}`, in: result } }, result] };
  result = { $cond: [{ $or: [{ $eq: ['$$dims', []] }, { $in: [0, '$$dims'] }] }, [], valore.impacchetta(result, '$$bounds')] };
  return { $let: { vars: { dims, bounds: limits }, in: richiedi({ $and: [{ $not: [nil(dimensions)] }, ...(lower === undefined ? [] : [{ $not: [nil(lower)] }])] }, richiedi(valid, result, '2202E', 'dimensioni o limiti non validi oppure budget di elementi superato'), '22004', 'dimensioni e limiti non possono essere NULL') } };
}
function normalizza(indices) {
  const cast = value => value === undefined ? undefined : require('./sqlSchemaMongo').convertiValore({type:'INT',args:[],cast:true},value);
  return indices.map(i => i.slice ? {...i,lower:cast(i.lower),upper:cast(i.upper)} : {...i,index:cast(i.index)});
}
module.exports = { leggi, riempi, normalizza };
