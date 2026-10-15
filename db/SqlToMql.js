'use strict';

/**
 * CodeDB — Traduttore SQL → MQL (MongoDB Query Language)
 *
 * Traduce un sottoinsieme comune di SQL SELECT in operazioni MongoDB, così la
 * tab "⚡ Query & Aggregate" può eseguire query SQL anche su MongoDB (non solo
 * su MySQL/PostgreSQL). Copertura:
 *
 *   - SELECT * | col1, col2 [AS alias] | aggregati | espressioni scalari e CASE
 *   - FROM <collezione>
 *   - WHERE con: = , != , <> , > , < , >= , <= ,
 *                AND / OR / NOT, parentesi,
 *                IN (...) / NOT IN (...),
 *                LIKE / NOT LIKE (i caratteri jolly % e _ → regex),
 *                IS [NOT] NULL,
 *                BETWEEN a AND b
 *   - SELECT DISTINCT col1, col2         → $group sui campi
 *   - GROUP BY col1, col2  con COUNT/SUM/AVG/MIN/MAX
 *   - HAVING (su alias/aggregati)        → $match dopo il $group
 *   - INNER/LEFT/RIGHT/FULL JOIN … ON … / USING (…) → $lookup e anti-join
 *   - CROSS JOIN, JOIN su CTE e derived table
 *                                          (alias di tabella e colonne
 *                                          qualificate a.col, JOIN concatenate)
 *   - UNION [ALL]                        → $unionWith (+ dedup per UNION)
 *   - FROM ( SELECT … ) AS sub           → sotto-query "derived table"
 *   - WITH [RECURSIVE] nome AS (SELECT …) → pipeline o programma iterativo
 *   - Finestre OVER/WINDOW con frame ROWS, RANGE e GROUPS
 *   - SELECT senza FROM e RETURNING transazionale sulle scritture
 *   - ORDER BY col [ASC|DESC], ...
 *   - LIMIT n  [OFFSET m]   |   LIMIT m, n  (stile MySQL: offset, count)
 *   - OFFSET m
 *
 * Restituisce un descrittore:
 *   { kind: 'find', coll, filter, projection, sort, limit, skip }
 * oppure, quando servono aggregazioni:
 *   { kind: 'aggregate', coll, pipeline }
 *
 * translateWrite gestisce INSERT, UPDATE (anche calcolati), DELETE e DDL
 * di collezioni, database e indici. Il perimetro e i limiti residui sono in
 * docs/copertura-linguaggi-query.md: questo modulo non emula un DBMS SQL.
 * Nessun accesso al DB: pura trasformazione di stringhe.
 */

const AGG_FUNCS = new Set(require('../public/js/sql-mongo-funzioni.mjs').AGGREGATI_SQL_MONGO);
const OP_TO_MQL = { '>': '$gt', '<': '$lt', '>=': '$gte', '<=': '$lte', '!=': '$ne', '<>': '$ne' };
const { leggiEspressione, emettiEspressione, filtroEspressione, prefissa } = require('./sqlEspressioni');
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'IS', 'NULL', 'BETWEEN', 'AS', 'ASC', 'DESC',
  'TRUE', 'FALSE', 'DISTINCT', 'JOIN', 'UNION', 'INTERSECT', 'EXCEPT',
  // JOIN e varianti
  'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING', 'ALL',
  'WITH', 'RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST',
  'OVER', 'PARTITION', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'RETURNING',
  'WINDOW', 'GROUPS', 'EXCLUDE', 'TIES', 'NO', 'OTHERS', 'NULLS', 'FIRST', 'LAST', 'FILTER', 'EXISTS', 'ANY', 'SOME',
]);

/* --------------------------------------------------------------------------
 * Tokenizer
 * ------------------------------------------------------------------------ */

// Tipi di token: 'kw' (parola chiave), 'ident', 'num', 'str', 'op', 'punct'.
function tokenize(sql) {
  const tokens = [];
  const s = String(sql);
  let i = 0;
  let arrayDepth = 0;
  const n = s.length;

  const isIdentStart = (c) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$.]/.test(c);

  while (i < n) {
    const c = s[i];
    if ((c === 'x' || c === 'X') && s[i + 1] === "'") {
      const end = s.indexOf("'", i + 2), hex = s.slice(i + 2, end);
      if (end < 0 || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('Letterale binario esadecimale non valido.');
      tokens.push({ type: 'binary', value: new (require('bson').Binary)(Buffer.from(hex, 'hex')) }); i = end + 1; continue;
    }

    // Spazi
    if (/\s/.test(c)) { i++; continue; }

    // Corpi SQL di procedure PostgreSQL; il contenuto resta una stringa e non
    // viene eseguito come JavaScript né confuso con le istruzioni esterne.
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))?.[0];
      if (tag) {
        const end = s.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error('Corpo SQL dollar-quoted non chiuso.');
        tokens.push({ type: 'str', value: s.slice(i + tag.length, end) }); i = end + tag.length; continue;
      }
    }

    // Commenti -- fino a fine riga
    if (c === '-' && s[i + 1] === '-') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const fine = s.indexOf('*/', i + 2);
      if (fine < 0) throw new Error('Commento SQL non chiuso.');
      i = fine + 2; continue;
    }

    // Stringhe con ' o " — raddoppio dell'apice per l'escape ('' o "")
    if (c === "'" || c === '"') {
      const quote = c;
      let val = '';
      let chiusa = false;
      i++;
      while (i < n) {
        if (s[i] === quote) {
          if (s[i + 1] === quote) { val += quote; i += 2; continue; }
          i++; chiusa = true; break;
        }
        if (s[i] === '\\' && i + 1 < n) { val += s[i + 1]; i += 2; continue; }
        val += s[i]; i++;
      }
      if (!chiusa) throw new Error('Stringa SQL non chiusa.');
      tokens.push({ type: 'str', value: val });
      continue;
    }

    // Identificatori quotati con backtick o parentesi quadre (`col` / [col])
    const bracketExpression = c === '[' && (arrayDepth > 0 || tokens.at(-1)?.type === 'ident' || [')', ']', '[', '::'].includes(tokens.at(-1)?.value));
    if (c === '`' || c === '[' && !bracketExpression) {
      const close = c === '`' ? '`' : ']';
      let val = '';
      i++;
      let chiuso = false;
      while (i < n) {
        if (s[i] === close) {
          if (s[i + 1] === close) { val += close; i += 2; continue; }
          i++; chiuso = true; break;
        }
        val += s[i++];
      }
      if (!chiuso) throw new Error('Identificatore SQL non chiuso.');
      tokens.push({ type: 'ident', value: val });
      continue;
    }

    // Numeri (con eventuale segno unario + / -). Il segno è parte del numero
    // solo in posizione di operando: non deve seguire un valore (numero,
    // stringa, identificatore o parentesi chiusa), altrimenti sarebbe una
    // sottrazione/addizione, che deve restare un operatore distinto.
    const signed = (c === '-' || c === '+') && /[0-9]/.test(s[i + 1] || '');
    const signedDot = (c === '-' || c === '+') && s[i + 1] === '.' && /[0-9]/.test(s[i + 2] || '');
    const prev = tokens[tokens.length - 1];
    const prevIsValue = prev && (prev.type === 'num' || prev.type === 'str' || prev.type === 'ident' || (prev.type === 'punct' && prev.value === ')'));
    const unarySign = (signed || signedDot) && !prevIsValue;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || '')) || unarySign) {
      let val = '';
      if (unarySign) { val += c; i++; }
      while (i < n && /[0-9.eE+\-]/.test(s[i])) {
        // segno solo dopo e/E (notazione esponenziale)
        if ((s[i] === '+' || s[i] === '-') && !/[eE]/.test(s[i - 1] || '')) break;
        val += s[i]; i++;
      }
      if (!Number.isFinite(Number(val))) throw new Error(`Numero SQL non valido: "${val}".`);
      const precise = val.replace(/[^0-9]/g, '').replace(/^0+/, '').length > 15;
      tokens.push({ type: 'num', value: Number(val), ...(precise ? { exact: val } : {}) });
      continue;
    }

    if(s.substr(i,3)==='-|-'){tokens.push({type:'op',value:'-|-'});i+=3;continue;}
    // Operatori a due caratteri
    const two = s.substr(i, 2);
    if (['>=', '<=', '<>', '!=', '==', '||', ':=', '::', '@>', '<@', '&&', '<<', '>>', '&<', '&>'].includes(two)) {
      tokens.push({ type: 'op', value: two === '==' ? '=' : two });
      i += 2; continue;
    }

    // Operatori a un carattere
    if ('=><+-/%'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++; continue;
    }

    // Punteggiatura
    if ('(),*;[]:'.includes(c)) {
      if (c === '[') arrayDepth++; else if (c === ']') arrayDepth--;
      tokens.push({ type: 'punct', value: c });
      i++; continue;
    }

    // Identificatori / parole chiave
    if (isIdentStart(c)) {
      let val = '';
      while (i < n && isIdentPart(s[i])) { val += s[i]; i++; }
      const up = val.toUpperCase();
      if (KEYWORDS.has(up)) tokens.push({ type: 'kw', value: up });
      else tokens.push({ type: 'ident', value: val });
      continue;
    }

    throw new Error(`Carattere non riconosciuto nella query SQL: "${c}"`);
  }

  return tokens;
}

