'use strict';

const mysql = require('mysql2');
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');
const { isSqlGeometryType, isGeoJson, assertGeoJson, parseGeoJsonText, potaCache } = require('./geometry');
const sessioni = require('./sessioni');

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

// Durata della cache dei metadati di colonna (vedi tableColumnsInfo). Breve di
// proposito: una ALTER TABLE fatta da fuori si riflette al massimo dopo questo
// intervallo, quelle fatte da qui svuotano la cache subito.
const GEO_CACHE_MS = 15000;

/* ---------------------------------------------------------------------------
 * Helpers MySQL
 * ------------------------------------------------------------------------- */

function assertDbName(name) {
  if (!name || /[\r\n]/.test(name) || name.length > 64) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

// Identificatore quotato (` `), con eventuale punto trattato come carattere.
function qid(name) {
  return mysql.escapeId(String(name), true);
}

function qtable(db, table) {
  return `${qid(db)}.${qid(table)}`;
}

// Converte un valore proveniente dal client (già "deserializzato" da EJSON)
// in un parametro SQL sicuro per mysql2: i tipi primitivi, Date e Buffer
// passano invariati, oggetti e array diventano testo JSON (utile per le
// colonne JSON), il tipo BSON Binary torna a essere un Buffer.
function toSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') {
    if (v._bsontype === 'Binary') return v.buffer;
    return JSON.stringify(v);
  }
  return v;
}

// Il client invia i valori in Extended JSON: relaxed = true produce tipi
// JavaScript nativi (numeri normali, Date per $date), quelli che servono
// come parametri SQL.
function parseClientValue(text) {
  return EJSON.parse(String(text), { relaxed: true });
}

function deserializeClientObject(obj) {
  return EJSON.deserialize(obj || {}, { relaxed: true });
}

// Le righe viaggiano verso il client come Extended JSON relaxed, come per
// MongoDB: le Date diventano { $date: ... } e il frontend le riconosce.
function serializeRow(row) {
  return EJSON.serialize(row, { relaxed: true });
}

// Clausola WHERE per la chiave (virtuale) _id: { col: valore, ... }.
// <=> è l'uguaglianza NULL-safe, necessaria per le chiavi composite di
// fallback che possono contenere NULL.
function whereFromId(id) {
  const cols = Object.keys(id);
  if (!cols.length) throw new Error('Identificatore di riga mancante.');
  const sql = cols.map((c) => `${qid(c)} <=> ?`).join(' AND ');
  const params = cols.map((c) => toSqlValue(id[c]));
  return { sql, params };
}

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
  let s = `${qid(name)} ${type}`;
  if (c.nullable === false) s += ' NOT NULL';
  if (c.default != null && String(c.default).trim() !== '') s += ` DEFAULT ${defaultSql(c.default)}`;
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  return s;
}

/* ---------------------------------------------------------------------------
 * Strategia MySQL: un pool dedicato per istanza (cioè per socket)
 * ------------------------------------------------------------------------- */

class MySqlStrategy extends DbStrategy {
  constructor() {
    super();
    this.pool = null; // pool promise-based di mysql2
    // Colonne geometriche per tabella (vedi geoColumns): la lettura le deve
    // conoscere a OGNI find, e information_schema non è gratis. Cache breve,
    // svuotata dalle DDL sulle colonne che passano da qui.
    this._geoCache = new Map();
  }

  get type() { return 'mysql'; }

  requirePool() {
    if (!this.pool) throw new Error('Nessuna connessione attiva al database.');
    return this.pool;
  }

  async connect(cfg) {
    const pool = mysql.createPool({
      host: (cfg.host || 'localhost').trim(),
      port: parseInt(cfg.port, 10) || 3306,
      user: cfg.username || 'root',
      password: cfg.password || '',
      database: (cfg.database || '').trim() || undefined,
      connectTimeout: 6000,
      waitForConnections: true,
      connectionLimit: 8,
      multipleStatements: false,
    }).promise();
    try {
      await pool.query('SELECT 1'); // credenziali sbagliate falliscono qui
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    this.pool = pool;
  }

  async disconnect() {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.end().catch(() => {});
    }
  }

  async health() {
    const pool = this.requirePool();
    const t0 = Date.now();
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - t0;
    // mysql2 non ha un'API pubblica per lo stato del pool: si leggono, in modo
    // difensivo, i contatori interni del pool "core" (dietro il wrapper promise).
    const raw = pool.pool || pool;
    const len = (d) => {
      if (!d) return null;
      if (typeof d.length === 'number') return d.length;
      if (typeof d.size === 'number') return d.size;
      if (typeof d.toArray === 'function') return d.toArray().length;
      return null;
    };
    const limit = (raw.config && raw.config.connectionLimit != null) ? raw.config.connectionLimit : null;
    const total = len(raw._allConnections);
    const idle = len(raw._freeConnections);
    return {
      latencyMs,
      pool: {
        limit,
        total,
        idle,
        active: (total != null && idle != null) ? total - idle : null,
        waiting: len(raw._connectionQueue),
      },
    };
  }

