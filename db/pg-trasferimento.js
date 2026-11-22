'use strict';

const { EJSON } = require('bson');
const { assertImportOutcomeKnown } = require('./importFailure');
const { parseClientValue, deserializeClientObject, preparaBinariEjson } = require('./sqlValori');
const { tipoColonna, valorePostgres } = require('./pg-valori');
const { rigaCsv } = require('./csv');
const { quotaSempre, quotaQualificato } = require('./identificatori');
const { definisciMetodi } = require('./prototipoStrategia');

/**
 * Trasferimento tabellare PostgreSQL: esportazione paginata (keyset su PK o
 * fallback OFFSET, con esclusione delle colonne generate e risoluzione
 * riferimenti/alias OID) e importazione a blocchi per firma di colonne con
 * `OVERRIDING SYSTEM VALUE`, `ON CONFLICT DO UPDATE` e isolamento riga per riga
 * in caso di errore.
 */
function installaTrasferimentoPg(prototipo, { schemaOf, geoBindingFallback }) {
  const qid = (name) => quotaSempre(name, 'postgresql');
  const qtable = (db, table) => quotaQualificato([schemaOf(db), table], 'postgresql');

  return definisciMetodi(prototipo, {
    async collectionExport(db, coll, payload) {
      const pool = this.requirePool();
      const format = ['sql', 'json'].includes(payload.format) ? payload.format : 'csv';
      const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 1000);
      const table = qtable(db, coll);
      const pk = await this.primaryKey(db, coll);
      // Il trasferimento usa il formato nativo testuale, senza conversioni del driver.
      const primaPagina = !payload.after && !(Number(payload.skip) > 0);
      const metadati = format !== 'csv'
        ? await this.metadatiEsportazione(db, coll, primaPagina)
        : null;
      if (metadati && primaPagina) {
        require('./pg-alias').attach(
          metadati.info.columns,
          await require('./pg-references').columnReferences((s, p) => pool.query(s, p), schemaOf(db), coll)
        );
      }
      const info = metadati?.info || await this.tableColumnsInfo(db, coll);
      const perNome = new Map(info.columns.map((c) => [c.name, c]));
      const selectList = metadati
        ? require('./sqlTransfer').projection(metadati.info, false)
        : info.columns.map((c) => (tipoColonna(c).kind === 'array' ? `${qid(c.name)}::text AS ${qid(c.name)}` : qid(c.name))).join(', ') || '*';

      let rows;
      let fields;
      let nextAfter = null;

      if (pk.length) {
        const pkCols = pk.map((c) => `${table}.${qid(c)}`).join(', ');
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
          whereSql = ` WHERE (${pkCols}) > (${pk.map((_, i) => `$${i + 1}`).join(', ')})`;
          params = afterVals.map((v, i) => valorePostgres(v, perNome.get(pk[i])));
        }
        params.push(limit);
        const limitIdx = params.length;
        const res = await pool.query(
          `SELECT ${selectList} FROM ${table}${whereSql} ORDER BY ${pkCols} LIMIT $${limitIdx}`,
          params
        );
        rows = res.rows;
        fields = res.fields;
        if (rows.length) {
          const last = rows[rows.length - 1];
          nextAfter = EJSON.stringify(preparaBinariEjson(pk.map((c) => last[c])), { relaxed: false });
        }
      } else {
        const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
        const res = await pool.query(`SELECT ${selectList} FROM ${table} LIMIT $1 OFFSET $2`, [limit, skip]);
        rows = res.rows;
        fields = res.fields;
      }

      const total = await this.totaleEsportazione(table, primaPagina);
      let columns = fields ? fields.map((f) => f.name) : [];
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
        lines = rows.map((r) => require('./databaseExport').insertSql(
          'postgresql',
          table,
          require('./sqlTransfer').encodeRow(r, metadati.info.columns, false),
          metadati.info
        ).trim());
      } else if (format === 'json') {
        lines = rows.map((r) => require('./sqlTransfer').encodeRow(r, metadati.info.columns, false));
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
      const geoBinding = (this.constructor && this.constructor.geoBinding) || geoBindingFallback;

      const conflictColumns = Array.isArray(payload.conflictColumns)
        ? payload.conflictColumns.filter((c) => typeof c === 'string' && c)
        : [];
      const pk = payload.upsert
        ? (conflictColumns.length ? conflictColumns : await this.primaryKey(db, coll))
        : [];
      if (payload.upsert && !pk.length) {
        throw new Error(`Upsert rifiutato per "${coll}": il piano non dichiara un'identita stabile.`);
      }

      let colonneReali = new Set();
      let geo = new Map();
      let geoNativo = new Map();
      let scrivibili = new Set();
      let importColumnTypes = new Map();
      let perNome = new Map();
      try {
        const info = await this.tableColumnsInfo(db, coll);
        perNome = new Map(info.columns.map((c) => [c.name, c]));
        importColumnTypes = new Map(info.columns.map((c) => [
          c.name,
          String(c.type || c.ctype || '').toLowerCase().replace(/^_(regproc|regoper)$/, '$1[]'),
        ]));
        colonneReali = new Set(info.columns.map((c) => c.name));
        geo = info.geo || geo;
        geoNativo = info.geoNativo || geoNativo;
        scrivibili = new Set(info.columns.filter((c) => !c.generated).map((c) => c.name));
      } catch (err) {
        throw new Error('Impossibile leggere i tipi delle colonne prima dell’importazione PostgreSQL.', { cause: err });
      }

      if (raw.some((row) => Object.values(row).some((v) => v?.$pgReference?.kind === 'nested'))) {
        const shapes = await require('./pg-references').columnReferences((s, p) => pool.query(s, p), schemaOf(db), coll);
        await require('./pg-alias').resolveNested((s, p) => pool.query(s, p), raw, shapes);
      }
      const parsed = [];
      for (let i = 0; i < raw.length; i++) {
        try {
          const row = deserializeClientObject(raw[i]);
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('la riga deve essere un oggetto { "colonna": valore }');
          }
          if (!colonneReali.has('_id')) delete row._id;
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
        const incompleta = parsed.find((p) => pk.some((c) => !p.cols.includes(c)));
        if (incompleta) {
          throw new Error(
            `Upsert rifiutato per "${coll}": la riga ${incompleta.i + 1} non contiene tutta l'identita stabile `
            + `(${pk.join(', ')}).`
          );
        }
      }

      const sqlPerGruppo = (cols, righe) => {
        if (!cols.length) return { sql: `INSERT INTO ${table} DEFAULT VALUES`, valori: [] };
        const valori = [];
        const tuple = righe.map((vals) => {
          const ph = vals.map((v, indice) => {
            const placeholder = `$${valori.length + 1}`;
            const reference = v?.$pgReference && importColumnTypes.get(cols[indice]) === v.$pgReference.kind
              ? require('./pg-alias').binding(v)
              : null;
            const bind = reference
              ? { ...reference, sql: reference.sql.replace('$1', placeholder) }
              : geoBinding(cols[indice], v, geo, placeholder, geoNativo, perNome.get(cols[indice]));
            valori.push(bind.param);
            return bind.sql;
          });
          return `(${ph.join(', ')})`;
        });
        let sql = `INSERT INTO ${table} (${cols.map(qid).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuple.join(', ')}`;
        if (pk.length && pk.every((c) => cols.includes(c))) {
          const updateCols = cols.filter((c) => !pk.includes(c));
          sql += ` ON CONFLICT (${pk.map(qid).join(', ')})`;
          sql += updateCols.length
            ? ` DO UPDATE SET ${updateCols.map((c) => `${qid(c)} = EXCLUDED.${qid(c)}`).join(', ')}`
            : ' DO NOTHING';
        }
        return { sql, valori };
      };

      const BLOCCO = 200;
      const gruppi = new Map();
      for (const p of parsed) {
        const firma = p.cols.join('\u0000');
        if (!gruppi.has(firma)) gruppi.set(firma, { cols: p.cols, elementi: [] });
        gruppi.get(firma).elementi.push(p);
      }

      const inserisciSingole = async (elementi) => {
        for (const p of elementi) {
          try {
            const { sql, valori } = sqlPerGruppo(p.cols, [p.values]);
            await pool.query(sql, valori);
            inserted += 1;
          } catch (err) {
            assertImportOutcomeKnown(err);
            if (errors.length < 10) errors.push(`Riga ${p.i + 1}: ${(err && err.message) || err}`);
          }
        }
      };

      for (const { cols, elementi } of gruppi.values()) {
        const limite = cols.length ? Math.max(1, Math.min(BLOCCO, Math.floor(60000 / cols.length))) : 1;
        for (let i = 0; i < elementi.length;) {
          const blocco = [];
          let bytes = 0;
          while (i < elementi.length && blocco.length < limite) {
            const size = Buffer.byteLength(JSON.stringify(elementi[i].values), 'utf8');
            if (blocco.length && bytes + size > 1024 * 1024) break;
            bytes += size;
            blocco.push(elementi[i++]);
          }
          try {
            const { sql, valori } = sqlPerGruppo(cols, blocco.map((p) => p.values));
            await pool.query(sql, valori);
            inserted += blocco.length;
          } catch (err) {
            assertImportOutcomeKnown(err);
            await inserisciSingole(blocco);
          }
        }
      }

      return { inserted, failed: raw.length - inserted, errors };
    },
  });
}

module.exports = { installaTrasferimentoPg };
