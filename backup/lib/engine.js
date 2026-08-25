'use strict';

/* ---------------------------------------------------------------------------
 * Motore di backup: dump in streaming di un database (MongoDB o MySQL) in una
 * cartella auto-descritta:
 *
 *   <dest>/<connessione>_<db>/<id>/            id = timestamp_tipo
 *     manifest.json                            metadati + checksum SHA-256
 *     data/<collection>.ndjson[.gz]            una riga EJSON per documento
 *     indexes/<collection>.json                indici (solo MongoDB, solo full)
 *     schema/<tabella>.sql                     CREATE TABLE (solo MySQL)
 *   <dest>/<connessione>_<db>/catalog.json     catalogo dei backup del gruppo
 *
 * Tipi di backup:
 *   full          — tutti i documenti/righe.
 *   incremental   — solo le modifiche dall'ULTIMO backup (di qualsiasi tipo).
 *   differential  — solo le modifiche dall'ultimo backup FULL.
 *
 * Le modifiche sono individuate da un campo data (--since-field, es.
 * updatedAt); senza campo: MongoDB usa il timestamp degli ObjectId (cattura
 * solo i nuovi inserimenti), MySQL e PostgreSQL cercano colonne canoniche
 * (updated_at, ...) e in mancanza eseguono il dump completo della tabella.
 * Le cancellazioni non vengono mai catturate dai backup incrementali/
 * differenziali.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { EJSON } = require('bson');
const { ObjectId } = require('mongodb');
const {
  createFileSink, safeName, makeBackupId, readCatalog, appendToCatalog, readManifest, formatBytes, backupPathKey,
} = require('./util');
const { isSqlGeometryType } = require('../../db/geometry');
// Come si scrive il nome di una tabella o di una colonna: regola unica,
// condivisa con gli adattatori, col DDL e col frontend.
const { quotaSempre } = require('../../db/identificatori');

// Il nome quotato per MySQL. Come per PostgreSQL (`pgQid`), la regola non e'
// del motore di backup: e' la stessa che usano gli adattatori.
const myQid = (name) => quotaSempre(name, 'mysql');
const { pgCreateTable, pgAuxDdl, pgSchemaObjects, pgColonneDaSalvare } = require('../../db/pg-ddl');
const {
  MANIFEST_VERSION, leggiIdentitaMySql, leggiIdentitaPostgres, validaManifestIdentita,
} = require('./identity');

const TOOL_VERSION = MANIFEST_VERSION;

// Dimensione e SHA-256 di un file appena scritto. Dati, schema e indici devono
// essere tutti verificabili prima di un ripristino.
function fileDigest(fullPath) {
  const buf = fs.readFileSync(fullPath);
  return { bytes: buf.length, sha256: require('crypto').createHash('sha256').update(buf).digest('hex') };
}
const SINCE_COLUMN_CANDIDATES = [
  'updated_at', 'updatedAt', 'modified_at', 'last_modified', 'last_updated', 'created_at', 'createdAt',
];

// Determina il backup di partenza per incremental/differential dal catalogo.
function resolveBase(groupDir, type, expected) {
  if (type === 'full') return null;
  const backups = readCatalog(groupDir).backups.filter((b) => b.status === 'ok');
  const base = type === 'differential'
    ? [...backups].reverse().find((b) => b.type === 'full')
    : backups[backups.length - 1];
  if (!base) {
    throw new Error(`Nessun backup ${type === 'differential' ? 'full' : ''} precedente in ${groupDir}: esegui prima un backup full.`);
  }
  const id = String(base.id || '');
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new Error('Il catalogo contiene un id di backup di base non valido.');
  }
  const manifest = readManifest(path.join(groupDir, id));
  const identityInfo = validaManifestIdentita(manifest);
  if (identityInfo.historical) {
    throw new Error(
      `Il backup di base ${id} usa un manifest storico senza identita dichiarata: `
      + 'esegui un nuovo backup full prima di creare incrementali o differenziali.'
    );
  }
  const normType = (v) => String(v === 'postgres' ? 'postgresql' : v);
  if (manifest.id !== id
      || manifest.connection !== String(expected.connName)
      || manifest.db !== String(expected.db)
      || normType(manifest.dbType) !== normType(expected.dbType)
      || !['full', 'incremental', 'differential'].includes(manifest.type)
      || !Number.isFinite(Date.parse(manifest.startedAt))) {
    throw new Error(`Il backup di base ${id} non appartiene semanticamente a questa catena.`);
  }
  if (type === 'differential' && manifest.type !== 'full') {
    throw new Error(`Il backup differenziale richiede una base full, ma ${id} è ${manifest.type}.`);
  }
  return { ...base, ...manifest };
}

function legacySafeName(name) {
  return String(name).replace(/[^\w.-]+/g, '_');
}

// Le installazioni aggiornate possono avere catene create col vecchio nome
// lossy. Le si riusa solo se OGNI manifest del catalogo prova che il gruppo
// appartiene esattamente alla stessa connessione e allo stesso database; in
// presenza di una vecchia collisione si parte invece nel nuovo gruppo sicuro.
function legacyGroupCompatible(groupDir, connName, db, dbType) {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(groupDir, 'catalog.json'), 'utf8'));
    const entries = (catalog.backups || []).filter((b) => b && b.status === 'ok');
    if (!entries.length) return false;
    const tipo = String(dbType === 'postgres' ? 'postgresql' : dbType);
    return entries.every((entry) => {
      const id = String(entry.id || '');
      if (!/^[\w.-]+$/.test(id)) return false;
      const manifest = JSON.parse(fs.readFileSync(path.join(groupDir, id, 'manifest.json'), 'utf8'));
      const tipoManifest = String(manifest.dbType === 'postgres' ? 'postgresql' : manifest.dbType);
      return manifest.connection === String(connName)
        && manifest.db === String(db)
        && tipoManifest === tipo;
    });
  } catch {
    return false;
  }
}

function backupGroupDir(destRoot, connName, db, dbType) {
  const hardened = path.join(destRoot, `${safeName(connName)}_${safeName(db)}`);
  if (fs.existsSync(hardened)) {
    const stat = fs.lstatSync(hardened);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Il gruppo di backup non può essere un file, link simbolico o junction: ${hardened}.`);
    }
    return hardened;
  }
  const legacy = path.join(destRoot, `${legacySafeName(connName)}_${legacySafeName(db)}`);
  if (legacy !== hardened && fs.existsSync(legacy)) {
    const stat = fs.lstatSync(legacy);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Il gruppo di backup legacy non può essere un file, link simbolico o junction: ${legacy}.`);
    }
    if (legacyGroupCompatible(legacy, connName, db, dbType)) return legacy;
  }
  return hardened;
}

function assertUniqueFilePaths(files) {
  const seen = new Map();
  for (const f of files) {
    const rel = String(f.path || '').replace(/\\/g, '/');
    const key = backupPathKey(rel);
    if (!rel) throw new Error('Il backup ha prodotto un file senza percorso.');
    if (seen.has(key)) {
      const previous = seen.get(key);
      throw new Error(
        `Collisione nei file di backup: ${previous.path} (${previous.collection || previous.kind}) e ${rel} `
        + `(${f.collection || f.kind}) indicano lo stesso percorso.`
      );
    }
    seen.set(key, f);
  }
}

/* --- Dump MongoDB --------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Confine temporale dei backup incrementali (CDB-32)
 *
 * Un incrementale seleziona le righe con "campo data > istante dell'ultimo
 * backup". Il confronto però avviene con la precisione del campo e del DBMS:
 * al SECONDO su MySQL (FROM_UNIXTIME di un intero) e sui timestamp degli
 * ObjectId di MongoDB. Le righe scritte NELLO STESSO SECONDO del backup
 * precedente, ma dopo il suo passaggio, cadono quindi nel buco fra i due
 * backup: non sono nel primo perché non c'erano ancora, e non sono nel secondo
 * perché non superano il confronto. Il dato manca senza alcun errore, e ci si
 * accorge del buco solo al ripristino.
 *
 * Si arretra perciò il confine di un margine. Il costo è qualche riga
 * ripetuta fra due layer, che il restore applica in upsert (REPLACE / ON
 * CONFLICT DO UPDATE / replaceOne upsert): riscrivere un valore identico è
 * innocuo, perderlo no.
 * ------------------------------------------------------------------------- */
