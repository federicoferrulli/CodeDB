'use strict';
// Gli array SQL conservano elementi e NULL come array BSON. Gli indici
// multikey non applicano UNIQUE sull'intero valore: quel vincolo è verificato
// dal percorso transazionale delle scritture CodeDB, come le chiavi esterne.
const nil = v => ({ $eq: [{ $ifNull: [v, null] }, null] });
const nullable = (args, value) => ({ $cond: [{ $or: args.map(nil) }, null, value] });
const valore = require('./sqlArrayValore');
const richiedi = (valid, value, state, message) => ({ $cond: [valid, value,
  { $convert: { input: { $cond: [valid, '0', `Array SQL [${state}]: ${message}`] }, to: 'int' } },
] });
const monodimensionale = (a, value, state = '0A000') => richiedi({ $lte: [{ $size: dimensioni(a) }, 1] }, value, state, 'la funzione richiede un array vuoto o monodimensionale');
function dimensioni(v) {
  v = valore.dati(v);
  return { $let: { vars: { forma: { $reduce: { input: { $range: [0, 6] }, initialValue: { next: v, dims: [] }, in: {
    next: { $cond: [{ $isArray: '$$value.next' }, { $arrayElemAt: ['$$value.next', 0] }, null] },
    dims: { $cond: [{ $isArray: '$$value.next' }, { $concatArrays: ['$$value.dims', [{ $size: '$$value.next' }]] }, '$$value.dims'] },
  } } } }, in: '$$forma.dims' } };
}
function converti(v, leaf, depth = 0) {
  if (depth === 0) return { $let: { vars: { origine: v }, in: valore.impacchetta(convertiRaw(valore.dati('$$origine'), leaf), valore.limiti('$$origine')) } };
  return convertiRaw(v, leaf, depth);
}
function convertiRaw(v, leaf, depth = 0) {
  if (depth === 6) return leaf(v);
  return { $cond: [{ $isArray: v }, { $map: { input: v, as: `array${depth}`, in: convertiRaw(`$$array${depth}`, leaf, depth + 1) } }, leaf({ $cond: [{ $isArray: v }, null, v] })] };
}
function valida(v, leaf, depth = 0) {
  if (depth === 0) v = valore.dati(v);
  if (depth === 6) return leaf(v);
  const child = `$$array${depth}`;
  return { $cond: [{ $isArray: v }, { $and: [depth ? { $gt: [{ $size: v }, 0] } : true, { $allElementsTrue: [{ $map: { input: v, as: `array${depth}`, in: { $and: [
    { $eq: [dimensioni(child), dimensioni({ $arrayElemAt: [v, 0] })] }, valida(child, leaf, depth + 1),
  ] } } }] }] }, leaf(v)] };
}
function piatta(v) {
  let result = valore.dati(v);
  for (let i = 0; i < 6; i++) result = { $reduce: { input: result, initialValue: [], in: { $concatArrays: ['$$value', { $cond: [{ $isArray: '$$this' }, '$$this', ['$$this']] }] } } };
  return result;
}
function costruisci(values) {
  return { $let: { vars: { elementi: values }, in: { $let: { vars: {
    vettore: { $map: { input: '$$elementi', as: 'child', in: valore.dati('$$child') } },
    interni: valore.limiti({ $arrayElemAt: ['$$elementi', 0] }),
  }, in: richiedi({ $and: [valida('$$vettore', v => ({ $not: [{ $isArray: v }] })),
    { $allElementsTrue: [{ $map: { input: '$$elementi', as: 'child', in: { $eq: [valore.limiti('$$child'), '$$interni'] } } }] },
  ] }, valore.impacchetta('$$vettore', { $concatArrays: [[1], '$$interni'] }), '2202E', 'Dimensioni degli array SQL non corrispondenti') } } } };
}
function accesso(value, indices) {
  return require('./sqlArrayIndici').leggi(value, indices);
}
function operatore(op, a, b) {
  a = piatta(a); b = piatta(b);
  const clean = v => ({ $filter: { input: v, as: 'elemento', cond: { $ne: ['$$elemento', null] } } });
  const required = op === '@>' ? b : a;
  return nullable([a, b], op === '&&' ? { $gt: [{ $size: { $setIntersection: [clean(a), clean(b)] } }, 0] }
    : { $and: [{ $not: [{ $in: [null, required] }] }, { $setIsSubset: op === '@>' ? [b, a] : [a, b] }] });
}
function funzione(name, args) {
  return { $let: { vars: Object.fromEntries(args.map((arg, i) => [`arrayArg${i}`, arg])), in: funzioneInterna(name, args.map((_, i) => `$$arrayArg${i}`)) } };
}
function funzioneInterna(name, args) {
  const [original, b, c] = args, a = valore.dati(original), bounds = valore.limiti(original);
  const preserve = result => valore.impacchetta(result, bounds);
  if (name === 'ARRAY_FILL') return require('./sqlArrayIndici').riempi(original, b, c);
  if (name === 'ARRAY_DIMS') return nullable([original], { $cond: [{ $eq: [a, []] }, null, { $reduce: { input: { $range: [0, { $size: dimensioni(a) }] }, initialValue: '', in: { $concat: ['$$value', '[', { $toString: { $arrayElemAt: [bounds, '$$this'] } }, ':', { $toString: { $subtract: [{ $add: [{ $arrayElemAt: [bounds, '$$this'] }, { $arrayElemAt: [dimensioni(a), '$$this'] }] }, 1] } }, ']'] } } }] });
  if (name === 'CARDINALITY') return nullable([a], { $reduce: { input: dimensioni(a), initialValue: 1, in: { $multiply: ['$$value', '$$this'] } } });
  if (name === 'ARRAY_NDIMS') return nullable([a], { $cond: [{ $eq: [{ $size: a }, 0] }, null, { $size: dimensioni(a) }] });
  if (['ARRAY_LENGTH', 'ARRAY_LOWER', 'ARRAY_UPPER'].includes(name)) {
    const length = { $arrayElemAt: [dimensioni(a), { $subtract: [b, 1] }] };
    const lower = { $arrayElemAt: [bounds, { $subtract: [b, 1] }] };
    return nullable([a, b], { $cond: [{ $and: [{ $gte: [b, 1] }, { $lte: [b, { $size: dimensioni(a) }] }, { $gt: [{ $ifNull: [length, 0] }, 0] }] }, name === 'ARRAY_LOWER' ? lower : name === 'ARRAY_UPPER' ? { $subtract: [{ $add: [lower, length] }, 1] } : length, null] });
  }
  if (name === 'ARRAY_POSITION') {
    const lower = { $ifNull: [{ $arrayElemAt: [bounds, 0] }, 1] };
    const pos = { $indexOfArray: [a, b, c ? { $max: [0, { $subtract: [c, lower] }] } : 0] };
    const result = monodimensionale(a, { $let: { vars: { pos }, in: { $cond: [{ $gte: ['$$pos', 0] }, { $add: ['$$pos', lower] }, null] } } });
    return nullable([a], c ? richiedi({ $not: [nil(c)] }, result, '22004', 'la posizione iniziale non può essere NULL') : result);
  }
  if (name === 'ARRAY_REMOVE') return nullable([a], monodimensionale(a, preserve({ $filter: { input: a, as: 'elemento', cond: { $ne: ['$$elemento', b] } } })));
  if (name === 'ARRAY_REPLACE') return nullable([a], converti(original, v => ({ $cond: [{ $eq: [v, b] }, c, v] })));
  if (name === 'ARRAY_APPEND') return monodimensionale(a, preserve({ $concatArrays: [{ $ifNull: [a, []] }, [b]] }), '22000');
  if (name === 'ARRAY_PREPEND') return monodimensionale(valore.dati(b), valore.impacchetta({ $concatArrays: [[original], { $ifNull: [valore.dati(b), []] }] }, valore.limiti(b)), '22000');
  if (name === 'ARRAY_CAT') return { $cond: [{ $and: [nil(a), nil(b)] }, null, { $let: { vars: { left: { $ifNull: [a, []] }, right: { $ifNull: [valore.dati(b), []] } }, in: {
    $cond: [{ $eq: [{ $size: '$$left' }, 0] }, { $ifNull: [b, original] }, { $cond: [{ $eq: [{ $size: '$$right' }, 0] }, original, {
      $let: { vars: { ld: { $size: dimensioni('$$left') }, rd: { $size: dimensioni('$$right') }, lb: bounds, rb: valore.limiti(b) }, in:
        richiedi({ $and: [{ $lte: [{ $abs: { $subtract: ['$$ld', '$$rd'] } }, 1] }, { $eq: [
          { $cond: [{ $lt: ['$$ld', '$$rd'] }, '$$lb', { $slice: ['$$lb', 1, 6] }] },
          { $cond: [{ $gt: ['$$ld', '$$rd'] }, '$$rb', { $slice: ['$$rb', 1, 6] }] },
        ] }] }, valore.impacchetta(costruisci({ $concatArrays: [
          { $cond: [{ $lt: ['$$ld', '$$rd'] }, ['$$left'], '$$left'] }, { $cond: [{ $gt: ['$$ld', '$$rd'] }, ['$$right'], '$$right'] },
        ] }), { $cond: [{ $gte: ['$$ld', '$$rd'] }, bounds, valore.limiti(b)] }), '2202E', 'dimensioni incompatibili per la concatenazione'),
      },
    }] }],
  } } }] };
  throw new Error(`Funzione array sconosciuta: ${name}.`);
}
function chiave(v) {
  const ranges=require('./sqlMultirangeMongo');
  return { elementi:{$map:{input:piatta(v),as:'v',in:{nullo:nil('$$v'),valore:{$cond:[ranges.isRange('$$v'),ranges.chiave('$$v'),'$$v']}}}},numeroDimensioni:{$size:dimensioni(v)},dimensioni:dimensioni(v),limiti:valore.limiti(v) };
}
module.exports = { dimensioni, converti, valida, piatta, costruisci, accesso, operatore, funzione, richiedi, chiave };
