'use strict';

/**
 * CodeDB — Traduttore SQL → MQL (MongoDB Query Language)
 *
 * Traduce un sottoinsieme comune di SQL SELECT in operazioni MongoDB, così la
 * tab "⚡ Query & Aggregate" può eseguire query SQL anche su MongoDB (non solo
 * su MySQL/PostgreSQL). Copertura:
 *
 *   - SELECT * | col1, col2 [AS alias] | funzioni aggregate
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
 *   - [INNER | LEFT [OUTER]] JOIN … ON a.x = b.y   → $lookup + $unwind
 *                                          (alias di tabella e colonne
 *                                          qualificate a.col, JOIN concatenate)
 *   - UNION [ALL]                        → $unionWith (+ dedup per UNION)
 *   - FROM ( SELECT … ) AS sub           → sotto-query "derived table"
 *   - ORDER BY col [ASC|DESC], ...
 *   - LIMIT n  [OFFSET m]   |   LIMIT m, n  (stile MySQL: offset, count)
 *   - OFFSET m
 *
 * Restituisce un descrittore:
 *   { kind: 'find', coll, filter, projection, sort, limit, skip }
 * oppure, quando servono aggregazioni:
 *   { kind: 'aggregate', coll, pipeline }
 *
 * Non gestisce (per scelta, con errore esplicito): RIGHT/FULL/CROSS JOIN, JOIN
 * con condizioni ON multiple o non di uguaglianza, sotto-query nella WHERE
 * (IN (SELECT …) / scalari), espressioni aritmetiche nel SELECT e ogni comando
 * che non sia una SELECT (INSERT/UPDATE/DELETE...). Per quei casi conviene una
 * pipeline MQL nativa. Nessun accesso al DB: pura trasformazione di stringhe.
 */

const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS', 'NULL', 'BETWEEN', 'AS', 'ASC', 'DESC',
  'TRUE', 'FALSE', 'DISTINCT', 'JOIN', 'UNION',
  // JOIN e varianti
  'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING', 'ALL',
]);

/* --------------------------------------------------------------------------
 * Tokenizer
 * ------------------------------------------------------------------------ */

// Tipi di token: 'kw' (parola chiave), 'ident', 'num', 'str', 'op', 'punct'.
function tokenize(sql) {
  const tokens = [];
  const s = String(sql);
  let i = 0;
  const n = s.length;

  const isIdentStart = (c) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$.]/.test(c);

  while (i < n) {
    const c = s[i];

    // Spazi
    if (/\s/.test(c)) { i++; continue; }

    // Commenti -- fino a fine riga
    if (c === '-' && s[i + 1] === '-') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }

    // Stringhe con ' o " — raddoppio dell'apice per l'escape ('' o "")
    if (c === "'" || c === '"') {
      const quote = c;
      let val = '';
      i++;
      while (i < n) {
        if (s[i] === quote) {
          if (s[i + 1] === quote) { val += quote; i += 2; continue; }
          i++; break;
        }
        if (s[i] === '\\' && i + 1 < n) { val += s[i + 1]; i += 2; continue; }
        val += s[i]; i++;
      }
      tokens.push({ type: 'str', value: val });
      continue;
    }

    // Identificatori quotati con backtick o parentesi quadre (`col` / [col])
    if (c === '`' || c === '[') {
      const close = c === '`' ? '`' : ']';
      let val = '';
      i++;
      while (i < n && s[i] !== close) { val += s[i]; i++; }
      i++; // salta la chiusura
      tokens.push({ type: 'ident', value: val });
      continue;
    }

    // Numeri (con eventuale segno unario + / -). Il segno è parte del numero
    // solo in posizione di operando: non deve seguire un valore (numero,
    // stringa, identificatore o parentesi chiusa), altrimenti sarebbe una
    // sottrazione/addizione — che il traduttore non gestisce comunque.
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
      tokens.push({ type: 'num', value: Number(val) });
      continue;
    }

    // Operatori a due caratteri
    const two = s.substr(i, 2);
    if (two === '>=' || two === '<=' || two === '<>' || two === '!=' || two === '==') {
      tokens.push({ type: 'op', value: two === '==' ? '=' : two });
      i += 2; continue;
    }

    // Operatori a un carattere
    if (c === '=' || c === '>' || c === '<') {
      tokens.push({ type: 'op', value: c });
      i++; continue;
    }

    // Punteggiatura
    if (c === '(' || c === ')' || c === ',' || c === '*') {
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
  if (p.isPunct('*')) {
    p.next();
    items.push({ kind: 'star' });
    return { distinct, items };
  }
  do {
    items.push(parseSelectItem(p));
  } while (p.eatPunct(','));
  return { distinct, items };
}

