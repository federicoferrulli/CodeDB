'use strict';
// Parser espresso con operatori MongoDB: funziona anche su colonne, DEFAULT,
// parametri e risultati di espressioni, senza JavaScript eseguito sul server.
const bind = (vars, expression) => ({ $let: { vars, in: expression } });
const valid = (condition, value) => require('./sqlArrayMongo').richiedi(condition, value, '22P02', 'letterale array non valido');
const at = (value, index) => ({ $arrayElemAt: [value, index] });
const size = value => ({ $size: value });
const slice = (value, count) => ({ $slice: [value, { $max: [0, count] }] });
const spaces = value => ({ $regexMatch: { input: value, regex: '^\\s$' } });

function scalare(token) {
  return bind({ quoted: { $eq: [{ $substrCP: [token, 0, 1] }, '"'] } }, bind({ text: {
    $cond: ['$$quoted', { $substrCP: [token, 1, { $subtract: [{ $strLenCP: token }, 2] }] }, token],
  } }, bind({ decoded: { $reduce: {
    input: { $range: [0, { $strLenCP: '$$text' }] }, initialValue: { text: '', pending: '', escaped: false, usedEscape: false },
    in: bind({ c: { $substrCP: ['$$text', '$$this', 1] } }, {
      $cond: ['$$value.escaped', { text: { $concat: ['$$value.text', '$$value.pending', '$$c'] }, pending: '', escaped: false, usedEscape: true },
        { $cond: [{ $eq: ['$$c', '\\'] }, { $mergeObjects: ['$$value', { escaped: true }] },
          { $cond: [{ $and: [{ $not: ['$$quoted'] }, spaces('$$c')] },
            { $mergeObjects: ['$$value', { pending: { $cond: [{ $eq: ['$$value.text', ''] }, '', { $concat: ['$$value.pending', '$$c'] }] } }] },
            { text: { $concat: ['$$value.text', '$$value.pending', '$$c'] }, pending: '', escaped: false, usedEscape: '$$value.usedEscape' },
          ] },
        ] },
      ],
    }),
  } } }, valid({ $and: [{ $not: ['$$decoded.escaped'] }, { $or: ['$$quoted', { $ne: ['$$decoded.text', ''] }] }] },
    { $cond: [{ $and: [{ $not: ['$$quoted'] }, { $not: ['$$decoded.usedEscape'] }, { $eq: [{ $toUpper: '$$decoded.text' }, 'NULL'] }] }, null, '$$decoded.text'] }))));
}
function parse(value) {
  const boundsPattern = '\\[\\s*([+-]?\\d+)\\s*:\\s*([+-]?\\d+)\\s*\\]';
  const tokenPattern = '"(?:[^"\\\\]|\\\\[\\s\\S])*"|(?:\\\\[\\s\\S]|[^{},"\\\\])+|[{},]';
  const root = { stack: [], expect: 'value', done: false, result: null };
  const push = item => ({ $concatArrays: [slice('$$value.stack', { $subtract: [size('$$value.stack'), 1] }), [{ $concatArrays: [at('$$value.stack', -1), [item]] }]] });
  const step = bind({ token: '$$this.match', depth: size('$$value.stack') }, valid({ $not: ['$$value.done'] }, {
    $switch: { branches: [
      { case: { $eq: ['$$token', '{'] }, then: valid({ $and: [{ $in: ['$$value.expect', ['value', 'empty']] }, { $lt: ['$$depth', 6] }] },
        { stack: { $concatArrays: ['$$value.stack', [[]]] }, expect: 'empty', done: false, result: null }) },
      { case: { $eq: ['$$token', ','] }, then: valid({ $and: [{ $gt: ['$$depth', 0] }, { $eq: ['$$value.expect', 'comma'] }] },
        { $mergeObjects: ['$$value', { expect: 'value' }] }) },
      { case: { $eq: ['$$token', '}'] }, then: valid({ $and: [{ $gt: ['$$depth', 0] }, { $in: ['$$value.expect', ['empty', 'comma']] }] },
        bind({ last: at('$$value.stack', -1), rest: slice('$$value.stack', { $subtract: ['$$depth', 1] }) }, {
          stack: { $cond: [{ $eq: ['$$depth', 1] }, [], { $concatArrays: [slice('$$rest', { $subtract: ['$$depth', 2] }), [{ $concatArrays: [at('$$rest', -1), ['$$last']] }]] }] },
          expect: 'comma', done: { $eq: ['$$depth', 1] }, result: '$$last',
        })) },
    ], default: valid({ $and: [{ $gt: ['$$depth', 0] }, { $in: ['$$value.expect', ['value', 'empty']] }] },
      { stack: push(scalare('$$token')), expect: 'comma', done: false, result: null }) },
  }));
  const boundsValid = { $or: [{ $eq: ['$$bounds', []] }, { $and: [
    { $eq: [size('$$bounds'), size('$$dims')] },
    { $allElementsTrue: [{ $map: { input: { $range: [0, size('$$bounds')] }, as: 'd', in: bind({
      upper: { $convert: { input: at({ $getField: { field: 'captures', input: at('$$bounds', '$$d') } }, 1), to: 'int' } },
    }, { $and: [{ $gte: ['$$upper', at('$$lower', '$$d')] },
      { $eq: [{ $add: [{ $subtract: ['$$upper', at('$$lower', '$$d')] }, 1] }, at('$$dims', '$$d')] },
    ] }) } }] },
  ] }] };
  let result = valid({ $and: ['$$parsed.done', boundsValid,
    require('./sqlArrayMongo').valida('$$parsed.result', v => ({ $not: [{ $isArray: v }] })),
  ] }, require('./sqlArrayValore').impacchetta('$$parsed.result', {
    $cond: [{ $eq: ['$$bounds', []] }, { $map: { input: '$$dims', as: 'd', in: 1 } }, '$$lower'],
  }));
  result = bind({ dims: require('./sqlArrayMongo').dimensioni('$$parsed.result'), lower: {
    $map: { input: '$$bounds', as: 'b', in: { $convert: { input: at('$$b.captures', 0), to: 'int' } } },
  } }, result);
  result = bind({ parsed: { $reduce: { input: {
    $filter: { input: '$$tokens', as: 't', cond: { $ne: [{ $trim: { input: '$$t.match' } }, ''] } },
  }, initialValue: root, in: step } } }, result);
  result = valid({ $eq: [{ $reduce: { input: '$$tokens', initialValue: '', in: { $concat: ['$$value', '$$this.match'] } } }, '$$body'] }, result);
  result = bind({ tokens: { $regexFindAll: { input: '$$body', regex: tokenPattern } }, bounds: { $regexFindAll: { input: '$$prefixText', regex: boundsPattern } } }, result);
  result = bind({ body: { $trim: { input: { $substrCP: ['$$inputArrayText', { $strLenCP: '$$prefixText' }, { $strLenCP: '$$inputArrayText' }] } } } }, result);
  result = bind({ prefixText: { $ifNull: ['$$prefix.match', ''] } }, result);
  result = bind({ prefix: { $regexFind: { input: '$$inputArrayText', regex: `^\\s*((?:${boundsPattern}\\s*)+)=` } } }, result);
  return bind({ inputArrayText: value }, { $cond: [{ $ne: [{ $type: '$$inputArrayText' }, 'string'] }, '$$inputArrayText', result] });
}
module.exports = { parse };