  async listDatabases() {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT s.SCHEMA_NAME AS name,
              COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size
         FROM information_schema.SCHEMATA s
    LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
     GROUP BY s.SCHEMA_NAME
     ORDER BY s.SCHEMA_NAME`
    );
    return rows.map((r) => ({ name: r.name, sizeOnDisk: Number(r.size) || 0 }));
  }

  async createDatabase(db, firstColl) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    // Nomi CREATI da CodeDB: niente caratteri di markup/quoting, che finirebbero
    // nell'interfaccia di tutti gli utenti (i nomi preesistenti restano intatti).
    DbStrategy.assertCreatableName(name, 'del database');
    try {
      await pool.query(`CREATE DATABASE ${qid(name)}`);
    } catch (err) {
      // Niente check preventivo via listDatabases() (costoso e soggetto a
      // TOCTOU): si lascia decidere al motore e si traduce il suo errore.
      if (err && err.code === 'ER_DB_CREATE_EXISTS') throw new Error(`Il database "${name}" esiste già.`);
      throw err;
    }
    // A differenza di MongoDB la prima tabella è facoltativa.
    const table = String(firstColl || '').trim();
    if (table) {
      await pool.query(
        `CREATE TABLE ${qtable(name, table)} (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY)`
      );
    }
  }

  async renameDatabase(db, newName) {
    const pool = this.requirePool();
    const from = String(db || '').trim();
    const to = String(newName || '').trim();
    assertDbName(from);
    assertDbName(to);
    DbStrategy.assertCreatableName(to, 'del database');
    if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
    if (SYSTEM_SCHEMAS.has(from.toLowerCase())) {
      throw new Error(`Il database di sistema "${from}" non può essere rinominato.`);
    }

    // MySQL non supporta RENAME DATABASE: si crea il nuovo schema e si
    // spostano le tabelle con RENAME TABLE (le view non sono spostabili).
    const [tables] = await pool.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [from]
    );
    if (!tables.length) throw new Error('Il database non contiene tabelle da spostare.');
    try {
      await pool.query(`CREATE DATABASE ${qid(to)}`);
    } catch (err) {
      // Niente check preventivo via listDatabases() (costoso e soggetto a
      // TOCTOU): si lascia decidere al motore e si traduce il suo errore.
      if (err && err.code === 'ER_DB_CREATE_EXISTS') throw new Error(`Il database "${to}" esiste già.`);
      throw err;
    }
    if (tables.length > 0) {
      const renameParts = tables.map((t) => `${qtable(from, t.name)} TO ${qtable(to, t.name)}`);
      await pool.query(`RENAME TABLE ${renameParts.join(', ')}`);
    }
    await pool.query(`DROP DATABASE ${qid(from)}`);
  }

  async dropDatabase(db) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    if (SYSTEM_SCHEMAS.has(name.toLowerCase())) {
      throw new Error(`Il database di sistema "${name}" non può essere eliminato.`);
    }
    await pool.query(`DROP DATABASE ${qid(name)}`);
  }

  async listCollections(db) {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS ttype, TABLE_ROWS AS cnt
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
      [db]
    );
    // TABLE_TYPE: 'BASE TABLE', 'VIEW' oppure 'SYSTEM VIEW' (information_schema).
    return rows.map((r) => {
      const isView = String(r.ttype || '').toUpperCase().includes('VIEW');
      return {
        name: r.name,
        type: isView ? 'view' : 'collection',
        count: isView ? null : Number(r.cnt) || 0, // stima InnoDB
      };
    });
  }

  async search(query) {
    this.requirePool();
    const term = `%${(query || '').toLowerCase()}%`;
    const sql = `
      SELECT table_schema as db, table_name as coll
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        AND (LOWER(table_schema) LIKE ? OR LOWER(table_name) LIKE ?)
    `;
    const [rows] = await this.pool.query(sql, [term, term]);
    const dbs = new Map();
    for (const r of rows) {
      if (!dbs.has(r.db)) dbs.set(r.db, []);
      dbs.get(r.db).push({ name: r.coll });
    }
    return Array.from(dbs.entries()).map(([name, collections]) => ({ name, collections }));
  }

  // Colonne della chiave primaria, nell'ordine della definizione.
  async primaryKey(db, table) {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME AS name
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
      [db, table]
    );
    return rows.map((r) => r.name);
  }

  /* -------------------------------------------------------------------------
   * Geometrie (vedi db/geometry.js per il perché del formato unico GeoJSON)
   * ---------------------------------------------------------------------- */

  // Elenco colonne della tabella con le sole informazioni che servono qui:
  // nome, tipo e — per le geometriche — SRID. `SRS_ID` esiste da MySQL 8; su
  // 5.7 la query fallisce e si ripiega senza (là il SRID non è vincolato).
  async tableColumnsInfo(db, coll) {
    const chiave = `${db}\u0000${coll}`;
    const ora = Date.now();
    const hit = this._geoCache.get(chiave);
    if (hit && hit.scade > ora) return hit.info;

    const pool = this.requirePool();
    let rows;
    try {
      [rows] = await pool.query(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, SRS_ID AS srid, EXTRA AS extra
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
        [db, coll]
      );
    } catch {
      [rows] = await pool.query(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, NULL AS srid, EXTRA AS extra
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
        [db, coll]
      );
    }
    const info = {
      // Le colonne INVISIBLE (MySQL 8) non fanno parte di `SELECT *`: vanno
      // escluse anche dalla lista esplicita, altrimenti la sola presenza di una
      // colonna geometrica farebbe comparire nella griglia colonne che prima
      // non c'erano.
      columns: rows
        .filter((r) => !/\bINVISIBLE\b/i.test(String(r.extra || '')))
        .map((r) => ({ name: r.name, type: r.type, srid: r.srid == null ? null : Number(r.srid) })),
      geo: new Map(),
    };
    for (const c of info.columns) {
      if (isSqlGeometryType(c.type)) info.geo.set(c.name, c);
    }
    this._geoCache.set(chiave, { info, scade: ora + GEO_CACHE_MS });
    potaCache(this._geoCache);
    return info;
  }

  // Lista di selezione: `*` quando non ci sono geometrie (nessun costo per il
  // 99% delle tabelle), altrimenti le colonne per nome con ST_AsGeoJSON su
  // quelle geometriche — l'alias conserva il nome originale, quindi il resto
  // della pipeline (colonne, _id, griglia) non si accorge di nulla.
  async selectListFor(db, coll) {
    const info = await this.tableColumnsInfo(db, coll);
    if (!info.geo.size) return { list: '*', geo: info.geo };
    const list = info.columns
      .map((c) => (info.geo.has(c.name) ? `ST_AsGeoJSON(${qid(c.name)}) AS ${qid(c.name)}` : qid(c.name)))
      .join(', ');
    return { list, geo: info.geo };
  }

  // Le geometrie tornano come testo GeoJSON: qui diventano oggetti, la forma
  // che il client sa disegnare sulla mappa.
  static geoRowsToJson(rows, geo) {
    if (!geo || !geo.size) return rows;
    for (const row of rows) {
      for (const col of geo.keys()) {
        if (col in row) row[col] = parseGeoJsonText(row[col]);
      }
    }
    return rows;
  }

  // Frammento SQL + parametro per scrivere una geometria. Il SRID della colonna
  // va imposto: ST_GeomFromGeoJSON produce SRID 4326 e MySQL rifiuta la
  // scrittura se non coincide con quello dichiarato dalla colonna (compreso 0,
  // il default di una colonna GEOMETRY senza SRID).
  static geoPlaceholder(colInfo) {
    return colInfo && colInfo.srid != null
      ? `ST_SRID(ST_GeomFromGeoJSON(?), ${Number(colInfo.srid)})`
      : 'ST_GeomFromGeoJSON(?)';
  }

  // Valore di scrittura per una colonna: le geometriche prendono il frammento
  // ST_GeomFromGeoJSON, tutte le altre un normale segnaposto.
  static geoBinding(col, value, geo) {
    const colInfo = geo && geo.get(col);
    if (colInfo && isGeoJson(value)) {
      assertGeoJson(value, `Colonna "${col}"`);
      return { sql: MySqlStrategy.geoPlaceholder(colInfo), param: JSON.stringify(value) };
    }
    return { sql: '?', param: toSqlValue(value) };
  }

  // _id virtuale per il client: la chiave primaria come oggetto
  // { colonna: valore }. Senza chiave primaria si usa l'intera riga come
  // chiave composita di fallback.
  makeId(row, pkCols, allCols) {
    const cols = pkCols.length ? pkCols : allCols;
    const id = {};
    for (const c of cols) id[c] = row[c];
    return id;
  }

  // Risale dalla chiave inviata dal client (JSON.stringify di _id) e la
  // trasforma in clausola WHERE.
  parseRowId(rawId) {
    const id = parseClientValue(rawId);
    if (!id || typeof id !== 'object' || Array.isArray(id)) {
      throw new Error('Identificatore di riga non valido.');
    }
    return whereFromId(id);
  }

  // ORDER BY: accetta sia SQL libero ("name ASC") sia il JSON {"name": 1}
  // prodotto dal click sulle intestazioni di colonna.
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

  // Pezzi comuni di una SELECT su filter/sort/limit/skip liberi (usati sia
  // dalla query dati vera e propria sia dal suo EXPLAIN).
  buildSelect(db, coll, payload) {
    const where = String(payload.filter || '').trim();
    const whereSql = where ? ` WHERE ${where}` : '';
    const orderSql = this.buildOrderBy(payload.sort);
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 50, 1), DbStrategy.resultCap(payload));
    const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
    const table = qtable(db, coll);
    return { table, whereSql, orderSql, limit, skip };
  }

  async collectionFind(db, coll, payload) {
    const pool = this.requirePool();
    const { table, whereSql, orderSql, limit, skip } = this.buildSelect(db, coll, payload);
    // Chiave primaria e metadati di colonna sono due letture di
    // information_schema indipendenti: in serie aggiungevano due round trip a
    // ogni pagina della griglia, in parallelo uno solo.
    const [pk, sel] = await Promise.all([this.primaryKey(db, coll), this.selectListFor(db, coll)]);

    // Keyset (seek) pagination: se richiesta e possibile (chiave a colonna
    // singola, ordinamento di default), pagina con `pk > :after` invece di
    // OFFSET, costo O(pagina) a qualsiasi profondità. Altrimenti fallback OFFSET.
    // Le colonne geometriche vanno lette come GeoJSON (ST_AsGeoJSON): senza,
    // mysql2 restituisce oggetti {x, y} annidati da cui non si risale al tipo.
    const { list: selectList, geo } = sel;
    const ks = this.buildKeyset(payload, table, whereSql, limit, pk, selectList);
    const sql = ks ? ks.sql : `SELECT ${selectList} FROM ${table}${whereSql}${orderSql} LIMIT ? OFFSET ?`;
    const params = ks ? ks.params : [limit, skip];

    // Timeout per-query (mysql2 interrompe la query allo scadere): una find lenta
    // degrada con errore invece di tenere occupata la connessione del pool. La
    // query object include `timeout` solo se > 0.
    const ms = DbStrategy.queryTimeoutMs();
    const q = ms > 0 ? { sql, timeout: ms } : { sql };
    // Se la richiesta ha un opHandle (griglia con runId), la eseguiamo su una
    // connessione dedicata di cui catturiamo il CONNECTION_ID, così è
    // annullabile via `KILL QUERY` (cancelQuery) — nessuna modifica ai dati.
    let rows, fields;
    const opHandle = payload && payload.opHandle;
    if (opHandle) {
      const conn = await pool.getConnection();
      try {
        try {
          const [[row]] = await conn.query('SELECT CONNECTION_ID() AS cid');
          if (row && row.cid) opHandle.connectionId = row.cid;
        } catch (_) {}
        [rows, fields] = await conn.query(q, params);
      } finally {
        conn.release();
      }
    } else {
      [rows, fields] = await pool.query(q, params);
    }
    // Keyset "indietro": la query gira in ordine pk DESC, qui si riordina ASC.
    if (ks && ks.reverse) rows = rows.slice().reverse();

    // COUNT(*) su InnoDB è una scansione: su tabelle enormi bloccherebbe la
    // griglia. Il client della UI passa `deferCount` e chiede il totale a parte
    // via `collection:count`; senza il flag (MCP, test) lo calcoliamo inline ma
    // con un timeout così non può bloccarsi all'infinito.
    let total = null;
    if (!payload.deferCount) {
      const c = await this.countWithTimeout(table, whereSql);
      total = c.total;
    }

    MySqlStrategy.geoRowsToJson(rows, geo);

    const columns = (fields || []).map((f) => f.name);
    // Budget di byte: il tetto sulle righe non protegge da poche righe enormi
    // (BLOB, testi lunghi, campi JSON). Il driver ha già materializzato il
    // result set, ma qui si evita almeno di serializzarlo e spedirlo per intero.
    const capped = DbStrategy.truncateBySize(rows);
    const docs = capped.rows.map((r) => {
      const doc = { ...r, _id: this.makeId(r, pk, columns) };
      return serializeRow(doc);
    });
    return { docs, columns, total, skip, limit, keyset: !!ks, truncated: capped.truncated || undefined };
  }

  // Costruisce la query keyset (seek) per la paginazione oppure ritorna null se
  // non applicabile (nessun keyset richiesto, sort personalizzato, o chiave non
  // a colonna singola) → il chiamante usa OFFSET. Il filtro utente (WHERE) viene
  // combinato in AND con il vincolo sul cursore.
  buildKeyset(payload, table, whereSql, limit, pk, selectList = '*') {
    const ks = payload && payload.keyset;
    if (!ks) return null;
    if (String(payload.sort || '').trim()) return null; // sort personalizzato → OFFSET
    if (!pk || pk.length !== 1) return null;             // chiave composita/assente → OFFSET
    const col = pk[0];
    const conds = [];
    const params = [];
    if (whereSql) conds.push(`(${whereSql.replace(/^\s*WHERE\s+/i, '')})`); // filtro utente
    let dir = 'ASC', reverse = false;
    if (ks.after != null) {
      conds.push(`${qid(col)} > ?`); params.push(this.keysetValue(ks.after, col));
    } else if (ks.from != null) {
      // Refresh in place: pagina corrente a partire (incluso) dal primo id noto.
      conds.push(`${qid(col)} >= ?`); params.push(this.keysetValue(ks.from, col));
    } else if (ks.before != null) {
      conds.push(`${qid(col)} < ?`); params.push(this.keysetValue(ks.before, col));
      dir = 'DESC'; reverse = true;
    }
    // ks.first (o nessun estremo): prima pagina, solo ORDER BY pk ASC.
    const whereClause = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    const sql = `SELECT ${selectList} FROM ${table}${whereClause} ORDER BY ${qid(col)} ${dir} LIMIT ?`;
    params.push(limit);
    return { sql, params, reverse };
  }

  // Estrae il valore della chiave dal cursore inviato dal client: è l'_id della
  // riga (JSON.stringify di `{ colonna: valore }`) oppure il valore scalare.
  keysetValue(rawId, col) {
    const parsed = parseClientValue(rawId);
    const v = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed[col] : parsed;
    return toSqlValue(v);
  }

  // COUNT(*) con timeout per-query (mysql2 uccide la query allo scadere). Ritorna
  // { total, timedOut }: total è null se il conteggio ha superato il timeout.
  async countWithTimeout(table, whereSql) {
    const pool = this.requirePool();
    const ms = DbStrategy.countTimeoutMs();
    const q = { sql: `SELECT COUNT(*) AS total FROM ${table}${whereSql}` };
    if (ms > 0) q.timeout = ms;
    try {
      const [[{ total }]] = await pool.query(q);
      return { total: Number(total), timedOut: false };
    } catch (err) {
      if (err && (err.code === 'PROTOCOL_SEQUENCE_TIMEOUT' || /timeout/i.test(err.message || ''))) {
        return { total: null, timedOut: true };
      }
      throw err;
    }
  }

  // Conteggio disaccoppiato richiesto dalla griglia (evento collection:count).
  // Senza filtro usa la stima istantanea del catalogo (information_schema)
  // invece di un COUNT(*) che scansiona l'intera tabella: è ciò che fanno
  // DBeaver/phpMyAdmin. Con filtro resta il COUNT(*) esatto con timeout.
  async collectionCount(db, coll, payload) {
    const { table, whereSql } = this.buildSelect(db, coll, payload);
    if (!whereSql) {
      // Stima usata solo se > 0: per tabelle vuote/piccole TABLE_ROWS è
      // inaffidabile (InnoDB) e il COUNT(*) esatto è comunque istantaneo.
      const est = await this.estimatedRowCount(db, coll);
      if (est != null && est > 0) return { total: est, timedOut: false, approx: true };
    }
    return this.countWithTimeout(table, whereSql);
  }

  // Stima (approssimata) del numero di righe dai metadati del catalogo, senza
  // scansione. TABLE_ROWS è affidabile solo per tabelle base InnoDB/MyISAM ed è
  // NULL per le viste: in tal caso torniamo null e il chiamante ripiega sul
  // COUNT(*) esatto. Sola lettura.
  async estimatedRowCount(db, coll) {
    const pool = this.requirePool();
    try {
      const [rows] = await pool.query(
        'SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = ?',
        [db, coll, 'BASE TABLE']
      );
      const n = rows && rows[0] ? rows[0].n : null;
      return n != null ? Number(n) : null;
    } catch (_) {
      return null;
    }
  }

  // Modalità "SQL Raw": esegue una query libera nel contesto del database.
  // payload.readOnly (usato dal gateway MCP): esegue dentro una transazione
  // READ ONLY — il motore rifiuta qualsiasi scrittura, comprese quelle
  // annidate in CTE o EXPLAIN ANALYZE — e con un timeout di 30 secondi.
  // payload.expectRead: la query è stata CLASSIFICATA come lettura e chi la
  // esegue è un sottoutente (vedi guardStrategy). È la stessa barriera che
  // PostgreSqlStrategy applicava già, e che qui mancava: se il parser sbaglia,
  // a rifiutare la scrittura è il MOTORE. Non copre l'I/O su file (scrivere un
  // file non è una scrittura transazionale): quello è negato a monte dal Proxy.
  async collectionAggregate(db, _coll, payload) {
    const pool = this.requirePool();
    const sql = String(payload.pipeline || '').trim();
    if (!sql) throw new Error('Inserisci una query SQL da eseguire.');
    const readOnly = !!payload.readOnly || !!payload.expectRead;
    const conn = await pool.getConnection();
    try {
      if (payload && payload.opHandle) {
        try {
          const [[row]] = await conn.query('SELECT CONNECTION_ID() AS cid');
          if (row && row.cid) payload.opHandle.connectionId = row.cid;
        } catch (_) {}
      }
      if (db) await conn.query(`USE ${qid(db)}`).catch(() => {});
      if (readOnly) await conn.query('START TRANSACTION READ ONLY');
      try {
        const cap = DbStrategy.resultCap(payload);
        const [result, fields] = await conn.query(readOnly ? { sql, timeout: 30000 } : sql);

        if (Array.isArray(result)) {
          // Se la prima voce è un array o un oggetto con affectedRows, abbiamo multipleStatements
          const isMulti = result.length > 0 && (Array.isArray(result[0]) || (typeof result[0] === 'object' && result[0] !== null && 'affectedRows' in result[0]));

          if (isMulti) {
            // Cerchiamo l'ultimo result set che ha righe di dati (SELECT)
            let selectRes = null;
            let selectFields = null;
            let totalAffected = 0;
            let statementCount = result.length;

            for (let i = 0; i < result.length; i++) {
              const resItem = result[i];
              if (Array.isArray(resItem)) {
                selectRes = resItem;
                selectFields = Array.isArray(fields) && fields[i] ? fields[i] : null;
              } else if (resItem && typeof resItem.affectedRows === 'number') {
                totalAffected += resItem.affectedRows;
              }
            }

            if (selectRes) {
              const rows = selectRes.slice(0, cap);
              const columns = (selectFields || []).map((f) => f.name || f);
              return { docs: rows.map(serializeRow), columns, total: selectRes.length, skip: 0, limit: cap };
            }

            // Soltanto statement di scrittura/DDL (INSERT, UPDATE, CREATE, ecc.)
            const summary = { istruzioniEseguite: statementCount, righeCoinvolteTotali: totalAffected };
            return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap };
          }

          // Singola SELECT
          const rows = result.slice(0, cap);
          const columns = (fields || []).map((f) => f.name);
          return { docs: rows.map(serializeRow), columns, total: result.length, skip: 0, limit: cap };
        }

        // Statement senza result set (UPDATE, DELETE, DDL...): riepilogo.
        const summary = { righeCoinvolte: result ? (result.affectedRows || 0) : 0 };
        if (result && result.insertId) summary.insertId = result.insertId;
        if (result && result.info) summary.info = result.info;
        return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap };
      } finally {
        if (readOnly) await conn.query('ROLLBACK').catch(() => {});
      }
    } finally {
      conn.release();
    }
  }

  /* --- Monitor delle sessioni ---------------------------------------------
   * `information_schema.PROCESSLIST`: senza il privilegio PROCESS il server non
   * dà errore, restituisce le sole sessioni dell'utente collegato — una lista
   * corta e perfettamente credibile. Si controllano quindi i grant e lo si
   * dichiara, perché "nessuno sta bloccando il database" e "non ti è dato
   * vedere chi lo sta bloccando" portano a decisioni opposte.
   * ---------------------------------------------------------------------- */
  async listSessions() {
    const pool = this.requirePool();
    const conn = await pool.getConnection();
    try {
      // ORDER BY … LIMIT sposta ordinamento e troncamento sul server: la riga
      // che interessa (quella che gira da più tempo) è la prima, quindi non è
      // mai fra quelle scartate dal tetto.
      const [rows] = await conn.query(
        `SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO
           FROM information_schema.PROCESSLIST
          ORDER BY TIME DESC
          LIMIT ${sessioni.MAX_SESSIONI + 1}`
      );

      // I privilegi dell'utente della connessione non cambiano mentre il
      // pannello è aperto: si chiedono una volta sola per connessione, invece
      // che a ogni refresh (il pannello si aggiorna ogni 5 s, e sarebbe una
      // query in più ogni volta solo per decidere il testo di una nota).
      if (this._notaPrivilegi === undefined) {
        this._notaPrivilegi = null;
        try {
          const [grants] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
          const testo = grants.map((r) => Object.values(r)[0]).join('\n');
          if (!/\b(PROCESS|ALL PRIVILEGES)\b/i.test(testo)) {
            this._notaPrivilegi = 'Vengono mostrate solo le sessioni dell\'utente collegato: manca il privilegio PROCESS, necessario per vedere quelle degli altri utenti.';
          }
        } catch { /* SHOW GRANTS negato: si preferisce nessuna nota a una sbagliata */ }
      }
      const nota = this._notaPrivilegi;

      const { coppie, saBloccanti, transazioni } = await this.attesePerLock(conn);
      const troncato = rows.length > sessioni.MAX_SESSIONI;
      const lista = sessioni.ordina(sessioni.collegaBlocchi(
        sessioni.normalizzaMysql(rows.slice(0, sessioni.MAX_SESSIONI), {
          threadIds: this.threadIdsDelPool(),
          transazioni,
        }),
        coppie
      ));
      return {
        sessioni: lista,
        capacita: { annullaQuery: true, terminaConnessione: true, saBloccanti },
        troncato,
        nota,
      };
    } finally {
      conn.release();
    }
  }

  /**
   * Coppie "chi aspetta → chi tiene il lock" per i lock InnoDB.
   *
   * Non è un di più: davanti a "il database è fermo" si vede la sessione in
   * attesa, la si termina, e non cambia nulla — quella è la vittima. Il lock
   * ce l'ha un'altra, spesso una connessione che non sta eseguendo niente e
   * che quindi non compare fra le query lente.
   *
   * Due dialetti e nessuno dei due garantito: `performance_schema.data_lock_waits`
   * esiste da MySQL 8, `information_schema.innodb_lock_waits` era la forma di
   * 5.7 (e MariaDB); entrambe richiedono privilegi che l'utente della
   * connessione può non avere. Il fallimento non è un errore da mostrare — il
   * resto del pannello funziona benissimo lo stesso — ma nemmeno da nascondere:
   * torna `saBloccanti: false`, e l'interfaccia dice che questo database non
   * sa indicare il bloccante invece di far credere che non ce ne siano.
   *
   * Restano fuori i lock di METADATO ("Waiting for table metadata lock", il
   * caso tipico di una ALTER dietro una transazione aperta): stanno in
   * `performance_schema.metadata_locks`, con un'altra forma. Limite noto.
   */
  async attesePerLock(conn) {
    const query = (sql) => conn.query(sql).then(([r]) => r);
    const mappa = (rows) => rows
      .filter((r) => r.attesa != null && r.blocca != null)
      .map((r) => ({ attesa: String(r.attesa), blocca: String(r.blocca) }));

    // Thread con una transazione aperta: su MySQL non c'è uno stato che lo
    // dica (un `Sleep` con i lock in mano è indistinguibile da un `Sleep`
    // qualunque), ed è proprio la sessione che finisce col bloccare tutti.
    let transazioni = [];
    try {
      transazioni = (await query('SELECT trx_mysql_thread_id AS id FROM information_schema.innodb_trx'))
        .map((r) => r.id).filter((v) => v != null);
    } catch { /* privilegi mancanti: si rinuncia al dettaglio, non al pannello */ }

    try {
      return {
        transazioni,
        coppie: mappa(await query(
          `SELECT r.trx_mysql_thread_id AS attesa, b.trx_mysql_thread_id AS blocca
             FROM performance_schema.data_lock_waits w
             JOIN information_schema.innodb_trx r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
             JOIN information_schema.innodb_trx b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID`
        )),
        saBloccanti: true,
      };
    } catch (_e8) {
      try {
        return {
          transazioni,
          coppie: mappa(await query(
            `SELECT r.trx_mysql_thread_id AS attesa, b.trx_mysql_thread_id AS blocca
               FROM information_schema.innodb_lock_waits w
               JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id
               JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id`
          )),
          saBloccanti: true,
        };
      } catch (_e57) {
        return { transazioni, coppie: [], saBloccanti: false };
      }
    }
  }

  /**
   * Id dei thread del NOSTRO pool. mysql2 non ha un'API pubblica per
   * enumerarli (come per le statistiche del pool in `health()`): si leggono in
   * modo difensivo i contatori interni. Un fallimento qui non è grave in sé ma
   * lo diventa nell'interfaccia — le connessioni di CodeDB comparirebbero come
   * terminabili — quindi l'assenza del dato vale "non lo so", e il monitor
   * segnala comunque la connessione con cui sta interrogando (che è certa).
   */
  threadIdsDelPool() {
    const ids = [];
    try {
      const raw = (this.pool && this.pool.pool) || this.pool;
      const all = raw && raw._allConnections;
      const arr = !all ? [] : (typeof all.toArray === 'function' ? all.toArray() : Array.from(all));
      for (const c of arr) {
        const id = c && (c.threadId != null ? c.threadId : (c.connection && c.connection.threadId));
        if (id != null) ids.push(id);
      }
    } catch { /* internals non disponibili */ }
    return ids;
  }

  async killSession(id, modo) {
    const pool = this.requirePool();
    // L'id arriva dal client: va usato come NUMERO in un comando che non
    // ammette parametri preparati (`KILL` non li accetta), quindi se non è un
    // intero non si costruisce alcuna stringa SQL con esso.
    const num = Number(String(id).trim());
    if (!Number.isInteger(num) || num <= 0) throw new Error(`Id di sessione non valido: "${id}".`);
    const conn = await pool.getConnection();
    try {
      await conn.query(modo === 'connessione' ? `KILL CONNECTION ${num}` : `KILL QUERY ${num}`);
      return { terminata: true, modo: modo === 'connessione' ? 'connessione' : 'query' };
    } finally {
      conn.release();
    }
  }

  async cancelQuery(opHandle) {
    if (!opHandle || !opHandle.connectionId || !this.pool) return { cancelled: false };
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`KILL QUERY ${opHandle.connectionId}`);
      return { cancelled: true };
    } catch (err) {
      return { cancelled: false };
    } finally {
      conn.release();
    }
  }

  // Piano di esecuzione: EXPLAIN sulla SELECT costruita da filter/sort correnti
  // (modalità find) o sulla SQL Raw (modalità aggregate). Prova prima
  // EXPLAIN FORMAT=JSON, con ripiego sull'EXPLAIN classico tabellare
  // (versioni vecchie o statement non supportati dal formato JSON).
  async collectionExplain(db, coll, payload) {
    const pool = this.requirePool();
    let sql;
    if (payload.mode === 'aggregate') {
      sql = String(payload.pipeline || '').trim();
      if (!sql) throw new Error('Inserisci una query SQL di cui mostrare il piano.');
    } else {
      const { table, whereSql, orderSql, limit, skip } = this.buildSelect(db, coll, payload);
      sql = `SELECT * FROM ${table}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${skip}`;
    }

    const conn = await pool.getConnection();
    try {
      await conn.query(`USE ${qid(db)}`);
      try {
        const [rows] = await conn.query(`EXPLAIN FORMAT=JSON ${sql}`);
        const raw = rows && rows[0] && (rows[0].EXPLAIN || rows[0][Object.keys(rows[0])[0]]);
        return { format: 'json', plan: JSON.parse(String(raw)), query: sql };
      } catch (err) {
        // Ripiego: EXPLAIN classico in forma tabellare.
        const [rows, fields] = await conn.query(`EXPLAIN ${sql}`);
        if (!Array.isArray(rows)) throw err;
        const columns = (fields || []).map((f) => f.name);
        return { format: 'table', rows: rows.map(serializeRow), columns, query: sql };
      }
    } finally {
      conn.release();
    }
  }

  async docInsert(db, coll, payload) {
    const pool = this.requirePool();
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    const cols = Object.keys(doc);
    const table = qtable(db, coll);
    let res;
    if (!cols.length) {
      [res] = await pool.query(`INSERT INTO ${table} () VALUES ()`);
    } else {
      // Una geometria non è un parametro come gli altri: il segnaposto diventa
      // ST_GeomFromGeoJSON(?) col SRID della colonna (vedi geoBinding).
      const { geo } = await this.tableColumnsInfo(db, coll);
      const bind = cols.map((c) => MySqlStrategy.geoBinding(c, doc[c], geo));
      const sql = `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES (${bind.map((b) => b.sql).join(', ')})`;
      [res] = await pool.query(sql, bind.map((b) => b.param));
    }
    return { insertedId: JSON.stringify(res.insertId || null) };
  }

  async docUpdate(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const set = deserializeClientObject(payload.set);
    const assignments = [];
    const params = [];
    const { geo } = await this.tableColumnsInfo(db, coll);
    for (const [col, val] of Object.entries(set)) {
      const b = MySqlStrategy.geoBinding(col, val, geo);
      assignments.push(`${qid(col)} = ${b.sql}`);
      params.push(b.param);
    }
    for (const col of payload.unset || []) {
      assignments.push(`${qid(col)} = NULL`);
    }
    if (!assignments.length) throw new Error('Nessuna modifica da applicare.');
    const [res] = await pool.query(
      `UPDATE ${qtable(db, coll)} SET ${assignments.join(', ')} WHERE ${where.sql} LIMIT 1`,
      [...params, ...where.params]
    );
    return { matched: res.affectedRows, modified: res.changedRows != null ? res.changedRows : res.affectedRows };
  }

  async docReplace(db, coll, payload) {
    const pool = this.requirePool();
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    delete doc._id; // chiave virtuale, non è una colonna
    // In SQL "sostituire" la riga equivale ad aggiornare tutte le colonne note.
    return this.docUpdate(db, coll, { id: payload.id, set: EJSON.serialize(doc, { relaxed: true }) });
  }

  async docDelete(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const [res] = await pool.query(
      `DELETE FROM ${qtable(db, coll)} WHERE ${where.sql} LIMIT 1`,
      where.params
    );
    return { deleted: res.affectedRows };
  }

  async collectionDeleteMany(db, coll, payload) {
    const pool = this.requirePool();
    const filter = String(payload.filter || '').trim();
    // Senza filtro svuota la tabella (come deleteMany({}) su MongoDB):
    // la conferma rafforzata è responsabilità del frontend.
    const [res] = await pool.query(
      `DELETE FROM ${qtable(db, coll)}${filter ? ` WHERE ${filter}` : ''}`
    );
    return { deleted: res.affectedRows };
  }

  // Valore di cella per l'export CSV: date in ISO, BLOB in base64,
  // oggetti/array come JSON; quoting RFC 4180 dove serve.
  static csvCell(v) {
    if (v === null || v === undefined) return '';
    let s;
    if (v instanceof Date) s = isNaN(v.getTime()) ? '' : v.toISOString();
    else if (Buffer.isBuffer(v)) s = v.toString('base64');
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // CREATE TABLE della tabella: usato dall'export di interi database per
  // ricreare lo schema all'import.
  async tableDdl(db, coll) {
    const pool = this.requirePool();
    const [[row]] = await pool.query(`SHOW CREATE TABLE ${qtable(db, coll)}`);
    // Le view (anche di sistema) restituiscono 'Create View': niente DDL da
    // esportare, il chiamante le tratta come le collection senza schema.
    const ddl = row && row['Create Table'];
    return ddl == null ? null : String(ddl);
  }

  async dbSchema(db) {
    const pool = this.requirePool();
    const [tables] = await pool.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
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
        presence: row.IS_NULLABLE === 'YES' ? 0 : 100, // coerente con PostgreSqlStrategy
      });
    }

    const collections = tables.map((t) => ({
      name: t.TABLE_NAME,
      fields: colsByTable.get(t.TABLE_NAME) || [],
    }));

    const [fkRows] = await pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [db]
    );

    const relations = [];
    const fkSet = new Set();
    for (const fk of fkRows) {
      relations.push({
        from: fk.TABLE_NAME,
        field: fk.COLUMN_NAME,
        to: fk.REFERENCED_TABLE_NAME,
        many: true,
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
  }


  // Esporta un blocco di righe come CSV (format: 'csv', header a parte),
  // come statement INSERT (format: 'sql') o come righe Extended JSON
  // (format: 'json', una riga-oggetto per riga di tabella: è il formato
  // dell'export di interi database, reimportabile con collectionImport).
  // Paginazione keyset sulla chiave primaria (evita l'O(n²) di OFFSET su
  // tabelle grandi): payload.after = EJSON dei valori PK dell'ultima riga
  // ricevuta. Senza chiave primaria non esiste un ordinamento stabile su cui
  // costruire un cursore, quindi si ripiega su skip/offset (comportamento
  // precedente, invariato per questo caso).
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
        whereSql = ` WHERE (${pkCols}) > (${pk.map(() => '?').join(', ')})`;
        params = afterVals.map(toSqlValue);
      }
      [rows, fields] = await pool.query(
        `SELECT * FROM ${table}${whereSql} ORDER BY ${pkCols} LIMIT ?`,
        [...params, limit]
      );
      if (rows.length) {
        const last = rows[rows.length - 1];
        nextAfter = EJSON.stringify(pk.map((c) => last[c]), { relaxed: true });
      }
    } else {
      const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
      [rows, fields] = await pool.query(`SELECT * FROM ${table} LIMIT ? OFFSET ?`, [limit, skip]);
    }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    const columns = (fields || []).map((f) => f.name);

    let lines;
    if (format === 'sql') {
      lines = rows.map((r) => {
        const vals = columns.map((c) => mysql.escape(r[c]));
        return `INSERT INTO ${table} (${columns.map(qid).join(', ')}) VALUES (${vals.join(', ')});`;
      });
    } else if (format === 'json') {
      // EJSON relaxed: le DATETIME diventano { $date } e il roundtrip
      // export → import preserva i tipi (vedi collectionImport).
      lines = rows.map((r) => EJSON.stringify(r, { relaxed: true }));
    } else {
      lines = rows.map((r) => columns.map((c) => MySqlStrategy.csvCell(r[c])).join(','));
    }
    return {
      lines,
      count: rows.length,
      total: Number(total),
      format,
      header: format === 'csv' ? columns.map(MySqlStrategy.csvCell).join(',') : null,
      nextAfter,
    };
  }

  // Importa un blocco di righe (payload.docs = array di oggetti Extended JSON
  // serializzati: relaxed = true produce i tipi JS nativi per i parametri
  // SQL). Le righe con lo stesso insieme di colonne (stesso ordine, il caso
  // comune quando arrivano da un export della stessa tabella) vengono
  // raggruppate in un unico INSERT multi-VALUES, come già fa il restore dei
  // backup; un batch che fallisce viene ripetuto riga per riga per isolare
  // l'errore e non perdere le righe valide, mantenendo il report ok/errori.
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
        const cols = Object.keys(row);
        if (!cols.length) throw new Error('riga vuota');
        parsed.push({ i, cols, values: cols.map((c) => toSqlValue(row[c])) });
      } catch (err) {
        if (errors.length < 10) errors.push(`Riga ${i + 1}: ${(err && err.message) || err}`);
      }
    }

    const BATCH_SIZE = 500;
    const groups = [];
    let cur = null;
    for (const p of parsed) {
      const sig = p.cols.join('\u0000');
      if (cur && cur.sig === sig && cur.rows.length < BATCH_SIZE) {
        cur.rows.push(p);
      } else {
        cur = { sig, cols: p.cols, rows: [p] };
        groups.push(cur);
      }
    }

    for (const g of groups) {
      try {
        const [res] = await pool.query(
          `INSERT INTO ${table} (${g.cols.map(qid).join(', ')}) VALUES ?`,
          [g.rows.map((r) => r.values)]
        );
        inserted += res.affectedRows;
      } catch {
        // Un vincolo violato da una sola riga fa fallire tutto il batch:
        // si ripete riga per riga per isolare quale e non perdere le altre.
        for (const r of g.rows) {
          try {
            await pool.query(
              `INSERT INTO ${table} (${g.cols.map(qid).join(', ')}) VALUES (${g.cols.map(() => '?').join(', ')})`,
              r.values
            );
            inserted += 1;
          } catch (err) {
            if (errors.length < 10) errors.push(`Riga ${r.i + 1}: ${(err && err.message) || err}`);
          }
        }
      }
    }

    return { inserted, failed: raw.length - inserted, errors };
  }

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
  }

  async renameCollection(db, coll, newName) {
    const pool = this.requirePool();
    const to = String(newName || '').trim();
    if (!to) throw new Error('Nuovo nome della tabella mancante.');
    DbStrategy.assertCreatableName(to, 'della tabella');
    await pool.query(`RENAME TABLE ${qtable(db, coll)} TO ${qtable(db, to)}`);
    this._geoCache.clear();
  }

  async dropCollection(db, coll) {
    const pool = this.requirePool();
    await pool.query(`DROP TABLE ${qtable(db, coll)}`);
    this._geoCache.clear();
  }

  async addColumn(db, coll, column) {
    const pool = this.requirePool();
    await pool.query(`ALTER TABLE ${qtable(db, coll)} ADD COLUMN ${columnSql(column || {})}`);
    this._geoCache.clear(); // i metadati di colonna in cache non valgono più
  }

  // payload: { oldName, column: { name, type, nullable, default } }
  async alterColumn(db, coll, payload) {
    const pool = this.requirePool();
    const oldName = String((payload && payload.oldName) || '').trim();
    if (!oldName) throw new Error('Nome della colonna da modificare mancante.');
    await pool.query(
      `ALTER TABLE ${qtable(db, coll)} CHANGE COLUMN ${qid(oldName)} ${columnSql(payload.column || {})}`
    );
    this._geoCache.clear();
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

  async dropIndex(db, coll, name) {
    const pool = this.requirePool();
    const idx = String(name || '').trim();
    if (!idx) throw new Error('Nome dell\'indice da eliminare mancante.');
    if (idx.toUpperCase() === 'PRIMARY') {
      await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP PRIMARY KEY`);
    } else {
      await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP INDEX ${qid(idx)}`);
    }
  }

  async tableFields(db, table) {
    const pool = this.requirePool();
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS cdefault, EXTRA AS extra, COLUMN_KEY AS ckey
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
      [db, table]
    );
    return cols.map((c) => ({
      name: c.name,
      types: [String(c.ctype)],
      presence: c.nullable === 'YES' ? 0 : 100, // 100 = NOT NULL
      nullable: c.nullable === 'YES',
      default: c.cdefault == null ? null : String(c.cdefault),
      autoIncrement: /auto_increment/i.test(String(c.extra || '')),
      key: String(c.ckey || ''),
    }));
  }

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
        count: Number(t.TABLE_ROWS) || 0, // stima InnoDB
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
  }
}

module.exports = MySqlStrategy;
