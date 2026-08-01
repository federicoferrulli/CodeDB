'use strict';

/**
 * CodeDB — Parser della sintassi nativa "mongosh" (shell MongoDB)
 *
 * Permette di scrivere nella tab ⚡ Query & Aggregate i comandi nella lingua
 * nativa di MongoDB, esattamente come nella shell:
 *
 *   db.users.find({ age: { $gt: 30 } }, { name: 1 }).sort({ name: 1 }).limit(20)
 *   db.orders.aggregate([ { $group: { _id: "$city", n: { $sum: 1 } } } ])
 *   db.users.countDocuments({ active: true })
 *   db.users.distinct("city", { country: "IT" })
 *   db.users.findOne({ _id: ObjectId("665f...") })
 *
 * Gli argomenti sono JavaScript, non JSON: chiavi non quotate, apici singoli,
 * virgole finali, letterali regex `/.../flags` e costruttori BSON tipici della
 * shell (`ObjectId`, `ISODate`/`Date`, `NumberLong`, `NumberInt`,
 * `NumberDecimal`, `UUID`). Vengono convertiti nella forma **Extended JSON**
 * canonica (`$oid`, `$date`, `$numberLong`, ...) così le strategie li ricostr-
 * uiscono con `EJSON.parse`. Nessun `eval`, nessun accesso al DB.
 *
 * Restituisce lo stesso descrittore del traduttore SQL→MQL:
 *   { kind: 'find', coll, filter, projection, sort, limit, skip }
 *   { kind: 'aggregate', coll, pipeline }
 * così `query:execute` può instradare i due motori sullo stesso codice.
 *
 * Le operazioni di scrittura shell (insertOne/updateMany/deleteMany...) vengono
 * riconosciute e **rifiutate con un messaggio esplicito**: le scritture si fanno
 * dalla vista Dati o con una pipeline $out/$merge.
 */

const READ_METHODS = new Set([
  'find', 'findOne', 'aggregate', 'count', 'countDocuments',
  'estimatedDocumentCount', 'distinct',
]);
const WRITE_METHODS = new Set([
  'insertOne', 'insertMany', 'insert', 'updateOne', 'updateMany', 'update',
  'replaceOne', 'deleteOne', 'deleteMany', 'remove', 'save', 'bulkWrite',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'drop',
  'createIndex', 'dropIndex', 'renameCollection',
]);
// Metodi di cursore no-op ai fini della query (li ignoriamo se in catena).
const IGNORED_CHAIN = new Set([
  'toArray', 'pretty', 'allowDiskUse', 'hint', 'collation', 'batchSize',
  'maxTimeMS', 'readPref', 'readConcern', 'comment', 'explain',
]);

/* --------------------------------------------------------------------------
 * Tokenizer (valori JavaScript + accesso ai membri con ".")
 * ------------------------------------------------------------------------ */

function tokenize(src) {
  const tokens = [];
  const s = String(src);
  let i = 0;
  const n = s.length;
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = s[i];

    if (/\s/.test(c)) { i++; continue; }

    // Commenti // e /* */
    if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }

    // Stringhe ' " `
    if (c === "'" || c === '"' || c === '`') {
      const q = c; let val = ''; i++;
      while (i < n) {
        if (s[i] === '\\' && i + 1 < n) {
          const nx = s[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' };
          val += map[nx] != null ? map[nx] : nx;
          i += 2; continue;
        }
        if (s[i] === q) { i++; break; }
        val += s[i]; i++;
      }
      tokens.push({ type: 'str', value: val });
      continue;
    }

    // Regex /.../flags — un '/' in posizione di valore inizia sempre una regex
    // (in questa grammatica non esiste la divisione).
    if (c === '/' && regexAllowed(tokens)) {
      let pattern = ''; i++;
      let inClass = false;
      while (i < n) {
        const ch = s[i];
        if (ch === '\\' && i + 1 < n) { pattern += ch + s[i + 1]; i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i++; break; }
        pattern += ch; i++;
      }
      let flags = '';
      while (i < n && /[a-z]/i.test(s[i])) { flags += s[i]; i++; }
      tokens.push({ type: 'regex', value: { pattern, flags } });
      continue;
    }

    // Numeri (con eventuale segno e notazione esponenziale)
    if (/[0-9]/.test(c) || ((c === '-' || c === '+') && /[0-9.]/.test(s[i + 1] || '')) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let val = c; i++;
      while (i < n && /[0-9.eE]/.test(s[i])) { val += s[i]; i++; }
      if ((s[i] === '+' || s[i] === '-') && /[eE]/.test(s[i - 1])) { val += s[i]; i++; while (i < n && /[0-9]/.test(s[i])) { val += s[i]; i++; } }
      tokens.push({ type: 'num', value: Number(val) });
      continue;
    }

    // Punteggiatura
    if ('{}[]():,.'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i++; continue;
    }

    // Identificatori / parole chiave
    if (isIdentStart(c)) {
      let val = ''; while (i < n && isIdentPart(s[i])) { val += s[i]; i++; }
      tokens.push({ type: 'ident', value: val });
      continue;
    }

    if (c === ';') { i++; continue; } // separatore/terminatore ignorato

    throw new Error(`Carattere non riconosciuto: "${c}"`);
  }

  return tokens;
}

