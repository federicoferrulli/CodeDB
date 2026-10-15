'use strict';
const sql = require('./SqlToMql');
const { leggiEspressione, emettiEspressione } = require('./sqlEspressioni');
const { SESSION, AUTHORIZE, ROUTINE, FLOW } = require('./sqlMongoContesto');
const { quotaSempre } = require('./identificatori');
const CATALOGO = '_codedb_sql_procedures';
const { CONDITION } = require('./sqlSavepointMongo');
const { conditions: condizioniPostgres } = require('./sqlCondizioniPostgres.json');
const STATEMENT_FAILED = Symbol('istruzione SQL da annullare');
const word = p => String(p.peek()?.value || '').toUpperCase();
const eat = (p, s) => word(p) === s && !!p.next();
const expect = (p, s) => { if (!eat(p, s)) throw new Error(`Atteso ${s} nella procedura SQL.`); };
const fine = p => { p.eatPunct(';'); if (!p.eof()) throw new Error(`Testo inatteso dopo la procedura: ${p.peek().value}.`); };

function riconosci(source) { return /^\s*(?:CALL\b|(?:CREATE\s+(?:OR\s+REPLACE\s+)?|DROP\s+)PROCEDURE\b)/i.test(source); }

function parse(source) {
  const p = new sql.Parser(sql.tokenize(source));
  if (eat(p, 'CALL')) {
    const name = p.parseIdent(), args = [];
    p.expectPunct('(');
    if (!p.isPunct(')')) do { args.push(leggiEspressione(p)); } while (p.eatPunct(','));
    p.expectPunct(')'); fine(p);
    for (const expr of args) emettiEspressione(expr, () => { throw new Error('CALL richiede argomenti scalari senza riferimenti a colonne.'); });
    return { op: 'call', name, args };
  }
  if (eat(p, 'DROP')) {
    expect(p, 'PROCEDURE'); const ifExists = eat(p, 'IF'); if (ifExists) expect(p, 'EXISTS');
    const name = p.parseIdent(); if (p.isPunct('(')) { p.next(); p.expectPunct(')'); }
    const cascade = eat(p, 'CASCADE'); eat(p, 'RESTRICT'); fine(p);
    return { op: 'drop', name, ifExists, cascade };
  }
  expect(p, 'CREATE'); const replace = eat(p, 'OR'); if (replace) expect(p, 'REPLACE');
  expect(p, 'PROCEDURE'); const name = p.parseIdent(), params = [];
  p.expectPunct('(');
  if (!p.isPunct(')')) do {
    eat(p, 'IN'); const param = { name: p.parseIdent(), ...require('./sqlSchemaMongo').tipo(p) };
    if (params.some(v => v.name === param.name)) throw new Error('Parametro di procedura duplicato.');
    params.push(param);
  } while (p.eatPunct(','));
  p.expectPunct(')');
  let dialect = 'mysql';
  const language = () => { if (eat(p, 'LANGUAGE')) {
    if (eat(p, 'PLPGSQL')) dialect = 'postgresql';
    else if (!eat(p, 'SQL')) throw new Error('Sono supportati corpi SQL e il sottoinsieme procedurale PL/pgSQL.');
  } };
  const security = () => {
    eat(p, 'SQL'); if (eat(p, 'SECURITY')) expect(p, 'INVOKER');
  };
  language(); security();
  let body, bound = false;
  if (eat(p, 'AS')) {
    const text = p.next(); if (text?.type !== 'str') throw new Error('AS richiede un corpo SQL tra apici o dollar quote.');
    const q = new sql.Parser(sql.tokenize(text.value));
    const declarations = [];
    if (eat(q, 'DECLARE')) while (word(q) !== 'BEGIN' && !q.eof()) {
      const name = q.parseIdent();
      if (eat(q, 'CURSOR')) { expect(q, 'FOR'); declarations.push(cursore(q, name)); q.expectPunct(';'); continue; }
      const type = require('./sqlSchemaMongo').tipo(q);
      const expr = eat(q, ':=') || eat(q, 'DEFAULT') ? leggiEspressione(q) : { tipo: 'valore', valore: null };
      q.expectPunct(';'); declarations.push({ op: 'declare', name, ...type, expr });
    }
    if (eat(q, 'BEGIN')) { eat(q, 'ATOMIC'); body = [...declarations, ...bloccoProtetto(q)]; expect(q, 'END'); fine(q); }
    else { body = blocco(q); fine(q); }
    language(); security();
  } else {
    expect(p, 'BEGIN'); bound = eat(p, 'ATOMIC'); body = bloccoProtetto(p); expect(p, 'END');
  }
  fine(p);
  const variables = new Set(params.map(v => v.name));
  const cursors = new Set();
  const conditions = new Map(), handlers = new Set();
  function validate(nodes, loop = false) {
    for (const node of nodes) {
      if (node.op === 'declare') {
        if (variables.has(node.name) || cursors.has(node.name)) throw new Error(`Variabile SQL duplicata: ${node.name}.`);
        variables.add(node.name);
      }
      if (node.op === 'cursor') {
        if (cursors.has(node.name) || variables.has(node.name)) throw new Error(`Cursore SQL duplicato: ${node.name}.`);
        cursors.add(node.name);
      }
      if (node.op === 'handler') {
        node.conditions = node.conditions.map(c => c.name ? conditions.get(c.name) || (() => { throw new Error(`Condizione SQL sconosciuta: ${c.name}.`); })() : c);
        for (const c of node.conditions) {
          const key = c.state || c.class;
          if (handlers.has(key)) throw new Error('Handler SQL duplicato nello stesso blocco.');
          handlers.add(key);
        }
      }
      if (node.op === 'condition') {
        if (conditions.has(node.name)) throw new Error('Condizione SQL duplicata.');
        conditions.set(node.name, node.condition);
      }
      if (node.op === 'raise' && node.condition?.name) {
        node.condition = conditions.get(node.condition.name);
        if (!node.condition) throw new Error('Condizione SQL sconosciuta in SIGNAL.');
      }
      if (['open', 'fetch', 'close'].includes(node.op) && !cursors.has(node.name)) throw new Error(`Cursore SQL sconosciuto: ${node.name}.`);
      if (node.op === 'fetch' && node.into.some(n => !variables.has(n))) throw new Error('FETCH INTO richiede variabili dichiarate.');
      if (node.op === 'set' && !variables.has(node.name)) throw new Error(`Variabile SQL sconosciuta: ${node.name}.`);
      if (['exit', 'continue'].includes(node.op) && !loop) throw new Error('EXIT/CONTINUE richiede un ciclo nella procedura.');
      if (node.expr) emettiEspressione(node.expr, n => { if (!variables.has(n) && !(dialect === 'postgresql' && n.toUpperCase() === 'FOUND')) throw new Error(`Variabile SQL sconosciuta: ${n}.`); return n; });
      if (node.then) validate(node.then, loop || ['while', 'loop', 'repeat'].includes(node.op));
      if (node.else) validate(node.else, loop);
      for (const handler of node.handlers || []) validate(handler.then, loop);
    }
  }
  validate(body);
  const plan = { op: 'create', name, replace, params, body, dialect, bound, sourceTokens: p.toks, variables: [...variables] };
  istruzioni(plan, Object.fromEntries(plan.variables.map(n => [n, 0]))).forEach(compila);
  return plan;
}

