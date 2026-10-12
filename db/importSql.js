'use strict';

// Il dump diventa lo stesso artefatto del JSON: nessun INSERT del file viene
// eseguito come codice. Il caricamento conserva staging, verifica e recupero.
const { estraiBersaglio } = require('./artefatti');
const { splitMySqlForeignKeys } = require('../backup/lib/engine');
const { quotaSempre } = require('./identificatori');

const IDENT = '(?:"(?:[^" ]|""| )+"|`(?:[^`]|``)+`|[\\p{L}_][\\p{L}\\p{N}_$]*)';
const NOME = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const match = (text, pattern) => new RegExp(pattern, 'iu').exec(text);

function identificatore(text, mysql) {
  const s = text.trim();
  if (s[0] === '"' || s[0] === '`') return s.slice(1, -1).replaceAll(s[0] + s[0], s[0]);
  return mysql ? s : s.toLowerCase();
}

// Taglia soltanto fuori da stringhe e parentesi: virgole nei valori e nei tipi
// DECIMAL, CHECK ed ENUM non separano colonne o tuple.
function pezzi(text, mysql, separator = ',') {
  const out = [];
  let start = 0, depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && (mysql || quote.escape)) { i++; continue; }
      if (c === quote.char) {
        if (text[i + 1] === c) i++;
        else quote = null;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      quote = { char: c, escape: c === "'" && /(?:^|\W)E$/i.test(text.slice(Math.max(0, i - 2), i)) };
    } else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === separator && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
    if (depth < 0) throw new Error('Parentesi SQL non bilanciate.');
  }
  if (quote || depth) throw new Error('Valore SQL incompleto.');
  out.push(text.slice(start).trim());
  return out;
}

