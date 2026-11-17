'use strict';

/* ---------------------------------------------------------------------------
 * Applicazione di un singolo layer di backup su MySQL (schema tabelle senza FK,
 * fuso orario/sql_mode di sessione, tombstone, geometrie WKB/SRID, ordinali
 * ENUM/SET e binari UNHEX).
 * ------------------------------------------------------------------------- */

const { EJSON } = require('bson');
const { readLines, fileDelBackup } = require('./util');
const { isSqlGeometryType } = require('../../db/geometry');
const { quotaSempre } = require('../../db/identificatori');
const { leggiIdentitaMySql, identityCompatibile } = require('./identity');
const { parseClientValue, toSqlValue } = require('../../db/sqlValori');
const {
  BATCH_SIZE, registraFileAtteso, registraAttesa,
  assertColumnsAndIdentity, checkApplied, readSchemaFile,
} = require('./restore-catena');
const { riqualificaDdl } = require('./restore-oggetti');

const myQid = (name) => quotaSempre(name, 'mysql');

const TIPI_BINARI_MYSQL = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit',
]);

async function mysqlGeoTargetColumns(conn, targetDb, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dtype, SRS_ID AS srid
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [targetDb, table],
  );
  const out = new Map();
  for (const r of rows) {
    const tipo = String(r.dtype || '').toLowerCase();
    if (isSqlGeometryType(r.dtype)) {
      out.set(r.name, { kind: 'geo', srid: r.srid == null ? null : Number(r.srid) });
    } else if (TIPI_BINARI_MYSQL.has(tipo)) {
      out.set(r.name, { kind: 'bin' });
    }
  }
  return out;
}

async function mysqlTargetIdentity(conn, db, table, expectedIdentity = null) {
  const [columnsRows] = await conn.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [db, table],
  );
  const columns = columnsRows.map((c) => ({
    name: c.name,
    type: String(c.type).toLowerCase(),
    nullable: String(c.nullable).toUpperCase() === 'YES',
  }));
  const identities = await leggiIdentitaMySql(
    (sql, params) => conn.query(sql, params), db, table, columns,
  );
  return {
    columnSchema: columns,
    identity: identities.find((candidate) => identityCompatibile(expectedIdentity, candidate))
      || identities[0] || null,
  };
}

