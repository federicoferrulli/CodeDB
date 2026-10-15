'use strict';

// Espressioni SQL pure: parsing separato dall'emissione dei riferimenti, che
// si risolvono soltanto dopo aver letto FROM e gli alias delle JOIN.
const { FUNZIONI_SQL_MONGO, AGGREGATI_SQL_MONGO } = require('../public/js/sql-mongo-funzioni.mjs');
const precedenza = { OR: 1, AND: 2, '=': 3, '!=': 3, '<>': 3, '>': 3, '<': 3, '>=': 3, '<=': 3,
  '@>': 3, '<@': 3, '&&': 3, '<<':3, '>>':3, '&<':3, '&>':3, '-|-':3, '||': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
const operatori = { OR: '$or', AND: '$and', '=': '$eq', '!=': '$ne', '<>': '$ne', '>': '$gt', '<': '$lt',
  '>=': '$gte', '<=': '$lte', '||': '$concat', '+': '$add', '-': '$subtract', '*': '$multiply', '/': '$divide', '%': '$mod' };

function leggiEspressione(p, minimo = 0) {
  let a = primaria(p);
  for (;;) {
    if (p.eatPunct('[')) {
      const first = p.isPunct(':') ? undefined : leggiEspressione(p);
      const slice = p.eatPunct(':');
      const upper = slice && !p.isPunct(']') ? leggiEspressione(p) : undefined;
      p.expectPunct(']'); a = { tipo: 'indicearray', a, ...(slice ? { slice, lower: first, upper } : { index: first }) }; continue;
    }
    if (p.peek()?.value === '::') { p.next(); a = { tipo: 'cast', a, descriptor: require('./sqlSchemaMongo').tipo(p) }; continue; }
    const t = p.peek(), op = t && ['kw', 'op', 'punct'].includes(t.type) && String(t.value).toUpperCase();
    // NOT NULL appartiene alla definizione dopo DEFAULT, non all'espressione.
    if (op === 'NOT' && !['IN', 'BETWEEN', 'LIKE', 'ILIKE'].includes(String(p.peek(1)?.value).toUpperCase())) break;
    if (minimo <= 3 && ['IS', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'NOT'].includes(op)) {
      const negato = p.eatKw('NOT');
      if (p.eatKw('IS')) {
        const neg = p.eatKw('NOT');
        if (p.eatKw('DISTINCT')) {
          p.expectKw('FROM'); a = { tipo: 'distinct', a, b: leggiEspressione(p, 4), neg };
        } else {
          const valore = p.next();
          if (valore?.type !== 'kw' || !['NULL', 'TRUE', 'FALSE'].includes(valore.value)) throw new Error('IS richiede NULL, TRUE, FALSE o DISTINCT FROM.');
          a = { tipo: 'is', a, valore: valore.value === 'NULL' ? null : valore.value === 'TRUE', neg };
        }
      } else if (p.eatKw('IN')) {
        p.expectPunct('(');
        if (p.isKw('SELECT') || p.isKw('WITH')) {
          p.pos--; a = { tipo: 'sottoquery', modo: 'ANY', op: '=', a, tokens: p.readParenGroup() };
        } else {
          const valori = [];
          do { valori.push(leggiEspressione(p)); } while (p.eatPunct(','));
          p.expectPunct(')'); a = { tipo: 'in', a, valori };
        }
      } else if (p.eatKw('BETWEEN')) {
        const lo = leggiEspressione(p, 4); p.expectKw('AND');
        a = { tipo: 'between', a, lo, hi: leggiEspressione(p, 4) };
      } else if (p.isKw('LIKE') || p.isKw('ILIKE')) {
        const insensitive = p.next().value === 'ILIKE';
        const pattern = leggiEspressione(p, 4);
        if (pattern.tipo !== 'valore') throw new Error('Il pattern LIKE deve essere una stringa fra apici.');
        a = { tipo: 'like', a, pattern: pattern.valore, insensitive };
      } else throw new Error('NOT deve precedere IN, LIKE, ILIKE o BETWEEN.');
      if (negato) a = { tipo: 'unaria', op: 'NOT', a };
      continue;
    }
    const grado = precedenza[op];
    if (!grado || grado < minimo) break;
    p.next();
    if (grado === 3 && p.peek()?.type === 'kw' && ['ANY', 'SOME', 'ALL'].includes(p.peek()?.value)) {
      const modo = p.next().value === 'ALL' ? 'ALL' : 'ANY';
      const tokens = p.readParenGroup();
      if (['SELECT', 'WITH'].includes(tokens[0]?.value)) a = { tipo: 'sottoquery', modo, op, a, tokens };
      else { const q = new (require('./SqlToMql').Parser)(tokens), b = leggiEspressione(q); if (!q.eof()) throw new Error('Argomento ANY/ALL non valido.'); a = { tipo: 'quantificata', modo, op, a, b }; }
      continue;
    }
    a = { tipo: 'binaria', op, a, b: leggiEspressione(p, grado + 1) };
  }
  return a;
}

function primaria(p) {
  const t = p.next();
  if (!t) throw new Error('Espressione SQL incompleta.');
  if (t.type === 'punct' && t.value === '(') {
    if (p.isKw('SELECT') || p.isKw('WITH')) { p.pos--; return { tipo: 'sottoquery', modo: 'scalare', tokens: p.readParenGroup() }; }
    const e = leggiEspressione(p); p.expectPunct(')'); return e;
  }
  if (['num', 'str', 'binary'].includes(t.type)) return { tipo: 'valore', valore: t.exact ? require('bson').Decimal128.fromString(t.exact) : t.value };
  const nome = String(t.value).toUpperCase();
  if (nome === 'ARRAY' && p.eatPunct('[') || t.value === '[' && t.type === 'punct') {
    const args = [];
    if (!p.isPunct(']')) do { args.push(leggiEspressione(p)); } while (p.eatPunct(','));
    p.expectPunct(']'); return { tipo: 'array', args };
  }
  if (nome === 'EXISTS' && t.type === 'kw') return { tipo: 'sottoquery', modo: 'exists', tokens: p.readParenGroup() };
  if (t.type === 'kw' && ['TRUE', 'FALSE', 'NULL'].includes(nome)) {
    return { tipo: 'valore', valore: nome === 'NULL' ? null : nome === 'TRUE' };
  }
  if (['kw', 'op'].includes(t.type) && ['+', '-', 'NOT'].includes(nome)) return { tipo: 'unaria', op: nome, a: leggiEspressione(p, nome === 'NOT' ? 3 : 7) };
  if (t.type === 'kw' && nome === 'CASE') {
    const base = p.isKw('WHEN') ? null : leggiEspressione(p);
    const rami = [];
    while (p.eatKw('WHEN')) {
      const condizione = leggiEspressione(p);
      p.expectKw('THEN');
      rami.push({ condizione: base ? { tipo: 'binaria', op: '=', a: base, b: condizione } : condizione,
        valore: leggiEspressione(p) });
    }
    if (!rami.length) throw new Error('CASE richiede almeno un WHEN.');
    const altrimenti = p.eatKw('ELSE') ? leggiEspressione(p) : { tipo: 'valore', valore: null };
    p.expectKw('END');
    return { tipo: 'case', rami, altrimenti };
  }
  if (t.type !== 'ident' && !(nome === 'CAST' || nome === 'CURRENT_TIMESTAMP')) {
    throw new Error(`Espressione SQL non valida: "${t.value}".`);
  }
  if (p.eatPunct('(')) {
    if (nome === 'CAST') {
      const a = leggiEspressione(p);
      p.expectKw('AS');
      const descriptor = require('./sqlSchemaMongo').tipo(p, true);
      p.expectPunct(')');
      return { tipo: 'cast', a, descriptor };
    }
    const distinct = p.eatKw('DISTINCT');
    const args = [];
    if (!p.isPunct(')')) do { args.push(p.eatPunct('*') ? { tipo: 'stella' } : leggiEspressione(p)); } while (p.eatPunct(','));
    p.expectPunct(')');
    let filter = null;
    if (p.eatKw('FILTER')) { p.expectPunct('('); p.expectKw('WHERE'); filter = leggiEspressione(p); p.expectPunct(')'); }
    if (p.eatKw('OVER')) {
      if (distinct) throw new Error('DISTINCT nelle finestre non è disponibile nei dialetti PostgreSQL/MySQL verificati.');
      if (filter && !AGGREGATI_SQL_MONGO.includes(nome)) throw new Error('FILTER richiede una funzione aggregata.');
      return { ...require('./sqlFinestre').leggiFinestra(p, nome, args), filter };
    }
    if (AGGREGATI_SQL_MONGO.includes(nome)) {
      if (args.length !== 1) throw new Error(`${nome} richiede un argomento.`);
      if (args[0].tipo === 'stella' && (nome !== 'COUNT' || distinct)) throw new Error('* è ammesso soltanto in COUNT(*) senza DISTINCT.');
      return { tipo: 'aggregato', func: nome, arg: args[0], distinct, filter };
    }
    const spec = FUNZIONI_SQL_MONGO[nome];
    if (p.insertConflict && nome === 'VALUES' && args.length === 1 && args[0].tipo === 'colonna') return { tipo: 'colonna', nome: `excluded.${args[0].nome}` };
    if (distinct || filter) throw new Error('DISTINCT e FILTER richiedono una funzione aggregata.');
    if (!spec) throw new Error(`Funzione SQL "${nome}" non traducibile in MQL.`);
    if (args.length < spec[1] || args.length > (spec[2] ?? spec[1])) throw new Error(`Numero di argomenti non valido per ${nome}.`);
    return { tipo: 'funzione', nome, args };
  }
  if (nome === 'CURRENT_TIMESTAMP') return { tipo: 'funzione', nome, args: [] };
  return { tipo: 'colonna', nome: t.value };
}

const nullo = x => ({ $eq: [{ $ifNull: [x, null] }, null] });
function conNull(args, expr) {
  return { $cond: [{ $or: args.map(nullo) }, null, expr] };
}

function emettiEspressione(e, resolve = x => x) {
  const emetti = x => emettiEspressione(x, resolve);
  if (e.tipo === 'valore') return { $literal: e.valore };
  if (e.tipo === 'array') return require('./sqlArrayMongo').costruisci(e.args.map(emetti));
  if(e.tipo==='assegnaarray') return require('./sqlArrayAssegnazione').assegna(emetti(e.a),e.indices.map(i=>i.slice?{slice:true,lower:i.lower&&emetti(i.lower),upper:i.upper&&emetti(i.upper)}:{slice:false,index:emetti(i.index)}),emetti(e.replacement));
  if (e.tipo === 'indicearray') {
    const indices = []; let current = e;
    while (current.tipo === 'indicearray') {
      indices.unshift(current.slice ? { slice: true, lower: current.lower && emetti(current.lower), upper: current.upper && emetti(current.upper) } : { slice: false, index: emetti(current.index) }); current = current.a;
    }
    return require('./sqlArrayMongo').accesso(emetti(current), indices);
  }
  if (e.tipo === 'quantificata') {
    const a = emetti(e.a), b = emetti(e.b), all = e.modo === 'ALL';
    const item = conNull([a, '$$elemento'], { [operatori[e.op]]: [a, '$$elemento'].map(require('./sqlOrdinamentoMongo').chiave) });
    return conNull([b], { $let: { vars: { confronti: { $map: { input: require('./sqlArrayMongo').piatta(b), as: 'elemento', in: item } } }, in: { $cond: [
      { $in: [!all, '$$confronti'] }, !all, { $cond: [{ $in: [null, '$$confronti'] }, null, all] },
    ] } } });
  }
  if (e.tipo === 'colonna') return `$${resolve(e.nome)}`;
  if (e.tipo === 'risultatoquery') return `$${resolve(e)}`;
  if (e.tipo === 'finestra') {
    if (e.indice == null) throw new Error('Le funzioni finestra sono ammesse nella SELECT, dopo WHERE e HAVING.');
    return `$risultati.f${e.indice}`;
  }
  if (e.tipo === 'is') return { [e.neg ? '$ne' : '$eq']: [{ $ifNull: [emetti(e.a), null] }, { $literal: e.valore }] };
  if (e.tipo === 'distinct') return { [e.neg ? '$eq' : '$ne']: [e.a, e.b].map(v => ({ $ifNull: [emetti(v), null] })) };
  if (e.tipo === 'between') {
    const a = emetti(e.a), lo = emetti(e.lo), hi = emetti(e.hi);
    const key = require('./sqlOrdinamentoMongo').chiave;
    return conNull([a, lo, hi], { $and: [{ $gte: [key(a), key(lo)] }, { $lte: [key(a), key(hi)] }] });
  }
  if (e.tipo === 'in') {
    const a = emetti(e.a), valori = e.valori.map(emetti);
    // IN: una corrispondenza vince sui NULL nella lista; in assenza di una
    // corrispondenza un NULL rende il risultato sconosciuto (anche in NOT IN).
    return conNull([a], { $cond: [{ $in: [a, valori] }, true, { $cond: [{ $or: valori.map(nullo) }, null, false] }] });
  }
  if (e.tipo === 'like') {
    const a = emetti(e.a);
    if (e.pattern === null) return { $literal: null };
    const rx = regexLike(e.pattern, e.insensitive);
    return conNull([a], { $regexMatch: { input: a, regex: rx.$regex, ...(rx.$options ? { options: rx.$options } : {}) } });
  }
  if (e.tipo === 'cast') {
    if (e.descriptor?.type === 'DOMAIN') return require('./sqlCastDomini').emetti(e.descriptor, emetti(e.a));
    if (e.descriptor && ['JSON','ENUM','UUID'].includes(e.descriptor.type) && !e.descriptor.array) throw new Error(`Tipo CAST non traducibile: ${e.descriptor.type}.`);
    if (e.descriptor && e.descriptor.type !== 'DOMAIN') return require('./sqlSchemaMongo').convertiValore({ ...e.descriptor, cast: true }, emetti(e.a));
    const tipo = { TEXT: 'string', VARCHAR: 'string', CHAR: 'string', INT: 'int', INTEGER: 'int', BIGINT: 'long',
      NUMERIC: 'decimal', DECIMAL: 'decimal', REAL: 'double', DOUBLE: 'double', FLOAT: 'double',
      BOOLEAN: 'bool', BOOL: 'bool', DATE: 'date', TIMESTAMP: 'date' }[e.descriptor?.type || e.destinazione];
    if (!tipo) throw new Error(`Tipo CAST non traducibile: ${e.descriptor?.type || e.destinazione}.`);
    return { $convert: { input: emetti(e.a), to: tipo } };
  }
  if (e.tipo === 'unaria') {
    const a = emetti(e.a);
    if (e.op === '+') return a;
    return e.op === '-' ? { $multiply: [-1, a] } : conNull([a], { $not: [a] });
  }
  if (e.tipo === 'binaria') {
    const bind = expression => ({ $let: { vars: { operandoA: emetti(e.a), operandoB: emetti(e.b) }, in: expression } });
    const a = '$$operandoA', b = '$$operandoB', expr = { [operatori[e.op]]: [a, b] };
    if(['<<','>>','&<','&>','-|-'].includes(e.op))return bind(require('./sqlMultirangeMongo').operatore(e.op,a,b));
    if(['<','>','<=','>='].includes(e.op)) {
      const multi=require('./sqlMultirangeMongo'),av=require('./sqlArrayValore');
      return bind(conNull([a,b],{$cond:[multi.isRange(a),{[operatori[e.op]]:[multi.chiave(a),multi.chiave(b)]},
        {$cond:[{$and:[av.isArray(a),av.isArray(b)]},{[operatori[e.op]]:[require('./sqlArrayMongo').chiave(a),require('./sqlArrayMongo').chiave(b)]},expr]}]}));
    }
    if (['@>', '<@', '&&'].includes(e.op)) {
      const av = require('./sqlArrayValore'), arr = v => ({ $cond: [av.isArray(v), v, []] });
      return bind(conNull([a, b], { $cond: [{ $or: [av.isArray(a), av.isArray(b)] }, require('./sqlArrayMongo').operatore(e.op, arr(a), arr(b)), require('./sqlMultirangeMongo').operatore(e.op, a, b)] }));
    }
    if (e.op === '||') {
      const arrays = require('./sqlArrayMongo');
      const av = require('./sqlArrayValore');
      // Le alternative non selezionate ricevono array validi anche durante
      // l'ottimizzazione delle costanti di MongoDB.
      const safeA = { $cond: [av.isArray(a), a, []] }, safeB = { $cond: [av.isArray(b), b, []] };
      return bind({ $cond: [av.isArray(a), { $cond: [{ $or: [av.isArray(b), nullo(b)] }, arrays.funzione('ARRAY_CAT', [safeA,safeB]), arrays.funzione('ARRAY_APPEND', [safeA,b])] },
        { $cond: [av.isArray(b), { $cond: [nullo(a), b, arrays.funzione('ARRAY_PREPEND', [a,safeB])] }, conNull([a, b], expr)] },
      ] });
    }
    if (['+','-','*'].includes(e.op)) return bind(conNull([a,b], { $cond: [require('./sqlMultirangeMongo').isRange(a), require('./sqlMultirangeMongo').operatore(e.op,a,b),expr] }));
    // La logica SQL ha tre valori; MongoDB considera null come falso.
    if (e.op === 'AND') return bind({ $cond: [{ $or: [{ $eq: [a, false] }, { $eq: [b, false] }] }, false, conNull([a, b], expr)] });
    if (e.op === 'OR') return bind({ $cond: [{ $or: [{ $eq: [a, true] }, { $eq: [b, true] }] }, true, conNull([a, b], expr)] });
    return bind(conNull([a, b], expr));
  }
  if (e.tipo === 'case') return { $switch: { branches: e.rami.map(r => ({ case: emetti(r.condizione), then: emetti(r.valore) })), default: emetti(e.altrimenti) } };
  if (e.tipo !== 'funzione') throw new Error('Espressione SQL sconosciuta.');
  const args = e.args.map(emetti), [op] = FUNZIONI_SQL_MONGO[e.nome];
  if (op === 'array') return require('./sqlArrayMongo').funzione(e.nome, args);
  if (op === 'range') return require('./sqlRangeMongo').funzione(e.nome, args);
  if (op === 'multirange') return require('./sqlMultirangeMongo').funzione(e.nome, args);
  if (['LOWER', 'UPPER'].includes(e.nome)) {
    const object = { $eq: [{ $type: args[0] }, 'object'] };
    return { $cond: [object, require('./sqlRangeMongo').funzione(e.nome, [{ $cond: [object, args[0], {}] }]), conNull(args, { [op]: { $cond: [object, null, args[0]] } })] };
  }
  if (op === 'hex') return esadecimale(args[0]);
  if (op === '$strLenBytes') return conNull(args, { $cond: [{ $eq: [{ $type: args[0] }, 'binData'] }, { $binarySize: args[0] }, { $strLenBytes: args[0] }] });
  if (op === 'now') return '$$NOW';
  if (op === 'nullif') return { $cond: [{ $eq: args }, null, args[0]] };
  if (op === '$ifNull') return { $ifNull: args };
  if (op === '$cond') return { $cond: args };
  if (op === '$min' || op === '$max') return conNull(args, require('./sqlOrdinamentoMongo').estremo(op === '$min' ? 'MIN' : 'MAX', args));
  if (['$trim', '$ltrim', '$rtrim'].includes(op)) return { [op]: { input: args[0], ...(args.length > 1 ? { chars: args[1] } : {}) } };
  if (op === '$replaceAll') return { $replaceAll: { input: args[0], find: args[1], replacement: args[2] } };
  if (op === '$substrCP') {
    const start = { $max: [0, { $subtract: [args[1], 1] }] };
    return conNull(args, { $substrCP: [args[0], start, args[2] ?? { $strLenCP: args[0] }] });
  }
  const expr = { [op]: args.length === 1 && !['$round', '$trunc', '$concat', '$max', '$min'].includes(op) ? args[0] : args };
  return conNull(args, expr);
}

function regexLike(pattern, insensitive = false) {
  const str = String(pattern);
  if ((str.match(/[%_]/g) || []).length > 20) throw new Error('Pattern LIKE troppo complesso: massimo 20 caratteri jolly.');
  let out = '';
  const escape = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    out += c === '%' ? '.*' : c === '_' ? '.' : c === '\\' && i + 1 < str.length ? escape(str[++i]) : escape(c);
  }
  const regex = '^' + out + '$';
  const ancorato = /^\^[^.*+?[\]{}()|\\]/.test(regex);
  return { $regex: regex, ...(insensitive || !ancorato ? { $options: 'i' } : {}) };
}

