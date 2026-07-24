'use strict';

const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);
const SYSTEM_DBS = new Set(['postgres', 'template0', 'template1']);

/* ---------------------------------------------------------------------------
 * Helpers PostgreSQL
 * ------------------------------------------------------------------------- */

function assertDbName(name) {
  if (!name || /[\r\n]/.test(name) || name.length > 63) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

// Identificatore quotato ("), gestendo eventuali virgolette interne
function qid(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function qtable(db, table) {
  return `${qid(table)}`;
}

// Converte un valore proveniente dal client (deserializzato da EJSON)
// in un parametro SQL per pg.
function toSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') {
    if (v._bsontype === 'Binary') return v.buffer;
    return JSON.stringify(v);
  }
  return v;
}

function parseClientValue(text) {
  return EJSON.parse(String(text), { relaxed: true });
}

function deserializeClientObject(obj) {
  return EJSON.deserialize(obj || {}, { relaxed: true });
}

function serializeRow(row) {
  return EJSON.serialize(row, { relaxed: true });
}

function whereFromId(id) {
  const cols = Object.keys(id);
  if (!cols.length) throw new Error('Identificatore di riga mancante.');
  const sqlParts = [];
  const params = [];
  let idx = 1;
  for (const c of cols) {
    const val = toSqlValue(id[c]);
    if (val === null) {
      sqlParts.push(`${qid(c)} IS NULL`);
    } else {
      sqlParts.push(`${qid(c)} = $${idx++}`);
      params.push(val);
    }
  }
  return { sql: sqlParts.join(' AND '), params };
}

function defaultSql(v) {
  const t = String(v).trim();
  if (/^(NULL|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|TRUE|FALSE)$/i.test(t)) return t.toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return `'${t.replace(/'/g, "''")}'`;
}

function columnSql(c) {
  const name = String((c && c.name) || '').trim();
  let type = String((c && c.type) || '').trim();
  if (!name || !type) throw new Error('Ogni colonna deve avere nome e tipo.');

  if (c.autoIncrement) {
    if (/bigint/i.test(type)) type = 'BIGSERIAL';
    else if (/int/i.test(type)) type = 'SERIAL';
  }

  let s = `${qid(name)} ${type}`;
  if (c.nullable === false) s += ' NOT NULL';
  if (c.default != null && String(c.default).trim() !== '' && !c.autoIncrement) {
    s += ` DEFAULT ${defaultSql(c.default)}`;
  }
  return s;
}

/* ---------------------------------------------------------------------------
 * Strategia PostgreSQL: un pool pg per istanza (cioè per socket)
 * ------------------------------------------------------------------------- */

class PostgreSqlStrategy extends DbStrategy {
  constructor() {
    super();
    this.pool = null;
    this._config = null;
  }

  get type() { return 'postgresql'; }

  requirePool() {
    if (!this.pool) throw new Error('Nessuna connessione attiva al database.');
    return this.pool;
  }

  async connect(cfg) {
    this._config = cfg;
    let pg;
    try {
      pg = require('pg');
    } catch (_err) {
      throw new Error('Driver PostgreSQL non installato. Esegui "npm install pg".');
    }

    const pool = new pg.Pool({
      host: (cfg.host || 'localhost').trim(),
      port: parseInt(cfg.port, 10) || 5432,
      user: cfg.username || 'postgres',
      password: cfg.password || '',
      database: (cfg.database || 'postgres').trim() || 'postgres',
      connectionTimeoutMillis: 6000,
      max: 4,
    });

    try {
      await pool.query('SELECT 1');
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    this.pool = pool;
    return { ok: true, message: 'Connessione a PostgreSQL stabilita.' };
  }

  async disconnect() {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.end().catch(() => {});
    }
  }