function parseSelectItem(p) {
  const t = p.peek();
  // Funzione aggregata: IDENT ( ... )
  if (t && t.type === 'ident' && AGG_FUNCS.has(t.value.toUpperCase()) && p.peek(1) && p.peek(1).value === '(') {
    const func = p.next().value.toUpperCase();
    p.expectPunct('(');
    let arg;
    if (p.eatPunct('*')) {
      arg = '*';
    } else {
      arg = p.parseIdent();
    }
    p.expectPunct(')');
    const alias = parseOptionalAlias(p);
    return { kind: 'agg', func, arg, alias };
  }

  // Colonna semplice
  const col = p.parseIdent();
  const alias = parseOptionalAlias(p);
  return { kind: 'col', name: col, alias };
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
  return parseOr(p);
}

function parseOr(p) {
  let left = parseAnd(p);
  if (p.isKw('OR')) {
    const parts = [left];
    while (p.eatKw('OR')) parts.push(parseAnd(p));
    return { $or: parts };
  }
  return left;
}

function parseAnd(p) {
  let left = parseNot(p);
  if (p.isKw('AND')) {
    const parts = [left];
    while (p.eatKw('AND')) parts.push(parseNot(p));
    return { $and: parts };
  }
  return left;
}

function parseNot(p) {
  if (p.eatKw('NOT')) {
    return { $nor: [parseNot(p)] };
  }
  return parsePrimary(p);
}

function parsePrimary(p) {
  if (p.eatPunct('(')) {
    const inner = parseOr(p);
    p.expectPunct(')');
    return inner;
  }
  return parseCondition(p);
}

function parseValue(p) {
  // Sotto-query scalare: … op (SELECT …). Non traducibile in un singolo $match.
  if (p.isPunct('(') && p.peek(1) && p.peek(1).type === 'kw' && p.peek(1).value === 'SELECT') {
    throw new Error('Le sotto-query scalari "(SELECT ...)" nella WHERE non sono supportate dal traduttore SQL→MQL. Esegui prima la sotto-query o usa una pipeline con $lookup.');
  }
  const t = p.next();
  if (!t) throw new Error('Valore atteso nella clausola WHERE, trovato fine query.');
  if (t.type === 'num') return t.value;
  if (t.type === 'str') return t.value;
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

// Converte un pattern SQL LIKE in una regex MongoDB (case-insensitive).
function likeToRegex(pattern) {
  let out = '';
  const str = String(pattern);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '%') { out += '.*'; continue; }
    if (ch === '_') { out += '.'; continue; }
    if (ch === '\\' && i + 1 < str.length) { out += escapeRegex(str[++i]); continue; }
    out += escapeRegex(ch);
  }
  return '^' + out + '$';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OP_TO_MQL = { '>': '$gt', '<': '$lt', '>=': '$gte', '<=': '$lte', '!=': '$ne', '<>': '$ne' };

