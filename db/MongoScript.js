'use strict';

const VOCABOLARIO_COSTRUTTORI = require('../public/js/costruttori-bson');
const { eseguiRegexIsolata } = require('./regexIsolata');

/**
 * CodeDB — Interprete di script MongoDB (dialetto mongosh)
 *
 * Esegue nella tab ⚡ Query & Aggregate script veri, non singoli comandi:
 *
 *   const soglia = 100;
 *   for (const p of db.prodotti.find({ prezzo: { $gt: soglia } }).toArray()) {
 *     db.report.insertOne({ nome: p.nome, prezzo: p.prezzo });
 *   }
 *   print('fatto:', db.report.countDocuments({}));
 *
 * ---------------------------------------------------------------------------
 * PERCHÉ UN INTERPRETE E NON `eval`
 *
 * `eval`/`new Function` eseguirebbero il codice dell'utente CON I PRIVILEGI DEL
 * PROCESSO CodeDB: accesso a `require`, `process`, al filesystem, alle
 * credenziali in memoria e al vault. Sarebbe un'esecuzione remota di codice
 * offerta a chiunque possa aprire la UI. Qui il codice viene invece
 * tokenizzato, trasformato in AST e VALUTATO nodo per nodo: l'unica cosa che
 * uno script può toccare è ciò che l'ambiente espone esplicitamente.
 *
 * Le tre proprietà su cui poggia la sicurezza:
 *
 *  1. **Nessun accesso alle globali.** Un identificatore non dichiarato dallo
 *     script si risolve solo nella tabella `GLOBALI` di questo file. `require`,
 *     `process`, `global`, `Function` non esistono per lo script.
 *
 *  2. **Accesso ai membri su whitelist per tipo** (`getMember`). È il punto
 *     più delicato: senza, `[].constructor.constructor('return process')()`
 *     ricostruirebbe `Function` e vanificherebbe tutto il resto. Nomi come
 *     `constructor`, `__proto__` e `prototype` sono negati sempre, e sui valori
 *     nativi si può chiamare solo ciò che è elencato qui.
 *
 *  3. **Chiamabile solo ciò che è stato creato qui.** Si possono invocare le
 *     funzioni definite dallo script, i metodi ottenuti dalla whitelist e le
 *     funzioni dell'ambiente. Mai una funzione nativa arrivata per altre vie.
 *
 * Le operazioni sul database passano tutte dall'`host` (iniettato da
 * `server.js` e legato alla strategia della sessione), quindi restano **sotto
 * il Proxy autorizzante**: l'RBAC vale per ogni chiamata dello script senza
 * una sola riga di codice dedicata qui dentro.
 *
 * Ci sono infine dei BUDGET (passi, iterazioni, tempo, chiamate al DB, output):
 * un `while(true)` scritto per sbaglio deve fermare sé stesso, non il server.
 * ---------------------------------------------------------------------------
 */

/* ==========================================================================
 * 1. Tokenizer
 * ========================================================================== */

const PAROLE_CHIAVE = new Set([
  'var', 'let', 'const', 'if', 'else', 'for', 'of', 'in', 'while', 'do',
  'break', 'continue', 'return', 'function', 'true', 'false', 'null',
  'undefined', 'typeof', 'new', 'try', 'catch', 'finally', 'throw', 'delete',
  'instanceof', 'void',
]);

// Operatori dal più lungo al più corto: l'ordine è ciò che permette di
// riconoscere `===` invece di `==` seguito da `=`.
const OPERATORI = [
  '===', '!==', '**=', '...',
  '==', '!=', '<=', '>=', '&&', '||', '??', '=>', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '**',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '?', ':', '.', ',', ';',
  '(', ')', '[', ']', '{', '}',
];

