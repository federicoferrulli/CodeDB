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
 *   - GROUP BY col1, col2  con COUNT/SUM/AVG/MIN/MAX
 *   - ORDER BY col [ASC|DESC], ...
 *   - LIMIT n  [OFFSET m]   |   LIMIT m, n  (stile MySQL: offset, count)
 *   - OFFSET m
 *
 * Restituisce un descrittore:
 *   { kind: 'find', coll, filter, projection, sort, limit, skip }
 * oppure, quando servono aggregazioni:
 *   { kind: 'aggregate', coll, pipeline }
 *
 * Non gestisce (per scelta, con errore esplicito): JOIN, sub-query, UNION,
 * DISTINCT, HAVING, espressioni aritmetiche nel SELECT e ogni comando che non
 * sia una SELECT (INSERT/UPDATE/DELETE...). Per quei casi conviene una pipeline
 * MQL nativa. Nessun accesso al DB: pura trasformazione di stringhe.
 */

const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS', 'NULL', 'BETWEEN', 'AS', 'ASC', 'DESC',
  'TRUE', 'FALSE', 'DISTINCT', 'JOIN', 'UNION',
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
  if (p.eatKw('DISTINCT')) {
    throw new Error('SELECT DISTINCT non è supportato dal traduttore SQL→MQL. Usa una pipeline MQL con $group.');
  }
  if (p.isPunct('*')) {
    p.next();
    items.push({ kind: 'star' });
    return items;
  }
  do {
    items.push(parseSelectItem(p));
  } while (p.eatPunct(','));
  return items;
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
  const col = p.parseIdent();

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
  const p = new Parser(tokens);

  if (!p.eatKw('SELECT')) {
    const t = p.peek();
    const w = t ? String(t.value).toUpperCase() : '';
    if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE'].includes(w)) {
      throw new Error('Solo le query SELECT sono traducibili in MongoDB. Per le scritture usa la vista Dati o una pipeline $out/$merge.');
    }
    throw new Error('La query SQL deve iniziare con SELECT.');
  }

  const select = parseSelectList(p);
  p.expectKw('FROM');
  const coll = p.parseIdent();

  // JOIN / UNION non supportati
  if (p.isKw('JOIN') || p.isKw('UNION')) {
    throw new Error('JOIN e UNION non sono supportati dal traduttore SQL→MQL. Usa i Virtual JOIN Cross-DB o una pipeline con $lookup.');
  }

  let filter = null;
  if (p.eatKw('WHERE')) filter = parseWhere(p);

  const groupBy = [];
  if (p.eatKw('GROUP')) {
    p.expectKw('BY');
    do { groupBy.push(p.parseIdent()); } while (p.eatPunct(','));
  }

  if (p.eatKw('HAVING')) {
    throw new Error('HAVING non è supportato dal traduttore SQL→MQL. Aggiungi un $match dopo il $group in una pipeline MQL.');
  }

  const orderBy = [];
  if (p.eatKw('ORDER')) {
    p.expectKw('BY');
    do {
      const field = p.parseIdent();
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
  const useAggregate = hasAgg || groupBy.length > 0;

  if (!useAggregate) {
    return buildFind({ coll, select, filter, orderBy, limit, skip });
  }
  return buildAggregate({ coll, select, filter, groupBy, orderBy, limit, skip });
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

function buildFind({ coll, select, filter, orderBy, limit, skip }) {
  const projection = {};
  const isStar = select.some((it) => it.kind === 'star');
  if (!isStar) {
    let selectsId = false;
    for (const it of select) {
      const name = it.name;
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
    limit: limit != null ? limit : 50,
    skip: skip || 0,
  };
}

// Nome di output per un item aggregato (alias esplicito o nome derivato).
function aggFieldName(it) {
  if (it.alias) return it.alias;
  if (it.func === 'COUNT' && it.arg === '*') return 'count';
  return `${it.func.toLowerCase()}_${it.arg}`;
}

function buildAggregate({ coll, select, filter, groupBy, orderBy, limit, skip }) {
  const pipeline = [];
  if (filter && Object.keys(filter).length) pipeline.push({ $match: filter });

  // Chiave di raggruppamento
  let groupId = null;
  if (groupBy.length === 1) {
    groupId = `$${groupBy[0]}`;
  } else if (groupBy.length > 1) {
    groupId = {};
    for (const g of groupBy) groupId[g] = `$${g}`;
  }

  const groupStage = { _id: groupId };
  const projectStage = { _id: 0 };

  for (const it of select) {
    if (it.kind === 'star') {
      throw new Error('SELECT * non è compatibile con GROUP BY / funzioni aggregate: elenca le colonne o gli aggregati.');
    }
    if (it.kind === 'agg') {
      const out = aggFieldName(it);
      if (it.func === 'COUNT') {
        groupStage[out] = it.arg === '*' ? { $sum: 1 } : { $sum: { $cond: [{ $ne: [`$${it.arg}`, null] }, 1, 0] } };
      } else {
        const op = { SUM: '$sum', AVG: '$avg', MIN: '$min', MAX: '$max' }[it.func];
        groupStage[out] = { [op]: `$${it.arg}` };
      }
      projectStage[out] = 1;
    } else {
      // Colonna semplice: deve far parte del GROUP BY
      if (!groupBy.includes(it.name)) {
        throw new Error(`La colonna "${it.name}" deve comparire in GROUP BY o dentro una funzione aggregata.`);
      }
      const out = it.alias || it.name;
      if (groupBy.length === 1) projectStage[out] = '$_id';
      else projectStage[out] = `$_id.${it.name}`;
    }
  }

  pipeline.push(groupStage);
  pipeline.push({ $project: projectStage });

  if (orderBy.length) {
    const sort = {};
    for (const o of orderBy) sort[o.field] = o.dir;
    pipeline.push({ $sort: sort });
  }
  if (skip) pipeline.push({ $skip: skip });
  if (limit != null) pipeline.push({ $limit: limit });

  return { kind: 'aggregate', coll, pipeline };
}

// Euristica: la stringa sembra una query SQL (SELECT ... FROM ...)?
function looksLikeSql(code) {
  return /^\s*SELECT\b/i.test(String(code || ''));
}

module.exports = { translate, looksLikeSql, tokenize };