function stringa(raw, mysql, copy = false, backslash = mysql) {
  const escape = copy || backslash || /^[eE]'/.test(raw);
  let s = copy ? raw : raw.replace(/^[eE]/, '').slice(1, -1).replace(/''/g, "'");
  const pattern = mysql ? /\\[\s\S]/g : copy
    ? /(?:\\(?:[0-7]{1,3}|x[0-9a-f]{1,2}))+|\\[\s\S]/gi
    : /(?:\\(?:[0-7]{1,3}|x[0-9a-f]{1,2}))+|\\(?:u[0-9a-f]{4}|U[0-9a-f]{8}|[\s\S])/gi;
  if (escape) s = s.replace(pattern, token => {
    const c = token.slice(1);
    if (!mysql && /^(?:[0-7]|x[0-9a-f])/i.test(c)) {
      const bytes = [...token.matchAll(/\\([0-7]{1,3}|x[0-9a-f]{1,2})/gi)].map(m => parseInt(m[1].replace(/^x/i, ''), /^x/i.test(m[1]) ? 16 : 8));
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    }
    if (!mysql && !copy && /^[uU]/.test(c) && c.length > 1) return String.fromCodePoint(parseInt(c.slice(1), 16));
    if (mysql && /[%_]/.test(c)) return token;
    if (mysql && !'0bnrtZ'.includes(c)) return c;
    return ({ '0': '\0', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', Z: '\x1a' })[c] ?? c;
  });
  return s;
}

function valore(raw, mysql, backslash = mysql) {
  const s = raw.trim();
  const nested=!mysql && /^pg_catalog\.format\(([\s\S]*)\)::("(?:[^"]|"")+"\."(?:[^"]|"")+")$/.exec(s);
  if(nested){
    const args=pezzi(nested[1],false),format=valore(args.shift(),false);
    if(typeof format!=='string')throw new Error('Formato del riferimento composto non valido.');
    const refs=args.map(a=>{const m=/^([\s\S]+)::pg_catalog\.(regprocedure|regoperator)::oid$/.exec(a);if(!m)throw new Error('Riferimento SQL composto non valido.');return {kind:m[2]==='regprocedure'?'regproc':'regoper',value:valore(m[1],false)};});
    return require('./pg-alias').parseNested(format,refs,nested[2]);
  }
  if (/^NULL$/i.test(s)) return null;
  if (/^(TRUE|FALSE)$/i.test(s)) return s.toLowerCase() === 'true';
  const pgRef = /^([\s\S]+)::pg_catalog\.(regprocedure(?:\[\])?|regoperator(?:\[\])?)::oid(?:\[\])?::pg_catalog\.(regproc(?:\[\])?|regoper(?:\[\])?)$/i.exec(s);
  if (!mysql && pgRef) return {$pgReference:{kind:pgRef[3].toLowerCase(),value:valore(pgRef[1],false)}};
  const ordinal = /^CAST\('(0|[1-9]\d*)' AS UNSIGNED\)$/i.exec(s);
  if (mysql && ordinal) return { $numberDecimal: ordinal[1] };
  // Il DBMS converte il testo nel tipo della colonna senza passare da Number.
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return s;
  if (/^(?:E)?'(?:[^'\\]|\\[\s\S]|'')*'$/i.test(s)) return stringa(s, mysql, false, backslash);
  const hex = /^(?:X'([0-9a-f]*)'|0x([0-9a-f]+))$/i.exec(s);
  if (hex) {
    const data = hex[1] ?? hex[2];
    if (data.length % 2) throw new Error('Valore binario esadecimale incompleto.');
    return { $binary: { base64: Buffer.from(data, 'hex').toString('base64'), subType: '00' } };
  }
  const convert = /^CONVERT\(X'([0-9a-f]*)' USING utf8mb4\)$/i.exec(s);
  if (convert) return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(convert[1], 'hex'));
  const decode = /^decode\('([0-9a-f]*)',\s*'hex'\)$/i.exec(s);
  if (decode) return valore(`X'${decode[1]}'`, mysql);
  const wkb = /^ST_GeomFromWKB\((X'[0-9a-f]*'),\s*(\d+)(?:,\s*'axis-order=long-lat')?\)$/i.exec(s);
  if (wkb && mysql) {
    const srid = Number(wkb[2]);
    if (!Number.isSafeInteger(srid) || srid > 0xffffffff) throw new Error('SRID non valido.');
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(srid);
    return { $binary: { base64: Buffer.concat([prefix, Buffer.from(wkb[1].slice(2, -1), 'hex')]).toString('base64'), subType: '00' } };
  }
  const geo = /^ST_GeomFromGeoJSON\(([\s\S]*)\)$/i.exec(s);
  if (geo) {
    const args = pezzi(geo[1], mysql);
    if (args.length !== 1 && !(args.length === 3 && /^1$/.test(args[1]) && /^\d+$/.test(args[2]))) throw new Error('Opzioni GeoJSON non supportate.');
    const value = JSON.parse(valore(args[0], mysql, backslash));
    if (args[2]) value.crs = { type: 'name', properties: { name: `EPSG:${args[2]}` } };
    return value;
  }
  const srid = /^ST_SetSRID\((ST_GeomFromGeoJSON\([\s\S]*\)),\s*(\d+)\)(?:::geography)?$/i.exec(s);
  if (srid) {
    const value = valore(srid[1], mysql, backslash);
    value.crs = { type: 'name', properties: { name: `EPSG:${srid[2]}` } };
    return value;
  }
  const bits = /^b'([01]+)'$/i.exec(s);
  if (bits) return mysql ? BigInt('0b' + bits[1]).toString() : bits[1];
  throw new Error('Espressione SQL nei dati non supportata: esportare valori letterali con INSERT o COPY.');
}