function tokenize(src) {
  const s = String(src == null ? '' : src);
  const toks = [];
  let i = 0;
  let line = 1;
  const n = s.length;

  const identStart = (c) => /[A-Za-z_$]/.test(c);
  const identPart = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = s[i];

    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }

    // Commenti
    if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }

    // Stringhe normali
    if (c === "'" || c === '"') {
      const q = c;
      let val = '';
      i++;
      while (i < n && s[i] !== q) {
        if (s[i] === '\\') { val += decodeEscape(s[i + 1]); i += 2; continue; }
        if (s[i] === '\n') line++;
        val += s[i];
        i++;
      }
      if (i >= n) throw errore(`Stringa non chiusa`, line);
      i++;
      toks.push({ t: 'str', v: val, line });
      continue;
    }

    // Template literal con interpolazione: `testo ${espressione} testo`
    if (c === '`') {
      const parti = [];
      const espressioni = [];
      let val = '';
      i++;
      while (i < n && s[i] !== '`') {
        if (s[i] === '\\') { val += decodeEscape(s[i + 1]); i += 2; continue; }
        if (s[i] === '$' && s[i + 1] === '{') {
          parti.push(val);
          val = '';
          i += 2;
          let livello = 1;
          let sub = '';
          while (i < n && livello > 0) {
            if (s[i] === '{') livello++;
            else if (s[i] === '}') { livello--; if (!livello) break; }
            if (s[i] === '\n') line++;
            sub += s[i];
            i++;
          }
          i++; // '}'
          espressioni.push(sub);
          continue;
        }
        if (s[i] === '\n') line++;
        val += s[i];
        i++;
      }
      if (i >= n) throw errore('Template literal non chiuso', line);
      i++;
      parti.push(val);
      toks.push({ t: 'tpl', v: { parti, espressioni }, line });
      continue;
    }

    // Regex /.../flags — ammessa solo dove ci si aspetta un valore
    if (c === '/' && regexAmmessa(toks)) {
      let pattern = '';
      let inClasse = false;
      i++;
      while (i < n) {
        const ch = s[i];
        if (ch === '\\') { pattern += ch + s[i + 1]; i += 2; continue; }
        if (ch === '[') inClasse = true;
        else if (ch === ']') inClasse = false;
        else if (ch === '/' && !inClasse) { i++; break; }
        if (ch === '\n') throw errore('Regex non chiusa', line);
        pattern += ch;
        i++;
      }
      let flags = '';
      while (i < n && /[a-z]/i.test(s[i])) { flags += s[i]; i++; }
      toks.push({ t: 'regex', v: { pattern, flags }, line });
      continue;
    }

    // Numeri
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let val = '';
      while (i < n && /[0-9._]/.test(s[i])) { val += s[i]; i++; }
      if (/[eE]/.test(s[i] || '')) {
        val += s[i]; i++;
        if (s[i] === '+' || s[i] === '-') { val += s[i]; i++; }
        while (i < n && /[0-9]/.test(s[i])) { val += s[i]; i++; }
      }
      toks.push({ t: 'num', v: Number(val.replace(/_/g, '')), line });
      continue;
    }

    // Identificatori e parole chiave
    if (identStart(c)) {
      let val = '';
      while (i < n && identPart(s[i])) { val += s[i]; i++; }
      toks.push({ t: PAROLE_CHIAVE.has(val) ? 'kw' : 'ident', v: val, line });
      continue;
    }

    // Operatori e punteggiatura
    const op = OPERATORI.find((o) => s.startsWith(o, i));
    if (op) {
      toks.push({ t: 'op', v: op, line });
      i += op.length;
      continue;
    }

    throw errore(`Carattere non riconosciuto: "${c}"`, line);
  }

  toks.push({ t: 'eof', v: null, line });
  return toks;
}

function decodeEscape(ch) {
  const mappa = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
  return mappa[ch] != null ? mappa[ch] : (ch == null ? '' : ch);
}

function regexAmmessa(toks) {
  const t = toks[toks.length - 1];
  if (!t) return true;
  if (t.t === 'op') return !')]}'.includes(t.v) && t.v !== '++' && t.v !== '--';
  if (t.t === 'kw') return t.v !== 'true' && t.v !== 'false' && t.v !== 'null';
  return false;
}

function errore(msg, line) {
  const err = new Error(line ? `${msg} (riga ${line})` : msg);
  err.scriptLine = line || null;
  return err;
}