/* --------------------------------------------------------------------------
 * Parser a discesa ricorsiva
 * ------------------------------------------------------------------------ */

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
    // Risolutore dei nomi di colonna: converte un riferimento qualificato
    // (alias.colonna) nel percorso MQL corretto. Di default è l'identità (nessun
    // JOIN, nessun alias): preserva il comportamento delle query a tabella
    // singola. In presenza di JOIN viene sostituito con un resolver che conosce
    // l'alias della collezione base e quelli delle collezioni unite.
    this.resolve = (name) => name;
  }

  peek(offset = 0) { return this.toks[this.pos + offset] || null; }
  next() { return this.toks[this.pos++] || null; }
  eof() { return this.pos >= this.toks.length; }

  isKw(word) {
    const t = this.peek();
    return t && t.type === 'kw' && t.value === word;
  }
  eatKw(word) {
    if (this.isKw(word)) { this.pos++; return true; }
    return false;
  }
  expectKw(word) {
    if (!this.eatKw(word)) {
      const t = this.peek();
      throw new Error(`Attesa parola chiave "${word}"${t ? `, trovato "${t.value}"` : ' a fine query'}.`);
    }
  }
  isPunct(ch) {
    const t = this.peek();
    return t && t.type === 'punct' && t.value === ch;
  }
  eatPunct(ch) {
    if (this.isPunct(ch)) { this.pos++; return true; }
    return false;
  }
  expectPunct(ch) {
    if (!this.eatPunct(ch)) {
      const t = this.peek();
      throw new Error(`Atteso "${ch}"${t ? `, trovato "${t.value}"` : ' a fine query'}.`);
    }
  }

  // Consuma un gruppo tra parentesi bilanciate a partire dalla '(' corrente e
  // restituisce i token interni (parentesi escluse). Usato per le sotto-query
  // (derived table) nella FROM.
  readParenGroup() {
    if (!this.isPunct('(')) throw new Error('Attesa "(".');
    this.pos++; // salta '('
    const inner = [];
    let depth = 1;
    while (this.pos < this.toks.length) {
      const t = this.toks[this.pos++];
      if (t.type === 'punct' && t.value === '(') depth++;
      else if (t.type === 'punct' && t.value === ')') { depth--; if (depth === 0) return inner; }
      inner.push(t);
    }
    throw new Error('Parentesi non bilanciate nella sotto-query.');
  }

  // Nome di colonna/tabella (identificatore, eventualmente puntato).
  parseIdent() {
    const t = this.peek();
    if (!t || t.type !== 'ident') {
      throw new Error(`Atteso un identificatore${t ? `, trovato "${t.value}"` : ' a fine query'}.`);
    }
    this.pos++;
    return t.value;
  }
}

// Item della SELECT: colonna semplice, funzione aggregata, oppure '*'.
function parseSelectList(p) {
  const items = [];
  const distinct = p.eatKw('DISTINCT');
  do {
    if (p.eatPunct('*')) items.push({ kind: 'star' });
    else items.push(parseSelectItem(p));
  } while (p.eatPunct(','));
  return { distinct, items };
}

function parseSelectItem(p) {
  const expr = leggiEspressione(p);
  const alias = parseOptionalAlias(p);
  if (expr.tipo === 'aggregato') return { kind: 'agg', func: expr.func,
    arg: expr.arg.tipo === 'stella' ? '*' : expr.arg.nome || 'espressione', aggregate: expr, alias };
  return expr.tipo === 'colonna' ? { kind: 'col', name: expr.nome, alias } : { kind: 'expr', expr, alias };
}

function parseOptionalAlias(p) {
  if (p.eatKw('AS')) return p.parseIdent();
  // Alias implicito: un identificatore che segue senza AS (non una keyword).
  const t = p.peek();
  if (t && t.type === 'ident') { p.pos++; return t.value; }
  return null;
}

/* --------------------------------------------------------------------------
 * WHERE → filtro MQL
 * ------------------------------------------------------------------------ */

function parseWhere(p) {
  return filtroEspressione(leggiEspressione(p), p.resolve);
}

function parseValue(p) {
  // Sotto-query scalare: … op (SELECT …). Non traducibile in un singolo $match.
  if (p.isPunct('(') && p.peek(1) && p.peek(1).type === 'kw' && p.peek(1).value === 'SELECT') {
    throw new Error('Le sotto-query scalari "(SELECT ...)" nella WHERE non sono supportate dal traduttore SQL→MQL. Esegui prima la sotto-query o usa una pipeline con $lookup.');
  }
  const t = p.next();
  if (!t) throw new Error('Valore atteso nella clausola WHERE, trovato fine query.');
  if (t.type === 'num') return t.exact ? require('bson').Decimal128.fromString(t.exact) : t.value;
  if (t.type === 'str' || t.type === 'binary') return t.value;
  if (t.type === 'kw') {
    if (t.value === 'TRUE') return true;
    if (t.value === 'FALSE') return false;
    if (t.value === 'NULL') return null;
  }
  // Un identificatore non quotato in posizione di valore è quasi sempre un
  // errore (riferimento a colonna, o stringa dimenticata tra apici): il
  // traduttore non supporta il confronto colonna-colonna, quindi lo rifiuta
  // esplicitamente invece di trattarlo silenziosamente come stringa.
  if (t.type === 'ident') {
    throw new Error(`Valore non valido nella WHERE: "${t.value}". Racchiudi le stringhe tra apici (es. '${t.value}'); il confronto tra due colonne non è supportato.`);
  }
  throw new Error(`Valore non valido nella WHERE: "${t.value}".`);
}

/* --------------------------------------------------------------------------
 * Traduzione complessiva
 * ------------------------------------------------------------------------ */

function translate(sql) {
  const raw = String(sql || '').trim().replace(/;\s*$/, '');
  if (!raw) throw new Error('Query SQL vuota.');

  const tokens = tokenize(raw);
  return translateTokens(tokens);
}

function translateTokens(tokens, ctes = new Map(), outer = null, existence = false) {
  if (tokens[0]?.value === '(') {
    const parenthesized = new Parser(tokens), inner = parenthesized.readParenGroup();
    if (parenthesized.eof()) return translateTokens(inner, ctes, outer, existence);
  }
  const p = new Parser(tokens);
  if (p.eatKw('WITH')) {
    if (p.eatKw('RECURSIVE')) return programmaRicorsivo(p, ctes);
    ctes = new Map(ctes);
    do {
      const nome = p.parseIdent();
      if (ctes.has(nome)) throw new Error(`CTE duplicata: ${nome}.`);
      const colonne = leggiColonneCte(p);
      p.expectKw('AS');
      const piano = rinominaPiano(translateTokens(p.readParenGroup(), ctes, outer), colonne);
      ctes.set(nome, piano);
    } while (p.eatPunct(','));
    tokens = p.toks.slice(p.pos);
  }
  const set = require('./sqlInsiemi').separa(tokens);
  if (set && (set.op !== 'UNION' || tokens.some(t => ['INTERSECT', 'EXCEPT'].includes(t.value)) || tokens[0]?.value === '(')) {
    const result = require('./sqlInsiemi').combina(translateTokens(set.left, ctes, outer), translateTokens(set.right, ctes, outer), set.op, set.all);
    if (!set.tail.length) return result;
    const env = new Map(ctes); env.set('__insieme', result);
    const select = result.columns.flatMap((name, i) => [...(i ? [{ type: 'punct', value: ',' }] : []), { type: 'ident', value: name }]);
    return translateStatement([{ type: 'kw', value: 'SELECT' }, ...select, ...tokenize('FROM __insieme'), ...set.tail], { ctes: env });
  }
  const segments = splitUnions(tokens);

  // Query singola: nessun UNION, nessun limite SQL implicito.
  if (segments.length === 1) {
    return translateStatement(segments[0].tokens, { defaultLimit: null, ctes, outer, existence });
  }

  // UNION [ALL] → $unionWith. Ogni operando è tradotto a pipeline; il primo
  // determina la collezione di partenza, gli altri diventano stadi $unionWith.
  // Senza LIMIT di default: un UNION restituisce tutte le righe (cap dell'engine).
  let depth = 0, tail = [];
  const last = segments.at(-1);
  const end = last.tokens.findIndex(t => {
    if (t.value === '(') depth++;
    if (t.value === ')') depth--;
    return !depth && t.type === 'kw' && ['ORDER', 'LIMIT', 'OFFSET'].includes(t.value);
  });
  if (end >= 0) { tail = last.tokens.slice(end); last.tokens = last.tokens.slice(0, end); }
  const first = translateStatement(segments[0].tokens, { defaultLimit: null, ctes, outer });
  const pipeline = planToPipeline(first);

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const plan = rinominaPiano(translateTokens(seg.tokens, ctes, outer), first.columns);
    pipeline.push({ $unionWith: { ...(plan.coll ? { coll: plan.coll } : {}), pipeline: planToPipeline(plan) } });
    if (!seg.all) pipeline.push({ $group: { _id: '$$ROOT' } }, { $replaceRoot: { newRoot: '$_id' } });
  }

  // Ogni UNION DISTINCT deduplica il risultato fino a quel punto; una UNION
  // ALL successiva può quindi aggiungere nuovamente righe uguali.
  const result = { kind: 'aggregate', coll: first.coll, pipeline, columns: first.columns };
  if (tail.length) {
    const env = new Map(ctes); env.set('__unione', result);
    const sorted = translateStatement([...tokenize('SELECT * FROM __unione'), ...tail], { ctes: env });
    sorted.columns = first.columns;
    return sorted;
  }
  return result;
}

