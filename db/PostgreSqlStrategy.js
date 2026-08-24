'use strict';

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
// Come si scrive il nome di una tabella o di una colonna: regola unica,
// condivisa con l'altro adattatore SQL, con il DDL, con il backup e col
// frontend (vedi db/identificatori.js).
const { quotaSempre, quotaQualificato } = require('./identificatori');
const { isPostgresGeometryType, isPostgresNativeGeometryType, isGeoJson, assertGeoJson, parseGeoJsonText } = require('./geometry');
const { pgNativoAGeoJson, geoJsonAPgNativo } = require('./pg-geo-nativo');
const sessioni = require('./sessioni');
const { randomUUID } = require('crypto');
const { normalizzaRicerca, clausolaPostgres } = require('./ricercaGlobale');
const {
  pianificaDuplicazione, calcolaNuovoValore, documentoSorgente, applicaRicalcolo, valoreSemplice,
} = require('./duplica');

// Tipi (`udt_name`) su cui ha senso cercare con ILIKE nel pannello di
// riferimento: vedi relatedRows. Fuori restano numeri, date e binari, dove la
// ricerca testuale costa una conversione riga per riga e non risponde comunque
// alla domanda posta.
const TESTUALI_PG = new Set(['varchar', 'text', 'bpchar', 'char', 'name', 'citext', 'json', 'jsonb', 'uuid']);

// Schemi che CodeDB non deve mai mostrare ne' modificare. Il livello
// "database" dell'interfaccia corrisponde allo SCHEMA (vedi la nota su qtable),
// quindi la protezione riguarda gli schemi di sistema, non i database.
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast']);

function isSystemSchema(name) {
  const n = String(name || '').trim().toLowerCase();
  return SYSTEM_SCHEMAS.has(n) || n.startsWith('pg_');
}

/* ---------------------------------------------------------------------------
 * Helpers PostgreSQL
 * ------------------------------------------------------------------------- */

function assertDbName(name) {
  if (!name || /[\r\n]/.test(name) || name.length > 63) {
    throw new Error(`Nome di database non valido: "${name}"`);
  }
}

// Identificatore quotato ("), gestendo eventuali virgolette interne. La regola
// non e' di questo file: sta in `db/identificatori.js` insieme a quella degli
// altri motori, perche' e' la stessa decisione presa ovunque si scriva il nome
// di una tabella o di una colonna.
function qid(name) {
  return quotaSempre(name, 'postgresql');
}

// Schema usato quando il chiamante non ne indica uno (client storici, percorsi
// che non passano dalla sidebar). `public` è lo schema di default di PostgreSQL.
const DEFAULT_SCHEMA = 'public';

// Nome di schema valido, normalizzato. Il livello "database" dell'interfaccia
// corrisponde allo SCHEMA PostgreSQL: vedi la nota in testa alla classe.
function schemaOf(db) {
  const s = String(db == null ? '' : db).trim();
  return s || DEFAULT_SCHEMA;
}