/* ==========================================================================
 * 2. Parser → AST
 * ========================================================================== */

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }

  peek(o = 0) { return this.toks[this.i + o]; }
  get line() { return (this.peek() || {}).line || 0; }
  next() { return this.toks[this.i++]; }

  isOp(v, o = 0) { const t = this.peek(o); return t && t.t === 'op' && t.v === v; }
  isKw(v, o = 0) { const t = this.peek(o); return t && t.t === 'kw' && t.v === v; }

  eatOp(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  eatKw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }

  expectOp(v) {
    if (!this.eatOp(v)) throw errore(`Atteso "${v}"`, this.line);
  }

  expectIdent() {
    const t = this.peek();
    if (!t || (t.t !== 'ident' && t.t !== 'kw')) throw errore('Atteso un nome', this.line);
    this.i++;
    return t.v;
  }

  // Il `;` è opzionale (ASI semplificato): lo si consuma se c'è.
  eatSemi() { while (this.eatOp(';')) { /* niente */ } }

  parseProgram() {
    const body = [];
    while (this.peek().t !== 'eof') {
      body.push(this.parseStatement());
      this.eatSemi();
    }
    return { type: 'Program', body };
  }

  parseStatement() {
    const line = this.line;

    if (this.isOp('{')) return this.parseBlock();
    if (this.isKw('var') || this.isKw('let') || this.isKw('const')) return this.parseVarDecl();
    if (this.isKw('if')) return this.parseIf();
    if (this.isKw('for')) return this.parseFor();
    if (this.isKw('while')) return this.parseWhile();
    if (this.isKw('do')) return this.parseDoWhile();
    if (this.isKw('function') && this.peek(1) && this.peek(1).t === 'ident') return this.parseFunctionDecl();
    if (this.isKw('try')) return this.parseTry();

    if (this.eatKw('return')) {
      const arg = (this.isOp(';') || this.isOp('}') || this.peek().t === 'eof') ? null : this.parseExpression();
      return { type: 'Return', arg, line };
    }
    if (this.eatKw('break')) return { type: 'Break', line };
    if (this.eatKw('continue')) return { type: 'Continue', line };
    if (this.eatKw('throw')) return { type: 'Throw', arg: this.parseExpression(), line };

    const expr = this.parseExpression();
    return { type: 'ExprStmt', expr, line };
  }

  parseBlock() {
    const line = this.line;
    this.expectOp('{');
    const body = [];
    while (!this.isOp('}')) {
      if (this.peek().t === 'eof') throw errore('Blocco "{" non chiuso', line);
      body.push(this.parseStatement());
      this.eatSemi();
    }
    this.expectOp('}');
    return { type: 'Block', body, line };
  }

  parseVarDecl() {
    const line = this.line;
    const kind = this.next().v;
    const decls = [];
    do {
      const name = this.expectIdent();
      let init = null;
      if (this.eatOp('=')) init = this.parseAssignment();
      decls.push({ name, init });
    } while (this.eatOp(','));
    return { type: 'VarDecl', kind, decls, line };
  }

  parseIf() {
    const line = this.line;
    this.eatKw('if');
    this.expectOp('(');
    const test = this.parseExpression();
    this.expectOp(')');
    const cons = this.parseStatement();
    let alt = null;
    this.eatSemi();
    if (this.eatKw('else')) alt = this.parseStatement();
    return { type: 'If', test, cons, alt, line };
  }

  parseFor() {
    const line = this.line;
    this.eatKw('for');
    this.expectOp('(');

    // for (const x of ...) / for (const k in ...)
    const salvato = this.i;
    let kind = null;
    if (this.isKw('var') || this.isKw('let') || this.isKw('const')) kind = this.next().v;
    if (this.peek().t === 'ident') {
      const name = this.peek().v;
      if (this.isKw('of', 1) || this.isKw('in', 1)) {
        this.i++;
        const modo = this.next().v; // of | in
        const right = this.parseExpression();
        this.expectOp(')');
        const body = this.parseStatement();
        return { type: modo === 'of' ? 'ForOf' : 'ForIn', kind, name, right, body, line };
      }
    }
    this.i = salvato;

    const init = this.isOp(';') ? null
      : (this.isKw('var') || this.isKw('let') || this.isKw('const')) ? this.parseVarDecl()
        : { type: 'ExprStmt', expr: this.parseExpression(), line };
    this.expectOp(';');
    const test = this.isOp(';') ? null : this.parseExpression();
    this.expectOp(';');
    const update = this.isOp(')') ? null : this.parseExpression();
    this.expectOp(')');
    const body = this.parseStatement();
    return { type: 'For', init, test, update, body, line };
  }

  parseWhile() {
    const line = this.line;
    this.eatKw('while');
    this.expectOp('(');
    const test = this.parseExpression();
    this.expectOp(')');
    const body = this.parseStatement();
    return { type: 'While', test, body, line };
  }

  parseDoWhile() {
    const line = this.line;
    this.eatKw('do');
    const body = this.parseStatement();
    this.eatSemi();
    if (!this.eatKw('while')) throw errore('Atteso "while" dopo "do"', this.line);
    this.expectOp('(');
    const test = this.parseExpression();
    this.expectOp(')');
    return { type: 'DoWhile', test, body, line };
  }

  parseFunctionDecl() {
    const line = this.line;
    this.eatKw('function');
    const name = this.expectIdent();
    const params = this.parseParams();
    const body = this.parseBlock();
    return { type: 'FuncDecl', name, params, body, line };
  }

  parseTry() {
    const line = this.line;
    this.eatKw('try');
    const block = this.parseBlock();
    let param = null;
    let handler = null;
    let finalizer = null;
    if (this.eatKw('catch')) {
      if (this.eatOp('(')) { param = this.expectIdent(); this.expectOp(')'); }
      handler = this.parseBlock();
    }
    if (this.eatKw('finally')) finalizer = this.parseBlock();
    if (!handler && !finalizer) throw errore('"try" senza "catch" né "finally"', line);
    return { type: 'Try', block, param, handler, finalizer, line };
  }

  parseParams() {
    this.expectOp('(');
    const params = [];
    while (!this.isOp(')')) {
      params.push(this.expectIdent());
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')');
    return params;
  }

  /* --- Espressioni (precedenza crescente) --- */

  parseExpression() { return this.parseAssignment(); }

  parseAssignment() {
    const start = this.i;
    const left = this.parseConditional();
    const t = this.peek();
    if (t && t.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(t.v)) {
      if (left.type !== 'Ident' && left.type !== 'Member') {
        throw errore('Assegnamento a un bersaglio non valido', t.line);
      }
      this.i++;
      const value = this.parseAssignment();
      return { type: 'Assign', op: t.v, target: left, value, line: t.line };
    }
    void start;
    return left;
  }

  parseConditional() {
    const test = this.parseNullish();
    if (this.eatOp('?')) {
      const cons = this.parseAssignment();
      this.expectOp(':');
      const alt = this.parseAssignment();
      return { type: 'Cond', test, cons, alt };
    }
    return test;
  }

  parseNullish() {
    let left = this.parseOr();
    while (this.isOp('??')) { this.i++; left = { type: 'Logical', op: '??', left, right: this.parseOr() }; }
    return left;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isOp('||')) { this.i++; left = { type: 'Logical', op: '||', left, right: this.parseAnd() }; }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.isOp('&&')) { this.i++; left = { type: 'Logical', op: '&&', left, right: this.parseEquality() }; }
    return left;
  }

  parseEquality() {
    let left = this.parseRelational();
    while (this.isOp('===') || this.isOp('!==') || this.isOp('==') || this.isOp('!=')) {
      const op = this.next().v;
      left = { type: 'Binary', op, left, right: this.parseRelational() };
    }
    return left;
  }

  parseRelational() {
    let left = this.parseAdditive();
    while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=') || this.isKw('in') || this.isKw('instanceof')) {
      const t = this.next();
      left = { type: 'Binary', op: t.v, left, right: this.parseAdditive() };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      left = { type: 'Binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%') || this.isOp('**')) {
      const op = this.next().v;
      left = { type: 'Binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '!' || t.v === '-' || t.v === '+')) {
      this.i++;
      return { type: 'Unary', op: t.v, arg: this.parseUnary(), line: t.line };
    }
    if (t.t === 'kw' && (t.v === 'typeof' || t.v === 'void' || t.v === 'delete')) {
      this.i++;
      return { type: 'Unary', op: t.v, arg: this.parseUnary(), line: t.line };
    }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.i++;
      return { type: 'Update', op: t.v, prefix: true, arg: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    const expr = this.parseCallMember();
    const t = this.peek();
    if (t && t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.i++;
      return { type: 'Update', op: t.v, prefix: false, arg: expr, line: t.line };
    }
    return expr;
  }

  parseCallMember() {
    let obj = this.parsePrimary();
    for (;;) {
      if (this.isOp('.')) {
        this.i++;
        const name = this.expectIdent();
        obj = { type: 'Member', obj, prop: { type: 'Str', value: name }, computed: false, line: this.line };
      } else if (this.isOp('[')) {
        this.i++;
        const prop = this.parseExpression();
        this.expectOp(']');
        obj = { type: 'Member', obj, prop, computed: true, line: this.line };
      } else if (this.isOp('(')) {
        const args = this.parseArgs();
        obj = { type: 'Call', callee: obj, args, line: this.line };
      } else {
        return obj;
      }
    }
  }

  parseArgs() {
    this.expectOp('(');
    const args = [];
    while (!this.isOp(')')) {
      args.push(this.parseAssignment());
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')');
    return args;
  }

  parsePrimary() {
    const t = this.peek();
    const line = t.line;

    if (t.t === 'num') { this.i++; return { type: 'Num', value: t.v }; }
    if (t.t === 'str') { this.i++; return { type: 'Str', value: t.v }; }
    if (t.t === 'regex') { this.i++; return { type: 'Regex', value: t.v }; }
    if (t.t === 'tpl') {
      this.i++;
      // Le espressioni interpolate vengono analizzate ora, non a runtime:
      // così un errore di sintassi si vede prima di eseguire qualsiasi cosa.
      const exprs = t.v.espressioni.map((src) => parseEspressione(src, line));
      return { type: 'Tpl', parti: t.v.parti, exprs };
    }

    if (t.t === 'kw') {
      if (t.v === 'true') { this.i++; return { type: 'Bool', value: true }; }
      if (t.v === 'false') { this.i++; return { type: 'Bool', value: false }; }
      if (t.v === 'null') { this.i++; return { type: 'Null' }; }
      if (t.v === 'undefined') { this.i++; return { type: 'Undef' }; }
      if (t.v === 'function') {
        this.i++;
        if (this.peek().t === 'ident') this.i++; // nome opzionale
        const params = this.parseParams();
        const body = this.parseBlock();
        return { type: 'Func', params, body, arrow: false, line };
      }
      if (t.v === 'new') {
        this.i++;
        const callee = this.parseCallMemberSenzaChiamata();
        const args = this.isOp('(') ? this.parseArgs() : [];
        return { type: 'New', callee, args, line };
      }
    }

    // Arrow function: (a, b) => ... oppure x => ...
    if (t.t === 'ident' && this.isOp('=>', 1)) {
      this.i += 2;
      return this.parseArrowCorpo([t.v], line);
    }
    if (this.isOp('(')) {
      const salvato = this.i;
      const arrow = this.provaArrow(line);
      if (arrow) return arrow;
      this.i = salvato;
      this.expectOp('(');
      const e = this.parseExpression();
      this.expectOp(')');
      return e;
    }

    if (this.isOp('[')) {
      this.i++;
      const elements = [];
      while (!this.isOp(']')) {
        elements.push(this.parseAssignment());
        if (!this.eatOp(',')) break;
      }
      this.expectOp(']');
      return { type: 'Array', elements, line };
    }

    if (this.isOp('{')) {
      this.i++;
      const props = [];
      while (!this.isOp('}')) {
        let key;
        let computed = false;
        const kt = this.peek();
        if (kt.t === 'str') { this.i++; key = { type: 'Str', value: kt.v }; }
        else if (kt.t === 'num') { this.i++; key = { type: 'Str', value: String(kt.v) }; }
        else if (this.isOp('[')) { this.i++; key = this.parseAssignment(); this.expectOp(']'); computed = true; }
        else key = { type: 'Str', value: this.expectIdent() };

        let value;
        if (this.eatOp(':')) value = this.parseAssignment();
        else value = { type: 'Ident', name: key.value, line }; // forma abbreviata { a }
        props.push({ key, value, computed });
        if (!this.eatOp(',')) break;
      }
      this.expectOp('}');
      return { type: 'Object', props, line };
    }

    if (t.t === 'ident') { this.i++; return { type: 'Ident', name: t.v, line }; }

    throw errore(`Espressione non valida vicino a "${t.v != null ? t.v : t.t}"`, line);
  }

  // `new X.Y(...)`: il callee è il percorso, la chiamata la gestisce parsePrimary.
  parseCallMemberSenzaChiamata() {
    let obj = this.parsePrimary();
    while (this.isOp('.')) {
      this.i++;
      const name = this.expectIdent();
      obj = { type: 'Member', obj, prop: { type: 'Str', value: name }, computed: false };
    }
    return obj;
  }

  provaArrow(line) {
    // `(a, b) =>` : si guarda avanti fino alla parentesi chiusa corrispondente.
    let k = this.i + 1;
    let livello = 1;
    const params = [];
    let atteso = 'nome';
    while (k < this.toks.length && livello > 0) {
      const tk = this.toks[k];
      if (tk.t === 'op' && tk.v === '(') livello++;
      else if (tk.t === 'op' && tk.v === ')') { livello--; if (!livello) break; }
      else if (livello === 1) {
        if (atteso === 'nome' && tk.t === 'ident') { params.push(tk.v); atteso = 'virgola'; }
        else if (atteso === 'virgola' && tk.t === 'op' && tk.v === ',') atteso = 'nome';
        else return null;
      }
      k++;
    }
    const dopo = this.toks[k + 1];
    if (!dopo || dopo.t !== 'op' || dopo.v !== '=>') return null;
    this.i = k + 2;
    return this.parseArrowCorpo(params, line);
  }

  parseArrowCorpo(params, line) {
    if (this.isOp('{')) {
      const body = this.parseBlock();
      return { type: 'Func', params, body, arrow: true, espressione: false, line };
    }
    const expr = this.parseAssignment();
    return { type: 'Func', params, body: expr, arrow: true, espressione: true, line };
  }
}

