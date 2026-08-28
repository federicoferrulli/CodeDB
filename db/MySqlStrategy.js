'use strict';

const mysql = require('mysql2');
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');
const { splitStatements } = require('./sqlText');
const { tabellare } = require('./sqlTabellare');
// Metadati comuni ai due motori SQL (chiave primaria, colonne, campi, indici
// unici, keyset, conteggio): la logica sta nel modulo, qui resta il dialetto.
const { installaMetadati } = require('./sqlMetadati');
// Conversione EJSON <-> parametri SQL: è il protocollo del client, non il
// dialetto del server, quindi vive in un modulo solo (vedi db/sqlValori.js).
const { toSqlValue, parseClientValue, deserializeClientObject, serializeRow } = require('./sqlValori');
const { raggruppaVincoli } = require('./relazioni');
const { cellaCsv, rigaCsv } = require('./csv');
// Come si scrive il nome di una tabella o di una colonna: regola unica,
// condivisa con l'altro adattatore SQL, con il DDL, con il backup e col
// frontend (vedi db/identificatori.js).
const { quotaSempre, quotaQualificato } = require('./identificatori');
const {
  isSqlGeometryType, isGeoJson, assertGeoJson, parseGeoJsonText, daFormaDriverMysql,
} = require('./geometry');
const sessioni = require('./sessioni');
const { randomUUID } = require('crypto');
const {
  normalizzaRicerca, catalogoDaDocumenti, aggiornaCacheCatalogo, catalogoValido,
  clausolaMySql, tipoJsonMySql, separaCataloghiJson,
} = require('./ricercaGlobale');
const {
  pianificaDuplicazione, calcolaNuovoValore, documentoSorgente, applicaRicalcolo, valoreSemplice,
} = require('./duplica');

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

// Identificatore quotato (` `), con eventuale punto trattato come carattere.
// La regola non è di questo file: sta in `db/identificatori.js` insieme a
// quella degli altri motori, perché è la stessa decisione presa ovunque si
// scriva il nome di una tabella o di una colonna.
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

// Il dialetto MySQL delle quattro funzioni comuni ai due motori SQL: tutto il
// resto (che cosa è un _id, come si normalizza un limite) sta nel modulo.
// Come MySQL scrive la regola «il valore nullo è il più piccolo»: con niente.
// Il suo ordinamento predefinito colloca già i NULL come i più piccoli, quindi
// un suffisso sarebbe rumore — e MySQL non ha nemmeno la sintassi NULLS
// FIRST/LAST. Che la coincidenza regga è provato contro un MySQL vero da
// test/e2e-nulli-ordinati.js: senza quella prova la regola qui si reggerebbe su
// una coincidenza che nessuno sorveglia.
const nulliPrima = () => '';

