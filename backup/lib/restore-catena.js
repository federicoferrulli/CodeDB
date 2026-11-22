'use strict';

/* ---------------------------------------------------------------------------
 * Risoluzione della catena incrementale/differenziale, verifica preventiva
 * (preflight SHA-256 + coerenza semantica delle righe e dei tombstone),
 * validazione DDL dello schema di tabella e tracciamento delle attese.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EJSON } = require('bson');
const { readLines, readManifest, fileDelBackup, verifyBackupDir } = require('./util');
const { normalizzaLayerBackup, validaDdlCollezione } = require('../../db/artefatti');
const {
  validaManifestIdentita, chiaveIdentita, identityCompatibile,
} = require('./identity');
const { splitStatements: splitSql } = require('../../db/sqlText');

const BATCH_SIZE = 500;

/**
 * Esegue una cancellazione preparatoria ignorando esclusivamente l'errore che
 * dimostra l'assenza del bersaglio. Autorizzazione, rete e timeout conservano
 * l'errore originale: chi orchestra puo cosi auditarne codice e messaggio.
 */
async function eliminaSePresente(elimina, { dbType, target } = {}) {
  try {
    return await elimina();
  } catch (err) {
    const mongoAssente = ['mongodb', 'mongo'].includes(String(dbType))
      && (err && (err.code === 26 || err.codeName === 'NamespaceNotFound'));
    const postgresAssente = ['postgresql', 'postgres'].includes(String(dbType))
      && err && err.code === '42P01';
    if (mongoAssente || postgresAssente) return false;
    if (err && target && !err.target) err.target = target;
    throw err;
  }
}

function trackerPer(tracker, collection, identity) {
  if (!tracker.has(collection)) tracker.set(collection, {
    identity, writes: 0, expectedCardinality: null, expectedDistinctIdentities: null,
  });
  const entry = tracker.get(collection);
  if (identity && entry.identity && !identityCompatibile(entry.identity, identity)) {
    throw new Error(`L'identita dichiarata per "${collection}" cambia fra i layer della catena.`);
  }
  if (identity && !entry.identity) entry.identity = identity;
  return entry;
}

function registraFileAtteso(tracker, file) {
  const entry = trackerPer(tracker, file.collection, file.identity || null);
  entry.pgPhysical = file.pgPhysical === true;
    entry.expectedCardinality = file.replayCardinality ?? file.sourceCardinality ?? file.count ?? 0;
  entry.expectedDistinctIdentities = file.identity
    ? (file.replayCardinality ?? file.sourceDistinctIdentities ?? file.count)
    : null;
  return entry;
}

function registraAttesa(tracker, file) {
  const entry = trackerPer(tracker, file.collection, file.identity || null);
  entry.writes += 1;
  if (file.sourceCardinality == null && file.count == null) entry.expectedCardinality += 1;
}

