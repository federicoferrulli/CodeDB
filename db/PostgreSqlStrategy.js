'use strict';

const { prendiConnessioneSql, chiudiStrategiaSql } = require('./sqlSessione');
const { modificaConSrid, ERRORE_SRID } = require('./sridModifica');
const { EJSON } = require('bson');
const DbStrategy = require('./DbStrategy');
const { stimaConteggio, conteggioLimitato, completaConteggi } = require('./conteggiNavigatore');
const { splitStatements, stripSqlNoise } = require('./sqlText');
const { tipiPostgresNativi } = require('./sqlRisultatiNativi');
const { tabellare } = require('./sqlTabellare');
const { eseguiBatchScritture, conRighe } = require('./sqlWriteBatch');
// Metadati comuni ai due motori SQL (chiave primaria, colonne, campi, indici
// unici, keyset, conteggio): la logica sta nel modulo, qui resta il dialetto.
const { installaMetadati } = require('./sqlMetadati');
// Conversione EJSON <-> parametri SQL: è il protocollo del client, non il
// dialetto del server, quindi vive in un modulo solo (vedi db/sqlValori.js).
const { parseClientValue, deserializeClientObject, serializeRow, documentoScrivibile } = require('./sqlValori');
const { tipoColonna, valorePostgres, valoreDalJson } = require('./pg-valori');
const { cellaCsv } = require('./csv');
// Come si scrive il nome di una tabella o di una colonna: regola unica,
// condivisa con l'altro adattatore SQL, con il DDL, con il backup e col
// frontend (vedi db/identificatori.js).
const { quotaSempre, quotaQualificato } = require('./identificatori');
const { isGeoJson, assertGeoJson, parseGeoJsonText } = require('./geometry');
const { pgNativoAGeoJson, geoJsonAPgNativo } = require('./pg-geo-nativo');
const sessioni = require('./sessioni');
const { normalizzaRicerca, clausolaPostgres } = require('./ricercaGlobale');
const {
  DEFAULT_SCHEMA,
  schemaOf,
  DIALETTO_METADATI,
  defaultSql,
  columnSql,
  installaCatalogoPg,
} = require('./pg-catalogo-schema');
const { installaTrasferimentoPg } = require('./pg-trasferimento');
const { installaSessioniPg } = require('./pg-sessioni-monitor');

// Schemi che CodeDB non deve mai mostrare né modificare. Il livello
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

function qid(name) {
  return quotaSempre(name, 'postgresql');
}

function qtable(db, table) {
  return quotaQualificato([schemaOf(db), table], 'postgresql');
}

function whereFromId(id, colonne = []) {
  const perNome = new Map(colonne.map((c) => [c.name, c]));
  const cols = Object.keys(id);
  if (!cols.length) throw new Error('Identificatore di riga mancante.');
  const sqlParts = [];
  const params = [];
  let idx = 1;
  for (const c of cols) {
    const val = valorePostgres(id[c], perNome.get(c));
    if (val === null) {
      sqlParts.push(`${qid(c)} IS NULL`);
    } else {
      sqlParts.push(`${qid(c)} = $${idx++}`);
      params.push(val);
    }
  }
  return { sql: sqlParts.join(' AND '), params };
}

const nulliPrima = (discendente) => (discendente ? ' NULLS LAST' : ' NULLS FIRST');

const TABELLARE = tabellare({
  qid, qtable, whereFromId, nulliPrima, segnaposto: (n) => `$${n}`, testoDi: (col) => `${col}::text`,
});