function leggiColonneCte(p) {
  if (!p.eatPunct('(')) return null;
  const colonne = [];
  do { colonne.push(p.parseIdent()); } while (p.eatPunct(','));
  p.expectPunct(')');
  if (new Set(colonne).size !== colonne.length) throw new Error('Nomi di colonna duplicati nella CTE.');
  return colonne;
}

function rinominaPiano(plan, columns) {
  if (!columns) return plan;
  if (!plan.columns || columns.length !== plan.columns.length) throw new Error('Il numero di colonne della CTE o UNION non coincide con la SELECT. Elenca esplicitamente le colonne.');
  if (columns.every((n, i) => n === plan.columns[i])) return plan;
  return { kind: 'aggregate', coll: plan.coll, columns, pipeline: [...planToPipeline(plan),
    { $replaceWith: Object.fromEntries(columns.map((n, i) => [n, { $ifNull: [`$${plan.columns[i]}`, null] }])) }] };
}

function programmaRicorsivo(p, inherited) {
  const definitions = [], names = new Set(inherited.keys());
  do {
    const name = p.parseIdent();
    if (names.has(name)) throw new Error(`CTE duplicata: ${name}.`);
    names.add(name);
    const columns = leggiColonneCte(p);
    p.expectKw('AS');
    const tokens = p.readParenGroup(), segments = splitUnions(tokens);
    const refers = ts => ts.some((t, i) => ['FROM', 'JOIN'].includes(t.value) && ts[i + 1]?.value === name);
    const recursive = refers(tokens);
    if (recursive && (segments.length !== 2 || refers(segments[0].tokens) || !refers(segments[1].tokens))) {
      throw new Error(`La CTE ricorsiva ${name} richiede un termine iniziale UNION [ALL] un termine ricorsivo.`);
    }
    definitions.push({ name, columns, seed: recursive ? segments[0].tokens : tokens,
      step: recursive ? segments[1].tokens : null, all: recursive && segments[1].all });
  } while (p.eatPunct(','));
  return { kind: 'program', definitions, inherited, query: p.toks.slice(p.pos) };
}

function pianoDocumenti(docs, columns) {
  return { kind: 'aggregate', coll: null, columns, pipeline: [{ $documents: { $literal: docs } }] };
}

// La stessa compilazione anticipata è usata dal guard e dall'esecutore: tutte
// le sorgenti e gli errori sintattici sono noti prima della prima lettura.
function analizzaProgramma(program) {
  const env = new Map(program.inherited), plans = [], definitions = [];
  for (const [index, d] of program.definitions.entries()) {
    const future = new Set(program.definitions.slice(index + 1).map(x => x.name));
    for (const tokens of [d.seed, d.step || []]) if (tokens.some((t, i) => ['FROM', 'JOIN'].includes(t.value) && future.has(tokens[i + 1]?.value))) {
      throw new Error('Una CTE deve essere dichiarata prima delle CTE che la usano; la ricorsione mutua non è supportata.');
    }
    const seed = rinominaPiano(translateTokens(d.seed, env), d.columns);
    if (seed.kind === 'program') throw new Error('WITH RECURSIVE annidato non ammesso: dichiara le CTE nello stesso WITH.');
    const columns = seed.columns;
    if (d.step && (!columns || !columns.length || new Set(columns).size !== columns.length)) throw new Error('La CTE ricorsiva richiede colonne di output esplicite e distinte.');
    plans.push(seed);
    env.set(d.name, pianoDocumenti([], columns));
    if (d.step) plans.push(rinominaPiano(translateTokens(d.step, env), columns));
    definitions.push({ ...d, columns });
  }
  plans.push(translateTokens(program.query, env));
  return { definitions, plans };
}

// Divide il flusso di token nelle SELECT separate da UNION [ALL] a livello 0
// (fuori da qualsiasi parentesi). Ritorna [{ tokens, all }], dove `all` indica se
// la UNION che precede quel segmento era una UNION ALL.
function splitUnions(tokens) {
  const segments = [];
  let depth = 0;
  let start = 0;
  let pendingAll = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (depth === 0 && t.type === 'kw' && t.value === 'UNION') {
      segments.push({ tokens: tokens.slice(start, i), all: pendingAll });
      const all = tokens[i + 1] && tokens[i + 1].type === 'kw' && tokens[i + 1].value === 'ALL';
      pendingAll = !!all;
      start = i + 1 + (all ? 1 : 0);
      i = start - 1;
    }
  }
  segments.push({ tokens: tokens.slice(start), all: pendingAll });
  return segments;
}

// Converte un piano (find o aggregate) nella pipeline equivalente, usata per gli
// operandi di UNION e per comporre gli stadi $unionWith.
function planToPipeline(plan) {
  if (plan.kind === 'program') throw new Error('Una CTE ricorsiva deve essere dichiarata nel WITH principale.');
  if (plan.kind === 'aggregate') return [...plan.pipeline];
  const pl = [];
  if (plan.filter && Object.keys(plan.filter).length) pl.push({ $match: plan.filter });
  if (plan.sort && Object.keys(plan.sort).length) pl.push({ $sort: plan.sort });
  if (plan.skip) pl.push({ $skip: plan.skip });
  if (plan.limit != null) pl.push(plan.limit === 0 ? { $match: { $expr: false } } : { $limit: plan.limit });
  if (plan.projection && Object.keys(plan.projection).length) pl.push({ $project: plan.projection });
  return pl;
}