// Mantiene indicizzabili i predicati semplici; tutte le combinazioni più
// articolate passano dalla stessa algebra a tre valori usata nella SELECT.
function filtroEspressione(e, resolve = x => x) {
  if (e.a?.tipo === 'colonna' && resolve(e.a.nome).startsWith('$')) return { $expr: emettiEspressione(e, resolve) };
  if (e.tipo === 'binaria' && ['AND', 'OR'].includes(e.op)) {
    const key = e.op === 'AND' ? '$and' : '$or';
    const parti = [e.a, e.b].flatMap(x => { const v = filtroEspressione(x, resolve); return v[key] || [v]; });
    return { [key]: parti };
  }
  if (e.tipo === 'binaria' && e.a.tipo === 'colonna' && e.b.tipo === 'valore' && precedenza[e.op] === 3) {
    const col = resolve(e.a.nome), val = e.b.valore;
    if (val === null) return { $expr: false };
    if (e.op === '=') return { [col]: val };
    if (e.op === '!=' || e.op === '<>') return { $and: [{ [col]: { $ne: null } }, { [col]: { $ne: val } }] };
    return { [col]: { [operatori[e.op]]: val } };
  }
  if (e.tipo === 'is' && e.a.tipo === 'colonna' && e.valore === null) return { [resolve(e.a.nome)]: e.neg ? { $ne: null } : null };
  if (e.tipo === 'in' && e.a.tipo === 'colonna' && e.valori.every(v => v.tipo === 'valore')) {
    return { [resolve(e.a.nome)]: { $in: e.valori.map(v => v.valore).filter(v => v !== null) } };
  }
  if (e.tipo === 'between' && e.a.tipo === 'colonna' && e.lo.tipo === 'valore' && e.hi.tipo === 'valore') {
    return e.lo.valore === null || e.hi.valore === null ? { $expr: false } : { [resolve(e.a.nome)]: { $gte: e.lo.valore, $lte: e.hi.valore } };
  }
  if (e.tipo === 'like' && e.a.tipo === 'colonna' && e.pattern !== null) return { [resolve(e.a.nome)]: regexLike(e.pattern, e.insensitive) };
  return { $expr: emettiEspressione(e, resolve) };
}

