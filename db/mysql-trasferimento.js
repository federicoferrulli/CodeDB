'use strict';

const { EJSON, Binary } = require('bson');
const { assertImportOutcomeKnown } = require('./importFailure');
const { toSqlValue, parseClientValue, deserializeClientObject } = require('./sqlValori');
const { rigaCsv } = require('./csv');
const { quotaSempre, quotaQualificato } = require('./identificatori');
const { definisciMetodi } = require('./prototipoStrategia');

function qid(name) {
  return quotaSempre(name, 'mysql');
}

function qtable(db, table) {
  return quotaQualificato([db, table], 'mysql');
}

function installaTrasferimentoMysql(prototipo) {
  definisciMetodi(prototipo, {
    async collectionExport(db, coll, payload) {
      const pool = this.requirePool();
      const format = ['sql', 'json'].includes(payload.format) ? payload.format : 'csv';
      const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 1000);
      const table = qtable(db, coll);
      const pk = await this.primaryKey(db, coll);
      const primaPagina = !payload.after && !(Number(payload.skip) > 0);
      const metadati = format !== 'csv'
        ? await this.metadatiEsportazione(db, coll, primaPagina)
        : null;
      const selectList = metadati ? require('./sqlTransfer').projection(metadati.info, true) : '*';

      let rows;
      let fields;
      let nextAfter = null;
      if (pk.length) {
        const pkCols = pk.map((c) => `${table}.${qid(c)}`).join(', ');
        const ordinalPk = new Set((metadati?.info.columns || []).filter(require('./mysql-ordinal').isOrdinal).map((c) => c.name));
        let whereSql = '';
        let params = [];
        if (payload.after != null && payload.after !== '') {
          let afterVals;
          try {
            afterVals = parseClientValue(payload.after);
          } catch {
            throw new Error('Cursore di paginazione non valido.');
          }
          if (!Array.isArray(afterVals) || afterVals.length !== pk.length) {
            throw new Error('Cursore di paginazione non valido.');
          }
          const keys = pk.map((c) => (ordinalPk.has(c) ? `CAST(${qid(c)} AS UNSIGNED)` : qid(c)));
          whereSql = ` WHERE (${keys.join(', ')}) > (${pk.map((c) => (ordinalPk.has(c) ? 'CAST(? AS UNSIGNED)' : '?')).join(', ')})`;
          params = afterVals.map(toSqlValue);
        }
        [rows, fields] = await pool.query(
          `SELECT ${selectList} FROM ${table}${whereSql} ORDER BY ${pkCols} LIMIT ?`,
          [...params, limit]
        );
        if (rows.length) {
          const last = rows[rows.length - 1];
          nextAfter = EJSON.stringify(pk.map((c) => (Buffer.isBuffer(last[c]) ? new Binary(last[c]) : last[c])), { relaxed: false });
        }
      } else {
        const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
        [rows, fields] = await pool.query(
          `SELECT ${selectList} FROM ${table} LIMIT ? OFFSET ?`,
          [limit, skip]
        );
      }
      const total = await this.totaleEsportazione(table, primaPagina);
      let columns = (fields || []).map((f) => f.name);

      if (metadati) {
        const scrivibili = metadati.scrivibili;
        const generate = columns.filter((c) => !scrivibili.has(c));
        if (generate.length) {
          for (const row of rows) for (const c of generate) delete row[c];
          columns = columns.filter((c) => scrivibili.has(c));
        }
      }

      let lines;
      if (format === 'sql') {
        lines = rows.map((r) => require('./databaseExport').insertSql('mysql', table, require('./sqlTransfer').encodeRow(r, metadati.info.columns), metadati.info).trim());
      } else if (format === 'json') {
        lines = rows.map((r) => require('./sqlTransfer').encodeRow(r, metadati.info.columns));
      } else {
        lines = rows.map((r) => rigaCsv(columns.map((c) => r[c]), { modalita: payload.csvMode }));
      }
      return {
        lines,
        count: rows.length,
        total,
        format,
        header: format === 'csv' ? rigaCsv(columns, { modalita: payload.csvMode }) : null,
        nextAfter,
      };
    },

    async collectionImport(db, coll, payload) {
      const pool = this.requirePool();
      const raw = Array.isArray(payload.docs) ? payload.docs : [];
      if (!raw.length) throw new Error('Nessuna riga da importare nel blocco.');
      const table = qtable(db, coll);
      let inserted = 0;
      const errors = [];
      const conflictColumns = Array.isArray(payload.conflictColumns)
        ? payload.conflictColumns.filter((c) => typeof c === 'string' && c)
        : [];
      if (payload.upsert && !conflictColumns.length) {
        throw new Error(`Upsert rifiutato per "${coll}": il piano non dichiara un'identita stabile.`);
      }

      let geo = new Map();
      let scrivibili = new Set();
      let colonneReali = new Set();
      let columnTypes = new Map();
      try {
        const info = await this.tableColumnsInfo(db, coll);
        columnTypes = new Map(info.columns.map((c) => [c.name, c]));
        colonneReali = new Set(info.columns.map((c) => c.name));
        geo = info.geo || geo;
        scrivibili = new Set(info.columns.filter((c) => !c.generated).map((c) => c.name));
      } catch { /* metadati non leggibili: vale il comportamento storico */ }

      const parsed = [];
      for (let i = 0; i < raw.length; i++) {
        try {
          const row = deserializeClientObject(raw[i]);
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('la riga deve essere un oggetto { "colonna": valore }');
          }
          for (const nome of Object.keys(row)) {
            if (colonneReali.has(nome) && !scrivibili.has(nome)) delete row[nome];
          }
          const cols = Object.keys(row);
          parsed.push({ i, cols, values: cols.map((c) => row[c]) });
        } catch (err) {
          if (errors.length < 10) errors.push(`Riga ${i + 1}: ${(err && err.message) || err}`);
        }
      }

      if (payload.upsert) {
        const incompleta = parsed.find((p) => conflictColumns.some((c) => !p.cols.includes(c)));
        if (incompleta) {
          throw new Error(
            `Upsert rifiutato per "${coll}": la riga ${incompleta.i + 1} non contiene tutta l'identita stabile `
            + `(${conflictColumns.join(', ')}).`
          );
        }
      }

      const coda = (cols) => {
        if (!payload.upsert) return '';
        const aggiornabili = cols.filter((c) => !conflictColumns.includes(c));
        const assegnazioni = aggiornabili.length
          ? aggiornabili.map((c) => `${qid(c)} = VALUES(${qid(c)})`)
          : [`${qid(conflictColumns[0])} = ${qid(conflictColumns[0])}`];
        const stessaIdentita = conflictColumns.map((c) => `${qid(c)} <=> VALUES(${qid(c)})`).join(' AND ');
        const guardia = `${qid(conflictColumns[0])} = IF(${stessaIdentita}, ${qid(conflictColumns[0])}, NULL)`;
        return ` ON DUPLICATE KEY UPDATE ${[guardia, ...assegnazioni].join(', ')}`;
      };

      const geoBindingFn = this.constructor && typeof this.constructor.geoBinding === 'function'
        ? this.constructor.geoBinding.bind(this.constructor)
        : (col, val) => ({ sql: '?', param: toSqlValue(val) });

      const inserimento = (cols, righe) => {
        const params = [];
        const zeroColumns = [];
        const tuple = righe.map((r, rowIndex) => {
          const ph = r.values.map((valore, indice) => {
            const ordinal = require('./mysql-ordinal').binding(valore, columnTypes.get(cols[indice]));
            const bind = ordinal || geoBindingFn(cols[indice], valore, geo, { importazione: true });
            if (ordinal?.zero) zeroColumns.push({ column: cols[indice], row: rowIndex + 1 });
            params.push(bind.param);
            return bind.sql;
          });
          return `(${ph.join(', ')})`;
        });
        return {
          sql: `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES ${tuple.join(', ')}${coda(cols)}`,
          params,
          zeroColumns,
        };
      };

      const BATCH_SIZE = 500;
      const groups = [];
      let cur = null;
      for (const p of parsed) {
        const sig = p.cols.join('\u0000');
        const bytes = Buffer.byteLength(JSON.stringify(p.values), 'utf8');
        if (cur && cur.sig === sig && cur.rows.length < BATCH_SIZE && cur.bytes + bytes <= 1024 * 1024) {
          cur.rows.push(p);
          cur.bytes += bytes;
        } else {
          cur = { sig, cols: p.cols, rows: [p], bytes };
          groups.push(cur);
        }
      }

      const conn = await pool.getConnection();
      let session;
      try {
        [[session]] = await conn.query('SELECT @@SESSION.time_zone AS timezone, @@SESSION.sql_mode AS mode');
        await conn.query("SET SESSION time_zone = ?, SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_ALL_TABLES'", [payload.timeZone || '+00:00']);
        const write = (sql, params, zeroColumns) => require('./mysql-ordinal').write(conn, sql, params, zeroColumns);
        for (const g of groups) {
          try {
            const q = inserimento(g.cols, g.rows);
            await write(q.sql, q.params, q.zeroColumns);
            inserted += g.rows.length;
          } catch (err) {
            assertImportOutcomeKnown(err);
            for (const r of g.rows) {
              try {
                const q = inserimento(g.cols, [r]);
                await write(q.sql, q.params, q.zeroColumns);
                inserted += 1;
              } catch (errRiga) {
                assertImportOutcomeKnown(errRiga);
                if (errors.length < 10) errors.push(`Riga ${r.i + 1}: ${(errRiga && errRiga.message) || errRiga}`);
              }
            }
          }
        }
      } finally {
        try {
          if (session) await conn.query('SET SESSION time_zone = ?, SESSION sql_mode = ?', [session.timezone, session.mode]);
          conn.release();
        } catch (err) {
          conn.destroy();
          throw err;
        }
      }
      return { inserted, failed: raw.length - inserted, errors };
    },
  });
}

module.exports = { installaTrasferimentoMysql };