// Traduce una singola SELECT (senza UNION) nel piano find/aggregate.
function translateStatement(tokens, { defaultLimit = null, ctes = new Map(), outer = null, existence = false } = {}) {
  const p = new Parser(tokens);

  if (!p.eatKw('SELECT')) {
    const t = p.peek();
    const w = t ? String(t.value).toUpperCase() : '';
    if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE'].includes(w)) {
      throw new Error('Solo le query SELECT sono traducibili in MongoDB. Per le scritture usa la vista Dati o una pipeline $out/$merge.');
    }
    throw new Error('La query SQL deve iniziare con SELECT.');
  }

  const { distinct, items: select } = parseSelectList(p);
  const hasFrom = p.eatKw('FROM');

  // FROM ( SELECT … ) [AS] alias  →  la sotto-query (derived table) diventa il
  // prefisso della pipeline; le clausole esterne le si applicano sopra.
  let coll;
  let baseAlias;
  let fromPipeline = null;
  if (!hasFrom) {
    if (select.some(it => it.kind === 'star')) throw new Error('SELECT * richiede FROM.');
    coll = null;
    fromPipeline = [{ $documents: [{}] }];
  } else if (p.isPunct('(')) {
    const innerTokens = p.readParenGroup();
    const innerPlan = translateTokens(innerTokens, ctes, outer);
    fromPipeline = planToPipeline(innerPlan);
    coll = innerPlan.coll;
    baseAlias = parseTableAlias(p);
  } else {
    coll = p.parseIdent();
    baseAlias = parseTableAlias(p);
    if (ctes.has(coll)) {
      const cte = ctes.get(coll);
      baseAlias ||= coll;
      fromPipeline = planToPipeline(cte);
      coll = cte.coll;
    }
  }

  // JOIN … ON  →  $lookup + $unwind. Le collezioni unite prendono il proprio
  // alias come campo di destinazione (`as`), così i riferimenti "alias.colonna"
  // corrispondono già al percorso MQL annidato.
  const joins = parseJoins(p, ctes);

  // Resolver dei nomi qualificati: attivo solo se c'è almeno un JOIN (in
  // presenza di soli alias di tabella senza JOIN si comporta comunque bene).
  const hasJoins = joins.length > 0;
  const joinAliases = new Set(joins.map((j) => j.alias));
  const local = makeResolver(baseAlias, coll, joinAliases, joins);
  const scope = { aliases: new Set([baseAlias || coll, ...joinAliases].filter(Boolean)), outer };
  p.resolve = name => outer?.has(name) && !scope.aliases.has(name.split('.')[0]) ? outer.resolve(name) : local(name);
  p.resolve.using = local.using;

  const where = p.eatKw('WHERE') ? leggiEspressione(p) : null;
  const { contieneSottoquery } = require('./sqlSottoquery');
  const filter = where && !contieneSottoquery(where) ? filtroEspressione(where, p.resolve) : null;

  const groupBy = [];
  if (p.eatKw('GROUP')) {
    p.expectKw('BY');
    do { groupBy.push(leggiEspressione(p)); } while (p.eatPunct(','));
  }

  let having = null;
  if (p.eatKw('HAVING')) {
    having = leggiEspressione(p);
  }

  const namedWindows = new Map();
  if (p.eatKw('WINDOW')) do {
    const name = p.parseIdent();
    if (namedWindows.has(name)) throw new Error(`Finestra duplicata: ${name}.`);
    p.expectKw('AS');
    namedWindows.set(name, require('./sqlFinestre').leggiSpecifica(p));
  } while (p.eatPunct(','));
  risolviFinestre(select, namedWindows);

  const orderBy = [];
  if (p.eatKw('ORDER')) {
    p.expectKw('BY');
    do {
      const expr = leggiEspressione(p);
      const ordinal = expr.tipo === 'valore' && Number.isInteger(expr.valore);
      if (ordinal && (expr.valore < 1 || expr.valore > select.length || select.some(it => it.kind === 'star'))) throw new Error('Posizione ORDER BY fuori dalla proiezione esplicita.');
      const field = ordinal ? nomeColonna(select[expr.valore - 1], expr.valore - 1) : expr.tipo === 'colonna' ? expr.nome : null;
      let dir = 1;
      if (p.eatKw('DESC')) dir = -1;
      else p.eatKw('ASC');
      let nulls = null;
      if (p.eatKw('NULLS')) { if (p.eatKw('FIRST')) nulls = 'first'; else { p.expectKw('LAST'); nulls = 'last'; } }
      orderBy.push({ field, dir, ...(field ? {} : { expr }), ...(nulls ? { nulls } : {}) });
    } while (p.eatPunct(','));
  }

  let limit = null;
  risolviFinestre(orderBy.map(o => ({ expr: o.expr })), namedWindows);
  let skip = 0;
  if (p.eatKw('LIMIT')) {
    const a = expectNumber(p, 'LIMIT');
    if (p.eatPunct(',')) {
      // LIMIT offset, count  (stile MySQL)
      skip = a;
      limit = expectNumber(p, 'LIMIT');
    } else {
      limit = a;
    }
  }
  if (p.eatKw('OFFSET')) {
    skip = expectNumber(p, 'OFFSET');
  }

  if (!p.eof()) {
    const t = p.peek();
    throw new Error(`Token inatteso a fine query: "${t.value}".`);
  }

  const hasAgg = select.some((it) => it.kind === 'agg' || require('./sqlRaggruppamenti').haAggregato(it.expr)) || require('./sqlRaggruppamenti').haAggregato(having) || orderBy.some(o => require('./sqlRaggruppamenti').haAggregato(o.expr));
  if (existence && !skip) {
    // EXISTS richiede la cardinalità, non i valori della proiezione. Mantiene
    // il gruppo globale anche su input vuoto ed evita errori in SELECT 1/0.
    for (let i = 0; i < groupBy.length; i++) {
      const g = groupBy[i];
      const item = g.tipo === 'valore' && Number.isInteger(g.valore) ? select[g.valore - 1]
        : g.tipo === 'colonna' ? select.find(it => it.alias === g.nome) : null;
      if (item) groupBy[i] = item.expr || item.aggregate || { tipo: 'colonna', nome: item.name };
    }
    if (!having) {
      select.splice(0, select.length, hasAgg ? { kind: 'agg', func: 'COUNT', arg: '*', alias: 'esiste' }
        : { kind: 'expr', expr: { tipo: 'valore', valore: 1 }, alias: 'esiste' });
      orderBy.length = 0;
    }
  }
  const hasExpr = select.some(it => it.kind === 'expr');
  const postDistinct = distinct && (hasAgg || groupBy.length > 0 || hasExpr || select.some(it => it.kind === 'star'));

  // SELECT DISTINCT senza GROUP BY / aggregati → raggruppa su tutte le colonne
  // proiettate (equivalente semantico del DISTINCT SQL).
  let effectiveGroupBy = groupBy;
  if (distinct && !postDistinct) {
    effectiveGroupBy = select.map((it) => it.name);
  }

  const useAggregate = hasAgg || hasExpr || postDistinct || effectiveGroupBy.length > 0 || hasJoins || !!fromPipeline || select.some(it => it.alias) || orderBy.length > 0 || contieneSottoquery(where) || !!outer;

  if (having && !(hasAgg || effectiveGroupBy.length > 0)) {
    throw new Error('HAVING richiede GROUP BY o una funzione aggregata.');
  }

  if (!useAggregate) {
    return { ...buildFind({ coll, select, filter, orderBy, limit: limit != null ? limit : defaultLimit, skip, resolve: p.resolve }),
      columns: select.some(it => it.kind === 'star') ? null : select.map(nomeColonna) };
  }
  const result = buildAggregate({ coll, select, where, groupBy: effectiveGroupBy,
    orderBy: postDistinct ? [] : orderBy, limit: postDistinct ? null : limit, skip: postDistinct ? 0 : skip,
    joins, having, prefix: fromPipeline, resolve: p.resolve, scope, ctes });
  if (postDistinct) {
    result.pipeline.push({ $group: { _id: '$$ROOT' } }, { $replaceRoot: { newRoot: '$_id' } });
    const ordini = orderBy.map(o => {
      const index = select.findIndex(it => o.expr ? JSON.stringify(it.expr || it.aggregate) === JSON.stringify(o.expr) : it.name === o.field);
      return index < 0 ? o : { ...o, expr: null, field: nomeColonna(select[index], index) };
    });
    result.pipeline = buildAggregate({ coll, select: [{ kind: 'star' }], groupBy: [], orderBy: ordini, skip, limit,
      prefix: result.pipeline }).pipeline;
  }
  result.columns = select.some(it => it.kind === 'star') ? null : select.map(nomeColonna);
  return result;
}

// Alias di tabella dopo FROM / JOIN: "coll alias" oppure "coll AS alias".
// Restituisce la stringa alias o null. Non consuma le parole chiave (JOIN,
// WHERE, ON, ...), quindi è sicuro anche senza alias esplicito.
function parseTableAlias(p) {
  if (p.eatKw('AS')) return p.parseIdent();
  const t = p.peek();
  if (t && t.type === 'ident') { p.pos++; return t.value; }
  return null;
}

// Analizza JOIN interne, esterne e cartesiane, anche su sorgenti derivate.
function parseJoins(p, ctes = new Map()) {
  const joins = [];
  for (;;) {
    let type = 'inner';
    if (p.eatKw('INNER')) {
      type = 'inner';
    } else if (p.eatKw('LEFT')) {
      p.eatKw('OUTER');
      type = 'left';
    } else if (p.isKw('RIGHT') || p.isKw('FULL')) {
      type = p.next().value.toLowerCase();
      p.eatKw('OUTER');
    } else if (p.eatKw('CROSS')) {
      type = 'cross';
    } else if (!p.isKw('JOIN')) {
      break; // nessun'altra JOIN
    }
    p.expectKw('JOIN');

    let coll, cte;
    if (p.isPunct('(')) {
      cte = translateTokens(p.readParenGroup(), ctes);
      coll = cte.coll;
    } else { coll = p.parseIdent(); cte = ctes.get(coll); }
    const alias = parseTableAlias(p) || coll;
    if (type === 'cross') {
      joins.push({ type, coll: cte ? cte.coll : coll, alias, pipeline: cte ? planToPipeline(cte) : [] });
      continue;
    }

    if (p.isKw('USING')) {
      p.next(); p.expectPunct('(');
      const colonne = [];
      do { colonne.push(p.parseIdent()); } while (p.eatPunct(','));
      p.expectPunct(')');
      const condizioni = colonne.map(nome => ({ tipo: 'binaria', op: '=', a: { tipo: 'colonna', nome }, b: { tipo: 'colonna', nome: `${alias}.${nome}` } }));
      joins.push({ type, coll: cte ? cte.coll : coll, alias, using: colonne, pipeline: cte ? planToPipeline(cte) : [],
        condizione: condizioni.reduce((a, b) => ({ tipo: 'binaria', op: 'AND', a, b })) });
      continue;
    }
    p.expectKw('ON');
    const condizione = leggiEspressione(p);
    if (condizione.tipo !== 'binaria' || condizione.op !== '=' || condizione.a.tipo !== 'colonna' || condizione.b.tipo !== 'colonna'
        || condizione.a.nome.startsWith(`${alias}.`) === condizione.b.nome.startsWith(`${alias}.`)) {
      joins.push({ type, coll: cte ? cte.coll : coll, alias, pipeline: cte ? planToPipeline(cte) : [], condizione });
      continue;
    }
    const left = condizione.a.nome, right = condizione.b.nome;
    joins.push({ type, coll: cte ? cte.coll : coll, alias, left, right, ...(cte ? { pipeline: planToPipeline(cte) } : {}) });
  }
  return joins;
}