// Tabella SEMPRE qualificata con lo schema. Prima `qtable` scartava il primo
// argomento e restituiva il solo nome della tabella: la risoluzione veniva
// lasciata al search_path, quindi con tabelle omonime in schemi diversi si
// leggeva e si SCRIVEVA su quella sbagliata, e lo scope dei permessi (che
// autorizza sul `db` passato) non aveva alcun effetto reale.
function qtable(db, table) {
  return quotaQualificato([schemaOf(db), table], 'postgresql');
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

// Il dialetto PostgreSQL delle quattro funzioni comuni ai due motori SQL:
// tutto il resto (che cosa è un _id, come si normalizza un limite) sta nel
// modulo.
// Come PostgreSQL scrive la regola «il valore nullo e' il piu' piccolo»: con
// un suffisso esplicito, perche' il suo predefinito e' l'opposto (i NULL sono i
// piu' GRANDI). In salita vanno quindi in cima, in discesa in fondo.
//
// Il prezzo: l'indice btree colloca i nulli in fondo, quindi chiedere l'ordine
// opposto lo rende inservibile per l'ordinamento — su 200.000 righe con indice,
// una pagina di griglia passa da 0,042 ms (Index Scan) a 6,508 ms (Seq Scan +
// Sort). Si paga perche' ogni alternativa sposta lo stesso costo su un altro
// motore senza toglierlo, e si paga SOLO dove i nulli possono esistere: sulle
// colonne NOT NULL il suffisso viene omesso (vedi serveSuffissoNulli).
const nulliPrima = (discendente) => (discendente ? ' NULLS LAST' : ' NULLS FIRST');

// `testoDi`: su PostgreSQL `intero LIKE testo` non esiste come operatore e la
// query FALLISCE invece di non trovare nulla. Il cast a testo e' quindi
// obbligatorio perche' la ricerca rapida funzioni su una colonna qualunque.
const TABELLARE = tabellare({
  qid, qtable, whereFromId, nulliPrima, segnaposto: (n) => `$${n}`, testoDi: (col) => `${col}::text`,
});

function preparaRicercaGlobale(_strategy, _db, _coll, payload, colonne) {
  const valore = normalizzaRicerca(payload && payload.cercaOvunque);
  if (!valore) return null;
  return (da) => clausolaPostgres(valore, colonne, qid, (n) => `$${n}`, da);
}

/* ---------------------------------------------------------------------------
 * Il dialetto PostgreSQL dei metadati comuni (db/sqlMetadati.js).
 *
 * Qui c'è solo ciò che di PostgreSQL c'è davvero: le query al catalogo, come se
 * ne leggono le righe e il segnaposto numerato dei parametri. Le decisioni —
 * quando una stima vale, che cosa è un indice unico, come si compone la pagina
 * a chiave — stanno nel modulo, in una copia sola.
 * ------------------------------------------------------------------------- */
const DIALETTO_METADATI = {
  qid,
  segnaposto: (n) => `$${n}`,
  // Il livello "database" dell'interfaccia è lo SCHEMA (vedi la nota su qtable).
  schema: schemaOf,
  esegui: async (strategia, sql, params) => (await strategia.requirePool().query(sql, params)).rows,

  chiavePrimaria: {
    // Filtro sullo schema: senza, una tabella OMONIMA in un altro schema poteva
    // fornire la chiave primaria, e da lì l'`_id` virtuale sbagliato — cioè
    // modifiche ed eliminazioni sulla riga sbagliata.
    query: (db, table) => ({
      sql: `SELECT kcu.column_name AS name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
             WHERE tc.constraint_type = 'PRIMARY KEY'
               AND tc.table_schema = $2
               AND tc.table_name = $1
          ORDER BY kcu.ordinal_position`,
      params: [table, schemaOf(db)],
    }),
  },

  colonne: {
    tentativi: (db, coll) => [{
      // `is_nullable` viaggia con le colonne che si leggevano gia': nessuna
      // lettura di catalogo in piu' (serve a chi compone l'ORDER BY).
      sql: `SELECT column_name AS name, udt_name AS type, is_nullable AS nullable
              FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
      params: [schemaOf(db), coll],
    }],
    classi: [
      // L'ordine conta: un tipo geometrico NATIVO (point, polygon, box...) non
      // è una geometria PostGIS e non si legge con ST_AsGeoJSON, ma la griglia
      // e l'editor su mappa devono poterlo leggere e scrivere lo stesso (vedi
      // db/pg-geo-nativo.js).
      { nome: 'geo', riconosce: isPostgresGeometryType },
      { nome: 'geoNativo', riconosce: isPostgresNativeGeometryType },
    ],
    // Il SRID sta in `geometry_columns`/`geography_columns` (viste PostGIS): se
    // PostGIS non è installato quelle viste non esistono e si prosegue senza —
    // `udt_name` non sarà mai 'geometry', quindi non cambia nulla.
    arricchisci: async (strategia, info, db, coll) => {
      if (!info.geo.size) return;
      try {
        const srid = await strategia.requirePool().query(
          `SELECT f_geometry_column AS name, srid, 'geometry' AS kind
             FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2
            UNION ALL
           SELECT f_geography_column AS name, srid, 'geography' AS kind
             FROM geography_columns WHERE f_table_schema = $1 AND f_table_name = $2`,
          [schemaOf(db), coll]
        );
        for (const r of srid.rows) {
          const c = info.geo.get(r.name);
          if (c) { c.srid = r.srid == null ? null : Number(r.srid); c.kind = r.kind; }
        }
      } catch {
        // Viste PostGIS assenti o non leggibili: si scrive senza forzare il
        // SRID (ST_GeomFromGeoJSON produce 4326, il default di gran lunga più
        // comune) invece di far fallire l'intera lettura.
      }
    },
  },

  campi: {
    query: (db, table) => ({
      // format_type conserva i modificatori che information_schema.data_type
      // perde (varchar(80), numeric(12,2), timestamp(3), array). Senza, salvare
      // soltanto la nullabilità cambiava anche il tipo della colonna.
      sql: `SELECT c.column_name AS name,
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS ctype,
                   c.is_nullable AS nullable,
                   c.column_default AS cdefault,
                   c.is_identity AS identity,
                   c.is_generated AS generated
              FROM information_schema.columns c
              JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema
              JOIN pg_catalog.pg_class t ON t.relnamespace = n.oid AND t.relname = c.table_name
              JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
                                            AND a.attname = c.column_name
                                            AND a.attnum > 0
                                            AND NOT a.attisdropped
             WHERE c.table_schema = $2 AND c.table_name = $1
          ORDER BY c.ordinal_position`,
      params: [table, schemaOf(db)],
    }),
    tipo: (c) => String(c.ctype || 'varchar'),
    // `serial` (nextval) e `GENERATED … AS IDENTITY` sono la stessa promessa:
    // se la colonna non viene scritta, il database produce un valore nuovo.
    autoIncrement: (c) => /nextval/i.test(String(c.cdefault || '')) || String(c.identity || '') === 'YES',
    // Colonna calcolata (GENERATED ALWAYS AS … STORED): nominarla in un INSERT
    // è un errore, il valore lo fa il database.
    generato: (c) => String(c.generated || '') === 'ALWAYS',
    // information_schema.columns non dice se la colonna è nella chiave
    // primaria: serve la lettura a parte, che il modulo fa in parallelo.
    chiaveDallaPrimaria: true,
    chiave: (c, pkSet) => (pkSet.has(c.name) ? 'PRI' : ''),
  },

  indici: {
    // `pg_index.indkey` elenca gli attributi nell'ordine dell'indice; gli
    // indici su espressione hanno attnum 0 e restano senza colonna (non sono
    // una chiave su cui si possa ragionare per la duplicazione).
    query: (db, table) => ({
      sql: `SELECT i.relname AS name, ix.indisunique AS unico, ix.indisprimary AS primaria,
                   a.attname AS colonna, k.ord
              FROM pg_catalog.pg_class t
              JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
              JOIN pg_catalog.pg_index ix ON ix.indrelid = t.oid
              JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
              JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
              LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
             WHERE n.nspname = $2 AND t.relname = $1
          ORDER BY i.relname, k.ord`,
      params: [table, schemaOf(db)],
    }),
    lettori: {
      nome: (r) => r.name,
      colonna: (r) => r.colonna,
      ordine: (r) => r.ord,
      unico: (r) => r.unico,
      primario: (r) => r.primaria,
    },
  },

  stima: {
    // `reltuples` è aggiornata da ANALYZE/autovacuum; vale -1 se la tabella non
    // è mai stata analizzata (PG >= 14). Vincolata allo SCHEMA della tabella
    // mostrata, non al search_path: con tabelle omonime la stima poteva venire
    // da un'altra tabella.
    query: (db, coll) => ({
      sql: `SELECT c.reltuples::bigint AS n
              FROM pg_class c
              JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
             WHERE c.relname = $1
               AND c.relkind = 'r'
               AND nsp.nspname = $2
             LIMIT 1`,
      params: [coll, schemaOf(db)],
    }),
    attendibile: (n) => n >= 0,
  },
};

// Tipo seriale equivalente, per colonna con default `nextval(...)`. I nomi a
// sinistra sono quelli che restituisce `format_type`, non gli alias SQL.
const SERIAL_PER_TIPO = {
  smallint: 'smallserial',
  integer: 'serial',
  bigint: 'bigserial',
};

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
  // Qui le DDL passano dal simple query protocol (`pool.query` senza
  // parametri), che esegue tutto ciò che è separato da `;`: un tipo non
  // validato era esecuzione di SQL arbitrario. Vedi DbStrategy.assertColumnType.
  DbStrategy.assertColumnType(type);

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
 *
 * MODELLO: il livello "database" dell'interfaccia = SCHEMA PostgreSQL
 *
 * Il pool `pg` è legato a `cfg.database` e non può cambiarlo a runtime: dentro
 * una connessione l'unico spazio di nomi navigabile sono gli schemi. Prima la
 * sidebar elencava invece i database del CLUSTER, ma `qtable()` scartava il
 * primo argomento e `listCollections()` ignorava il suo: si vedevano i nomi di
 * database che non si potevano aprire, sotto ognuno comparivano le tabelle di
 * tutti gli schemi del database connesso, e ogni operazione finiva sulla
 * tabella risolta dal `search_path`. Con tabelle omonime in schemi diversi
 * questo significava leggere, MODIFICARE ed ELIMINARE la riga sbagliata; e lo
 * scope dei permessi, che autorizza sul `db` ricevuto, non aveva effetto reale.
 *
 * Da qui in avanti il primo argomento `db` di ogni metodo è il NOME DELLO
 * SCHEMA: `qtable()` qualifica sempre, le query sui cataloghi filtrano su
 * `table_schema`, e create/rename/drop del "database" sono CREATE/ALTER/DROP
 * SCHEMA. Per SQL Raw (`collectionAggregate`) il `search_path` viene allineato
 * allo schema aperto, così i nomi non qualificati scritti dall'utente si
 * risolvono dove se li aspetta.
 *
 * Conseguenza sui backup preesistenti: i manifest scritti prima di questa
 * modifica hanno `db` = nome del DATABASE. `backup/lib/restore.js` continua a
 * interpretarli come prima quando il manifest non dichiara uno `schema`.
 * ------------------------------------------------------------------------- */

class PostgreSqlStrategy extends DbStrategy {
  constructor() {
    super();
    this.pool = null;
    this._config = null;
    // Metadati di colonna (tipo + SRID delle geometriche) per schema.tabella:
    // servono a ogni find, quindi vanno in cache breve. Vedi tableColumnsInfo.
    this._cacheColonne = new Map();
    this._preparaRicercaGlobale = (db, coll, payload, colonne) =>
      preparaRicercaGlobale(this, db, coll, payload, colonne);
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
      max: 8,
      // Compare in `pg_stat_activity.application_name` e nei log del server:
      // è così che il monitor delle sessioni riconosce le connessioni di
      // CodeDB e non offre di terminarle (vedi db/sessioni.js).
      application_name: sessioni.APP_NAME,
    });

    pool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]', err ? err.message : err);
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

  async health() {
    const pool = this.requirePool();
    const t0 = Date.now();
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - t0;
    // Il Pool di `pg` espone contatori pubblici: totali/idle/in coda.
    const limit = (pool.options && pool.options.max != null) ? pool.options.max : null;
    const total = pool.totalCount != null ? pool.totalCount : null;
    const idle = pool.idleCount != null ? pool.idleCount : null;
    return {
      latencyMs,
      pool: {
        limit,
        total,
        idle,
        active: (total != null && idle != null) ? total - idle : null,
        waiting: pool.waitingCount != null ? pool.waitingCount : null,
      },
    };
  }

  async listDatabases() {
    const pool = this.requirePool();
    // Il livello "database" della UI sono gli SCHEMI del database connesso.
    // Elencare i database del cluster era fuorviante: il pool `pg` e' legato a
    // cfg.database e non puo' cambiarlo, quindi aprendo un altro database si
    // vedevano comunque le tabelle di quello connesso e ogni operazione finiva
    // sull'omonima risolta dal search_path (o falliva).
    const res = await pool.query(
      `SELECT n.nspname AS name,
              COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS size
         FROM pg_namespace n
         LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','p','m')
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_%'
     GROUP BY n.nspname
     ORDER BY n.nspname`
    );
    return res.rows.map((r) => ({ name: r.name, sizeOnDisk: Number(r.size) || 0 }));
  }

  async createDatabase(db, firstColl) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    // Vedi la nota in MySqlStrategy: vale solo per i nomi creati da CodeDB.
    DbStrategy.assertCreatableName(name, 'dello schema');
    try {
      await pool.query(`CREATE SCHEMA ${qid(name)}`);
    } catch (err) {
      if (err && err.code === '42P06') throw new Error(`Lo schema "${name}" esiste già.`);
      throw err;
    }

    // La prima tabella si crea sulla STESSA connessione: prima serviva un client
    // separato verso il nuovo database, e la tabella finiva in un database che
    // poi la sessione non poteva piu' raggiungere.
    const table = String(firstColl || '').trim();
    if (table) {
      DbStrategy.assertCreatableName(table, 'della tabella');
      await pool.query(`CREATE TABLE ${qid(name)}.${qid(table)} (id SERIAL PRIMARY KEY)`);
    }
  }

  // Il livello "database" della UI è uno SCHEMA PostgreSQL, e ALTER SCHEMA
  // RENAME è atomico e istantaneo: nessun dump/restore necessario.
  supportsNativeRename() { return true; }

  async renameDatabase(db, newName) {
    const pool = this.requirePool();
    const from = String(db || '').trim();
    const to = String(newName || '').trim();
    assertDbName(from);
    assertDbName(to);
    DbStrategy.assertCreatableName(to, 'del database');
    if (from === to) throw new Error('Il nuovo nome coincide con quello attuale.');
    if (isSystemSchema(from)) {
      throw new Error(`Lo schema di sistema "${from}" non può essere rinominato.`);
    }
    try {
      await pool.query(`ALTER SCHEMA ${qid(from)} RENAME TO ${qid(to)}`);
    } catch (err) {
      if (err && err.code === '42P06') throw new Error(`Lo schema "${to}" esiste già.`);
      throw err;
    }
  }

  async dropDatabase(db) {
    const pool = this.requirePool();
    const name = String(db || '').trim();
    assertDbName(name);
    if (isSystemSchema(name)) {
      throw new Error(`Lo schema di sistema "${name}" non può essere eliminato.`);
    }
    // CASCADE: elimina anche le tabelle contenute, coerentemente con la
    // semantica dell'operazione nell'interfaccia ("elimina il database e TUTTI
    // i suoi dati", gia' confermata esplicitamente dall'utente).
    await pool.query(`DROP SCHEMA ${qid(name)} CASCADE`);
  }

  async listCollections(db) {
    const pool = this.requirePool();
    // Filtrata sullo schema richiesto: prima l'argomento veniva ignorato e sotto
    // OGNI voce della sidebar comparivano le tabelle di tutti gli schemi.
    const res = await pool.query(
      // Il join su pg_class passa per pg_namespace, altrimenti `relname` da solo
      // aggancia le tabelle OMONIME di tutti gli schemi: la stessa tabella
      // compariva più volte nella sidebar e il conteggio righe poteva arrivare
      // da un'altra tabella. Prima non si notava perché la query restituiva
      // comunque le tabelle di ogni schema.
      `SELECT t.table_name AS name, t.table_type AS ttype, COALESCE(c.reltuples::bigint, 0) AS cnt
         FROM information_schema.tables t
    LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
    LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
        WHERE t.table_schema = $1
     ORDER BY t.table_name`,
      [schemaOf(db)]
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
      SELECT table_schema AS db, table_name AS coll
        FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND (LOWER(table_schema) LIKE $1 OR LOWER(table_name) LIKE $1)
    `;
    const res = await pool.query(sql, [term]);
    const dbs = new Map();
    for (const r of res.rows) {
      if (!dbs.has(r.db)) dbs.set(r.db, []);
      dbs.get(r.db).push({ name: r.coll });
    }
    return Array.from(dbs.entries()).map(([name, collections]) => ({ name, collections }));
  }

  // Le quattro funzioni del tabellare (identificatore di riga, sua lettura,
  // ordinamento, pezzi della SELECT) non hanno nulla di PostgreSQL: stanno in
  // db/sqlTabellare.js, legate qui al solo dialetto. Vedi il commento in testa
  // a quel modulo.
  makeId(row, pkCols, allCols) {
    return TABELLARE.makeId(row, pkCols, allCols);
  }

  /* -------------------------------------------------------------------------
   * Geometrie PostGIS (vedi db/geometry.js per il perché del formato GeoJSON)
   * ---------------------------------------------------------------------- */

  /**
   * Toglie dal documento la chiave `_id` SOLO se è quella virtuale (CDB-41).
   *
   * Su SQL `_id` è un identificatore sintetico costruito da CodeDB a partire
   * dalla chiave primaria, quindi va scartato prima di scrivere. Ma nulla
   * impedisce a una tabella di avere una colonna davvero chiamata `_id` — è
   * anzi comune nelle tabelle migrate da MongoDB — e lì la `delete`
   * incondizionata buttava via un valore dell'utente in silenzio: la riga
   * veniva inserita con quel campo vuoto, senza errori.
   */
  async rimuoviIdVirtuale(db, coll, doc) {
    if (!doc || !Object.prototype.hasOwnProperty.call(doc, '_id')) return doc;
    try {
      const { columns } = await this.tableColumnsInfo(db, coll);
      if (columns.some((c) => c.name === '_id')) return doc; // colonna vera: si conserva
    } catch { /* metadati non leggibili: si ricade sul comportamento storico */ }
    delete doc._id;
    return doc;
  }

  // `*` quando non ci sono geometrie; altrimenti colonne esplicite con
  // ST_AsGeoJSON su quelle geometriche (l'alias conserva il nome). Senza,
  // il driver `pg` restituirebbe il WKB esadecimale, inutilizzabile.
  async selectListFor(db, coll) {
    const info = await this.tableColumnsInfo(db, coll);
    if (!info.geo.size && !info.geoNativo.size) {
      return { list: '*', geo: info.geo, geoNativo: info.geoNativo, colonne: info.columns };
    }
    const list = info.columns
      .map((c) => {
        if (info.geo.has(c.name)) return `ST_AsGeoJSON(${qid(c.name)}) AS ${qid(c.name)}`;
        // I tipi nativi il driver li consegna come oggetti ({x, y}) che non
        // distinguono un lseg da un path: il TESTO di PostgreSQL invece è
        // completo e traducibile in GeoJSON.
        if (info.geoNativo.has(c.name)) return `${qid(c.name)}::text AS ${qid(c.name)}`;
        return qid(c.name);
      })
      .join(', ');
    // `colonne` viaggia con la lista: sono gli STESSI descrittori appena
    // letti, quindi chi compone l'ORDER BY non deve rileggere il catalogo.
    return { list, geo: info.geo, geoNativo: info.geoNativo, colonne: info.columns };
  }

  static geoRowsToJson(rows, geo, geoNativo) {
    if (geo && geo.size) {
      for (const row of rows) {
        for (const col of geo.keys()) {
          if (col in row) row[col] = parseGeoJsonText(row[col]);
        }
      }
    }
    if (geoNativo && geoNativo.size) {
      for (const row of rows) {
        for (const [col, info] of geoNativo) {
          if (col in row) row[col] = pgNativoAGeoJson(info.type, row[col]);
        }
      }
    }
    return rows;
  }

  // Frammento SQL per scrivere una geometria: il SRID della colonna va imposto
  // (ST_GeomFromGeoJSON produce sempre 4326) e le colonne `geography` vogliono
  // il cast esplicito, altrimenti PostgreSQL rifiuta l'assegnazione.
  static geoExpression(colInfo, placeholder) {
    const base = colInfo && colInfo.srid != null
      ? `ST_SetSRID(ST_GeomFromGeoJSON(${placeholder}), ${Number(colInfo.srid)})`
      : `ST_GeomFromGeoJSON(${placeholder})`;
    return (colInfo && colInfo.kind === 'geography') ? `${base}::geography` : base;
  }

  // Espressione + parametro per una colonna in scrittura.
  static geoBinding(col, value, geo, placeholder, geoNativo) {
    const colInfo = geo && geo.get(col);
    if (colInfo && isGeoJson(value)) {
      assertGeoJson(value, `Colonna "${col}"`);
      return { sql: PostgreSqlStrategy.geoExpression(colInfo, placeholder), param: JSON.stringify(value) };
    }
    // Tipo nativo: l'editor manda GeoJSON, PostgreSQL vuole il proprio
    // letterale — "(12.5,41.9)" e non {"type":"Point",...}. Senza questa
    // conversione l'inserimento falliva con "invalid input syntax for type
    // point" (CDB-A88).
    const nativo = geoNativo && geoNativo.get(col);
    if (nativo && value != null) {
      if (isGeoJson(value)) assertGeoJson(value, `Colonna "${col}"`);
      return { sql: placeholder, param: geoJsonAPgNativo(nativo.type, value) };
    }
    return { sql: placeholder, param: toSqlValue(value) };
  }

  /**
   * Condizione WHERE che colpisce UNA SOLA riga.
   *
   * Quando la tabella non ha chiave primaria, `makeId` ripiega sull'intera riga:
   * l'`_id` virtuale non identifica più una riga ma un VALORE, e su una tabella
   * con righe duplicate un UPDATE o un DELETE dalla griglia le colpiva TUTTE —
   * mentre MySqlStrategy, sullo stesso percorso, aggiunge `LIMIT 1`.
   * PostgreSQL non ammette `LIMIT` in UPDATE/DELETE, ma ha il `ctid`, che
   * identifica fisicamente la riga: si seleziona il primo ctid che corrisponde
   * e si agisce solo su quello.
   */
  async bersaglioRiga(db, coll, whereSql) {
    const pk = await this.primaryKey(db, coll);
    if (pk.length) return whereSql; // la chiave primaria è già univoca
    return `ctid = (SELECT ctid FROM ${qtable(db, coll)} WHERE ${whereSql} LIMIT 1)`;
  }

  parseRowId(rawId) {
    return TABELLARE.parseRowId(rawId);
  }

  /**
   * L'ORDER BY della griglia e della tab ⚡. `opzioni.colonne` sono i
   * descrittori della tabella su cui si ordina (nome, tipo, nullabilita'):
   * arrivano gia' letti da `collectionFind`, quindi conoscerli non costa una
   * lettura di catalogo in piu'. Un motore che debba ordinare diversamente
   * sovrascrive QUESTO metodo, ed e' ascoltato da tutti i percorsi.
   */
  buildOrderBy(text, opzioni) {
    return TABELLARE.buildOrderBy(text, opzioni);
  }

  buildSelect(db, coll, payload, opzioni = {}) {
    // `ordinamento` chiude sul metodo di QUESTA istanza: e' cio' che rende
    // efficace una sovrascrittura di `buildOrderBy` anche per la griglia.
    return TABELLARE.buildSelect(db, coll, payload, {
      ...opzioni,
      ordinamento: (testo) => this.buildOrderBy(testo, opzioni),
    });
  }

  async collectionFind(db, coll, payload) {
    const pool = this.requirePool();
    // Due letture di catalogo indipendenti: in parallelo costano un round trip
    // invece di due, su ogni pagina della griglia.
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
    // Geometrie lette come GeoJSON: vedi selectListFor.
    const { list: selectList, geo, geoNativo } = sel;
    const ks = this.buildKeyset(payload, table, whereSql, limit, pk, selectList, whereParams);
    // Su PostgreSQL il numero del segnaposto è la POSIZIONE reale del
    // parametro: se il filtro strutturato ne ha già occupati due, il limite
    // è $3 e il salto $4. Lasciarli fissi a $1 e $2 farebbe leggere il
    // limite al posto del filtro — in silenzio, con un risultato plausibile.
    const nFiltro = whereParams.length;
    const sql = ks ? ks.sql
      : `SELECT ${selectList} FROM ${table}${whereSql}${orderSql} LIMIT $${nFiltro + 1} OFFSET $${nFiltro + 2}`;
    const params = ks ? ks.params : [...whereParams, limit, skip];
    const ms = DbStrategy.queryTimeoutMs();
    const opHandle = payload && payload.opHandle;

    // Se la richiesta ha un opHandle (griglia con runId) o un timeout attivo,
    // usiamo una connessione dedicata: catturiamo il PID di backend (annullabile
    // via pg_cancel_backend, sola lettura) e impostiamo statement_timeout con
    // SET LOCAL in transazione, così una find lenta degrada con errore invece di
    // occupare la connessione all'infinito.
    let res;
    if (opHandle || ms > 0) {
      const client = await pool.connect();
      try {
        if (opHandle && client.processID) opHandle.processID = client.processID;
        await client.query('BEGIN READ ONLY');
        if (ms > 0) await client.query(`SET LOCAL statement_timeout = ${ms}`);
        res = await client.query(sql, params);
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    } else {
      res = await pool.query(sql, params);
    }
    // Keyset "indietro": la query gira in ordine pk DESC, qui si riordina ASC.
    let rows = res.rows;
    if (ks && ks.reverse) rows = rows.slice().reverse();
    PostgreSqlStrategy.geoRowsToJson(rows, geo, geoNativo);

    // COUNT(*) su tabelle enormi è una scansione: bloccherebbe la griglia. Il
    // client della UI passa `deferCount` e chiede il totale a parte via
    // `collection:count`; senza il flag (MCP, test) lo calcoliamo inline ma con
    // un timeout così non può bloccarsi all'infinito.
    let total = null;
    if (!payload.deferCount) {
      const c = await this.countWithTimeout(table, whereSql, whereParams);
      total = c.total;
    }

    const columns = res.fields ? res.fields.map((f) => f.name) : [];
    // Budget di byte: vedi la nota corrispondente in MySqlStrategy.
    const capped = DbStrategy.truncateBySize(rows);
    const docs = capped.rows.map((r) => {
      const doc = { ...r, _id: this.makeId(r, pk, columns) };
      return serializeRow(doc);
    });

    return { docs, columns, total, skip, limit, keyset: !!ks, truncated: capped.truncated || undefined };
  }

  // COUNT(*) con statement_timeout: dentro una transazione con SET LOCAL così il
  // timeout si azzera da solo a fine transazione. Ritorna { total, timedOut }:
  // total è null se il conteggio è stato annullato per timeout (SQLSTATE 57014).
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (ms > 0) await client.query(`SET LOCAL statement_timeout = ${ms}`);
      const r = await client.query(`SELECT COUNT(*) AS total FROM ${table}${whereSql}`, whereParams);
      await client.query('COMMIT');
      return { total: Number(r.rows[0]?.total) || 0, timedOut: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err && err.code === '57014') return { total: null, timedOut: true };
      throw err;
    } finally {
      client.release();
    }
  }

  // Lettura con timeout per-query, dentro una transazione READ ONLY: una query
  // lenta degrada con errore invece di tenere occupata una connessione del pool.
  // È il ramo "senza opHandle" di collectionFind estratto per riuso — qui non
  // c'è un runId da annullare, sono letture brevi avviate da un pannello.
  async queryConTimeout(sql, params) {
    const pool = this.requirePool();
    const ms = DbStrategy.queryTimeoutMs();
    if (ms <= 0) return pool.query(sql, params);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${ms}`);
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async collectionAggregate(db, _coll, payload) {
    const pool = this.requirePool();
    const sql = String(payload.pipeline || '').trim();
    if (!sql) throw new Error('Inserisci una query SQL da eseguire.');
    // `readOnly`: richiesto esplicitamente (tool MCP di sola lettura).
    // `expectRead`: la query e' stata CLASSIFICATA come lettura e chi la esegue
    // e' un sottoutente (vedi guardStrategy). E' la barriera che non dipende dal
    // parser: se la classificazione sbaglia, e' il motore a rifiutare la
    // scrittura invece di lasciarla passare come "lettura".
    const readOnly = !!payload.readOnly || !!payload.expectRead;
    // TETTO DI TEMPO — su ENTRAMBI i rami, non solo in lettura. Prima
    // il limite valeva solo dentro la transazione READ ONLY, come costante
    // `30000` scritta qui dentro: una scrittura sbagliata teneva una
    // connessione del pool senza limite. Il valore viene ora dalla stessa fonte
    // configurabile degli altri tetti dell'interfaccia
    // (`DbStrategy.aggregateTimeoutMs`, env CODEDB_AGGREGATE_TIMEOUT_MS);
    // <= 0 disattiva il limite.
    const ms = DbStrategy.aggregateTimeoutMs();
    const client = await pool.connect();
    // SQL Raw: la query la scrive l'utente, quindi puo' qualificare gli schemi
    // come vuole. I nomi NON qualificati devono pero' risolversi nello schema
    // che sta guardando, non in quello che capita dal search_path del server.
    // `SET LOCAL` dentro la transazione, `RESET` fuori: la connessione torna
    // sempre pulita al pool.
    const schema = schemaOf(db);
    let pathSet = false;
    let timeoutSet = false;
    let readTxOpen = false;
    try {
      if (payload && payload.opHandle && client.processID) {
        payload.opHandle.processID = client.processID;
      }
      if (readOnly) {
        await client.query('BEGIN READ ONLY');
        // Segnare la transazione subito dopo BEGIN: anche un errore nel primo
        // SET LOCAL deve fare ROLLBACK prima di restituire il client al pool.
        readTxOpen = true;
        if (ms > 0) await client.query(`SET LOCAL statement_timeout = ${ms}`);
        // Un solo schema: aggiungere `public` come ripiego farebbe risolvere
        // un nome non qualificato fuori dal database/schema autorizzato quando
        // la tabella non esiste nello schema selezionato.
        await client.query(`SET LOCAL search_path TO ${qid(schema)}`);
      } else {
        await client.query(`SET search_path TO ${qid(schema)}`);
        pathSet = true;
        // Fuori da una transazione non c'è `SET LOCAL`: il valore resta sulla
        // connessione, quindi va riazzerato nel `finally` come il search_path,
        // altrimenti lo eredita chi prende questo client dal pool.
        if (ms > 0) {
          await client.query(`SET statement_timeout = ${ms}`);
          timeoutSet = true;
        }
      }
      try {
        const cap = DbStrategy.resultCap(payload);
        const res = await client.query(sql);
        if (Array.isArray(res)) {
          const lastRes = res[res.length - 1];
          const rows = (lastRes.rows || []).slice(0, cap);
          const columns = lastRes.fields ? lastRes.fields.map((f) => f.name) : [];
          return { docs: rows.map(serializeRow), columns, total: rows.length, skip: 0, limit: cap, resultSet: true };
        }
        if (res.rows && (res.rows.length > 0 || res.fields)) {
          const rows = res.rows.slice(0, cap);
          const columns = res.fields ? res.fields.map((f) => f.name) : [];
          return { docs: rows.map(serializeRow), columns, total: res.rows.length, skip: 0, limit: cap, resultSet: true };
        }

        const summary = { comando: res.command, righeCoinvolte: res.rowCount || 0 };
        return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap };
      } finally {
        if (readTxOpen) {
          await client.query('ROLLBACK').catch(() => {});
          readTxOpen = false;
        }
        if (pathSet) await client.query('RESET search_path').catch(() => {});
        if (timeoutSet) await client.query('RESET statement_timeout').catch(() => {});
      }
    } finally {
      // Rete di sicurezza per errori avvenuti durante i SET LOCAL, prima di
      // entrare nel blocco che esegue la query. Un client con una transazione
      // READ ONLY rimasta aperta avvelenerebbe la richiesta successiva del pool.
      if (readTxOpen) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  /* --- Monitor delle sessioni ---------------------------------------------
   * `pg_stat_activity`. Due cose che nessuno degli altri due DBMS ha e che
   * vanno conservate fino all'interfaccia: `backend_type` separa i processi di
   * servizio (autovacuum, checkpointer, walwriter) dai client veri, e lo stato
   * `idle in transaction` — fermo, invisibile fra le query lente, e con i lock
   * ancora in mano — che è quasi sempre la risposta a "perché è tutto bloccato
   * se non sta girando niente".
   * ---------------------------------------------------------------------- */
  async listSessions() {
    const pool = this.requirePool();
    const { rows } = await pool.query(
      `SELECT pid,
              usename,
              client_addr::text AS client_addr,
              client_port,
              datname,
              state,
              query,
              wait_event_type,
              wait_event,
              backend_type,
              application_name,
              -- Il dato che rende il pannello una risposta invece di un
              -- elenco: chi tiene il lock che questa sessione sta aspettando.
              -- Senza, si termina la vittima e non cambia niente.
              --
              -- Si chiama SOLO sulle righe che stanno davvero aspettando un
              -- lock pesante, che è l'unico caso in cui può restituire
              -- qualcosa: la funzione prende per un istante l'accesso
              -- esclusivo allo stato condiviso del lock manager, e la
              -- documentazione avverte di non chiamarla di frequente. Su un
              -- server con cinquecento sessioni erano cinquecento prese ogni
              -- cinque secondi — proprio mentre il database è in difficoltà,
              -- cioè quando questo pannello è aperto. Il risultato non cambia:
              -- un backend in attesa di un lock pesante ha per definizione
              -- wait_event_type = 'Lock'.
              CASE WHEN wait_event_type = 'Lock' THEN pg_blocking_pids(pid) END AS blocking,
              EXTRACT(EPOCH FROM (now() - COALESCE(
                CASE WHEN state = 'active' THEN query_start ELSE state_change END,
                backend_start))) AS secondi
         FROM pg_stat_activity
        ORDER BY secondi DESC NULLS LAST
        LIMIT $1`,
      [sessioni.MAX_SESSIONI + 1]
    );

    // Senza il ruolo `pg_monitor`/`pg_read_all_stats` (o la superutenza) le
    // righe altrui ci sono ma il testo della query è sostituito da
    // "<insufficient privilege>": la tabella sembra completa mentre la
    // colonna che serve è vuota, quindi lo si dice.
    const nascoste = rows.some((r) => String(r.query || '').includes('insufficient privilege'));
    const nota = nascoste
      ? 'Il testo delle query degli altri utenti non è visibile: serve il ruolo "pg_monitor" (o "pg_read_all_stats") sull\'utente della connessione.'
      : null;

    const troncato = rows.length > sessioni.MAX_SESSIONI;
    const usate = rows.slice(0, sessioni.MAX_SESSIONI);
    const coppie = [];
    for (const r of usate) {
      for (const b of (Array.isArray(r.blocking) ? r.blocking : [])) coppie.push({ attesa: r.pid, blocca: b });
    }
    const lista = sessioni.ordina(sessioni.collegaBlocchi(
      sessioni.normalizzaPostgres(usate, { processIDs: this.processIDsDelPool() }),
      coppie
    ));
    return {
      sessioni: lista,
      capacita: { annullaQuery: true, terminaConnessione: true, saBloccanti: true },
      troncato,
      nota,
    };
  }

  /**
   * PID dei backend del NOSTRO pool. Come per mysql2 non c'è un'API pubblica:
   * si legge `_clients` in modo difensivo. È il secondo dei due segnali usati
   * per riconoscere le connessioni di CodeDB — l'altro, `application_name`,
   * copre anche le connessioni di un'ALTRA istanza di CodeDB, che questo non
   * vedrebbe.
   */
  processIDsDelPool() {
    const ids = [];
    try {
      for (const c of (this.pool && this.pool._clients) || []) {
        if (c && c.processID != null) ids.push(c.processID);
      }
    } catch { /* internals non disponibili */ }
    return ids;
  }

  async killSession(id, modo) {
    const pool = this.requirePool();
    const pid = Number(String(id).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Id di sessione non valido: "${id}".`);
    // `pg_terminate_backend` chiude la connessione (la transazione in corso
    // viene annullata dal server); `pg_cancel_backend` ferma la sola query e
    // lascia in piedi sessione e transazione.
    const fn = modo === 'connessione' ? 'pg_terminate_backend' : 'pg_cancel_backend';
    const res = await pool.query(`SELECT ${fn}($1) AS esito`, [pid]);
    const esito = !!(res.rows && res.rows[0] && res.rows[0].esito);
    return { terminata: esito, modo: modo === 'connessione' ? 'connessione' : 'query' };
  }

  async cancelQuery(opHandle) {
    if (!opHandle || !opHandle.processID || !this.pool) return { cancelled: false };
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT pg_cancel_backend($1) AS cancelled', [opHandle.processID]);
      const cancelled = !!(res.rows && res.rows[0] && res.rows[0].cancelled);
      return { cancelled };
    } catch (err) {
      return { cancelled: false };
    } finally {
      client.release();
    }
  }

  async collectionExplain(db, coll, payload) {
    const pool = this.requirePool();
    let sql;
    let parametriPiano = [];
    if (payload.mode === 'aggregate') {
      sql = String(payload.pipeline || '').trim();
      if (!sql) throw new Error('Inserisci una query SQL di cui mostrare il piano.');
      if (splitStatements(sql).length !== 1) {
        throw new Error('Il piano di esecuzione accetta una sola istruzione SQL.');
      }
    } else {
      // Le stesse colonne che vede `collectionFind`: un piano calcolato su un
      // ORDER BY diverso da quello della query vera spiegherebbe un'altra
      // query. La lettura e' in cache (la find l'ha appena fatta), quindi non
      // aggiunge un round trip.
      const { columns: colonne } = await this.tableColumnsInfo(db, coll);
      const ricercaGlobale = await this._preparaRicercaGlobale(db, coll, payload, colonne);
      const { table, whereSql, whereParams, orderSql, limit, skip } =
        this.buildSelect(db, coll, payload, { colonne, ricercaGlobale });
      sql = `SELECT * FROM ${table}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${skip}`;
      // Il piano si calcola sulla query VERA, parametri compresi.
      parametriPiano = whereParams;
    }

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN READ ONLY');
      transactionOpen = true;
      await client.query('SET LOCAL statement_timeout = 30000');
      await client.query(`SET LOCAL search_path TO ${qid(schemaOf(db))}`);
      const res = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, parametriPiano);
      const plan = res.rows[0]['QUERY PLAN'] || res.rows[0][Object.keys(res.rows[0])[0]];
      return { format: 'json', plan: Array.isArray(plan) ? plan[0] : plan, query: sql };
    } finally {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  async docInsert(db, coll, payload) {
    const pool = this.requirePool();
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    await this.rimuoviIdVirtuale(db, coll, doc);
    const cols = Object.keys(doc);
    const table = qtable(db, coll);
    let res;
    if (!cols.length) {
      res = await pool.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING *`);
    } else {
      // Le colonne geometriche non prendono il valore grezzo ma
      // ST_GeomFromGeoJSON col SRID della colonna (vedi geoBinding).
      const { geo, geoNativo } = await this.tableColumnsInfo(db, coll);
      const bind = cols.map((c, i) => PostgreSqlStrategy.geoBinding(c, doc[c], geo, `$${i + 1}`, geoNativo));
      const sql = `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES (${bind.map((b) => b.sql).join(', ')}) RETURNING *`;
      res = await pool.query(sql, bind.map((b) => b.param));
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

    const { geo, geoNativo } = await this.tableColumnsInfo(db, coll);
    for (const [col, val] of Object.entries(set)) {
      if (col === '_id') continue;
      const b = PostgreSqlStrategy.geoBinding(col, val, geo, `$${idx++}`, geoNativo);
      assignments.push(`${qid(col)} = ${b.sql}`);
      params.push(b.param);
    }
    for (const col of payload.unset || []) {
      if (col === '_id') continue;
      assignments.push(`${qid(col)} = NULL`);
    }
    if (!assignments.length) throw new Error('Nessuna modifica da applicare.');

    const whereSql = where.sql.replace(/\$(\d+)/g, () => `$${idx++}`);
    params.push(...where.params);

    const res = await pool.query(
      `UPDATE ${qtable(db, coll)} SET ${assignments.join(', ')} WHERE ${await this.bersaglioRiga(db, coll, whereSql)}`,
      params
    );
    return { matched: res.rowCount, modified: res.rowCount };
  }

  async docReplace(db, coll, payload) {
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    await this.rimuoviIdVirtuale(db, coll, doc);
    return this.docUpdate(db, coll, { id: payload.id, set: EJSON.serialize(doc, { relaxed: true }) });
  }

  async docDelete(db, coll, payload) {
    const pool = this.requirePool();
    const where = this.parseRowId(payload.id);
    const res = await pool.query(
      `DELETE FROM ${qtable(db, coll)} WHERE ${await this.bersaglioRiga(db, coll, where.sql)}`,
      where.params
    );
    return { deleted: res.rowCount };
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
    const { columns: colonne } = await this.tableColumnsInfo(db, coll);
    const ricercaGlobale = await this._preparaRicercaGlobale(db, coll, payload, colonne);
    const { table, whereSql, whereParams } = this.buildSelect(db, coll, payload, { colonne, ricercaGlobale });
    const res = await pool.query(`DELETE FROM ${table}${whereSql}`, whereParams);
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

  /**
   * Esegue una funzione con il `search_path` fissato sullo schema indicato.
   *
   * Serve alle funzioni di catalogo `pg_get_constraintdef`/`pg_get_indexdef`:
   * il testo che restituiscono qualifica con lo schema SOLO gli oggetti non
   * visibili dal `search_path` corrente. Impostandolo sullo schema di origine
   * si ottiene un DDL con nomi NON qualificati, cioè ripristinabile in uno
   * schema diverso da quello di partenza — è lo stesso meccanismo con cui
   * `pg_dump` produce dump reimportabili altrove. L'alternativa (riscrivere il
   * testo con delle regex) fallirebbe su ogni nome che contiene un punto.
   */
  async conSearchPath(schema, fn) {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      try {
        await client.query(`SET LOCAL search_path TO ${qid(schema)}`);
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  /**
   * DDL della tabella: colonne, PRIMARY KEY, UNIQUE e CHECK.
   *
   * Il nome della tabella è volutamente NON qualificato. `collectionAggregate`
   * allinea il `search_path` allo schema di destinazione prima di eseguire lo
   * SQL, quindi un DDL non qualificato ricrea la tabella DOVE la si sta
   * importando; qualificandola con lo schema di ORIGINE, l'import in uno schema
   * diverso ricreava invece la tabella nello schema di partenza (o falliva).
   * È la stessa forma che MySQL ottiene da `SHOW CREATE TABLE`.
   *
   * Le chiavi esterne NON stanno qui: vanno aggiunte quando tutte le tabelle
   * esistono e i dati sono stati caricati (vedi `tableAuxDdl`).
   */
  async tableDdl(db, coll) {
    const schema = schemaOf(db);
    const fields = await this.tableFields(db, coll);
    if (!fields.length) return null;

    // Colonne a identità: `GENERATED ... AS IDENTITY` (PG 10+) non compare nel
    // default e va letto a parte, altrimenti si perde ricreando una colonna
    // ordinaria senza generazione automatica.
    const ident = await this.conSearchPath(schema, (client) => client.query(
      `SELECT column_name AS name, identity_generation AS generation
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND is_identity = 'YES'`,
      [schema, coll],
    ));
    const identita = new Map(ident.rows.map((r) => [r.name, String(r.generation || 'BY DEFAULT')]));

    const colDefs = fields.map((f) => {
      const generation = identita.get(f.name);
      if (generation) {
        // L'identità implica già NOT NULL e la propria sequenza.
        return `${qid(f.name)} ${f.types[0]} GENERATED ${generation} AS IDENTITY`;
      }
      // `DEFAULT nextval('<tabella>_<col>_seq')` è una colonna seriale. La
      // sequenza vive nello schema di ORIGINE: riprodurre il default verbatim
      // creerebbe una tabella che punta alla sequenza di un altro schema (o a
      // una che non esiste). I tipi `serial` la ricreano invece da soli, con il
      // nome giusto nello schema di destinazione.
      const seriale = f.default != null && /\bnextval\s*\(/i.test(f.default)
        ? SERIAL_PER_TIPO[String(f.types[0] || '').toLowerCase()]
        : null;
      if (seriale) {
        let def = `${qid(f.name)} ${seriale}`;
        if (!f.nullable) def += ' NOT NULL';
        return def;
      }
      let def = `${qid(f.name)} ${f.types[0]}`;
      if (!f.nullable) def += ' NOT NULL';
      // Il default arriva già come espressione SQL dal catalogo
      // (`now()`, `'x'::text`, `(a + b)`): va riprodotto verbatim, non
      // ri-quotato come un letterale da `defaultSql` — che è invece la forma
      // giusta per un default digitato dall'utente.
      if (f.default != null) def += ` DEFAULT ${f.default}`;
      return def;
    });

    // Vincoli di tabella diversi dalle FK, nella forma autorevole del catalogo:
    // `pg_get_constraintdef` conserva PK multi-colonna, UNIQUE parziali,
    // espressioni CHECK e clausole che una ricostruzione a mano perde.
    const vincoli = await this.conSearchPath(schema, (client) => client.query(
      `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS def
         FROM pg_catalog.pg_constraint c
         JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2 AND c.contype IN ('p', 'u', 'c')
     ORDER BY c.contype DESC, c.conname`,
      [schema, coll],
    ));
    for (const r of vincoli.rows) colDefs.push(String(r.def));

    return `CREATE TABLE ${qid(coll)} (\n  ${colDefs.join(',\n  ')}\n);`;
  }

  /**
   * Istruzioni da eseguire DOPO che tutte le tabelle esistono e i dati sono
   * stati caricati: indici non vincolari e chiavi esterne.
   *
   * L'ordine è essenziale. Una FK verso una tabella non ancora creata fallisce,
   * e una FK attiva durante il caricamento impone alle righe un ordine di
   * inserimento che l'export non conosce. Creare gli indici alla fine è inoltre
   * molto più rapido che mantenerli aggiornati riga per riga.
   */
  async tableAuxDdl(db, coll) {
    const schema = schemaOf(db);
    return this.conSearchPath(schema, async (client) => {
      const out = { indexes: [], foreignKeys: [] };

      // Solo gli indici NON creati da un vincolo: quelli di PK/UNIQUE sono già
      // dentro il CREATE TABLE e ricrearli darebbe un errore di duplicato.
      const idx = await client.query(
        `SELECT pg_catalog.pg_get_indexdef(x.indexrelid) AS def
           FROM pg_catalog.pg_index x
           JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
           JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = x.indexrelid
            )
       ORDER BY i.relname`,
        [schema, coll],
      );
      for (const r of idx.rows) out.indexes.push(`${String(r.def)};`);

      const fk = await client.query(
        `SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid) AS def
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'f'
       ORDER BY c.conname`,
        [schema, coll],
      );
      for (const r of fk.rows) {
        out.foreignKeys.push(
          `ALTER TABLE ${qid(coll)} ADD CONSTRAINT ${qid(r.name)} ${String(r.def)};`
        );
      }
      return out;
    });
  }

  async dbSchema(db) {
    const pool = this.requirePool();
    // Schema/UML/grafo del solo schema aperto: prima univano le tabelle di
    // tutti gli schemi, quindi il diagramma mostrava relazioni fra tabelle che
    // nella vista corrente non esistono.
    const schema = schemaOf(db);
    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema]
    );

    const columnsRes = await pool.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`,
      [schema]
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
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [schema]
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

  // Chiavi esterne uscenti dalla sola tabella indicata (pannello di riferimento
  // della griglia). Qui `ccu.table_schema` conta doppio: nella UI il "database"
  // È lo schema, quindi una FK verso un altro schema è a tutti gli effetti una
  // FK verso un altro database, e il pannello deve saperlo per interrogare la
  // tabella giusta invece di una omonima nello schema di partenza.
  async columnRelations(db, coll) {
    const pool = this.requirePool();
    const schema = schemaOf(db);
    const res = await pool.query(
      `SELECT kcu.column_name,
              ccu.table_schema AS referenced_table_schema,
              ccu.table_name   AS referenced_table_name,
              ccu.column_name  AS referenced_column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1
          AND tc.table_name = $2
     ORDER BY kcu.ordinal_position`,
      [schema, coll]
    );
    return res.rows.map((r) => ({
      campo: r.column_name,
      db: r.referenced_table_schema || schema,
      tabella: r.referenced_table_name,
      colonna: r.referenced_column_name,
      origine: 'vincolo',
      molti: false,
    }));
  }

  async collectionExport(db, coll, payload) {
    const pool = this.requirePool();
    const format = ['sql', 'json'].includes(payload.format) ? payload.format : 'csv';
    const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 1000);
    const table = qtable(db, coll);
    const pk = await this.primaryKey(db, coll);
    // Il formato JSON e' anche il trasporto dell'export di un intero database:
    // le geometrie devono quindi uscire nella lingua comune GeoJSON, non nella
    // rappresentazione privata del driver (`point` diventerebbe `{ x, y }`).
    const selezione = format === 'json' ? await this.selectListFor(db, coll) : null;
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
        whereSql = ` WHERE (${pkCols}) > (${pk.map((_, i) => `$${i + 1}`).join(', ')})`;
        params = afterVals.map(toSqlValue);
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
        nextAfter = EJSON.stringify(pk.map((c) => last[c]), { relaxed: true });
      }
    } else {
      const skip = Math.max(parseInt(payload.skip, 10) || 0, 0);
      const res = await pool.query(`SELECT ${selectList} FROM ${table} LIMIT $1 OFFSET $2`, [limit, skip]);
      rows = res.rows;
      fields = res.fields;
    }

    if (selezione) {
      PostgreSqlStrategy.geoRowsToJson(rows, selezione.geo, selezione.geoNativo);
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
          if (v instanceof Date) return isNaN(v.getTime()) ? 'NULL' : `'${v.toISOString()}'`;
          if (typeof v === 'object' || Buffer.isBuffer(v)) {
            return `'${JSON.stringify(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
          }
          return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
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

  // payload.upsert: se true, le righe che riportano tutte le colonne della
  // PK vengono inserite con ON CONFLICT ... DO UPDATE (usato dal restore per
  // i layer incrementali/differenziali, dove una riga può già esistere).
  async collectionImport(db, coll, payload) {
    const pool = this.requirePool();
    const raw = Array.isArray(payload.docs) ? payload.docs : [];
    if (!raw.length) throw new Error('Nessuna riga da importare nel blocco.');
    const table = qtable(db, coll);
    let inserted = 0;
    const errors = [];

    const pk = payload.upsert ? await this.primaryKey(db, coll) : [];
    // Nomi reali delle colonne: serve a distinguere l'`_id` virtuale da una
    // colonna omonima (CDB-41), comune nelle tabelle migrate da MongoDB.
    let colonneReali = new Set();
    let geo = new Map();
    let geoNativo = new Map();
    try {
      const info = await this.tableColumnsInfo(db, coll);
      colonneReali = new Set(info.columns.map((c) => c.name));
      geo = info.geo || geo;
      geoNativo = info.geoNativo || geoNativo;
    } catch { /* metadati non leggibili: vale il comportamento storico */ }

    const parsed = [];
    for (let i = 0; i < raw.length; i++) {
      try {
        const row = EJSON.deserialize(raw[i], { relaxed: true });
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error('la riga deve essere un oggetto { "colonna": valore }');
        }
        // Come in docInsert (CDB-41): si scarta l'`_id` VIRTUALE, non una
        // colonna che si chiama davvero così.
        if (!colonneReali.has('_id')) delete row._id;
        const cols = Object.keys(row);
        if (!cols.length) throw new Error('riga vuota');
        parsed.push({ i, cols, values: cols.map((c) => row[c]) });
      } catch (err) {
        if (errors.length < 10) errors.push(`Riga ${i + 1}: ${(err && err.message) || err}`);
      }
    }

    // Costruisce l'INSERT (con eventuale upsert sulla chiave primaria) per un
    // gruppo di righe che condividono le STESSE colonne. `righe` è un array di
    // array di valori; i placeholder scorrono su tutte le righe.
    const sqlPerGruppo = (cols, righe) => {
      const valori = [];
      const tuple = righe.map((vals) => {
        const ph = vals.map((v, indice) => {
          const placeholder = `$${valori.length + 1}`;
          const bind = PostgreSqlStrategy.geoBinding(
            cols[indice], v, geo, placeholder, geoNativo
          );
          valori.push(bind.param);
          return bind.sql;
        });
        return `(${ph.join(', ')})`;
      });
      let sql = `INSERT INTO ${table} (${cols.map(qid).join(', ')}) VALUES ${tuple.join(', ')}`;
      if (pk.length && pk.every((c) => cols.includes(c))) {
        const updateCols = cols.filter((c) => !pk.includes(c));
        sql += ` ON CONFLICT (${pk.map(qid).join(', ')})`;
        sql += updateCols.length
          ? ` DO UPDATE SET ${updateCols.map((c) => `${qid(c)} = EXCLUDED.${qid(c)}`).join(', ')}`
          : ' DO NOTHING';
      }
      return { sql, valori };
    };

    // Import A BLOCCHI, non una query per riga (CDB-31): importare 10.000 righe
    // significava 10.000 round-trip, ciascuno con la sua latenza — su una
    // connessione remota è la differenza fra secondi e minuti. Le righe vengono
    // raggruppate per FORMA (stesse colonne), perché un solo INSERT può avere
    // una sola lista di colonne, e i documenti MongoDB importati in PostgreSQL
    // non hanno tutti gli stessi campi.
    //
    // Se un blocco fallisce si ricade sulle righe singole: l'errore va
    // attribuito alla riga che lo ha causato, altrimenti un solo valore
    // sbagliato farebbe scartare centinaia di righe valide senza dire quale.
    const BLOCCO = 200;
    const gruppi = new Map(); // firma delle colonne -> { cols, elementi }
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
          if (errors.length < 10) errors.push(`Riga ${p.i + 1}: ${(err && err.message) || err}`);
        }
      }
    };

    for (const { cols, elementi } of gruppi.values()) {
      for (let i = 0; i < elementi.length; i += BLOCCO) {
        const blocco = elementi.slice(i, i + BLOCCO);
        try {
          const { sql, valori } = sqlPerGruppo(cols, blocco.map((p) => p.values));
          await pool.query(sql, valori);
          inserted += blocco.length;
        } catch {
          await inserisciSingole(blocco);
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
      defs = [`${qid('id')} SERIAL PRIMARY KEY`];
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
    // Il nuovo nome resta nello STESSO schema: ALTER TABLE ... RENAME TO non
    // accetta un nome qualificato per la destinazione.
    await pool.query(`ALTER TABLE ${qtable(db, coll)} RENAME TO ${qid(to)}`);
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

  async alterColumn(db, coll, payload) {
    const pool = this.requirePool();
    const oldName = String((payload && payload.oldName) || '').trim();
    if (!oldName) throw new Error('Nome della colonna da modificare mancante.');
    const col = payload.column || {};
    const newName = String(col.name || '').trim();
    const type = String(col.type || '').trim();
    if (!newName) throw new Error('Nome della colonna mancante.');
    // Questo ramo NON passa da columnSql: il tipo finisce direttamente in
    // `ALTER COLUMN … TYPE ${type}` e nel ripiego `USING …::${type}`, quindi la
    // validazione va ripetuta qui o resta la porta aperta.
    if (type) DbStrategy.assertColumnType(type);
    if (newName !== oldName) DbStrategy.assertCreatableName(newName, 'della colonna');

    // Rename, tipo, nullabilità e default formano UNA modifica logica. Prima
    // erano query indipendenti: se il cast falliva dopo il rename, l'utente
    // riceveva un errore ma la colonna era già stata rinominata. La transazione
    // rende l'operazione atomica; il SAVEPOINT permette il solo ripiego USING
    // senza lasciare la transazione nello stato aborted di PostgreSQL.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT column_default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schemaOf(db), coll, oldName],
      );
      if (!current.rowCount) throw new Error(`La colonna "${oldName}" non esiste nella tabella "${coll}".`);
      const currentDefault = current.rows[0].column_default == null
        ? '' : String(current.rows[0].column_default).trim();

      if (newName && newName !== oldName) {
        await client.query(`ALTER TABLE ${qtable(db, coll)} RENAME COLUMN ${qid(oldName)} TO ${qid(newName)}`);
      }

      const targetName = newName || oldName;
      if (type) {
        await client.query('SAVEPOINT codedb_tipo_colonna');
        try {
          await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} TYPE ${type}`);
          await client.query('RELEASE SAVEPOINT codedb_tipo_colonna');
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT codedb_tipo_colonna');
          if (/cannot be cast automatically/i.test(err.message || '')) {
            await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} TYPE ${type} USING ${qid(targetName)}::${type}`);
          } else {
            throw err;
          }
        }
      }
      if (col.nullable === false) {
        await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} SET NOT NULL`);
      } else if (col.nullable === true) {
        await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} DROP NOT NULL`);
      }

      // Il form invia sempre il default. Se è identico a quello letto dal
      // catalogo (per esempio nextval(...) di una SERIAL) lo si conserva senza
      // reinterpretarlo. Una modifica usa invece lo stesso encoder ristretto
      // della creazione: literal/numero/keyword sicure, mai SQL arbitrario.
      if (Object.prototype.hasOwnProperty.call(col, 'default')) {
        const requestedDefault = String(col.default == null ? '' : col.default).trim();
        if (requestedDefault !== currentDefault) {
          const clause = requestedDefault
            ? `SET DEFAULT ${defaultSql(requestedDefault)}`
            : 'DROP DEFAULT';
          await client.query(`ALTER TABLE ${qtable(db, coll)} ALTER COLUMN ${qid(targetName)} ${clause}`);
        }
      }

      await client.query('COMMIT');
      this._cacheColonne.clear();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async dropColumn(db, coll, name) {
    const pool = this.requirePool();
    const column = String(name || '').trim();
    if (!column) throw new Error('Nome della colonna da eliminare mancante.');
    await pool.query(`ALTER TABLE ${qtable(db, coll)} DROP COLUMN ${qid(column)}`);
    this._cacheColonne.clear();
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
    const table = String(coll || '').trim();
    if (!table) throw new Error('Tabella proprietaria dell\'indice mancante.');
    const schema = schemaOf(db);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL lock_timeout = \'10s\'');
      // Il lock rende atomici controllo e DROP rispetto alle DDL sulla tabella.
      await client.query(`LOCK TABLE ${qtable(schema, table)} IN ACCESS EXCLUSIVE MODE`);
      const found = await client.query(
        `SELECT 1
           FROM pg_catalog.pg_class i
           JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
           JOIN pg_catalog.pg_index x ON x.indexrelid = i.oid
           JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
          WHERE n.nspname = $1 AND i.relname = $2 AND t.relname = $3`,
        [schema, idx, table]
      );
      if (!found.rowCount) {
        throw new Error('L\'indice indicato non appartiene alla tabella selezionata.');
      }
      await client.query(`DROP INDEX ${qid(schema)}.${qid(idx)}`);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Indici della tabella nella forma attesa dalla vista Dettagli e dallo
   * schema: `key` è l'oggetto { colonna: 1 } nell'ordine dell'indice. La
   * lettura e il raggruppamento delle righe stanno fuori (vedi elencoIndici e
   * db/sqlMetadati.js), perché sono gli stessi su MySQL.
   */
  async indexList(db, table) {
    const indici = await this.elencoIndici(db, table);
    return indici.map((i) => ({
      name: i.name,
      key: Object.fromEntries(i.columns.map((c) => [c, 1])),
      unique: i.unique,
      primary: i.primary,
    }));
  }

  /**
   * Documento pronto da inserire come duplicato della riga ricevuta: le chiavi
   * seguono la modalita' (vedi db/duplica.js), i valori nuovi si calcolano qui
   * perche' solo il database sa qual e' il MAX e cosa e' gia' occupato.
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
          const r = await pool.query(`SELECT MAX(${qid(nome)}) AS m FROM ${table}`);
          return r.rows[0] ? r.rows[0].m : null;
        },
        esiste: async (v) => {
          const r = await pool.query(`SELECT 1 FROM ${table} WHERE ${qid(nome)} = $1 LIMIT 1`, [v]);
          return r.rows.length > 0;
        },
        uuid: () => randomUUID(),
      });
      applicaRicalcolo(piano, nome, nuovo, { pk: col.pk, etichetta: col.tipo });
    }
    return { doc: JSON.stringify(piano.doc), note: piano.note, azioni: piano.azioni };
  }

  async collectionStats(db, coll) {
    const pool = this.requirePool();
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM ${qtable(db, coll)}`);
    const count = Number(countRes.rows[0]?.total) || 0;

    // `::regclass` risolve un nome non qualificato dal search_path: qui si passa
    // il nome QUALIFICATO, altrimenti le dimensioni potevano essere quelle di
    // una tabella omonima in un altro schema.
    const sizeRes = await pool.query(
      `SELECT pg_relation_size($1::regclass) AS data_size, pg_total_relation_size($1::regclass) AS total_size`,
      [qtable(db, coll)]
    );
    const dataSize = Number(sizeRes.rows[0]?.data_size) || 0;
    const totalSize = Number(sizeRes.rows[0]?.total_size) || 0;

    // `pg_indexes` da solo dava il nome dell'indice al posto delle colonne (e
    // nessuna unicita'): la vista Dettagli mostrava "Chiavi: {idx_nome:1}", che
    // non e' una chiave. Le colonne vere arrivano da pg_index (vedi indexList).
    const indexes = await this.indexList(db, coll);

    const fields = await this.tableFields(db, coll);

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

// I metodi comuni ai due motori SQL (chiave primaria, informazioni sulle
// colonne, elenco dei campi, indici unici, paginazione a chiave, conteggio)
// arrivano dal modulo già legati al dialetto PostgreSQL dichiarato in testa:
// non sono più scritti qui, e non possono più divergere da quelli di MySQL.
installaMetadati(PostgreSqlStrategy.prototype, DIALETTO_METADATI);

module.exports = PostgreSqlStrategy;
