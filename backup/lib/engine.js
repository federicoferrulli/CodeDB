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
  createFileSink, safeName, makeBackupId, readCatalog, appendToCatalog, formatBytes,
} = require('./util');

const TOOL_VERSION = 1;

// Dimensione e SHA-256 di un file di schema appena scritto. Il restore esegue
// questi file come SQL: senza checksum non c'è modo di accorgersi che sono stati
// modificati dopo il backup (vedi assertSafeSchemaSql in restore.js).
function schemaDigest(fullPath) {
  const buf = fs.readFileSync(fullPath);
  return { bytes: buf.length, sha256: require('crypto').createHash('sha256').update(buf).digest('hex') };
}
const SINCE_COLUMN_CANDIDATES = [
  'updated_at', 'updatedAt', 'modified_at', 'last_modified', 'last_updated', 'created_at', 'createdAt',
];

// Determina il backup di partenza per incremental/differential dal catalogo.
function resolveBase(groupDir, type) {
  if (type === 'full') return null;
  const backups = readCatalog(groupDir).backups.filter((b) => b.status === 'ok');
  const base = type === 'differential'
    ? [...backups].reverse().find((b) => b.type === 'full')
    : backups[backups.length - 1];
  if (!base) {
    throw new Error(`Nessun backup ${type === 'differential' ? 'full' : ''} precedente in ${groupDir}: esegui prima un backup full.`);
  }
  return base;
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
    const cursor = collection.find(filter).batchSize(1000);
    for await (const doc of cursor) {
      await sink.writeLine(EJSON.stringify(doc, { relaxed: true }));
      count += 1;
    }
    const { bytes, sha256 } = await sink.close();
    files.push({ path: rel, collection: coll, kind: 'data', mode, sinceColumn, count, bytes, sha256 });
    log.info(`  ${coll}: ${count} documenti → ${rel} (${formatBytes(bytes)})`);

    // Gli indici servono solo al restore del layer full.
    if (type === 'full') {
      const indexes = await collection.indexes().catch(() => []);
      const relIdx = `indexes/${safeName(coll)}.json`;
      fs.mkdirSync(path.join(backupDir, 'indexes'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relIdx), JSON.stringify(EJSON.serialize(indexes, { relaxed: true }), null, 2), 'utf8');
      files.push({ path: relIdx, collection: coll, kind: 'indexes' });
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

async function dumpMySql({ strategy, db, collections, since, sinceField, backupDir, compress, level, log }) {
  const mysql = require('mysql2');
  const pool = strategy.pool;
  const conn = await pool.getConnection();
  const files = [];
  const notes = [];
  try {
    for (const table of collections) {
      // Definizione della tabella, per ricrearla al restore.
      const [[create]] = await conn.query(`SHOW CREATE TABLE ${mysql.escapeId(db, true)}.${mysql.escapeId(table, true)}`);
      const relSchema = `schema/${safeName(table)}.sql`;
      fs.mkdirSync(path.join(backupDir, 'schema'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relSchema), String(create['Create Table']) + ';\n', 'utf8');
      // Checksum anche per lo schema: il restore lo ESEGUE, quindi deve poter
      // verificare che il file non sia stato alterato sul disco.
      files.push({ path: relSchema, collection: table, kind: 'schema', ...schemaDigest(path.join(backupDir, relSchema)) });

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
          where = ` WHERE ${mysql.escapeId(sinceColumn, true)} > FROM_UNIXTIME(?)`;
          // Millisecondi (non secondi interi): FROM_UNIXTIME accetta i decimali.
          params.push(confineIncrementale(since).getTime() / 1000);
        } else {
          notes.push(`"${table}": nessuna colonna data utilizzabile — inclusa per intero nel backup incrementale.`);
        }
      }

      const rel = `data/${safeName(table)}.ndjson${compress ? '.gz' : ''}`;
      const sink = createFileSink(path.join(backupDir, rel), { compress, level });
      let count = 0;
      // Streaming riga per riga sulla connessione non-promise: nessun
      // caricamento in memoria dell'intera tabella.
      const stream = conn.connection
        .query({ sql: `SELECT * FROM ${mysql.escapeId(db, true)}.${mysql.escapeId(table, true)}${where}`, values: params })
        .stream();
      for await (const row of stream) {
        await sink.writeLine(EJSON.stringify(row, { relaxed: true }));
        count += 1;
      }
      const { bytes, sha256 } = await sink.close();
      files.push({ path: rel, collection: table, kind: 'data', mode, sinceColumn, count, bytes, sha256 });
      log.info(`  ${table}: ${count} righe → ${rel} (${formatBytes(bytes)})`);
    }
  } finally {
    conn.release();
  }
  return { files, notes };
}

