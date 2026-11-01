'use strict';

const crypto = require('crypto');
const { EJSON } = require('bson');
const { readLines, fileDelBackup } = require('./util');
const { quotaSempre } = require('../../db/identificatori');
const { parseClientValue, toSqlValue } = require('../../db/sqlValori');

/** Un merge conserva le righe proprie della destinazione. Per contarle non
 * basta un Set JavaScript: l'uguaglianza dipende da tipi e collation del DBMS.
 * Il contenitore temporaneo raccoglie soltanto le identità nominate dalla
 * catena (comprese quelle cancellate), con memoria limitata a un batch. */
async function contaIdentitaPreservate({ strategy, dbType, targetDb, collection, chain, file, retarget }) {
  const sources = chain.flatMap(layer => layer.manifest.files
    .filter(item => item.collection === collection && ['data', 'tombstones'].includes(item.kind))
    .map(item => ({ layer, item })));
  const temp = `_cdb_merge_${crypto.randomBytes(12).toString('hex')}`;
  if (dbType === 'mongodb') {
    const db = strategy.client.db(targetDb);
    const original = (await db.listCollections({ name: collection }).toArray()).find(item => item.name === collection);
    if (!original || !await db.collection(collection).findOne({}, { projection: { _id: 1 } })) return 0;
    await db.createCollection(temp, original.options?.collation ? { collation: original.options.collation } : {});
    try {
      const bson = require('../../db/mongoBson');
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const result = await bson.importRows(strategy.client, targetDb, temp, batch, true, { preservaIdentita: true });
        if (result.failed) throw new Error(result.errors.join('; '));
        batch = [];
      };
      for (const { layer, item } of sources) {
        for await (const line of readLines(fileDelBackup(layer.dir, item.path, 'identità del merge'))) {
          const row = item.encoding === 'bson-base64' ? JSON.parse(line) : EJSON.parse(line, { relaxed: false });
          batch.push(item.encoding === 'bson-base64' ? bson.encode(bson.decodeId(row)) : bson.encode({ _id: row._id }));
          if (batch.length >= 500) await flush();
        }
      }
      await flush();
      const rows = await db.collection(collection).aggregate([
        { $lookup: { from: temp, localField: '_id', foreignField: '_id', as: '__codedb_identita' } },
        { $match: { __codedb_identita: { $size: 0 } } }, { $count: 'n' },
      ], { allowDiskUse: true }).toArray();
      return rows[0]?.n || 0;
    } finally { await db.collection(temp).drop(); }
  }

  const mysql = dbType === 'mysql';
  const quota = name => quotaSempre(name, mysql ? 'mysql' : 'postgresql');
  const qtable = `${quota(targetDb)}.${quota(collection)}`;
  const qtemp = mysql ? `${quota(targetDb)}.${quota(temp)}` : quota(temp);
  const columns = file.identity.columns;
  const qcols = columns.map(quota).join(', ');
  const conn = mysql ? await strategy.pool.getConnection() : await strategy.pool.connect();
  let created = false;
  let originalSession = null;
  try {
    const result = await conn.query(`SELECT 1 AS presente FROM ${qtable} LIMIT 1`);
    if (!(mysql ? result[0] : result.rows).length) return 0;
    if (mysql) {
      [[originalSession]] = await conn.query('SELECT @@SESSION.time_zone AS timezone, @@SESSION.sql_mode AS mode');
      await conn.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_ALL_TABLES'");
    }
    await conn.query(`CREATE TEMPORARY TABLE ${qtemp} AS SELECT ${qcols} FROM ${qtable} WHERE 1=0`);
    created = true;
    await conn.query(mysql
      ? `ALTER TABLE ${qtemp} ADD PRIMARY KEY (${qcols})`
      : `CREATE UNIQUE INDEX ON ${qtemp} (${qcols})`);
    const shapes = !mysql ? await require('../../db/pg-references').columnReferences((sql, params) => conn.query(sql, params), targetDb, collection) : null;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      if (shapes) await require('../../db/pg-alias').resolveNested(
        (sql, params) => conn.query(sql, params), batch.map(item => item.row), shapes,
      );
      const params = [];
      const tuples = batch.map(({ row, dataFile }) => `(${columns.map(column => {
        let value = row[column];
        const binary = mysql
          ? (dataFile.columnSchema || []).some(c => c.name === column && /^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/i.test(c.type))
          : (dataFile.binarie || []).includes(column);
        if (binary && typeof value === 'string') value = Buffer.from(value, 'hex');
        const columnType = String((dataFile.columnSchema || []).find(item => item.name === column)?.type || '')
          .toLowerCase().replace(/^_(regproc|regoper)$/, '$1[]');
        const reference = !mysql && value?.$pgReference && value.$pgReference.kind === columnType
          ? require('../../db/pg-alias').binding(value) : null;
        if (reference) {
          params.push(reference.param);
          return reference.sql.replace('$1', `$${params.length}`);
        }
        params.push(toSqlValue(value));
        const placeholder = mysql ? '?' : `$${params.length}`;
        return mysql && (dataFile.ordinalColumns || []).includes(column) ? `CAST(${placeholder} AS UNSIGNED)` : placeholder;
      }).join(', ')})`);
      const conflict = mysql
        ? ` ON DUPLICATE KEY UPDATE ${quota(columns[0])}=${quota(columns[0])}`
        : ` ON CONFLICT (${qcols}) DO NOTHING`;
      await conn.query(`INSERT INTO ${qtemp} (${qcols}) VALUES ${tuples.join(', ')}${conflict}`, params);
      batch = [];
    };
    for (const { layer, item } of sources) {
      const dataFile = layer.manifest.files.find(candidate => candidate.kind === 'data' && candidate.collection === collection) || file;
      if (mysql) {
        // I TIMESTAMP sono salvati in UTC: anche la tabella di confronto deve
        // interpretarli nello stesso fuso usato dal caricamento delle righe.
        await flush();
        await conn.query('SET SESSION time_zone = ?', [dataFile.timezone === 'UTC' ? '+00:00' : originalSession.timezone]);
      }
      for await (const line of readLines(fileDelBackup(layer.dir, item.path, 'identità del merge'))) {
        let row = parseClientValue(line);
        if (shapes && retarget) row = require('../../db/pg-references').rowReferences(row, shapes, value => value,
          (value, node) => node.type === 'regnamespace' && [layer.manifest.db, quota(layer.manifest.db)].includes(value)
            ? quota(targetDb) : retarget(value, layer.manifest.db, targetDb));
        batch.push({ row, dataFile });
        // Anche PK molto larghe restano sotto il limite dei parametri PG.
        if (batch.length >= Math.max(1, Math.min(500, Math.floor(30000 / columns.length)))) await flush();
      }
    }
    await flush();
    const predicate = columns.map(column => `m.${quota(column)}=d.${quota(column)}`).join(' AND ');
    const count = await conn.query(`SELECT COUNT(*) AS n FROM ${qtable} d WHERE NOT EXISTS (SELECT 1 FROM ${qtemp} m WHERE ${predicate})`);
    return Number((mysql ? count[0] : count.rows)[0].n);
  } finally {
    try { if (created) await conn.query(`DROP TABLE ${qtemp}`); }
    finally {
      try {
        if (originalSession) await conn.query('SET SESSION time_zone = ?, SESSION sql_mode = ?', [originalSession.timezone, originalSession.mode]);
        conn.release();
      } catch (error) { conn.destroy(); throw error; }
    }
  }
}

module.exports = { contaIdentitaPreservate };