// Una regex può iniziare solo dove ci si aspetta un valore: a inizio input o
// dopo ( [ { , : (mai dopo un valore/identificatore/parentesi chiusa).
function regexAllowed(tokens) {
  const t = tokens[tokens.length - 1];
  if (!t) return true;
  if (t.type === 'punct') return '([{,:'.includes(t.value);
  return false;
}

/* --------------------------------------------------------------------------
 * Parser
 * ------------------------------------------------------------------------ */

class Parser {
  constructor(tokens) { this.toks = tokens; this.pos = 0; }
  peek(o = 0) { return this.toks[this.pos + o] || null; }
  next() { return this.toks[this.pos++] || null; }
  eof() { return this.pos >= this.toks.length; }
  isPunct(ch) { const t = this.peek(); return t && t.type === 'punct' && t.value === ch; }
  eatPunct(ch) { if (this.isPunct(ch)) { this.pos++; return true; } return false; }
  expectPunct(ch) {
    if (!this.eatPunct(ch)) { const t = this.peek(); throw new Error(`Atteso "${ch}"${t ? `, trovato "${fmt(t)}"` : ' a fine query'}.`); }
  }
  isIdent() { const t = this.peek(); return t && t.type === 'ident'; }
  expectIdent() {
    const t = this.peek();
    if (!t || t.type !== 'ident') throw new Error(`Atteso un nome${t ? `, trovato "${fmt(t)}"` : ' a fine query'}.`);
    this.pos++; return t.value;
  }
}

function fmt(t) { return t && t.value != null ? String(typeof t.value === 'object' ? JSON.stringify(t.value) : t.value) : '?'; }

// Valore JS → forma EJSON-canonica (oggetti/array plain, tipi BSON come $oid...)
function parseValue(p) {
  const t = p.peek();
  if (!t) throw new Error('Valore atteso, trovato fine query.');

  if (t.type === 'num') { p.next(); return t.value; }
  if (t.type === 'str') { p.next(); return t.value; }
  if (t.type === 'regex') { p.next(); return { $regularExpression: { pattern: t.value.pattern, options: t.value.flags || '' } }; }
  if (t.type === 'punct' && t.value === '{') return parseObject(p);
  if (t.type === 'punct' && t.value === '[') return parseArray(p);

  if (t.type === 'ident') {
    const word = t.value;
    const lower = word.toLowerCase();
    if (lower === 'true') { p.next(); return true; }
    if (lower === 'false') { p.next(); return false; }
    if (lower === 'null' || lower === 'undefined') { p.next(); return null; }
    // new Costruttore(...)
    if (word === 'new') { p.next(); return parseConstructor(p, p.expectIdent()); }
    // Costruttore(...)
    if (p.peek(1) && p.peek(1).type === 'punct' && p.peek(1).value === '(') {
      p.next();
      return parseConstructor(p, word);
    }
    throw new Error(`Valore non valido: "${word}". Le stringhe vanno tra apici.`);
  }

  throw new Error(`Valore non valido: "${fmt(t)}".`);
}

function parseObject(p) {
  p.expectPunct('{');
  const obj = {};
  if (p.eatPunct('}')) return obj;
  do {
    if (p.isPunct('}')) break; // virgola finale
    const kt = p.peek();
    let key;
    if (kt && (kt.type === 'ident')) { p.next(); key = kt.value; }
    else if (kt && kt.type === 'str') { p.next(); key = kt.value; }
    else if (kt && kt.type === 'num') { p.next(); key = String(kt.value); }
    else throw new Error(`Chiave di oggetto non valida${kt ? `: "${fmt(kt)}"` : ''}.`);
    p.expectPunct(':');
    obj[key] = parseValue(p);
  } while (p.eatPunct(','));
  p.expectPunct('}');
  return obj;
}

