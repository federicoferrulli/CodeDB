'use strict';

// La forma JavaScript non basta a distinguere un array SQL da un documento
// JSON. Il descrittore proviene dal catalogo, insieme alle colonne in cache.
const { toSqlValue, parseClientValue } = require('./sqlValori');
const quote = text => '"' + String(text).replace(/(["\\])/g, '\\$1') + '"';
const scalarText = scalar => Buffer.isBuffer(scalar) ? '\\x' + scalar.toString('hex') : scalar instanceof Date ? scalar.toISOString() : scalar;

function tipoDaCatalogo(nodes, dimensions = 0) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const byId = new Map(nodes.map(n => [Number(n.oid), n]));
  const visit = (n, seen = new Set(), rank = 0) => {
    if (!n || seen.has(Number(n.oid))) return null;
    const next = new Set([...seen, Number(n.oid)]);
    if (n.kind === 'd') return visit(byId.get(Number(n.base)), next, rank || Number(n.dimensions));
    if (n.array === true && Number(n.element)) {
      const element = byId.get(Number(n.element));
      return { kind: 'array', delimiter: element?.delimiter || ',',
        dimensions: rank || Number(n.dimensions) || 1,
        element: visit(element, next) || { kind: 'scalar', name: element?.name } };
    }
    const native = n.schema === 'pg_catalog';
    return { kind: native && /^jsonb?$/.test(n.name) ? 'json' : native && n.name === 'bytea' ? 'bytea' : 'scalar',
      name: n.name, schema: n.schema, oid: Number(n.oid) };
  };
  return visit(nodes[0], new Set(), Number(dimensions));
}

// Ripiego per i descrittori storici e per i chiamanti puri. I nomi di tipi
// definiti dall'utente vengono risolti dal catalogo, mai dal prefisso `_`.
const BUILTIN_ARRAYS = new Set(['bool','bytea','char','name','int2','int4','int8','text','oid','float4','float8',
  'bpchar','varchar','numeric','date','time','timetz','timestamp','timestamptz','interval','json','jsonb','uuid','box']);
function tipoColonna(column) {
  if (column?.pgType) return column.pgType;
  let name = String(column?.baseType || column?.declaredType || column?.type || column?.types?.[0] || '').toLowerCase().trim();
  const array = /\[\]$/.test(name) || name[0] === '_' && BUILTIN_ARRAYS.has(name.slice(1));
  if (array) name = name[0] === '_' ? name.slice(1) : name.replace(/(?:\[\])+$/, '').trim();
  const scalar = { kind: /^jsonb?$/.test(name) ? 'json' : name === 'bytea' ? 'bytea' : 'scalar', name };
  return array ? { kind: 'array', delimiter: name === 'box' ? ';' : ',', dimensions: column?.dimensions || 1, element: scalar } : scalar;
}

function jsonSql(value) {
  return JSON.stringify(value, (_key, item) => item?._bsontype === 'Long'
    ? { $numberLong: item.toString() } : item);
}

function valorePostgres(value, column) {
  const type = tipoColonna(column);
  if (type.kind !== 'array') return toSqlValue(value);
  if (value == null || typeof value === 'string') return value == null ? null : value;
  const explicit = value?._sqlArray === true;
  const content = explicit ? value.values : value;
  if (!Array.isArray(content)) throw new Error('Il valore di un array PostgreSQL deve essere un array JSON oppure un letterale nativo.');
  const delimiter = type.delimiter || ',';
  const jsonRank = explicit ? value.lower?.length : Number(type.dimensions) || 1;
  const encode = (v, depth) => {
    if (type.element?.kind === 'json' && depth >= jsonRank) return v == null ? 'NULL' : quote(jsonSql(v));
    if (type.element?.kind === 'array' && depth >= jsonRank) return v == null ? 'NULL' : quote(valorePostgres(v, { pgType: type.element }));
    if (Array.isArray(v)) return '{' + v.map(item => encode(item, depth + 1)).join(delimiter) + '}';
    if (v == null) return 'NULL';
    return quote(scalarText(toSqlValue(v)));
  };
  let prefix = '';
  if (explicit) {
    if (!Array.isArray(value.lower) || !value.lower.length) throw new Error('Limiti dell’array PostgreSQL non validi.');
    let level = content;
    prefix = value.lower.map(lower => {
      if (!Number.isSafeInteger(lower) || !Array.isArray(level) || !level.length) throw new Error('Limiti dell’array PostgreSQL non validi.');
      const upper = lower + level.length - 1;
      if (lower < -2147483648 || upper > 2147483647) throw new Error('Limiti dell’array PostgreSQL fuori intervallo.');
      level = level[0];
      return `[${lower}:${upper}]`;
    }).join('') + '=';
  }
  return prefix + encode(content, 0);
}

// INSERT e replace ricevono ancora la sorgente JSON: non si devono perdere
// cifre dentro NUMERIC[] o documenti JSONB[] prima di arrivare al binder.
function valoreDalJson(text, column) {
  const source = String(text).trim(), type = tipoColonna(column);
  if (type.kind !== 'array' || source[0] !== '[') return parseClientValue(source);
  JSON.parse(source); // solo validazione: i Number prodotti non vengono usati
  const elementi = raw => {
    const result = []; let start = 1, depth = 0, quoted = false;
    for (let i = 1; i < raw.length - 1; i++) {
      const char = raw[i];
      if (quoted) { if (char === '\\') i++; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
      else if (char === ',' && !depth) { result.push(raw.slice(start, i).trim()); start = i + 1; }
    }
    const last = raw.slice(start, -1).trim();
    if (last) result.push(last);
    return result;
  };
  const rank = Number(type.dimensions) || 1;
  const encode = (raw, depth) => {
    if (raw === 'null') return 'NULL';
    if (type.element?.kind === 'json' && depth >= rank) return quote(raw);
    if (type.element?.kind === 'array' && depth >= rank) return quote(valoreDalJson(raw, { pgType: type.element }));
    if (raw[0] === '[') return '{' + elementi(raw).map(item => encode(item, depth + 1)).join(type.delimiter || ',') + '}';
    return quote(/^-?\d/.test(raw) ? raw : scalarText(toSqlValue(parseClientValue(raw))));
  };
  return encode(source, 0);
}

module.exports = { tipoDaCatalogo, tipoColonna, valorePostgres, valoreDalJson };