function parseCondition(p) {
  const col = p.resolve(p.parseIdent());

  // IS [NOT] NULL
  if (p.eatKw('IS')) {
    const neg = p.eatKw('NOT');
    p.expectKw('NULL');
    return neg ? { [col]: { $ne: null } } : { [col]: null };
  }

  // NOT IN / NOT LIKE / NOT BETWEEN
  let negated = false;
  if (p.eatKw('NOT')) negated = true;

  if (p.eatKw('IN')) {
    p.expectPunct('(');
    if (p.isKw('SELECT')) {
      throw new Error('Le sotto-query in "IN (SELECT ...)" non sono supportate dal traduttore SQL→MQL. Usa un JOIN ($lookup) o esegui prima la sotto-query.');
    }
    const list = [];
    if (!p.isPunct(')')) {
      do { list.push(parseValue(p)); } while (p.eatPunct(','));
    }
    p.expectPunct(')');
    return { [col]: negated ? { $nin: list } : { $in: list } };
  }

  if (p.eatKw('LIKE')) {
    const pat = parseValue(p);
    const rx = { $regex: likeToRegex(pat), $options: 'i' };
    return { [col]: negated ? { $not: rx } : rx };
  }

  if (p.eatKw('BETWEEN')) {
    const lo = parseValue(p);
    p.expectKw('AND');
    const hi = parseValue(p);
    const range = { $gte: lo, $lte: hi };
    return { [col]: negated ? { $not: range } : range };
  }

  if (negated) {
    throw new Error(`"NOT" può precedere solo IN, LIKE o BETWEEN (colonna "${col}").`);
  }

  // Operatore di confronto
  const t = p.peek();
  if (!t || t.type !== 'op') {
    throw new Error(`Operatore di confronto atteso dopo "${col}"${t ? `, trovato "${t.value}"` : ''}.`);
  }
  p.next();
  const val = parseValue(p);
  if (t.value === '=') return { [col]: val };
  const mql = OP_TO_MQL[t.value];
  return { [col]: { [mql]: val } };
}

/* --------------------------------------------------------------------------
 * Traduzione complessiva
 * ------------------------------------------------------------------------ */

function translate(sql) {
  const raw = String(sql || '').trim().replace(/;\s*$/, '');
  if (!raw) throw new Error('Query SQL vuota.');

  const tokens = tokenize(raw);
  const segments = splitUnions(tokens);

  // Query singola: nessun UNION. Comportamento storico (LIMIT di default 50).
  if (segments.length === 1) {
    return translateStatement(segments[0].tokens, { defaultLimit: 50 });
  }

  // UNION [ALL] → $unionWith. Ogni operando è tradotto a pipeline; il primo
  // determina la collezione di partenza, gli altri diventano stadi $unionWith.
  // Senza LIMIT di default: un UNION restituisce tutte le righe (cap dell'engine).
  const anyDistinct = segments.some((s, i) => i > 0 && !s.all);
  const first = translateStatement(segments[0].tokens, { defaultLimit: null });
  const pipeline = planToPipeline(first);

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const plan = translateStatement(seg.tokens, { defaultLimit: null });
    pipeline.push({ $unionWith: { coll: plan.coll, pipeline: planToPipeline(plan) } });
  }

  // UNION (senza ALL) elimina i duplicati sull'intero documento; UNION ALL li
  // mantiene. Con operatori misti, si deduplica se almeno un UNION non è ALL.
  if (anyDistinct) {
    pipeline.push({ $group: { _id: '$$ROOT' } });
    pipeline.push({ $replaceRoot: { newRoot: '$_id' } });
  }

  return { kind: 'aggregate', coll: first.coll, pipeline };
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
  if (plan.kind === 'aggregate') return plan.pipeline;
  const pl = [];
  if (plan.filter && Object.keys(plan.filter).length) pl.push({ $match: plan.filter });
  if (plan.projection && Object.keys(plan.projection).length) pl.push({ $project: plan.projection });
  if (plan.sort && Object.keys(plan.sort).length) pl.push({ $sort: plan.sort });
  if (plan.skip) pl.push({ $skip: plan.skip });
  if (plan.limit != null) pl.push({ $limit: plan.limit });
  return pl;
}