async function restoreLayerMySql({
  strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, opts, tracker,
}) {
  const pool = strategy.pool;
  const conn = await pool.getConnection();
  let total = 0;
  let originalSession;
  try {
    [[originalSession]] = await conn.query('SELECT @@SESSION.time_zone AS timezone, @@SESSION.sql_mode AS mode');
    await conn.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_ALL_TABLES'");
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${myQid(targetDb)}`);
    await conn.query(`USE ${myQid(targetDb)}`);
    const dataFiles = layer.manifest.files.filter(
      (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
    );

    let existingTables = null;
    if (isFirst) {
      const [rows] = await conn.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [targetDb]
      );
      existingTables = new Set(rows.map(r => r.TABLE_NAME));
    }

    for (const f of dataFiles) {
      await conn.query('SET SESSION time_zone = ?', [f.timezone === 'UTC' ? '+00:00' : originalSession.timezone]);
      registraFileAtteso(tracker, f);
      const tableId = myQid(f.collection);
      if (isFirst) {
        if (drop) {
          await conn.query(`DROP TABLE IF EXISTS ${tableId}`);
          existingTables.delete(f.collection);
        }

        if (!existingTables.has(f.collection)) {
          const schemaFile = layer.manifest.files.find((x) => x.kind === 'schema' && x.collection === f.collection);
          if (!schemaFile) throw new Error(`Schema di "${f.collection}" assente dal backup: impossibile ricreare la tabella.`);
          const ddl = readSchemaFile(layer.dir, schemaFile, f.collection, {
            ...opts, dbType: 'mysql', database: layer.manifest.db,
          });
          const separated = require('./engine').splitMySqlForeignKeys(ddl, f.collection);
          await conn.query(riqualificaDdl(separated.ddl, layer.manifest.db, targetDb, 'mysql').replace(/;\s*$/, ''));
          existingTables.add(f.collection);
        }
      }

      const targetMeta = await mysqlTargetIdentity(conn, targetDb, f.collection, f.identity);
      let empty = false;
      if (!f.identity) {
        if (!isFirst && f.mode === 'full' && f.content?.mode === 'snapshot') {
          assertColumnsAndIdentity(f, targetMeta.columnSchema, targetMeta.identity, { empty: true });
          await conn.query(`DELETE FROM ${tableId}`);
        }
        const [[row]] = await conn.query(`SELECT NOT EXISTS(SELECT 1 FROM ${tableId} LIMIT 1) AS \`is_empty\``);
        empty = !!Number(row.is_empty);
      }
      assertColumnsAndIdentity(f, targetMeta.columnSchema, targetMeta.identity, { empty });

      const eliminazioni = layer.manifest.files.find((x) => x.kind === 'tombstones' && x.collection === f.collection);
      if (!isFirst && eliminazioni) {
        const binary = new Set((f.columnSchema || []).filter(c => /^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/i.test(c.type)).map(c => c.name));
        const whereDelete = f.identity.columns.map((c) => `${myQid(c)} = ${binary.has(c) ? 'UNHEX(?)' : (f.ordinalColumns || []).includes(c) ? 'CAST(? AS UNSIGNED)' : '?'}`).join(' AND ');
        for await (const line of readLines(fileDelBackup(layer.dir, eliminazioni.path, 'file di cancellazioni'))) {
          const id = EJSON.parse(line, { relaxed: false });
          await conn.query(
            `DELETE FROM ${tableId} WHERE ${whereDelete}`,
            f.identity.columns.map((c) => toSqlValue(id[c]))
          );
        }
      }

      const geoTarget = await mysqlGeoTargetColumns(conn, targetDb, f.collection);
      const sridOrigine = f.geoSrid || {};

      const upsert = !!f.identity && (!isFirst || !drop);
      const verb = upsert ? 'UPSERT' : 'INSERT';
      let batch = [];
      let columns = null;
      let applied = 0;
      const flush = async () => {
        if (!batch.length) return;
        const listaColonne = columns.map((c) => myQid(c)).join(', ');
        const conflictColumns = f.identity ? f.identity.columns : [];
        if (upsert && !conflictColumns.length) {
          throw new Error(`Upsert rifiutato per "${f.collection}": il manifest non dichiara un'identita stabile.`);
        }
        const aggiornabili = columns.filter((c) => !conflictColumns.includes(c));
        const upsertSql = upsert
          ? ` ON DUPLICATE KEY UPDATE ${(
            aggiornabili.length
              ? aggiornabili.map((c) => `${myQid(c)} = VALUES(${myQid(c)})`)
              : [`${myQid(conflictColumns[0])} = ${myQid(conflictColumns[0])}`]
          ).join(', ')}`
          : '';
        const ordinalColumns = new Set(f.ordinalColumns || []);
        const enumColumns = new Set((f.columnSchema || []).filter(require('../../db/mysql-ordinal').isEnum).map(c => c.name));
        const zeroColumns = [];
        const geoNelBatch = columns.some((c) => geoTarget.has(c) || ordinalColumns.has(c));
        if (!geoNelBatch) {
          await require('../../db/mysql-ordinal').write(conn, `INSERT INTO ${tableId} (${listaColonne}) VALUES ?${upsertSql}`, [batch]);
        } else {
          const params = [];
          const tuple = batch.map((riga, rowIndex) => {
            const segnaposti = columns.map((c, i) => {
              const info = geoTarget.get(c);
              const v = riga[i];
              if (ordinalColumns.has(c) && v != null) {
                const bind = require('../../db/mysql-ordinal').binding(require('bson').Decimal128.fromString(String(v)), { type: enumColumns.has(c) ? 'enum' : 'set' });
                if (bind.zero) zeroColumns.push({ column: c, row: rowIndex + 1 });
                params.push(bind.param); return bind.sql;
              }
              if (!info || v == null) { params.push(v); return '?'; }
              if (info.kind !== 'bin' && f.geometryEncoding === 'mysql-internal-hex') {
                const bytes = Buffer.from(String(v), 'hex');
                if (bytes.length < 9 || bytes.length * 2 !== String(v).length) throw new Error('Geometria binaria del backup non valida.');
                params.push(bytes.subarray(4).toString('hex'));
                return `ST_GeomFromWKB(UNHEX(?), ${bytes.readUInt32LE(0)}, 'axis-order=long-lat')`;
              }
              params.push(String(v));
              if (info.kind === 'bin') return 'UNHEX(?)';
              return `ST_GeomFromWKB(UNHEX(?), ${Number(sridOrigine[c] ?? info.srid ?? 0)})`;
            });
            return `(${segnaposti.join(', ')})`;
          });
          await require('../../db/mysql-ordinal').write(
            conn, `INSERT INTO ${tableId} (${listaColonne}) VALUES ${tuple.join(', ')}${upsertSql}`, params, zeroColumns,
          );
        }
        applied += batch.length;
        batch = [];
      };
      for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
        // parseClientValue legge in forma canonica preservando i Long oltre i 53 bit.
        const row = parseClientValue(line);
        registraAttesa(tracker, f);
        const colsRiga = Object.keys(row);
        if (!columns) columns = colsRiga;
        const stessaForma = colsRiga.length === columns.length
          && colsRiga.every((c) => columns.includes(c));
        if (!stessaForma) {
          await flush();
          columns = colsRiga;
        }
        batch.push(columns.map((c) => (geoTarget.has(c) ? row[c] : toSqlValue(row[c]))));
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      total += applied;
      log.info(`  ${f.collection}: ${applied} righe applicate (layer ${layer.manifest.id}, ${verb}).`);
      checkApplied(problems, layer, f, applied);
    }
  } finally {
    try {
      if (originalSession) await conn.query('SET SESSION time_zone = ?, SESSION sql_mode = ?', [originalSession.timezone, originalSession.mode]);
      conn.release();
    } catch (err) { conn.destroy(); throw err; }
  }
  return total;
}

module.exports = {
  mysqlGeoTargetColumns,
  mysqlTargetIdentity,
  restoreLayerMySql,
};
