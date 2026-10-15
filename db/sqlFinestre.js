'use strict';

// Le finestre restano sul server MongoDB. Una partizione ordinata permette di
// applicare anche i peer SQL (più chiavi, stringhe, NULL) senza JavaScript remoto.
const { leggiEspressione, emettiEspressione, prefissa } = require('./sqlEspressioni');
const FUNZIONI = new Set(require('../public/js/sql-mongo-funzioni.mjs').FINESTRE_SQL_MONGO);

function leggiFinestra(p, func, args) {
  if (!FUNZIONI.has(func)) throw new Error(`Funzione finestra non traducibile: ${func}.`);
  const arita = { ROW_NUMBER: [0, 0], RANK: [0, 0], DENSE_RANK: [0, 0], PERCENT_RANK: [0, 0], CUME_DIST: [0, 0],
    LAG: [1, 3], LEAD: [1, 3], NTH_VALUE: [2, 2] }[func] || [1, 1];
  if (args.length < arita[0] || args.length > arita[1]) throw new Error(`Numero di argomenti non valido per ${func}.`);
  if (args.some(a => a.tipo === 'stella') && func !== 'COUNT') throw new Error('* è valido soltanto in COUNT.');
  if (p.peek()?.type === 'ident') return { tipo: 'finestra', func, args, riferimento: p.parseIdent() };
  return { tipo: 'finestra', func, args, ...leggiSpecifica(p) };
}

function leggiSpecifica(p) {
  p.expectPunct('(');
  const riferimento = p.peek()?.type === 'ident' ? p.parseIdent() : null;
  const partition = [], order = [];
  if (p.eatKw('PARTITION')) {
    p.expectKw('BY');
    do { partition.push(leggiEspressione(p)); } while (p.eatPunct(','));
  }
  if (p.eatKw('ORDER')) {
    p.expectKw('BY');
    do {
      const expr = leggiEspressione(p);
      const dir = p.eatKw('DESC') ? -1 : (p.eatKw('ASC'), 1);
      let nulls = null;
      if (p.eatKw('NULLS')) { if (p.eatKw('FIRST')) nulls = 'first'; else { p.expectKw('LAST'); nulls = 'last'; } }
      order.push({ expr, dir, nulls });
    } while (p.eatPunct(','));
  }
  let frame = null;
  if (p.isKw('ROWS') || p.isKw('RANGE') || p.isKw('GROUPS')) {
    const tipo = p.next().value;
    const limite = () => {
      if (p.eatKw('CURRENT')) { p.expectKw('ROW'); return 0; }
      const n = p.eatKw('UNBOUNDED') ? Infinity : p.next()?.value;
      if (typeof n !== 'number' || n < 0 || (tipo !== 'RANGE' && n !== Infinity && !Number.isInteger(n))) throw new Error('Limite della finestra non valido.');
      if (p.eatKw('PRECEDING')) return -n;
      p.expectKw('FOLLOWING'); return n;
    };
    const between = p.eatKw('BETWEEN');
    const lo = limite();
    if (between) p.expectKw('AND');
    const hi = between ? limite() : 0;
    if (lo === Infinity || hi === -Infinity || lo > hi) throw new Error('Estremi della finestra non validi.');
    if (!riferimento && tipo === 'RANGE' && [lo, hi].some(n => Number.isFinite(n) && n !== 0) && order.length !== 1) throw new Error('RANGE con offset richiede una sola chiave numerica di ordinamento.');
    frame = { tipo, lo, hi };
    if (p.eatKw('EXCLUDE')) {
      if (p.eatKw('CURRENT')) { p.expectKw('ROW'); frame.exclude = 'current'; }
      else if (p.eatKw('GROUP')) frame.exclude = 'group';
      else if (p.eatKw('TIES')) frame.exclude = 'ties';
      else { p.expectKw('NO'); p.expectKw('OTHERS'); }
    }
  }
  p.expectPunct(')');
  return { riferimento, partition, order, frame };
}