// Env CODEDB_BACKUP_MARGINE_MS: 0 disattiva il margine (selezione esatta, utile
// nei test e per chi preferisce la minima ridondanza sapendo cosa rischia).
const MARGINE_INCREMENTALE_MS = 2000;

function margineIncrementale() {
  const m = parseInt(process.env.CODEDB_BACKUP_MARGINE_MS, 10);
  return Number.isFinite(m) ? Math.max(m, 0) : MARGINE_INCREMENTALE_MS;
}

function confineIncrementale(since) {
  return new Date(new Date(since).getTime() - margineIncrementale());
}

async function dumpMongo({ strategy, db, collections, type, since, sinceField, backupDir, compress, level, log }) {
  const client = strategy.client;
  const files = [];
  const notes = [];

  for (const coll of collections) {
    const collection = client.db(db).collection(coll);
    let filter = {};
    let mode = 'full';
    let sinceColumn = null;
    if (since) {
      mode = 'incremental';
      if (sinceField) {
        sinceColumn = sinceField;
        filter = { [sinceField]: { $gt: confineIncrementale(since) } };
      } else {
        sinceColumn = '_id';
        filter = { _id: { $gt: ObjectId.createFromTime(Math.floor(confineIncrementale(since).getTime() / 1000)) } };
        notes.push(`"${coll}": modifiche individuate dal timestamp degli ObjectId — solo i nuovi inserimenti, non gli aggiornamenti (usa --since-field per un campo data).`);
      }
    }

    const rel = `data/${safeName(coll)}.ndjson${compress ? '.gz' : ''}`;
    const sink = createFileSink(path.join(backupDir, rel), { compress, level });
    let count = 0;
    const columns = new Set(['_id']);
    const cursor = collection.find(filter).batchSize(1000);
    let digest;
    try {
      for await (const doc of cursor) {
        for (const column of Object.keys(doc)) columns.add(column);
        await sink.writeLine(EJSON.stringify(doc, { relaxed: true }));
        count += 1;
      }
      digest = await sink.close();
    } catch (err) {
      await cursor.close().catch(() => {});
      await sink.abort(err);
      throw err;
    }
    const { bytes, sha256 } = digest;
    const sourceCardinality = await collection.countDocuments({});
    files.push({
      path: rel, collection: coll, kind: 'data', mode, sinceColumn, count, bytes, sha256,
      columns: [...columns], identity: { kind: 'mongodb-id', columns: ['_id'] },
      sourceCardinality, sourceDistinctIdentities: sourceCardinality,
    });
    log.info(`  ${coll}: ${count} documenti → ${rel} (${formatBytes(bytes)})`);

    // Gli indici servono solo al restore del layer full.
    if (type === 'full') {
      const indexes = await collection.indexes();
      const relIdx = `indexes/${safeName(coll)}.json`;
      fs.mkdirSync(path.join(backupDir, 'indexes'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relIdx), JSON.stringify(EJSON.serialize(indexes, { relaxed: true }), null, 2), 'utf8');
      files.push({ path: relIdx, collection: coll, kind: 'indexes', ...fileDigest(path.join(backupDir, relIdx)) });
    }
  }

  // Oggetti di database che non sono documenti: view e OPZIONI delle
  // collection. Le opzioni sono la parte che sorprende: un validatore, una
  // collection capped o una collation di default non stanno nei documenti né
  // negli indici, quindi un restore le perdeva tutte e il database ripristinato
  // accettava scritture che l'originale rifiutava. Solo nel full: gli
  // incrementali contengono modifiche, non la forma del database.
  if (type === 'full') {
    const oggetti = { views: [], collectionOptions: [] };
    const tutte = await client.db(db).listCollections().toArray();
    for (const info of tutte) {
      if (info.type === 'view') {
        oggetti.views.push({
          name: info.name,
          viewOn: info.options && info.options.viewOn,
          pipeline: (info.options && info.options.pipeline) || [],
          collation: info.options && info.options.collation,
        });
        continue;
      }
      if (!collections.includes(info.name)) continue;
      const opzioni = { ...(info.options || {}) };
      // Non sono opzioni ricreabili: l'uuid appartiene all'istanza di origine e
      // `idIndex` viene ricreato insieme agli indici.
      delete opzioni.uuid;
      delete opzioni.idIndex;
      if (Object.keys(opzioni).length) oggetti.collectionOptions.push({ name: info.name, options: opzioni });
    }
    if (oggetti.views.length || oggetti.collectionOptions.length) {
      const relOgg = 'objects/schema.json';
      fs.mkdirSync(path.join(backupDir, 'objects'), { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, relOgg),
        JSON.stringify(EJSON.serialize(oggetti, { relaxed: true }), null, 2), 'utf8',
      );
      files.push({ path: relOgg, collection: null, kind: 'objects', ...fileDigest(path.join(backupDir, relOgg)) });
      log.info(`  Oggetti di schema: ${oggetti.views.length} view, ${oggetti.collectionOptions.length} collection con opzioni`);
    }
  }
  return { files, notes };
}

