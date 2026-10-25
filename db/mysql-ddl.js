'use strict';

const { randomBytes } = require('node:crypto');
const { quotaSempre } = require('./identificatori');
const qid = n => quotaSempre(n, 'mysql');

async function mysqlTableDdl(conn, db, table, pool) {
  const [[row]] = await conn.query(`SHOW CREATE TABLE ${qid(db)}.${qid(table)}`);
  let ddl = row?.['Create Table'];
  if (!ddl || !/\b(?:enum|set)\([^\n]*\?/i.test(ddl)) return ddl || null;
  // Il catalogo MySQL usa utf8mb3 e sostituisce i caratteri fuori BMP con '?'.
  // CTAS conserva i valori ENUM/SET interni: li leggiamo in una tabella TEMPORARY.
  const [columns] = await conn.query(`SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_TYPE AS definition
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND DATA_TYPE IN ('enum','set')`, [db, table]);
  const reader = await pool.getConnection();
  try {
    for (const c of columns.filter(c => c.definition.includes('?'))) {
      const values = [...c.definition.matchAll(/'(?:[^'\\]|\\.|'')*'/g)];
      const temp = `${qid(db)}.${qid('codedb_enum_' + randomBytes(10).toString('hex'))}`;
      let created = false;
      try {
        await reader.query(`CREATE TEMPORARY TABLE ${temp} AS SELECT ${qid(c.name)} FROM ${qid(db)}.${qid(table)} WHERE 0`);
        created = true;
        const labels = [];
        for (let offset = 0; offset < values.length; offset += 500) {
          const indices = Array.from({ length: Math.min(500, values.length - offset) }, (_, i) =>
            c.type === 'set' ? (1n << BigInt(offset + i)).toString() : String(offset + i + 1));
          await reader.query(`INSERT INTO ${temp} VALUES ${indices.map(n => `(${n})`).join(',')}`);
          const [rows] = await reader.query(`SELECT ${qid(c.name)} AS label FROM ${temp} ORDER BY ${qid(c.name)}+0`);
          labels.push(...rows.map(r => "'" + String(r.label).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"));
          await reader.query(`DELETE FROM ${temp}`);
        }
        const prefix = qid(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp('(' + prefix + '\\s+)' + c.type + "\\((?:'(?:[^'\\\\]|\\\\.|'')*'(?:,)?)*\\)", 'i');
        if (!pattern.test(ddl)) throw new Error(`Definizione ${c.type} di "${c.name}" non ricostruibile.`);
        ddl = ddl.replace(pattern, (_m, p) => p + c.type + '(' + labels.join(',') + ')');
      } finally { if (created) await reader.query(`DROP TEMPORARY TABLE ${temp}`); }
    }
  } finally { reader.release(); }
  return ddl;
}

// Lo scanner conserva le posizioni del testo originale e ignora stringhe,
// identificatori quotati e commenti quando riconosce le clausole SQL.
function tokenDdl(sql) {
  const tokens = [];
  let i = 0, depth = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql[i] === '#' || (sql.startsWith('--', i) && /\s/.test(sql[i + 2] || ' '))) {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue;
    }
    const start = i, quote = sql[i];
    if (["'", '"', '`'].includes(quote)) {
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && quote !== '`') { i += 2; continue; }
        if (sql[i++] === quote) {
          if (sql[i] === quote) { i++; continue; }
          break;
        }
      }
      tokens.push({ start, end: i, value: sql.slice(start, i), quoted: true, depth });
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(sql[i])) {
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ start, end: i, value: sql.slice(start, i), quoted: false, depth });
      continue;
    }
    const value = sql[i++];
    if (value === ')') depth--;
    tokens.push({ start, end: i, value, quoted: false, depth });
    if (value === '(') depth++;
  }
  return tokens;
}

function canonicalMySqlTableDdl(ddl, db = null) {
  const sql = String(ddl || ''), tokens = tokenDdl(sql);
  const positions = new Map(tokens.map((token, index) => [token, index]));
  const word = (token, value) => token && !token.quoted && token.value.toUpperCase() === value;
  const charsetAt = i => {
    const first = tokens[i];
    let next = word(first, 'CHARSET') ? i + 1
      : word(first, 'CHARACTER') && word(tokens[i + 1], 'SET') ? i + 2 : null;
    if (next == null) return null;
    if (word(tokens[next], '=')) next++;
    const value = tokens[next];
    return value && !value.quoted && /^[A-Za-z0-9_]+$/.test(value.value)
      ? { name: value.value.toLowerCase(), end: value.end } : null;
  };
  let tableCharset = null;
  for (let i = 0; i < tokens.length; i++) if (tokens[i].depth === 0) {
    const charset = charsetAt(i); if (charset) tableCharset = charset.name;
  }
  const removals = [];
  if (tableCharset) {
    let column = [];
    const inspect = () => {
      const first = column[0];
      if (!first || (!first.quoted && /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|KEY|INDEX|CHECK|FULLTEXT|SPATIAL)$/i.test(first.value))) return;
      let collation = null;
      for (let j = 1; j < column.length - 1; j++) if (word(column[j], 'COLLATE')) {
        const value = word(column[j + 1], '=') ? column[j + 2] : column[j + 1];
        if (value && !value.quoted) collation = value.value.toLowerCase();
      }
      if (!collation || !collation.startsWith(tableCharset + '_')) return;
      for (const token of column) {
        const charset = charsetAt(positions.get(token));
        if (charset?.name === tableCharset) removals.push([token.start, charset.end]);
      }
    };
    for (const token of tokens) {
      if (token.depth === 1 && token.value !== ',') column.push(token);
      if ((token.depth === 1 && token.value === ',') || (token.depth === 0 && token.value === ')')) { inspect(); column = []; }
    }
  }
  let normalized = sql;
  for (const [start, end] of removals.reverse()) normalized = normalized.slice(0, start) + normalized.slice(end);
  return require('./schemaObjects').canonicalSqlForDb(normalized, db);
}

module.exports = { mysqlTableDdl, canonicalMySqlTableDdl };