const nonNull = x => ({ $ne: [{ $ifNull: [x, null] }, null] });
const ref = (a, resolve, prefix = '') => emettiEspressione(a, prefissa(resolve, prefix));

function stadiFinestre(finestre, resolve) {
  const pipeline = [{ $replaceWith: { origine: '$$ROOT', risultati: {} } }];
  finestre.forEach((w, indice) => {
    const chiavi = Object.fromEntries(w.order.map((o, i) => [`k${i}`, { $ifNull: [ref(o.expr, resolve, 'origine.'), null] }]));
    pipeline.push({ $set: { chiavi, ordinamento: Object.fromEntries(w.order.map((o, i) => [`k${i}`, require('./sqlOrdinamentoMongo').chiave(chiavi[`k${i}`])])) } });
    const sortBy = {};
    for (const [i, o] of w.order.entries()) {
      if (o.nulls) {
        pipeline.push({ $set: { [`nulli.n${i}`]: { $cond: [nonNull(`$chiavi.k${i}`), 0, 1] } } });
        sortBy[`nulli.n${i}`] = o.nulls === 'first' ? -1 : 1;
      }
      sortBy[`ordinamento.k${i}`] = o.dir;
    }
    const partitionBy = w.partition.length ? Object.fromEntries(w.partition.map((e, i) => [`p${i}`, { $ifNull: [ref(e, resolve, 'origine.'), null] }])) : null;
    // Un ordine costante soddisfa il vincolo MongoDB per i frame documentali;
    // OVER() in SQL lascia deliberatamente non specificato l'ordine delle righe.
    const configurazione = { ...(partitionBy ? { partitionBy } : {}), sortBy: w.order.length ? sortBy : { chiavi: 1 } };
    const nativo = finestraNativa(w, resolve, indice);
    if (nativo) {
      pipeline.push({ $setWindowFields: { ...configurazione, output: nativo.output } });
      pipeline.push({ $set: { [`risultati.f${indice}`]: nativo.result } }, { $unset: ['chiavi', 'ordinamento', 'nulli', 'valoreFinestra', 'conteggioFinestra'] });
      return;
    }
    pipeline.push({ $setWindowFields: {
      ...configurazione,
      output: { righe: { $push: { origine: '$origine', chiavi: '$chiavi' }, window: { documents: ['unbounded', 'unbounded'] } },
        posizione: { $sum: 1, window: { documents: ['unbounded', 'current'] } } },
    } });
    const n = { $size: '$righe' }, i = { $subtract: ['$posizione', 1] };
    if (w.frame?.exclude) pipeline.push({ $set: { righe: { $map: { input: { $range: [0, n] }, as: 'j',
      in: { $mergeObjects: [{ $arrayElemAt: ['$righe', '$$j'] }, { numero: '$$j' }] } } } } });
    const peer = { $eq: ['$$r.chiavi', '$chiavi'] };
    const prima = { $indexOfArray: [{ $map: { input: '$righe', as: 'r', in: '$$r.chiavi' } }, '$chiavi'] };
    const dopo = { $add: [prima, { $size: { $filter: { input: '$righe', as: 'r', cond: peer } } }] };
    const arg = w.args[0];
    const valori = rows => {
      const value = arg?.tipo === 'stella' ? 1 : { $ifNull: [ref(arg, resolve, '$r.origine.'), null] };
      return { $map: { input: rows, as: 'r', in: w.filter ? { $cond: [ref(w.filter, resolve, '$r.origine.'), value, null] } : value } };
    };
    let result;
    const intero = (a, defaultValue, minimo) => {
      if (!a) return defaultValue;
      if (a.tipo !== 'valore' || !Number.isSafeInteger(a.valore) || a.valore < minimo) throw new Error(`${w.func} richiede un intero costante >= ${minimo}.`);
      return a.valore;
    };
    if (w.func === 'ROW_NUMBER') result = '$posizione';
    else if (w.func === 'RANK') result = { $add: [prima, 1] };
    else if (w.func === 'DENSE_RANK') result = { $size: { $setUnion: [{ $map: { input: { $slice: ['$righe', '$posizione'] }, as: 'r', in: '$$r.chiavi' } }, []] } };
    else if (w.func === 'PERCENT_RANK') result = { $cond: [{ $lte: [n, 1] }, 0, { $divide: [prima, { $subtract: [n, 1] }] }] };
    else if (w.func === 'CUME_DIST') result = { $divide: [dopo, n] };
    else if (w.func === 'NTILE') {
      const buckets = intero(arg, null, 1);
      const q = { $floor: { $divide: [n, buckets] } }, r = { $mod: [n, buckets] };
      const grandi = { $multiply: [r, { $add: [q, 1] }] };
      result = { $cond: [{ $lt: [i, grandi] }, { $add: [{ $floor: { $divide: [i, { $add: [q, 1] }] } }, 1] },
        { $add: [r, { $floor: { $divide: [{ $subtract: [i, grandi] }, { $max: [q, 1] }] } }, 1] }] };
    } else if (w.func === 'LAG' || w.func === 'LEAD') {
      const offset = intero(w.args[1], 1, 0) * (w.func === 'LAG' ? -1 : 1);
      const target = { $add: [i, offset] };
      result = { $cond: [{ $and: [{ $gte: [target, 0] }, { $lt: [target, n] }] },
        { $arrayElemAt: [valori('$righe'), target] }, w.args[2] ? ref(w.args[2], resolve, 'origine.') : null] };
    } else {
      const frame = w.frame || { tipo: 'RANGE', lo: -Infinity, hi: w.order.length ? 0 : Infinity };
      let rows;
      if (frame.tipo === 'GROUPS') {
        const gruppi = { $reduce: { input: '$righe', initialValue: [], in: { $cond: [
          { $in: ['$$this.chiavi', '$$value'] }, '$$value', { $concatArrays: ['$$value', ['$$this.chiavi']] },
        ] } } };
        const gruppo = { $indexOfArray: [gruppi, '$chiavi'] }, riga = { $indexOfArray: [gruppi, '$$r.chiavi'] };
        const bounds = [];
        if (frame.lo !== -Infinity) bounds.push({ $gte: [riga, { $add: [gruppo, frame.lo] }] });
        if (frame.hi !== Infinity) bounds.push({ $lte: [riga, { $add: [gruppo, frame.hi] }] });
        rows = { $filter: { input: '$righe', as: 'r', cond: { $and: bounds } } };
      } else if (frame.tipo === 'ROWS') {
        const lo = frame.lo === -Infinity ? 0 : { $max: [0, { $add: [i, frame.lo] }] };
        const hi = frame.hi === Infinity ? n : { $min: [n, { $add: [i, frame.hi + 1] }] };
        const size = { $max: [0, { $subtract: [hi, lo] }] };
        rows = { $cond: [{ $gt: [size, 0] }, { $slice: ['$righe', lo, size] }, []] };
      } else if ([frame.lo, frame.hi].every(x => !Number.isFinite(x) || x === 0)) {
        const lo = frame.lo === -Infinity ? 0 : prima, hi = frame.hi === Infinity ? n : dopo;
        rows = { $slice: ['$righe', lo, { $subtract: [hi, lo] }] };
      } else {
        const val = '$chiavi.k0', rowval = '$$r.chiavi.k0', dir = w.order[0].dir;
        const bounds = [];
        if (frame.lo !== -Infinity) bounds.push({ [dir === 1 ? '$gte' : '$lte']: [rowval, { $add: [val, frame.lo * dir] }] });
        if (frame.hi !== Infinity) bounds.push({ [dir === 1 ? '$lte' : '$gte']: [rowval, { $add: [val, frame.hi * dir] }] });
        rows = { $filter: { input: '$righe', as: 'r', cond: { $cond: [nonNull(val), { $and: [nonNull(rowval), ...bounds] }, peer] } } };
      }
      if (frame.exclude) {
        const corrente = { $eq: ['$$r.numero', i] };
        rows = { $filter: { input: rows, as: 'r', cond: frame.exclude === 'current' ? { $not: [corrente] }
          : frame.exclude === 'group' ? { $not: [peer] } : { $or: [corrente, { $not: [peer] }] } } };
      }
      const vals = valori(rows), validi = { $filter: { input: vals, as: 'v', cond: nonNull('$$v') } };
      if (w.func === 'COUNT') result = { $size: validi };
      else if (['MIN', 'MAX'].includes(w.func)) result = require('./sqlOrdinamentoMongo').estremo(w.func, validi);
      else if (['RANGE_AGG', 'RANGE_INTERSECT_AGG'].includes(w.func)) result = require('./sqlMultirangeMongo').aggregato(w.func, validi);
      else if (['SUM', 'AVG'].includes(w.func)) result = { $cond: [{ $gt: [{ $size: validi }, 0] }, { [`$${w.func.toLowerCase()}`]: validi }, null] };
      else {
        const at = w.func === 'LAST_VALUE' ? -1 : w.func === 'NTH_VALUE' ? intero(w.args[1], null, 1) - 1 : 0;
        result = { $ifNull: [{ $arrayElemAt: [vals, at] }, null] };
      }
    }
    pipeline.push({ $set: { [`risultati.f${indice}`]: result } }, { $unset: ['righe', 'posizione', 'chiavi', 'ordinamento', 'nulli'] });
  });
  return pipeline;
}

