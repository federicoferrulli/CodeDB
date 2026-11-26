'use strict';

const mysql = require('mysql2');
const { prendiConnessioneSql, chiudiStrategiaSql } = require('./sqlSessione');
const { tipoMysqlNativo } = require('./sqlRisultatiNativi');
const { modificaConSrid, ERRORE_SRID } = require('./sridModifica');
const { EJSON, Binary } = require('bson');
const DbStrategy = require('./DbStrategy');
const { stimaConteggio, conteggioLimitato, completaConteggi } = require('./conteggiNavigatore');
const { splitStatements } = require('./sqlText');
const { tabellare } = require('./sqlTabellare');
const { eseguiBatchScritture } = require('./sqlWriteBatch');
// Metadati comuni ai due motori SQL (chiave primaria, colonne, campi, indici
// unici, keyset, conteggio): la logica sta nel modulo, qui resta il dialetto.
const { installaMetadati } = require('./sqlMetadati');
// Conversione EJSON <-> parametri SQL: è il protocollo del client, non il
// dialetto del server, quindi vive in un modulo solo (vedi db/sqlValori.js).
const { toSqlValue, parseClientValue, deserializeClientObject, serializeRow, documentoScrivibile } = require('./sqlValori');
const { cellaCsv } = require('./csv');
// Come si scrive il nome di una tabella o di una colonna: regola unica,
// condivisa con l'altro adattatore SQL, con il DDL, con il backup e col
// frontend (vedi db/identificatori.js).
const { quotaSempre, quotaQualificato } = require('./identificatori');
const {
  isSqlGeometryType, isGeoJson, assertGeoJson, parseGeoJsonText, daFormaDriverMysql,
} = require('./geometry');
const {
  normalizzaRicerca, catalogoDaDocumenti, aggiornaCacheCatalogo, catalogoValido,
  clausolaMySql, tipoJsonMySql, separaCataloghiJson,
} = require('./ricercaGlobale');
const {
  DIALETTO_METADATI,
  defaultSql,
  columnSql,
  columnAlterSqlStatica,
  installaCatalogoMysql,
} = require('./mysql-catalogo-schema');
const { installaTrasferimentoMysql } = require('./mysql-trasferimento');
const { installaSessioniMysql } = require('./mysql-sessioni-monitor');

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

// Tipi su cui ha senso cercare col LIKE nel pannello di riferimento (vedi
// relatedRows). Fuori da qui restano numeri, date e binari: un LIKE su una
// colonna non testuale costringe MySQL a convertirla riga per riga e non
// risponde comunque alla domanda che l'utente sta ponendo.
const TESTUALI_MYSQL = new Set([
  'char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json',
]);

/* ---------------------------------------------------------------------------
 * Helpers MySQL
 * ------------------------------------------------------------------------- */

