'use strict';
const bind = (vars, expression) => ({ $let: { vars, in: expression } });
const join = (input, delimiter) => bind({ pezzi: input }, { $reduce: { input: { $range: [0, { $size: '$$pezzi' }] }, initialValue: '',
  in: { $concat: ['$$value', { $cond: [{ $eq: ['$$this', 0] }, '', delimiter] }, { $arrayElemAt: ['$$pezzi', '$$this'] }] },
} });
const quote = text => ({ $concat: ['"', { $replaceAll: { input: { $replaceAll: { input: text, find: '\\', replacement: '\\\\' } }, find: '"', replacement: '\\"' } }, '"'] });
function range(value) {
  const bound = field => bind({ endpoint: `${value}.${field}` }, { $cond: [{ $eq: ['$$endpoint', null] }, '',
    { $switch: { branches: [
      { case: { $eq: [`${value}._sqlRange`, 'DATERANGE'] }, then: { $dateToString: { date: '$$endpoint', format: '%Y-%m-%d', timezone: 'UTC' } } },
      { case: { $in: [`${value}._sqlRange`, ['TSRANGE','TSTZRANGE']] }, then: quote(bind({ dateText: { $dateToString: { date: '$$endpoint', format: '%Y-%m-%d %H:%M:%S.%L', timezone: 'UTC' } } },
        { $concat: [{ $rtrim: { input: { $rtrim: { input: '$$dateText', chars: '0' } }, chars: '.' } }, { $cond: [{ $eq: [`${value}._sqlRange`, 'TSTZRANGE'] }, '+00', ''] }] })) },
    ], default: { $toString: '$$endpoint' } } },
  ] });
  return { $cond: [`${value}.empty`, 'empty', { $concat: [{ $cond: [`${value}.lowerInc`, '[', '('] }, bound('lower'), ',', bound('upper'), { $cond: [`${value}.upperInc`, ']', ')'] }] }] };
}
function scalare(value) {
  const multi = require('./sqlMultirangeMongo');
  return bind({ scalarText: value }, { $switch: { branches: [
    { case: multi.tag('$$scalarText'), then: { $concat: ['{', join({ $map: { input: '$$scalarText.ranges', as: 'r', in: range('$$r') } }, ','), '}'] } },
    { case: multi.isRange('$$scalarText'), then: range('$$scalarText') },
    { case: { $eq: [{ $type: '$$scalarText' }, 'bool'] }, then: { $cond: ['$$scalarText', 'true', 'false'] } },
  ], default: { $convert: { input: '$$scalarText', to: 'string' } } } });
}
function array(value, depth = 0) {
  const scalar = bind({ leaf: value }, { $cond: [{ $eq: [{ $ifNull: ['$$leaf', null] }, null] }, 'NULL',
    bind({ text: { $cond: [{ $eq: [{ $type: '$$leaf' }, 'bool'] }, { $cond: ['$$leaf', 't', 'f'] }, scalare('$$leaf')] } },
      { $cond: [{ $or: [{ $eq: ['$$text', ''] }, { $eq: [{ $toUpper: '$$text' }, 'NULL'] }, { $regexMatch: { input: '$$text', regex: '[{},"\\\\\\s]' } }] }, quote('$$text'), '$$text'] }),
  ] });
  if (depth === 6) return scalar;
  return { $cond: [{ $isArray: value }, { $concat: ['{', join({ $map: { input: value, as: `testoArray${depth}`, in: array(`$$testoArray${depth}`, depth + 1) } }, ','), '}'] }, scalar] };
}
function converti(value) {
  const av = require('./sqlArrayValore'), arrays = require('./sqlArrayMongo');
  return bind({ textInput: value }, { $cond: [av.isArray('$$textInput'), bind({ content: av.dati('$$textInput'), lower: av.limiti('$$textInput') },
    { $concat: [{ $cond: [av.tag('$$textInput'), { $concat: [join({ $map: { input: { $range: [0, { $size: '$$lower' }] }, as: 'd', in: {
      $concat: ['[', { $toString: { $arrayElemAt: ['$$lower', '$$d'] } }, ':', { $toString: { $subtract: [{ $add: [{ $arrayElemAt: ['$$lower', '$$d'] }, { $arrayElemAt: [arrays.dimensioni('$$content'), '$$d'] }] }, 1] } }, ']'],
    } } }, ''), '='] }, ''] }, array('$$content')] }), scalare('$$textInput')] });
}
module.exports = { converti };