function cursore(p, name) {
  const start = p.pos; while (!p.eof() && !p.isPunct(';')) p.next();
  const tokens = p.toks.slice(start, p.pos);
  if (!['SELECT', 'WITH'].includes(String(tokens[0]?.value).toUpperCase())) throw new Error('Un cursore richiede una query SELECT.');
  return { op: 'cursor', name, tokens };
}

function condizione(p, classes = false) {
  if (eat(p, 'SQLSTATE')) {
    eat(p, 'VALUE'); const state = p.next();
    if (state?.type !== 'str' || !/^[0-9A-Z]{5}$/.test(state.value) || state.value.startsWith('00')) throw new Error('SQLSTATE non valido.');
    return { state: state.value };
  }
  if (classes) {
    if (eat(p, 'NOT')) { expect(p, 'FOUND'); return { class: '02' }; }
    if (eat(p, 'SQLWARNING')) return { class: '01' };
    if (eat(p, 'SQLEXCEPTION')) return { class: 'exception' };
  }
  return { name: p.parseIdent() };
}

function blocco(p, single = false) {
  const nodes = [];
  while (!p.eof() && !['END', 'ELSE', 'ELSIF', 'ELSEIF', 'UNTIL', 'EXCEPTION', 'WHEN'].includes(word(p))) {
    if (p.eatPunct(';')) continue;
    if (eat(p, 'DECLARE')) {
      if (['CONTINUE', 'EXIT'].includes(word(p))) {
        const action = p.next().value.toLowerCase(); expect(p, 'HANDLER'); expect(p, 'FOR');
        const conditions = []; do { conditions.push(condizione(p, true)); } while (p.eatPunct(','));
        let then;
        if (eat(p, 'BEGIN')) { then = blocco(p); expect(p, 'END'); p.expectPunct(';'); }
        else then = blocco(p, true);
        nodes.push({ op: 'handler', action, conditions, then }); if (single) break; continue;
      }
      if (String(p.peek(1)?.value).toUpperCase() === 'CONDITION') {
        const name = p.parseIdent(); expect(p, 'CONDITION'); expect(p, 'FOR');
        const condition = condizione(p);
        if (!condition.state) throw new Error('DECLARE CONDITION richiede SQLSTATE.');
        nodes.push({ op: 'condition', name, condition }); p.expectPunct(';'); if (single) break; continue;
      }
      if (String(p.peek(1)?.value).toUpperCase() === 'CURSOR') {
        const name = p.parseIdent(); expect(p, 'CURSOR'); expect(p, 'FOR'); nodes.push(cursore(p, name)); p.expectPunct(';'); if (single) break; continue;
      }
      const name = p.parseIdent(), type = require('./sqlSchemaMongo').tipo(p);
      const expr = eat(p, 'DEFAULT') ? leggiEspressione(p) : { tipo: 'valore', valore: null };
      nodes.push({ op: 'declare', name, ...type, expr });
    } else if (eat(p, 'BEGIN')) { nodes.push(...bloccoProtetto(p)); expect(p, 'END'); }
    else if (eat(p, 'SAVEPOINT')) nodes.push({ op: 'savepoint', name: p.parseIdent() });
    else if (eat(p, 'RELEASE')) { expect(p, 'SAVEPOINT'); nodes.push({ op: 'release', name: p.parseIdent() }); }
    else if (eat(p, 'ROLLBACK')) { expect(p, 'TO'); eat(p, 'SAVEPOINT'); nodes.push({ op: 'rollback', name: p.parseIdent() }); }
    else if (eat(p, 'SET')) {
      const name = p.parseIdent(); expect(p, '='); nodes.push({ op: 'set', name, expr: leggiEspressione(p) });
    } else if (p.peek()?.type === 'ident' && p.peek(1)?.value === ':=') {
      const name = p.parseIdent(); p.next(); nodes.push({ op: 'set', name, expr: leggiEspressione(p) });
    } else if (eat(p, 'IF')) {
      nodes.push(ramoIf(p)); expect(p, 'END'); expect(p, 'IF');
    } else if (eat(p, 'WHILE')) {
      const expr = leggiEspressione(p), loop = eat(p, 'LOOP'); if (!loop) expect(p, 'DO'); const then = blocco(p);
      expect(p, 'END'); expect(p, loop ? 'LOOP' : 'WHILE'); nodes.push({ op: 'while', expr, then });
    } else if (eat(p, 'LOOP')) {
      const then = blocco(p); expect(p, 'END'); expect(p, 'LOOP'); nodes.push({ op: 'loop', then });
    } else if (eat(p, 'REPEAT')) {
      const then = blocco(p); expect(p, 'UNTIL'); const expr = leggiEspressione(p);
      expect(p, 'END'); expect(p, 'REPEAT'); nodes.push({ op: 'repeat', expr, then });
    } else if (['OPEN', 'CLOSE'].includes(word(p))) nodes.push({ op: p.next().value.toLowerCase(), name: p.parseIdent() });
    else if (eat(p, 'FETCH')) {
      eat(p, 'NEXT'); eat(p, 'FROM') || eat(p, 'IN');
      const name = p.parseIdent(), into = []; expect(p, 'INTO');
      do { into.push(p.parseIdent()); } while (p.eatPunct(','));
      nodes.push({ op: 'fetch', name, into });
    } else if (eat(p, 'RETURN')) nodes.push({ op: 'return' });
    else if (['EXIT', 'CONTINUE'].includes(word(p))) {
      const op = p.next().value.toLowerCase(); nodes.push({ op, expr: eat(p, 'WHEN') ? leggiEspressione(p) : null });
    } else if (['SIGNAL', 'RESIGNAL'].includes(word(p))) {
      const resignal = p.next().value.toUpperCase() === 'RESIGNAL';
      const condition = resignal && (p.isPunct(';') || word(p) === 'SET') ? null : condizione(p);
      let expr;
      if (eat(p, 'SET')) { expect(p, 'MESSAGE_TEXT'); expect(p, '='); expr = leggiEspressione(p); }
      nodes.push({ op: 'raise', condition, expr, resignal });
    } else if (eat(p, 'RAISE')) {
      if (p.isPunct(';')) nodes.push({ op: 'raise', resignal: true });
      else {
        eat(p, 'EXCEPTION');
        let state = 'P0001', expr;
        if (word(p) === 'SQLSTATE') state = condizione(p).state;
        else if (condizioniPostgres[word(p).toLowerCase()]) state = condizioniPostgres[p.next().value.toLowerCase()][0];
        else if (word(p) !== 'USING') expr = leggiEspressione(p);
        if (eat(p, 'USING')) do {
          const option = word(p); p.next(); expect(p, '=');
          if (option === 'MESSAGE') expr = leggiEspressione(p);
          else if (option === 'ERRCODE') {
            const code = p.next();
            if (code?.type !== 'str') throw new Error('ERRCODE richiede un SQLSTATE o una condizione PostgreSQL tra apici.');
            state = condizioniPostgres[code.value.toLowerCase()]?.[0] || code.value;
            if (!/^[0-9A-Z]{5}$/.test(state) || state.startsWith('00')) throw new Error('SQLSTATE non valido in RAISE.');
          } else throw new Error(`Opzione RAISE non supportata: ${option}.`);
        } while (p.eatPunct(','));
        nodes.push({ op: 'raise', condition: { state }, expr });
      }
    } else {
      const start = p.pos;
      while (!p.eof() && !p.isPunct(';')) p.next();
      const tokens = p.toks.slice(start, p.pos);
      if (!tokens.length) throw new Error('Istruzione di procedura vuota.');
      nodes.push({ op: 'sql', tokens });
    }
    p.expectPunct(';');
    if (single) break;
  }
  return nodes;
}