/* --- Dump MySQL ----------------------------------------------------------- */

// Sceglie la colonna data per l'incrementale della tabella: quella esplicita
// (--since-field, se esiste) oppure la prima tra le candidate canoniche.
async function mysqlSinceColumn(conn, db, table, sinceField) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dtype FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table]
  );
  const dateCols = new Set(
    cols.filter((c) => ['timestamp', 'datetime', 'date'].includes(String(c.dtype).toLowerCase())).map((c) => c.name)
  );
  if (sinceField) return dateCols.has(sinceField) ? sinceField : null;
  return SINCE_COLUMN_CANDIDATES.find((c) => dateCols.has(c)) || null;
}

/**
 * Oggetti di schema MySQL che NON sono tabelle: view, routine, trigger, eventi.
 *
 * Erano il buco dichiarato del motore: un backup "riuscito" di un database con
 * delle view lo ripristinava senza, e nessun conteggio di righe lo segnalava —
 * i conteggi tornavano, perché le view non hanno righe proprie. È anche il
 * motivo per cui la rinomina di un database era stata disabilitata: senza
 * questi oggetti, dump + restore non è una rinomina ma una perdita silenziosa.
 *
 * `SHOW CREATE ...` è la forma autorevole (la stessa che usa mysqldump):
 * ricostruire le definizioni da information_schema perderebbe DEFINER,
 * SQL SECURITY, il corpo esatto delle routine e i delimitatori dei trigger.
 */
async function mysqlSchemaObjects(conn, db) {
  const mysql = require('mysql2');
  const qdb = myQid(db);
  const out = { views: [], routines: [], triggers: [], events: [] };

  const [views] = await conn.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'VIEW' ORDER BY TABLE_NAME`,
    [db],
  );
  for (const v of views) {
    const [[row]] = await conn.query(`SHOW CREATE VIEW ${qdb}.${myQid(v.name)}`);
    if (row && row['Create View']) out.views.push({ name: v.name, ddl: String(row['Create View']) });
  }

  const [routines] = await conn.query(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    [db],
  );
  for (const r of routines) {
    const tipo = String(r.type).toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
    const [[row]] = await conn.query(`SHOW CREATE ${tipo} ${qdb}.${myQid(r.name)}`);
    const ddl = row && (row[`Create ${tipo === 'FUNCTION' ? 'Function' : 'Procedure'}`]);
    if (ddl) out.routines.push({ name: r.name, type: tipo, ddl: String(ddl) });
  }

  const [triggers] = await conn.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS onTable FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME`,
    [db],
  );
  for (const t of triggers) {
    const [[row]] = await conn.query(`SHOW CREATE TRIGGER ${qdb}.${myQid(t.name)}`);
    if (row && row['SQL Original Statement']) {
      out.triggers.push({ name: t.name, table: t.onTable, ddl: String(row['SQL Original Statement']) });
    }
  }

  // Gli eventi esistono solo se lo scheduler è compilato: su alcune varianti
  // (e su MariaDB con feature disattivate) la tabella non è interrogabile, e
  // non è un motivo per far fallire un backup.
  try {
    const [events] = await conn.query(
      `SELECT EVENT_NAME AS name FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
      [db],
    );
    for (const e of events) {
      const [[row]] = await conn.query(`SHOW CREATE EVENT ${qdb}.${myQid(e.name)}`);
      if (row && row['Create Event']) out.events.push({ name: e.name, ddl: String(row['Create Event']) });
    }
  } catch { /* scheduler eventi non disponibile: nessun evento da salvare */ }

  return out;
}

/**
 * Chiavi esterne di una tabella, separate dalla sua CREATE TABLE.
 *
 * `SHOW CREATE TABLE` le include in linea, e questo rende il ripristino
 * dipendente dall'ordine alfabetico delle tabelle: se la figlia viene creata
 * prima della padre, MySQL rifiuta con ER_FK_CANNOT_OPEN_PARENT e la tabella
 * (con le sue righe) sparisce dal ripristino. Estraendole si possono applicare
 * alla fine, quando tutte le tabelle esistono e i dati sono dentro — che è
 * anche l'unico ordine in cui i dati stessi non violano i vincoli.
 *
 * A differenza di PostgreSQL, MySQL non ha un `pg_get_constraintdef`: la forma
 * testuale di `SHOW CREATE TABLE` è l'unica fonte completa della definizione
 * (azione referenziale compresa), quindi l'estrazione è per forza testuale.
 * Ciò che NON deve restare affidato al testo è il CONTO: `atteseDalCatalogo`
 * arriva da `information_schema` e, se non coincide con quante righe si sono
 * riconosciute, il backup si ferma. Una regex che smette di corrispondere —
 * per un cambio di formato di MySQL, o per una clausola non prevista —
 * produrrebbe altrimenti uno schema privo di vincoli senza dire niente a
 * nessuno: esattamente il tipo di silenzio che questo audit ha inseguito.
 */
function splitMySqlForeignKeys(createTable, tableName, atteseDalCatalogo = null) {
  const mysql = require('mysql2');
  const righe = String(createTable).split('\n');
  const tenute = [];
  const fk = [];
  for (const riga of righe) {
    const m = riga.match(/^\s*CONSTRAINT\s+(`(?:[^`]|``)+`)\s+FOREIGN KEY\s(.*?),?\s*$/i);
    if (m) {
      fk.push(`ALTER TABLE ${myQid(tableName)} ADD CONSTRAINT ${m[1]} FOREIGN KEY ${m[2]};`);
    } else {
      tenute.push(riga);
    }
  }
  if (atteseDalCatalogo != null && fk.length !== atteseDalCatalogo) {
    throw new Error(
      `Chiavi esterne di "${tableName}": il catalogo ne dichiara ${atteseDalCatalogo}, `
      + `ma nella CREATE TABLE ne sono state riconosciute ${fk.length}. `
      + 'Il backup si ferma invece di produrre uno schema incompleto.'
    );
  }
  if (!fk.length) return { ddl: String(createTable), foreignKeys: [] };
  // Tolta l'ultima voce dell'elenco, la precedente resta con una virgola
  // sospesa: `CREATE TABLE (a INT,\n) ENGINE=...` non è sintassi valida.
  for (let i = tenute.length - 1; i >= 0; i--) {
    if (/^\s*\)/.test(tenute[i])) continue;
    tenute[i] = tenute[i].replace(/,\s*$/, '');
    break;
  }
  return { ddl: tenute.join('\n'), foreignKeys: fk };
}