// Costruisce il risolutore dei nomi qualificati. La collezione base ha i campi
// alla radice (alias.campo → campo); ogni collezione unita è annidata sotto il
// proprio alias (usato come `as` del $lookup), quindi alias.campo è già il
// percorso MQL corretto e va lasciato intatto. I nomi non qualificati e i
// percorsi annidati della base (es. address.city) restano invariati.
function makeResolver(baseAlias, baseColl, joinAliases, joins = []) {
  const using = joins.some(j => ['right', 'full'].includes(j.type) && j.using)
    ? [...new Set(joins.flatMap(j => j.using || []))] : [];
  const resolve = function resolve(name) {
    const dot = name.indexOf('.');
    if (dot < 0) return using.length && !using.includes(name) ? `originebase.${name}` : name;
    const qualifier = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    if (qualifier === baseAlias || (!baseAlias && qualifier === baseColl)) return using.length ? `originebase.${rest}` : rest;
    if (joinAliases.has(qualifier)) return name;
    return using.length ? `originebase.${name}` : name;
  };
  resolve.using = using;
  return resolve;
}

// Ultimo segmento di un nome qualificato: "t.col" → "col", "col" → "col".
// È il nome di output predefinito di una colonna proiettata (come in SQL).
function lastSegment(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}

// Stadi $lookup + $unwind per l'elenco di JOIN. Le condizioni ON usano il
// resolver corrente: il lato che appartiene alla collezione appena unita diventa
// foreignField (spogliato dell'alias), l'altro diventa localField (risolto sul
// percorso già disponibile, base o join precedente).
function buildJoinStages(joins, resolve, coll, prefix = []) {
  const stages = [];
  for (const j of joins) {
    if (j.type === 'right' || j.type === 'full') {
      // Il ramo anti-join parte dalla destra e cerca nell'intera relazione
      // sinistra già costruita: conserva filtri delle CTE e JOIN precedenti.
      const sinistra = [...prefix, ...stages];
      stages.push(...buildJoinStages([{ ...j, type: j.type === 'full' ? 'left' : 'inner' }], resolve, coll));
      const on = j.condizione || { tipo: 'binaria', op: '=', a: { tipo: 'colonna', nome: j.left }, b: { tipo: 'colonna', nome: j.right } };
      const condizione = emettiEspressione(on, nome => nome.startsWith(`${j.alias}.`)
        ? `$destra.${nome.slice(j.alias.length + 1)}` : resolve(nome));
      const destra = { [j.alias]: '$$ROOT' };
      for (const nome of j.using || []) destra[nome] = { $ifNull: [`$${nome}`, null] };
      stages.push({ $unionWith: { ...(j.coll ? { coll: j.coll } : {}), pipeline: [
        ...(j.pipeline || []),
        { $replaceWith: { riga: '$$ROOT' } },
        { $lookup: { ...(coll ? { from: coll } : {}), let: { destra: '$riga' },
          pipeline: [...sinistra, { $match: { $expr: condizione } }, { $limit: 1 }], as: 'corrispondenze' } },
        { $match: { corrispondenze: { $size: 0 } } },
        { $replaceWith: '$riga' }, { $replaceWith: destra },
      ] } });
      continue;
    }
    if (j.type === 'cross') {
      stages.push({ $lookup: { ...(j.coll ? { from: j.coll } : {}), pipeline: j.pipeline, as: j.alias } }, { $unwind: `$${j.alias}` });
      continue;
    }
    if (j.condizione) {
      const variabili = {};
      const condizione = emettiEspressione(j.condizione, nome => {
        if (nome.startsWith(`${j.alias}.`)) return nome.slice(j.alias.length + 1);
        const key = `campo${Object.keys(variabili).length}`;
        variabili[key] = `$${resolve(nome)}`;
        return `$${key}`;
      });
      stages.push({ $lookup: { ...(j.coll ? { from: j.coll } : {}), let: variabili, pipeline: [...j.pipeline, { $match: { $expr: condizione } }], as: j.alias } });
      stages.push({ $unwind: j.type === 'left' ? { path: `$${j.alias}`, preserveNullAndEmptyArrays: true } : `$${j.alias}` });
      continue;
    }
    const belongsToNew = (name) => {
      const dot = name.indexOf('.');
      return dot >= 0 && name.slice(0, dot) === j.alias;
    };
    let foreignRaw;
    let localRaw;
    if (belongsToNew(j.left) && !belongsToNew(j.right)) {
      foreignRaw = j.left; localRaw = j.right;
    } else if (belongsToNew(j.right) && !belongsToNew(j.left)) {
      foreignRaw = j.right; localRaw = j.left;
    } else {
      throw new Error(`La condizione ON di "${j.alias}" deve confrontare una colonna della tabella "${j.alias}" con una colonna di un'altra tabella (es. ${j.alias}.id = base.${j.alias}_id).`);
    }
    const foreignField = foreignRaw.slice(j.alias.length + 1);
    const localField = resolve(localRaw);
    {
      stages.push({ $lookup: { ...(j.coll ? { from: j.coll } : {}), let: { chiave: `$${localField}` }, pipeline: [
        ...(j.pipeline || []),
        { $match: { $expr: { $and: [{ $ne: [{ $ifNull: ['$$chiave', null] }, null] }, { $eq: [`$${foreignField}`, '$$chiave'] }] } } },
      ], as: j.alias } });
    }
    if (j.type === 'left') {
      stages.push({ $unwind: { path: `$${j.alias}`, preserveNullAndEmptyArrays: true } });
    } else {
      stages.push({ $unwind: `$${j.alias}` });
    }
  }
  return stages;
}

function expectNumber(p, ctx) {
  const t = p.next();
  if (!t || t.type !== 'num' || !Number.isFinite(t.value)) {
    throw new Error(`Numero atteso dopo ${ctx}${t ? `, trovato "${t.value}"` : ''}.`);
  }
  // LIMIT/OFFSET devono essere interi non negativi: un valore negativo darebbe
  // un $limit/$skip invalido a runtime (aggregate) o un clamp silenzioso (find).
  if (t.value < 0) {
    throw new Error(`${ctx} non può essere negativo (trovato ${t.value}).`);
  }
  return Math.trunc(t.value);
}

function buildFind({ coll, select, filter, orderBy, limit, skip, resolve = (x) => x }) {
  const projection = {};
  const isStar = select.some((it) => it.kind === 'star');
  if (!isStar) {
    let selectsId = false;
    for (const it of select) {
      const name = resolve(it.name);
      projection[name] = 1;
      if (name === '_id') selectsId = true;
    }
    // In SQL "SELECT col" non porta la chiave primaria: escludi _id se non richiesto.
    if (!selectsId) projection._id = 0;
  }

  const sort = {};
  for (const o of orderBy) sort[resolve(o.field)] = o.dir;

  return {
    kind: 'find',
    coll,
    filter: filter || {},
    projection,
    sort,
    // Solo un LIMIT scritto nella query restringe il risultato.
    limit: limit != null ? limit : null,
    skip: skip || 0,
  };
}

// Nome di output per un item aggregato (alias esplicito o nome derivato). Per un
// argomento qualificato (t.col) usa solo l'ultimo segmento, così il nome del
// campo di output non contiene punti.
function aggFieldName(it) {
  if (it.alias) return it.alias;
  if (it.func === 'COUNT' && it.arg === '*') return 'count';
  return `${it.func.toLowerCase()}_${lastSegment(it.arg)}`;
}

// Aggiunge $sort / $skip / $limit finali comuni a find e aggregate.
function pushSortSkipLimit(pipeline, orderBy, skip, limit) {
  if (orderBy.length) {
    pipeline.push({ $replaceWith: { originale: '$$ROOT', chiavi: Object.fromEntries(orderBy.map((o, i) =>
      [`k${i}`, require('./sqlOrdinamentoMongo').chiave(`$${o.field}`)])), nulli: Object.fromEntries(orderBy.map((o, i) =>
      [`n${i}`, { $eq: [{ $ifNull: [`$${o.field}`, null] }, null] }])) } });
    const sort = {};
    for (const [i, o] of orderBy.entries()) {
      if (o.nulls) sort[`nulli.n${i}`] = o.nulls === 'first' ? -1 : 1;
      sort[`chiavi.k${i}`] = o.dir;
    }
    pipeline.push({ $sort: sort });
  }
  if (skip) pipeline.push({ $skip: skip });
  if (limit != null) pipeline.push(limit === 0 ? { $match: { $expr: false } } : { $limit: limit });
  if (orderBy.length) pipeline.push({ $replaceWith: '$originale' });
}