function bloccoProtetto(p) {
  const body = blocco(p); if (!eat(p, 'EXCEPTION')) return body;
  const handlers = [];
  while (eat(p, 'WHEN')) {
    const conditions = [];
    do {
      if (word(p) === 'SQLSTATE') conditions.push(condizione(p).state);
      else {
        const states = word(p) === 'OTHERS' ? ['*'] : condizioniPostgres[word(p).toLowerCase()];
        if (!states) throw new Error(`Condizione EXCEPTION non riconosciuta: ${p.peek()?.value}.`);
        p.next(); conditions.push(...states);
      }
    } while (eat(p, 'OR'));
    expect(p, 'THEN'); handlers.push({ conditions, then: blocco(p) });
  }
  if (!handlers.length) throw new Error('EXCEPTION richiede almeno un handler WHEN.');
  return [{ op: 'protected', then: body, handlers }];
}

function ramoIf(p) {
  const expr = leggiEspressione(p); expect(p, 'THEN'); const then = blocco(p);
  const otherwise = eat(p, 'ELSIF') || eat(p, 'ELSEIF') ? [ramoIf(p)] : eat(p, 'ELSE') ? blocco(p) : [];
  return { op: 'if', expr, then, else: otherwise };
}

function letterale(value, descriptor) {
  if (value == null) return 'NULL';
  if (value?._sqlArray === true) {
    if (!descriptor?.array) throw new Error('Manca il tipo dell’array SQL con limiti espliciti.');
    const type = descriptor.type + (descriptor.args?.length ? '(' + descriptor.args.map(v => letterale(v)).join(',') + ')' : '') + '[]';
    return `CAST(${letterale(require('./sqlArrayValore').testo(value))} AS ${type})`;
  }
  if (Array.isArray(value)) return `ARRAY[${value.map(letterale).join(',')}]`;
  if (require('./sqlMultirangeMongo').TYPES[value?._sqlMultirange]) return `${value._sqlMultirange}(${value.ranges.map(v => letterale(v)).join(',')})`;
  if (require('./sqlRangeMongo').TYPES[value?._sqlRange]) return value.empty ? `CAST('empty' AS ${value._sqlRange})`
    : `${value._sqlRange}(${letterale(value.lower)},${letterale(value.upper)},'${value.lowerInc ? '[' : '('}${value.upperInc ? ']' : ')'}')`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  if (value instanceof Date) return letterale(value.toISOString());
  if (value?._bsontype === 'Binary') return `X'${Buffer.from(value.value()).toString('hex')}'`;
  if (['Decimal128', 'Long', 'Int32', 'Double'].includes(value?._bsontype)) return value.toString();
  throw new Error('Valore del parametro SQL non scalare.');
}
function bind(tokens, values, types = new Map()) {
  return tokens.map(t => t.sqlReplacement || (['str', 'binary'].includes(t.type) ? letterale(t.value)
    : t.type === 'ident' && Object.hasOwn(values, t.value) ? letterale(values[t.value], types.get(t.value))
      : t.type === 'ident' && t.value.toUpperCase() === 'FOUND' && Object.hasOwn(values, 'FOUND') ? letterale(values.FOUND)
      : t.type === 'ident' ? quotaSempre(t.value, 'mongodb') : t.exact || String(t.value))).join(' ');
}
function istruzioni(plan, values) {
  const output = [];
  function visit(nodes) { for (const node of nodes) { if (node.tokens) output.push(bind(node.tokens, values)); if (node.then) visit(node.then); if (node.else) visit(node.else); for (const h of node.handlers || []) visit(h.then); } }
  visit(plan.body); return output;
}
function compila(text) {
  if (String(sql.tokenize(text)[0]?.value).toUpperCase() === 'CALL') return { ...parse(text), kind: 'call' };
  const plan = sql.looksLikeSql(text) ? sql.translate(text) : sql.translateWrite(text);
  if (plan.kind === 'ddl' || plan.kind === 'program') throw new Error('Il corpo della procedura ammette SELECT e scritture DML; DDL e CTE ricorsive richiedono un contesto separato.');
  return plan;
}

