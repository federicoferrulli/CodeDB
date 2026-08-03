'use strict';

/* ---------------------------------------------------------------------------
 * Ripristino da una cartella di backup. Se il backup è incrementale o
 * differenziale la catena viene risolta automaticamente risalendo i baseId
 * tra le cartelle sorelle (full → ... → backup richiesto) e i layer vengono
 * applicati in ordine: il primo con INSERT, i successivi come upsert
 * (replaceOne upsert su MongoDB, REPLACE INTO su MySQL, INSERT ... ON
 * CONFLICT DO UPDATE su PostgreSQL).
 *
 * Restore selettivo: --collections limita il ripristino alle collection o
 * tabelle indicate. Le cancellazioni avvenute tra un layer e l'altro non sono
 * nei backup e quindi non vengono riprodotte.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EJSON } = require('bson');
const { readLines, readManifest } = require('./util');

const BATCH_SIZE = 500;

/* ---------------------------------------------------------------------------
 * Verifica di completezza del ripristino.
 *
 * Un restore che non ripristina nulla NON è un successo: è la peggiore delle
 * riuscite apparenti, perché arriva proprio quando serve (ripristino d'emergenza)
 * e viene confermato da UI, audit e notifica Slack. Il manifest dichiara per ogni
 * file il numero di documenti/righe (`count`), quindi il confronto con quanto
 * effettivamente applicato è possibile senza ambiguità: un layer che non contiene
 * nulla di pertinente (count 0, o collection esclusa dal restore selettivo) resta
 * legittimo, mentre righe dichiarate e non applicate sono un errore.
 * ------------------------------------------------------------------------- */
function checkApplied(problems, layer, f, applied, extra) {
  const expected = f.count;
  if (expected == null) return;              // manifest storico senza conteggio
  if (applied >= expected) return;
  problems.push(
    `${f.collection} (layer ${layer.manifest.id}): applicati ${applied} di ${expected} attesi` +
    (extra ? ` — ${extra}` : '')
  );
}

// Catena dei backup da applicare, dal full iniziale al backup richiesto.
function resolveChain(backupDir) {
  const chain = [];
  const seen = new Set();
  let dir = path.resolve(backupDir);
  const parent = path.dirname(dir);
  for (;;) {
    if (seen.has(dir)) throw new Error(`Catena di backup circolare in ${parent}: controlla i baseId dei manifest.`);
    seen.add(dir);
    const manifest = readManifest(dir);
    chain.unshift({ dir, manifest });
    if (manifest.type === 'full') return chain;
    if (!manifest.baseId) throw new Error(`Il backup ${manifest.id} è ${manifest.type} ma non ha un baseId.`);
    // Il baseId arriva da un file su disco, quindi vale come qualunque altro
    // input: `path.join(parent, '../../..')` uscirebbe dalla cartella dei
    // backup e farebbe leggere (e applicare al database) file scelti da chi ha
    // scritto il manifest — un archivio ricevuto da terzi, per esempio.
    // Un id di backup è un nome di cartella, non un percorso.
    const baseId = String(manifest.baseId);
    if (baseId.includes('/') || baseId.includes('\\') || baseId === '.' || baseId === '..') {
      throw new Error(`baseId non valido nel manifest ${manifest.id}: "${baseId}" non è un nome di backup.`);
    }
    const baseDir = path.join(parent, baseId);
    if (path.dirname(path.resolve(baseDir)) !== path.resolve(parent)) {
      throw new Error(`baseId non valido nel manifest ${manifest.id}: punta fuori dalla cartella del gruppo.`);
    }
    if (!fs.existsSync(baseDir)) {
      throw new Error(`Backup di base "${baseId}" non trovato in ${parent}: la catena è incompleta.`);
    }
    dir = baseDir;
  }
}

