'use strict';

/* ---------------------------------------------------------------------------
 * Ripristino da una cartella di backup. Se il backup è incrementale o
 * differenziale la catena viene risolta automaticamente risalendo i baseId
 * tra le cartelle sorelle (full → ... → backup richiesto) e i layer vengono
 * applicati in ordine: il primo con INSERT, i successivi come upsert
 * (replaceOne upsert su MongoDB, REPLACE INTO su MySQL).
 *
 * Restore selettivo: --collections limita il ripristino alle collection o
 * tabelle indicate. Le cancellazioni avvenute tra un layer e l'altro non sono
 * nei backup e quindi non vengono riprodotte.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { EJSON } = require('bson');
const { readLines, readManifest } = require('./util');

const BATCH_SIZE = 500;

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
    const baseDir = path.join(parent, manifest.baseId);
    if (!fs.existsSync(baseDir)) {
      throw new Error(`Backup di base "${manifest.baseId}" non trovato in ${parent}: la catena è incompleta.`);
    }
    dir = baseDir;
  }
}

/* --- Restore MongoDB ------------------------------------------------------ */

async function restoreLayerMongo({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log }) {
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

async function restoreLayerMySql({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log }) {
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
          await conn.query(fs.readFileSync(path.join(layer.dir, schemaFile.path), 'utf8').replace(/;\s*$/, ''));
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
        if (!columns) columns = Object.keys(row);
        batch.push(columns.map((c) => toSqlValue(row[c])));
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      total += applied;
      log.info(`  ${f.collection}: ${applied} righe applicate (layer ${layer.manifest.id}, ${verb}).`);
    }
  } finally {
    conn.release();
  }
  return total;
}

/* --- Restore completo ----------------------------------------------------- */

async function runRestore({ session, backupDir, targetDb, onlyCollections, drop, log }) {
  const { strategy, dbType } = session;
  const chain = resolveChain(backupDir);
  const first = chain[0].manifest;
  if (first.dbType !== dbType) {
    throw new Error(`Il backup è di tipo "${first.dbType}" ma la connessione di destinazione è "${dbType}".`);
  }
  const db = targetDb || first.db;
  log.info(`Catena di ripristino (${chain.length} layer): ${chain.map((l) => l.manifest.id).join(' → ')}`);
  log.info(`Database di destinazione: ${db}`);

  if (onlyCollections) {
    const available = new Set(chain.flatMap((l) => l.manifest.files.filter((f) => f.kind === 'data').map((f) => f.collection)));
    for (const c of onlyCollections) {
      if (!available.has(c)) throw new Error(`Collection/tabella "${c}" non presente nel backup.`);
    }
  }

  let total = 0;
  for (let i = 0; i < chain.length; i++) {
    const args = { strategy, targetDb: db, layer: chain[i], isFirst: i === 0, onlyCollections, drop, log };
    total += dbType === 'mysql' ? await restoreLayerMySql(args) : await restoreLayerMongo(args);
  }
  return { targetDb: db, layers: chain.length, totalDocs: total };
}

module.exports = { runRestore, resolveChain };