function assertColumnsAndIdentity(file, columnSchema, actualIdentity, { empty = false } = {}) {
  const columns = columnSchema.map((c) => c.name);
  if (Array.isArray(file.columns)) {
    const actual = new Set(columns);
    const missing = file.columns.filter((c) => !actual.has(c));
    if (missing.length) {
      throw new Error(
        `La destinazione "${file.collection}" non contiene le colonne del manifest: ${missing.join(', ')}.`
      );
    }
  }
  if (Array.isArray(file.columnSchema)) {
    const byName = new Map(columnSchema.map((c) => [c.name, c]));
    for (const expected of file.columnSchema) {
      const actual = byName.get(expected.name);
      const norm = (value) => String(value).trim().replace(/\s+/g, ' ').toLowerCase();
      if (!actual || norm(actual.type) !== norm(expected.type)
          || actual.nullable !== expected.nullable) {
        throw new Error(
          `La colonna "${file.collection}.${expected.name}" non e compatibile col manifest `
          + `(tipo ${expected.type}, ${expected.nullable ? 'NULL ammesso' : 'NOT NULL'}).`
        );
      }
    }
  }
  if (file.identity && !identityCompatibile(file.identity, actualIdentity)) {
    const attesa = file.identity.columns.join(', ');
    throw new Error(
      `L'identita della destinazione "${file.collection}" non e compatibile col manifest (${attesa}).`
    );
  }
  if (!file.identity && !empty) {
    throw new Error(
      `La tabella "${file.collection}" non ha identita stabile: il full e ammesso solo verso una destinazione vuota.`
    );
  }
}

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
    validaManifestIdentita(manifest);
    chain.unshift({ dir, manifest });
    if (manifest.type === 'full') {
      const expected = chain[0].manifest;
      const normType = (v) => String(v === 'postgres' ? 'postgresql' : v);
      let previousTime = -Infinity;
      for (let i = 0; i < chain.length; i++) {
        const layer = chain[i];
        const m = layer.manifest;
        const dirId = path.basename(layer.dir);
        const time = Date.parse(m.startedAt);
        if (m.id !== dirId) throw new Error(`Il manifest ${dirId} dichiara un id diverso (${m.id}).`);
        if (!['full', 'incremental', 'differential'].includes(m.type)) throw new Error(`Tipo di backup non valido in ${m.id}.`);
        if (m.connection !== expected.connection || m.db !== expected.db || normType(m.dbType) !== normType(expected.dbType)) {
          throw new Error(`Il layer ${m.id} appartiene a una connessione/database diversa dal backup richiesto.`);
        }
        if (!Number.isFinite(time) || time < previousTime) throw new Error(`Cronologia non valida nel layer ${m.id}.`);
        if (i === 0 && m.type !== 'full') throw new Error(`La catena non inizia con un backup full (layer ${m.id}).`);
        if (i > 0 && m.baseId !== chain[i - 1].manifest.id) throw new Error(`baseId incoerente nel layer ${m.id}.`);
        if (m.type === 'differential' && chain[i - 1].manifest.type !== 'full') {
          throw new Error(`Il differenziale ${m.id} non è basato direttamente su un full.`);
        }
        previousTime = time;
      }
      const declarations = new Map(), presenti = new Set();
      for (const layer of chain) {
        require('./inventario-entita').validaCopertura(layer.manifest, presenti);
        for (const nome of layer.manifest.entityInventory?.removed || []) {
          declarations.delete(nome);
          presenti.delete(nome);
        }
        for (const f of layer.manifest.files) if (f.kind === 'data') presenti.add(f.collection);
        for (const file of layer.manifest.files.filter((f) => f && f.kind === 'data')) {
          if (Number(layer.manifest.version || 1) < 2) continue;
          const current = {
            identity: file.identity || null,
            columns: file.columns,
            columnSchema: file.columnSchema || null,
          };
          const previous = declarations.get(file.collection);
          if (previous) {
            const mongo = ['mongodb', 'mongo'].includes(String(layer.manifest.dbType));
            const sameColumns = mongo || (previous.columns.length === current.columns.length
              && previous.columns.every((c, index) => c === current.columns[index]));
            const sameSchema = mongo || previous.columnSchema.every((column, index) => {
              const other = current.columnSchema[index];
              return other && column.name === other.name && column.type === other.type
                && column.nullable === other.nullable;
            });
            if (!sameColumns || !sameSchema || !identityCompatibile(previous.identity, current.identity)) {
              throw new Error(
                `Colonne o identita di "${file.collection}" cambiano fra i layer della catena: `
                + 'serve un nuovo backup full.'
              );
            }
          } else {
            declarations.set(file.collection, current);
          }
        }
      }
      return chain;
    }
    if (!manifest.baseId) throw new Error(`Il backup ${manifest.id} è ${manifest.type} ma non ha un baseId.`);
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

/**
 * Controlla l'intera catena prima della prima modifica al database.
 */
async function preflightChain(chain, log, { allowUnsafeSchema = false, filtraErroreOrigine } = {}) {
  try { return await verificaContenutiCatena(chain, log, allowUnsafeSchema); }
  catch (err) { throw filtraErroreOrigine ? filtraErroreOrigine(err) : err; }
}