// `testoDi`: come si confronta una colonna COME TESTO. Su MySQL non serve
// nulla — la conversione e' implicita, e un CAST esplicito sposterebbe la
// collation del confronto (vedi la nota sull'errore 1267 in testa al file).
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
      // mysql2 di norma decodifica JSON, ma `jsonStrings` e alcuni fork lo
      // restituiscono come testo. Decodificarlo qui evita di catalogare l'intero
      // documento come un solo valore (che farebbe coincidere anche le chiavi).
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
  // Il livello "database" dell'interfaccia è un database MySQL vero.
  schema: (db) => String(db == null ? '' : db),
  // mysql2 restituisce [righe, campi].
  esegui: async (strategia, sql, params) => (await strategia.requirePool().query(sql, params))[0],

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
      // `IS_NULLABLE` viaggia con le colonne che si leggevano già: sapere quali
      // colonne ammettono NULL non costa una lettura di catalogo in più (serve a
      // chi compone l'ORDER BY, vedi buildOrderBy).
      sql: `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_TYPE AS declaredType,
                   ${srid} AS srid, EXTRA AS extra,
                   IS_NULLABLE AS nullable
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
      params: [db, coll],
    })),
    // Le colonne INVISIBLE (MySQL 8) non fanno parte di `SELECT *`: vanno
    // escluse anche dalla lista esplicita, altrimenti la sola presenza di una
    // colonna geometrica farebbe comparire nella griglia colonne che prima non
    // c'erano.
    visibile: (r) => !/\bINVISIBLE\b/i.test(String(r.extra || '')),
    // `EXTRA` porta gia' anche questo: una colonna VIRTUAL/STORED GENERATED.
    generato: (r) => /GENERATED/i.test(String(r.extra || '')),
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
    // Colonna calcolata (VIRTUAL/STORED GENERATED): il valore lo fa il
    // database e un INSERT che la nomina viene rifiutato.
    generato: (c) => /GENERATED/i.test(String(c.extra || '')),
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
    // TABLE_ROWS è affidabile solo per le tabelle base InnoDB/MyISAM ed è NULL
    // per le viste: in tal caso il chiamante ripiega sul COUNT(*) esatto.
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
  // Il nome è quotato, il tipo NON può esserlo (deve arrivare al motore come
  // sintassi): l'unica difesa è pretendere che abbia la forma di un tipo, o
  // `INT, RENAME TO altra_tabella` in un CHANGE COLUMN porta la tabella fuori
  // dallo scope di chi ha la sola capability `ddl`. Vedi DbStrategy.
  DbStrategy.assertColumnType(type);
  let s = `${qid(name)} ${type}`;
  if (c.nullable === false) s += ' NOT NULL';
  if (c.default != null && String(c.default).trim() !== '') s += ` DEFAULT ${defaultSql(c.default)}`;
  // La visibilità (MySQL 8.0.23+) va DOPO il default e PRIMA di
  // AUTO_INCREMENT: è l'ordine imposto dalla grammatica di column_definition,
  // non una preferenza. Fuori posto, l'ALTER viene rifiutato dal parser.
  if (c.invisible) s += ' INVISIBLE';
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  return s;
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
  constructor() {
    super();
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

  /* -------------------------------------------------------------------------
   * Geometrie (vedi db/geometry.js per il perché del formato unico GeoJSON)
   * ---------------------------------------------------------------------- */

  // Lista di selezione: `*` quando non ci sono geometrie (nessun costo per il
  // 99% delle tabelle), altrimenti le colonne per nome con ST_AsGeoJSON su
  // quelle geometriche — l'alias conserva il nome originale, quindi il resto
  // della pipeline (colonne, _id, griglia) non si accorge di nulla.
  async selectListFor(db, coll, infoPrecaricate = null) {
    const info = infoPrecaricate || await this.tableColumnsInfo(db, coll);
    if (!info.geo.size) return { list: '*', geo: info.geo, colonne: info.columns };
    const list = info.columns
      .map((c) => (info.geo.has(c.name) ? `ST_AsGeoJSON(${qid(c.name)}) AS ${qid(c.name)}` : qid(c.name)))
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

  // Frammento SQL + parametro per scrivere una geometria. Il SRID va SEMPRE
  // imposto, anche quando la colonna non ne dichiara uno.
  //
  // `ST_GeomFromGeoJSON` produce SRID 4326, e in 4326 MySQL usa l'ordine degli
  // assi latitudine-longitudine: lasciato cosi', un poligono `(0 0, 1 0, 1 1)`
  // veniva riletto come `(0 0, 0 1, 1 1)` — le coordinate SCAMBIATE, cioe' una
  // geometria diversa scritta senza che nulla lo segnalasse. Su una colonna che
  // dichiara un SRID il valore veniva gia' riportato a quello giusto; su una
  // colonna che non lo dichiara — il caso predefinito, `SRS_ID` NULL — si
  // saltava `ST_SRID` e restava il 4326 con i suoi assi invertiti. Una colonna
  // senza SRS dichiarato contiene geometrie cartesiane, il cui SRID e' 0: e'
  // quello che va imposto, non il 4326 che il parser sceglie per conto suo.
  static geoPlaceholder(colInfo) {
    if (!colInfo || colInfo.srid == null) {
      throw new Error('SRID non noto: CodeDB non può modificare la geometria senza reinterpretare le coordinate. Dichiara lo SRID della colonna oppure consenti la lettura dei metadata di information_schema.');
    }
    const srid = Number(colInfo.srid);
    return `ST_SRID(ST_GeomFromGeoJSON(?), ${srid})`;
  }

  // Valore di scrittura per una colonna: le geometriche prendono il frammento
  // ST_GeomFromGeoJSON, tutte le altre un normale segnaposto.
  static geoBinding(col, value, geo) {
    const colInfo = geo && geo.get(col);
    if (colInfo) {
      // I file esportati prima della correzione portano la forma grezza del
      // driver (`{ x, y }` per un punto) invece del GeoJSON: si recupera,
      // invece di chiedere all'utente di rifare l'export.
      const geoJson = isGeoJson(value) ? value : daFormaDriverMysql(value);
      if (geoJson) {
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
      const c = await this.countWithTimeout(table, whereSql, whereParams);
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
      return serializeRow(doc, sel.colonne);
    });
    const columnMeta = Object.fromEntries(sel.colonne.map((c) => [c.name, {
      type: c.declaredType || c.type, nullable: c.nullable, srid: c.srid,
    }]));
    return { docs, columns, columnMeta, total, skip, limit, keyset: !!ks, truncated: capped.truncated || undefined };
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
    const ms = DbStrategy.countTimeoutMs();
    const q = { sql: `SELECT COUNT(*) AS total FROM ${table}${whereSql}` };
    if (ms > 0) q.timeout = ms;
    try {
      const [[{ total }]] = await pool.query(q, whereParams);
      return { total: Number(total), timedOut: false };
    } catch (err) {
      if (err && (err.code === 'PROTOCOL_SEQUENCE_TIMEOUT' || /timeout/i.test(err.message || ''))) {
        return { total: null, timedOut: true };
      }
      throw err;
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
  // Il valore viene ora da `DbStrategy.aggregateTimeoutMs()`, la stessa fonte
  // (env CODEDB_AGGREGATE_TIMEOUT_MS) che governa il tetto delle aggregazioni
  // su MongoDB; <= 0 disattiva il limite.
  async collectionAggregate(db, _coll, payload) {
    const pool = this.requirePool();
    const sql = String(payload.pipeline || '').trim();
    if (!sql) throw new Error('Inserisci una query SQL da eseguire.');
    const readOnly = !!payload.readOnly || !!payload.expectRead;
    const tetto = DbStrategy.aggregateTimeoutMs();
    const richiesta = { sql };
    if (tetto > 0) richiesta.timeout = tetto;
    const conn = await pool.getConnection();
    // Il timeout di mysql2 è lato CLIENT: allo scadere il driver smette di
    // aspettare, ma il server continua a eseguire e il result set arriverà
    // comunque, fuori sincrono con la richiesta successiva. Una connessione
    // così non può tornare al pool: va uccisa la query sul server e distrutta
    // la connessione.
    let avvelenata = false;
    try {
      if (payload && payload.opHandle) {
        try {
          const [[row]] = await conn.query('SELECT CONNECTION_ID() AS cid');
          if (row && row.cid) payload.opHandle.connectionId = row.cid;
        } catch (_) {}
      }
      await this.usaDatabase(conn, db);
      if (readOnly) await conn.query('START TRANSACTION READ ONLY');
      try {
        const cap = DbStrategy.resultCap(payload);
        let result, fields;
        try {
          [result, fields] = await conn.query(richiesta);
        } catch (err) {
          if (!MySqlStrategy.isDriverTimeout(err)) throw err;
          avvelenata = true;
          await this.uccidiSulServer(conn.threadId);
          // L'errore del driver risale così com'è: a tradurlo in italiano
          // (causa + rimedio, citando il limite configurato) è `spiegaErrore`,
          // che è l'unico posto dove quel testo deve vivere.
          throw err;
        }

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
              return { docs: rows.map(serializeRow), columns, total: selectRes.length, skip: 0, limit: cap, resultSet: true };
            }

            // Soltanto statement di scrittura/DDL (INSERT, UPDATE, CREATE, ecc.)
            const summary = { istruzioniEseguite: statementCount, righeCoinvolteTotali: totalAffected };
            return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap };
          }

          // Singola SELECT
          const rows = result.slice(0, cap);
          const columns = (fields || []).map((f) => f.name);
          return { docs: rows.map(serializeRow), columns, total: result.length, skip: 0, limit: cap, resultSet: true };
        }

        // Statement senza result set (UPDATE, DELETE, DDL...): riepilogo.
        const summary = { righeCoinvolte: result ? (result.affectedRows || 0) : 0 };
        if (result && result.insertId) summary.insertId = result.insertId;
        if (result && result.info) summary.info = result.info;
        return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap };
      } finally {
        // Su una connessione avvelenata non si parla più: il ROLLBACK finirebbe
        // per leggere il result set arretrato della query uccisa.
        if (readOnly && !avvelenata) await conn.query('ROLLBACK').catch(() => {});
      }
    } finally {
      if (avvelenata) { try { conn.destroy(); } catch (_) {} }
      else conn.release();
    }
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
      // ORDER BY … LIMIT sposta ordinamento e troncamento sul server, così la
      // riga che interessa non è mai fra quelle scartate dal tetto.
      //
      // Il solo `TIME DESC` non bastava, e sbagliava nel verso peggiore: in
      // PROCESSLIST `TIME` è il tempo trascorso nello STATO CORRENTE, che per un
      // thread `Sleep` è da quanto è inattivo. Su un server con centinaia di
      // connessioni applicative aperte da ore le prime 500 righe erano tutte
      // `Sleep`, e la query che gira da quaranta secondi — l'unica ragione per
      // cui questo pannello viene aperto — cadeva oltre il tetto: non compariva
      // in tabella e non entrava in `diagnosi()`, che rispondeva «nessuna query
      // lenta». Un verdetto falso, non incompleto. Le sessioni che stanno
      // facendo qualcosa vengono quindi prima, e solo dentro quei due gruppi
      // conta la durata.
      const [rows] = await conn.query(
        `SELECT p.ID, p.USER, p.HOST, p.DB, p.COMMAND, p.TIME, p.STATE, p.INFO,
                t.THREAD_ID AS STABLE_ID
           FROM information_schema.PROCESSLIST p
           LEFT JOIN performance_schema.threads t ON t.PROCESSLIST_ID = p.ID
          ORDER BY (p.COMMAND <> 'Sleep') DESC, p.TIME DESC
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

  async killSession(id, modo, identitaOsservata) {
    const pool = this.requirePool();
    // L'id arriva dal client: va usato come NUMERO in un comando che non
    // ammette parametri preparati (`KILL` non li accetta), quindi se non è un
    // intero non si costruisce alcuna stringa SQL con esso.
    const num = Number(String(id).trim());
    if (!Number.isInteger(num) || num <= 0) throw new Error(`Id di sessione non valido: "${id}".`);
    const conn = await pool.getConnection();
    try {
      const [correnti] = await conn.query(
        'SELECT THREAD_ID AS STABLE_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = ?',
        [num]
      );
      const corrente = correnti[0] && `mysql-thread:${correnti[0].STABLE_ID}`;
      sessioni.assertIdentitaSessione(identitaOsservata, corrente);
      await conn.query(modo === 'connessione' ? `KILL CONNECTION ${num}` : `KILL QUERY ${num}`);
      return { terminata: true, modo: modo === 'connessione' ? 'connessione' : 'query' };
    } finally {
      conn.release();
    }
  }

  async cancelQuery(opHandle) {
    if (!opHandle || !opHandle.connectionId || !this.pool) return { cancelled: false };
    return { cancelled: await this.uccidiSulServer(opHandle.connectionId) };
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
      if (splitStatements(sql, { backslashEscape: true }).length !== 1) {
        throw new Error('Il piano di esecuzione accetta una sola istruzione SQL.');
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

    const conn = await pool.getConnection();
    try {
      await this.usaDatabase(conn, db);
      try {
        const [rows] = await conn.query(`EXPLAIN FORMAT=JSON ${sql}`, parametriPiano);
        const raw = rows && rows[0] && (rows[0].EXPLAIN || rows[0][Object.keys(rows[0])[0]]);
        return { format: 'json', plan: JSON.parse(String(raw)), query: sql };
      } catch (err) {
        // Ripiego: EXPLAIN classico in forma tabellare.
        const [rows, fields] = await conn.query(`EXPLAIN ${sql}`, parametriPiano);
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
    // `TABLE_ROWS` viaggia con lo schema perche' il grafo deve poter nascondere
    // le tabelle VUOTE, e senza un conteggio quella decisione non e'
    // esprimibile: il filtro cadeva su `fields.length === 0`, cioe' sulle
    // tabelle senza COLONNE, che in SQL non esistono. E' una stima InnoDB —
    // ricavata dai campionamenti dell'indice, non un `COUNT(*)`, che su un
    // centinaio di tabelle sarebbe una scansione ciascuna — quindi il
    // chiamante la tratta come tale: si nasconde solo cio' che la stima
    // dichiara a zero, mai cio' che non sa (`null`).
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
        presence: row.IS_NULLABLE === 'YES' ? 0 : 100, // coerente con PostgreSqlStrategy
      });
    }

    const collections = tables.map((t) => ({
      name: t.TABLE_NAME,
      fields: colsByTable.get(t.TABLE_NAME) || [],
      rowsApprox: t.TABLE_ROWS == null ? null : Number(t.TABLE_ROWS),
    }));

    const [fkRows] = await pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA,
              REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
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
        toDb: fk.REFERENCED_TABLE_SCHEMA || db,
        external: !!fk.REFERENCED_TABLE_SCHEMA && fk.REFERENCED_TABLE_SCHEMA !== db,
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

  // Chiavi esterne uscenti dalla sola tabella indicata (pannello di riferimento
  // della griglia). Si legge REFERENCED_TABLE_SCHEMA e non lo si dà per uguale a
  // `db`: in MySQL una FK può attraversare i database, e assumendo lo schema di
  // partenza il pannello interrogherebbe una tabella omonima sbagliata — o
  // inesistente, che è il caso fortunato perché almeno si vede.
  async columnRelations(db, coll) {
    const pool = this.requirePool();
    const [rows] = await pool.query(
      `SELECT CONSTRAINT_NAME, ORDINAL_POSITION, COLUMN_NAME,
              REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [db, coll]
    );
    return raggruppaVincoli(rows.map((r) => ({
      nome: r.CONSTRAINT_NAME,
      ordine: r.ORDINAL_POSITION,
      campo: r.COLUMN_NAME,
      db: r.REFERENCED_TABLE_SCHEMA || db,
      tabella: r.REFERENCED_TABLE_NAME,
      colonna: r.REFERENCED_COLUMN_NAME,
    })));
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
    // Il formato JSON e' anche il trasporto dell'export di un intero database:
    // le geometrie devono uscire nella lingua comune GeoJSON, non nella
    // rappresentazione privata del driver (un POINT diventerebbe `{ x, y }`,
    // che all'import MySQL rifiuta con «Cannot get geometry object»). E' la
    // stessa scelta gia' fatta su PostgreSQL: qui mancava e basta.
    const primaPagina = !payload.after && !(Number(payload.skip) > 0);
    const metadati = format === 'json'
      ? await this.metadatiEsportazione(db, coll, primaPagina)
      : null;
    const selezione = metadati ? await this.selectListFor(db, coll, metadati.info) : null;
    const selectList = selezione ? selezione.list : '*';

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
        `SELECT ${selectList} FROM ${table}${whereSql} ORDER BY ${pkCols} LIMIT ?`,
        [...params, limit]
      );
      if (rows.length) {
        const last = rows[rows.length - 1];
        nextAfter = EJSON.stringify(pk.map((c) => last[c]), { relaxed: true });
      }
    } else {
      const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
      [rows, fields] = await pool.query(
        `SELECT ${selectList} FROM ${table} LIMIT ? OFFSET ?`, [limit, skip]);
    }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    let columns = (fields || []).map((f) => f.name);

    if (format === 'json') {
      // Le geometriche tornano come TESTO GeoJSON: qui diventano oggetti, la
      // stessa forma che la griglia riceve e che l'import sa riscrivere.
      MySqlStrategy.geoRowsToJson(rows, selezione ? selezione.geo : null);
      // Una colonna GENERATA non si puo' nominare in un INSERT: esportarla
      // rendeva il file non reimportabile riga per riga. Il suo valore lo
      // ricalcola il database dalla definizione, che viaggia nel DDL.
      const scrivibili = metadati.scrivibili;
      const generate = columns.filter((c) => !scrivibili.has(c));
      if (generate.length) {
        for (const row of rows) for (const c of generate) delete row[c];
        columns = columns.filter((c) => scrivibili.has(c));
      }
    }

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
      lines = rows.map((r) => rigaCsv(columns.map((c) => r[c]), { modalita: payload.csvMode }));
    }
    return {
      lines,
      count: rows.length,
      total: Number(total),
      format,
      header: format === 'csv' ? rigaCsv(columns, { modalita: payload.csvMode }) : null,
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
    const conflictColumns = Array.isArray(payload.conflictColumns)
      ? payload.conflictColumns.filter((c) => typeof c === 'string' && c)
      : [];
    if (payload.upsert && !conflictColumns.length) {
      throw new Error(`Upsert rifiutato per "${coll}": il piano non dichiara un'identita stabile.`);
    }

    // Geometrie e colonne scrivibili si leggono dal catalogo della tabella di
    // DESTINAZIONE: e' lei a dire come va scritto un valore, non il file.
    let geo = new Map();
    let scrivibili = new Set();
    try {
      const info = await this.tableColumnsInfo(db, coll);
      geo = info.geo || geo;
      scrivibili = await this.colonneScrivibili(db, coll);
    } catch { /* metadati non leggibili: vale il comportamento storico */ }

    const parsed = [];
    for (let i = 0; i < raw.length; i++) {
      try {
        const row = EJSON.deserialize(raw[i], { relaxed: true });
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error('la riga deve essere un oggetto { "colonna": valore }');
        }
        // Una colonna GENERATA arriva dai file esportati dalle versioni che la
        // scrivevano: nominarla in un INSERT e' un errore, e farebbe fallire
        // OGNI riga. Si scarta qui, cosi' i file gia' prodotti restano
        // importabili invece di richiedere un nuovo export.
        for (const nome of Object.keys(row)) {
          if (scrivibili.size && !scrivibili.has(nome)) delete row[nome];
        }
        const cols = Object.keys(row);
        if (!cols.length) throw new Error('riga vuota');
        // I valori NON vengono piu' convertiti qui: `geoBinding` decide per
        // ciascuna colonna se serve un segnaposto normale o
        // ST_GeomFromGeoJSON, ed e' lui a chiamare `toSqlValue`.
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
      return ` ON DUPLICATE KEY UPDATE ${assegnazioni.join(', ')}`;
    };

    // Una tupla per riga con i suoi parametri: le colonne geometriche prendono
    // ST_GeomFromGeoJSON col SRID della colonna (la stessa via di docInsert),
    // le altre un segnaposto. Prima si usava `VALUES ?` con la lista dei
    // valori, che per una geometria manda al server l'oggetto GeoJSON grezzo:
    // MySQL risponde «Cannot get geometry object» su OGNI riga.
    const inserimento = (cols, righe) => {
      const params = [];
      const tuple = righe.map((r) => {
        const ph = r.values.map((valore, indice) => {
          const bind = MySqlStrategy.geoBinding(cols[indice], valore, geo);
          params.push(bind.param);
          return bind.sql;
        });
        return `(${ph.join(', ')})`;
      });
      return {
        sql: `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES ${tuple.join(', ')}${coda(cols)}`,
        params,
      };
    };

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
        const q = inserimento(g.cols, g.rows);
        await pool.query(q.sql, q.params);
        // affectedRows vale 2 per una riga aggiornata da ON DUPLICATE KEY:
        // il conteggio applicato misura righe sorgente, non effetti interni.
        inserted += g.rows.length;
      } catch {
        // Un vincolo violato da una sola riga fa fallire tutto il batch:
        // si ripete riga per riga per isolare quale e non perdere le altre.
        for (const r of g.rows) {
          try {
            const q = inserimento(g.cols, [r]);
            await pool.query(q.sql, q.params);
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
    this._cacheColonne.clear();
  }

  async dropCollection(db, coll) {
    const pool = this.requirePool();
    await pool.query(`DROP TABLE ${qtable(db, coll)}`);
    this._cacheColonne.clear();
  }

  async addColumn(db, coll, column) {
    const pool = this.requirePool();
    await pool.query(`ALTER TABLE ${qtable(db, coll)} ADD COLUMN ${columnSql(column || {})}`);
    this._cacheColonne.clear(); // i metadati di colonna in cache non valgono più
  }

  // payload: { oldName, column: { name, type, nullable, default } }
  async alterColumn(db, coll, payload) {
    const pool = this.requirePool();
    const oldName = String((payload && payload.oldName) || '').trim();
    if (!oldName) throw new Error('Nome della colonna da modificare mancante.');
    const [rows] = await pool.query(
      `SELECT EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression,
              COLUMN_COMMENT AS comment, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [db, coll, oldName]
    );
    const originale = rows[0];
    if (!originale) throw new Error(`Colonna ${oldName} non trovata.`);
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
    // AUTO_INCREMENT è metadato autorevole del server: un client vecchio o un
    // form incompleto non deve rimuoverlo accidentalmente.
    column.autoIncrement = /auto_increment/i.test(extra);
    // Idem per la visibilità (MySQL 8.0.23+): senza conservarla, modificare il
    // tipo di una colonna nascosta la rendeva visibile — cioè la faceva
    // ricomparire in tutte le `SELECT *` delle applicazioni che la usano.
    column.invisible = /\bINVISIBLE\b/i.test(extra);
    let definizione = columnSql(column);
    const tipoTestuale = /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(String(column.type || '').trim());
    if (tipoTestuale && originale.charset) definizione += ` CHARACTER SET ${qid(originale.charset)}`;
    if (tipoTestuale && originale.collation) definizione += ` COLLATE ${qid(originale.collation)}`;
    const onUpdate = extra.match(/on update CURRENT_TIMESTAMP(?:\(\d+\))?/i);
    if (onUpdate) definizione += ` ${onUpdate[0].toUpperCase()}`;
    if (originale.comment) definizione += ` COMMENT ${mysql.escape(String(originale.comment))}`;
    await pool.query(
      `ALTER TABLE ${qtable(db, coll)} CHANGE COLUMN ${qid(oldName)} ${definizione}`
    );
    this._cacheColonne.clear();
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

  /**
   * Documento pronto da inserire come duplicato della riga ricevuta: chiavi
   * risolte secondo la modalità (vedi db/duplica.js), valori nuovi calcolati
   * qui perché solo il database sa qual è il MAX e cosa è già occupato.
   */
  async duplicatePlan(db, coll, payload) {
    const pool = this.requirePool();
    const doc = documentoSorgente(payload.doc);
    const fields = await this.tableFields(db, coll);
    if (!fields.length) throw new Error(`Tabella "${coll}" non trovata in "${db}".`);
    const colonne = fields.map((f) => ({
      name: f.name,
      tipo: f.types[0],
      pk: f.key === 'PRI',
      nullable: f.nullable,
      generabile: f.autoIncrement,
      generata: f.generated,
    }));
    const piano = pianificaDuplicazione({
      doc,
      colonne,
      uniche: await this.uniqueIndexes(db, coll),
      conChiavi: payload.conChiavi === true,
      idVirtuale: !fields.some((f) => f.name === '_id'),
    });

    const table = qtable(db, coll);
    for (const nome of piano.ricalcola) {
      const col = colonne.find((c) => c.name === nome);
      const nuovo = await calcolaNuovoValore({
        tipo: col.tipo,
        originale: valoreSemplice(doc[nome]),
        massimo: async () => {
          const [[r]] = await pool.query(`SELECT MAX(${qid(nome)}) AS m FROM ${table}`);
          return r ? r.m : null;
        },
        esiste: async (v) => {
          const [rows] = await pool.query(`SELECT 1 FROM ${table} WHERE ${qid(nome)} = ? LIMIT 1`, [v]);
          return rows.length > 0;
        },
        uuid: () => randomUUID(),
      });
      applicaRicalcolo(piano, nome, nuovo, { pk: col.pk, etichetta: col.tipo });
    }
    return { doc: JSON.stringify(piano.doc), note: piano.note, azioni: piano.azioni };
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

// I metodi comuni ai due motori SQL (chiave primaria, informazioni sulle
// colonne, elenco dei campi, indici unici, paginazione a chiave, conteggio)
// arrivano dal modulo già legati al dialetto MySQL dichiarato in testa: non
// sono più scritti qui, e non possono più divergere da quelli di PostgreSQL.
installaMetadati(MySqlStrategy.prototype, DIALETTO_METADATI);

MySqlStrategy.scegliCollazione = scegliCollazione;

module.exports = MySqlStrategy;
