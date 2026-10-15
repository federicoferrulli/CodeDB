'use strict';

// INTERSECT ha precedenza maggiore; a parità di precedenza si associa a sinistra.
function separa(tokens) {
  let depth = 0, split = -1, priority = Infinity, lastOperator = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value === '(') depth++;
    else if (t.value === ')') depth--;
    else if (!depth && t.type === 'kw' && ['UNION', 'INTERSECT', 'EXCEPT'].includes(t.value)) {
      const p = t.value === 'INTERSECT' ? 2 : 1;
      if (p <= priority) { split = i; priority = p; }
      lastOperator = i;
    }
  }
  if (split < 0) return null;
  let end = tokens.length;
  depth = 0;
  for (let i = lastOperator + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value === '(') depth++;
    else if (t.value === ')') depth--;
    else if (!depth && t.type === 'kw' && ['ORDER', 'LIMIT', 'OFFSET'].includes(t.value)) { end = i; break; }
  }
  const modifier = tokens[split + 1]?.value;
  return { left: tokens.slice(0, split), right: tokens.slice(split + (['ALL', 'DISTINCT'].includes(modifier) ? 2 : 1), end),
    op: tokens[split].value, all: modifier === 'ALL', tail: tokens.slice(end) };
}

function combina(left, right, op, all) {
  const { planToPipeline, rinominaPiano } = require('./SqlToMql');
  if (!left.columns || !right.columns) throw new Error(`${op} richiede colonne esplicite per l'associazione posizionale.`);
  right = rinominaPiano(right, left.columns);
  const row = Object.fromEntries(left.columns.map(n => [n, { $ifNull: [`$${n}`, null] }]));
  const wrap = side => ({ $replaceWith: { riga: row, lato: { $literal: side } } });
  const pipeline = [...planToPipeline(left), wrap(0), { $unionWith: {
    ...(right.coll ? { coll: right.coll } : {}), pipeline: [...planToPipeline(right), wrap(1)],
  } }, { $group: { _id: '$riga', sinistra: { $sum: { $cond: [{ $eq: ['$lato', 0] }, 1, 0] } },
    destra: { $sum: { $cond: [{ $eq: ['$lato', 1] }, 1, 0] } } } }];
  const count = op === 'INTERSECT' ? { $min: ['$sinistra', '$destra'] }
    : op === 'EXCEPT' ? { $max: [0, { $subtract: ['$sinistra', all ? '$destra' : { $cond: [{ $gt: ['$destra', 0] }, '$sinistra', 0] }] }] }
      : { $add: ['$sinistra', '$destra'] };
  pipeline.push({ $set: { ripetizioni: { $range: [0, all ? count : { $cond: [{ $gt: [count, 0] }, 1, 0] }] } } },
    { $unwind: '$ripetizioni' }, { $replaceWith: '$_id' });
  return { kind: 'aggregate', coll: left.coll, columns: left.columns, pipeline };
}

module.exports = { separa, combina };