function preparaRicercaGlobale(_strategy, _db, _coll, payload, colonne) {
  const valore = normalizzaRicerca(payload && payload.cercaOvunque);
  if (!valore) return null;
  return (da) => clausolaPostgres(valore, colonne, qid, (n) => `$${n}`, da);
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
  constructor(options = {}) {
    super(options);
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

  async listCollections(db, { includeCounts = true } = {}) {
    const pool = this.requirePool();
    // Filtrata sullo schema richiesto: prima l'argomento veniva ignorato e sotto
    // OGNI voce della sidebar comparivano le tabelle di tutti gli schemi.
    const res = await pool.query(
      // Il join su pg_class passa per pg_namespace, altrimenti `relname` da solo
      // aggancia le tabelle OMONIME di tutti gli schemi: la stessa tabella
      // compariva più volte nella sidebar e il conteggio righe poteva arrivare
      // da un'altra tabella. Prima non si notava perché la query restituiva
      // comunque le tabelle di ogni schema.
      `SELECT t.table_name AS name, t.table_type AS ttype,
              CASE WHEN s.n_live_tup > 0 THEN s.n_live_tup
                   WHEN c.reltuples > 0 THEN c.reltuples::bigint END AS cnt
         FROM information_schema.tables t
    LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
    LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
    LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
        WHERE t.table_schema = $1
     ORDER BY t.table_name`,
      [schemaOf(db)]
    );
    const collections = res.rows.map((r) => {
      const isView = String(r.ttype || '').toUpperCase().includes('VIEW');
      return {
        name: r.name,
        type: isView ? 'view' : 'collection',
        ...stimaConteggio(isView || !includeCounts ? null : r.cnt),
      };
    });
    if (!includeCounts) return collections;
    return completaConteggi(collections, async (coll, limit, ms) => {
      const result = await this.queryConTimeout(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${qtable(db, coll.name)} LIMIT ${limit}) AS campione`, [], ms
      );
      return conteggioLimitato(result.rows[0]?.n, coll.count);
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
  async selectListFor(db, coll, infoPrecaricate = null) {
    const info = infoPrecaricate || await this.tableColumnsInfo(db, coll);
    if (!info.geo.size && !info.geoNativo.size && !info.columns.some(c => tipoColonna(c).kind === 'array')) {
      return { list: '*', geo: info.geo, geoNativo: info.geoNativo, colonne: info.columns };
    }
    const list = info.columns
      .map((c) => {
        // Il parser standard perde limiti, cifre NUMERIC e microsecondi degli
        // elementi. Il testo nativo è anche un input valido per il binder.
        if (tipoColonna(c).kind === 'array') return `${qid(c.name)}::text AS ${qid(c.name)}`;
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
    if (!colInfo || colInfo.srid == null) {
      throw new Error('SRID non noto: CodeDB non può modificare la geometria senza reinterpretare le coordinate. Dichiara lo SRID della colonna oppure consenti la lettura dei metadata PostGIS.');
    }
    const base = `ST_SetSRID(ST_GeomFromGeoJSON(${placeholder}), ${Number(colInfo.srid)})`;
    return (colInfo && colInfo.kind === 'geography') ? `${base}::geography` : base;
  }

  // Espressione + parametro per una colonna in scrittura.
  static geoBinding(col, value, geo, placeholder, geoNativo, colonna) {
    const colInfo = geo && geo.get(col);
    if (colInfo && isGeoJson(value)) {
      // Si serializza la forma CANONICA restituita dalla validazione: le
      // coordinate arrivano dal client come oggetti BSON (Double/Int32), e
      // serializzare l'originale li rimetterebbe dentro il testo consegnato a
      // ST_GeomFromGeoJSON.
      const canonica = assertGeoJson(value, `Colonna "${col}"`);
      return { sql: PostgreSqlStrategy.geoExpression(colInfo, placeholder), param: JSON.stringify(canonica) };
    }
    // Tipo nativo: l'editor manda GeoJSON, PostgreSQL vuole il proprio
    // letterale — "(12.5,41.9)" e non {"type":"Point",...}. Senza questa
    // conversione l'inserimento falliva con "invalid input syntax for type
    // point" (CDB-A88).
    const nativo = geoNativo && geoNativo.get(col);
    if (nativo && value != null) {
      const canonica = isGeoJson(value) ? assertGeoJson(value, `Colonna "${col}"`) : value;
      return { sql: placeholder, param: geoJsonAPgNativo(nativo.type, canonica) };
    }
    return { sql: placeholder, param: valorePostgres(value, colonna) };
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

  parseRowId(rawId, colonne) {
    return TABELLARE.parseRowId(rawId, colonne);
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
    const perNome = new Map((opzioni.colonne || []).map(c => [c.name, c]));
    // `ordinamento` chiude sul metodo di QUESTA istanza: e' cio' che rende
    // efficace una sovrascrittura di `buildOrderBy` anche per la griglia.
    return TABELLARE.buildSelect(db, coll, payload, {
      ...opzioni,
      valore: (campo, value) => valorePostgres(value, perNome.get(campo)),
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
    const perNome = new Map(sel.colonne.map(c => [c.name, c]));
    const ks = this.buildKeyset(payload, table, whereSql, limit, pk, selectList, whereParams,
      (campo, value) => valorePostgres(value, perNome.get(campo)));
    // Su PostgreSQL il numero del segnaposto è la POSIZIONE reale del
    // parametro: se il filtro strutturato ne ha già occupati due, il limite
    // è $3 e il salto $4. Lasciarli fissi a $1 e $2 farebbe leggere il
    // limite al posto del filtro — in silenzio, con un risultato plausibile.
    const nFiltro = whereParams.length;
    const sql = ks ? ks.sql
      : `SELECT ${selectList} FROM ${table}${whereSql}${orderSql} LIMIT $${nFiltro + 1} OFFSET $${nFiltro + 2}`;
    const params = ks ? ks.params : [...whereParams, limit, skip];
    const ms = DbStrategy.queryTimeoutMs(this.env);
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
    const capped = DbStrategy.truncateBySize(rows, DbStrategy.maxResultBytes(this.env));
    const idReale = columns.includes('_id');
    const rowIds = idReale ? capped.rows.map(r => serializeRow(this.makeId(r, pk, columns), sel.colonne)) : undefined;
    const docs = capped.rows.map((r) => {
      const doc = idReale ? r : { ...r, _id: this.makeId(r, pk, columns) };
      return serializeRow(doc, sel.colonne);
    });

    const columnMeta = Object.fromEntries(sel.colonne.map((c) => [c.name, {
      type: c.declaredType || c.type, nullable: c.nullable, srid: c.srid, generated: c.generated,
      // Il nome di un dominio non rivela il tipo: l'editor deve sapere che
      // anche app."numeric" può contenere un array, senza ricevere il catalogo.
      ...(tipoColonna(c).kind === 'array' ? { pgType: { kind: 'array' } } : {}),
      // Sottotipo PostGIS: `type` qui e' 'geometry' per ogni colonna
      // geometrica, e la griglia non avrebbe altro modo di sapere che quella
      // colonna vuole un MultiPolygon.
      geoType: c.geoTipo || undefined,
    }]));
    return { docs, columns, columnMeta, ...(rowIds ? { rowIds } : {}), total, skip, limit, keyset: !!ks, truncated: capped.truncated || undefined };
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
    const ms = DbStrategy.countTimeoutMs(this.env);
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
  async queryConTimeout(sql, params, ms = DbStrategy.queryTimeoutMs(this.env)) {
    const pool = this.requirePool();
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
    const ms = DbStrategy.aggregateTimeoutMs(this.env);
    const lease = await prendiConnessioneSql(this, sql, () => pool.connect());
    const client = lease.conn;
    let eseguita = false;
    const letturaIsolata = readOnly && !lease.transazione;
    // SQL Raw: la query la scrive l'utente, quindi puo' qualificare gli schemi
    // come vuole. I nomi NON qualificati devono pero' risolversi nello schema
    // che sta guardando, non in quello che capita dal search_path del server.
    // Le letture protette usano SET LOCAL; le sessioni persistenti conservano
    // il client, mentre i prestiti brevi ripuliscono il contesto prima del rilascio.
    const schema = schemaOf(db);
    // In una transazione abortita PostgreSQL accetta il recupero, ma rifiuta SET.
    const recupero = /^(?:ROLLBACK|ABORT|COMMIT|END)\b/i.test(stripSqlNoise(sql, { dbms: 'postgresql' }).trim());
    let pathSet = false;
    let timeoutSet = false;
    let readTxOpen = false;
    try {
      if (readOnly && lease.transazione && !lease.solaLettura) {
        throw new Error('La lettura protetta non può aprire una seconda transazione: usa BEGIN READ ONLY o completa prima la transazione di scrittura.');
      }
      if (payload && payload.opHandle && client.processID) {
        payload.opHandle.processID = client.processID;
      }
      if (letturaIsolata) {
        await client.query('BEGIN READ ONLY');
        // Segnare la transazione subito dopo BEGIN: anche un errore nel primo
        // SET LOCAL deve fare ROLLBACK prima di restituire il client al pool.
        readTxOpen = true;
        if (ms > 0) await client.query(`SET LOCAL statement_timeout = ${ms}`);
        // Un solo schema: aggiungere `public` come ripiego farebbe risolvere
        // un nome non qualificato fuori dal database/schema autorizzato quando
        // la tabella non esiste nello schema selezionato.
        await client.query(`SET LOCAL search_path TO ${qid(schema)}`);
      } else if (!recupero) {
        // Rollback, SET LOCAL e routine possono cambiare il contesto sul server.
        await client.query(`SET search_path TO ${qid(schema)}`);
        pathSet = true;
        // Fuori da una transazione non c'è `SET LOCAL`: il valore resta sulla
        // connessione, quindi nei prestiti brevi va riazzerato nel `finally`,
        // altrimenti lo eredita chi prende questo client dal pool.
        if (ms > 0) {
          await client.query(`SET statement_timeout = ${ms}`);
          timeoutSet = true;
        }
      }
      try {
        const cap = DbStrategy.resultCap(payload);
        const res = await client.query({ text: sql, values: payload.params, types: tipiPostgresNativi })
          .catch(err => { throw require('./queryError').annotaErroreQuery(err, sql, 'postgresql'); });
        eseguita = true;
        if (Array.isArray(res)) {
          const lastRes = res[res.length - 1];
          const rows = (lastRes.rows || []).slice(0, cap);
          const columns = lastRes.fields ? lastRes.fields.map((f) => f.name) : [];
          return { docs: rows.map((r) => serializeRow(r, lastRes.fields || [])), columns, total: lastRes.rows?.length || 0, skip: 0, limit: cap, resultSet: true, truncated: lastRes.rows?.length > cap };
        }
        if (res.rows && (res.rows.length > 0 || res.fields)) {
          const rows = res.rows.slice(0, cap);
          const columns = res.fields ? res.fields.map((f) => f.name) : [];
          return { docs: rows.map((r) => serializeRow(r, res.fields || [])), columns, total: res.rows.length, skip: 0, limit: cap, resultSet: true, truncated: res.rows.length > cap };
        }

        const summary = { comando: res.command, righeCoinvolte: res.rowCount || 0 };
        return { docs: [summary], columns: Object.keys(summary), total: 1, skip: 0, limit: cap };
      } finally {
        if (readTxOpen) {
          await client.query('ROLLBACK').catch(() => {});
          readTxOpen = false;
        }
        if (pathSet && !lease.transazione && !lease.persistente) await client.query('RESET search_path').catch(() => {});
        if (timeoutSet && !lease.transazione && !lease.persistente) await client.query('RESET statement_timeout').catch(() => {});
      }
    } finally {
      // Rete di sicurezza per errori avvenuti durante i SET LOCAL, prima di
      // entrare nel blocco che esegue la query. Un client con una transazione
      // READ ONLY rimasta aperta avvelenerebbe la richiesta successiva del pool.
      if (readTxOpen) await client.query('ROLLBACK').catch(() => {});
      // In caso di errore pg rigetta prima di ReadyForQuery. Una richiesta
      // vuota attende quel messaggio senza alterare la transazione abortita.
      let statoServer, guasta = false;
      try {
        if (!eseguita) await client.query('').catch(() => {});
        const status = client.getTransactionStatus?.();
        if (status) statoServer = { transazione: status !== 'I', solaLettura: lease.solaLettura };
        if (status === 'T') {
          const stato = await client.query('SHOW transaction_read_only');
          statoServer.solaLettura = stato.rows[0].transaction_read_only === 'on';
        }
      } catch (err) {
        guasta = true;
        if (eseguita) throw err;
      } finally { await lease.termina(eseguita, guasta, statoServer); }
    }
  }

  /**
   * Batch di scritture in una sola transazione. La logica sta in
   * `db/sqlWriteBatch.js`, comune ai due motori SQL; qui resta il dialetto:
   * il tetto di tempo e il `search_path` si impongono con `SET LOCAL`, che
   * esiste solo DENTRO la transazione (un `SET` non riazzerato lo
   * erediterebbe chi prende quel client dal pool), e le righe di un
   * `RETURNING` passano dai tetti dichiarati dal modulo comune.
   */
  async executeWriteBatch(db, statements) {
    const pool = this.requirePool();
    const ms = DbStrategy.aggregateTimeoutMs(this.env);
    return eseguiBatchScritture(statements, {
      apri: () => pool.connect(),
      begin: (client) => client.query('BEGIN'),
      dentroLaTransazione: async (client) => {
        if (ms > 0) await client.query(`SET LOCAL statement_timeout = ${ms}`);
        await client.query(`SET LOCAL search_path TO ${qid(schemaOf(db))}`);
      },
      commit: (client) => client.query('COMMIT'),
      rollback: (client) => client.query('ROLLBACK'),
      esegui: async (client, sql) => {
        const res = await client.query(sql);
        const summary = { comando: res.command, righeCoinvolte: res.rowCount || 0 };
        return conRighe(
          summary,
          Array.isArray(res.rows) ? res.rows.map((r) => serializeRow(r, res.fields || [])) : [],
          Array.isArray(res.fields) ? res.fields.map((field) => field.name) : [],
        );
      },
      chiudi: (client) => client.release(),
    });
  }

  async collectionExplain(db, coll, payload) {
    const pool = this.requirePool();
    let sql;
    let parametriPiano = [];
    if (payload.mode === 'aggregate') {
      sql = String(payload.pipeline || '').trim();
      if (!sql) throw new Error('Inserisci una query SQL di cui mostrare il piano.');
      if (splitStatements(sql, { dbms: 'postgresql' }).length !== 1) {
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
    const [fields, info] = await Promise.all([this.tableFields(db, coll), this.tableColumnsInfo(db, coll)]);
    const perNome = new Map(info.columns.map(c => [c.name, c]));
    const doc = await require('./insertValues').parseSqlInsert(payload.doc, fields,
      (raw, col) => tipoColonna(perNome.get(col.name)).kind === 'array' ? valoreDalJson(raw, perNome.get(col.name)) : undefined);
    const cols = Object.keys(doc);
    const table = qtable(db, coll);
    const ritorno = info.columns.some(c => tipoColonna(c).kind === 'array')
      ? info.columns.map(c => tipoColonna(c).kind === 'array' ? `${qid(c.name)}::text AS ${qid(c.name)}` : qid(c.name)).join(', ') : '*';
    let res;
    if (!cols.length) {
      res = await pool.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING ${ritorno}`);
    } else {
      // Le colonne geometriche non prendono il valore grezzo ma
      // ST_GeomFromGeoJSON col SRID della colonna (vedi geoBinding).
      const { geo, geoNativo } = info;
      const bind = cols.map((c, i) => PostgreSqlStrategy.geoBinding(c, doc[c], geo, `$${i + 1}`, geoNativo, perNome.get(c)));
      const override = fields.some(f => f.identityGeneration === 'ALWAYS' && Object.hasOwn(doc, f.name)) ? ' OVERRIDING SYSTEM VALUE' : '';
      const sql = `INSERT INTO ${table} (${cols.map(qid).join(', ')})${override} VALUES (${bind.map((b) => b.sql).join(', ')}) RETURNING ${ritorno}`;
      res = await pool.query(sql, bind.map((b) => b.param));
    }
    const insertedRow = res.rows[0] || {};
    const pk = await this.primaryKey(db, coll);
    const insertedId = JSON.stringify(serializeRow(this.makeId(insertedRow, pk, Object.keys(insertedRow)), fields));
    return { insertedId };
  }

  async docUpdate(db, coll, payload) {
    const pool = this.requirePool();
    const set = deserializeClientObject(payload.set);
    const assignments = [];
    const params = [];
    let idx = 1;

    let info;
    try { info = await this.tableColumnsInfo(db, coll); }
    catch (err) { throw new Error(ERRORE_SRID, { cause: err }); }
    const perNome = new Map(info.columns.map(c => [c.name, c]));
    const where = this.parseRowId(payload.id, info.columns);
    const bersaglio = await this.bersaglioRiga(db, coll, where.sql);
    return modificaConSrid({ pool, mysql: false, info, set, table: qtable(db, coll), where, qid }, async (conn, geo) => {
      const { geoNativo } = info;

      for (const [col, val] of Object.entries(set)) {
        if (col === '_id' && !info.columns.some(c => c.name === '_id')) continue;
        const b = PostgreSqlStrategy.geoBinding(col, val, geo, `$${idx++}`, geoNativo, perNome.get(col));
        assignments.push(`${qid(col)} = ${b.sql}`);
        params.push(b.param);
      }
      for (const col of payload.unset || []) {
        if (col === '_id' && !info.columns.some(c => c.name === '_id')) continue;
        assignments.push(`${qid(col)} = NULL`);
      }
      if (!assignments.length) throw new Error('Nessuna modifica da applicare.');

      const whereSql = bersaglio.replace(/\$(\d+)/g, () => `$${idx++}`);
      params.push(...where.params);

      const res = await conn.query(
        `UPDATE ${qtable(db, coll)} SET ${assignments.join(', ')} WHERE ${whereSql}`,
        params
      );
      return { matched: res.rowCount, modified: res.rowCount };
    });
  }

  async docReplace(db, coll, payload) {
    const doc = parseClientValue(payload.doc);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('La riga deve essere un oggetto JSON: { "colonna": valore, ... }');
    }
    const { columns } = await this.tableColumnsInfo(db, coll);
    const perNome = new Map(columns.map(c => [c.name, c]));
    const { campiJson } = await import('../public/js/insert-json.mjs');
    for (const [name, raw] of campiJson(payload.doc)) {
      if (tipoColonna(perNome.get(name)).kind === 'array') doc[name] = valoreDalJson(raw, perNome.get(name));
    }
    documentoScrivibile(doc, columns);
    return this.docUpdate(db, coll, { id: payload.id, set: EJSON.serialize(doc, { relaxed: false }) });
  }

  async docDelete(db, coll, payload) {
    const pool = this.requirePool();
    const { columns } = await this.tableColumnsInfo(db, coll);
    const where = this.parseRowId(payload.id, columns);
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
    return cellaCsv(v);
  }

}

// I metodi comuni ai due motori SQL (chiave primaria, informazioni sulle
// colonne, elenco dei campi, indici unici, paginazione a chiave, conteggio)
// arrivano dal modulo già legati al dialetto PostgreSQL: non possono divergere
// da quelli di MySQL. Catalogo/DDL, trasferimenti e monitor delle sessioni
// sono installati dai rispettivi moduli non enumerabili sul prototipo.
installaMetadati(PostgreSqlStrategy.prototype, DIALETTO_METADATI);
installaCatalogoPg(PostgreSqlStrategy.prototype);
installaTrasferimentoPg(PostgreSqlStrategy.prototype, {
  schemaOf,
  geoBindingFallback: PostgreSqlStrategy.geoBinding,
});
installaSessioniPg(PostgreSqlStrategy.prototype);

module.exports = PostgreSqlStrategy;
PostgreSqlStrategy.columnSql = columnSql;
PostgreSqlStrategy.defaultSql = defaultSql;