/* ---------------------------------------------------------------------------
 * Validazione del DDL contenuto nel backup.
 *
 * Il restore esegue `schema/*.sql` con i privilegi della connessione di
 * destinazione. Il file è fidato solo se prodotto da CodeDB e non alterato: chi
 * riesce a far puntare il restore a una cartella che controlla (o a modificare
 * una cartella di backup su disco) può altrimenti far eseguire al server SQL a
 * piacere — GRANT, DROP, creazione di utenti — aggirando del tutto la
 * classificazione delle capability, perché il contenuto non veniva mai ispezionato.
 *
 * Si valida per FORMA e per BERSAGLIO, non per numero di statement: il DDL può
 * legittimamente contenere più comandi (tabella + indici + vincoli), ma ognuno
 * deve essere un CREATE/ALTER di tabella o indice e deve riguardare la tabella
 * attesa. Tutto il resto viene rifiutato mostrando il DDL, così l'operatore vede
 * cosa è stato bloccato e può decidere (allowUnsafeSchema) invece di trovarsi
 * davanti a un muro.
 * ------------------------------------------------------------------------- */

// Normalizzazione condivisa (db/sqlText.js): via commenti e stringhe. Qui gli
// identificatori quotati vanno CONSERVATI, perche' la validazione deve poter
// riconoscere il nome della tabella attesa anche quando e' scritto `ordini` o
// "ordini".
const { stripSqlNoise, splitStatements: splitSql } = require('../../db/sqlText');

function splitStatements(sql) {
  return splitSql(sql, { keepIdentifiers: true });
}

const SAFE_DDL = /^(CREATE\s+(OR\s+REPLACE\s+)?(TEMP(ORARY)?\s+)?TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE)\b/i;

/**
 * @throws se il DDL non è una definizione della tabella attesa.
 * @returns il DDL originale, da eseguire.
 */
function assertSafeSchemaSql(sql, expectedTable, { allowUnsafeSchema = false } = {}) {
  const statements = splitStatements(sql);
  if (!statements.length) throw new Error(`Il file di schema di "${expectedTable}" è vuoto.`);

  const table = String(expectedTable);
  // Il nome può comparire quotato in tre modi diversi a seconda del DBMS: dopo
  // stripSqlNoise le virgolette sono sparite, quindi si cerca l'identificatore.
  const mentionsTable = (st) => new RegExp(`(^|[^\\w])${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`, 'i').test(st);

  const problems = [];
  for (const st of statements) {
    if (!SAFE_DDL.test(st)) {
      problems.push(`comando non ammesso: "${st.slice(0, 80)}"`);
    } else if (!mentionsTable(st)) {
      problems.push(`riguarda un'altra tabella: "${st.slice(0, 80)}"`);
    }
  }

  if (problems.length) {
    if (allowUnsafeSchema) return sql; // scelta esplicita dell'operatore
    throw new Error(
      `Lo schema di "${expectedTable}" contenuto nel backup non è una definizione di tabella valida e non verrà eseguito.\n` +
      problems.map((p) => `  · ${p}`).join('\n') +
      '\nSe il backup è di provenienza certa, ripeti il ripristino con --allow-unsafe-schema.'
    );
  }
  return sql;
}

// Legge il file di schema verificandone, quando il manifest lo dichiara, il
// checksum: un file alterato sul disco non deve poter essere eseguito.
function readSchemaFile(layerDir, schemaFile, expectedTable, opts) {
  const full = path.join(layerDir, schemaFile.path);
  const sql = fs.readFileSync(full, 'utf8');
  if (schemaFile.sha256) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (actual !== schemaFile.sha256) {
      throw new Error(
        `Il file di schema di "${expectedTable}" non corrisponde al checksum del manifest: il backup è stato alterato o è corrotto.`
      );
    }
  }
  return assertSafeSchemaSql(sql, expectedTable, opts);
}

/* --- Restore MongoDB ------------------------------------------------------ */