function parse(code) {
  return new Parser(tokenize(code)).parseProgram();
}

function parseEspressione(src, line) {
  try {
    const p = new Parser(tokenize(src));
    const e = p.parseExpression();
    return e;
  } catch (err) {
    throw errore(`Interpolazione non valida: ${err.message}`, line);
  }
}

/* ==========================================================================
 * 3. Sicurezza dell'accesso ai membri
 * ========================================================================== */

// Nomi negati SEMPRE, su qualunque valore: sono le porte da cui si risalirebbe
// a `Function` e quindi all'esecuzione arbitraria di codice.
const NOMI_VIETATI = new Set([
  'constructor', '__proto__', 'prototype', '__defineGetter__',
  '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

// Metodi ammessi sui valori nativi, per tipo. Ciò che non è qui non esiste.
const METODI_STRINGA = new Set([
  'charAt', 'charCodeAt', 'concat', 'endsWith', 'includes', 'indexOf',
  'lastIndexOf', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll',
  'slice', 'split', 'startsWith', 'substring', 'toLowerCase', 'toUpperCase',
  'trim', 'trimEnd', 'trimStart', 'toString', 'match', 'normalize',
]);
const METODI_ARRAY = new Set([
  'concat', 'every', 'fill', 'filter', 'find', 'findIndex', 'flat', 'forEach',
  'includes', 'indexOf', 'join', 'lastIndexOf', 'map', 'pop', 'push', 'reduce',
  'reverse', 'shift', 'slice', 'some', 'sort', 'splice', 'unshift', 'toString',
]);
const METODI_NUMERO = new Set(['toFixed', 'toPrecision', 'toString']);
const METODI_DATA = new Set([
  'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours',
  'getMinutes', 'getSeconds', 'getMilliseconds', 'toISOString', 'toJSON',
  'toString', 'toDateString', 'valueOf',
]);
const METODI_REGEX = new Set(['test', 'exec', 'toString']);

/* ---------------------------------------------------------------------------
 * Espressioni regolari: l'unico buco nel principio "tutto ha un budget".
 *
 * L'esecuzione di una regex è UNA chiamata nativa, sincrona e non
 * interrompibile: mentre gira, il ciclo di eventi di Node è fermo e nessuno dei
 * budget del runner — che vivono fra un nodo dell'AST e il successivo — può
 * intervenire. `tempoMs` NON è quindi un limite forte finché lo script gira nel
 * processo principale, che ospita tutte le sessioni Socket.IO, il gateway MCP
 * e (nell'app desktop) la finestra Electron: tre righe con un quantificatore
 * annidato congelavano l'applicazione per ogni utente collegato.
 *
 * Due reti, entrambe a costo nullo e nessuna delle due completa:
 *  1. si rifiutano in fase di valutazione i pattern con quantificatore annidato
 *     — `(a+)+`, `(a*)*`, `(a+)*` — cioè la forma che produce il tempo
 *     esponenziale nei casi pratici;
 *  2. si limita la lunghezza del testo su cui una regex può essere applicata.
 * La difesa completa sarebbe eseguire gli script in un worker_thread con
 * `terminate()` alla scadenza; finché non c'è, valgono queste.
 * ------------------------------------------------------------------------- */

/** Testo più lungo di così non viene dato in pasto a una regex. */
const MAX_TESTO_REGEX = 5000;

/**
 * Rifiuta i pattern con un quantificatore applicato a un gruppo che ne contiene
 * già uno. È il caso che esplode: ogni carattere in più raddoppia il tempo.
 */
function assertRegexSicura(pattern, line) {
  const p = String(pattern);
  // Pila dei gruppi aperti: per ognuno si annota se al suo interno è comparso
  // un quantificatore.
  const pila = [];
  let inClasse = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') { i++; continue; }
    if (inClasse) { if (ch === ']') inClasse = false; continue; }
    if (ch === '[') { inClasse = true; continue; }
    if (ch === '(') { pila.push(false); continue; }
    if (ch === ')') {
      const conteneva = pila.pop();
      // Quantificatore SUBITO dopo la parentesi chiusa?
      const dopo = p[i + 1];
      const quantificato = dopo === '*' || dopo === '+'
        || (dopo === '{' && /^\{\d*,?\d*\}/.test(p.slice(i + 1)));
      if (quantificato) {
        if (conteneva) {
          throw errore(
            'Espressione regolare rifiutata: un quantificatore applicato a un gruppo che ne contiene già uno '
            + '(per esempio (a+)+) può richiedere tempo esponenziale e bloccherebbe il server. Riscrivi il pattern.',
            line
          );
        }
        // Il gruppo quantificato conta come quantificatore per chi lo contiene.
        if (pila.length) pila[pila.length - 1] = true;
      }
      continue;
    }
    if (ch === '*' || ch === '+' || (ch === '{' && /^\{\d*,?\d*\}/.test(p.slice(i)))) {
      if (pila.length) pila[pila.length - 1] = true;
    }
  }
  return p;
}

/**
 * Nega l'applicazione di una regex a un testo smisurato. Vale sia per
 * `re.test(s)`/`re.exec(s)` sia per i metodi di stringa che accettano una regex
 * (`match`, `replace`, `search`, `split`), che sono la stessa chiamata nativa
 * non interrompibile vista dall'altro lato.
 */
function assertTestoRegex(target, nome, args) {
  let soggetto = null;
  if (target instanceof RegExp) {
    if (nome === 'test' || nome === 'exec') soggetto = args[0];
  } else if (typeof target === 'string' && args.some((a) => a instanceof RegExp)) {
    soggetto = target;
  }
  if (typeof soggetto === 'string' && soggetto.length > MAX_TESTO_REGEX) {
    throw errore(
      `Espressione regolare applicata a un testo di ${soggetto.length} caratteri: il limite è ${MAX_TESTO_REGEX}. `
      + 'Una regex non è interrompibile e su un testo lungo può bloccare il server.'
    );
  }
}

/**
 * Accesso a una proprietà. È il cuore della sandbox: qui si decide cosa uno
 * script può raggiungere partendo da un valore.
 */
function getMember(obj, name, ctx) {
  if (obj == null) {
    throw errore(`Impossibile leggere "${name}" da ${obj === null ? 'null' : 'undefined'}`);
  }
  const chiave = String(name);
  if (NOMI_VIETATI.has(chiave)) {
    throw errore(`Accesso a "${chiave}" non consentito negli script`);
  }

  // Oggetti dell'ambiente (db, collection, cursore): dispatch proprio.
  if (obj && typeof obj === 'object' && obj.__host) {
    return obj.__get(chiave, ctx);
  }

  // Funzioni dello script e dell'ambiente: non espongono NULLA. In
  // particolare niente `call`/`apply`/`bind`, con cui si cambierebbe il `this`
  // di un metodo nativo per farlo agire su un bersaglio non previsto.
  if (obj && typeof obj === 'object' && (obj.__funzione || obj.__chiamabile)) {
    throw errore('Le funzioni non espongono proprietà negli script');
  }

  if (typeof obj === 'string') {
    if (chiave === 'length') return obj.length;
    if (/^\d+$/.test(chiave)) return obj[Number(chiave)];
    if (METODI_STRINGA.has(chiave)) return legaNativo(obj, chiave, ctx);
    return undefined;
  }

  if (Array.isArray(obj)) {
    if (chiave === 'length') return obj.length;
    if (/^\d+$/.test(chiave)) return obj[Number(chiave)];
    if (METODI_ARRAY.has(chiave)) return legaNativo(obj, chiave, ctx);
    return undefined;
  }

  if (typeof obj === 'number') {
    return METODI_NUMERO.has(chiave) ? legaNativo(obj, chiave, ctx) : undefined;
  }

  if (obj instanceof Date) {
    return METODI_DATA.has(chiave) ? legaNativo(obj, chiave, ctx) : undefined;
  }

  if (obj instanceof RegExp) {
    if (chiave === 'source' || chiave === 'flags' || chiave === 'lastIndex') return obj[chiave];
    return METODI_REGEX.has(chiave) ? legaNativo(obj, chiave, ctx) : undefined;
  }

  if (typeof obj === 'function') {
    // Le funzioni non espongono nulla: né `call`, né `apply`, né `bind`.
    throw errore('Le funzioni non espongono proprietà negli script');
  }

  if (typeof obj === 'object') {
    // Oggetti semplici: SOLO proprietà proprie, mai ereditate dal prototipo.
    return Object.prototype.hasOwnProperty.call(obj, chiave) ? obj[chiave] : undefined;
  }

  return undefined;
}

/**
 * Dimensione stimata del risultato dei metodi nativi che ALLOCANO (CDB-65).
 * Ritorna null per tutti gli altri: non c'è nulla da controllare.
 *
 * Stima per eccesso sulle stringhe (2 byte per carattere, come le stringhe
 * interne di V8) e per difetto sugli array (il solo puntatore): serve a fermare
 * la crescita esplosiva, non a misurare la memoria reale.
 */
function byteStimati(target, nome, args) {
  const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  if (typeof target === 'string') {
    switch (nome) {
      case 'repeat': return target.length * Math.max(n(args[0]), 0) * 2;
      case 'padEnd':
      case 'padStart': return Math.max(n(args[0]), target.length) * 2;
      case 'concat': return (target.length + args.reduce((s, a) => s + String(a == null ? '' : a).length, 0)) * 2;
      case 'split': return target.length * 2 + (target.length + 1) * 8;
      default: return null;
    }
  }
  if (Array.isArray(target)) {
    switch (nome) {
      case 'concat': return (target.length + args.reduce((s, a) => s + (Array.isArray(a) ? a.length : 1), 0)) * 8;
      case 'fill': return target.length * 8;
      case 'flat': return target.length * 8 * Math.max(n(args[0], 1), 1);
      case 'join': return target.length * 16;
      default: return null;
    }
  }
  return null;
}

// Metodo nativo reso invocabile, avvolto in modo che gli argomenti-funzione
// (map/filter/forEach…) siano quelli dello script e non funzioni native.
function legaNativo(target, nome, ctx) {
  return {
    __chiamabile: true,
    __nome: nome,
    async invoca(args) {
      // Budget di memoria PRIMA di allocare: dopo sarebbe inutile, perché è
      // l'allocazione stessa a esaurire l'heap del processo (CDB-65).
      if (ctx && typeof ctx.contaMemoria === 'function') {
        const stima = byteStimati(target, nome, args);
        if (stima != null) ctx.contaMemoria(stima, `il risultato di ${nome}()`);
      }
      // I callback dello script sono asincroni (possono toccare il database):
      // i metodi nativi che li accettano vanno eseguiti a mano, in sequenza,
      // invece di delegarli al motore JS che non li attenderebbe. Questo
      // controllo viene PRIMA di adattare gli argomenti, altrimenti
      // `filter(fn)` verrebbe rifiutato invece di essere eseguito.
      if (ASINCRONI_CON_CALLBACK.has(nome) && isFunzioneScript(args[0])) {
        return eseguiConCallback(target, nome, args[0], ctx, args.slice(1));
      }
      // Una funzione passata a un metodo che non la prevede non ha modo di
      // essere invocata: meglio dirlo che ignorarla.
      if (args.some(isFunzioneScript)) return adattaCallback();
      // Una regex è una chiamata nativa non interrompibile: nessun budget del
      // runner può fermarla una volta partita (vedi la nota su MAX_TESTO_REGEX).
      assertTestoRegex(target, nome, args);
      const usaRegex = (target instanceof RegExp && (nome === 'test' || nome === 'exec'))
        || (typeof target === 'string' && args.some((arg) => arg instanceof RegExp));
      if (usaRegex) return eseguiRegexIsolata(target, nome, args, ctx && ctx.limitiRegex);
      return target[nome](...args);
    },
  };
}

const ASINCRONI_CON_CALLBACK = new Set(['map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every', 'reduce', 'sort']);

async function eseguiConCallback(arr, nome, fn, ctx, resto = []) {
  // La chiamata di una funzione dello script la sa fare solo il valutatore
  // (MongoScriptRunner.js), che la inietta nel contesto: qui si conosce il
  // linguaggio, non come si esegue.
  const chiama = (...args) => ctx.chiamaFunzione(fn, args);
  if (nome === 'forEach') {
    for (let i = 0; i < arr.length; i++) await chiama(arr[i], i, arr);
    return undefined;
  }
  if (nome === 'map') {
    const out = [];
    for (let i = 0; i < arr.length; i++) out.push(await chiama(arr[i], i, arr));
    return out;
  }
  if (nome === 'filter') {
    const out = [];
    for (let i = 0; i < arr.length; i++) if (verita(await chiama(arr[i], i, arr))) out.push(arr[i]);
    return out;
  }
  if (nome === 'find' || nome === 'findIndex') {
    for (let i = 0; i < arr.length; i++) {
      if (verita(await chiama(arr[i], i, arr))) return nome === 'find' ? arr[i] : i;
    }
    return nome === 'find' ? undefined : -1;
  }
  if (nome === 'some') {
    for (let i = 0; i < arr.length; i++) if (verita(await chiama(arr[i], i, arr))) return true;
    return false;
  }
  if (nome === 'every') {
    for (let i = 0; i < arr.length; i++) if (!verita(await chiama(arr[i], i, arr))) return false;
    return true;
  }
  if (nome === 'reduce') {
    // Il valore iniziale è il SECONDO argomento e va letto: ignorarlo non
    // produceva un errore ma un risultato sbagliato in silenzio —
    // [1,2,3].reduce((a,b)=>a+b, 10) dava 6 invece di 16, e con un accumulatore
    // di tipo diverso dagli elementi ([{n:2}].reduce((a,x)=>a+x.n, 0)) dava NaN.
    const conIniziale = resto.length > 0;
    let acc = conIniziale ? resto[0] : arr[0];
    let start = conIniziale ? 0 : 1;
    if (!conIniziale && arr.length === 0) {
      throw errore('reduce() su un array vuoto senza valore iniziale.');
    }
    for (let i = start; i < arr.length; i++) acc = await chiama(acc, arr[i], i, arr);
    return acc;
  }
  if (nome === 'sort') {
    // Ordinamento con comparatore dello script: insertion sort, perché il sort
    // nativo non può attendere un comparatore asincrono.
    const out = [...arr];
    for (let i = 1; i < out.length; i++) {
      const v = out[i];
      let j = i - 1;
      while (j >= 0 && Number(await chiama(out[j], v)) > 0) { out[j + 1] = out[j]; j--; }
      out[j + 1] = v;
    }
    arr.length = 0;
    arr.push(...out);
    return arr;
  }
  return undefined;
}

function adattaCallback() {
  // I metodi nativi che accettano callback sono gestiti da eseguiConCallback:
  // qui si arriva solo per usi non previsti, dove il callback non serve.
  throw errore('Questo metodo non accetta funzioni come argomento negli script');
}

function isFunzioneScript(v) {
  return !!(v && typeof v === 'object' && v.__funzione);
}

/* ==========================================================================
 * 4. Ambiente globale (l'unica cosa raggiungibile per nome)
 * ========================================================================== */

function costruisciGlobali(ctx) {
  const fn = (nome, impl) => ({ __chiamabile: true, __nome: nome, invoca: async (args) => impl(...args) });

  const oggetto = (nome, membri) => ({
    __host: true,
    __nome: nome,
    __get(chiave) {
      if (!Object.prototype.hasOwnProperty.call(membri, chiave)) return undefined;
      return membri[chiave];
    },
  });

  const globali = {
    // Uscita dello script: `print` è il modo mongosh di riportare qualcosa.
    print: fn('print', (...args) => { ctx.stampa(args); }),
    printjson: fn('printjson', (v) => { ctx.stampa([v], true); }),

    // Costruttori BSON: sono VALORI marcati, convertiti in Extended JSON quando
    // vengono passati al database (vedi aEjson).
    ObjectId: fn('ObjectId', (v) => bson('oid', v == null ? null : String(v))),
    ISODate: fn('ISODate', (v) => (v == null ? new Date() : new Date(v))),
    NumberLong: fn('NumberLong', (v) => bson('long', String(v))),
    NumberInt: fn('NumberInt', (v) => bson('int', parseInt(v, 10))),
    NumberDecimal: fn('NumberDecimal', (v) => bson('decimal', String(v))),
    UUID: fn('UUID', (v) => bson('uuid', String(v))),

    parseInt: fn('parseInt', (v, r) => parseInt(v, r || 10)),
    parseFloat: fn('parseFloat', (v) => parseFloat(v)),
    isNaN: fn('isNaN', (v) => Number.isNaN(Number(v))),
    String: fn('String', (v) => (v == null ? String(v) : testo(v))),
    Number: fn('Number', (v) => Number(v)),
    Boolean: fn('Boolean', (v) => verita(v)),

    Date: oggetto('Date', { now: fn('now', () => Date.now()) }),

    JSON: oggetto('JSON', {
      stringify: fn('stringify', (v, _r, spazi) => JSON.stringify(semplifica(v), null, spazi || 0)),
      parse: fn('parse', (v) => JSON.parse(String(v))),
    }),

    Math: oggetto('Math', {
      abs: fn('abs', Math.abs), ceil: fn('ceil', Math.ceil), floor: fn('floor', Math.floor),
      round: fn('round', Math.round), max: fn('max', (...a) => Math.max(...a)),
      min: fn('min', (...a) => Math.min(...a)), pow: fn('pow', Math.pow),
      sqrt: fn('sqrt', Math.sqrt), random: fn('random', Math.random),
      trunc: fn('trunc', Math.trunc),
      PI: Math.PI, E: Math.E,
    }),

    Object: oggetto('Object', {
      keys: fn('keys', (o) => (o && typeof o === 'object' ? Object.keys(o) : [])),
      values: fn('values', (o) => (o && typeof o === 'object' ? Object.values(o) : [])),
      entries: fn('entries', (o) => (o && typeof o === 'object' ? Object.entries(o) : [])),
      assign: fn('assign', (...a) => Object.assign({}, ...a.filter((x) => x && typeof x === 'object'))),
    }),

    Array: oggetto('Array', {
      isArray: fn('isArray', (v) => Array.isArray(v)),
      from: fn('from', (v) => (Array.isArray(v) ? [...v] : [])),
    }),
  };
  for (const nome of VOCABOLARIO_COSTRUTTORI.chiamate) {
    if (!Object.prototype.hasOwnProperty.call(globali, nome)) {
      throw new Error(`Costruttore BSON dichiarato ma non implementato: ${nome}`);
    }
  }
  return globali;
}

function bson(tipo, valore) {
  return { __bson: tipo, valore };
}

/* ==========================================================================
 * 5. Conversioni verso/da il database
 * ========================================================================== */

/**
 * Converte un valore dello script nella forma Extended JSON canonica attesa
 * dalle strategie. È il confine fra il mondo dell'interprete e quello del
 * driver: da qui in poi valgono le regole EJSON documentate in CLAUDE.md.
 */
function aEjson(v) {
  if (v == null) return v;
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v instanceof RegExp) return { $regularExpression: { pattern: v.source, options: v.flags } };
  if (Array.isArray(v)) return v.map(aEjson);
  if (typeof v === 'object') {
    if (v.__bson) {
      switch (v.__bson) {
        case 'oid': return { $oid: v.valore };
        case 'long': return { $numberLong: String(v.valore) };
        case 'int': return { $numberInt: String(v.valore) };
        case 'decimal': return { $numberDecimal: String(v.valore) };
        case 'uuid': return { $uuid: String(v.valore) };
        default: return v.valore;
      }
    }
    if (v.__host || v.__funzione || v.__chiamabile) {
      throw errore('Un oggetto del database o una funzione non può essere usato come valore in una query');
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = aEjson(v[k]);
    return out;
  }
  return v;
}

/** Serializza in stringa EJSON, che è ciò che le strategie accettano. */
function aEjsonStr(v) {
  return JSON.stringify(aEjson(v));
}

/** Rende un valore stampabile/serializzabile in JSON semplice. */
function semplifica(v) {
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(semplifica);
  if (typeof v === 'object') {
    if (v.__bson) return String(v.valore);
    if (v.__host) return `[${v.__nome}]`;
    if (v.__funzione || v.__chiamabile) return '[Function]';
    const out = {};
    for (const k of Object.keys(v)) out[k] = semplifica(v[k]);
    return out;
  }
  return v;
}

function testo(v) {
  if (typeof v === 'string') return v;
  if (v == null) return String(v);
  if (typeof v === 'object') {
    try { return JSON.stringify(semplifica(v)); } catch { return String(v); }
  }
  return String(v);
}

function verita(v) {
  if (v && typeof v === 'object' && v.__bson) return true;
  return !!v;
}

module.exports = {
  tokenize,
  parse,
  getMember,
  aEjson,
  aEjsonStr,
  semplifica,
  testo,
  verita,
  costruisciGlobali,
  bson,
  errore,
  isFunzioneScript,
  assertRegexSicura,
  MAX_TESTO_REGEX,
  NOMI_VIETATI,
};

/* Il valutatore e gli oggetti `db` vivono in MongoScriptRunner.js: questo file
 * si ferma al linguaggio (lessico, sintassi, sandbox dei valori). */