function pgQid(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
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

async function dumpPostgreSql({ strategy, db, collections, since, sinceField, backupDir, compress, level, log }) {
  const pool = strategy.pool;
  const files = [];
  const notes = [];
  const BATCH = 1000;

  for (const table of collections) {
    // Schema in cui il nome viene davvero risolto: serve a qualificare le query
    // del dump, a scegliere la colonna incrementale giusta e a registrare nel
    // manifest COSA è stato salvato. `db` è già uno schema (vedi la nota su
    // qtable in PostgreSqlStrategy), quindi lo si preferisce quando c'è.
    const resolved = await pgResolveSchema(pool, table, db).catch(() => ({ schema: db || null, ambiguous: [] }));
    // Riferimento qualificato usato da TUTTE le query del dump: senza, il nome
    // veniva risolto dal search_path e si poteva salvare la tabella omonima di
    // un altro schema — un backup che riesce ma contiene i dati sbagliati, e un
    // restore che poi li scrive sopra quelli buoni.
    const qualified = resolved.schema ? `${pgQid(resolved.schema)}.${pgQid(table)}` : pgQid(table);
    if (resolved.ambiguous.length) {
      notes.push(
        `"${table}": esiste anche negli schemi ${resolved.ambiguous.join(', ')}; ` +
        `salvata quella risolta dal search_path (${resolved.schema || 'sconosciuto'}).`
      );
      log.info(`  ATTENZIONE: "${table}" è omonima in ${resolved.ambiguous.join(', ')}: salvata ${resolved.schema || '?'}.${table}`);
    }
    const ddl = await strategy.tableDdl(db, table);
    if (ddl) {
      const relSchema = `schema/${safeName(table)}.sql`;
      fs.mkdirSync(path.join(backupDir, 'schema'), { recursive: true });
      fs.writeFileSync(path.join(backupDir, relSchema), ddl + '\n', 'utf8');
      files.push({ path: relSchema, collection: table, kind: 'schema', schema: resolved.schema || undefined, ...schemaDigest(path.join(backupDir, relSchema)) });
    }

    let mode = 'full';
    let sinceColumn = null;
    let sinceParam = null;
    if (since) {
      sinceColumn = await pgSinceColumn(pool, table, sinceField, resolved.schema);
      if (sinceColumn) {
        mode = 'incremental';
        sinceParam = confineIncrementale(since);
      } else {
        notes.push(`"${table}": nessuna colonna data utilizzabile — inclusa per intero nel backup incrementale.`);
      }
    }

    const pk = await strategy.primaryKey(db, table);
    const rel = `data/${safeName(table)}.ndjson${compress ? '.gz' : ''}`;
    const sink = createFileSink(path.join(backupDir, rel), { compress, level });
    let count = 0;

    if (pk.length) {
      const pkCols = pk.map(pgQid).join(', ');
      let after = null;
      for (;;) {
        const conds = [];
        const params = [];
        if (sinceParam) {
          conds.push(`${pgQid(sinceColumn)} > $${params.length + 1}`);
          params.push(sinceParam);
        }
        if (after) {
          conds.push(`(${pkCols}) > (${pk.map((_, i) => `$${params.length + i + 1}`).join(', ')})`);
          params.push(...after);
        }
        const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
        params.push(BATCH);
        const res = await pool.query(
          `SELECT * FROM ${qualified}${where} ORDER BY ${pkCols} LIMIT $${params.length}`,
          params
        );
        if (!res.rows.length) break;
        for (const row of res.rows) {
          await sink.writeLine(EJSON.stringify(row, { relaxed: true }));
          count += 1;
        }
        after = pk.map((c) => res.rows[res.rows.length - 1][c]);
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
        const res = await pool.query(
          `SELECT * FROM ${qualified}${where} ORDER BY ctid LIMIT $${params.length - 1} OFFSET $${params.length}`,
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

    const { bytes, sha256 } = await sink.close();
    // `schema` nel manifest: documenta da dove vengono i dati, così un restore
    // futuro (o un operatore) non deve indovinarlo.
    files.push({ path: rel, collection: table, kind: 'data', schema: resolved.schema || undefined, mode, sinceColumn, count, bytes, sha256 });
    log.info(`  ${resolved.schema ? resolved.schema + '.' : ''}${table}: ${count} righe → ${rel} (${formatBytes(bytes)})`);
  }
  return { files, notes };
}

/* --- Backup completo di un database --------------------------------------- */

async function runBackup({ session, connName, db, type, onlyCollections, sinceField, destRoot, compress, level, log }) {
  const { strategy, dbType } = session;
  const groupDir = path.join(destRoot, `${safeName(connName)}_${safeName(db)}`);
  const base = resolveBase(groupDir, type);
  const since = base ? base.startedAt : null;
  const id = makeBackupId(type);
  const backupDir = path.join(groupDir, id);
  if (fs.existsSync(backupDir)) throw new Error(`La cartella di backup esiste già: ${backupDir}`);

  // startedAt è catturato PRIMA di leggere i dati: il prossimo incrementale
  // ripartirà da qui e non perderà le scritture avvenute durante il dump.
  const startedAt = new Date().toISOString();
  if (base) log.info(`Backup ${type} basato su ${base.id} (modifiche dal ${since}).`);

  // Solo collection/tabelle "vere": le view sono derivate e non si ripristinano.
  const all = (await strategy.listCollections(db)).filter((c) => c.type !== 'view').map((c) => c.name);
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

module.exports = { runBackup };