function finestraNativa(w, resolve) {
  // Percorso streaming per ROWS e aggregati sull'intera partizione: non crea
  // array proporzionali alla partizione per i casi più frequenti.
  if (w.func === 'ROW_NUMBER') return { output: { valoreFinestra: { $sum: 1, window: { documents: ['unbounded', 'current'] } } }, result: '$valoreFinestra' };
  const frame = w.frame || (!w.order.length ? { tipo: 'ROWS', lo: -Infinity, hi: Infinity } : null);
  if (!frame || frame.exclude || frame.tipo !== 'ROWS' || !['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'FIRST_VALUE', 'LAST_VALUE'].includes(w.func)) return null;
  const limite = n => !Number.isFinite(n) ? 'unbounded' : n === 0 ? 'current' : n;
  const window = { documents: [limite(frame.lo), limite(frame.hi)] };
  const value = w.args[0].tipo === 'stella' ? 1 : { $ifNull: [ref(w.args[0], resolve, 'origine.'), null] };
  const a = w.filter ? { $cond: [ref(w.filter, resolve, 'origine.'), value, null] } : value;
  const count = { $sum: { $cond: [nonNull(a), 1, 0] }, window };
  if (w.func === 'COUNT') return { output: { valoreFinestra: count }, result: '$valoreFinestra' };
  if (['MIN', 'MAX'].includes(w.func)) return { output: { valoreFinestra: { [`$${w.func.toLowerCase()}`]: require('./sqlOrdinamentoMongo').candidato(a), window } }, result: { $ifNull: ['$valoreFinestra.valore', null] } };
  const op = { FIRST_VALUE: '$first', LAST_VALUE: '$last' }[w.func] || `$${w.func.toLowerCase()}`;
  return { output: { valoreFinestra: { [op]: a, window }, ...(w.func === 'SUM' ? { conteggioFinestra: count } : {}) },
    result: w.func === 'SUM' ? { $cond: [{ $gt: ['$conteggioFinestra', 0] }, '$valoreFinestra', null] } : { $ifNull: ['$valoreFinestra', null] } };
}

module.exports = { FUNZIONI, leggiFinestra, leggiSpecifica, stadiFinestre };
