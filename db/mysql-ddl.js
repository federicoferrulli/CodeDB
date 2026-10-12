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

module.exports = { mysqlTableDdl };