async function restoreLayerMongo({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems }) {
  const client = strategy.client;
  const dataFiles = layer.manifest.files.filter(
    (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
  );
  let total = 0;
  for (const f of dataFiles) {
    const collection = client.db(targetDb).collection(f.collection);
    if (isFirst && drop) await collection.drop().catch(() => {});

    let batch = [];
    let applied = 0;
    const flush = async () => {
      if (!batch.length) return;
      if (isFirst) {
        await collection.insertMany(batch, { ordered: false });
      } else {
        await collection.bulkWrite(
          batch.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
          { ordered: false }
        );
      }
      batch = [];
    };
    for await (const line of readLines(path.join(layer.dir, f.path))) {
      batch.push(EJSON.parse(line, { relaxed: false }));
      applied += 1;
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    total += applied;
    log.info(`  ${f.collection}: ${applied} documenti applicati (layer ${layer.manifest.id}).`);
    checkApplied(problems, layer, f, applied);

    // Indici: solo dal layer full, dopo i dati.
    if (isFirst) {
      const idxFile = layer.manifest.files.find((x) => x.kind === 'indexes' && x.collection === f.collection);
      if (idxFile) {
        const indexes = EJSON.deserialize(JSON.parse(fs.readFileSync(path.join(layer.dir, idxFile.path), 'utf8')), { relaxed: false });
        for (const idx of indexes) {
          if (idx.name === '_id_') continue;
          const { key, name, v, ns, ...opts } = idx;
          await collection.createIndex(key, { name, ...opts }).catch((err) => {
            log.error(`  Indice "${name}" su ${f.collection} non ricreato: ${err.message}`);
          });
        }
      }
    }
  }
  return total;
}

/* --- Restore MySQL -------------------------------------------------------- */

// Converte un valore EJSON (relaxed: Date, Binary, oggetti JSON) in un
// parametro SQL sicuro, come toSqlValue in MySqlStrategy.
function toSqlValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') {
    if (v._bsontype === 'Binary') return v.buffer;
    return JSON.stringify(v);
  }
  return v;
}

async function restoreLayerMySql({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, opts }) {
  const mysql = require('mysql2');
  const pool = strategy.pool;
  const conn = await pool.getConnection();
  let total = 0;
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(targetDb, true)}`);
    await conn.query(`USE ${mysql.escapeId(targetDb, true)}`);
    const dataFiles = layer.manifest.files.filter(
      (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
    );

    let existingTables = null;
    if (isFirst) {
      const [rows] = await conn.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [targetDb]
      );
      existingTables = new Set(rows.map(r => r.TABLE_NAME));
    }

    for (const f of dataFiles) {
      const tableId = mysql.escapeId(f.collection, true);
      if (isFirst) {
        if (drop) {
          await conn.query(`DROP TABLE IF EXISTS ${tableId}`);
          existingTables.delete(f.collection);
        }

        if (!existingTables.has(f.collection)) {
          const schemaFile = layer.manifest.files.find((x) => x.kind === 'schema' && x.collection === f.collection);
          if (!schemaFile) throw new Error(`Schema di "${f.collection}" assente dal backup: impossibile ricreare la tabella.`);
          // Checksum + validazione della forma prima di eseguire: il contenuto
          // del file arriva dal disco, non da CodeDB.
          const ddl = readSchemaFile(layer.dir, schemaFile, f.collection, opts);
          await conn.query(ddl.replace(/;\s*$/, ''));
          existingTables.add(f.collection);
        }
      }

      // I layer successivi al primo (e le tabelle senza colonna data incluse
      // per intero in un incrementale) vanno applicati come upsert.
      const verb = isFirst ? 'INSERT' : 'REPLACE';
      let batch = [];
      let columns = null;
      let applied = 0;
      const flush = async () => {
        if (!batch.length) return;
        await conn.query(
          `${verb} INTO ${tableId} (${columns.map((c) => mysql.escapeId(c, true)).join(', ')}) VALUES ?`,
          [batch]
        );
        applied += batch.length;
        batch = [];
      };
      for await (const line of readLines(path.join(layer.dir, f.path))) {
        const row = EJSON.parse(line, { relaxed: true });
        const colsRiga = Object.keys(row);
        if (!columns) columns = colsRiga;
        // Le colonne erano dedotte UNA VOLTA dalla prima riga (CDB-30): una riga
        // successiva con colonne diverse — normale su MongoDB esportato in SQL,
        // o dopo un ALTER TABLE a metà catena — perdeva i campi in più SENZA
        // dirlo, e riempiva di NULL quelli mancanti. Il gruppo di INSERT deve
        // avere una sola lista di colonne, quindi le righe di forma diversa non
        // si accodano a questo batch: si scarica il batch corrente e si riparte
        // con la forma nuova.
        const stessaForma = colsRiga.length === columns.length
          && colsRiga.every((c) => columns.includes(c));
        if (!stessaForma) {
          await flush();
          columns = colsRiga;
        }
        batch.push(columns.map((c) => toSqlValue(row[c])));
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      total += applied;
      log.info(`  ${f.collection}: ${applied} righe applicate (layer ${layer.manifest.id}, ${verb}).`);
      checkApplied(problems, layer, f, applied);
    }
  } finally {
    conn.release();
  }
  return total;
}

// Tabelle già presenti nello schema di destinazione: serve per non tentare una
// CREATE TABLE che fallirebbe (ed è l'unica ragione per cui esisteva il
// `.catch(() => {})` che nascondeva anche gli errori veri).
async function pgExistingTables(strategy, targetSchema) {
  const res = await strategy.collectionAggregate(targetSchema, null, {
    pipeline: 'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $$SCHEMA$$'
      .replace('$$SCHEMA$$', `'${String(targetSchema).replace(/'/g, "''")}'`),
    readOnly: true,
  });
  const rows = (res && (res.docs || res.rows)) || [];
  return new Set(rows.map((r) => r.tablename).filter(Boolean));
}