async function esegui(client, db, name, payload, env) {
  const internal = payload[ROUTINE];
  const plan = internal ? { op: 'call', name, args: internal.args.map(valore => ({ tipo: 'valore', valore })) } : parse(payload.sql);
  if (plan.name !== name) throw new Error('Bersaglio della procedura non valido.');
  let database = client.db(db); const catalog = database.collection(CATALOGO);
  const result = message => ({ docs: [{ messaggio: message }], columns: ['messaggio'], resultSet: true });
  if (plan.op === 'create') {
    await require('./sqlDipendenzeRoutine').modifica(client, db, plan, payload);
    return result(`Procedura ${name} creata.`);
  }
  if (plan.op === 'drop') {
    await require('./sqlDipendenzeRoutine').modifica(client, db, plan, payload);
    return result(`Procedura ${name} eliminata.`);
  }
  const doc = internal || await catalog.findOne({ _id: name });
  if (!doc) throw new Error(`Procedura ${name} inesistente.`);
  const routine = internal ? internal.definition : parse(doc.sql);
  if (routine.op !== 'create' || routine.name !== name) throw new Error('Definizione della procedura non valida nel catalogo.');
  if (plan.args.length !== routine.params.length) throw new Error('Numero di argomenti della procedura non corretto.');
  const authorize = payload[AUTHORIZE];
  if (!authorize) throw new Error('Manca il controllo dei permessi della procedura SQL.');
  // Tutti i rami vengono autorizzati prima di aprire la transazione, compresi
  // quelli non percorsi. Non esistono SQL dinamico o privilegi del definente.
  for (const text of istruzioni(routine, Object.fromEntries(routine.variables.map(n => [n, 0])))) authorize(text);
  const hello = await database.command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('CALL atomica richiede un replica set MongoDB. Nessuna scrittura eseguita.');
  const runtime = require('./MongoSqlRuntime'), flow = payload[FLOW] || { depth: 0, steps: 0, ctx: runtime.contesto(env, payload) }, ctx = flow.ctx;
  if (++flow.depth > 32) { flow.depth--; throw new Error('Routine SQL oltre il limite di 32 chiamate annidate.'); }
  const session = payload[SESSION] || client.startSession();
  if (!flow.savepoints) flow.savepoints = require('./sqlSavepointMongo').crea(client, db, session, ctx, payload, env);
  if (!payload[SESSION]) flow.rootCall = true;
  if (flow.savepoints) { client = flow.savepoints.client; database = client.db(db); }
  let output;
  try {
    const transact = payload[SESSION] ? fn => fn() : (fn, options) => session.withTransaction(fn, options);
    await transact(async () => {
      if (!payload[SESSION]) { flow.steps = 0; flow.savepoints.reset(); }
      const values = Object.fromEntries(routine.variables.map(n => [n, null]));
      if (routine.dialect === 'postgresql') values.FOUND = false;
      const types = new Map(routine.params.map(p => [p.name, p])), resolvedTypes = new Map();
      const cursors = new Map(), handlers = [], scope = {}; let handling, cursorBytes = 0;
      const evaluate = async expr => {
        ctx.verifica();
        const expression = emettiEspressione(expr, n => `variabili.${routine.dialect === 'postgresql' && n.toUpperCase() === 'FOUND' ? 'FOUND' : n}`);
        const cursor = database.aggregate([{ $documents: [{ variabili: { $literal: values } }] }, { $project: { _id: 0, valore: expression } }], ctx.opzioni());
        try { return (await cursor.next())?.valore ?? null; } catch (err) { throw require('./sqlSavepointMongo').erroreEspressione(err); } finally { await cursor.close(); }
      };
      async function assign(name, value) {
        const schemaApi = require('./sqlSchemaMongo');
        const schema = { columns: [{ ...types.get(name), nullable: true }], constraints: [] };
        await require('./sqlDominiMongo').risolvi(database, schema, new Map(), ctx.opzioni(session));
        resolvedTypes.set(name, schema.columns[0]);
        const rowValue = schemaApi.normalizzaArray(schema, { [name]: value });
        const cursor = database.aggregate([{ $documents: { $literal: [rowValue] } }, schemaApi.conversioni(schema),
          { $match: schemaApi.validatore(schema) }], ctx.opzioni());
        try {
          const row = await cursor.next();
          if (!row) throw new Error(`Valore non compatibile con il tipo della variabile SQL ${name}.`);
          values[name] = row[name];
        } catch (err) { throw require('./sqlSavepointMongo').erroreEspressione(err); } finally { await cursor.close(); }
      }
      for (let i = 0; i < routine.params.length; i++) await assign(routine.params[i].name, await evaluate(plan.args[i]));
      const assigned = new Set();
      output = result(`Procedura ${name} eseguita.`);
      const step = () => { ctx.verifica(); if (++flow.steps > 10000) throw new Error('Procedura SQL oltre il limite di 10000 passi.'); };
      async function run(nodes) {
        for (const node of nodes) {
          step();
          try {
          if (node.op === 'sql') {
            const text = bind(node.tokens, values, resolvedTypes); authorize(text);
            const p = compila(text), options = { ...payload, sql: text, [SESSION]: session, [FLOW]: flow };
            delete options[ROUTINE];
            const savepoint = p.kind === 'write' && flow.savepoints?.begin();
            try {
              output = p.kind === 'call' ? await esegui(client, db, p.name, options, env)
                : p.kind === 'write' ? await runtime.scrivi(client, db, p.coll, options, env) : await runtime.leggi(client, db, options, env);
              if (savepoint) flow.savepoints.release(savepoint);
            } catch (error) {
              if (savepoint && error[CONDITION] && !error[STATEMENT_FAILED]) await flow.savepoints.rollback(savepoint);
              else if (p.kind === 'write') error[STATEMENT_FAILED] = true;
              throw error;
            }
          } else if (node.op === 'protected') {
            if (!flow.savepoints) throw new Error('EXCEPTION richiede una CALL SQL principale.');
            const frame = flow.savepoints.begin(); let control;
            try { control = await run(node.then); flow.savepoints.release(frame); }
            catch (error) {
              if (!error[CONDITION] || error[STATEMENT_FAILED]) throw error;
              await flow.savepoints.rollback(frame);
              const handler = node.handlers.find(h => h.conditions.some(c => c === '*' && !['57014', 'P0004'].includes(error.sqlState) || c === error.sqlState || c.endsWith('000') && error.sqlState.startsWith(c.slice(0, 2))));
              if (!handler) throw error;
              const previous = handling; handling = error;
              try { control = await run(handler.then); } finally { handling = previous; }
            }
            if (control) return control;
          } else if (['savepoint', 'rollback', 'release'].includes(node.op)) {
            if (!flow.rootCall || internal) throw new Error('SAVEPOINT esplicito richiede una CALL SQL principale, fuori dal corpo di un trigger.');
            if (node.op === 'savepoint') flow.savepoints.begin(node.name, routine.dialect === 'mysql');
            else if (node.op === 'rollback') await flow.savepoints.rollback(flow.savepoints.named(node.name), true);
            else flow.savepoints.release(flow.savepoints.named(node.name));
          } else if (node.op === 'declare' || node.op === 'set') {
            if (node.op === 'declare') types.set(node.name, node);
            await assign(node.name, await evaluate(node.expr));
            assigned.add(node.name);
          }
          else if (node.op === 'cursor') cursors.set(node.name, { tokens: node.tokens, rows: null });
          else if (node.op === 'handler') handlers.push(node);
          else if (node.op === 'open') {
            const c = cursors.get(node.name);
            if (c.rows) throw new Error(`Cursore ${node.name} già aperto.`);
            const text = bind(c.tokens, values, resolvedTypes); authorize(text);
            const plan = compila(text);
            if (!['find', 'aggregate'].includes(plan.kind)) throw new Error('Il cursore richiede una SELECT senza scritture o ricorsione.');
            const result = await runtime.leggi(client, db, { ...payload, sql: text, [SESSION]: session }, env);
            c.columns = plan.columns || result.columns;
            if (new Set(c.columns).size !== c.columns.length) throw new Error('Il cursore richiede alias distinti per le colonne del risultato.');
            c.rows = result.docs.map(d => require('bson').EJSON.deserialize(d, { relaxed: false })); c.at = 0;
            c.bytes = require('bson').calculateObjectSize({ rows: c.rows }); cursorBytes += c.bytes;
            const budget = require('./DbStrategy').maxResultBytes(env);
            if (budget > 0 && cursorBytes > budget) throw new Error('Cursori SQL oltre il budget complessivo di byte.');
          }
          else if (node.op === 'close') {
            const c = cursors.get(node.name);
            if (!c.rows) throw new Error(`Cursore ${node.name} non aperto.`);
            cursorBytes -= c.bytes; c.rows = null;
          }
          else if (node.op === 'fetch') {
            const c = cursors.get(node.name);
            if (!c.rows) throw new Error(`Cursore ${node.name} non aperto.`);
            if (c.columns.length && c.columns.length !== node.into.length) throw new Error('FETCH INTO: numero di variabili diverso dalle colonne del cursore.');
            const row = c.rows[c.at++];
            if (routine.dialect === 'postgresql') values.FOUND = !!row;
            if (row || routine.dialect === 'postgresql') for (let i = 0; i < node.into.length; i++) await assign(node.into[i], row?.[c.columns[i]] ?? null);
            if (!row && routine.dialect !== 'postgresql') throw Object.assign(new Error('Cursore SQL senza altre righe.'), { [CONDITION]: new Set(), sqlState: '02000', natural: true });
          }
          else if (node.op === 'return') return 'return';
          else if (node.op === 'raise') {
            if (node.resignal && !handling) throw new Error('RESIGNAL richiede un handler attivo.');
            const sqlState = node.condition?.state || handling?.sqlState;
            const message = node.expr ? `Eccezione SQL: ${await evaluate(node.expr)}` : handling?.message || `Condizione SQL ${sqlState}.`;
            throw Object.assign(new Error(message), { [CONDITION]: new Set(), sqlState, mysqlState: node.condition?.state || handling?.mysqlState || sqlState });
          }
          else if (['exit', 'continue'].includes(node.op)) { if (!node.expr || await evaluate(node.expr) === true) return node.op; }
          else if (node.op === 'if') { const control = await run(await evaluate(node.expr) === true ? node.then : node.else); if (control) return control; }
          else if (['while', 'loop', 'repeat'].includes(node.op)) {
            while (node.op !== 'while' || await evaluate(node.expr) === true) {
              step(); const control = await run(node.then);
              if (control === 'return') return control;
              if (control === 'exit' || (node.op === 'repeat' && await evaluate(node.expr) === true)) break;
            }
          }
          } catch (error) {
            if (!error[CONDITION] || error[STATEMENT_FAILED]) throw error;
            if (handling) { error[CONDITION].add(scope); throw error; }
            if (error[CONDITION].has(scope)) throw error;
            const group = error.sqlState.slice(0, 2), cls = ['01', '02'].includes(group) ? group : 'exception';
            const state = routine.dialect === 'mysql' ? error.mysqlState || error.sqlState : error.sqlState;
            const handler = handlers.find(h => h.conditions.some(c => c.state === state))
              || handlers.find(h => h.conditions.some(c => c.class === cls));
            if (!handler) { if (group === '01' || error.natural) continue; throw error; }
            handling = error; let control;
            try { control = await run(handler.then); } finally { handling = null; }
            if (handler.action === 'exit') return 'return';
            if (control) return control;
          }
        }
      }
      await run(routine.body); ctx.verifica();
      if (internal?.done) internal.done(values, assigned);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 30000 });
    return output;
  } finally { flow.depth--; if (!payload[SESSION]) await session.endSession(); }
}

module.exports = { riconosci, parse, esegui: require('./sqlCastDomini').avvolgi(esegui, 3), istruzioni, compila, bind };
