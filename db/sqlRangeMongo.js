'use strict';
const TYPES = { INT4RANGE: 'int', INT8RANGE: 'long', NUMRANGE: 'decimal', DATERANGE: 'date', TSRANGE: 'date', TSTZRANGE: 'date' };
const nil = v => ({ $eq: [{ $ifNull: [v, null] }, null] });
const nullable = (args, value) => ({ $cond: [{ $or: args.map(nil) }, null, value] });
const invalid = value => ({ $convert: { input: { $concat: ['Intervallo SQL non valido: ', { $ifNull: [{ $toString: value }, 'NULL'] }] }, to: 'int' } });
function costruisci(type, lower, upper, bounds = { $literal: '[)' }, empty = false) {
  const target = TYPES[type];
  const endpoint = v => type === 'DATERANGE' ? { $dateTrunc: { date: { $convert: { input: v, to: target } }, unit: 'day', timezone: 'UTC' } } : { $convert: { input: v, to: target } };
  const discrete = ['INT4RANGE', 'INT8RANGE', 'DATERANGE'].includes(type);
  const next = v => type === 'DATERANGE' ? { $dateAdd: { startDate: v, unit: 'day', amount: 1 } } : { $convert: { input: { $add: [v, 1] }, to: target } };
  const emptyRange = { _sqlRange: type, empty: true, lower: null, upper: null, lowerInc: false, upperInc: false };
  return { $let: { vars: { lo: endpoint(lower), hi: endpoint(upper), bounds, empty }, in: {
    $cond: [{ $and: [{ $in: ['$$bounds', ['[)', '[]', '(]', '()']] }, { $or: [nil('$$lo'), nil('$$hi'), { $lte: ['$$lo', '$$hi'] }] }] }, {
      $let: { vars: { li: { $eq: [{ $substrBytes: ['$$bounds', 0, 1] }, '['] }, ui: { $eq: [{ $substrBytes: ['$$bounds', 1, 1] }, ']'] } }, in: {
        $cond: [{ $or: ['$$empty', { $and: [{ $not: [nil('$$lo')] }, { $eq: ['$$lo', '$$hi'] }, { $not: [{ $and: ['$$li', '$$ui'] }] }] }] }, { $literal: emptyRange }, {
          $let: { vars: {
            lower: discrete ? { $cond: [{ $or: ['$$li', nil('$$lo')] }, '$$lo', next('$$lo')] } : '$$lo',
            upper: discrete ? { $cond: [{ $and: ['$$ui', { $not: [nil('$$hi')] }] }, next('$$hi'), '$$hi'] } : '$$hi',
          }, in: { $cond: [{ $and: [{ $not: [nil('$$lower')] }, { $eq: ['$$lower', '$$upper'] }, discrete] }, { $literal: emptyRange },
            { _sqlRange: type, empty: false, lower: '$$lower', upper: '$$upper', lowerInc: { $and: [{ $not: [nil('$$lower')] }, discrete ? true : '$$li'] }, upperInc: discrete ? false : { $and: [{ $not: [nil('$$upper')] }, '$$ui'] } },
          ] } } },
        ] },
      } },
    invalid('$$bounds')] },
  } };
}
function converti(type, value) {
  const source = { $cond: [{ $eq: [{ $type: value }, 'string'] }, value, 'valore non testuale'] };
  const clean = v => ({ $let: { vars: { value: { $trim: { input: v, chars: ' "' } } }, in: { $cond: [{ $eq: ['$$value', ''] }, null, '$$value'] } } });
  return nullable([value], { $let: { vars: { range: value, source }, in: { $cond: [{ $eq: [{ $type: '$$range' }, 'object'] },
    costruisci(type, '$$range.lower', '$$range.upper', { $concat: [{ $cond: ['$$range.lowerInc', '[', '('] }, { $cond: ['$$range.upperInc', ']', ')'] }] }, '$$range.empty'),
    { $let: { vars: { pieces: { $split: [{ $substrBytes: ['$$source', 1, { $max: [0, { $subtract: [{ $strLenBytes: '$$source' }, 2] }] }] }, ','] } }, in: { $cond: [
      { $eq: ['$$source', 'empty'] }, { $literal: { _sqlRange: type, empty: true, lower: null, upper: null, lowerInc: false, upperInc: false } },
      { $cond: [{ $eq: [{ $size: '$$pieces' }, 2] }, costruisci(type, clean({ $arrayElemAt: ['$$pieces', 0] }), clean({ $arrayElemAt: ['$$pieces', 1] }), { $concat: [
        { $substrBytes: ['$$source', 0, 1] }, { $substrBytes: ['$$source', { $subtract: [{ $strLenBytes: '$$source' }, 1] }, 1] },
      ] }), invalid('$$source')] },
    ] } } },
  ] } } });
}
function proprieta(type, nullableColumn) {
  return { bsonType: ['object', ...(nullableColumn ? ['null'] : [])], required: ['_sqlRange', 'empty', 'lower', 'upper', 'lowerInc', 'upperInc'], additionalProperties: false,
    properties: { _sqlRange: { enum: [type] }, empty: { bsonType: 'bool' }, lowerInc: { bsonType: 'bool' }, upperInc: { bsonType: 'bool' },
      lower: { bsonType: [TYPES[type] === 'date' ? 'date' : 'int', ...(TYPES[type] === 'date' ? [] : ['long', 'double', 'decimal']), 'null'] },
      upper: { bsonType: [TYPES[type] === 'date' ? 'date' : 'int', ...(TYPES[type] === 'date' ? [] : ['long', 'double', 'decimal']), 'null'] } } };
}
function operatore(op, a, b) {
  const lo = (x, y) => ({ $or: [nil(`${x}.lower`), { $and: [{ $not: [nil(`${y}.lower`)] }, { $or: [{ $lt: [`${x}.lower`, `${y}.lower`] }, { $and: [{ $eq: [`${x}.lower`, `${y}.lower`] }, { $or: [`${x}.lowerInc`, { $not: [`${y}.lowerInc`] }] }] }] }] }] });
  const hi = (x, y) => ({ $or: [nil(`${x}.upper`), { $and: [{ $not: [nil(`${y}.upper`)] }, { $or: [{ $gt: [`${x}.upper`, `${y}.upper`] }, { $and: [{ $eq: [`${x}.upper`, `${y}.upper`] }, { $or: [`${x}.upperInc`, { $not: [`${y}.upperInc`] }] }] }] }] }] });
  const before = (x, y) => ({ $and: [{ $not: [nil(`${x}.upper`)] }, { $not: [nil(`${y}.lower`)] }, { $or: [{ $lt: [`${x}.upper`, `${y}.lower`] }, { $and: [{ $eq: [`${x}.upper`, `${y}.lower`] }, { $not: [{ $and: [`${x}.upperInc`, `${y}.lowerInc`] }] }] }] }] });
  const contains = { $cond: [{ $eq: [{ $type: '$$b' }, 'object'] }, { $or: ['$$b.empty', { $and: [{ $not: ['$$a.empty'] }, lo('$$a', '$$b'), hi('$$a', '$$b')] }] },
    { $and: [{ $not: ['$$a.empty'] }, { $or: [nil('$$a.lower'), { $gt: ['$$b', '$$a.lower'] }, { $and: ['$$a.lowerInc', { $eq: ['$$b', '$$a.lower'] }] }] },
      { $or: [nil('$$a.upper'), { $lt: ['$$b', '$$a.upper'] }, { $and: ['$$a.upperInc', { $eq: ['$$b', '$$a.upper'] }] }] }] },
  ] };
  return nullable([a, b], { $let: { vars: { a: op === '<@' ? b : a, b: op === '<@' ? a : b }, in: op === '&&'
    ? { $and: [{ $not: ['$$a.empty'] }, { $not: ['$$b.empty'] }, { $not: [before('$$a', '$$b')] }, { $not: [before('$$b', '$$a')] }] } : contains } });
}
function funzione(name, args) {
  if (TYPES[name]) return args.length === 1 ? converti(name, args[0]) : costruisci(name, ...args);
  const multi = require('./sqlMultirangeMongo');
  return { $let: { vars: { rangeInput: args[0] }, in: { $cond: [multi.tag('$$rangeInput'), multi.funzione(name,['$$rangeInput']), proprietaValore(name,['$$rangeInput'])] } } };
}
function proprietaValore(name, args) {
  const field = { LOWER: 'lower', UPPER: 'upper', LOWER_INC: 'lowerInc', UPPER_INC: 'upperInc', ISEMPTY: 'empty' }[name];
  if (field) return nullable(args, { $getField: { field, input: args[0] } });
  const value = name === 'LOWER_INF' ? 'lower' : 'upper';
  return nullable(args, { $let: { vars: { range: args[0] }, in: { $and: [{ $not: ['$$range.empty'] }, nil(`$$range.${value}`)] } } });
}
module.exports = { TYPES, costruisci, converti, proprieta, operatore, funzione, proprietaValore };