function parseArray(p) {
  p.expectPunct('[');
  const arr = [];
  if (p.eatPunct(']')) return arr;
  do {
    if (p.isPunct(']')) break; // virgola finale
    arr.push(parseValue(p));
  } while (p.eatPunct(','));
  p.expectPunct(']');
  return arr;
}

// Costruttori BSON della shell → EJSON canonico.
function parseConstructor(p, name) {
  p.expectPunct('(');
  const args = [];
  if (!p.isPunct(')')) {
    do { args.push(parseValue(p)); } while (p.eatPunct(','));
  }
  p.expectPunct(')');

  switch (name) {
    case 'ObjectId':
    case 'ObjectID': {
      if (args.length === 0) throw new Error('ObjectId() richiede l\'id esadecimale come argomento.');
      return { $oid: String(args[0]) };
    }
    case 'ISODate':
    case 'Date': {
      const v = args.length ? args[0] : new Date().toISOString();
      if (typeof v === 'number') return { $date: new Date(v).toISOString() };
      return { $date: String(v) };
    }
    case 'NumberLong': return { $numberLong: String(args[0]) };
    case 'NumberInt': return { $numberInt: String(args[0]) };
    case 'NumberDecimal': return { $numberDecimal: String(args[0]) };
    case 'NumberDouble':
    case 'Double': return Number(args[0]);
    case 'UUID':
    case 'BinData':
      throw new Error(`Il costruttore ${name}() non è ancora supportato dal parser shell.`);
    default:
      throw new Error(`Costruttore sconosciuto: ${name}().`);
  }
}

// Lista di argomenti di una chiamata di metodo: '(' [value (',' value)*] ')'
function parseCallArgs(p) {
  p.expectPunct('(');
  const args = [];
  if (!p.isPunct(')')) {
    do { args.push(parseValue(p)); } while (p.eatPunct(','));
  }
  p.expectPunct(')');
  return args;
}

/* --------------------------------------------------------------------------
 * Traduzione del comando db.<coll>.<method>(...)[.<chain>(...)]
 * ------------------------------------------------------------------------ */

function translate(code) {
  const raw = String(code || '').trim().replace(/;\s*$/, '');
  const tokens = tokenize(raw);
  const p = new Parser(tokens);

  const head = p.expectIdent();
  if (head !== 'db') throw new Error('I comandi shell devono iniziare con "db." (es. db.utenti.find({...})).');
  p.expectPunct('.');
  const coll = p.expectIdent();
  p.expectPunct('.');
  const method = p.expectIdent();
  const args = parseCallArgs(p);

  if (WRITE_METHODS.has(method)) {
    // Questo traduttore produce un piano di SOLA LETTURA (find/aggregate): una
    // scrittura non è rappresentabile. Non è però più un vicolo cieco — l'errore
    // è marcato, e `query:execute` lo riconosce per instradare il comando
    // all'interprete di script (db/MongoScriptRunner.js), che le scritture le
    // esegue davvero.
    const err = new Error(`L'operazione di scrittura "${method}()" non è eseguibile da qui: usa la vista Dati oppure una pipeline con $out/$merge.`);
    err.scritturaShell = true;
    err.metodo = method;
    throw err;
  }
  if (!READ_METHODS.has(method)) {
    const err = new Error(`Metodo "${method}()" non supportato. Usa find, findOne, aggregate, countDocuments o distinct.`);
    err.metodoSconosciuto = method;
    throw err;
  }

  const op = buildBaseOp(method, args, coll);

  // Catena: .sort(...).skip(...).limit(...).projection(...).count()...
  while (p.eatPunct('.')) {
    const m = p.expectIdent();
    const cargs = parseCallArgs(p);
    applyChain(op, m, cargs);
  }
  if (!p.eof()) { const t = p.peek(); throw new Error(`Token inatteso a fine comando: "${fmt(t)}".`); }

  return finalizeOp(op);
}