/**
 * Colonne geometriche di una tabella MySQL, con il loro SRID.
 *
 * Il motore non può appoggiarsi alla cache della strategia: gira sulla propria
 * connessione dentro la transazione di snapshot, e deve descrivere lo stesso
 * istante dei dati.
 *
 * @returns {Promise<Map<string, {srid: number|null}>>}
 */
/**
 * Metadati delle colonne da salvare, e come leggerle senza perdere nulla.
 *
 * Tre decisioni vivono qui, tutte imparate da difetti reali (CDB-A86):
 *
 *  1. le colonne GENERATE (STORED o VIRTUAL) si ESCLUDONO. Sono derivate dalle
 *     altre, come una view lo è dalle tabelle; MySQL rifiuta un INSERT che le
 *     valorizzi, quindi salvarle faceva fallire il ripristino dell'intera
 *     tabella. La destinazione le ricalcola dalla CREATE TABLE del backup;
 *
 *  2. le GEOMETRIE si leggono come WKB esadecimale. Il driver le consegna
 *     altrimenti come `{x, y}`, forma che perde tipo e SRID e che non si può
 *     reinserire;
 *
 *  3. i BIGINT si leggono come TESTO. Il driver li converte in Number, e oltre
 *     2^53 il valore CAMBIA: -9223372036854775808 tornava
 *     -9223372036854776000. Il backup riusciva, il ripristino falliva con "Out
 *     of range" — e senza il vincolo di dominio avrebbe invece salvato un
 *     numero diverso da quello che c'era, senza dirlo a nessuno. DECIMAL non ha
 *     questo problema: mysql2 lo consegna già come stringa.
 *
 * @returns {Promise<{nomi: string[], geo: Map<string, {srid: number|null}>, select: string}>}
 */
// Tipi che il driver consegna come Buffer: vanno salvati in esadecimale.
// `bit` è incluso: BIT(n) arriva come Buffer esattamente come un BLOB.
const TIPI_BINARI_MYSQL = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit',
]);

// Tipi temporali: si salvano come testo per non passare dal Date di JavaScript,
// che tronca i microsecondi e reinterpreta i TIMESTAMP nel fuso del client.
const TIPI_TEMPORALI_MYSQL = new Set(['date', 'datetime', 'timestamp', 'time']);

async function mysqlColumnMeta(conn, db, table) {
  const mysql = require('mysql2');
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dtype, COLUMN_TYPE AS ctype, EXTRA AS extra, SRS_ID AS srid,
            IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [db, table],
  );
  const salvabili = rows.filter((r) => !/GENERATED/i.test(String(r.extra || '')));
  const geo = new Map();
  const pezzi = [];
  for (const r of salvabili) {
    const id = myQid(r.name);
    const tipo = String(r.dtype || '').toLowerCase();
    if (isSqlGeometryType(r.dtype)) {
      geo.set(r.name, { srid: r.srid == null ? null : Number(r.srid) });
      pezzi.push(`HEX(ST_AsBinary(${id})) AS ${id}`);
    } else if (TIPI_BINARI_MYSQL.has(tipo)) {
      // I binari il driver li consegna come Buffer, che NON sopravvive al
      // giro EJSON del file NDJSON: torna come oggetto e MySQL lo rifiuta
      // ("Data too long"). In esadecimale sono testo puro ed esatti.
      pezzi.push(`HEX(${id}) AS ${id}`);
    } else if (tipo === 'bigint' || TIPI_TEMPORALI_MYSQL.has(tipo)) {
      // BIGINT: vedi sopra. Date e orari: il driver li converte in Date di
      // JavaScript, che ha risoluzione al MILLISECONDO — un DATETIME(6) con
      // .999999 tornava .999000, e un TIMESTAMP passava anche per il fuso
      // orario del client. Come testo restano esattamente ciò che erano.
      pezzi.push(`CAST(${id} AS CHAR) AS ${id}`);
    } else {
      pezzi.push(id);
    }
  }
  return {
    nomi: salvabili.map((r) => r.name),
    columns: salvabili.map((r) => ({ name: r.name, nullable: String(r.nullable).toUpperCase() === 'YES' })),
    columnSchema: salvabili.map((r) => ({
      name: r.name,
      type: String(r.ctype || r.dtype).toLowerCase(),
      nullable: String(r.nullable).toUpperCase() === 'YES',
    })),
    geo,
    select: pezzi.join(', '),
  };
}

async function mysqlStableIdentity(conn, db, table, columns) {
  return (await leggiIdentitaMySql((sql, params) => conn.query(sql, params), db, table, columns))[0] || null;
}