// Traduce una singola SELECT (senza UNION) nel piano find/aggregate.
function translateStatement(tokens, { defaultLimit = 50 } = {}) {
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
  p.expectKw('FROM');

  // FROM ( SELECT … ) [AS] alias  →  la sotto-query (derived table) diventa il
  // prefisso della pipeline; le clausole esterne le si applicano sopra.
  let coll;
  let baseAlias;
  let fromPipeline = null;
  if (p.isPunct('(')) {
    const innerTokens = p.readParenGroup();
    const innerPlan = translateStatement(innerTokens, { defaultLimit: null });
    fromPipeline = planToPipeline(innerPlan);
    coll = innerPlan.coll;
    baseAlias = parseTableAlias(p);
  } else {
    coll = p.parseIdent();
    baseAlias = parseTableAlias(p);
  }

  // JOIN … ON  →  $lookup + $unwind. Le collezioni unite prendono il proprio
  // alias come campo di destinazione (`as`), così i riferimenti "alias.colonna"
  // corrispondono già al percorso MQL annidato.
  const joins = parseJoins(p);

  // Resolver dei nomi qualificati: attivo solo se c'è almeno un JOIN (in
  // presenza di soli alias di tabella senza JOIN si comporta comunque bene).
  const hasJoins = joins.length > 0;
  if (hasJoins || baseAlias) {
    const joinAliases = new Set(joins.map((j) => j.alias));
    p.resolve = makeResolver(baseAlias, coll, joinAliases);
  }

  let filter = null;
  if (p.eatKw('WHERE')) filter = parseWhere(p);

  const groupBy = [];
  if (p.eatKw('GROUP')) {
    p.expectKw('BY');
    do { groupBy.push(p.resolve(p.parseIdent())); } while (p.eatPunct(','));
  }

  let having = null;
  if (p.eatKw('HAVING')) {
    having = parseHaving(p, select, p.resolve);
  }

  const orderBy = [];
  if (p.eatKw('ORDER')) {
    p.expectKw('BY');
    do {
      const field = p.resolve(p.parseIdent());
      let dir = 1;
      if (p.eatKw('DESC')) dir = -1;
      else p.eatKw('ASC');
      orderBy.push({ field, dir });
    } while (p.eatPunct(','));
  }

  let limit = null;
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

  const hasAgg = select.some((it) => it.kind === 'agg');

  // SELECT DISTINCT senza GROUP BY / aggregati → raggruppa su tutte le colonne
  // proiettate (equivalente semantico del DISTINCT SQL).
  let effectiveGroupBy = groupBy;
  if (distinct && groupBy.length === 0 && !hasAgg) {
    if (select.some((it) => it.kind === 'star')) {
      throw new Error('SELECT DISTINCT * non è supportato: elenca le colonne su cui applicare il DISTINCT.');
    }
    effectiveGroupBy = select.map((it) => p.resolve(it.name));
  } else if (distinct) {
    throw new Error('DISTINCT combinato con GROUP BY o funzioni aggregate non è supportato dal traduttore SQL→MQL.');
  }

  const useAggregate = hasAgg || effectiveGroupBy.length > 0 || hasJoins || !!fromPipeline;

  if (having && !(hasAgg || effectiveGroupBy.length > 0)) {
    throw new Error('HAVING richiede GROUP BY o una funzione aggregata.');
  }

  if (!useAggregate) {
    return buildFind({ coll, select, filter, orderBy, limit: limit != null ? limit : defaultLimit, skip, resolve: p.resolve });
  }
  return buildAggregate({ coll, select, filter, groupBy: effectiveGroupBy, orderBy, limit, skip, joins, having, prefix: fromPipeline, resolve: p.resolve });
}