function asObject(v, label) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} deve essere un oggetto.`);
  return v;
}

function buildBaseOp(method, args, coll) {
  switch (method) {
    case 'find':
      return { type: 'find', coll, filter: asObject(args[0], 'Il filtro'), projection: asObject(args[1], 'La proiezione'), sort: {}, limit: null, skip: 0 };
    case 'findOne':
      return { type: 'find', coll, filter: asObject(args[0], 'Il filtro'), projection: asObject(args[1], 'La proiezione'), sort: {}, limit: 1, skip: 0 };
    case 'aggregate': {
      if (!Array.isArray(args[0])) throw new Error('aggregate() richiede un array di stadi (pipeline).');
      return { type: 'aggregate', coll, pipeline: args[0], extra: [] };
    }
    case 'count':
    case 'countDocuments':
    case 'estimatedDocumentCount':
      return { type: 'count', coll, filter: asObject(args[0], 'Il filtro') };
    case 'distinct': {
      const field = args[0];
      if (typeof field !== 'string' || !field) throw new Error('distinct() richiede il nome del campo come stringa.');
      return { type: 'distinct', coll, field, filter: asObject(args[1], 'Il filtro') };
    }
    default:
      throw new Error(`Metodo "${method}()" non supportato.`);
  }
}

function applyChain(op, method, args) {
  if (IGNORED_CHAIN.has(method)) return;

  if (method === 'count') {
    // cursor.count() → trasforma un find in un conteggio
    if (op.type !== 'find') throw new Error('.count() è applicabile solo a find().');
    op.type = 'count';
    return;
  }

  if (op.type === 'find') {
    switch (method) {
      case 'sort': op.sort = asObject(args[0], 'sort()'); return;
      case 'limit': op.limit = intArg(args[0], 'limit'); return;
      case 'skip': op.skip = intArg(args[0], 'skip'); return;
      case 'project':
      case 'projection': op.projection = asObject(args[0], 'projection()'); return;
      default: throw new Error(`Metodo di cursore "${method}()" non supportato su find().`);
    }
  }

  if (op.type === 'aggregate') {
    switch (method) {
      case 'sort': op.extra.push({ $sort: asObject(args[0], 'sort()') }); return;
      case 'limit': op.extra.push({ $limit: intArg(args[0], 'limit') }); return;
      case 'skip': op.extra.push({ $skip: intArg(args[0], 'skip') }); return;
      default: throw new Error(`Metodo "${method}()" non supportato su aggregate().`);
    }
  }

  throw new Error(`Metodo "${method}()" non concatenabile qui.`);
}

function intArg(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label}() richiede un numero.`);
  return Math.trunc(v);
}

// Normalizza l'operazione nel descrittore comune { kind:'find'|'aggregate' }.
function finalizeOp(op) {
  if (op.type === 'find') {
    return {
      kind: 'find',
      coll: op.coll,
      filter: op.filter || {},
      projection: op.projection || {},
      sort: op.sort || {},
      limit: op.limit != null ? op.limit : 50,
      skip: op.skip || 0,
    };
  }
  if (op.type === 'aggregate') {
    return { kind: 'aggregate', coll: op.coll, pipeline: [...op.pipeline, ...(op.extra || [])] };
  }
  if (op.type === 'count') {
    const pipeline = [];
    if (op.filter && Object.keys(op.filter).length) pipeline.push({ $match: op.filter });
    pipeline.push({ $count: 'count' });
    return { kind: 'aggregate', coll: op.coll, pipeline };
  }
  if (op.type === 'distinct') {
    // La colonna di output usa un nome piatto: un campo annidato (es. "a.b")
    // come chiave di $project creerebbe un oggetto nidificato { a: { b: ... } }
    // invece di una colonna singola. Si appiattisce il punto in underscore.
    const outKey = op.field.includes('.') ? op.field.replace(/\./g, '_') : op.field;
    const pipeline = [];
    if (op.filter && Object.keys(op.filter).length) pipeline.push({ $match: op.filter });
    pipeline.push({ $group: { _id: `$${op.field}` } });
    pipeline.push({ $project: { _id: 0, [outKey]: '$_id' } });
    pipeline.push({ $sort: { [outKey]: 1 } });
    return { kind: 'aggregate', coll: op.coll, pipeline };
  }
  throw new Error('Operazione non riconosciuta.');
}

// Euristica: la stringa è un comando shell mongosh (db.<coll>.<metodo>(...))?
function looksLikeShell(code) {
  return /^\s*db\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$]/.test(String(code || ''));
}

module.exports = { translate, looksLikeShell, tokenize };
