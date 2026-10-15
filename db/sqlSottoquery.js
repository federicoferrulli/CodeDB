'use strict';
const { emettiEspressione, prefissa } = require('./sqlEspressioni');

function contieneSottoquery(e) {
  return !!e && typeof e === 'object' && (e.tipo === 'sottoquery' || Object.values(e).some(contieneSottoquery));
}

// Ogni livello conserva i documenti sorgente in un involucro: i nomi interni
// non possono sovrascrivere campi dell'utente. Le correlazioni passano da let.
function espandiSottoquery(expressions, pipeline, resolve, scope, ctes) {
  if (!expressions.some(contieneSottoquery)) return resolve;
  const { translateTokens, planToPipeline } = require('./SqlToMql');
  pipeline.push({ $replaceWith: { dati: '$$ROOT', risposte: {} } });
  const source = resolve.root || (resolve.using?.length ? null : '$$ROOT');
  const original = resolve;
  const livello = (original.livello || 0) + 1;
  resolve = n => typeof n === 'object' && n.livello === livello ? `risposte.${n.campo}` : prefissa(original, 'dati.')(n);
  resolve.livello = livello;
  resolve.flattenUsing = original.flattenUsing || !!original.using?.length;
  resolve.root = source === '$$ROOT' ? '$dati' : source ? `$dati.${source.slice(1)}` : '$dati';
  let index = 0;
  function visita(e) {
    if (!e || typeof e !== 'object') return;
    if (e.tipo !== 'sottoquery') { Object.values(e).forEach(visita); return; }
    visita(e.a);
    const bindings = {}, names = new Map();
    const outer = {
      has: name => scope.aliases.has(name.split('.')[0]) || !!scope.outer?.has(name),
      resolve: name => {
        if (!names.has(name)) {
          const key = `v${names.size}`;
          bindings[key] = `$${scope.aliases.has(name.split('.')[0])
            ? resolve(scope.correlated ? scope.correlated(name) : name) : scope.outer.resolve(name)}`;
          names.set(name, `$${key}`);
        }
        return names.get(name);
      },
    };
    const plan = translateTokens(e.tokens, ctes, outer, e.modo === 'exists');
    if (plan.kind === 'program') throw new Error('Una CTE ricorsiva dentro una sottoquery richiede un piano iterativo esterno.');
    if (e.modo !== 'exists' && plan.columns?.length !== 1) throw new Error('La sottoquery deve restituire esattamente una colonna esplicita.');
    const field = `s${index++}`, rows = `$risposte.${field}`, sub = planToPipeline(plan);
    if (e.modo === 'exists') sub.push({ $limit: 1 });
    if (e.modo === 'scalare') sub.push({ $limit: 2 });
    pipeline.push({ $lookup: { ...(plan.coll ? { from: plan.coll } : {}), let: bindings, pipeline: sub, as: `risposte.${field}` } });
    const values = { $map: { input: rows, as: 'r', in: { $ifNull: [`$$r.${plan.columns?.[0]}`, null] } } };
    let value;
    if (e.modo === 'exists') value = { $gt: [{ $size: rows }, 0] };
    else if (e.modo === 'scalare') value = { $cond: [{ $lte: [{ $size: rows }, 1] }, { $ifNull: [{ $arrayElemAt: [values, 0] }, null] },
      // L'errore resta condizionale a dati reali, evitando una valutazione
      // anticipata dell'ottimizzatore anche quando la cardinalità è corretta.
      { $convert: { input: { $concat: ['Sottoquery scalare: più di una riga (', { $toString: { $size: rows } }, ')'] }, to: 'int' } }] };
    else {
      const a = emettiEspressione(e.a, resolve), b = '$$v';
      const op = { '=': '$eq', '<>': '$ne', '!=': '$ne', '>': '$gt', '<': '$lt', '>=': '$gte', '<=': '$lte' }[e.op];
      const comparisons = { $map: { input: values, as: 'v', in: { $cond: [
        { $or: [{ $eq: [{ $ifNull: [a, null] }, null] }, { $eq: [b, null] }] }, null, { [op]: [a, b] }] } } };
      const decisive = e.modo === 'ANY';
      value = { $cond: [{ $in: [decisive, comparisons] }, decisive, { $cond: [{ $in: [null, comparisons] }, null, !decisive] }] };
    }
    pipeline.push({ $set: { [`risposte.${field}`]: value } });
    for (const k of Object.keys(e)) delete e[k];
    Object.assign(e, { tipo: 'risultatoquery', campo: field, livello });
  }
  expressions.forEach(visita);
  return resolve;
}

module.exports = { contieneSottoquery, espandiSottoquery };
