'use strict';
// Gli array con base 1 restano BSON ordinari; gli altri conservano i limiti
// nello stesso valore, così copie, parametri, backup e confronti non li perdono.
const tag = value => ({ $eq: [{ $getField: { field: '_sqlArray', input: { $cond: [{ $eq: [{ $type: value }, 'object'] }, value, {}] } } }, true] });
const field = (value, name) => ({ $getField: { field: name, input: { $cond: [tag(value), value, {}] } } });
const dati = value => ({ $let: { vars: { arrayValue: value }, in: { $cond: [tag('$$arrayValue'), field('$$arrayValue', 'values'), '$$arrayValue'] } } });
const isArray = value => ({ $or: [{ $isArray: value }, tag(value)] });
function limiti(value) {
  return { $let: { vars: { arrayValue: value }, in: { $cond: [tag('$$arrayValue'), field('$$arrayValue', 'lower'), { $map: { input: require('./sqlArrayMongo').dimensioni('$$arrayValue'), as: 'dimensione', in: 1 } }] } } };
}
function impacchetta(values, lower) {
  return { $let: { vars: { contenuto: values, limiti: lower }, in: { $cond: [
    { $or: [{ $eq: [{ $ifNull: ['$$contenuto', null] }, null] }, { $eq: ['$$contenuto', []] }, { $allElementsTrue: [{ $map: { input: '$$limiti', as: 'limite', in: { $eq: ['$$limite', 1] } } }] }] },
    '$$contenuto', require('./sqlArrayMongo').richiedi({ $allElementsTrue: [{ $map: { input: { $range: [0, { $size: '$$limiti' }] }, as: 'd', in: { $and: [
      { $gte: [{ $arrayElemAt: ['$$limiti', '$$d'] }, -2147483648] },
      { $lte: [{ $add: [{ $arrayElemAt: ['$$limiti', '$$d'] }, { $arrayElemAt: [require('./sqlArrayMongo').dimensioni('$$contenuto'), '$$d'] }] }, 2147483647] },
    ] } } }] }, { _sqlArray: true, lower: '$$limiti', values: '$$contenuto' }, '54000', 'limiti dell’array fuori intervallo'),
  ] } } };
}
function parse(text) {
  let pos = 0; const lower = [], upper = [];
  const fail = () => { throw new Error('Letterale array SQL non valido.'); };
  const space = () => { while (/\s/.test(text[pos] || '') && pos < text.length) pos++; };
  space();
  while (text[pos] === '[') {
    const match = /^\[\s*([+-]?\d+)\s*:\s*([+-]?\d+)\s*\]/.exec(text.slice(pos));
    if (!match) fail(); lower.push(Number(match[1])); upper.push(Number(match[2])); pos += match[0].length; space();
  }
  if (lower.length) { if (text[pos++] !== '=') fail(); space(); }
  function array(depth = 0) {
    if (depth >= 6 || text[pos++] !== '{') fail(); space();
    const values = [];
    if (text[pos] === '}') { pos++; return values; }
    for (;;) {
      space(); let value = '', quoted = false, escaped = false;
      if (text[pos] === '{') value = array(depth + 1);
      else if (text[pos] === '"') {
        quoted = true; pos++;
        for (;;) { const c = text[pos++]; if (c === undefined) fail(); if (c === '"') break; if (c === '\\') { if (pos >= text.length) fail(); value += text[pos++]; } else value += c; }
      } else {
        let pending = '';
        while (pos < text.length && ![',', '}'].includes(text[pos])) {
          const c = text[pos++]; if (c === '"' || c === '{') fail();
          if (c === '\\') { if (pos >= text.length) fail(); escaped = true; value += pending + text[pos++]; pending = ''; }
          else if (/\s/.test(c)) pending += c;
          else { value += pending + c; pending = ''; }
        }
        if (!value) fail();
      }
      values.push(!quoted && !escaped && typeof value === 'string' && value.toUpperCase() === 'NULL' ? null : value);
      space(); if (text[pos] === '}') { pos++; return values; } if (text[pos++] !== ',') fail();
    }
  }
  const values = array(); space(); if (pos !== text.length) fail();
  function shape(v) {
    if (!Array.isArray(v)) return [];
    const child = v.length ? shape(v[0]) : [];
    if (v.some(x => JSON.stringify(shape(x)) !== JSON.stringify(child)) || child.includes(0)) fail();
    return [v.length, ...child];
  }
  const dims = shape(values);
  if (lower.some((n, i) => !Number.isInteger(n) || n < -2147483648 || upper[i] > 2147483647 || upper[i] < n || upper[i] - n + 1 !== dims[i]) || lower.length && lower.length !== dims.length) fail();
  return !values.length || lower.every(n => n === 1) ? values : { _sqlArray: true, lower, values };
}
function testo(value) {
  const content = value?._sqlArray === true ? value.values : value;
  const scalar = v => v instanceof Date ? v.toISOString() : v?._sqlMultirange ? '{'+v.ranges.map(scalar).join(',')+'}' : v?._sqlRange ? v.empty ? 'empty' : `${v.lowerInc ? '[' : '('}${v.lower == null ? '' : scalar(v.lower)},${v.upper == null ? '' : scalar(v.upper)}${v.upperInc ? ']' : ')'}` : String(v);
  const encode = v => Array.isArray(v) ? '{' + v.map(encode).join(',') + '}' : v == null ? 'NULL' : '"' + scalar(v).replace(/(["\\])/g, '\\$1') + '"';
  const dims = []; for (let v = content; Array.isArray(v); v = v[0]) dims.push(v.length);
  return (value?._sqlArray ? value.lower.map((lo, i) => `[${lo}:${lo + dims[i] - 1}]`).join('') + '=' : '') + encode(content);
}
module.exports = { tag, dati, isArray, limiti, impacchetta, parse, testo };