function esadecimale(value) {
  const decimal = n => require('bson').Decimal128.fromString(n);
  const isNumeric = { $or: [{ $isNumber: value }, { $eq: [{ $type: value }, 'bool'] }] };
  const modulus = decimal('18446744073709551616'), minimum = decimal('-9223372036854775808'), maximum = decimal('18446744073709551615');
  const rounded = { $cond: [{ $gte: ['$$n', 0] }, { $floor: { $add: ['$$n', decimal('0.5')] } }, { $ceil: { $subtract: ['$$n', decimal('0.5')] } }] };
  const bounded = { $max: [minimum, { $cond: [{ $gt: [rounded, maximum] }, decimal('9223372036854775807'), rounded] }] };
  const numeric = { $let: { vars: { n: { $convert: { input: value, to: 'decimal', onError: 0, onNull: 0 } } }, in: { $let: { vars: { n: bounded }, in: {
    $let: { vars: { result: { $reduce: { input: { $range: [0, 16] }, initialValue: { n: { $cond: [{ $lt: ['$$n', 0] }, { $add: ['$$n', modulus] }, '$$n'] }, text: '' },
      in: { n: { $trunc: { $divide: ['$$value.n', 16] } }, text: { $cond: [{ $and: [{ $eq: ['$$value.n', 0] }, { $ne: ['$$value.text', ''] }] }, '$$value.text',
        { $concat: [{ $substrBytes: ['0123456789ABCDEF', { $toInt: { $mod: ['$$value.n', 16] } }, 1] }, '$$value.text'] }] } },
    } } }, in: '$$result.text' },
  } } } } };
  const binary = { $convert: { input: { $cond: [isNumeric, null, value] }, to: 'binData', format: 'utf8' } };
  return conNull([value], { $cond: [isNumeric, numeric,
    { $toUpper: { $convert: { input: binary, to: 'string', format: 'hex' } } }] });
}

// Le variabili correlate $$… restano assolute anche dentro gli involucri delle finestre.
function prefissa(resolve, prefix) { return n => { const p = resolve(n); return p.startsWith('$') ? p : prefix + p; }; }
module.exports = { leggiEspressione, emettiEspressione, filtroEspressione, prefissa };