// HAVING → filtro applicato dopo il raggruppamento. Ogni condizione confronta un
// termine (un alias/colonna del GROUP BY, oppure una funzione aggregata come
// COUNT(*)/SUM(x)) con un valore. Restituisce { conditions: [{ field, op, value }],
// combinator: '$and'|'$or', aggs: [{ func, arg, out }] } dove `aggs` elenca gli
// aggregati richiesti dall'HAVING ma non già presenti nel SELECT, da calcolare.
function parseHaving(p, select, resolve) {
  const aggs = [];
  const conditions = [];
  let combinator = '$and';

  const resolveAggName = (func, argRaw) => {
    const arg = argRaw === '*' ? '*' : resolve(argRaw);
    // Cerca un aggregato equivalente già nel SELECT (per alias di output).
    for (const it of select) {
      if (it.kind === 'agg' && it.func === func) {
        const selArg = it.arg === '*' ? '*' : resolve(it.arg);
        if (selArg === arg) return aggFieldName(it);
      }
    }
    // Altrimenti registra un aggregato calcolato apposta per l'HAVING.
    const out = `__having_${func.toLowerCase()}_${arg === '*' ? 'all' : String(arg).replace(/[.\s]/g, '_')}`;
    if (!aggs.some((a) => a.out === out)) aggs.push({ func, arg, out });
    return out;
  };

  const parseTerm = () => {
    const t = p.peek();
    // Funzione aggregata: FUNC( * | colonna )
    if (t && t.type === 'ident' && AGG_FUNCS.has(t.value.toUpperCase()) && p.peek(1) && p.peek(1).value === '(') {
      const func = p.next().value.toUpperCase();
      p.expectPunct('(');
      const arg = p.eatPunct('*') ? '*' : p.parseIdent();
      p.expectPunct(')');
      return resolveAggName(func, arg);
    }
    // Alias di output o colonna del GROUP BY: il nome è già quello proiettato.
    const id = p.parseIdent();
    return lastSegment(id);
  };

  const parseOneCondition = () => {
    const field = parseTerm();
    const opTok = p.peek();
    if (!opTok || opTok.type !== 'op') {
      throw new Error(`Operatore di confronto atteso nella HAVING${opTok ? `, trovato "${opTok.value}"` : ''}.`);
    }
    p.next();
    const value = parseValue(p);
    conditions.push({ field, op: opTok.value, value });
  };

  parseOneCondition();
  if (p.isKw('OR')) {
    combinator = '$or';
    while (p.eatKw('OR')) parseOneCondition();
  } else {
    while (p.eatKw('AND')) parseOneCondition();
  }

  return { conditions, combinator, aggs };
}