// Ordine delle fasi SQL: sorgenti, WHERE, gruppi/HAVING, finestre e proiezione.
function buildAggregate({ coll, select, filter, where = null, groupBy, orderBy, limit, skip, joins = [], having = null, prefix = null, resolve = (x) => x, scope = { aliases: new Set() }, ctes = new Map() }) {
  const pipeline = [];
  // Sotto-query nella FROM (derived table): la sua pipeline apre tutto.
  if (prefix && prefix.length) pipeline.push(...prefix);
  if (resolve.using?.length) pipeline.push({ $replaceWith: { originebase: '$$ROOT',
    ...Object.fromEntries(resolve.using.map(n => [n, { $ifNull: [`$${n}`, null] }])) } });
  // I JOIN vanno per primi: WHERE e GROUP BY possono riferirsi ai campi uniti.
  if (joins.length) pipeline.push(...buildJoinStages(joins, resolve, coll, [...pipeline]));
  const { espandiSottoquery } = require('./sqlSottoquery');
  const prima = [where, ...groupBy.filter(g => typeof g === 'object')];
  const argomentiAggregati = e => {
    if (!e || typeof e !== 'object' || e.tipo === 'sottoquery') return;
    if (e.tipo === 'aggregato') { prima.push(e.arg, e.filter); return; }
    Object.values(e).forEach(argomentiAggregati);
  };
  [...select, having, ...orderBy].forEach(argomentiAggregati);
  resolve = espandiSottoquery(prima, pipeline, resolve, scope, ctes);
  if (where) filter = filtroEspressione(where, resolve);
  if (filter && Object.keys(filter).length) pipeline.push({ $match: filter });

  const grouped = require('./sqlRaggruppamenti').raggruppa({ select, groupBy, having, orderBy, resolve, nomeColonna });
  if (grouped) return buildAggregate({ coll, ...grouped, filter: null, groupBy: [], limit, skip,
    prefix: [...pipeline, ...grouped.pipeline], ctes, scope: { ...scope, correlated: grouped.resolveCorrelated } });
  resolve = espandiSottoquery([...select, ...orderBy], pipeline, resolve, scope, ctes);
  const finestre = [];
  const visita = e => {
    if (!e || typeof e !== 'object') return;
    if (e.tipo === 'finestra') {
      e.indice = finestre.length;
      finestre.push(e);
      return;
    }
    Object.values(e).forEach(v => Array.isArray(v) ? v.forEach(visita) : visita(v));
  };
  select.forEach(it => visita(it.expr));
  orderBy.forEach(o => visita(o.expr));
  if (finestre.length) {
    pipeline.push(...require('./sqlFinestre').stadiFinestre(finestre, resolve));
    const valori = {};
    for (const [i, it] of select.entries()) {
      if (it.kind === 'star') continue;
      const nome = nomeColonna(it, i);
      valori[nome] = it.kind === 'expr' ? emettiEspressione(it.expr, prefissa(resolve, 'origine.'))
        : { $ifNull: [`$origine.${it.kind === 'agg' ? aggFieldName(it) : resolve(it.name)}`, null] };
    }
    const fonte = resolve.root ? `$origine.${resolve.root.slice(1)}` : '$origine';
    const sorgente = resolve.using?.length || resolve.flattenUsing ? appiattisciUsing(fonte) : fonte;
    pipeline.push({ $set: { valori: select.some(it => it.kind === 'star') ? { $mergeObjects: [sorgente, valori] } : valori,
      ordini: Object.fromEntries(orderBy.map((o, i) => [`o${i}`, o.expr ? emettiEspressione(o.expr, prefissa(resolve, 'origine.')) : null])) } });
    pushSortSkipLimit(pipeline, orderBy.map((o, i) => ({ ...o, field: o.expr ? `ordini.o${i}` : Object.hasOwn(valori, o.field) ? `valori.${o.field}` : `origine.${resolve(o.field)}` })), skip, limit);
    pipeline.push({ $replaceWith: '$valori' });
    return { kind: 'aggregate', coll, pipeline };
  }

  // JOIN senza aggregazione: proiezione semplice (o passthrough per SELECT *).
  {
    if (select.some(it => it.kind === 'expr') || orderBy.some(o => o.expr) || (select.some(it => it.kind === 'star') && select.length > 1)) {
      const valori = {};
      for (const [i, it] of select.entries()) {
        if (it.kind === 'star') continue;
        const nome = it.alias || (it.name && lastSegment(it.name)) || it.expr?.nome?.toLowerCase() || `espressione_${i + 1}`;
        valori[nome] = { $ifNull: [it.kind === 'expr' ? emettiEspressione(it.expr, resolve) : `$${resolve(it.name)}`, null] };
      }
      // L'involucro evita che un alias calcolato sovrascriva un campo sorgente
      // ancora necessario alla proiezione o all'ordinamento.
      const sorgente = resolve.flattenUsing ? appiattisciUsing(resolve.root) : resolve.using?.length ? appiattisciUsing() : resolve.root || '$$ROOT';
      pipeline.push({ $replaceWith: { origine: '$$ROOT', valori: select.some(it => it.kind === 'star') ? { $mergeObjects: [sorgente, valori] } : valori,
        ordini: Object.fromEntries(orderBy.map((o, i) => [`o${i}`, o.expr ? emettiEspressione(o.expr, resolve) : null])) } });
      const ordine = orderBy.map((o, i) => ({ ...o, field: o.expr ? `ordini.o${i}` : Object.hasOwn(valori, o.field) ? `valori.${o.field}` : `origine.${resolve(o.field)}` }));
      pushSortSkipLimit(pipeline, ordine, skip, limit);
      pipeline.push({ $replaceWith: '$valori' });
      return { kind: 'aggregate', coll, pipeline };
    }
    const isStar = select.some((it) => it.kind === 'star');
    // Ordina sui campi sorgente prima della proiezione, risolvendo gli alias.
    const ordine = orderBy.map(o => ({ ...o, field: resolve(select.find(it => it.alias === o.field)?.name || o.field) }));
    pushSortSkipLimit(pipeline, ordine, skip, limit);
    if (!isStar) {
      const projectStage = { _id: 0 };
      for (const it of select) {
        const path = resolve(it.name);
        const out = it.alias || lastSegment(it.name);
        projectStage[out] = joins.some(j => ['left', 'right', 'full'].includes(j.type)) ? { $ifNull: [`$${path}`, null] } : `$${path}`;
      }
      pipeline.push({ $project: projectStage });
    } else if (resolve.using?.length || resolve.root) {
      pipeline.push({ $replaceWith: resolve.flattenUsing ? appiattisciUsing(resolve.root) : resolve.root || appiattisciUsing() });
    }
    return { kind: 'aggregate', coll, pipeline };
  }

}

function contieneFinestra(e) {
  return !!e && typeof e === 'object' && (e.tipo === 'finestra' || Object.values(e).some(v => Array.isArray(v) ? v.some(contieneFinestra) : contieneFinestra(v)));
}

function appiattisciUsing(root = '$$ROOT') {
  return { $mergeObjects: [root === '$$ROOT' ? '$originebase' : `${root}.originebase`, { $arrayToObject: {
    $filter: { input: { $objectToArray: root }, as: 'campo', cond: { $ne: ['$$campo.k', 'originebase'] } },
  } }] };
}

function risolviFinestre(items, named) {
  const risolvi = (w, seen = new Set()) => {
    if (!w.riferimento) return { partition: [], order: [], frame: null, ...w };
    if (seen.has(w.riferimento)) throw new Error('Riferimento circolare fra finestre SQL.');
    seen.add(w.riferimento);
    const base = named.get(w.riferimento);
    if (!base) throw new Error(`Finestra non definita: ${w.riferimento}.`);
    const parent = risolvi(base, seen);
    if (w.partition?.length || (w.order?.length && parent.order.length) || (w.frame && parent.frame)) throw new Error('La finestra derivata non può sovrascrivere PARTITION, ORDER o il frame ereditati.');
    return { ...parent, ...w, riferimento: null, partition: parent.partition,
      order: w.order?.length ? w.order : parent.order, frame: w.frame || parent.frame };
  };
  for (const def of named.values()) risolvi(def);
  const visita = e => {
    if (!e || typeof e !== 'object') return;
    if (e.tipo === 'finestra') {
      Object.assign(e, risolvi(e));
      if (e.frame?.tipo === 'RANGE' && [e.frame.lo, e.frame.hi].some(n => Number.isFinite(n) && n !== 0) && e.order.length !== 1) throw new Error('RANGE con offset richiede una sola chiave numerica di ordinamento.');
      return;
    }
    Object.values(e).forEach(v => Array.isArray(v) ? v.forEach(visita) : visita(v));
  };
  items.forEach(it => visita(it.expr));
}

function nomeColonna(it, i) {
  return it.alias || (it.kind === 'agg' ? aggFieldName(it) : it.name && lastSegment(it.name)) || it.expr?.nome?.toLowerCase() || it.expr?.func?.toLowerCase() || `espressione_${i + 1}`;
}

