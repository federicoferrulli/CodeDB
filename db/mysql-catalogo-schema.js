'use strict';

const mysql = require('mysql2');
const DbStrategy = require('./DbStrategy');
const { colonnaGenerata, defaultDaCreate } = require('./mysqlColonne');
const { quotaSempre, quotaQualificato } = require('./identificatori');
const { isSqlGeometryType } = require('./geometry');
const { raggruppaVincoli } = require('./relazioni');
const { definisciMetodi } = require('./prototipoStrategia');
const { creaIndiceSql, pianificaDuplicatoSql } = require('./sqlCatalogoComune');

function qid(name) {
  return quotaSempre(name, 'mysql');
}

function qtable(db, table) {
  return quotaQualificato([db, table], 'mysql');
}

/* ---------------------------------------------------------------------------
 * Il dialetto MySQL dei metadati comuni (db/sqlMetadati.js).
 *
 * Qui c'è solo ciò che di MySQL c'è davvero: le query al catalogo, il modo di
 * leggerne le righe e il segnaposto dei parametri. Le decisioni — quando una
 * stima vale, che cosa è un indice unico, come si compone la pagina a chiave —
 * stanno nel modulo, in una copia sola.
 * ------------------------------------------------------------------------- */
const DIALETTO_METADATI = {
  qid,
  segnaposto: () => '?',
  schema: (db) => String(db == null ? '' : db),
  esegui: async (strategia, sql, params) => (
    await (params === undefined ? strategia.requirePool().query(sql) : strategia.requirePool().query(sql, params))
  )[0],

  chiavePrimaria: {
    query: (db, table) => ({
      sql: `SELECT COLUMN_NAME AS name
              FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
          ORDER BY ORDINAL_POSITION`,
      params: [db, table],
    }),
  },

  colonne: {
    // `SRS_ID` esiste da MySQL 8: su 5.7 la query fallisce, e il secondo
    // tentativo la legge senza (là il SRID non è vincolato).
    tentativi: (db, coll) => ['SRS_ID', 'NULL'].map((srid) => ({
      sql: `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_TYPE AS declaredType,
                   ${srid} AS srid, EXTRA AS extra,
                   IS_NULLABLE AS nullable
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
      params: [db, coll],
    })),
    visibile: (r) => !/\bINVISIBLE\b/i.test(String(r.extra || '')),
    generato: (r) => colonnaGenerata(r.extra),
    dettagli: (r) => /\bauto_increment\b/i.test(r.extra) ? { autoIncrement: true } : {},
    classi: [{ nome: 'geo', riconosce: isSqlGeometryType }],
  },

  campi: {
    query: (db, table) => ({
      sql: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable,
                   COLUMN_DEFAULT AS cdefault, EXTRA AS extra, COLUMN_KEY AS ckey
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
      params: [db, table],
    }),
    tipo: (c) => String(c.ctype),
    autoIncrement: (c) => /auto_increment/i.test(String(c.extra || '')),
    generato: (c) => colonnaGenerata(c.extra),
    chiave: (c) => String(c.ckey || ''),
  },

  indici: {
    query: (db, table) => ({ sql: `SHOW INDEX FROM ${qtable(db, table)}`, params: [] }),
    lettori: {
      nome: (r) => r.Key_name,
      colonna: (r) => r.Column_name,
      ordine: (r) => r.Seq_in_index,
      unico: (r) => !Number(r.Non_unique),
      primario: (r) => r.Key_name === 'PRIMARY',
    },
    assentiSeErrore: true, // le view non hanno indici: SHOW INDEX fallisce
  },

  stima: {
    query: (db, coll) => ({
      sql: 'SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = ?',
      params: [db, coll, 'BASE TABLE'],
    }),
    attendibile: () => true,
  },
};

// DEFAULT di colonna: numeri e parole chiave (NULL, CURRENT_TIMESTAMP...)
// passano così come sono, il resto viene quotato come stringa.
function defaultSql(v) {
  const t = String(v).trim();
  if (/^(NULL|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|TRUE|FALSE)$/i.test(t)) return t.toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return mysql.escape(t);
}

// Definizione SQL di una colonna a partire dall'oggetto del form:
// { name, type, nullable, default, autoIncrement }.
function columnSql(c) {
  const name = String((c && c.name) || '').trim();
  const type = String((c && c.type) || '').trim();
  if (!name || !type) throw new Error('Ogni colonna deve avere nome e tipo.');
  DbStrategy.assertColumnType(type);
  let s = `${qid(name)} ${type}`;
  if (c.charset) s += ` CHARACTER SET ${qid(c.charset)}`;
  if (c.collation) s += ` COLLATE ${qid(c.collation)}`;
  if (c.nullable === false) s += ' NOT NULL';
  if (c.default != null && String(c.default).trim() !== '') s += ` DEFAULT ${defaultSql(c.default)}`;
  // La visibilità (MySQL 8.0.23+) va DOPO il default e PRIMA di AUTO_INCREMENT.
  if (c.invisible) s += ' INVISIBLE';
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  return s;
}

// I metadati arrivano dal server; la bozza li aggiorna dopo ogni ALTER.
function columnAlterSqlStatica(db, coll, payload, originale) {
  const oldName = payload.oldName;
  if (String(originale.generationExpression || '').trim()) {
    throw new Error(
      'La modifica visuale di una colonna generata non è supportata: usa una DDL esplicita per non perderne l’espressione.'
    );
  }
  const extra = String(originale.extra || '');
  const sconosciuti = extra
    .replace(/auto_increment/ig, '')
    .replace(/default_generated/ig, '')
    .replace(/\bINVISIBLE\b/ig, '')
    .replace(/on update CURRENT_TIMESTAMP(?:\(\d+\))?/ig, '')
    .trim();
  if (sconosciuti) {
    throw new Error(`La colonna contiene attributi MySQL non modificabili in sicurezza (${sconosciuti}). Usa una DDL esplicita.`);
  }
  const column = { ...(payload.column || {}) };
  column.autoIncrement = /auto_increment/i.test(extra);
  column.invisible = /\bINVISIBLE\b/i.test(extra);
  const tipoTestuale = /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(String(column.type || '').trim());
  let definizione = columnSql({
    ...column,
    invisible: false,
    autoIncrement: false,
    charset: tipoTestuale ? originale.charset : undefined,
    collation: tipoTestuale ? originale.collation : undefined,
    default: /default_generated/i.test(extra) && String(column.default ?? '') === String(originale.defaultValue ?? '') ? undefined : column.default,
  });
  if (/default_generated/i.test(extra) && String(column.default ?? '') === String(originale.defaultValue ?? '') && originale.defaultValue != null) {
    definizione += ` DEFAULT ${originale.defaultExpression}`;
  }
  if (column.invisible) definizione += ' INVISIBLE';
  if (column.autoIncrement) definizione += ' AUTO_INCREMENT';
  const onUpdate = extra.match(/on update CURRENT_TIMESTAMP(?:\(\d+\))?/i);
  if (onUpdate) definizione += ` ${onUpdate[0].toUpperCase()}`;
  if (originale.comment) definizione += ` COMMENT ${mysql.escape(String(originale.comment))}`;
  if (/^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/i.test(String(column.type).trim())) {
    if (originale.srid != null) definizione += ` SRID ${Number(originale.srid)}`;
  }
  return `ALTER TABLE ${qtable(db, coll)} CHANGE COLUMN ${qid(oldName)} ${definizione}`;
}

function installaCatalogoMysql(prototipo) {
  definisciMetodi(prototipo, {
    async tableDdl(db, coll) {
      const pool = this.requirePool();
      return require('./mysql-ddl').mysqlTableDdl(pool, db, coll, this.metadataPool || pool);
    },

    async tableAuxDdl(db, coll) {
      const pool = this.requirePool();
      const ddl = await require('./mysql-ddl').mysqlTableDdl(pool, db, coll, this.metadataPool || pool);
      const [[count]] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
        [db, coll]
      );
      if (!Number.isSafeInteger(Number(count?.n)) || Number(count.n) < 0) {
        throw new Error('Conteggio delle chiavi esterne MySQL non valido.');
      }
      return {
        indexes: [],
        foreignKeys: require('../backup/lib/engine').splitMySqlForeignKeys(ddl, coll, Number(count.n)).foreignKeys,
      };
    },

    async dbSchema(db) {
      const pool = this.requirePool();
      const [tables] = await pool.query(
        `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
        [db]
      );

      const [columns] = await pool.query(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [db]
      );

      const colsByTable = new Map();
      for (const row of columns) {
        if (!colsByTable.has(row.TABLE_NAME)) colsByTable.set(row.TABLE_NAME, []);
        colsByTable.get(row.TABLE_NAME).push({
          name: row.COLUMN_NAME,
          types: [row.DATA_TYPE || row.COLUMN_TYPE || 'varchar'],
          pk: row.COLUMN_KEY === 'PRI',
          nullable: row.IS_NULLABLE === 'YES',
          presence: row.IS_NULLABLE === 'YES' ? 0 : 100,
        });
      }

      const collections = tables.map((t) => ({
        name: t.TABLE_NAME,
        fields: colsByTable.get(t.TABLE_NAME) || [],
        rowsApprox: t.TABLE_ROWS == null ? null : Number(t.TABLE_ROWS),
      }));

      const [fkRows] = await pool.query(
        `SELECT CONSTRAINT_NAME, ORDINAL_POSITION, TABLE_NAME, COLUMN_NAME,
                REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
        [db]
      );

      const relations = [];
      const fkSet = new Set();
      for (const fk of fkRows) {
        relations.push({
          from: fk.TABLE_NAME,
          field: fk.COLUMN_NAME,
          to: fk.REFERENCED_TABLE_NAME,
          toDb: fk.REFERENCED_TABLE_SCHEMA || db,
          external: !!fk.REFERENCED_TABLE_SCHEMA && fk.REFERENCED_TABLE_SCHEMA !== db,
          many: true,
          constraint: fk.CONSTRAINT_NAME,
          ordine: Number(fk.ORDINAL_POSITION) || 1,
          toField: fk.REFERENCED_COLUMN_NAME,
          origine: 'vincolo',
        });
        fkSet.add(`${fk.TABLE_NAME}.${fk.COLUMN_NAME}->${fk.REFERENCED_TABLE_NAME}`);
      }

      const detected = DbStrategy.detectRelations(collections);
      for (const r of detected) {
        const key = `${r.from}.${r.field}->${r.to}`;
        if (!fkSet.has(key)) {
          relations.push(r);
        }
      }

      return { collections, relations };
    },

    async columnRelations(db, coll) {
      const pool = this.requirePool();
      const [rows] = await pool.query(
        `SELECT k.CONSTRAINT_NAME, k.ORDINAL_POSITION, k.COLUMN_NAME,
                k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
                r.DELETE_RULE, r.UPDATE_RULE
           FROM information_schema.KEY_COLUMN_USAGE k
           JOIN information_schema.REFERENTIAL_CONSTRAINTS r
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [db, coll]
      );
      return raggruppaVincoli(rows.map((r) => ({
        nome: r.CONSTRAINT_NAME,
        onDelete: r.DELETE_RULE,
        onUpdate: r.UPDATE_RULE,
        ordine: r.ORDINAL_POSITION,
        campo: r.COLUMN_NAME,
        db: r.REFERENCED_TABLE_SCHEMA || db,
        tabella: r.REFERENCED_TABLE_NAME,
        colonna: r.REFERENCED_COLUMN_NAME,
      })));
    },

    async createCollection(db, name, payload = {}) {
      const pool = this.requirePool();
      const table = String(name || '').trim();
      if (!table) throw new Error('Nome della tabella mancante.');
      DbStrategy.assertCreatableName(table, 'della tabella');
      const cols = Array.isArray(payload.columns) ? payload.columns : [];
      let defs;
      if (!cols.length) {
        defs = [`${qid('id')} INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`];
      } else {
        defs = cols.map(columnSql);
        const pk = cols.filter((c) => c.primaryKey).map((c) => qid(String(c.name).trim()));
        if (pk.length) defs.push(`PRIMARY KEY (${pk.join(', ')})`);
      }
      await pool.query(`CREATE TABLE ${qtable(db, table)} (${defs.join(', ')})`);
    },

    async renameCollection(db, coll, newName) {
      const pool = this.requirePool();
      const to = String(newName || '').trim();
      if (!to) throw new Error('Nuovo nome della tabella mancante.');
      DbStrategy.assertCreatableName(to, 'della tabella');
      await pool.query(`RENAME TABLE ${qtable(db, coll)} TO ${qtable(db, to)}`);
      this._cacheColonne.clear();
    },

    async dropCollection(db, coll) {
      const pool = this.requirePool();
      await pool.query(`DROP TABLE ${qtable(db, coll)}`);
      this._cacheColonne.clear();
    },

    async addColumn(db, coll, column) {
      const pool = this.requirePool();
      await pool.query(`ALTER TABLE ${qtable(db, coll)} ADD COLUMN ${columnSql(column || {})}`);
      this._cacheColonne.clear();
    },

    async alterColumn(db, coll, payload) {
      const sql = await this.columnAlterSql(db, coll, payload);
      await this.requirePool().query(sql);
      this._cacheColonne.clear();
    },

    async columnAlterSql(db, coll, payload) {
      const oldName = String((payload && payload.oldName) || '').trim();
      if (!oldName) throw new Error('Nome della colonna da modificare mancante.');
      const costruttore = this.constructor && typeof this.constructor.columnAlterSql === 'function'
        ? this.constructor.columnAlterSql
        : columnAlterSqlStatica;
      return costruttore(db, coll, { ...payload, oldName }, await this.columnDefinition(db, coll, oldName));
    },

    async columnDefinition(db, coll, oldName) {
      const pool = this.requirePool();
      const [rows] = await pool.query(
        `SELECT EXTRA AS extra, COLUMN_DEFAULT AS defaultValue, COLUMN_TYPE AS columnType, GENERATION_EXPRESSION AS generationExpression,
                COLUMN_COMMENT AS comment, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [db, coll, oldName]
      );
      const originale = rows[0];
      if (!originale) throw new Error(`Colonna ${oldName} non trovata.`);
      if (/default_generated/i.test(originale.extra || '') && originale.defaultValue != null) {
        originale.defaultExpression = defaultDaCreate(await this.tableDdl(db, coll), qid(oldName));
      }
      if (/^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/i.test(originale.columnType)) {
        try {
          const [srids] = await pool.query(
            'SELECT SRS_ID AS srid FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [db, coll, oldName]
          );
          originale.srid = srids[0]?.srid;
        } catch (err) {
          if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        }
      }
      return originale;
    },

    async dropColumn(db, coll, name) {
      const pool = this.requirePool();
      const column = String(name || '').trim();
      if (!column) throw new Error('Nome della colonna da eliminare mancante.');
      await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP COLUMN ${qid(column)}`);
    },

    async createIndex(db, coll, payload) {
      return creaIndiceSql(this, { qid, qtable }, db, coll, payload);
    },

    async dropIndex(db, coll, name) {
      const pool = this.requirePool();
      const idx = String(name || '').trim();
      if (!idx) throw new Error('Nome dell\'indice da eliminare mancante.');
      if (idx.toUpperCase() === 'PRIMARY') {
        await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP PRIMARY KEY`);
      } else {
        await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP INDEX ${qid(idx)}`);
      }
    },

    async duplicatePlan(db, coll, payload) {
      return pianificaDuplicatoSql(
        this,
        { qid, qtable, segnaposto: DIALETTO_METADATI.segnaposto, esegui: DIALETTO_METADATI.esegui },
        db,
        coll,
        payload
      );
    },

    async collectionStats(db, coll) {
      const pool = this.requirePool();
      const [[t]] = await pool.query(
        `SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AVG_ROW_LENGTH
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [db, coll]
      );
      if (!t) throw new Error(`Tabella "${coll}" non trovata in "${db}".`);

      let indexes = [];
      try {
        const [idx] = await pool.query(`SHOW INDEX FROM ${qtable(db, coll)}`);
        const byName = new Map();
        for (const i of idx) {
          let entry = byName.get(i.Key_name);
          if (!entry) byName.set(i.Key_name, (entry = { name: i.Key_name, key: {}, unique: !Number(i.Non_unique) }));
          entry.key[i.Column_name] = 1;
        }
        indexes = [...byName.values()];
      } catch { /* le view non hanno indici */ }

      const fields = await this.tableFields(db, coll);
      return {
        stats: {
          count: Number(t.TABLE_ROWS) || 0,
          size: Number(t.DATA_LENGTH) || 0,
          storageSize: (Number(t.DATA_LENGTH) || 0) + (Number(t.INDEX_LENGTH) || 0),
          avgObjSize: Number(t.AVG_ROW_LENGTH) || 0,
          totalIndexSize: Number(t.INDEX_LENGTH) || 0,
          nindexes: indexes.length,
        },
        indexes,
        fields,
        sampled: Number(t.TABLE_ROWS) || 0,
      };
    },
  });
}

module.exports = {
  DIALETTO_METADATI,
  defaultSql,
  columnSql,
  columnAlterSqlStatica,
  qid,
  qtable,
  installaCatalogoMysql,
};