async function verificaContenutiCatena(chain, log, allowUnsafeSchema) {
  let verifiedCount = 0;
  let unverifiableCount = 0;

  for (const layer of chain) {
    let report;
    try {
      report = await verifyBackupDir(layer.dir);
    } catch (err) {
      throw new Error(
        `Verifica preventiva fallita per il layer "${layer.manifest.id || path.basename(layer.dir)}": ${err.message}`
      );
    }

    verifiedCount += report.okCount;
    unverifiableCount += report.unverifiableCount;
    if (report.failedCount || report.extraCount) {
      const problemi = report.details
        .filter((d) => d.status !== 'OK' && d.status !== 'UNVERIFIABLE')
        .slice(0, 5)
        .map((d) => `${d.file}: ${d.status}${d.error ? ` (${d.error})` : ''}`);
      throw new Error(
        `Verifica preventiva fallita per il layer "${report.backupId || layer.manifest.id}": `
        + `${report.failedCount} file mancanti, corrotti o non validi e ${report.extraCount} non dichiarati. `
        + `${problemi.join('; ')}. Nessuna modifica è stata applicata al database.`
      );
    }
    if (report.unverifiableCount && log && typeof log.info === 'function') {
      log.info(
        `  ATTENZIONE: il layer ${report.backupId || layer.manifest.id} contiene `
        + `${report.unverifiableCount} file storici senza checksum; esistenza e dimensione sono state controllate, `
        + 'ma l\'integrità del contenuto non è dimostrabile.'
      );
    }

    const schemas = layer.manifest.files.filter((f) => f.kind === 'schema' || f.kind === 'schema-standalone').map((file) => ({
      collection: file.collection,
      database: file.schema || layer.manifest.db,
      sql: fs.readFileSync(fileDelBackup(layer.dir, file.path, 'file di schema'), 'utf8'),
    }));
    const objectsFile = layer.manifest.files.find((f) => f.kind === 'objects');
    const objectText = objectsFile
      ? fs.readFileSync(fileDelBackup(layer.dir, objectsFile.path, 'file di oggetti'), 'utf8') : null;
    const objects = objectText == null ? null : layer.manifest.dbType === 'mongodb'
      ? JSON.parse(objectText) : EJSON.parse(objectText);
    for (const file of layer.manifest.files.filter(f => f.kind === 'large-objects')) {
      if (!['postgresql', 'postgres'].includes(layer.manifest.dbType)) throw new Error('Large Objects in un backup non PostgreSQL.');
      require('../../db/pg-references').validateLargeObjects(JSON.parse(fs.readFileSync(fileDelBackup(layer.dir, file.path, 'Large Objects'), 'utf8')));
    }
    const largeFiles = layer.manifest.files.filter(f => f.kind === 'large-object');
    if (largeFiles.length) {
      if (!['postgresql', 'postgres'].includes(layer.manifest.dbType)) throw new Error('Large Objects in un backup non PostgreSQL.');
      require('../../db/pg-references').validateLargeObjects(largeFiles.map(f => ({ oid: f.oid, size: 0, chunks: [] })));
      for (const file of largeFiles) if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size !== file.bytes) throw new Error('Dimensione Large Object non valida nel manifest.');
    }
    normalizzaLayerBackup({
      dbType: layer.manifest.dbType,
      database: layer.manifest.db,
      schemas,
      collections: layer.manifest.files.filter((f) => f.kind === 'data').map((f) => f.collection),
      objects,
      integrity: { verifiedCount: report.okCount, unverifiableCount: report.unverifiableCount },
    }, { allowUnsafeSchema });

    if (Number(layer.manifest.version) >= 2) {
      for (const file of layer.manifest.files.filter((f) => f.kind === 'data')) {
        if (file.encoding && (file.encoding !== 'bson-base64' || !['mongo', 'mongodb'].includes(layer.manifest.dbType))) throw new Error('Codifica dei dati di backup non supportata.');
        const declared = new Set(file.columns);
        let rows = 0;
        for await (const line of readLines(fileDelBackup(layer.dir, file.path, 'file di dati'))) {
          const row = file.encoding === 'bson-base64' ? JSON.parse(line) : EJSON.parse(line, { relaxed: false });
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error(`Il file dati di "${file.collection}" contiene una riga non strutturata.`);
          }
          const rowColumns = file.encoding === 'bson-base64'
            ? require('../../db/mongoBson').inspect(require('../../db/mongoBson').decode(row)).columns : Object.keys(row);
          for (const column of rowColumns) {
            if (!declared.has(column)) {
              throw new Error(`Il file dati di "${file.collection}" contiene la colonna non dichiarata "${column}".`);
            }
          }
          const mongo = ['mongodb', 'mongo'].includes(String(layer.manifest.dbType));
          if (!mongo) {
            for (const column of file.columns) {
              if (!Object.prototype.hasOwnProperty.call(row, column)) {
                throw new Error(`Il file dati di "${file.collection}" non contiene la colonna dichiarata "${column}".`);
              }
            }
          }
          if (file.identity) chiaveIdentita(row, file.identity);
          rows += 1;
        }
        if (file.count != null && rows !== file.count) {
          throw new Error(
            `Cardinalita incoerente per "${file.collection}": il manifest dichiara ${file.count}, il file contiene ${rows} righe.`
          );
        }
      }
      for (const file of layer.manifest.files.filter((f) => f.kind === 'tombstones')) {
        if (file.encoding && (file.encoding !== 'bson-base64' || !['mongo', 'mongodb'].includes(layer.manifest.dbType))) throw new Error('Codifica delle cancellazioni non supportata.');
        let rows = 0;
        for await (const line of readLines(fileDelBackup(layer.dir, file.path, 'file di cancellazioni'))) {
          const row = file.encoding === 'bson-base64' ? JSON.parse(line) : EJSON.parse(line, { relaxed: false });
          if (file.encoding) require('../../db/mongoBson').decodeId(row);
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error(`Il file di cancellazioni di "${file.collection}" contiene una riga non strutturata.`);
          }
          const attese = new Set(file.identity.columns);
          const ricevute = Object.keys(row);
          if (ricevute.length !== attese.size || ricevute.some((c) => !attese.has(c))) {
            throw new Error(`Tombstone non valido per "${file.collection}": deve contenere soltanto l'identità dichiarata.`);
          }
          chiaveIdentita(row, file.identity);
          rows += 1;
        }
        if (rows !== file.count) throw new Error(`Cardinalità tombstone incoerente per "${file.collection}".`);
      }
    }
  }

  return {
    verifiedCount,
    unverifiableCount,
    integrita: { verificata: unverifiableCount === 0, metodo: 'SHA-256' },
    autenticita: {
      verificata: false,
      motivo: 'I checksum provano integrita rispetto ai manifest, non autenticita.',
    },
  };
}

function splitStatements(sql) {
  return splitSql(sql, { keepIdentifiers: true });
}

function assertSafeSchemaSql(sql, expectedTable, opts = {}) {
  try {
    return validaDdlCollezione(sql, {
      dbType: opts.dbType || 'mysql',
      database: opts.database || '',
      collection: expectedTable,
      allowUnsafeSchema: opts.allowUnsafeSchema,
    });
  } catch (err) {
    throw new Error(
      `Lo schema di "${expectedTable}" contenuto nel backup non è una definizione di tabella valida e non verrà eseguito.\n`
      + `  · ${err.message}\n`
      + 'Se il backup è di provenienza certa, ripeti il ripristino con --allow-unsafe-schema.'
    );
  }
}

function readSchemaFile(layerDir, schemaFile, expectedTable, opts) {
  const full = fileDelBackup(layerDir, schemaFile.path, 'file di schema');
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

module.exports = {
  BATCH_SIZE,
  eliminaSePresente,
  trackerPer,
  registraFileAtteso,
  registraAttesa,
  assertColumnsAndIdentity,
  checkApplied,
  resolveChain,
  preflightChain,
  splitStatements,
  assertSafeSchemaSql,
  readSchemaFile,
};
