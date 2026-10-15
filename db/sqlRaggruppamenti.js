'use strict';
const { emettiEspressione } = require('./sqlEspressioni');

const colonna = nome => ({ tipo: 'colonna', nome });
const nonNull = x => ({ $ne: [{ $ifNull: [x, null] }, null] });
function haAggregato(e) {
  return !!e && typeof e === 'object' && (e.tipo === 'aggregato' || Object.values(e).some(v => Array.isArray(v) ? v.some(haAggregato) : haAggregato(v)));
}

function raggruppa({ select, groupBy, having, orderBy, resolve, nomeColonna }) {
  const ast = it => it.kind === 'col' ? colonna(it.name) : it.kind === 'agg'
    ? it.aggregate || { tipo: 'aggregato', func: it.func, arg: it.arg === '*' ? { tipo: 'stella' } : colonna(it.arg) } : it.expr;
  const expressions = select.map(ast);
  if (!groupBy.length && !expressions.some(haAggregato) && !haAggregato(having) && !orderBy.some(o => haAggregato(o.expr))) return null;
  if (select.some(it => it.kind === 'star')) throw new Error('SELECT * non è compatibile con GROUP BY / funzioni aggregate: elenca le colonne o gli aggregati.');
  const aliases = new Map(select.map((it, i) => [nomeColonna(it, i), expressions[i]]));
  const key = e => JSON.stringify(e, (k, v) => k === 'indice' ? undefined : v);
  const canonical = e => {
    if (!e || typeof e !== 'object') return e;
    if (e.tipo === 'colonna') return colonna(resolve(e.nome));
    return Array.isArray(e) ? e.map(canonical) : Object.fromEntries(Object.entries(e).map(([k, v]) => [k, canonical(v)]));
  };
  const groups = groupBy.map(g => {
    if (typeof g === 'string') g = colonna(g);
    if (g.tipo === 'valore' && Number.isInteger(g.valore)) {
      if (g.valore < 1 || g.valore > expressions.length) throw new Error('Posizione GROUP BY fuori dalla proiezione.');
      g = expressions[g.valore - 1];
    } else if (g.tipo === 'colonna' && aliases.has(g.nome)) g = aliases.get(g.nome);
    if (haAggregato(g)) throw new Error('GROUP BY non può contenere funzioni aggregate.');
    return g;
  });
  const groupKeys = groups.map(g => key(canonical(g)));
  const group = { _id: groups.length ? Object.fromEntries(groups.map((g, i) => [`g${i}`, { $ifNull: [emettiEspressione(g, resolve), null] }])) : null };
  const project = { _id: 0 }, empty = { _id: null }, aggregates = new Map();
  groups.forEach((g, i) => { project[`g${i}`] = `$_id.g${i}`; });
  function aggregate(e) {
    const k = key(e);
    if (aggregates.has(k)) return colonna(aggregates.get(k));
    if (haAggregato(e.arg) || haAggregato(e.filter)) throw new Error('Un aggregato non può contenere un altro aggregato nello stesso raggruppamento.');
    const n = `a${aggregates.size}`, v = `v${aggregates.size}`, c = `c${aggregates.size}`;
    aggregates.set(k, n);
    const arg = e.arg.tipo === 'stella' ? 1 : { $ifNull: [emettiEspressione(e.arg, resolve), null] };
    const value = e.filter ? { $cond: [emettiEspressione(e.filter, resolve), arg, null] } : arg;
    const count = { $sum: { $cond: [nonNull(value), 1, 0] } };
    if (['RANGE_AGG', 'RANGE_INTERSECT_AGG'].includes(e.func)) {
      group[v] = { [e.distinct ? '$addToSet' : '$push']: value }; empty[v] = [];
      project[n] = require('./sqlMultirangeMongo').aggregato(e.func, `$${v}`);
    } else if (['MIN', 'MAX'].includes(e.func)) {
      group[v] = { [`$${e.func.toLowerCase()}`]: require('./sqlOrdinamentoMongo').candidato(value) }; empty[v] = null;
      project[n] = { $ifNull: [`$${v}.valore`, null] };
    } else if (e.distinct) {
      group[v] = { $addToSet: value }; empty[v] = [];
      const values = { $filter: { input: `$${v}`, as: 'v', cond: nonNull('$$v') } };
      project[n] = e.func === 'COUNT' ? { $size: values }
        : { $cond: [{ $gt: [{ $size: values }, 0] }, { [`$${e.func.toLowerCase()}`]: values }, null] };
    } else if (e.func === 'COUNT') {
      group[v] = count; empty[v] = 0; project[n] = `$${v}`;
    } else {
      group[v] = { [`$${e.func.toLowerCase()}`]: value }; empty[v] = null;
      if (e.func === 'SUM') { group[c] = count; empty[c] = 0; project[n] = { $cond: [{ $gt: [`$${c}`, 0] }, `$${v}`, null] }; }
      else project[n] = { $ifNull: [`$${v}`, null] };
    }
    return colonna(n);
  }
  function transform(e, useAliases = false, seen = new Set()) {
    if (!e || typeof e !== 'object') return e;
    if (e.tipo === 'sottoquery') return { ...e, ...(e.a ? { a: transform(e.a, useAliases, seen) } : {}) };
    if (e.tipo === 'aggregato') return aggregate(e);
    if (e.tipo) {
      const index = groupKeys.indexOf(key(canonical(e)));
      if (index >= 0) return colonna(`g${index}`);
    }
    if (e.tipo === 'colonna') {
      if (resolve(e.nome).startsWith('$')) return colonna(resolve(e.nome));
      if (useAliases && aliases.has(e.nome) && !seen.has(e.nome)) return transform(aliases.get(e.nome), false, new Set([...seen, e.nome]));
      throw new Error(`La colonna "${e.nome}" deve comparire in GROUP BY o dentro una funzione aggregata.`);
    }
    return Array.isArray(e) ? e.map(v => transform(v, useAliases, seen))
      : Object.fromEntries(Object.entries(e).map(([k, v]) => [k, transform(v, useAliases, seen)]));
  }
  const items = select.map((it, i) => ({ kind: 'expr', expr: transform(expressions[i]), alias: nomeColonna(it, i) }));
  const condition = having ? transform(having, true) : null;
  const order = orderBy.map(o => o.expr ? { ...o, expr: transform(o.expr, true) }
    : aliases.has(o.field) ? o : { ...o, field: transform(colonna(o.field)).nome });
  const pipeline = groups.length ? [{ $group: group }] : [
    { $facet: { gruppo: [{ $group: group }] } },
    { $replaceWith: { $ifNull: [{ $arrayElemAt: ['$gruppo', 0] }, { $literal: empty }] } },
  ];
  pipeline.push({ $project: project });
  return { pipeline, select: items, where: condition, orderBy: order, resolveCorrelated: name => transform(colonna(name)).nome };
}

module.exports = { raggruppa, haAggregato };