function creaLettoreSql({ dbType }) {
  const mysql = dbType === 'mysql';
  if (!mysql && dbType !== 'postgresql') throw new Error('Un dump SQL richiede una connessione MySQL o PostgreSQL.');
  const artifact = { formato: 'codedb-database', versione: 1, origineFormato: 'sql', dbType, db: '', collections: [], objects: {}, avvisi: [] };
  const tables = new Map(), columns = new Map(), dropped = [], seqOwners = new Map(), seqDefaults = [];
  let loCurrent = null;
  let pending = '', statement = '', delimiter = ';', quote = null, block = false, version = '', line = 0, copy = null;
  let backslash = mysql;
  const q = name => quotaSempre(name, dbType);
  const avviso = text => { if (!artifact.avvisi.includes(text)) artifact.avvisi.push(text); };
  function source(db) {
    if (artifact.db && artifact.db !== db) throw new Error('Il dump contiene più database/schemi: esportarli separatamente.');
    artifact.db = db;
  }
  function nome(raw) {
    const parts = [...raw.matchAll(new RegExp(IDENT, 'gu'))].map(m => identificatore(m[0], mysql));
    if (parts.length === 2) source(parts[0]);
    return parts.at(-1);
  }
  function table(name) {
    if (!tables.has(name)) {
      const t = { name, ddl: null, docs: [], postDdl: [], identity: null };
      tables.set(name, t); artifact.collections.push(t);
    }
    return tables.get(name);
  }
  function ids(raw) {
    const names = pezzi(raw, mysql).map(s => {
      if (!match(s, `^${IDENT}$`)) throw new Error('Elenco colonne SQL non valido.');
      return identificatore(s, mysql);
    });
    if (new Set(names.map(n => mysql ? n.toLowerCase() : n)).size !== names.length) throw new Error('Elenco colonne SQL duplicato.');
    return names;
  }
  function struttura(t) {
    const start = t.ddl.indexOf('('), end = t.ddl.lastIndexOf(')');
    if (start < 0 || end < start) throw new Error(`Struttura di "${t.name}" incompleta.`);
    const defs = pezzi(t.ddl.slice(start + 1, end), mysql);
    const cols = [];
    for (const def of defs) {
      const pk = match(def, `^(?:CONSTRAINT\\s+${IDENT}\\s+)?PRIMARY\\s+KEY\\s*\\(([^)]+)\\)`);
      if (pk) { t.identity = { kind: 'primary-key', columns: ids(pk[1]) }; continue; }
      if (/^(?:CONSTRAINT|UNIQUE|KEY|INDEX|FOREIGN|CHECK|FULLTEXT|SPATIAL)\b/i.test(def)) continue;
      const col = match(def, `^(${IDENT})\\s+`);
      if (!col) throw new Error(`Colonna di "${t.name}" non riconosciuta.`);
      const name = identificatore(col[1], mysql);
      cols.push(name);
      if (/\bPRIMARY\s+KEY\b/i.test(def)) t.identity = { kind: 'primary-key', columns: [name] };
    }
    columns.set(t.name, cols);
  }
  function modificaColonna(t, name, transform) {
    if (!t?.ddl) throw new Error('ALTER COLUMN richiede la CREATE TABLE nel dump.');
    const start = t.ddl.indexOf('('), end = t.ddl.lastIndexOf(')');
    let found = false;
    const defs = pezzi(t.ddl.slice(start + 1, end), mysql).map(def => {
      const col = match(def, `^(${IDENT})\\s+`);
      if (!col || identificatore(col[1], mysql) !== name) return def;
      found = true;
      return transform(def);
    });
    if (!found) throw new Error(`Colonna "${name}" non dichiarata.`);
    t.ddl = t.ddl.slice(0, start + 1) + defs.join(', ') + t.ddl.slice(end);
  }
  function addRows(t, cols, tuples) {
    if (!cols?.length) throw new Error(`INSERT senza colonne e senza CREATE TABLE per "${t.name}".`);
    for (const tuple of tuples) {
      if (!tuple.startsWith('(') || !tuple.endsWith(')')) throw new Error('Tupla INSERT non valida.');
      const vals = pezzi(tuple.slice(1, -1), backslash);
      if (vals.length !== cols.length) throw new Error(`"${t.name}": numero di valori diverso dalle colonne.`);
      const row = Object.fromEntries(cols.flatMap((col, i) => /^DEFAULT$/i.test(vals[i]) ? [] : [[col, valore(vals[i], mysql, backslash)]]));
      t.docs.push(row);
    }
  }
  function esegui(raw) {
    const sql = raw.trim();
    if (!sql) return;
    let m;
    if ((m = match(sql, `^(?:CREATE\\s+(?:DATABASE|SCHEMA)(?:\\s+IF\\s+NOT\\s+EXISTS)?|USE)\\s+(${IDENT})(?:\\s|$)`))) { source(identificatore(m[1], mysql)); return; }
    if (/^(BEGIN|START TRANSACTION|COMMIT|LOCK TABLES|UNLOCK TABLES)\b/i.test(sql)) return;
    if (/^SET\b/i.test(sql) || /^SELECT\s+pg_catalog\.set_config\('search_path', '', false\)$/i.test(sql)) {
      if ((m = match(sql, `^SET(?:\\s+LOCAL)?\\s+search_path\\s+(?:TO|=)\\s+(${IDENT})`))) { source(identificatore(m[1], mysql)); return; }
      if (mysql && (m = /(?:^SET\s+|,\s*)(?:SESSION\s+)?SQL_MODE\s*=\s*['"]([^'"]*)['"]/i.exec(sql))) backslash = !/NO_BACKSLASH_ESCAPES/i.test(m[1]);
      if (!mysql && (m = /^SET\s+standard_conforming_strings\s*=\s*'?((?:on|off))'?$/i.exec(sql))) backslash = m[1].toLowerCase() === 'off';
      if (mysql && (m = /(?:^SET\s+|,\s*)(?:SESSION\s+)?time_zone\s*=\s*['"]([^'"]+)['"]/i.exec(sql))) {
        if (tables.size && [...tables.values()].some(t => t.docs.length) && m[1] !== artifact.sqlTimeZone) throw new Error('Il dump cambia fuso orario durante i dati: esportare con un unico fuso.');
        if (m[1].toUpperCase() === 'SYSTEM') throw new Error('Il dump deve dichiarare un fuso esplicito, non SYSTEM.');
        artifact.sqlTimeZone = m[1];
      }
      if (!mysql && /^SET\s+(?:LOCAL\s+)?DateStyle\b/i.test(sql) && !/['"]ISO(?:,\s*(?:YMD|MDY|DMY))?['"]$/i.test(sql)) {
        throw new Error('Esportare le date PostgreSQL con DateStyle ISO.');
      }
      // Queste impostazioni non vengono eseguite: scritture parametrizzate e
      // sessioni dell'import impongono codifica, modalità stretta e fuso UTC.
      if (/^SET\s+(?:(?:SESSION|LOCAL)\s+)?(?:@|NAMES\b|character_set_client\b|character_set_results\b|collation_connection\b|client_encoding\b|standard_conforming_strings\b|check_function_bodies\b|xmloption\b|client_min_messages\b|row_security\b|default_tablespace\b|default_table_access_method\b|statement_timeout\b|lock_timeout\b|idle_in_transaction_session_timeout\b|transaction_timeout\b|sql_mode\b|time_zone\b|foreign_key_checks\b|unique_checks\b|DateStyle\b|IntervalStyle\b|TimeZone\b)/i.test(sql)
          || /^SET\s+SQL_NOTES\s*=/i.test(sql)
          || /^SELECT\s+pg_catalog\.set_config\('search_path', '', false\)$/i.test(sql)) {
        if (/\b(?:NAMES|client_encoding|character_set_client)\b/i.test(sql) && !/(?:utf8|utf-8|@)/i.test(sql)) throw new Error('Il dump deve essere codificato in UTF-8.');
        return;
      }
      throw new Error('Impostazione SQL non supportata nel dump.');
    }
    if ((m = match(sql, `^INSERT\\s+INTO\\s+(${NOME})\\s*([\\s\\S]*)$`))) {
      const t = table(nome(m[1])); let tail = m[2], cols = columns.get(t.name);
      if (tail.startsWith('(')) { const end = tail.indexOf(')'); cols = ids(tail.slice(1, end)); tail = tail.slice(end + 1).trim(); }
      tail = tail.replace(/^OVERRIDING SYSTEM VALUE\s+/i, '');
      if (/^DEFAULT VALUES$/i.test(tail)) { t.docs.push({}); return; }
      if (!/^VALUES\s*\(/i.test(tail)) throw new Error('Sono supportati INSERT con VALUES; SELECT, IGNORE e conflitti impliciti non conservano tutte le righe.');
      addRows(t, cols, pezzi(tail.replace(/^VALUES\s*/i, ''), backslash)); return;
    }
    if ((m = match(sql, `^COPY\\s+(${NOME})\\s*\\(([^)]+)\\)\\s+FROM\\s+stdin$`))) {
      copy = { t: table(nome(m[1])), cols: ids(m[2]) }; return;
    }
    if ((m = match(sql, `^DROP (TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT) IF EXISTS\\s+(${NOME})$`))) {
      const name = nome(m[2]);
      dropped.push(name);
      if (m[1].toUpperCase() !== 'TABLE') {
        for (const field of ['views', 'routines', 'triggers', 'events']) {
          if (artifact.objects[field]) artifact.objects[field] = artifact.objects[field].filter(o => o.name !== name);
        }
      } else if (tables.get(name)?.docs.length) throw new Error('DROP TABLE dopo i dati: il dump eliminerebbe righe già importate.');
      return;
    }
    if (/^(?:GRANT|REVOKE|COMMENT ON)\b/i.test(sql) || /^ALTER\s+(?:TABLE|SCHEMA|SEQUENCE|VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|LARGE OBJECT).*\sOWNER TO\s/i.test(sql)) {
      avviso('Proprietari, privilegi e commenti del dump non vengono trasferiti; restano quelli della connessione di destinazione.'); return;
    }
    if ((m = match(sql, `^ALTER TABLE(?:\\s+ONLY)?\\s+(${NOME})\\s+ALTER COLUMN\\s+(${IDENT})\\s+SET DEFAULT\\s+nextval\\('((?:[^']|'')+)'::regclass\\)$`))) {
      seqDefaults.push({ table: nome(m[1]), col: identificatore(m[2], mysql), seq: nome(m[3].replaceAll("''", "'")) }); return;
    }
    if (!mysql && (m = match(sql, `^ALTER TABLE(?:\\s+ONLY)?\\s+(${NOME})\\s+ALTER COLUMN\\s+(${IDENT})\\s+ADD\\s+(GENERATED (?:ALWAYS|BY DEFAULT) AS IDENTITY[\\s\\S]*)$`))) {
      modificaColonna(table(nome(m[1])), identificatore(m[2], false), def => def + ' ' + m[3]); return;
    }
    if ((m = match(sql, `^ALTER SEQUENCE\\s+(${NOME})\\s+OWNED BY\\s+(${NOME}\\.${IDENT})$`))) {
      const parts = [...m[2].matchAll(new RegExp(IDENT, 'gu'))];
      const col = identificatore(parts.pop()[0], mysql);
      seqOwners.set(nome(m[1]), { table: nome(parts.map(p => p[0]).join('.')), col }); return;
    }
    if ((m = /^SELECT\s+(?:pg_catalog\.)?setval\('((?:[^']|'')+)',\s*(-?\d+),\s*(true|false)\)$/i.exec(sql))) {
      const seq = nome(m[1].replaceAll("''", "'"));
      (artifact.objects.sequenceValues ||= []).push({ name: seq, sql: `SELECT setval('${q(seq).replaceAll("'", "''")}', ${m[2]}, ${m[3]})` }); return;
    }
    if (!mysql && (m = /^SELECT\s+(?:pg_catalog\.)?lo_create\((?:'(\d+)'|(\d+))\)$/i.exec(sql))) {
      (artifact.largeObjects ||= []).push({ oid: m[1] || m[2], size: 0, chunks: [] }); return;
    }
    if (!mysql && (m = /^SELECT\s+(?:pg_catalog\.)?lo_put\((\d+),\s*(\d+),\s*decode\('([0-9a-f]*)',\s*'hex'\)\)$/i.exec(sql))) {
      const object = artifact.largeObjects?.find(o => o.oid === m[1]);
      if (!object || object.size !== Number(m[2]) || m[3].length % 2) throw new Error('Chunk Large Object fuori sequenza.');
      const bytes = Buffer.from(m[3], 'hex'); object.chunks.push(bytes.toString('base64')); object.size += bytes.length; return;
    }
    if (!mysql && (m = /^SELECT\s+(?:pg_catalog\.)?lo_open\((?:'(\d+)'|(\d+)),\s*131072\)$/i.exec(sql))) {
      loCurrent = artifact.largeObjects?.find(o => o.oid === (m[1] || m[2])); if (!loCurrent) throw new Error('Large Object non dichiarato.'); return;
    }
    if (!mysql && (m = /^SELECT\s+(?:pg_catalog\.)?lowrite\(0,\s*'\\{1,2}x([0-9a-f]*)'\)$/i.exec(sql))) {
      if (!loCurrent || m[1].length % 2) throw new Error('Chunk Large Object non valido.');
      const bytes = Buffer.from(m[1], 'hex'); loCurrent.chunks.push(bytes.toString('base64')); loCurrent.size += bytes.length; return;
    }
    if (!mysql && /^SELECT\s+(?:pg_catalog\.)?lo_close\(0\)$/i.test(sql)) { loCurrent = null; return; }
    if (/^REFRESH MATERIALIZED VIEW\b/i.test(sql)) return;
    if (/^ALTER TABLE\b/i.test(sql) && /(?:DISABLE|ENABLE) KEYS$/i.test(sql) && mysql) return;
    if (/^(?:CREATE|ALTER TABLE)\b/i.test(sql)) {
      const target = estraiBersaglio(sql);
      const obj = target.object.parts;
      if (obj.length === 2) source(identificatore(obj[0].quoted ? q(obj[0].value) : obj[0].value, mysql));
      const name = identificatore(obj.at(-1).quoted ? q(obj.at(-1).value) : obj.at(-1).value, mysql);
      if (target.kind === 'create-table') {
        const t = table(name);
        if (t.ddl) throw new Error(`Tabella "${name}" dichiarata più volte.`);
        t.ddl = sql; struttura(t);
        if (mysql) { const split = splitMySqlForeignKeys(sql, name); t.ddl = split.ddl; t.postDdl.push(...split.foreignKeys); }
      } else if (target.kind === 'alter-table' || target.kind === 'create-index') {
        const tname = identificatore(target.table.parts.at(-1).quoted ? q(target.table.name) : target.table.name, mysql);
        const t = table(tname);
        if (!mysql && target.kind === 'alter-table' && /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY KEY|UNIQUE)\s*\(/i.test(sql)) {
          if (!t.ddl) throw new Error('Il vincolo richiede la CREATE TABLE nel dump.');
          const clause = sql.slice(sql.search(/\bADD\s/i)).replace(/^ADD\s+/i, '');
          const end = t.ddl.lastIndexOf(')'); t.ddl = t.ddl.slice(0, end) + ', ' + clause + t.ddl.slice(end); struttura(t);
        } else t.postDdl.push(sql);
      } else {
        if (['create-type', 'create-domain'].includes(target.kind)) {
          const types=artifact.objects.types ||= [];
          const previous=types.find(t=>t.name===name);
          const shell=target.kind==='create-type' && target.object.next===target.tokens.length;
          if(previous && previous.shell && !previous.ddl) Object.assign(previous,{ddl:sql});
          else types.push({ name, kind: target.kind.slice(7), ddl: shell ? '' : sql, ...(shell?{shell:true}:{}) });
          return;
        }
        const field = { 'create-view': 'views', 'create-function': 'routines', 'create-procedure': 'routines', 'create-trigger': 'triggers', 'create-event': 'events', 'create-sequence': 'sequences', 'create-collation': 'collations' }[target.kind];
        if (!field) throw new Error('Oggetto SQL non supportato.');
        const ddl = target.kind === 'create-sequence' ? sql.replace(/^CREATE SEQUENCE\s+(?!IF NOT EXISTS)/i, 'CREATE SEQUENCE IF NOT EXISTS ') : sql;
        (artifact.objects[field] ||= []).push({ name, ddl: ddl.replace(/\s+WITH NO DATA\s*$/i, ''), ...(target.table ? { table: target.table.name } : {}), ...(/MATERIALIZED VIEW/i.test(sql) ? { materialized: true } : {}) });
      }
      return;
    }
    throw new Error('Istruzione non supportata nel dump: ' + sql.slice(0, 60).replace(/\s+/g, ' '));
  }
  function riga(raw) {
    line++;
    const text = raw.replace(/\r$/, '');
    if (copy) {
      if (text === '\\.') { copy = null; return; }
      const values = text.split('\t');
      if (values.length !== copy.cols.length) throw new Error(`COPY "${copy.t.name}": numero di campi non valido.`);
      copy.t.docs.push(Object.fromEntries(copy.cols.map((c, i) => [c, values[i] === '\\N' ? null : stringa(values[i], false, true)])));
      return;
    }
    if (!statement.trim() && !quote && !block) {
      const d = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(text);
      if (d && mysql) { delimiter = d[1]; return; }
      if (/^\\(?:un)?restrict\s+\w+\s*$/.test(text) && !mysql) return;
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i + 1];
      if (block) {
        if (c === '*' && next === '/') { block = false; statement += version.replace(/^!\d*\s*/, '') + ' '; version = ''; i++; }
        else if (version) version += c;
        continue;
      }
      if (quote) {
        if (quote.tag) {
          if (text.startsWith(quote.tag, i)) { statement += quote.tag; i += quote.tag.length - 1; quote = null; }
          else statement += c;
        } else {
          statement += c;
          if (c === '\\' && quote.escape && next != null) statement += text[++i];
          else if (c === quote.char) {
            if (next === c) statement += text[++i]; else quote = null;
          }
        }
        continue;
      }
      if (text.startsWith(delimiter, i)) { esegui(statement); statement = ''; i += delimiter.length - 1; continue; }
      if ((c === '-' && next === '-' && (!mysql || !text[i + 2] || /\s/.test(text[i + 2]))) || (mysql && c === '#')) break;
      if (c === '/' && next === '*') { block = true; version = text[i + 2] === '!' ? '!' : ''; i += version ? 2 : 1; continue; }
      if (c === "'" || c === '"' || c === '`') quote = { char: c, escape: c === "'" && (backslash || /(?:^|\W)E$/i.test(statement)) };
      if (c === '$' && !mysql) { const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(text.slice(i)); if (tag) { quote = { tag: tag[0] }; statement += tag[0]; i += tag[0].length - 1; continue; } }
      statement += c;
    }
    statement += '\n';
    if (block && version) version += '\n';
    if (statement.length > 32 * 1024 * 1024) throw new Error('Istruzione SQL oltre 32 MB: esportare INSERT più piccoli.');
  }
  return {
    scrivi(chunk) {
      pending += chunk;
      let start = 0, end;
      while ((end = pending.indexOf('\n', start)) >= 0) {
        try { riga(pending.slice(start, end)); } catch (err) { throw new Error(`SQL, riga ${line}: ${err.message}`); }
        start = end + 1;
      }
      pending = pending.slice(start);
      if (pending.length > 32 * 1024 * 1024) throw new Error('Riga SQL oltre 32 MB: esportare INSERT più piccoli.');
    },
    fine() {
      if (pending) riga(pending);
      if (copy || quote || block) throw new Error('Dump SQL incompleto: stringa, commento o COPY non terminato.');
      esegui(statement);
      for (const name of dropped) if (!tables.get(name)?.ddl && !Object.values(artifact.objects).some(values => values.some(o => o.name === name))) throw new Error(`DROP senza CREATE per "${name}".`);
      for (const d of seqDefaults) {
        const t = tables.get(d.table);
        const seq = artifact.objects.sequences?.find(s => s.name === d.seq);
        if (!seq || !t?.ddl) throw new Error('La sequenza del default non è dichiarata nel dump.');
        modificaColonna(t, d.col, def => def + ` DEFAULT nextval('${q(d.seq).replaceAll("'", "''")}'::regclass)`);
      }
      for (const [name, owner] of seqOwners) {
        const seq = artifact.objects.sequences?.find(s => s.name === name);
        if (!seq || !tables.get(owner.table)?.ddl) throw new Error('Proprietario della sequenza non dichiarato nel dump.');
        seq.ownerTable = owner.table; seq.ownerColumn = owner.col;
      }
      if (!artifact.db) artifact.db = mysql ? 'importato' : 'public';
      if (!artifact.collections.length) throw new Error('Il dump non contiene tabelle importabili.');
      return artifact;
    },
  };
}

module.exports = { creaLettoreSql };
