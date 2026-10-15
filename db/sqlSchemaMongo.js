'use strict';

// Lo schema SQL vive nel validatore della collezione: anche scritture MQL e
// client esterni rispettano tipi, CHECK, NOT NULL e indici univoci.
const { emettiEspressione, leggiEspressione } = require('./sqlEspressioni');
const { Decimal128, EJSON } = require('bson');
const PREFIX = 'CodeDB SQL schema v1:';
const numerici = ['int', 'long', 'double', 'decimal'];
const word = p => String(p.peek()?.value || '').toUpperCase();
const eat = (p, s) => word(p) === s && !!p.next();
const expect = (p, s) => { if (!eat(p, s)) throw new Error(`Atteso ${s} nella definizione SQL.`); };

function tipo(p, cast = false) {
  const originalName = String(p.next()?.value || '');
  let type = originalName.toUpperCase();
  if (type === 'DOUBLE') eat(p, 'PRECISION');
  if (type === 'CHARACTER') type = eat(p, 'VARYING') ? 'VARCHAR' : 'CHAR';
  const aliases = { INTEGER: 'INT', INT2: 'SMALLINT', INT4: 'INT', INT8: 'BIGINT', BOOL: 'BOOLEAN', NUMERIC: 'DECIMAL', FLOAT: 'DOUBLE', FLOAT8: 'DOUBLE', FLOAT4: 'REAL', DATETIME: 'TIMESTAMP', JSONB: 'JSON' };
  type = aliases[type] || type;
  const types = ['TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'DECIMAL', 'REAL', 'DOUBLE', 'TEXT', 'VARCHAR', 'CHAR', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON', 'UUID', 'ENUM', 'BYTEA', 'BINARY', 'VARBINARY', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB'];
  const domain = !types.includes(type) && !require('./sqlRangeMongo').TYPES[type] && !require('./sqlMultirangeMongo').TYPES[type] ? originalName : null;
  if (domain && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(domain)) throw new Error(`Nome del tipo SQL non valido: ${domain}.`);
  const args = [];
  if (p.eatPunct('(')) {
    do { const t = p.next();
      if (type === 'ENUM' ? t?.type !== 'str' : t?.type !== 'num' || !Number.isSafeInteger(t.value) || t.value < 0) throw new Error('Dimensione o valore del tipo SQL non valido.');
      args.push(t.value);
    } while (p.eatPunct(','));
    p.expectPunct(')');
  }
  if (['VARCHAR', 'CHAR'].includes(type) && (args.length > 1 || args[0] === 0)) throw new Error('Lunghezza del tipo testuale non valida.');
  if (type === 'DECIMAL' && (!(cast && !args.length) && !args.length || args.length > 2 || args[0] < 1 || args[0] > 34 || (args[1] || 0) > args[0])) throw new Error('DECIMAL richiede precisione fra 1 e 34 e scala non superiore alla precisione.');
  if (type === 'ENUM' && (!args.length || new Set(args).size !== args.length)) throw new Error('ENUM richiede valori testuali distinti.');
  if (type === 'BINARY' && !args.length) args.push(1);
  if (['BINARY', 'VARBINARY'].includes(type) && (args.length !== 1 || args[0] < 1 || args[0] > (type === 'BINARY' ? 255 : 65535))) throw new Error('Dimensione del tipo binario non valida.');
  if (!['VARCHAR', 'CHAR', 'DECIMAL', 'ENUM', 'BINARY', 'VARBINARY'].includes(type) && args.length) throw new Error(`Parametri non supportati per il tipo ${type}.`);
  const unsigned = eat(p, 'UNSIGNED');
  if (unsigned && !['TINYINT', 'SMALLINT', 'INT', 'BIGINT'].includes(type)) throw new Error('UNSIGNED è supportato sui tipi interi.');
  let array = false;
  while (p.eatPunct('[')) { if (p.peek()?.type === 'num') p.next(); p.expectPunct(']'); array = true; }
  if (eat(p, 'ARRAY')) { array = true; if (p.eatPunct('[')) { if (p.peek()?.type === 'num') p.next(); p.expectPunct(']'); } }
  return { type: domain ? 'DOMAIN' : type, args, ...(domain ? { domain } : {}), ...(unsigned ? { unsigned: true } : {}), ...(array ? { array: true } : {}) };
}

function espressione(p) {
  const { Parser } = require('./SqlToMql');
  const q = new Parser(p.readParenGroup()), expr = leggiEspressione(q);
  if (!q.eof()) throw new Error('Espressione del vincolo SQL non valida.');
  emettiEspressione(expr); // Rifiuta sottoquery, finestre e funzioni non scalari.
  return expr;
}

function definizione(p, coll, parziale = false) {
  const schema = { columns: [], constraints: [] };
  p.expectPunct('(');
  const nomi = () => { p.expectPunct('('); const names = []; do { names.push(p.parseIdent()); } while (p.eatPunct(',')); p.expectPunct(')'); return names; };
  const riferimento = (columns, name) => {
    const coll = p.parseIdent(), references = { coll, columns: p.isPunct('(') ? nomi() : null };
    const constraint = { kind: 'FOREIGN', name, columns, references, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' };
    while (eat(p, 'ON')) {
      const operation = word(p); p.next();
      if (!['DELETE', 'UPDATE'].includes(operation)) throw new Error('FOREIGN KEY: atteso ON DELETE oppure ON UPDATE.');
      let action = word(p); p.next();
      if (action === 'SET') { expect(p, 'NULL'); action = 'SET NULL'; }
      if (action === 'NO') { expect(p, 'ACTION'); action = 'NO ACTION'; }
      if (!['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL'].includes(action)) throw new Error(`Azione referenziale non tradotta: ${action}.`);
      constraint[operation === 'DELETE' ? 'onDelete' : 'onUpdate'] = action;
    }
    return constraint;
  };
  do {
    let name = eat(p, 'CONSTRAINT') ? p.parseIdent() : null;
    if (['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(word(p))) {
      const kind = word(p); p.next();
      if (kind === 'PRIMARY') expect(p, 'KEY');
      if (kind === 'FOREIGN') { expect(p, 'KEY'); const columns = nomi(); expect(p, 'REFERENCES'); schema.constraints.push(riferimento(columns, name)); }
      else schema.constraints.push(kind === 'CHECK' ? { kind, name, expr: espressione(p) } : { kind, name, columns: nomi() });
      continue;
    }
    if (name) throw new Error('CONSTRAINT deve precedere un vincolo di tabella.');
    const col = { name: p.parseIdent(), ...tipo(p), nullable: true };
    if (!col.name || col.name.includes('.') || col.name.startsWith('$') || col.name === '__proto__') throw new Error('Nome di colonna SQL non valido.');
    while (!p.eof() && !p.isPunct(',') && !p.isPunct(')')) {
      name = eat(p, 'CONSTRAINT') ? p.parseIdent() : null;
      if (eat(p, 'NOT')) { expect(p, 'NULL'); col.nullable = false; }
      else if (eat(p, 'NULL')) col.nullable = true;
      else if (eat(p, 'DEFAULT')) {
        col.default = leggiEspressione(p);
        emettiEspressione(col.default, () => { throw new Error('DEFAULT non può riferirsi ad altre colonne.'); });
      } else if (eat(p, 'PRIMARY')) { expect(p, 'KEY'); schema.constraints.push({ kind: 'PRIMARY', name, columns: [col.name] }); }
      else if (eat(p, 'UNIQUE')) schema.constraints.push({ kind: 'UNIQUE', name, columns: [col.name] });
      else if (eat(p, 'CHECK')) schema.constraints.push({ kind: 'CHECK', name, expr: espressione(p) });
      else if (eat(p, 'REFERENCES')) schema.constraints.push(riferimento([col.name], name));
      else throw new Error(`Clausola di colonna non tradotta: ${p.peek()?.value}.`);
    }
    if (schema.columns.some(c => c.name === col.name)) throw new Error(`Colonna SQL duplicata: ${col.name}.`);
    schema.columns.push(col);
  } while (p.eatPunct(','));
  p.expectPunct(')');
  return parziale ? schema : verifica(schema, coll);
}

function verifica(schema, coll) {
  if (new Set(schema.columns.map(c => c.name)).size !== schema.columns.length) throw new Error('Colonna SQL duplicata.');
  if (schema.constraints.filter(c => c.kind === 'PRIMARY').length > 1) throw new Error('Una tabella può avere una sola chiave primaria.');
  const used = new Set();
  schema.constraints.forEach((constraint, i) => {
    if (!constraint.name) {
      let suffix = i + 1;
      while (schema.constraints.some(c => c.name === `${coll}_${constraint.kind.toLowerCase()}_${suffix}`)) suffix++;
      constraint.name = `${coll}_${constraint.kind.toLowerCase()}_${suffix}`;
    }
    if (used.has(constraint.name)) throw new Error(`Vincolo SQL duplicato: ${constraint.name}.`);
    used.add(constraint.name);
    if (constraint.columns && new Set(constraint.columns).size !== constraint.columns.length) throw new Error('Colonna ripetuta nel vincolo.');
    for (const name of constraint.columns || []) {
      const col = schema.columns.find(c => c.name === name);
      if (!col) throw new Error(`Colonna del vincolo sconosciuta: ${name}.`);
      if (constraint.kind === 'PRIMARY') col.nullable = false;
    }
    if (constraint.expr) emettiEspressione(constraint.expr, name => {
      if (!schema.columns.some(c => c.name === name)) throw new Error(`Colonna del CHECK sconosciuta: ${name}.`);
      return name;
    });
  });
  return schema;
}

function bsonTypes(c) {
  if (c.array) return ['array'];
  if (require('./sqlRangeMongo').TYPES[c.type] || require('./sqlMultirangeMongo').TYPES[c.type]) return ['object'];
  if (['BYTEA', 'BINARY', 'VARBINARY', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB'].includes(c.type)) return ['binData'];
  if (['TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'DECIMAL', 'REAL', 'DOUBLE'].includes(c.type)) return numerici;
  return { TEXT: ['string'], VARCHAR: ['string'], CHAR: ['string'], ENUM: ['string'], UUID: ['string'], BOOLEAN: ['bool'], DATE: ['date'], TIMESTAMP: ['date'], JSON: ['object', 'array', 'string', 'int', 'long', 'double', 'decimal', 'bool'] }[c.type];
}

function validatore(schema, existing = false) {
  const properties = { _id: {} }, required = [], checks = [];
  for (const c of schema.columns) {
    const unchanged=existing===true || existing instanceof Set && existing.has(c.name);
    for (const constraint of c.elementDomain ? [] : c.domainChecks || []) if (!unchanged || constraint.validated !== false) checks.push({ $ne: [emettiEspressione(constraint.expr, name => {
      if (name.toUpperCase() !== 'VALUE') throw new Error('CHECK di dominio: è ammesso soltanto VALUE.'); return c.name;
    }), false] });
    if (c.array) {
      const base = { ...c, array: false, nullable: !c.elementDomainNotNull, name: 'elemento', elementDomain: false, domainChecks: c.elementDomain ? c.domainChecks : [] };
      const validator = validatore({ columns: [base], constraints: [] }, unchanged);
      const scalar = (validator.$jsonSchema || validator.$and[0].$jsonSchema).properties.elemento;
      let items = scalar;
      for (let depth = 1; depth < 6; depth++) items = { anyOf: [scalar, { bsonType: 'array', items }] };
      const plain = { bsonType: ['array', ...(c.nullable ? ['null'] : [])], items };
      properties[c.name] = { anyOf: [plain, { bsonType: 'object', required: ['_sqlArray','lower','values'], additionalProperties: false,
        properties: { _sqlArray: { enum: [true] }, lower: { bsonType:'array', minItems:1, maxItems:6, items:{bsonType:'int',minimum:-2147483648,maximum:2147483647} }, values:{bsonType:'array',minItems:1,items} } }] };
      if (!c.nullable) required.push(c.name);
      const substitute = (v, ref) => typeof v === 'string' && v === '$elemento' ? ref : Array.isArray(v) ? v.map(x => substitute(x, ref))
        : v && typeof v === 'object' && !v._bsontype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, ref)])) : v;
      const leaf = v => validator.$and?.[1]?.$expr ? substitute(validator.$and[1].$expr, v) : true;
      checks.push(require('./sqlArrayMongo').valida(`$${c.name}`, leaf));
      const av = require('./sqlArrayValore'), v = `$${c.name}`, data = av.dati(v), lower = av.limiti(v);
      checks.push({ $cond: [av.tag(v), { $and: [{ $eq: [{ $size: lower }, { $size: require('./sqlArrayMongo').dimensioni(data) }] }, { $eq: [v, av.impacchetta(data, lower)] }] }, true] });
      continue;
    }
    if (require('./sqlRangeMongo').TYPES[c.type] || require('./sqlMultirangeMongo').TYPES[c.type]) {
      const api = require('./sqlMultirangeMongo').TYPES[c.type] ? require('./sqlMultirangeMongo') : require('./sqlRangeMongo');
      properties[c.name] = api.proprieta(c.type, c.nullable);
      if (!c.nullable) required.push(c.name);
      checks.push({ $or: [{ $eq: [{ $ifNull: [`$${c.name}`, null] }, null] }, { $eq: [`$${c.name}`, api.converti(c.type, `$${c.name}`)] }] });
      continue;
    }
    const prop = { bsonType: [...bsonTypes(c), ...(c.nullable ? ['null'] : [])] };
    if (!c.nullable) required.push(c.name);
    if (['VARCHAR', 'CHAR'].includes(c.type) && c.args.length) prop.maxLength = c.args[0];
    if (c.type === 'UUID') prop.pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    if (c.type === 'ENUM') prop.enum = [...c.args, ...(c.nullable ? [null] : [])];
    const binaryLimit = ['BINARY', 'VARBINARY'].includes(c.type) ? c.args[0] : { TINYBLOB: 255, BLOB: 65535, MEDIUMBLOB: 16777215, LONGBLOB: 4294967295 }[c.type];
    if (binaryLimit) checks.push({ $cond: [{ $eq: [{ $type: `$${c.name}` }, 'binData'] },
      { [c.type === 'BINARY' ? '$eq' : '$lte']: [{ $binarySize: `$${c.name}` }, binaryLimit] }, true] });
    const bits = { TINYINT: 8, SMALLINT: 16, INT: 32, BIGINT: 64 }[c.type];
    if (bits) {
      const value = `$${c.name}`, bound = 2n ** BigInt(bits - (c.unsigned ? 0 : 1));
      checks.push({ $cond: [{ $isNumber: value }, { $and: [{ $eq: [{ $mod: [value, 1] }, 0] },
        { $gte: [value, Decimal128.fromString(String(c.unsigned ? 0 : -bound))] }, { $lt: [value, Decimal128.fromString(String(bound))] }] }, true] });
    }
    if (c.type === 'DECIMAL') {
      const value = `$${c.name}`, [precision, scale = 0] = c.args, max = Decimal128.fromString(`1E${precision - scale}`);
      checks.push({ $cond: [{ $isNumber: value }, { $and: [{ $lt: [{ $abs: value }, max] }, { $eq: [value, { $round: [value, scale] }] }] }, true] });
    }
    properties[c.name] = prop;
  }
  for (const c of schema.constraints.filter(c => c.kind === 'CHECK')) checks.push({ $ne: [emettiEspressione(c.expr), false] });
  const json = { bsonType: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}), description: PREFIX + JSON.stringify(schema, function(k, v) {
    return this[k]?._bsontype === 'Binary' ? EJSON.serialize(this[k]) : v;
  }) };
  return checks.length ? { $and: [{ $jsonSchema: json }, { $expr: { $and: checks } }] } : { $jsonSchema: json };
}

function indici(schema) {
  // _id è già univoco e MongoDB vieta una seconda specifica di quell'indice.
  return schema.constraints.filter(c => ['PRIMARY', 'UNIQUE'].includes(c.kind)
    && !c.columns.some(n => schema.columns.find(col => col.name === n)?.array)
    && !(c.columns.length === 1 && c.columns[0] === '_id')).map(c => ({ key: Object.fromEntries(c.columns.map(n => [n, 1])), name: c.name, unique: true,
    ...(c.kind === 'UNIQUE' ? { partialFilterExpression: { $and: c.columns.map(n => ({ [n]: { $type: bsonTypes(schema.columns.find(c => c.name === n)) } })) } } : {}) }));
}

async function leggi(database, coll, options = {}) {
  const info = await database.listCollections({ name: coll }, options).next();
  return daInfo(info);
}

function daInfo(info) {
  const validator = info?.options?.validator;
  const json = validator?.$jsonSchema || validator?.$and?.find(c => c.$jsonSchema)?.$jsonSchema;
  const description = json?.description || '';
  return description.startsWith(PREFIX) ? JSON.parse(description.slice(PREFIX.length), (_k, v) =>
    v && typeof v === 'object' && Object.keys(v).some(k => k.startsWith('$number') || k === '$binary') ? EJSON.deserialize(v, { relaxed: false }) : v) : null;
}

function arrotonda(value, scale) {
  const factor = Decimal128.fromString(`1E${scale}`);
  return { $let: { vars: { scalato: { $multiply: [value, factor] } }, in: {
    $let: { vars: { intero: { $trunc: '$$scalato' } }, in: { $divide: [
      { $cond: [{ $gte: [{ $abs: { $subtract: ['$$scalato', '$$intero'] } }, Decimal128.fromString('0.5')] },
        { $add: ['$$intero', { $cond: [{ $gte: ['$$scalato', 0] }, 1, -1] }] }, '$$intero'] }, factor,
    ] } },
  } } };
}

function conversioni(schema, insert = false) {
  return { $set: Object.fromEntries(schema.columns.map(c => {
    let value = `$${c.name}`;
    if (insert) {
      let fallback = c.default ? emettiEspressione(c.default) : null;
      if (c.array && typeof fallback?.$literal === 'string') fallback = { $literal: require('./sqlArrayValore').parse(fallback.$literal) };
      value = { $cond: [{ $eq: [{ $type: value }, 'missing'] }, fallback, value] };
    }
    return [c.name, convertiValore(c, value)];
  })) };
}
function convertiValore(c, value) {
    if (c.array) {
      if (typeof value?.$literal === 'string') value = { $literal: require('./sqlArrayValore').parse(value.$literal) };
      else value = require('./sqlArrayTesto').parse(value);
      return require('./sqlArrayMongo').converti(value, v => convertiValore({ ...c, array: false }, v));
    }
    if (require('./sqlRangeMongo').TYPES[c.type]) return require('./sqlRangeMongo').converti(c.type, value);
    if (require('./sqlMultirangeMongo').TYPES[c.type]) return require('./sqlMultirangeMongo').converti(c.type, value);
    if (c.cast && ['TEXT', 'VARCHAR', 'CHAR'].includes(c.type)) {
      value = require('./sqlValoreTesto').converti(value);
      if (c.args.length) {
        if (c.args[0] > 16 * 1024 * 1024) throw new Error('Lunghezza CAST oltre il limite BSON.');
        const trimmed = { $substrCP: ['$$testo', 0, c.args[0]] };
        const padding = { $reduce: { input: { $range: [0, { $max: [0, { $subtract: [c.args[0], { $strLenCP: { $ifNull: ['$$testo',''] } }] }] }] }, initialValue: '', in: { $concat: ['$$value', ' '] } } };
        value = { $let: { vars: { testo: value }, in: { $cond: [{ $eq: ['$$testo', null] }, null, c.type === 'CHAR' ? { $concat: [trimmed, padding] } : trimmed] } } };
      }
      return value;
    }
    if (c.cast && ['REAL', 'DOUBLE'].includes(c.type)) return { $convert: { input: value, to: 'double' } };
    if (c.cast && c.type === 'BOOLEAN') {
      const isText = { $eq: [{ $type: value }, 'string'] };
      return { $cond: [isText, { $let: { vars: { booleano: { $toLower: { $trim: { input: { $cond: [isText, value, ''] } } } } }, in: {
        $cond: [{ $in: ['$$booleano', ['true','t','yes','y','on','1']] }, true, { $cond: [{ $in: ['$$booleano', ['false','f','no','n','off','0']] }, false,
          { $convert: { input: { $concat: ['Valore booleano SQL non valido: ', '$$booleano'] }, to: 'int' } },
        ] }],
      } } }, { $convert: { input: value, to: 'bool' } }] };
    }
    if (bsonTypes(c)?.includes('binData')) {
      value = { $convert: { input: value, to: 'binData', format: 'utf8' } };
      if (c.type === 'BINARY') value = { $let: { vars: { b: value }, in: { $cond: [
        { $and: [{ $ne: ['$$b', null] }, c.cast || { $lt: [{ $binarySize: '$$b' }, c.args[0]] }] },
        { $convert: { input: { $substrBytes: [{ $concat: [{ $convert: { input: '$$b', to: 'string', format: 'hex' } }, '00'.repeat(c.args[0])] }, 0, c.args[0] * 2] }, to: 'binData', format: 'hex' } }, '$$b',
      ] } } };
    }
    if (['DATE', 'TIMESTAMP'].includes(c.type)) value = { $convert: { input: value, to: 'date' } };
    if (c.type === 'DATE') value = { $dateTrunc: { date: value, unit: 'day', timezone: 'UTC' } };
    if (c.type === 'DECIMAL') {
      value = { $convert: { input: value, to: 'decimal' } };
      if (c.args.length) value = arrotonda(value, c.args[1] || 0);
      if (c.cast && c.args.length) {
        const valid = { $or: [{ $eq: [value, null] }, { $lt: [{ $abs: value }, Decimal128.fromString(`1E${c.args[0] - (c.args[1] || 0)}`)] }] };
        value = { $cond: [valid, value, { $convert: { input: { $cond: [valid, '0', 'SQL numeric overflow'] }, to: 'int' } }] };
      }
    }
    if (['TINYINT', 'SMALLINT', 'INT', 'BIGINT'].includes(c.type)) value = { $convert: {
      input: arrotonda({ $convert: { input: value, to: 'decimal' } }, 0), to: c.type === 'BIGINT' ? c.unsigned ? 'decimal' : 'long' : c.type === 'INT' && c.unsigned ? 'long' : 'int',
    } };
    if (c.cast && ['TINYINT','SMALLINT','INT','BIGINT'].includes(c.type)) {
      const bits = { TINYINT: 8, SMALLINT: 16, INT: 32, BIGINT: 64 }[c.type], bound = 2n ** BigInt(bits - (c.unsigned ? 0 : 1));
      const valid = { $or: [{ $eq: [value,null] }, { $and: [{ $gte: [value,Decimal128.fromString(String(c.unsigned ? 0 : -bound))] }, { $lt: [value,Decimal128.fromString(String(bound))] }] }] };
      value = { $cond: [valid,value,{ $convert: { input: { $cond: [valid,'0','SQL numeric overflow'] }, to:'int' } }] };
    }
    return value;
}

function normalizzaJson(schema, doc, fields = schema.columns.map(c => c.name)) {
  for (const c of schema.columns) if (c.type === 'JSON' && fields.includes(c.name) && typeof doc[c.name] === 'string') {
    try { doc[c.name] = JSON.parse(doc[c.name], (_key, value, context) => {
      if (typeof value !== 'number') return value;
      const raw = context?.source;
      if (raw && raw.replace(/[^0-9]/g, '').replace(/^0+/, '').length > 15) return Decimal128.fromString(raw);
      if (!Number.isFinite(value)) throw new Error('Numero JSON fuori intervallo.');
      return value;
    }); }
    catch { throw new Error(`Testo JSON non valido nella colonna ${c.name}.`); }
  }
  return doc;
}

function normalizzaArray(schema, doc) {
  for (const c of schema.columns) if (c.array && typeof doc[c.name] === 'string') doc[c.name] = require('./sqlArrayValore').parse(doc[c.name]);
  return doc;
}

async function crea(client, db, coll, payload, env = {}) {
  const plan = require('./SqlToMql').translateWrite(payload.sql);
  if (plan.kind !== 'ddl' || plan.coll !== coll) throw new Error('Definizione SQL non valida.');
  const database = client.db(db);
  if (['createDomain', 'alterDomain', 'dropDomain'].includes(plan.op)) return require('./sqlDominiMongo').esegui(client, db, plan, payload, env);
  if (plan.op === 'alterTable') return require('./sqlAlterMongo').esegui(client, db, coll, plan, payload, env);
  if (plan.op === 'dropCollection') {
    for (const doc of await database.collection('_codedb_sql_procedures').find({}).toArray()) {
      const routines = require('./sqlDipendenzeRoutine'), definition = routines.definizione(doc); if (!definition) continue;
      const deps = await routines.analizza(database, definition);
      if (deps.tables.some(t => t.name === coll)) throw new Error(`DROP TABLE impedito dalla dipendenza della procedura ${doc._id}.`);
    }
    const infos = await database.listCollections().toArray();
    for (const info of infos) if (info.name !== coll && daInfo(info)?.constraints.some(c => c.kind === 'FOREIGN' && c.references.coll === coll)) {
      throw new Error(`DROP TABLE impedito dalla FOREIGN KEY definita su ${info.name}.`);
    }
    const result = await database.collection(coll).drop();
    await database.collection('_codedb_sql_triggers').deleteMany({ coll });
    return result;
  }
  if (plan.op === 'dropIndex') {
    const schema = await leggi(database, coll);
    if (schema?.constraints.some(c => c.name === plan.name && ['PRIMARY', 'UNIQUE'].includes(c.kind))) throw new Error('L’indice applica un vincolo SQL: non può essere eliminato separatamente dal vincolo.');
    return database.collection(coll).dropIndex(plan.name);
  }
  if (plan.op !== 'createCollection' || !plan.schema) throw new Error('Definizione SQL non valida.');
  await require('./sqlDominiMongo').risolvi(database, plan.schema);
  if (plan.ifNotExists && await database.listCollections({ name: coll }, { nameOnly: true }).hasNext()) return;
  await verificaDefault(database, plan.schema);
  await riferimenti(database, coll, plan.schema);
  const options = { validator: validatore(plan.schema), validationLevel: 'strict', validationAction: 'error' };
  const indexes = indici(plan.schema);
  const hello = await database.command({ hello: 1 });
  const domainReferences = plan.schema.columns.some(c => c.domain);
  if (domainReferences) await require('./sqlVincoliReferenziali').inizializzaBlocco(database);
  const session = client.startSession();
  const run = async extra => {
    if (domainReferences) {
      if (!extra.session) throw new Error('Gli schemi con domini richiedono un replica set MongoDB.');
      await require('./sqlVincoliReferenziali').blocca(database, extra);
      await require('./sqlDominiMongo').risolvi(database, plan.schema, new Map(), extra);
      options.validator = validatore(plan.schema);
    }
    await database.createCollection(coll, { ...options, ...extra });
    if (indexes.length) await database.collection(coll).createIndexes(indexes, extra);
  };
  try {
    if (hello.setName || hello.msg === 'isdbgrid') await session.withTransaction(() => run({ session }), { writeConcern: { w: 'majority' } });
    else await run({});
  } catch (err) { if (!(plan.ifNotExists && err.code === 48)) throw err; }
  finally { await session.endSession(); }
}

async function riferimenti(database, coll, schema, schemas = new Map()) {
  for (const constraint of schema.constraints.filter(c => c.kind === 'FOREIGN')) {
    const parent = schemas.get(constraint.references.coll) || (constraint.references.coll === coll ? schema : await leggi(database, constraint.references.coll));
    if (!parent) throw new Error(`FOREIGN KEY ${constraint.name}: la tabella riferita deve avere uno schema SQL.`);
    constraint.references.columns ||= parent.constraints.find(c => c.kind === 'PRIMARY')?.columns;
    const cols = constraint.references.columns;
    if (!cols || cols.length !== constraint.columns.length || !parent.constraints.some(c => ['PRIMARY', 'UNIQUE'].includes(c.kind)
      && c.columns.length === cols.length && c.columns.every((n, i) => n === cols[i]))) throw new Error(`FOREIGN KEY ${constraint.name}: manca una chiave univoca corrispondente.`);
    cols.forEach((name, i) => {
      const a = parent.columns.find(c => c.name === name), b = schema.columns.find(c => c.name === constraint.columns[i]);
      if (!a || a.type !== b.type || !!a.array !== !!b.array || !!a.unsigned !== !!b.unsigned || JSON.stringify(a.args) !== JSON.stringify(b.args)) throw new Error(`FOREIGN KEY ${constraint.name}: tipi delle colonne incompatibili.`);
    });
  }
}

async function verificaDefault(database, schema) {
  for (const col of schema.columns.filter(c => c.default)) {
    // PostgreSQL ammette un DEFAULT che viola i CHECK del dominio: la
    // violazione si manifesta quando il valore viene effettivamente usato.
    const single = { columns: [{ ...col, nullable: true, domainChecks: [], elementDomainNotNull: false }], constraints: [] };
    const cursor = database.aggregate([{ $documents: [{}] }, conversioni(single, true)]);
    let row;
    try { row = await cursor.next(); } finally { await cursor.close(); }
    normalizzaJson(single, row);
    const valid = database.aggregate([{ $documents: { $literal: [row] } }, { $match: validatore(single) }]);
    try { if (!await valid.hasNext()) throw new Error(`DEFAULT non compatibile con il tipo della colonna ${col.name}.`); }
    finally { await valid.close(); }
  }
}

module.exports = { definizione, verifica, tipo, validatore, indici, leggi, daInfo, conversioni, convertiValore, normalizzaJson, normalizzaArray, crea: require('./sqlCastDomini').avvolgi(crea, 3), riferimenti, verificaDefault, bsonTypes };