// Euristica: la stringa sembra una query SQL (SELECT ... FROM ...)?
function looksLikeSql(code) {
  return /^\s*\(*\s*(SELECT|WITH)\b/i.test(String(code || ''));
}

/* ==========================================================================
 * SQL di SCRITTURA e DDL su MongoDB
 *
 * "SQL anche per i database Mongo" non può fermarsi alle SELECT: chi scrive
 * `INSERT INTO` o `CREATE TABLE` si aspetta che funzioni. La traduzione è
 * diretta per le collezioni libere; le tabelle CREATE TABLE hanno invece
 * schema, vincoli nativi e migrazioni ALTER TABLE. Il runtime SQL e le
 * scritture dello script attraversano il Proxy autorizzante e condividono
 * i controlli referenziali. Clausole e tipi non tradotti vengono rifiutati.
 * ========================================================================== */

// Le keyword di scrittura non stanno in KEYWORDS (il tokenizer le marca come
// identificatori): aggiungerle cambierebbe il parsing delle SELECT, dove una
// colonna può benissimo chiamarsi "set" o "values". Si confrontano quindi a
// mano, senza distinzione fra maiuscole e minuscole.
function isWord(p, parola, offset = 0) {
  const t = p.peek(offset);
  return !!t && (t.type === 'ident' || t.type === 'kw') && String(t.value).toUpperCase() === parola;
}

function eatWord(p, parola) {
  if (isWord(p, parola)) { p.pos++; return true; }
  return false;
}

function expectWord(p, parola) {
  if (!eatWord(p, parola)) {
    const t = p.peek();
    throw new Error(`Attesa parola chiave "${parola}"${t ? `, trovato "${t.value}"` : ' a fine comando'}.`);
  }
}

/** Il testo è un comando SQL di scrittura o DDL (non una SELECT)? */
function looksLikeSqlWrite(code) {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|TRUNCATE|ALTER)\b/i.test(String(code || ''));
}

/**
 * Traduce un comando SQL di scrittura/DDL in un'operazione MongoDB.
 *
 * @returns {{kind:'write'|'ddl', op:string, coll?:string, db?:string, docs?:object[], filter?:object, update?:object, note?:string}}
 */
function translateWrite(sql) {
  const p = new Parser(tokenize(String(sql).trim().replace(/;\s*$/, '')));
  const completo = piano => {
    if (piano.kind === 'write' && ['insertOne', 'insertMany'].includes(piano.op) && p.eatKw('ON')) {
      const postgres = eatWord(p, 'CONFLICT');
      let columns = null;
      if (postgres) {
        if (p.eatPunct('(')) { columns = []; do { columns.push(p.parseIdent()); } while (p.eatPunct(',')); p.expectPunct(')'); }
        expectWord(p, 'DO');
      } else { expectWord(p, 'DUPLICATE'); expectWord(p, 'KEY'); }
      if (postgres && eatWord(p, 'NOTHING')) piano.conflict = { dialect: 'postgresql', columns, nothing: true };
      else {
        expectWord(p, 'UPDATE'); if (postgres) expectWord(p, 'SET');
        if (postgres && !columns) throw new Error('ON CONFLICT DO UPDATE richiede le colonne del vincolo univoco.');
        p.insertConflict = !postgres;
        const set = leggiSet(p);
        const resolve = name => /^excluded\./i.test(name) ? `$excluded.${name.slice(9)}` : makeResolver(null, piano.coll, new Set())(name);
        const fields = Object.fromEntries(Object.entries(set).map(([k, e]) => [k, emettiEspressione(e, resolve)]));
        const where = postgres && p.eatKw('WHERE') ? filtroEspressione(leggiEspressione(p), resolve) : {};
        piano.conflict = { dialect: postgres ? 'postgresql' : 'mysql', columns, where,
          update: postgres ? [{ $set: fields }] : Object.entries(fields).map(([k, v]) => ({ $set: { [k]: v } })) };
      }
    }
    if (piano.kind === 'write' && ['updateMany', 'deleteMany'].includes(piano.op) && (p.isKw('ORDER') || p.isKw('LIMIT'))) {
      const start = p.pos;
      while (!p.eof() && !p.isKw('RETURNING')) p.next();
      const selezione = translateTokens([{ type: 'kw', value: 'SELECT' }, { type: 'ident', value: '_id' },
        { type: 'kw', value: 'FROM' }, { type: 'ident', value: piano.coll }, ...p.toks.slice(start, p.pos)]);
      piano.selection = [{ $match: piano.filter }, ...planToPipeline(selezione)];
    }
    if (p.eatKw('RETURNING')) {
      if (piano.kind !== 'write' || !['insertOne', 'insertMany', 'updateMany', 'deleteMany'].includes(piano.op)) throw new Error('RETURNING è disponibile per INSERT, UPDATE e DELETE.');
      const { distinct, items } = parseSelectList(p);
      if (distinct || items.some(it => it.kind === 'agg' || require('./sqlRaggruppamenti').haAggregato(it.expr) || contieneFinestra(it.expr))) throw new Error('RETURNING richiede colonne o espressioni scalari, senza aggregati o finestre.');
      piano.returning = buildAggregate({ coll: piano.coll, select: items, filter: null, groupBy: [], orderBy: [], limit: null, skip: 0,
        resolve: makeResolver(null, piano.coll, new Set()), scope: { aliases: new Set([piano.coll]) } }).pipeline;
    }
    if (!p.eof()) throw new Error(`Clausola non tradotta a fine comando: "${p.peek().value}". Nessuna scrittura eseguita.`);
    return piano;
  };

  if (eatWord(p, 'INSERT')) return completo(traduciInsert(p));
  if (eatWord(p, 'UPDATE')) return completo(traduciUpdate(p));
  if (eatWord(p, 'DELETE')) return completo(traduciDelete(p));
  if (eatWord(p, 'TRUNCATE')) return completo(traduciTruncate(p));
  if (eatWord(p, 'CREATE')) return completo(traduciCreate(p));
  if (eatWord(p, 'DROP')) return completo(traduciDrop(p));

  if (eatWord(p, 'ALTER')) return completo(isWord(p, 'DOMAIN') ? require('./sqlDominiMongo').parse(p, 'alterDomain') : require('./sqlAlterMongo').parse(p));
  if (isWord(p, 'REPLACE')) {
    throw new Error('REPLACE INTO non è supportato su MongoDB. Usa UPDATE … SET (aggiornamento) oppure db.<collezione>.replaceOne().');
  }
  const t = p.peek();
  throw new Error(`Comando SQL non riconosciuto${t ? `: "${t.value}"` : ''}.`);
}

// INSERT INTO coll (c1, c2) VALUES (v1, v2), (v3, v4)
function traduciInsert(p) {
  expectWord(p, 'INTO');
  const coll = p.parseIdent();

  let colonne = null;
  if (p.isPunct('(')) {
    p.expectPunct('(');
    colonne = [];
    do { colonne.push(p.parseIdent()); } while (p.eatPunct(','));
    p.expectPunct(')');
  }

  if (p.isKw('SELECT') || p.isKw('WITH') || p.isPunct('(')) {
    const start = p.pos;
    let depth = 0;
    while (!p.eof()) {
      if (!depth && (p.isKw('RETURNING') || (p.isKw('ON') && ['CONFLICT', 'DUPLICATE'].includes(String(p.peek(1)?.value).toUpperCase())))) break;
      const token = p.next(); if (token.value === '(') depth++; else if (token.value === ')') depth--;
    }
    const source = translateTokens(p.toks.slice(start, p.pos));
    return { kind: 'write', op: 'insertMany', coll, source: colonne ? rinominaPiano(source, colonne) : source, implicitColumns: !colonne };
  }
  if (eatWord(p, 'DEFAULT')) { expectWord(p, 'VALUES'); return { kind: 'write', op: 'insertOne', coll, docs: [{}], needsSchema: true }; }
  expectWord(p, 'VALUES');

  const righe = [];
  do {
    p.expectPunct('(');
    const valori = [];
    do { valori.push(eatWord(p, 'DEFAULT') ? require('./sqlMongoContesto').DEFAULT : leggiEspressione(p)); } while (p.eatPunct(','));
    p.expectPunct(')');
    righe.push(valori);
  } while (p.eatPunct(','));

  if (righe.some(row => row.some(e => e !== require('./sqlMongoContesto').DEFAULT && e.tipo !== 'valore'))) {
    for (const row of righe) for (const e of row) if (e !== require('./sqlMongoContesto').DEFAULT) emettiEspressione(e, () => { throw new Error('VALUES non può riferirsi a colonne.'); });
    return { kind: 'write', op: 'insertMany', coll, expressionRows: righe, insertColumns: colonne };
  }
  for (const row of righe) for (let i = 0; i < row.length; i++) if (row[i] !== require('./sqlMongoContesto').DEFAULT) row[i] = row[i].valore;
  if (!colonne) {
    return { kind: 'write', op: righe.length > 1 ? 'insertMany' : 'insertOne', coll, values: righe };
  }
  if (new Set(colonne).size !== colonne.length) throw new Error('Colonna ripetuta nella INSERT.');

  const docs = righe.map((valori) => {
    if (valori.length !== colonne.length) {
      throw new Error(`Numero di valori (${valori.length}) diverso dal numero di colonne (${colonne.length}).`);
    }
    const doc = {};
    colonne.forEach((c, i) => { doc[c] = valori[i]; });
    return doc;
  });

  return { kind: 'write', op: docs.length > 1 ? 'insertMany' : 'insertOne', coll, docs };
}