function assertDbName(name) {
  if (!name || /[\r\n]/.test(name) || name.length > 64) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

function qid(name) {
  return quotaSempre(name, 'mysql');
}

function qtable(db, table) {
  return quotaQualificato([db, table], 'mysql');
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

const nulliPrima = () => '';

const TABELLARE = tabellare({
  qid, qtable, whereFromId, nulliPrima, segnaposto: () => '?', testoDi: (col) => col,
});

async function preparaRicercaGlobale(strategy, db, coll, payload, colonne) {
  const valore = normalizzaRicerca(payload && payload.cercaOvunque);
  if (!valore) return null;
  const json = (colonne || []).filter(tipoJsonMySql);
  let catalogo = new Map();
  if (json.length) {
    const chiave = `${db}\0${coll}`;
    catalogo = catalogoValido(strategy._cacheRicerca, chiave);
    if (!catalogo) {
      const nomi = json.map((c) => qid(c.name)).join(', ');
      const [righe] = await strategy.requirePool().query(
        `SELECT ${nomi} FROM ${qtable(db, coll)} LIMIT 100`
      );
      for (const riga of righe) {
        for (const col of json) {
          if (typeof riga[col.name] !== 'string') continue;
          try { riga[col.name] = JSON.parse(riga[col.name]); } catch { riga[col.name] = null; }
        }
      }
      catalogo = aggiornaCacheCatalogo(
        strategy._cacheRicerca,
        chiave,
        catalogoDaDocumenti(righe)
      );
    }
  }
  const perColonna = separaCataloghiJson(catalogo, json.map((c) => c.name));
  return () => clausolaMySql(valore, colonne, perColonna, qid);
}

/* ---------------------------------------------------------------------------
 * Collation della connessione
 *
 * mysql2 non chiede al server quale collation usare: se `charset` non è
 * indicato ripiega su una COSTANTE compilata nel driver — oggi
 * utf8mb4_unicode_ci (lib/connection_config.js). Il client `mysql` e DBeaver
 * adottano invece la predefinita del server, e la differenza non è cosmetica:
 * tutto ciò che eredita `collation_connection` — le variabili utente `@x`,
 * `CAST(… AS CHAR)`, `DATE_FORMAT()` — ha coercibilità IMPLICIT, la stessa di
 * una colonna. Confrontarlo con una colonna di collation diversa è l'errore
 * 1267 «Illegal mix of collations»: una query corretta altrove che falliva
 * SOLO in CodeDB, per una collation che l'utente non ha mai scelto.
 *
 * Ci si allinea al database (in mancanza, al server), ma SOLO dentro utf8mb4.
 * Adottare la collation di un altro charset — su un server vecchio
 * `collation_server` è spesso latin1_swedish_ci — cambierebbe
 * `character_set_connection` lasciando `character_set_client` a utf8mb4: i
 * letterali verrebbero convertiti a latin1 e i caratteri fuori da quel
 * repertorio (emoji, ideogrammi) andrebbero persi per strada. Il ripiego è la
 * collation utf8mb4 predefinita DEL SERVER, cioè quella che prendono le
 * tabelle create senza COLLATE esplicito.
 * ------------------------------------------------------------------------- */

const PREFISSO_UTF8MB4 = 'utf8mb4_';

// Nome di collation plausibile: finisce dentro uno `SET`, e il valore arriva
// dal server, ma un identificatore si controlla comunque prima di comporlo.
const RE_COLLAZIONE = /^[a-z0-9_]+$/i;

/**
 * Sceglie la collation a cui allineare la connessione fra le candidate, in
 * ordine di specificità (database → server → predefinita utf8mb4 del server).
 * Scarta tutto ciò che non è utf8mb4: vedi il commento sopra.
 * @returns {string|null} `null` = nessuna candidata utilizzabile, si resta al
 *   default del driver (cioè al comportamento di prima).
 */
function scegliCollazione({ database, server, utf8mb4 } = {}) {
  for (const c of [database, server, utf8mb4]) {
    const nome = String(c == null ? '' : c).trim();
    if (!nome || !RE_COLLAZIONE.test(nome)) continue;
    if (!nome.toLowerCase().startsWith(PREFISSO_UTF8MB4)) continue;
    return nome;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Strategia MySQL: un pool dedicato per istanza (cioè per socket)
 * ------------------------------------------------------------------------- */

class MySqlStrategy extends DbStrategy {
  constructor(options = {}) {
    super(options);
    this.pool = null; // pool promise-based di mysql2
    // Colonne geometriche per tabella (vedi geoColumns): la lettura le deve
    // conoscere a OGNI find, e information_schema non è gratis. Cache breve,
    // svuotata dalle DDL sulle colonne che passano da qui.
    this._cacheColonne = new Map();
    this._cacheRicerca = new Map();
    this._preparaRicercaGlobale = (db, coll, payload, colonne) =>
      preparaRicercaGlobale(this, db, coll, payload, colonne);
    // Collation a cui allineare ogni connessione del pool (null = default del
    // driver). Decisa alla connessione, vedi scegliCollazione.
    this.collazione = null;
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
      // Un BIGINT oltre 2^53 lo consegna come STRINGA, non come Number
      // arrotondato: senza, mysql2 fa `Number(s)` sul testo del campo e
      // 9007199254740993 diventava ...992 PRIMA di qualunque giro EJSON —
      // quindi nella griglia, nell'export e nel backup, che usa questo pool.
      // I valori dentro l'intervallo sicuro restano Number: la stringa compare
      // solo dove il numero non era rappresentabile.
      supportBigNumbers: true,
    }).promise();

    // Ogni connessione NUOVA riparte dal default del driver: il pool ne apre
    // fino a `connectionLimit` e le riapre dopo una caduta, quindi l'allinea-
    // mento va rifatto alla nascita di CIASCUNA, non una volta sola. mysql2
    // serve i comandi di una connessione in ordine di arrivo: la `SET`
    // accodata qui precede la query di chi ha chiesto la connessione.
    pool.pool.on('connection', (conn) => {
      if (!this.collazione) return;
      conn.query(`SET collation_connection = ${mysql.escape(this.collazione)}`, () => {});
    });

    // Prima connessione: valida le credenziali (devono fallire QUI, non alla
    // prima query dell'utente) e rileva la collation a cui allinearsi.
    let conn;
    try {
      conn = await pool.getConnection();
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    try {
      // Il rilevamento non è essenziale: se fallisce (privilegi ridotti,
      // server esotico, fork che non espone CHARACTER_SETS) si resta al
      // default del driver — il comportamento di prima — invece di rifiutare
      // una connessione che per tutto il resto funziona.
      try {
        this.collazione = await this.rilevaCollazione(conn);
        if (this.collazione) {
          // Questa connessione è nata prima che la collation fosse nota:
          // l'handler qui sopra l'ha saltata, e senza questa riga tornerebbe
          // nel pool disallineata.
          await conn.query(`SET collation_connection = ${mysql.escape(this.collazione)}`);
        }
      } catch (_) {
        this.collazione = null;
      }
    } finally {
      conn.release();
    }
    this.pool = pool;
  }

  /**
   * Collation candidate lette dal server, in un solo giro. `@@collation_database`
   * senza database predefinito vale quella del server, e va bene: è il ripiego
   * successivo.
   */
  async rilevaCollazione(conn) {
    const [[r]] = await conn.query(
      `SELECT @@collation_database AS db, @@collation_server AS srv,
              (SELECT DEFAULT_COLLATE_NAME FROM information_schema.CHARACTER_SETS
                WHERE CHARACTER_SET_NAME = 'utf8mb4') AS u8`
    );
    return scegliCollazione({ database: r && r.db, server: r && r.srv, utf8mb4: r && r.u8 });
  }

  /**
   * Cambio di database su una connessione del pool.
   *
   * Il `USE` da solo non basta: `collation_connection` NON segue il database, e
   * due database dello stesso server possono avere collation diverse — è il
   * caso normale quando accanto a uno schema nuovo vive un dump vecchio.
   * Allinearsi solo alla connessione servirebbe quindi soltanto sul database
   * predefinito. La scelta è fatta LATO SERVER in una sola istruzione: se la
   * collation del database non è utf8mb4 si torna a quella rilevata alla
   * connessione, per non portare `character_set_connection` fuori da utf8mb4
   * (vedi il commento in testa al file). `LEFT(...)` e non `LIKE`: con
   * NO_BACKSLASH_ESCAPES l'underscore di `'utf8mb4\_%'` non sarebbe più
   * protetto e il confronto diventerebbe più largo del previsto.
   */
  async usaDatabase(conn, db) {
    if (!db) return;
    await conn.query(`USE ${qid(db)}`);
    if (!this.collazione) return;
    await conn.query(
      "SET collation_connection = IF(LEFT(@@collation_database, 8) = 'utf8mb4_', @@collation_database, ?)",
      [this.collazione]
    );
  }

  async disconnect() {
    await chiudiStrategiaSql(this);
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
    this.requirePool();
    const from = String(db || '').trim();
    const to = String(newName || '').trim();
    assertDbName(from);
    assertDbName(to);
    DbStrategy.assertCreatableName(to, 'del database');
    if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
    if (SYSTEM_SCHEMAS.has(from.toLowerCase())) {
      throw new Error(`Il database di sistema "${from}" non può essere rinominato.`);
    }

    // MySQL non offre RENAME DATABASE, e questo metodo NON lo emula: la vecchia
    // emulazione spostava le sole tabelle base, perdendo view, routine, trigger
    // ed eventi. La rinomina passa da dump → verifica → restore, orchestrata
    // dal server (`rinominaViaDump`), che quegli oggetti li salva e li ricrea.
    // Arrivare qui significa che qualcuno ha scavalcato quel percorso.
    throw new Error(
      'La rinomina di un database MySQL non passa da questo metodo: usa il ' +
      'percorso dump/restore del server (db:rename), che copia anche view, ' +
      'routine, trigger, eventi e chiavi esterne e verifica il risultato.'
    );
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

  async listCollections(db, { includeCounts = true } = {}) {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS ttype, TABLE_ROWS AS cnt
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
      [db]
    );
    // TABLE_TYPE: 'BASE TABLE', 'VIEW' oppure 'SYSTEM VIEW' (information_schema).
    const collections = rows.map((r) => {
      const isView = String(r.ttype || '').toUpperCase().includes('VIEW');
      return {
        name: r.name,
        type: isView ? 'view' : 'collection',
        ...stimaConteggio(isView || !includeCounts ? null : r.cnt),
      };
    });
    if (!includeCounts) return collections;
    return completaConteggi(collections, async (coll, limit, ms) => {
      const conn = await pool.getConnection();
      let avvelenata = false;
      try {
        const [[row]] = await conn.query({
          sql: `SELECT /*+ MAX_EXECUTION_TIME(${ms}) */ COUNT(*) AS n FROM (SELECT 1 FROM ${qtable(db, coll.name)} LIMIT ${limit}) AS campione`,
          timeout: ms,
        });
        return conteggioLimitato(row?.n, coll.count);
      } catch (err) {
        avvelenata = MySqlStrategy.isDriverTimeout(err);
        if (avvelenata) {
          await this.uccidiSulServer(conn.threadId);
          conn.destroy();
        }
        throw err;
      } finally {
        if (!avvelenata) conn.release();
      }
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

  /* -------------------------------------------------------------------------
   * Geometrie (vedi db/geometry.js per il perché del formato unico GeoJSON)
   * ---------------------------------------------------------------------- */

  // Lista di selezione: `*` quando non ci sono geometrie (nessun costo per il
  // 99% delle tabelle), altrimenti le colonne per nome con ST_AsGeoJSON su
  // quelle geometriche — l'alias conserva il nome originale, quindi il resto
  // della pipeline (colonne, _id, griglia) non si accorge di nulla.
  async selectListFor(db, coll, infoPrecaricate = null, { preservaSrid = false } = {}) {
    const info = infoPrecaricate || await this.tableColumnsInfo(db, coll);
    if (!info.geo.size) return { list: '*', geo: info.geo, colonne: info.columns };
    const list = info.columns
      .map((c) => (info.geo.has(c.name) ? `ST_AsGeoJSON(${qid(c.name)}${preservaSrid ? ', 17, 2' : ''}) AS ${qid(c.name)}` : qid(c.name)))
      .join(', ');
    // `colonne` viaggia con la lista: sono gli STESSI descrittori appena letti,
    // quindi chi compone l'ORDER BY non deve rileggere il catalogo.
    return { list, geo: info.geo, colonne: info.columns };
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

  // Lo SRID deve essere noto già al parser, prima di interpretare gli assi.
  static geoPlaceholder(colInfo) {
    if (!colInfo || colInfo.srid == null) {
      throw new Error('SRID non noto: CodeDB non può modificare la geometria senza reinterpretare le coordinate. Dichiara lo SRID della colonna oppure consenti la lettura dei metadata di information_schema.');
    }
    const srid = Number(colInfo.srid);
    return `ST_GeomFromGeoJSON(?, 1, ${srid})`;
  }

  // Valore di scrittura per una colonna: le geometriche prendono il frammento
  // ST_GeomFromGeoJSON, tutte le altre un normale segnaposto.
  static geoBinding(col, value, geo, { importazione = false } = {}) {
    let colInfo = geo && geo.get(col);
    if (colInfo) {
      if (typeof value === 'string') {
        const match = /^(?:SRID=(\d+);)?\s*([A-Z]+\s*(?:\(|EMPTY\b)[\s\S]*)$/i.exec(value.trim());
        if (!match) throw new Error(`Colonna "${col}": usa WKT, SRID=…;WKT oppure GeoJSON.`);
        const srid = Number(match[1] ?? colInfo.srid ?? 0);
        if (!Number.isInteger(srid) || srid < 0 || srid > 4294967295) throw new Error('SRID fuori intervallo.');
        if (colInfo.srid != null && srid !== colInfo.srid) throw new Error(`Colonna "${col}": richiede SRID ${colInfo.srid}.`);
        return { sql: `ST_GeomFromText(?, ${srid}, 'axis-order=long-lat')`, param: match[2] };
      }
      const bytes = toSqlValue(value);
      if (Buffer.isBuffer(bytes)) {
        if (bytes.length < 9) throw new Error(`Colonna "${col}": geometria binaria incompleta.`);
        return { sql: `ST_GeomFromWKB(?, ${bytes.readUInt32LE(0)}, 'axis-order=long-lat')`, param: bytes.subarray(4) };
      }
      // I file esportati prima della correzione portano la forma grezza del
      // driver (`{ x, y }` per un punto) invece del GeoJSON: si recupera,
      // invece di chiedere all'utente di rifare l'export.
      const geoJson = isGeoJson(value) ? value : daFormaDriverMysql(value);
      if (geoJson) {
        if (importazione) {
          // L'export conserva il CRS di ogni geometria, anche nelle colonne
          // senza vincolo SRID o con riferimenti diversi fra righe. I file
          // storici senza CRS usano il vincolo di colonna; senza vincolo hanno
          // coordinate cartesiane (SRID 0). Le modifiche inline continuano a
          // leggere lo SRID originale sotto lock tramite modificaConSrid.
          let srid = colInfo.srid ?? 0;
          if (geoJson.crs != null) {
            const name = geoJson.crs.type === 'name' && geoJson.crs.properties && geoJson.crs.properties.name;
            const match = typeof name === 'string' && name.match(/^(?:EPSG:|urn:ogc:def:crs:EPSG::)(\d+)$/i);
            if (!match) throw new Error(`Colonna "${col}": CRS della geometria non riconosciuto.`);
            srid = Number(match[1]);
          }
          if (!Number.isInteger(Number(srid)) || Number(srid) < 0 || Number(srid) > 4294967295) {
            throw new Error(`Colonna "${col}": SRID della geometria non valido.`);
          }
          if (colInfo.erroreSrid) throw new Error(ERRORE_SRID);
          colInfo = { ...colInfo, srid: Number(srid) };
        }
        // Si serializza ciò che è stato VALIDATO: `assertGeoJson` restituisce la
        // forma canonica, con le coordinate in numeri JSON invece che negli
        // oggetti BSON in cui il decodificatore Extended JSON stretto le
        // trasforma. Serializzare l'originale rimetterebbe quegli oggetti nel
        // testo passato a ST_GeomFromGeoJSON.
        const canonica = assertGeoJson(geoJson, `Colonna "${col}"`);
        return { sql: MySqlStrategy.geoPlaceholder(colInfo), param: JSON.stringify(canonica) };
      }
    }
    return { sql: '?', param: toSqlValue(value) };
  }

  // Le quattro funzioni del tabellare (identificatore di riga, sua lettura,
  // ordinamento, pezzi della SELECT) non hanno nulla di MySQL: stanno in
  // db/sqlTabellare.js, legate qui al solo dialetto. Vedi il commento in testa
  // a quel modulo.
  makeId(row, pkCols, allCols) {
    return TABELLARE.makeId(row, pkCols, allCols);
  }

  parseRowId(rawId) {
    return TABELLARE.parseRowId(rawId);
  }

  /**
   * L'ORDER BY della griglia e della tab ⚡. `opzioni.colonne` sono i
   * descrittori della tabella su cui si ordina (nome, tipo, nullabilità):
   * arrivano già letti da `collectionFind`, quindi conoscerli non costa una
   * lettura di catalogo in più. Un motore che debba ordinare diversamente
   * sovrascrive QUESTO metodo, ed è ascoltato da tutti i percorsi.
   */
  buildOrderBy(text, opzioni) {
    return TABELLARE.buildOrderBy(text, opzioni);
  }

  buildSelect(db, coll, payload, opzioni = {}) {
    // `ordinamento` chiude sul metodo di QUESTA istanza: è ciò che rende
    // efficace una sovrascrittura di `buildOrderBy` anche per la griglia.
    return TABELLARE.buildSelect(db, coll, payload, {
      ...opzioni,
      ordinamento: (testo) => this.buildOrderBy(testo, opzioni),
    });
  }

  async collectionFind(db, coll, payload) {
    const pool = this.requirePool();
    // Chiave primaria e metadati di colonna sono due letture di
    // information_schema indipendenti: in serie aggiungevano due round trip a
    // ogni pagina della griglia, in parallelo uno solo.
    //
    // La SELECT si compone DOPO di loro, e non prima: fino a ieri l'ordinamento
    // veniva composto in modo sincrono mentre la lettura dei metadati non era
    // nemmeno partita, quindi chi lo compone non poteva sapere nulla della
    // colonna su cui stava ordinando. I metadati si leggevano comunque, a ogni
    // pagina: spostare la composizione dopo di essi non costa niente.
    const [pk, sel] = await Promise.all([this.primaryKey(db, coll), this.selectListFor(db, coll)]);
    const ricercaGlobale = await this._preparaRicercaGlobale(db, coll, payload, sel.colonne);
    const { table, whereSql, whereParams, orderSql, limit, skip } =
      this.buildSelect(db, coll, payload, { colonne: sel.colonne, ricercaGlobale });

    // Keyset (seek) pagination: se richiesta e possibile (chiave a colonna
    // singola, ordinamento di default), pagina con `pk > :after` invece di
    // OFFSET, costo O(pagina) a qualsiasi profondità. Altrimenti fallback OFFSET.
    // Le colonne geometriche vanno lette come GeoJSON (ST_AsGeoJSON): senza,
    // mysql2 restituisce oggetti {x, y} annidati da cui non si risale al tipo.
    const { list: selectList, geo } = sel;
    const ks = this.buildKeyset(payload, table, whereSql, limit, pk, selectList, whereParams);
    const sql = ks ? ks.sql : `SELECT ${selectList} FROM ${table}${whereSql}${orderSql} LIMIT ? OFFSET ?`;
    // I parametri del filtro STRUTTURATO vengono prima di limite e salto:
    // `componiSelezione` li ha numerati partendo da 1, e invertirli farebbe
    // leggere il limite al posto del filtro. Col filtro testuale la lista è
    // vuota e non cambia nulla.
    const params = ks ? ks.params : [...whereParams, limit, skip];

    // Timeout per-query (mysql2 interrompe la query allo scadere): una find lenta
    // degrada con errore invece di tenere occupata la connessione del pool. La
    // query object include `timeout` solo se > 0.
    const ms = DbStrategy.queryTimeoutMs(this.env);
    const q = ms > 0 ? { sql, timeout: ms } : { sql };
    // Se la richiesta ha un opHandle (griglia con runId), la eseguiamo su una
    // connessione dedicata di cui catturiamo il CONNECTION_ID, così è
    // annullabile via `KILL QUERY` (cancelQuery) — nessuna modifica ai dati.
    // Connessione dedicata: consente KILL QUERY via opHandle, avvolge eventuali
    // clausole SQL libere in START TRANSACTION READ ONLY e, su timeout lato
    // client (PROTOCOL_SEQUENCE_TIMEOUT), uccide la query sul server e distrugge
    // la connessione invece di rimetterla avvelenata nel pool.
    let rows, fields;
    const opHandle = payload && payload.opHandle;
    const clausolaLibera = !!(
      (payload && typeof payload.filter === 'string' && payload.filter.trim())
      || (payload && typeof payload.sort === 'string' && payload.sort.trim() && !payload.sort.trim().startsWith('{'))
    );
    const conn = await pool.getConnection();
    let inTx = false;
    let avvelenata = false;
    try {
      if (opHandle) {
        if (conn.threadId) opHandle.connectionId = conn.threadId;
        else {
          try {
            const [[row]] = await conn.query('SELECT CONNECTION_ID() AS cid');
            if (row && row.cid) opHandle.connectionId = row.cid;
          } catch (_) {}
        }
      }
      if (clausolaLibera) {
        await conn.query('START TRANSACTION READ ONLY');
        inTx = true;
      }
      [rows, fields] = await conn.query(q, params);
    } catch (err) {
      if (MySqlStrategy.isDriverTimeout(err)) {
        avvelenata = true;
        await this.uccidiSulServer(conn.threadId);
      }
      throw err;
    } finally {
      if (inTx && !avvelenata) await conn.query('ROLLBACK').catch(() => {});
      if (avvelenata) conn.destroy?.();
      else conn.release();
    }
    // Keyset "indietro": la query gira in ordine pk DESC, qui si riordina ASC.
    if (ks && ks.reverse) rows = rows.slice().reverse();

    // COUNT(*) su InnoDB è una scansione: su tabelle enormi bloccherebbe la
    // griglia. Il client della UI passa `deferCount` e chiede il totale a parte
    // via `collection:count`; senza il flag (MCP, test) lo calcoliamo inline ma
    // con un timeout così non può bloccarsi all'infinito.
    let total = null;
    if (!payload.deferCount) {
      const c = await this.countWithTimeout(table, whereSql, whereParams);
      total = c.total;
    }

    MySqlStrategy.geoRowsToJson(rows, geo);

    const columns = (fields || []).map((f) => f.name);
    // Budget di byte: il tetto sulle righe non protegge da poche righe enormi
    // (BLOB, testi lunghi, campi JSON). Il driver ha già materializzato il
    // result set, ma qui si evita almeno di serializzarlo e spedirlo per intero.
    const capped = DbStrategy.truncateBySize(rows, DbStrategy.maxResultBytes(this.env));
    const idReale = columns.includes('_id');
    const rowIds = idReale ? capped.rows.map(r => serializeRow(this.makeId(r, pk, columns), sel.colonne)) : undefined;
    const docs = capped.rows.map((r) => {
      const doc = idReale ? r : { ...r, _id: this.makeId(r, pk, columns) };
      return serializeRow(doc, sel.colonne);
    });
    const columnMeta = Object.fromEntries(sel.colonne.map((c) => [c.name, {
      type: c.declaredType || c.type, nullable: c.nullable, srid: c.srid, generated: c.generated,
    }]));
    return { docs, columns, columnMeta, ...(rowIds ? { rowIds } : {}), total, skip, limit, keyset: !!ks, truncated: capped.truncated || undefined };
  }

  // COUNT(*) con timeout per-query (mysql2 uccide la query allo scadere). Ritorna
  // { total, timedOut }: total è null se il conteggio ha superato il timeout.
  // I PARAMETRI della clausola vanno con lei.
  //
  // Finché il filtro era un frammento di testo grezzo la clausola bastava a se
  // stessa, e il conteggio poteva riceverla da sola. Col filtro strutturato la
  // clausola contiene segnaposto, e mandarla senza valori dà «no parameter $1»
  // su PostgreSQL e un errore di sintassi su MySQL — cioè la griglia mostra le
  // righe e poi fallisce sul totale, il che è peggio di fallire subito perché
  // sembra un difetto del conteggio e non del filtro.
  async countWithTimeout(table, whereSql, whereParams = []) {
    const pool = this.requirePool();
    const ms = DbStrategy.countTimeoutMs(this.env);
    const q = { sql: `SELECT COUNT(*) AS total FROM ${table}${whereSql}` };
    if (ms > 0) q.timeout = ms;
    const conn = await pool.getConnection();
    let inTx = false;
    let avvelenata = false;
    try {
      if (whereSql) {
        await conn.query('START TRANSACTION READ ONLY');
        inTx = true;
      }
      const [[{ total }]] = await conn.query(q, whereParams);
      return { total: Number(total), timedOut: false };
    } catch (err) {
      if (MySqlStrategy.isDriverTimeout(err)) {
        avvelenata = true;
        await this.uccidiSulServer(conn.threadId);
        return { total: null, timedOut: true };
      }
      throw err;
    } finally {
      if (inTx && !avvelenata) await conn.query('ROLLBACK').catch(() => {});
      if (avvelenata) conn.destroy?.();
      else conn.release();
    }
  }

  // Modalità "SQL Raw": esegue una query libera nel contesto del database.
  // payload.readOnly (usato dal gateway MCP): esegue dentro una transazione
  // READ ONLY — il motore rifiuta qualsiasi scrittura, comprese quelle
  // annidate in CTE o EXPLAIN ANALYZE.
  // payload.expectRead: la query è stata CLASSIFICATA come lettura e chi la
  // esegue è un sottoutente (vedi guardStrategy). È la stessa barriera che
  // PostgreSqlStrategy applicava già, e che qui mancava: se il parser sbaglia,
  // a rifiutare la scrittura è il MOTORE. Non copre l'I/O su file (scrivere un
  // file non è una scrittura transazionale): quello è negato a monte dal Proxy.
  //
  // TETTO DI TEMPO — vale su ENTRAMBI i rami, non solo in lettura.
  // Prima il limite stava sul ramo di sola lettura, come costante `30000`
  // scritta qui dentro: una scrittura sbagliata (un UPDATE che tocca l'intera
  // tabella, un ALTER su milioni di righe) teneva una connessione del pool
  // senza alcun limite, e cambiare la configurazione non cambiava nulla.
  // Il valore viene ora da `DbStrategy.aggregateTimeoutMs(this.env)`, la stessa fonte
  // (env CODEDB_AGGREGATE_TIMEOUT_MS) che governa il tetto delle aggregazioni
  // su MongoDB; <= 0 disattiva il limite.
  async collectionAggregate(db, _coll, payload) {
    const pool = this.requirePool();
    const sql = String(payload.pipeline || '').trim();
    if (!sql) throw new Error('Inserisci una query SQL da eseguire.');
    const readOnly = !!payload.readOnly || !!payload.expectRead;
    const tetto = DbStrategy.aggregateTimeoutMs(this.env);
    const richiesta = { sql, typeCast: tipoMysqlNativo };
    if (tetto > 0) richiesta.timeout = tetto;
    const lease = await prendiConnessioneSql(this, sql, () => pool.getConnection());
    const conn = lease.conn;
    const { queryMysql, statoMysql } = require('./mysqlSessioneNativa');
    const query = (sql, params) => queryMysql(conn, sql, params);
    const statoNativo = statoMysql(conn);
    const transazioneInCorso = !!(statoNativo.status & 1);
    let eseguita = false;
    let erroreIstruzione;
    const letturaIsolata = readOnly && !lease.transazione;
    // Il timeout di mysql2 è lato CLIENT: allo scadere il driver smette di
    // aspettare, ma il server continua a eseguire e il result set arriverà
    // comunque, fuori sincrono con la richiesta successiva. Una connessione
    // così non può tornare al pool: va uccisa la query sul server e distrutta
    // la connessione.
    let avvelenata = false;
    try {
      if (readOnly && lease.transazione && !lease.solaLettura) {
        throw new Error('La lettura protetta non può aprire una seconda transazione: usa BEGIN READ ONLY o completa prima la transazione di scrittura.');
      }
      if (payload && payload.opHandle) {
        payload.opHandle.connectionId = conn.threadId;
      }
      // Il database osservato nel protocollo cambia anche dopo un USE libero.
      // Evitare USE/SET ridondanti preserva la diagnostica fra due query.
      if (db && statoNativo.database !== db) {
        statoNativo.database = undefined;
        await this.usaDatabase(conn, db);
        statoNativo.database = db;
      }
      if (letturaIsolata) await query('START TRANSACTION READ ONLY');
      try {
        const cap = DbStrategy.resultCap(payload);
        let risposta;
        try {
          risposta = await require('./mysqlSessioneNativa').queryRisultatoMysql(conn, richiesta, payload.params, cap, DbStrategy.maxResultBytes(this.env));
          eseguita = true;
        } catch (err) {
          require('./queryError').annotaErroreQuery(err, sql, 'mysql');
          if (!MySqlStrategy.isDriverTimeout(err)) throw err;
          avvelenata = true;
          await this.uccidiSulServer(conn.threadId);
          throw err;
        }
        if (risposta.righe) return risposta.righe;
        if (risposta.istruzioni > 1) {
          const summary = { istruzioniEseguite: risposta.istruzioni, righeCoinvolteTotali: risposta.coinvolte };
          return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap };
        }
        const result = risposta.header;
        // Statement senza result set (UPDATE, DELETE, DDL...): riepilogo.
        const summary = { righeCoinvolte: result ? (result.affectedRows || 0) : 0 };
        if (result && result.insertId) summary.insertId = result.insertId;
        if (result && result.info) summary.info = result.info;
        let activeDb;
        if (/^USE\b/i.test(require('./sqlText').stripSqlNoise(sql, { dbms: 'mysql', backslashEscape: true }).trim())) {
          // È MySQL a decodificare identificatori, escape e commenti. Il cambio
          // diventa visibile alla UI solo dopo che il comando è riuscito.
          activeDb = result.stateChanges?.schema;
          if (activeDb == null) {
            const [[row]] = await query('SELECT DATABASE() AS db');
            activeDb = row.db;
            statoNativo.database = activeDb;
          }
        }
        return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap, ...(activeDb ? { activeDb } : {}) };
      } finally {
        // Su una connessione avvelenata non si parla più: il ROLLBACK finirebbe
        // per leggere il result set arretrato della query uccisa.
        if (letturaIsolata && !avvelenata) await query('ROLLBACK').catch(() => {});
      }
    } catch (err) {
      erroreIstruzione = err;
      throw err;
    } finally {
      let statoServer;
      try {
        if (!avvelenata) {
          // Un errore non include flag. La lettura diagnostica li recupera
          // senza cancellare l'errore precedente da SHOW WARNINGS.
          if (conn.connection && statoNativo.status == null) await query('SHOW COUNT(*) WARNINGS');
          if (Number.isInteger(statoNativo.status)) statoServer = {
            transazione: !!(statoNativo.status & 1) || !(statoNativo.status & 2),
            solaLettura: !!(statoNativo.status & 0x2000),
          };
        }
      } catch (err) {
        avvelenata = true;
        err.sqlTransactionLost = true;
        if (eseguita) throw err;
      } finally {
        if (erroreIstruzione && (avvelenata || (lease.transazione && erroreIstruzione.code === 'ER_LOCK_DEADLOCK') ||
            (transazioneInCorso && Number.isInteger(statoNativo.status) && !(statoNativo.status & 1)))) {
          erroreIstruzione.sqlTransactionLost = true;
        }
        await lease.termina(eseguita, avvelenata, statoServer);
      }
    }
  }

  /**
   * Batch di scritture in una sola transazione. La logica sta in
   * `db/sqlWriteBatch.js`, comune ai due motori SQL; qui resta il dialetto:
   * il `USE <db>` prima della transazione, il tetto di tempo per-query di
   * mysql2 (lato CLIENT: allo scadere il driver smette di aspettare ma il
   * server continua, quindi si manda `KILL QUERY` da un'altra connessione e
   * questa si distrugge invece di restituirla al pool con un result set
   * arretrato in arrivo) e la forma del riepilogo di uno statement.
   */
  async executeWriteBatch(db, statements) {
    const pool = this.requirePool();
    const tetto = DbStrategy.aggregateTimeoutMs(this.env);
    return eseguiBatchScritture(statements, {
      apri: () => pool.getConnection(),
      primaDellaTransazione: (conn) => this.usaDatabase(conn, db),
      begin: (conn) => conn.beginTransaction(),
      commit: (conn) => conn.commit(),
      rollback: (conn) => conn.rollback(),
      esegui: async (conn, sql) => {
        const richiesta = { sql };
        if (tetto > 0) richiesta.timeout = tetto;
        let result;
        try {
          [result] = await conn.query(richiesta);
        } catch (err) {
          if (MySqlStrategy.isDriverTimeout(err)) {
            // La connessione non e' piu' utilizzabile: lo dichiara al motore
            // comune, che salta il ROLLBACK esplicito e registra che ad
            // annullare la transazione e' stata la disconnessione.
            err.connessioneAvvelenata = true;
            await this.uccidiSulServer(conn.threadId);
          }
          throw err;
        }
        const summary = { righeCoinvolte: result ? (result.affectedRows || 0) : 0 };
        if (result && result.insertId) summary.insertId = result.insertId;
        if (result && result.info) summary.info = result.info;
        return summary;
      },
      chiudi: (conn, { avvelenata }) => {
        if (avvelenata) { try { conn.destroy(); } catch (_) {} }
        else conn.release();
      },
    });
  }

  // Riconosce lo scadere del timeout per-query di mysql2: il driver lancia un
  // errore PROPRIO (`PROTOCOL_SEQUENCE_TIMEOUT`, «Query inactivity timeout»),
  // non un errore del server.
  //
  // Il riconoscimento è STRETTO di proposito. Un `/timeout/i` sul messaggio
  // pescherebbe anche `ER_LOCK_WAIT_TIMEOUT` («Lock wait timeout exceeded») e
  // `ER_QUERY_TIMEOUT` («max_execution_time exceeded»), che sono errori del
  // SERVER: lì la connessione è sana e la query è già finita, quindi ucciderla
  // e buttare via la connessione è lavoro inutile, ma soprattutto l'utente si
  // sentirebbe dire «hai superato CODEDB_AGGREGATE_TIMEOUT_MS» mentre il
  // problema era un lock di un'altra transazione — due diagnosi opposte.
  static isDriverTimeout(err) {
    if (!err) return false;
    if (err.code === 'PROTOCOL_SEQUENCE_TIMEOUT') return true;
    return /query inactivity timeout/i.test(err.message || '');
  }

  // KILL QUERY su una SECONDA connessione: quella che sta eseguendo la query è
  // occupata, il comando deve arrivare da un'altra sessione. Uccide la sola
  // istruzione in corso, non la connessione.
  async uccidiSulServer(threadId) {
    const id = Number(threadId);
    if (!Number.isInteger(id) || id <= 0 || !this.pool) return false;
    let altra = null;
    try {
      altra = await this.pool.getConnection();
      await altra.query(`KILL QUERY ${id}`);
      return true;
    } catch (_) {
      return false;
    } finally {
      if (altra) altra.release();
    }
  }

  // Piano di esecuzione: EXPLAIN sulla SELECT costruita da filter/sort correnti
  // (modalità find) o sulla SQL Raw (modalità aggregate). Prova prima
  // EXPLAIN FORMAT=JSON, con ripiego sull'EXPLAIN classico tabellare
  // (versioni vecchie o statement non supportati dal formato JSON).
  async collectionExplain(db, coll, payload) {
    const pool = this.requirePool();
    let sql;
    let parametriPiano = [];
    if (payload.mode === 'aggregate') {
      sql = String(payload.pipeline || '').trim();
      if (!sql) throw new Error('Inserisci una query SQL di cui mostrare il piano.');
      if (splitStatements(sql, { dbms: 'mysql', backslashEscape: true }).length !== 1) {
        throw new Error('Il piano di esecuzione accetta una sola istruzione SQL.');
      }
      const normExplain = require('./sqlText').stripSqlNoise(sql, { dbms: 'mysql', backslashEscape: true }).trim();
      if (/^(?:ANALYZE|EXPLAIN)\b/i.test(normExplain)) {
        throw new Error('EXPLAIN ANALYZE esegue la query: usa l’esecuzione normale anziché il piano di esecuzione.');
      }
    } else {
      // Le stesse colonne che vede `collectionFind`: un piano calcolato su un
      // ORDER BY diverso da quello della query vera spiegherebbe un'altra
      // query. La lettura è in cache (la find l'ha appena fatta), quindi non
      // aggiunge un round trip.
      const { columns: colonne } = await this.tableColumnsInfo(db, coll);
      const ricercaGlobale = await this._preparaRicercaGlobale(db, coll, payload, colonne);
      const { table, whereSql, whereParams, orderSql, limit, skip } =
        this.buildSelect(db, coll, payload, { colonne, ricercaGlobale });
      sql = `SELECT * FROM ${table}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${skip}`;
      // Il piano si calcola sulla query VERA, parametri compresi: un EXPLAIN
      // con i segnaposto senza valori non è la stessa query.
      parametriPiano = whereParams;
    }

    const ms = DbStrategy.queryTimeoutMs(this.env);
    const conTimeout = (testo) => (ms > 0 ? { sql: testo, timeout: ms } : testo);
    const conn = await pool.getConnection();
    let inTx = false;
    let avvelenata = false;
    try {
      await this.usaDatabase(conn, db);
      await conn.query('START TRANSACTION READ ONLY');
      inTx = true;
      try {
        const [rows] = await conn.query(conTimeout(`EXPLAIN FORMAT=JSON ${sql}`), parametriPiano);
        const raw = rows && rows[0] && (rows[0].EXPLAIN || rows[0][Object.keys(rows[0])[0]]);
        return { format: 'json', plan: JSON.parse(String(raw)), query: sql };
      } catch (err) {
        if (MySqlStrategy.isDriverTimeout(err)) {
          avvelenata = true;
          await this.uccidiSulServer(conn.threadId);
          throw err;
        }
        // Ripiego: EXPLAIN classico in forma tabellare.
        try {
          const [rows, fields] = await conn.query(conTimeout(`EXPLAIN ${sql}`), parametriPiano);
          if (!Array.isArray(rows)) throw err;
          const columns = (fields || []).map((f) => f.name);
          return { format: 'table', rows: rows.map((r) => serializeRow(r, fields || [])), columns, query: sql };
        } catch (fallbackErr) {
          if (MySqlStrategy.isDriverTimeout(fallbackErr)) {
            avvelenata = true;
            await this.uccidiSulServer(conn.threadId);
          }
          throw fallbackErr;
        }
      }
    } finally {
      if (inTx && !avvelenata) await conn.query('ROLLBACK').catch(() => {});
      if (avvelenata) conn.destroy?.();
      else conn.release();
    }
  }

  async docInsert(db, coll, payload) {
    const pool = this.requirePool();
    const fields = await this.tableFields(db, coll);
    const doc = await require('./insertValues').parseSqlInsert(payload.doc, fields);
    const cols = Object.keys(doc);
    const table = qtable(db, coll);
    const { geo } = await this.tableColumnsInfo(db, coll);
    const bind = cols.map(c => MySqlStrategy.geoBinding(c, doc[c], geo, { importazione: true }));
    const sql = cols.length
      ? `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES (${bind.map(b => b.sql).join(', ')})`
      : `INSERT INTO ${table} () VALUES ()`;
    const conn = await pool.getConnection();
    let mode;
    let restored = false;
    try {
      const [[session]] = await conn.query('SELECT @@SESSION.sql_mode AS mode');
      mode = session.mode;
      const strict = [...new Set([...String(mode).split(',').filter(Boolean), 'STRICT_ALL_TABLES', 'NO_AUTO_VALUE_ON_ZERO'])].join(',');
      await conn.query('SET SESSION sql_mode = ?', [strict]);
      // I parametri binari restano byte e NO_BACKSLASH_ESCAPES non cambia la quotatura.
      const [res] = await conn.execute(sql, bind.map(b => b.param));
      return { insertedId: JSON.stringify(res.insertId ?? null) };
    } finally {
      if (mode != null) {
        try { await conn.query('SET SESSION sql_mode = ?', [mode]); restored = true; }
        catch { /* una sessione non ripristinata non torna al pool */ }
      }
      if (restored) conn.release(); else conn.destroy();
    }
  }

  async docUpdate(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const set = deserializeClientObject(payload.set);
    const assignments = [];
    const params = [];
    let info;
    try { info = await this.tableColumnsInfo(db, coll); }
    catch (err) { throw new Error(ERRORE_SRID, { cause: err }); }
    return modificaConSrid({ pool, mysql: true, info, set, table: qtable(db, coll), where, qid }, async (conn, geo) => {

      for (const [col, val] of Object.entries(set)) {
        const b = MySqlStrategy.geoBinding(col, val, geo);
        assignments.push(`${qid(col)} = ${b.sql}`);
        params.push(b.param);
      }
      for (const col of payload.unset || []) {
        assignments.push(`${qid(col)} = NULL`);
      }
      if (!assignments.length) throw new Error('Nessuna modifica da applicare.');
      const [res] = await conn.query(
        `UPDATE ${qtable(db, coll)} SET ${assignments.join(', ')} WHERE ${where.sql} LIMIT 1`,
        [...params, ...where.params]
      );
      return { matched: res.affectedRows, modified: res.changedRows != null ? res.changedRows : res.affectedRows };
    });
  }

  async docReplace(db, coll, payload) {
    const pool = this.requirePool();
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    documentoScrivibile(doc, (await this.tableColumnsInfo(db, coll)).columns);
    // In SQL "sostituire" la riga equivale ad aggiornare tutte le colonne note.
    return this.docUpdate(db, coll, { id: payload.id, set: EJSON.serialize(doc, { relaxed: false }) });
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

  /**
   * Cancellazione in blocco secondo il filtro MOSTRATO.
   *
   * Il filtro deve essere lo STESSO che ha prodotto le righe a schermo, in
   * qualunque forma sia arrivato: se la griglia sta filtrando in modalità
   * rapida — dove il testo è una parola da cercare e non una clausola — e qui
   * si usasse il solo `filter`, quella parola verrebbe interpretata come una
   * WHERE. Nel migliore dei casi è un errore di sintassi; nel peggiore è una
   * cancellazione che non corrisponde a ciò che l'utente vedeva.
   *
   * Si riusa quindi `buildSelect`, che è già il posto in cui le due forme di
   * filtro diventano una clausola sola, parametri compresi.
   */
  async collectionDeleteMany(db, coll, payload) {
    const pool = this.requirePool();
    // Senza filtro svuota la tabella (come deleteMany({}) su MongoDB):
    // la conferma rafforzata è responsabilità del frontend.
    const { columns: colonne } = await this.tableColumnsInfo(db, coll);
    const ricercaGlobale = await this._preparaRicercaGlobale(db, coll, payload, colonne);
    const { table, whereSql, whereParams } = this.buildSelect(db, coll, payload, { colonne, ricercaGlobale });
    const [res] = await pool.query(`DELETE FROM ${table}${whereSql}`, whereParams);
    return { deleted: res.affectedRows };
  }

  // Valore di cella per l'export CSV: date in ISO, BLOB in base64,
  // oggetti/array come JSON; quoting RFC 4180 dove serve.
  static csvCell(v) {
    return cellaCsv(v);
  }

}

// I metodi comuni ai due motori SQL (chiave primaria, informazioni sulle
// colonne, elenco dei campi, indici unici, paginazione a chiave, conteggio)
// arrivano dal modulo già legati al dialetto MySQL; catalogo/DDL, trasferimento
// massivo e monitor delle sessioni vivono nei rispettivi sottosistemi dedicati.
installaMetadati(MySqlStrategy.prototype, DIALETTO_METADATI);
installaCatalogoMysql(MySqlStrategy.prototype);
installaTrasferimentoMysql(MySqlStrategy.prototype);
installaSessioniMysql(MySqlStrategy.prototype);

MySqlStrategy.scegliCollazione = scegliCollazione;
MySqlStrategy.columnSql = columnSql;
MySqlStrategy.defaultSql = defaultSql;
MySqlStrategy.columnAlterSql = columnAlterSqlStatica;

module.exports = MySqlStrategy;