async function dumpMySql({ strategy, db, collections, since, sinceField, backupDir, compress, level, log }) {
  const mysql = require('mysql2');
  const pool = strategy.pool;
  const conn = await pool.getConnection();
  const files = [];
  const notes = [];
  let inTransaction = false;
  try {
    // Un'unica snapshot per tutte le tabelle: senza, ogni SELECT vedeva un
    // istante diverso e il backup poteva contenere riferimenti orfani pur
    // completandosi senza errori. La transazione mantiene inoltre i metadata
    // lock fino al COMMIT, impedendo DDL concorrenti durante schema + dati.
    await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    inTransaction = true;

    const chiaviEsterne = [];
    for (const table of collections) {
      // Definizione della tabella, per ricrearla al restore. Le chiavi esterne
      // vengono estratte e applicate alla fine: vedi splitMySqlForeignKeys.
      const [[create]] = await conn.query(`SHOW CREATE TABLE ${myQid(db)}.${myQid(table)}`);
      // Le FK si tolgono dal testo della CREATE TABLE, ma il loro numero viene
      // confrontato con il CATALOGO: se la rimozione testuale non corrisponde a
      // ciò che il database dichiara, il backup si ferma invece di produrre uno
      // schema incompleto. Vedi splitMySqlForeignKeys.
      const [fkCatalogo] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
        [db, table],
      );
      const separato = splitMySqlForeignKeys(
        String(create['Create Table']), table, Number(fkCatalogo[0].n) || 0,
      );
      if (separato.foreignKeys.length) chiaviEsterne.push(...separato.foreignKeys);
      const relSchema = `schema/${safeName(table)}.sql`;
      fs.mkdirSync(path.join(backupDir, 'schema'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relSchema), separato.ddl + ';\n', 'utf8');
      // Checksum anche per lo schema: il restore lo ESEGUE, quindi deve poter
      // verificare che il file non sia stato alterato sul disco.
      files.push({ path: relSchema, collection: table, kind: 'schema', ...fileDigest(path.join(backupDir, relSchema)) });

      let mode = 'full';
      let sinceColumn = null;
      let where = '';
      const params = [];
      if (since) {
        sinceColumn = await mysqlSinceColumn(conn, db, table, sinceField);
        if (sinceColumn) {
          mode = 'incremental';
          // FROM_UNIXTIME confronta l'istante assoluto: passare una Date
          // farebbe serializzare a mysql2 l'ora locale del client, sbagliata
          // quando il server è in un altro fuso orario.
          where = ` WHERE ${myQid(sinceColumn)} > FROM_UNIXTIME(?)`;
          // Millisecondi (non secondi interi): FROM_UNIXTIME accetta i decimali.
          params.push(confineIncrementale(since).getTime() / 1000);
        } else {
          notes.push(`"${table}": nessuna colonna data utilizzabile — inclusa per intero nel backup incrementale.`);
        }
      }

      const rel = `data/${safeName(table)}.ndjson${compress ? '.gz' : ''}`;
      const sink = createFileSink(path.join(backupDir, rel), { compress, level });
      let count = 0;
      // Le colonne GEOMETRY non possono essere lette con `SELECT *`: il driver
      // le consegna come oggetti `{x, y}` (o array di punti), una forma che
      // PERDE il tipo geometrico e il SRID e che MySQL rifiuta di reinserire
      // — "Cannot get geometry object from data you send to the GEOMETRY
      // field". Il backup riusciva e il ripristino falliva riga per riga.
      //
      // Si salvano come WKB esadecimale e NON come GeoJSON, che pure è la
      // convenzione dell'interfaccia (vedi geometry.js). Il motivo è la
      // FEDELTÀ: ST_AsGeoJSON normalizza l'orientamento degli anelli di un
      // poligono, e un anello invertito su un SRS geografico può scambiare
      // l'interno con l'esterno — cioè restituire il complemento del poligono
      // originale, senza errori e senza che nulla lo segnali. Un backup deve
      // restituire il dato che ha preso, non un dato equivalente secondo
      // qualche convenzione. WKB è la rappresentazione esatta.
      // La lista si costruisce sempre per nome, mai `SELECT *`: è ciò che
      // permette di escludere le generate e di leggere geometrie e BIGINT in
      // una forma che si può reinserire. Vedi mysqlColumnMeta.
      const meta = await mysqlColumnMeta(conn, db, table);
      const { geo: geoCols, select: selectList } = meta;
      if (!selectList) throw new Error(`La tabella "${table}" non ha colonne salvabili.`);
      const identity = await mysqlStableIdentity(conn, db, table, meta.columns);
      if (since && !identity) {
        throw new Error(
          `La tabella "${table}" non ha un'identita stabile (PRIMARY KEY o UNIQUE interamente NOT NULL): `
          + 'backup incrementale/differenziale rifiutato.'
        );
      }
      if (geoCols.size) {
        notes.push(`"${table}": ${geoCols.size} colonne geometriche salvate come WKB esadecimale.`);
      }

      // Streaming riga per riga sulla connessione non-promise: nessun
      // caricamento in memoria dell'intera tabella.
      const stream = conn.connection
        .query({ sql: `SELECT ${selectList} FROM ${myQid(db)}.${myQid(table)}${where}`, values: params })
        .stream();
      let digest;
      try {
        for await (const row of stream) {
          // HEX() restituisce già una stringa esadecimale: va nel file così
          // com'è, e il restore la riconosce dal tipo della colonna di
          // destinazione (vedi mysqlGeoTargetColumns).
          await sink.writeLine(EJSON.stringify(row, { relaxed: true }));
          count += 1;
        }
        digest = await sink.close();
      } catch (err) {
        stream.destroy();
        await sink.abort(err);
        throw err;
      }
      const { bytes, sha256 } = digest;
      // Il SRID di ORIGINE di ogni colonna geometrica va nel manifest: il WKB
      // non lo contiene, e senza di esso il restore non saprebbe in quale
      // sistema di riferimento la geometria era espressa.
      const geoSrid = geoCols.size
        ? Object.fromEntries([...geoCols].map(([c, i]) => [c, i.srid == null ? 0 : i.srid]))
        : undefined;
      const distinctExpr = identity
        ? `COUNT(DISTINCT ${identity.columns.map(myQid).join(', ')})`
        : 'NULL';
      const [[sourceCounts]] = await conn.query(
        `SELECT COUNT(*) AS cardinality, ${distinctExpr} AS distinctIdentities `
        + `FROM ${myQid(db)}.${myQid(table)}`,
      );
      const sourceCardinality = Number(sourceCounts.cardinality);
      const sourceDistinctIdentities = identity ? Number(sourceCounts.distinctIdentities) : null;
      files.push({
        path: rel, collection: table, kind: 'data', mode, sinceColumn, count, bytes, sha256, geoSrid,
        columns: meta.nomi, columnSchema: meta.columnSchema, identity,
        sourceCardinality, sourceDistinctIdentities,
      });
      log.info(`  ${table}: ${count} righe → ${rel} (${formatBytes(bytes)})`);
    }
    // Oggetti di schema e chiavi esterne: un solo file per backup, applicato
    // dal restore DOPO tabelle e dati. Sta dentro la stessa transazione delle
    // letture, così descrive lo stesso istante dei dati.
    const oggetti = await mysqlSchemaObjects(conn, db);
    oggetti.foreignKeys = chiaviEsterne;
    const totale = oggetti.views.length + oggetti.routines.length
      + oggetti.triggers.length + oggetti.events.length + chiaviEsterne.length;
    if (totale) {
      const relOgg = 'objects/schema.json';
      fs.mkdirSync(path.join(backupDir, 'objects'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relOgg), JSON.stringify(oggetti, null, 2), 'utf8');
      files.push({ path: relOgg, collection: null, kind: 'objects', ...fileDigest(path.join(backupDir, relOgg)) });
      log.info(
        `  Oggetti di schema: ${oggetti.views.length} view, ${oggetti.routines.length} routine, `
        + `${oggetti.triggers.length} trigger, ${oggetti.events.length} eventi, ${chiaviEsterne.length} chiavi esterne`
      );
    }

    await conn.query('COMMIT');
    inTransaction = false;
    return { files, notes };
  } catch (err) {
    if (inTransaction) await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Il nome quotato per PostgreSQL. La regola non e' del motore di backup: sta
// in db/identificatori.js insieme a quella degli altri motori.
function pgQid(name) {
  return quotaSempre(name, 'postgresql');
}

/**
 * Schema in cui PostgreSQL risolve davvero un nome di tabella non qualificato.
 *
 * `to_regclass` applica esattamente le stesse regole del `search_path` usate
 * dalle query del dump, quindi è l'unico modo di sapere QUALE tabella si sta
 * salvando quando lo stesso nome esiste in più schemi.
 *
 * @returns {Promise<{ schema: string|null, ambiguous: string[] }>}
 */
async function pgResolveSchema(pool, table, preferred = null) {
  // Se il chiamante sa gia' in quale schema si trova (la UI passa lo schema come
  // "db"), quello vince: to_regclass serve solo come ripiego per i percorsi che
  // non lo conoscono.
  const ref = preferred ? `${pgQid(preferred)}.${pgQid(table)}` : table;
  const res = await pool.query(
    `SELECT n.nspname AS schema
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass($1)`,
    [ref]
  );
  const schema = res.rows.length ? res.rows[0].schema : (preferred || null);
  // Omonimi in altri schemi: non è un errore, ma va detto — è la differenza fra
  // "ho salvato public.ordini" e "ho salvato archivio.ordini".
  const others = await pool.query(
    `SELECT n.nspname AS schema
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND c.relkind IN ('r','p','v','m','f')
        AND n.nspname NOT IN ('pg_catalog','information_schema')`,
    [table]
  );
  return { schema, ambiguous: others.rows.map((r) => r.schema).filter((s) => s !== schema) };
}

// Sceglie la colonna data per l'incrementale della tabella: quella esplicita
// (--since-field, se esiste) oppure la prima tra le candidate canoniche.
//
// La ricerca è vincolata allo SCHEMA in cui la tabella viene effettivamente
// risolta: cercare per solo `table_name` su tutti gli schemi poteva far scegliere
// la colonna incrementale di una tabella OMONIMA di un altro schema, e quindi
// produrre un incrementale che filtra sulle righe sbagliate — un backup che
// riesce ma non contiene ciò che dovrebbe.
async function pgSinceColumn(pool, table, sinceField, schema = null) {
  const res = await pool.query(
    schema
      ? `SELECT column_name AS name, data_type AS dtype FROM information_schema.columns
          WHERE table_schema = $2 AND table_name = $1`
      : `SELECT column_name AS name, data_type AS dtype FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_name = $1`,
    schema ? [table, schema] : [table]
  );
  const dateCols = new Set(
    res.rows
      .filter((c) => ['timestamp without time zone', 'timestamp with time zone', 'date'].includes(String(c.dtype).toLowerCase()))
      .map((c) => c.name)
  );
  if (sinceField) return dateCols.has(sinceField) ? sinceField : null;
  return SINCE_COLUMN_CANDIDATES.find((c) => dateCols.has(c)) || null;
}

// Metadati PostgreSQL letti dallo STESSO client della snapshot. Delegare alla
// strategy userebbe pool.query(), cioè un'altra connessione: un DDL concorrente
// potrebbe allora far descrivere uno schema diverso da quello dei dati.
async function pgStableIdentity(client, table, schema, columnSchema) {
  return (await leggiIdentitaPostgres(
    (sql, params) => client.query(sql, params), schema, table, columnSchema,
  ))[0] || null;
}

/**
 * DDL della tabella PostgreSQL, dal modulo condiviso `db/pg-ddl.js`.
 *
 * Prima era una ricostruzione a mano, indipendente da quella della strategia:
 * sole colonne più PRIMARY KEY, senza UNIQUE, CHECK, indici, identità né
 * colonne generate, e con i default passati da un encoder che trasformava
 * `nextval('s'::regclass)` nella STRINGA "nextval('s'::regclass)" — cioè una
 * DDL che al ripristino assegnava un testo a una colonna intera (CDB-A87).
 *
 * Il client è quello della snapshot: lo schema descritto è lo stesso istante
 * dei dati salvati.
 */
async function pgTableDdl(client, schema, table) {
  const q = (sql, params) => client.query(sql, params);
  const ddl = await pgCreateTable(q, schema, table, { qualificato: true });
  if (!ddl) throw new Error(`La tabella PostgreSQL "${schema}.${table}" non ha colonne leggibili.`);
  return ddl;
}

async function dumpPostgreSql({ strategy, db, collections, since, sinceField, backupDir, compress, level, log }) {
  const pool = strategy.pool;
  const files = [];
  const notes = [];
  const BATCH = 1000;
  const client = await pool.connect();
  let inTransaction = false;
  // Indici e chiavi esterne di TUTTE le tabelle, raccolti qui e applicati dal
  // restore dopo tabelle e dati (terza fase).
  const indiciEFk = [];

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTransaction = true;

    // db è lo schema nel modello PostgreSQL di CodeDB. I nomi sono quindi già
    // qualificabili senza alcuna SELECT di catalogo: il lock è il primo comando
    // dopo BEGIN e precede la creazione della snapshot. Un solo LOCK statement
    // evita inoltre finestre fra una tabella e la successiva.
    const schema = String(db || 'public').trim() || 'public';
    const qualificati = new Map(collections.map(
      (table) => [table, `${pgQid(schema)}.${pgQid(table)}`]
    ));
    const lockTargets = [...qualificati.values()].sort((a, b) => a.localeCompare(b));
    await client.query(`LOCK TABLE ${lockTargets.join(', ')} IN ACCESS SHARE MODE`);

    // Solo dopo i lock si apre la snapshot e si leggono i metadati. Da questo
    // punto schema, PK e pagine dati passano tutti dallo stesso client.
    const risolte = new Map();
    for (const table of collections) {
      const resolved = await pgResolveSchema(client, table, schema);
      const qualified = qualificati.get(table);
      risolte.set(table, { resolved, qualified });
    }

    for (const table of collections) {
    // Schema in cui il nome viene davvero risolto: serve a qualificare le query
    // del dump, a scegliere la colonna incrementale giusta e a registrare nel
    // manifest COSA è stato salvato. `db` è già uno schema (vedi la nota su
    // qtable in PostgreSqlStrategy), quindi lo si preferisce quando c'è.
    const { resolved, qualified } = risolte.get(table);
    // Riferimento qualificato usato da TUTTE le query del dump: senza, il nome
    // veniva risolto dal search_path e si poteva salvare la tabella omonima di
    // un altro schema — un backup che riesce ma contiene i dati sbagliati, e un
    // restore che poi li scrive sopra quelli buoni.
    if (resolved.ambiguous.length) {
      notes.push(
        `"${table}": esiste anche negli schemi ${resolved.ambiguous.join(', ')}; ` +
        `salvata quella risolta dal search_path (${resolved.schema || 'sconosciuto'}).`
      );
      log.info(`  ATTENZIONE: "${table}" è omonima in ${resolved.ambiguous.join(', ')}: salvata ${resolved.schema || '?'}.${table}`);
    }
    const ddl = await pgTableDdl(client, resolved.schema || schema, table);
    if (ddl) {
      const relSchema = `schema/${safeName(table)}.sql`;
      fs.mkdirSync(path.join(backupDir, 'schema'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relSchema), ddl + '\n', 'utf8');
      files.push({ path: relSchema, collection: table, kind: 'schema', schema: resolved.schema || undefined, ...fileDigest(path.join(backupDir, relSchema)) });
    }

    // Indici e chiavi esterne della tabella: applicati dal restore nella terza
    // fase, quando tutte le tabelle esistono e i dati sono dentro. Una FK verso
    // una tabella non ancora creata fallisce (CDB-A85, stessa logica di MySQL).
    const aux = await pgAuxDdl(
      (sql, p) => client.query(sql, p), resolved.schema || schema, table, { qualificato: true },
    );
    indiciEFk.push(...aux.indexes, ...aux.foreignKeys);

    // Colonne da salvare e come leggerle: esclude le GENERATE (PostgreSQL
    // rifiuta un INSERT che le valorizzi) e legge `bytea` in esadecimale e i
    // temporali come testo, perché il driver li consegna come Buffer e come
    // Date — forme che perdono byte e microsecondi (CDB-A87).
    const {
      select: listaSelect, binarie: colonneBinarie, nomi: savedColumns, columnSchema,
    } = await pgColonneDaSalvare(
      (sql, p) => client.query(sql, p), resolved.schema || schema, table,
    );
    if (!listaSelect) throw new Error(`La tabella PostgreSQL "${table}" non ha colonne salvabili.`);

    let mode = 'full';
    let sinceColumn = null;
    let sinceParam = null;
    if (since) {
      sinceColumn = await pgSinceColumn(client, table, sinceField, resolved.schema);
      if (sinceColumn) {
        mode = 'incremental';
        sinceParam = confineIncrementale(since);
      } else {
        notes.push(`"${table}": nessuna colonna data utilizzabile — inclusa per intero nel backup incrementale.`);
      }
    }

    const identity = await pgStableIdentity(
      client, table, resolved.schema || schema, columnSchema,
    );
    if (since && !identity) {
      throw new Error(
        `La tabella "${table}" non ha un'identita stabile (PRIMARY KEY o UNIQUE interamente NOT NULL): `
        + 'backup incrementale/differenziale rifiutato.'
      );
    }
    const orderIdentity = identity ? identity.columns : [];
    const rel = `data/${safeName(table)}.ndjson${compress ? '.gz' : ''}`;
    const sink = createFileSink(path.join(backupDir, rel), { compress, level });
    let count = 0;

    let digest;
    try {
    if (orderIdentity.length) {
      const pkCols = orderIdentity.map(pgQid).join(', ');
      let after = null;
      for (;;) {
        const conds = [];
        const params = [];
        if (sinceParam) {
          conds.push(`${pgQid(sinceColumn)} > $${params.length + 1}`);
          params.push(sinceParam);
        }
        if (after) {
          conds.push(`(${pkCols}) > (${orderIdentity.map((_, i) => `$${params.length + i + 1}`).join(', ')})`);
          params.push(...after);
        }
        const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
        params.push(BATCH);
        const res = await client.query(
          `SELECT ${listaSelect} FROM ${qualified}${where} ORDER BY ${pkCols} LIMIT ${params.length}`,
          params
        );
        if (!res.rows.length) break;
        for (const row of res.rows) {
          await sink.writeLine(EJSON.stringify(row, { relaxed: true }));
          count += 1;
        }
        after = orderIdentity.map((c) => res.rows[res.rows.length - 1][c]);
        if (res.rows.length < BATCH) break;
      }
    } else {
      // Nessuna PK: paginazione per OFFSET (tabelle senza chiave, presumibilmente
      // piccole). ORDER BY ctid (identificatore fisico di riga, sempre presente
      // sulle tabelle base) dà un ordine STABILE tra le pagine: senza, PostgreSQL
      // non garantisce lo stesso ordine tra query e OFFSET potrebbe saltare o
      // duplicare righe.
      let offset = 0;
      for (;;) {
        const conds = [];
        const params = [];
        if (sinceParam) {
          conds.push(`${pgQid(sinceColumn)} > $1`);
          params.push(sinceParam);
        }
        const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
        params.push(BATCH, offset);
        const res = await client.query(
          `SELECT ${listaSelect} FROM ${qualified}${where} ORDER BY ctid LIMIT ${params.length - 1} OFFSET ${params.length}`,
          params
        );
        if (!res.rows.length) break;
        for (const row of res.rows) {
          await sink.writeLine(EJSON.stringify(row, { relaxed: true }));
          count += 1;
        }
        offset += res.rows.length;
        if (res.rows.length < BATCH) break;
      }
    }

      digest = await sink.close();
    } catch (err) {
      await sink.abort(err);
      throw err;
    }
    const { bytes, sha256 } = digest;
    // `schema` nel manifest: documenta da dove vengono i dati, così un restore
    // futuro (o un operatore) non deve indovinarlo.
    const distinctExpr = !identity ? 'NULL'
      : identity.columns.length === 1
        ? `COUNT(DISTINCT ${pgQid(identity.columns[0])})`
        : `COUNT(DISTINCT (${identity.columns.map(pgQid).join(', ')}))`;
    const sourceCounts = await client.query(
      `SELECT COUNT(*) AS cardinality, ${distinctExpr} AS "distinctIdentities" FROM ${qualified}`,
    );
    const sourceCardinality = Number(sourceCounts.rows[0].cardinality);
    const sourceDistinctIdentities = identity ? Number(sourceCounts.rows[0].distinctIdentities) : null;
    files.push({
      path: rel, collection: table, kind: 'data', schema: resolved.schema || undefined,
      mode, sinceColumn, count, bytes, sha256,
      columns: savedColumns, columnSchema, identity,
      sourceCardinality, sourceDistinctIdentities,
      // Colonne salvate in esadecimale: il restore deve sapere quali
      // riconvertire con decode(?, 'hex').
      binarie: colonneBinarie.size ? [...colonneBinarie] : undefined,
    });
    log.info(`  ${resolved.schema ? resolved.schema + '.' : ''}${table}: ${count} righe → ${rel} (${formatBytes(bytes)})`);
    }

    // Oggetti dello schema (view, funzioni, trigger, sequenze) e vincoli
    // differiti: un solo file per backup, applicato dal restore DOPO i dati.
    // Senza, un backup PostgreSQL di uno schema con delle view lo ripristinava
    // senza, e i conteggi di riga tornavano lo stesso (CDB-A87).
    const oggetti = await pgSchemaObjects((sql, p) => client.query(sql, p), schema);
    oggetti.foreignKeys = indiciEFk;
    const totaleOggetti = oggetti.views.length + oggetti.routines.length
      + oggetti.triggers.length + oggetti.sequences.length + indiciEFk.length;
    if (totaleOggetti) {
      const relOgg = 'objects/schema.json';
      fs.mkdirSync(path.join(backupDir, 'objects'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relOgg), JSON.stringify(oggetti, null, 2), 'utf8');
      files.push({ path: relOgg, collection: null, kind: 'objects', ...fileDigest(path.join(backupDir, relOgg)) });
      log.info(
        `  Oggetti di schema: ${oggetti.views.length} view, ${oggetti.routines.length} funzioni, `
        + `${oggetti.triggers.length} trigger, ${oggetti.sequences.length} sequenze, ${indiciEFk.length} indici/vincoli`
      );
    }

    await client.query('COMMIT');
    inTransaction = false;
    return { files, notes };
  } catch (err) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* --- Backup completo di un database --------------------------------------- */

async function runBackup({ session, connName, db, type, onlyCollections, sinceField, destRoot, compress, level, log }) {
  const { strategy, dbType } = session;
  const groupDir = backupGroupDir(destRoot, connName, db, dbType);
  const base = resolveBase(groupDir, type, { connName, db, dbType });
  const since = base ? base.startedAt : null;
  const id = makeBackupId(type);
  const backupDir = path.join(groupDir, id);
  if (fs.existsSync(backupDir)) throw new Error(`La cartella di backup esiste già: ${backupDir}`);

  // startedAt è catturato PRIMA di leggere i dati: il prossimo incrementale
  // ripartirà da qui e non perderà le scritture avvenute durante il dump.
  const startedAt = new Date().toISOString();
  if (base) log.info(`Backup ${type} basato su ${base.id} (modifiche dal ${since}).`);

  // Solo collection/tabelle "vere". Due esclusioni, per due motivi diversi:
  //
  //  - le VIEW sono derivate: i loro documenti non esistono, e vengono salvate
  //    come definizione fra gli oggetti di schema, non come dati;
  //  - le collection di SISTEMA (`system.views`, `system.js`, `system.profile`)
  //    sono strutture interne del server. `listCollections` le restituisce, e
  //    salvarle come dati produceva un backup che al ripristino falliva con
  //    "cannot write to <db>.system.views": MongoDB non accetta insert diretti
  //    lì. Bastava una view nel database perché il suo backup non fosse più
  //    ripristinabile — e il backup risultava "riuscito".
  const all = (await strategy.listCollections(db))
    .filter((c) => c.type !== 'view' && !String(c.name).startsWith('system.'))
    .map((c) => c.name);
  const collections = onlyCollections
    ? all.filter((c) => onlyCollections.includes(c))
    : all;
  if (onlyCollections) {
    for (const c of onlyCollections) {
      if (!all.includes(c)) throw new Error(`Collection/tabella "${c}" non trovata nel database "${db}".`);
    }
  }
  if (!collections.length) throw new Error(`Il database "${db}" non contiene collection/tabelle da salvare.`);

  fs.mkdirSync(backupDir, { recursive: true });
  let result;
  try {
    const args = { strategy, db, collections, type, since, sinceField, backupDir, compress, level, log };
    result = dbType === 'mysql'
      ? await dumpMySql(args)
      : (dbType === 'postgresql' || dbType === 'postgres')
        ? await dumpPostgreSql(args)
        : await dumpMongo(args);
    assertUniqueFilePaths(result.files);

    const manifest = {
      tool: 'codedb-backup',
      version: TOOL_VERSION,
      id,
      type,
      baseId: base ? base.id : null,
      connection: connName,
      dbType,
      db,
      compress,
      startedAt,
      endedAt: new Date().toISOString(),
      notes: result.notes,
      files: result.files,
    };
    validaManifestIdentita(manifest);
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await appendToCatalog(groupDir, {
      id, type, baseId: manifest.baseId, db, dbType, startedAt, endedAt: manifest.endedAt, status: 'ok',
    });
  } catch (err) {
    // Backup incompleto: la cartella parziale viene rimossa e il catalogo
    // resta intatto, così non potrà mai fare da base a un incrementale.
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignora */ }
    throw err;
  }

  const dataFiles = result.files.filter((f) => f.kind === 'data');
  const totalDocs = dataFiles.reduce((s, f) => s + f.count, 0);
  const totalBytes = dataFiles.reduce((s, f) => s + f.bytes, 0);
  for (const n of result.notes) log.info(`  Nota: ${n}`);
  return { backupDir, id, collections: dataFiles.length, totalDocs, totalBytes };
}

module.exports = { runBackup, splitMySqlForeignKeys, mysqlSchemaObjects };