// UPDATE coll SET a = 1, b = 'x' [WHERE …]
function traduciUpdate(p) {
  const coll = p.parseIdent();
  const alias = isWord(p, 'SET') ? null : parseTableAlias(p);
  const joins = parseJoins(p, new Map());
  expectWord(p, 'SET');

  const set = leggiSet(p);
  if (p.eatKw('FROM')) aggiungiSorgentiDml(p, joins);
  if (alias || joins.length || Object.values(set).some(require('./sqlSottoquery').contieneSottoquery)
      || p.toks.slice(p.pos).some(t => t.type === 'kw' && ['SELECT', 'WITH'].includes(t.value))) return pianoDml(p, coll, alias, joins, set);
  const filter = p.eatKw('WHERE') || eatWord(p, 'WHERE') ? parseWhere(p) : {};

  return {
    kind: 'write',
    op: 'updateMany',
    coll,
    filter,
    update: Object.values(set).every(e => e.tipo === 'valore')
      ? { $set: Object.fromEntries(Object.entries(set).map(([k, e]) => [k, e.valore])) }
      : [{ $set: Object.fromEntries(Object.entries(set).map(([k, e]) => [k, emettiEspressione(e)])) }],
    note: Object.keys(filter).length ? null : 'UPDATE senza WHERE: aggiornati TUTTI i documenti della collezione.',
  };
}

function leggiSet(p) {
  const set = Object.create(null);
  do {
    const campo = p.parseIdent();
    const indices=[];
    while(p.eatPunct('[')) {
      const first=p.isPunct(':')?undefined:leggiEspressione(p),slice=p.eatPunct(':');
      const upper=slice&&!p.isPunct(']')?leggiEspressione(p):undefined;
      p.expectPunct(']'); indices.push(slice?{slice,lower:first,upper}:{slice:false,index:first});
    }
    const t = p.peek();
    if (!t || t.type !== 'op' || t.value !== '=') {
      throw new Error(`Atteso "=" dopo "${campo}" nella SET.`);
    }
    p.pos++;
    const replacement=leggiEspressione(p);
    set[campo] = indices.length?{tipo:'assegnaarray',a:set[campo]||{tipo:'colonna',nome:campo},indices,replacement}:replacement;
  } while (p.eatPunct(','));

  return set;
}

// DELETE FROM coll [WHERE …]
function traduciDelete(p) {
  const target = p.isKw('FROM') ? null : p.parseIdent();
  expectWord(p, 'FROM');
  const coll = p.parseIdent();
  const alias = parseTableAlias(p);
  if (target && target !== (alias || coll)) throw new Error('DELETE richiede un unico bersaglio coerente con FROM.');
  const joins = parseJoins(p, new Map());
  if (p.eatKw('USING')) aggiungiSorgentiDml(p, joins);
  if (target || alias || joins.length || p.toks.slice(p.pos).some(t => t.type === 'kw' && ['SELECT', 'WITH'].includes(t.value))) return pianoDml(p, coll, alias, joins, null);
  const filter = p.eatKw('WHERE') || eatWord(p, 'WHERE') ? parseWhere(p) : {};
  return {
    kind: 'write',
    op: 'deleteMany',
    coll,
    filter,
    note: Object.keys(filter).length ? null : 'DELETE senza WHERE: cancellati TUTTI i documenti della collezione.',
  };
}

function aggiungiSorgentiDml(p, joins) {
  do {
    const coll = p.parseIdent(), alias = parseTableAlias(p) || coll;
    joins.push({ type: 'cross', coll, alias, pipeline: [] });
    joins.push(...parseJoins(p, new Map()));
  } while (p.eatPunct(','));
}

function pianoDml(p, coll, alias, joins, set) {
  const resolve = makeResolver(alias, coll, new Set(joins.map(j => j.alias)), joins);
  const where = p.eatKw('WHERE') ? leggiEspressione(p) : null;
  const select = [{ kind: 'col', name: `${alias || coll}._id`, alias: 'rid' }];
  const assignments = Object.keys(set || {}).map(name => {
    if (name.includes('.') && !name.startsWith(`${alias || coll}.`)) throw new Error('UPDATE può modificare soltanto la tabella bersaglio.');
    return name.startsWith(`${alias || coll}.`) ? name.slice((alias || coll).length + 1) : name;
  });
  Object.values(set || {}).forEach((expr, i) => select.push({ kind: 'expr', expr, alias: `v${i}` }));
  const orderBy = [];
  if (p.eatKw('ORDER')) {
    p.expectKw('BY');
    do { const expr = leggiEspressione(p), dir = p.eatKw('DESC') ? -1 : (p.eatKw('ASC'), 1);
      orderBy.push(expr.tipo === 'colonna' ? { field: expr.nome, dir } : { expr, dir });
    } while (p.eatPunct(','));
  }
  const limit = p.eatKw('LIMIT') ? expectNumber(p, 'LIMIT') : null;
  const changes = buildAggregate({ coll, select, where, groupBy: [], orderBy, limit, skip: 0, joins, resolve,
    scope: { aliases: new Set([alias || coll, ...joins.map(j => j.alias)]) } });
  return { kind: 'write', op: set ? 'updateMany' : 'deleteMany', coll, changes, assignments, filter: {} };
}

// TRUNCATE [TABLE] coll
function traduciTruncate(p) {
  eatWord(p, 'TABLE');
  const coll = p.parseIdent();
  return { kind: 'write', op: 'deleteMany', coll, filter: {}, truncate: true, note: 'TRUNCATE: cancellati tutti i documenti (la collezione resta).' };
}

// CREATE TABLE coll (…) | CREATE DATABASE nome
function traduciCreate(p) {
  if (isWord(p, 'DOMAIN')) return require('./sqlDominiMongo').parse(p, 'createDomain');
  if (eatWord(p, 'DATABASE') || eatWord(p, 'SCHEMA')) {
    eatWord(p, 'IF'); eatWord(p, 'NOT'); eatWord(p, 'EXISTS');
    const db = p.parseIdent();
    return {
      kind: 'ddl',
      op: 'createDatabase',
      db,
      note: 'Su MongoDB un database esiste quando contiene almeno una collezione: viene creata una collezione iniziale.',
    };
  }
  if (eatWord(p, 'TABLE') || eatWord(p, 'COLLECTION')) {
    const ifNotExists = eatWord(p, 'IF');
    if (ifNotExists) { expectWord(p, 'NOT'); expectWord(p, 'EXISTS'); }
    const coll = p.parseIdent();
    const schema = p.isPunct('(') ? require('./sqlSchemaMongo').definizione(p, coll) : null;
    return { kind: 'ddl', op: 'createCollection', coll, schema, ifNotExists, note: null };
  }
  const unique = eatWord(p, 'UNIQUE');
  if (eatWord(p, 'INDEX')) {
    const name = p.parseIdent();
    expectWord(p, 'ON');
    const coll = p.parseIdent();
    p.expectPunct('(');
    const keys = {};
    do {
      const campo = p.parseIdent();
      keys[campo] = p.eatKw('DESC') ? -1 : (p.eatKw('ASC'), 1);
    } while (p.eatPunct(','));
    p.expectPunct(')');
    return { kind: 'ddl', op: 'createIndex', coll, keys, options: { name, unique } };
  }
  const t = p.peek();
  throw new Error(`CREATE non supportato${t ? ` per "${t.value}"` : ''}: sono tradotti CREATE TABLE e CREATE DATABASE.`);
}

// DROP TABLE coll | DROP DATABASE nome
function traduciDrop(p) {
  if (isWord(p, 'DOMAIN')) return require('./sqlDominiMongo').parse(p, 'dropDomain');
  if (eatWord(p, 'INDEX')) {
    const name = p.parseIdent();
    expectWord(p, 'ON');
    return { kind: 'ddl', op: 'dropIndex', coll: p.parseIdent(), name };
  }
  if (eatWord(p, 'DATABASE') || eatWord(p, 'SCHEMA')) {
    eatWord(p, 'IF'); eatWord(p, 'EXISTS');
    const db = p.parseIdent();
    return { kind: 'ddl', op: 'dropDatabase', db };
  }
  if (eatWord(p, 'TABLE') || eatWord(p, 'COLLECTION')) {
    eatWord(p, 'IF'); eatWord(p, 'EXISTS');
    const coll = p.parseIdent();
    return { kind: 'ddl', op: 'dropCollection', coll };
  }
  const t = p.peek();
  throw new Error(`DROP non supportato${t ? ` per "${t.value}"` : ''}: sono tradotti DROP TABLE e DROP DATABASE.`);
}

module.exports = { translate, looksLikeSql, tokenize, translateWrite, looksLikeSqlWrite,
  translateTokens, planToPipeline, rinominaPiano, pianoDocumenti, analizzaProgramma, Parser };