// Traduce una condizione HAVING ({ field, op, value }) in un frammento $match.
function havingConditionToMatch(cond) {
  if (cond.op === '=') return { [cond.field]: cond.value };
  const mql = OP_TO_MQL[cond.op];
  if (!mql) throw new Error(`Operatore HAVING non supportato: "${cond.op}".`);
  return { [cond.field]: { [mql]: cond.value } };
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

// Analizza zero o più clausole JOIN. Sono supportati INNER JOIN (default) e
// LEFT [OUTER] JOIN con una singola condizione di equi-join (ON a = b).
// RIGHT/FULL/CROSS JOIN e le condizioni non di uguaglianza sono rifiutati con
// un messaggio esplicito (non hanno una traduzione diretta e sicura in $lookup).
function parseJoins(p) {
  const joins = [];
  for (;;) {
    let type = 'inner';
    if (p.eatKw('INNER')) {
      type = 'inner';
    } else if (p.eatKw('LEFT')) {
      p.eatKw('OUTER');
      type = 'left';
    } else if (p.isKw('RIGHT') || p.isKw('FULL')) {
      const w = p.peek().value;
      throw new Error(`${w} JOIN non è supportato dal traduttore SQL→MQL: invertire le tabelle per usare un LEFT JOIN, oppure usare una pipeline con $lookup.`);
    } else if (p.isKw('CROSS')) {
      throw new Error('CROSS JOIN non è supportato dal traduttore SQL→MQL. Usa una pipeline con $lookup.');
    } else if (!p.isKw('JOIN')) {
      break; // nessun'altra JOIN
    }
    p.expectKw('JOIN');

    const coll = p.parseIdent();
    const alias = parseTableAlias(p) || coll;

    if (p.isKw('USING')) {
      throw new Error('JOIN ... USING non è supportato: usa la forma "ON tabella.colonna = altra.colonna".');
    }
    p.expectKw('ON');
    const left = p.parseIdent();
    const opTok = p.peek();
    if (!opTok || opTok.type !== 'op' || opTok.value !== '=') {
      throw new Error(`La condizione ON di "${alias}" deve essere un'uguaglianza (colonna = colonna).`);
    }
    p.next();
    const right = p.parseIdent();
    if (p.isKw('AND') || p.isKw('OR')) {
      throw new Error(`La condizione ON di "${alias}" supporta un solo equi-join (una coppia colonna = colonna). Sposta le altre condizioni nella WHERE o usa una pipeline con $lookup.`);
    }

    joins.push({ type, coll, alias, left, right });
  }
  return joins;
}

// Costruisce il risolutore dei nomi qualificati. La collezione base ha i campi
// alla radice (alias.campo → campo); ogni collezione unita è annidata sotto il
// proprio alias (usato come `as` del $lookup), quindi alias.campo è già il
// percorso MQL corretto e va lasciato intatto. I nomi non qualificati e i
// percorsi annidati della base (es. address.city) restano invariati.
function makeResolver(baseAlias, baseColl, joinAliases) {
  return function resolve(name) {
    const dot = name.indexOf('.');
    if (dot < 0) return name;
    const qualifier = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    if (qualifier === baseAlias || qualifier === baseColl) return rest;
    if (joinAliases.has(qualifier)) return name;
    return name;
  };
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
function buildJoinStages(joins, resolve) {
  const stages = [];
  for (const j of joins) {
    const belongsToNew = (name) => {
      const dot = name.indexOf('.');
      return dot >= 0 && (name.slice(0, dot) === j.alias || name.slice(0, dot) === j.coll);
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
    const foreignField = lastSegment(foreignRaw);
    const localField = resolve(localRaw);
    stages.push({ $lookup: { from: j.coll, localField, foreignField, as: j.alias } });
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
      // Nota: il find di MongoDB non può rinominare i campi, quindi un
      // eventuale alias (SELECT col AS x) non viene applicato alla proiezione:
      // si proietta sempre il nome reale della colonna.
      projection[name] = 1;
      if (name === '_id') selectsId = true;
    }
    // In SQL "SELECT col" non porta la chiave primaria: escludi _id se non richiesto.
    if (!selectsId) projection._id = 0;
  }

  const sort = {};
  for (const o of orderBy) sort[o.field] = o.dir;

  return {
    kind: 'find',
    coll,
    filter: filter || {},
    projection,
    sort,
    // Il default (50 per una query singola, nessun limite per gli operandi di
    // UNION) è già applicato dal chiamante: qui si passa il valore così com'è.
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
    const sort = {};
    for (const o of orderBy) sort[o.field] = o.dir;
    pipeline.push({ $sort: sort });
  }
  if (skip) pipeline.push({ $skip: skip });
  if (limit != null) pipeline.push({ $limit: limit });
}

// Espressione di un aggregato dato func e percorso dell'argomento (già risolto,
// oppure '*' per COUNT). COUNT(col) conta solo i valori non nulli, come in SQL.
function aggExpr(func, argPath) {
  if (func === 'COUNT') {
    return argPath === '*' ? { $sum: 1 } : { $sum: { $cond: [{ $ne: [`$${argPath}`, null] }, 1, 0] } };
  }
  const op = { SUM: '$sum', AVG: '$avg', MIN: '$min', MAX: '$max' }[func];
  return { [op]: `$${argPath}` };
}

function buildAggregate({ coll, select, filter, groupBy, orderBy, limit, skip, joins = [], having = null, prefix = null, resolve = (x) => x }) {
  const pipeline = [];
  // Sotto-query nella FROM (derived table): la sua pipeline apre tutto.
  if (prefix && prefix.length) pipeline.push(...prefix);
  // I JOIN vanno per primi: WHERE e GROUP BY possono riferirsi ai campi uniti.
  if (joins.length) pipeline.push(...buildJoinStages(joins, resolve));
  if (filter && Object.keys(filter).length) pipeline.push({ $match: filter });

  const hasAgg = select.some((it) => it.kind === 'agg');
  const grouping = groupBy.length > 0 || hasAgg;

  // JOIN senza aggregazione: proiezione semplice (o passthrough per SELECT *).
  if (!grouping) {
    const isStar = select.some((it) => it.kind === 'star');
    if (!isStar) {
      const projectStage = { _id: 0 };
      let selectsId = false;
      for (const it of select) {
        const path = resolve(it.name);
        const out = it.alias || lastSegment(it.name);
        projectStage[out] = `$${path}`;
        if (out === '_id') selectsId = true;
      }
      if (selectsId) delete projectStage._id;
      pipeline.push({ $project: projectStage });
    }
    pushSortSkipLimit(pipeline, orderBy, skip, limit);
    return { kind: 'aggregate', coll, pipeline };
  }

  // Chiave di raggruppamento. Con più campi, la chiave dell'oggetto _id non può
  // contenere punti (verrebbe interpretata come percorso annidato): la si
  // sanifica, tenendo il percorso risolto solo come valore.
  let groupId = null;
  const idKeyOf = {};
  if (groupBy.length === 1) {
    groupId = `$${groupBy[0]}`;
  } else if (groupBy.length > 1) {
    groupId = {};
    for (const g of groupBy) {
      const key = g.replace(/[.\s]/g, '_');
      groupId[key] = `$${g}`;
      idKeyOf[g] = key;
    }
  }

  const groupStage = { _id: groupId };
  const projectStage = { _id: 0 };

  for (const it of select) {
    if (it.kind === 'star') {
      throw new Error('SELECT * non è compatibile con GROUP BY / funzioni aggregate: elenca le colonne o gli aggregati.');
    }
    if (it.kind === 'agg') {
      const out = aggFieldName(it);
      const argPath = it.arg === '*' ? '*' : resolve(it.arg);
      groupStage[out] = aggExpr(it.func, argPath);
      projectStage[out] = 1;
    } else {
      // Colonna semplice: deve far parte del GROUP BY (confronto sul percorso risolto).
      const rname = resolve(it.name);
      if (!groupBy.includes(rname)) {
        throw new Error(`La colonna "${it.name}" deve comparire in GROUP BY o dentro una funzione aggregata.`);
      }
      const out = it.alias || lastSegment(it.name);
      if (groupBy.length === 1) projectStage[out] = '$_id';
      else projectStage[out] = `$_id.${idKeyOf[rname]}`;
    }
  }

  // HAVING: aggiunge gli aggregati richiesti ma non presenti nel SELECT, così da
  // poterli filtrare dopo il raggruppamento.
  if (having && having.aggs.length) {
    for (const a of having.aggs) {
      const argPath = a.arg === '*' ? '*' : resolve(a.arg);
      groupStage[a.out] = aggExpr(a.func, argPath);
      projectStage[a.out] = 1;
    }
  }

  pipeline.push(groupStage);
  pipeline.push({ $project: projectStage });

  if (having) {
    const frags = having.conditions.map(havingConditionToMatch);
    const match = frags.length === 1 ? frags[0] : { [having.combinator]: frags };
    pipeline.push({ $match: match });
    // Rimuove gli aggregati calcolati solo per l'HAVING (non richiesti nel SELECT).
    if (having.aggs.length) {
      const drop = {};
      for (const a of having.aggs) drop[a.out] = 0;
      pipeline.push({ $project: drop });
    }
  }

  pushSortSkipLimit(pipeline, orderBy, skip, limit);

  return { kind: 'aggregate', coll, pipeline };
}

// Euristica: la stringa sembra una query SQL (SELECT ... FROM ...)?
function looksLikeSql(code) {
  return /^\s*SELECT\b/i.test(String(code || ''));
}

module.exports = { translate, looksLikeSql, tokenize };