  async listDatabases() {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT datname AS name, pg_database_size(datname) AS size
         FROM pg_database
        WHERE datistemplate = false
     ORDER BY datname`
    );
    return res.rows.map((r) => ({ name: r.name, sizeOnDisk: Number(r.size) || 0 }));
  }

  async createDatabase(db, firstColl) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    try {
      await pool.query(`CREATE DATABASE ${qid(name)}`);
    } catch (err) {
      if (err && err.code === '42P04') throw new Error(`Il database "${name}" esiste già.`);
      throw err;
    }

    const table = String(firstColl || '').trim();
    if (table) {
      const pg = require('pg');
      const client = new pg.Client({
        host: (this._config.host || 'localhost').trim(),
        port: parseInt(this._config.port, 10) || 5432,
        user: this._config.username || 'postgres',
        password: this._config.password || '',
        database: name,
        connectionTimeoutMillis: 6000,
      });
      try {
        await client.connect();
        await client.query(`CREATE TABLE ${qid(table)} (id SERIAL PRIMARY KEY)`);
      } finally {
        await client.end().catch(() => {});
      }
    }
  }

  async renameDatabase(db, newName) {
    const pool = this.requirePool();
    const from = String(db || '').trim();
    const to = String(newName || '').trim();
    assertDbName(from);
    assertDbName(to);
    if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
    if (SYSTEM_DBS.has(from.toLowerCase())) {
      throw new Error(`Il database di sistema "${from}" non può essere rinominato.`);
    }
    try {
      // Disconnette eventuali altre sessioni per consentire la rinomina
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [from]
      );
      await pool.query(`ALTER DATABASE ${qid(from)} RENAME TO ${qid(to)}`);
    } catch (err) {
      if (err && err.code === '42P04') throw new Error(`Il database "${to}" esiste già.`);
      throw err;
    }
  }

  async dropDatabase(db) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    if (SYSTEM_DBS.has(name.toLowerCase())) {
      throw new Error(`Il database di sistema "${name}" non può essere eliminato.`);
    }
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    );
    await pool.query(`DROP DATABASE ${qid(name)}`);
  }

  async listCollections(_db) {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT t.table_name AS name, t.table_type AS ttype, COALESCE(c.reltuples::bigint, 0) AS cnt
         FROM information_schema.tables t
    LEFT JOIN pg_class c ON c.relname = t.table_name
    LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY t.table_name`
    );
    return res.rows.map((r) => {
      const isView = String(r.ttype || '').toUpperCase().includes('VIEW');
      return {
        name: r.name,
        type: isView ? 'view' : 'collection',
        count: isView ? null : Math.max(0, Number(r.cnt) || 0),
      };
    });
  }

  async search(query) {
    const pool = this.requirePool();
    const term = `%${(query || '').toLowerCase()}%`;
    const sql = `
      SELECT table_catalog AS db, table_name AS coll
        FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND (LOWER(table_catalog) LIKE $1 OR LOWER(table_name) LIKE $1)
    `;
    const res = await pool.query(sql, [term]);
    const dbs = new Map();
    for (const r of res.rows) {
      if (!dbs.has(r.db)) dbs.set(r.db, []);
      dbs.get(r.db).push({ name: r.coll });
    }
    return Array.from(dbs.entries()).map(([name, collections]) => ({ name, collections }));
  }

  async primaryKey(_db, table) {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT kcu.column_name AS name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND tc.table_name = $1
     ORDER BY kcu.ordinal_position`,
      [table]
    );
    return res.rows.map((r) => r.name);
  }

  makeId(row, pkCols, allCols) {
    const cols = pkCols.length ? pkCols : allCols;
    const id = {};
    for (const c of cols) id[c] = row[c];
    return id;
  }

  parseRowId(rawId) {
    const id = parseClientValue(rawId);
    if (!id || typeof id !== 'object' || Array.isArray(id)) {
      throw new Error('Identificatore di riga non valido.');
    }
    return whereFromId(id);
  }

  buildOrderBy(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (t.startsWith('{')) {
      let spec;
      try {
        spec = JSON.parse(t);
      } catch {
        throw new Error('Ordinamento non valido: usare SQL (es. name ASC) oppure JSON (es. {"name":1}).');
      }
      const parts = Object.entries(spec).map(([col, dir]) => `${qid(col)} ${Number(dir) < 0 ? 'DESC' : 'ASC'}`);
      return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
    }
    return ` ORDER BY ${t}`;
  }

  buildSelect(_db, coll, payload) {
    const where = String(payload.filter || '').trim();
    const whereSql = where ? ` WHERE ${where}` : '';
    const orderSql = this.buildOrderBy(payload.sort);
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), 500);
    const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
    const table = qtable(_db, coll);
    return { table, whereSql, orderSql, limit, skip };
  }

  async collectionFind(db, coll, payload) {
    const pool = this.requirePool();
    const { table, whereSql, orderSql, limit, skip } = this.buildSelect(db, coll, payload);

    const res = await pool.query(`SELECT * FROM ${table}${whereSql}${orderSql} LIMIT $1 OFFSET $2`, [limit, skip]);
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM ${table}${whereSql}`);
    const total = Number(countRes.rows[0]?.total) || 0;

    const columns = res.fields ? res.fields.map((f) => f.name) : [];
    const pk = await this.primaryKey(db, coll);
    const docs = res.rows.map((r) => {
      const doc = { ...r, _id: this.makeId(r, pk, columns) };
      return serializeRow(doc);
    });

    return { docs, columns, total, skip, limit };
  }

  async collectionAggregate(_db, _coll, payload) {
    const pool = this.requirePool();
    const sql = String(payload.pipeline || '').trim();
    if (!sql) throw new Error('Inserisci una query SQL da eseguire.');
    const readOnly = !!payload.readOnly;
    const client = await pool.connect();
    try {
      if (readOnly) {
        await client.query('BEGIN READ ONLY');
        await client.query('SET LOCAL statement_timeout = 30000');
      }
      try {
        const res = await client.query(sql);
        if (Array.isArray(res)) {
          const lastRes = res[res.length - 1];
          const rows = (lastRes.rows || []).slice(0, 500);
          const columns = lastRes.fields ? lastRes.fields.map((f) => f.name) : [];
          return { docs: rows.map(serializeRow), columns, total: rows.length, skip: 0, limit: 500 };
        }
        if (res.rows && (res.rows.length > 0 || res.fields)) {
          const rows = res.rows.slice(0, 500);
          const columns = res.fields ? res.fields.map((f) => f.name) : [];
          return { docs: rows.map(serializeRow), columns, total: res.rows.length, skip: 0, limit: 500 };
        }

        const summary = { comando: res.command, righeCoinvolte: res.rowCount || 0 };
        return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: 500 };
      } finally {
        if (readOnly) await client.query('ROLLBACK').catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  async collectionExplain(_db, coll, payload) {
    const pool = this.requirePool();
    let sql;
    if (payload.mode === 'aggregate') {
      sql = String(payload.pipeline || '').trim();
      if (!sql) throw new Error('Inserisci una query SQL di cui mostrare il piano.');
    } else {
      const { table, whereSql, orderSql, limit, skip } = this.buildSelect(_db, coll, payload);
      sql = `SELECT * FROM ${table}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${skip}`;
    }

    try {
      const res = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
      const plan = res.rows[0]['QUERY PLAN'] || res.rows[0][Object.keys(res.rows[0])[0]];
      return { format: 'json', plan: Array.isArray(plan) ? plan[0] : plan, query: sql };
    } catch (_err) {
      const res = await pool.query(`EXPLAIN ${sql}`);
      const columns = res.fields ? res.fields.map((f) => f.name) : ['QUERY PLAN'];
      return { format: 'table', rows: res.rows.map(serializeRow), columns, query: sql };
    }
  }

  async docInsert(db, coll, payload) {
    const pool = this.requirePool();
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    delete doc._id;
    const cols = Object.keys(doc);
    const table = qtable(db, coll);
    let res;
    if (!cols.length) {
      res = await pool.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING *`);
    } else {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES (${placeholders}) RETURNING *`;
      res = await pool.query(sql, cols.map((c) => toSqlValue(doc[c])));
    }
    const insertedRow = res.rows[0] || {};
    const pk = await this.primaryKey(db, coll);
    const insertedId = JSON.stringify(this.makeId(insertedRow, pk, Object.keys(insertedRow)));
    return { insertedId };
  }

  async docUpdate(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const set = deserializeClientObject(payload.set);
    const assignments = [];
    const params = [];
    let idx = 1;

    for (const [col, val] of Object.entries(set)) {
      if (col === '_id') continue;
      assignments.push(`${qid(col)} = $${idx++}`);
      params.push(toSqlValue(val));
    }
    for (const col of payload.unset || []) {
      if (col === '_id') continue;
      assignments.push(`${qid(col)} = NULL`);
    }
    if (!assignments.length) throw new Error('Nessuna modifica da applicare.');

    const whereSql = where.sql.replace(/\$(\d+)/g, () => `$${idx++}`);
    params.push(...where.params);

    const res = await pool.query(
      `UPDATE ${qtable(db, coll)} SET ${assignments.join(', ')} WHERE ${whereSql}`,
      params
    );
    return { matched: res.rowCount, modified: res.rowCount };
  }

  async docReplace(db, coll, payload) {
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    delete doc._id;
    return this.docUpdate(db, coll, { id: payload.id, set: EJSON.serialize(doc, { relaxed: true }) });
  }

  async docDelete(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const res = await pool.query(
      `DELETE FROM ${qtable(db, coll)} WHERE ${where.sql}`,
      where.params
    );
    return { deleted: res.rowCount };
  }

  async collectionDeleteMany(db, coll, payload) {
    const pool = this.requirePool();
    const filter = String(payload.filter || '').trim();
    const res = await pool.query(
      `DELETE FROM ${qtable(db, coll)}${filter ? ` WHERE ${filter}` : ''}`
    );
    return { deleted: res.rowCount };
  }

  static csvCell(v) {
    if (v === null || v === undefined) return '';
    let s;
    if (v instanceof Date) s = isNaN(v.getTime()) ? '' : v.toISOString();
    else if (Buffer.isBuffer(v)) s = v.toString('base64');
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async tableDdl(_db, coll) {
    const fields = await this.tableFields(_db, coll);
    const pk = await this.primaryKey(_db, coll);
    const colDefs = fields.map((f) => {
      let def = `${qid(f.name)} ${f.types[0]}`;
      if (!f.nullable) def += ' NOT NULL';
      if (f.default != null) def += ` DEFAULT ${defaultSql(f.default)}`;
      return def;
    });
    if (pk.length) colDefs.push(`PRIMARY KEY (${pk.map(qid).join(', ')})`);
    return `CREATE TABLE ${qid(coll)} (\n  ${colDefs.join(',\n  ')}\n);`;
  }

  async dbSchema(_db) {
    const pool = this.requirePool();
    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' ORDER BY table_name`
    );

    const columnsRes = await pool.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_name, ordinal_position`
    );

    const colsByTable = new Map();
    for (const row of columnsRes.rows) {
      if (!colsByTable.has(row.table_name)) colsByTable.set(row.table_name, []);
      const typeName = row.data_type === 'USER-DEFINED' ? row.udt_name : (row.data_type || row.udt_name || 'varchar');
      colsByTable.get(row.table_name).push({
        name: row.column_name,
        types: [typeName],
        presence: row.is_nullable === 'YES' ? 0 : 100,
        nullable: row.is_nullable === 'YES',
      });
    }

    const collections = tablesRes.rows.map((t) => ({
      name: t.table_name,
      fields: colsByTable.get(t.table_name) || [],
    }));

    const fkRes = await pool.query(
      `SELECT kcu.table_name, kcu.column_name, ccu.table_name AS referenced_table_name, ccu.column_name AS referenced_column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`
    );

    const relations = [];
    const fkSet = new Set();
    for (const fk of fkRes.rows) {
      relations.push({
        from: fk.table_name,
        field: fk.column_name,
        to: fk.referenced_table_name,
        many: true,
      });
      fkSet.add(`${fk.table_name}.${fk.column_name}->${fk.referenced_table_name}`);
    }

    const detected = DbStrategy.detectRelations(collections);
    for (const r of detected) {
      const key = `${r.from}.${r.field}->${r.to}`;
      if (!fkSet.has(key)) relations.push(r);
    }

    return { collections, relations };
  }

  async collectionExport(db, coll, payload) {
    const pool = this.requirePool();
    const format = ['sql', 'json'].includes(payload.format) ? payload.format : 'csv';
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 1000);
    const table = qtable(db, coll);
    const pk = await this.primaryKey(db, coll);

    let rows;
    let fields;
    let nextAfter = null;

    if (pk.length) {
      const pkCols = pk.map(qid).join(', ');
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
        params = afterVals.map(toSqlValue);
      }
      params.push(limit);
      const limitIdx = params.length;
      const res = await pool.query(
        `SELECT * FROM ${table}${whereSql} ORDER BY ${pkCols} LIMIT $${limitIdx}`,
        params
      );
      rows = res.rows;
      fields = res.fields;
      if (rows.length) {
        const last = rows[rows.length - 1];
        nextAfter = EJSON.stringify(pk.map((c) => last[c]), { relaxed: true });
      }
    } else {
      const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
      const res = await pool.query(`SELECT * FROM ${table} LIMIT $1 OFFSET $2`, [limit, skip]);
      rows = res.rows;
      fields = res.fields;
    }

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    const total = Number(countRes.rows[0]?.total) || 0;
    const columns = fields ? fields.map((f) => f.name) : [];

    let lines;
    if (format === 'sql') {
      lines = rows.map((r) => {
        const vals = columns.map((c) => {
          const v = r[c];
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number' || typeof v === 'boolean') return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        });
        return `INSERT INTO ${table} (${columns.map(qid).join(', ')}) VALUES (${vals.join(', ')});`;
      });
    } else if (format === 'json') {
      lines = rows.map((r) => EJSON.stringify(r, { relaxed: true }));
    } else {
      lines = rows.map((r) => columns.map((c) => PostgreSqlStrategy.csvCell(r[c])).join(','));
    }

    return {
      lines,
      count: rows.length,
      total,
      format,
      header: format === 'csv' ? columns.map(PostgreSqlStrategy.csvCell).join(',') : null,
      nextAfter,
    };
  }

  async collectionImport(db, coll, payload) {
    const pool = this.requirePool();
    const raw = Array.isArray(payload.docs) ? payload.docs : [];
    if (!raw.length) throw new Error('Nessuna riga da importare nel blocco.');
    const table = qtable(db, coll);
    let inserted = 0;
    const errors = [];

    const parsed = [];
    for (let i = 0; i < raw.length; i++) {
      try {
        const row = EJSON.deserialize(raw[i], { relaxed: true });
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error('la riga deve essere un oggetto { "colonna": valore }');
        }
        delete row._id;
        const cols = Object.keys(row);
        if (!cols.length) throw new Error('riga vuota');
        parsed.push({ i, cols, values: cols.map((c) => toSqlValue(row[c])) });
      } catch (err) {
        if (errors.length < 10) errors.push(`Riga ${i + 1}: ${(err && err.message) || err}`);
      }
    }

    for (const p of parsed) {
      try {
        const placeholders = p.cols.map((_, idx) => `$${idx + 1}`).join(', ');
        const sql = `INSERT INTO ${table} (${p.cols.map(qid).join(', ')}) VALUES (${placeholders})`;
        await pool.query(sql, p.values);
        inserted += 1;
      } catch (err) {
        if (errors.length < 10) errors.push(`Riga ${p.i + 1}: ${(err && err.message) || err}`);
      }
    }

    return { inserted, failed: raw.length - inserted, errors };
  }

  async createCollection(db, name, payload = {}) {
    const pool = this.requirePool();
    const table = String(name || '').trim();
    if (!table) throw new Error('Nome della tabella mancante.');
    const cols = Array.isArray(payload.columns) ? payload.columns : [];
    let defs;
    if (!cols.length) {
      defs = [`${qid('id')} SERIAL PRIMARY KEY`];
    } else {
      defs = cols.map(columnSql);
      const pk = cols.filter((c) => c.primaryKey).map((c) => qid(String(c.name).trim()));
      if (pk.length) defs.push(`PRIMARY KEY (${pk.join(', ')})`);
    }
    await pool.query(`CREATE TABLE ${qtable(db, table)} (${defs.join(', ')})`);
  }

  async renameCollection(_db, coll, newName) {
    const pool = this.requirePool();
    const to = String(newName || '').trim();
    if (!to) throw new Error('Nuovo nome della tabella mancante.');
    await pool.query(`ALTER TABLE ${qtable(_db, coll)} RENAME TO ${qid(to)}`);
  }

  async dropCollection(_db, coll) {
    const pool = this.requirePool();
    await pool.query(`DROP TABLE ${qtable(_db, coll)}`);
  }

  async addColumn(db, coll, column) {
    const pool = this.requirePool();
    await pool.query(`ALTER TABLE ${qtable(db, coll)} ADD COLUMN ${columnSql(column || {})}`);
  }

  async alterColumn(db, coll, payload) {
    const pool = this.requirePool();
    const oldName = String((payload && payload.oldName) || '').trim();
    if (!oldName) throw new Error('Nome della colonna da modificare mancante.');
    const col = payload.column || {};
    const newName = String(col.name || '').trim();
    const type = String(col.type || '').trim();

    if (newName && newName !== oldName) {
      await pool.query(`ALTER TABLE ${qtable(db, coll)} RENAME COLUMN ${qid(oldName)} TO ${qid(newName)}`);
    }

    const targetName = newName || oldName;
    if (type) {
      try {
        await pool.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} TYPE ${type}`);
      } catch (err) {
        if (/cannot be cast automatically/i.test(err.message || '')) {
          await pool.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} TYPE ${type} USING ${qid(targetName)}::${type}`);
        } else {
          throw err;
        }
      }
    }
    if (col.nullable === false) {
      await pool.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} SET NOT NULL`);
    } else if (col.nullable === true) {
      await pool.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} DROP NOT NULL`);
    }
  }

  async dropColumn(db, coll, name) {
    const pool = this.requirePool();
    const column = String(name || '').trim();
    if (!column) throw new Error('Nome della colonna da eliminare mancante.');
    await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP COLUMN ${qid(column)}`);
  }

  async createIndex(db, coll, payload) {
    const pool = this.requirePool();
    let spec;
    try {
      spec = JSON.parse(String(payload.fields || ''));
    } catch {
      throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.keys(spec).length) {
      throw new Error('Specifica dei campi non valida: usa ad es. {"email": 1}.');
    }
    const cols = Object.entries(spec).map(([c, dir]) => `${qid(c)} ${Number(dir) < 0 ? 'DESC' : 'ASC'}`);
    const name = String(payload.name || '').trim() || `${Object.keys(spec).join('_')}_idx`;
    await pool.query(
      `CREATE ${payload.unique ? 'UNIQUE ' : ''}INDEX ${qid(name)} ON ${qtable(db, coll)} (${cols.join(', ')})`
    );
    return { name };
  }

  async dropIndex(_db, _coll, name) {
    const pool = this.requirePool();
    const idx = String(name || '').trim();
    if (!idx) throw new Error('Nome dell\'indice da eliminare mancante.');
    await pool.query(`DROP INDEX ${qid(idx)}`);
  }

  async tableFields(_db, table) {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT column_name AS name, data_type AS ctype, udt_name AS udt, is_nullable AS nullable, column_default AS cdefault
         FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_name = $1
     ORDER BY ordinal_position`,
      [table]
    );

    const pk = await this.primaryKey(_db, table);
    const pkSet = new Set(pk);

    return res.rows.map((c) => ({
      name: c.name,
      types: [String(c.ctype === 'USER-DEFINED' ? c.udt : (c.ctype || c.udt || 'varchar'))],
      presence: c.nullable === 'YES' ? 0 : 100,
      nullable: c.nullable === 'YES',
      default: c.cdefault == null ? null : String(c.cdefault),
      autoIncrement: /nextval/i.test(String(c.cdefault || '')),
      key: pkSet.has(c.name) ? 'PRI' : '',
    }));
  }

  async collectionStats(_db, coll) {
    const pool = this.requirePool();
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM ${qtable(_db, coll)}`);
    const count = Number(countRes.rows[0]?.total) || 0;

    const sizeRes = await pool.query(
      `SELECT pg_relation_size($1::regclass) AS data_size, pg_total_relation_size($1::regclass) AS total_size`,
      [coll]
    );
    const dataSize = Number(sizeRes.rows[0]?.data_size) || 0;
    const totalSize = Number(sizeRes.rows[0]?.total_size) || 0;

    const idxRes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tablename = $1`,
      [coll]
    );
    const indexes = idxRes.rows.map((i) => ({ name: i.indexname, key: { [i.indexname]: 1 } }));

    const fields = await this.tableFields(_db, coll);

    return {
      stats: {
        count,
        size: dataSize,
        storageSize: totalSize,
        avgObjSize: count > 0 ? Math.round(dataSize / count) : 0,
        totalIndexSize: totalSize - dataSize,
        nindexes: indexes.length,
      },
      indexes,
      fields,
      sampled: count,
    };
  }
}

module.exports = PostgreSqlStrategy;