/**
 * Schema PostgreSQL di destinazione per un layer.
 *
 * Dopo il passaggio al modello "db della UI = schema" (vedi PostgreSqlStrategy),
 * `targetDb` è un nome di SCHEMA. I manifest scritti PRIMA di quel cambiamento
 * hanno però `db` = nome del DATABASE e non dichiarano alcuno schema: per non
 * ricreare quelle tabelle in uno schema inventato col nome del vecchio
 * database, in loro assenza si ripiega su `public`, che è dove quelle tabelle
 * stavano davvero. Un `--target-db` esplicito vince sempre.
 */
function pgTargetSchema(targetDb, layer, explicitTarget) {
  if (explicitTarget) return explicitTarget;
  const declared = (layer.manifest.files || []).find((f) => f.schema);
  if (declared) return declared.schema;
  return 'public';
}

async function restoreLayerPostgreSql({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, opts, explicitTarget }) {
  const dataFiles = layer.manifest.files.filter(
    (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
  );
  // Schema effettivo di destinazione (retro-compatibile con i backup vecchi).
  targetDb = pgTargetSchema(targetDb, layer, explicitTarget);
  log.info(`  Schema di destinazione PostgreSQL: ${targetDb}`);
  let total = 0;
  // L'elenco delle tabelle esistenti si legge una volta sola, come già fa il
  // ramo MySQL, e si aggiorna man mano.
  let existingTables = null;
  if (isFirst && dataFiles.length) {
    existingTables = await pgExistingTables(strategy, targetDb).catch((err) => {
      log.error(`  Impossibile elencare le tabelle di "${targetDb}": ${err.message}`);
      return null;
    });
  }
  for (const f of dataFiles) {
    if (isFirst) {
      if (drop) {
        await strategy.dropCollection(targetDb, f.collection).catch(() => {});
        if (existingTables) existingTables.delete(f.collection);
      }
      const schemaFile = layer.manifest.files.find((x) => x.kind === 'schema' && x.collection === f.collection);
      // Se non sappiamo cosa esiste, si prova comunque a creare: una CREATE su
      // tabella già presente fallisce in modo innocuo ed è l'unico errore che
      // qui va tollerato.
      const mustCreate = schemaFile && (!existingTables || !existingTables.has(f.collection));
      if (mustCreate) {
        const sql = readSchemaFile(layer.dir, schemaFile, f.collection, opts);
        try {
          await strategy.collectionAggregate(targetDb, f.collection, { pipeline: sql });
          if (existingTables) existingTables.add(f.collection);
        } catch (err) {
          // Senza tabella non c'è ripristino possibile: fallire qui, con il
          // motivo, invece di proseguire e concludere con "0 righe applicate".
          throw new Error(
            `Impossibile ricreare la tabella "${f.collection}" in "${targetDb}": ${err.message}`
          );
        }
      }
    }
    // Applica a batch (come i restore Mongo/MySQL): senza, l'intero file
    // verrebbe caricato in memoria — OOM su tabelle grandi.
    let batch = [];
    let applied = 0;
    let failed = 0;
    const firstErrors = [];
    const flush = async () => {
      if (!batch.length) return;
      const imp = await strategy.collectionImport(targetDb, f.collection, { docs: batch, upsert: !isFirst });
      applied += imp.inserted;
      // `collectionImport` non lancia sui singoli errori di riga: li restituisce.
      // Ignorarli significava dichiarare riuscito un ripristino di zero righe.
      failed += imp.failed || 0;
      for (const e of (imp.errors || [])) {
        if (firstErrors.length < 3) firstErrors.push(typeof e === 'string' ? e : (e.error || JSON.stringify(e)));
      }
      batch = [];
    };
    for await (const line of readLines(path.join(layer.dir, f.path))) {
      batch.push(line);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    total += applied;
    log.info(`  ${f.collection}: ${applied} righe applicate (layer ${layer.manifest.id}, ${isFirst ? 'INSERT' : 'UPSERT'}).`);
    if (failed) log.error(`  ${f.collection}: ${failed} righe NON applicate. Primi errori: ${firstErrors.join(' | ')}`);
    checkApplied(problems, layer, f, applied, failed ? `${failed} righe rifiutate (${firstErrors.join(' | ')})` : null);
  }
  return total;
}

/* --- Restore completo ----------------------------------------------------- */

async function runRestore({ session, backupDir, targetDb, onlyCollections, drop, log, allowUnsafeSchema = false }) {
  const { strategy, dbType } = session;
  const chain = resolveChain(backupDir);
  const first = chain[0].manifest;
  if (first.dbType !== dbType) {
    throw new Error(`Il backup è di tipo "${first.dbType}" ma la connessione di destinazione è "${dbType}".`);
  }
  const db = targetDb || first.db;
  // Distinzione necessaria su PostgreSQL: un --target-db indicato dall'utente
  // vince sempre, mentre `first.db` dei backup vecchi e' un nome di DATABASE,
  // non di schema (vedi pgTargetSchema).
  const explicitTarget = targetDb || null;
  log.info(`Catena di ripristino (${chain.length} layer): ${chain.map((l) => l.manifest.id).join(' → ')}`);
  log.info(`Database di destinazione: ${db}`);

  if (onlyCollections) {
    const available = new Set(chain.flatMap((l) => l.manifest.files.filter((f) => f.kind === 'data').map((f) => f.collection)));
    for (const c of onlyCollections) {
      if (!available.has(c)) throw new Error(`Collection/tabella "${c}" non presente nel backup.`);
    }
  }

  // Righe/documenti che la catena dichiara di contenere per le collection
  // effettivamente incluse nel ripristino: è il metro di paragone del risultato.
  const expected = chain.reduce((sum, l) => sum + l.manifest.files
    .filter((f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection)))
    .reduce((s, f) => s + (f.count || 0), 0), 0);

  let total = 0;
  const problems = [];
  for (let i = 0; i < chain.length; i++) {
    const args = { strategy, targetDb: db, layer: chain[i], isFirst: i === 0, onlyCollections, drop, log, problems, opts: { allowUnsafeSchema }, explicitTarget };
    total += dbType === 'mysql'
      ? await restoreLayerMySql(args)
      : (dbType === 'postgresql' || dbType === 'postgres')
        ? await restoreLayerPostgreSql(args)
        : await restoreLayerMongo(args);
  }

  const summary = { targetDb: db, layers: chain.length, totalDocs: total, expectedDocs: expected, problems };

  // Un ripristino incompleto non deve mai risultare "riuscito": né in UI, né
  // nell'audit, né nella notifica Slack. L'errore porta con sé il riepilogo, così
  // il chiamante può comunque dire quanto è stato applicato prima di fermarsi.
  if (problems.length) {
    const err = new Error(
      `Ripristino incompleto: applicati ${total} di ${expected} documenti/righe attesi. ` +
      problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` (e altri ${problems.length - 5})` : '')
    );
    err.summary = summary;
    throw err;
  }
  // Rete di sicurezza per i backup storici, i cui manifest non dichiarano
  // `count`: lì il confronto per file non è possibile, quindi zero righe
  // applicate è l'unico segnale disponibile. Un backup che dichiara zero righe
  // (collection vuote) resta invece un ripristino legittimo.
  const hasUnknownCounts = chain.some((l) => l.manifest.files.some(
    (f) => f.kind === 'data' && f.count == null && (!onlyCollections || onlyCollections.includes(f.collection))
  ));
  if (total === 0 && hasUnknownCounts) {
    const err = new Error(
      'Ripristino terminato senza applicare alcun documento/riga: verifica i permessi sul database di destinazione e il contenuto del backup.'
    );
    err.summary = summary;
    throw err;
  }
  return summary;
}

module.exports = { runRestore, resolveChain, checkApplied, assertSafeSchemaSql, splitStatements };
