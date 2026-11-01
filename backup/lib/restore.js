'use strict';

const { preparaCollectionMongo } = require('../../db/mongoCollectionOptions');

/* ---------------------------------------------------------------------------
 * Ripristino da una cartella di backup. Se il backup è incrementale o
 * differenziale la catena viene risolta automaticamente risalendo i baseId
 * tra le cartelle sorelle (full → ... → backup richiesto) e i layer vengono
 * applicati in ordine: il primo con INSERT su destinazione vuota o upsert nel
 * merge, i successivi come upsert (replaceOne su MongoDB, ON DUPLICATE KEY UPDATE su MySQL, INSERT ... ON
 * CONFLICT DO UPDATE su PostgreSQL).
 *
 * Restore selettivo: --collections limita il ripristino alle collection o
 * tabelle indicate. Nei manifest v3 i tombstone vengono applicati prima degli
 * upsert del layer; le catene storiche dichiarano equivalenza incompleta.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EJSON } = require('bson');
const { readLines, readManifest, fileDelBackup, verifyBackupDir } = require('./util');
const { isSqlGeometryType } = require('../../db/geometry');
// Come si scrive il nome di una tabella o di una colonna: regola unica per
// tutto il repo (vedi db/identificatori.js).
const { quotaSempre } = require('../../db/identificatori');
const { normalizzaLayerBackup, validaDdlCollezione } = require('../../db/artefatti');
const {
  MANIFEST_VERSION, leggiIdentitaMySql, leggiIdentitaPostgres,
  validaManifestIdentita, chiaveIdentita, identityCompatibile,
} = require('./identity');
const { equivalenzaCatena } = require('./tombstones');
const { risolviOggettiCatena, coerenzaOggetti, equivalenzaConSchema } = require('./schema-snapshot');
// Come si legge una riga del dump e come diventa un parametro SQL: e' il
// protocollo del file, non il dialetto del server, e vive gia' in un modulo
// solo (vedi db/sqlValori.js). Qui ce n'era una seconda copia, rimasta indietro
// sul Long annidato in un documento JSON.
const { parseClientValue, toSqlValue } = require('../../db/sqlValori');
const myQid = (name) => quotaSempre(name, 'mysql');
const pgQid = (name) => quotaSempre(name, 'postgresql');

// Tipi che il dump salva in esadecimale perché il driver li consegna come
// Buffer, che non sopravvive al giro EJSON del file NDJSON. Vedi engine.js.
const TIPI_BINARI_MYSQL = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit',
]);

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
      const declarations = new Map();
      for (const layer of chain) {
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

/**
 * Controlla l'intera catena prima della prima modifica al database.
 *
 * I manifest storici possono non avere SHA-256: restano ripristinabili per
 * compatibilità, ma vengono dichiarati esplicitamente non verificabili. Ogni
 * checksum presente, la dimensione, il tipo e il confinamento di ogni file
 * vengono invece validati. Basta un solo problema in qualunque layer per
 * interrompere tutto prima di DROP/CREATE/INSERT.
 */
async function preflightChain(chain, log, { allowUnsafeSchema = false } = {}) {
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

    // La verifica dei checksum prova l'integrita' rispetto al manifest, non
    // rende sicuro l'SQL. Si normalizza l'INTERO layer qui, prima che qualunque
    // layer della catena possa modificare la destinazione.
    const schemas = layer.manifest.files.filter((f) => f.kind === 'schema').map((file) => ({
      collection: file.collection,
      database: file.schema || layer.manifest.db,
      sql: fs.readFileSync(fileDelBackup(layer.dir, file.path, 'file di schema'), 'utf8'),
    }));
    const objectsFile = layer.manifest.files.find((f) => f.kind === 'objects');
    const objectText = objectsFile
      ? fs.readFileSync(fileDelBackup(layer.dir, objectsFile.path, 'file di oggetti'), 'utf8') : null;
    const objects = objectText == null ? null : layer.manifest.dbType === 'mongodb'
      ? JSON.parse(objectText) : EJSON.parse(objectText);
    for (const file of layer.manifest.files.filter(f=>f.kind==='large-objects')) {
      if (!['postgresql','postgres'].includes(layer.manifest.dbType)) throw new Error('Large Objects in un backup non PostgreSQL.');
      require('../../db/pg-references').validateLargeObjects(JSON.parse(fs.readFileSync(fileDelBackup(layer.dir,file.path,'Large Objects'),'utf8')));
    }
    const largeFiles=layer.manifest.files.filter(f=>f.kind==='large-object');
    if (largeFiles.length) {
      if (!['postgresql','postgres'].includes(layer.manifest.dbType)) throw new Error('Large Objects in un backup non PostgreSQL.');
      require('../../db/pg-references').validateLargeObjects(largeFiles.map(f=>({oid:f.oid,size:0,chunks:[]})));
      for(const file of largeFiles) if (!Number.isSafeInteger(file.size) || file.size<0 || file.size!==file.bytes) throw new Error('Dimensione Large Object non valida nel manifest.');
    }
    normalizzaLayerBackup({
      dbType: layer.manifest.dbType,
      database: layer.manifest.db,
      schemas,
      collections: layer.manifest.files.filter((f) => f.kind === 'data').map((f) => f.collection),
      objects,
      integrity: { verifiedCount: report.okCount, unverifiableCount: report.unverifiableCount },
    }, { allowUnsafeSchema });

    // Il checksum protegge i byte, non la coerenza semantica fra quei byte e
    // le colonne/identita dichiarate nel manifest. Per i manifest v2 si legge
    // ogni riga prima della prima mutazione: una colonna non dichiarata o una
    // chiave assente non puo arrivare fino all'INSERT/UPSERT.
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
const { splitStatements: splitSql } = require('../../db/sqlText');

function splitStatements(sql) {
  return splitSql(sql, { keepIdentifiers: true });
}

/**
 * @throws se il DDL non è una definizione della tabella attesa.
 * @returns il DDL originale, da eseguire.
 */
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

// Legge il file di schema verificandone, quando il manifest lo dichiara, il
// checksum: un file alterato sul disco non deve poter essere eseguito.
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

/**
 * Colonne geometriche della tabella di DESTINAZIONE, con il loro SRID.
 *
 * Si leggono dopo la CREATE TABLE e dal database di destinazione, non dal
 * manifest: è la destinazione a decidere come il valore va scritto, e un
 * restore verso uno schema con SRID diverso deve seguire quello.
 *
 * @returns {Promise<Map<string, {srid: number|null}>>}
 */
async function mysqlGeoTargetColumns(conn, targetDb, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dtype, SRS_ID AS srid
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [targetDb, table],
  );
  const out = new Map();
  for (const r of rows) {
    const tipo = String(r.dtype || '').toLowerCase();
    if (isSqlGeometryType(r.dtype)) {
      out.set(r.name, { kind: 'geo', srid: r.srid == null ? null : Number(r.srid) });
    } else if (TIPI_BINARI_MYSQL.has(tipo)) {
      // Salvati in esadecimale dal dump (il Buffer del driver non sopravvive
      // al giro EJSON): qui tornano binari con UNHEX.
      out.set(r.name, { kind: 'bin' });
    }
  }
  return out;
}

/* --- Oggetti di schema (terza fase del ripristino) ------------------------- */

/**
 * Un'istruzione DDL del backup può nominare il database di ORIGINE.
 *
 * `SHOW CREATE VIEW` e `SHOW CREATE TRIGGER` restituiscono definizioni che
 * qualificano le tabelle con lo schema in cui vivevano. Ripristinandole in un
 * database diverso — che è esattamente il caso della rinomina — la view
 * continuerebbe a leggere le tabelle dell'ORIGINALE: il ripristino "riesce" e
 * produce oggetti che puntano altrove, il modo più insidioso di sbagliare.
 *
 * La sostituzione è deliberatamente conservativa: agisce solo sulla forma
 * `` `db`. `` esattamente uguale al nome di origine, non su testo libero.
 */
function riqualificaDdl(ddl, dbOrigine, dbDestinazione, dbType = null) {
  if (!dbOrigine || dbOrigine === dbDestinazione) return String(ddl);
  if (dbType === 'postgresql' || dbType === 'postgres') {
    const indice = require('../../db/pg-indici').riqualificaIndice(ddl, dbOrigine, dbDestinazione);
    if (indice != null) return indice;
  }
  const esc = String(dbOrigine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPg = String(dbOrigine).replace(/"/g, '""');
  const escapedPgRegex = escapedPg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let riscritta = String(ddl)
    .replace(new RegExp('`' + esc + '`\\s*\\.', 'g'), myQid(dbDestinazione) + '.')
    .replace(
      new RegExp('"' + escapedPgRegex + '"\\s*\\.', 'g'),
      `"${String(dbDestinazione).replace(/"/g, '""')}".`,
    );
  if (dbType === 'postgresql' || dbType === 'postgres') {
    riscritta = riscritta.replace(
      new RegExp('(^|[^\\w"\'])' + esc + '\\s*\\.', 'gi'),
      (_match, prefix) => `${prefix}"${String(dbDestinazione).replace(/"/g, '""')}".`,
    );
  }

  // La sostituzione copre la forma che `SHOW CREATE VIEW`/`TRIGGER` producono
  // davvero (nome fra backtick seguito da un punto). Se DOPO la riscrittura il
  // nome del database di origine compare ancora, vuol dire che era scritto in
  // una forma non prevista — e proseguire creerebbe un oggetto che continua a
  // leggere il database ORIGINALE: il ripristino "riesce" e punta altrove.
  // Meglio fermarsi e dirlo: era il fallimento silenzioso che questa funzione
  // deve impedire, non uno che può permettersi di produrre.
  const residuo = new RegExp('(^|[^\\w`])' + esc + '(?![\\w])', 'i');
  const senzaNomiQuotati = riscritta
    .replace(new RegExp('`' + esc + '`(?!\\s*\\.)', 'g'), '')
    .replace(new RegExp('"' + escapedPgRegex + '"(?!\\s*\\.)', 'g'), '');
  if (residuo.test(senzaNomiQuotati)) {
    throw new Error(
      `La definizione nomina ancora il database di origine "${dbOrigine}" in una forma non riscrivibile: `
      + 'ripristinandola punterebbe alle tabelle originali invece che a quelle appena create.'
    );
  }
  return riscritta;
}

/**
 * Toglie la clausola DEFINER da una DDL.
 *
 * `SHOW CREATE ...` la include sempre, e nomina un utente dell'istanza di
 * ORIGINE. Ripristinando altrove — o con un utente senza privilegio SUPER —
 * MySQL rifiuta con ERROR 1227, e l'oggetto va perso per un motivo che non ha
 * nulla a che vedere con i dati. Senza DEFINER l'oggetto nasce di proprietà di
 * chi esegue il restore, che è il comportamento desiderabile.
 */
function senzaDefiner(ddl) {
  return String(ddl).replace(/\sDEFINER\s*=\s*(`(?:[^`]|``)+`|'(?:[^']|'')*'|\S+)@(`(?:[^`]|``)+`|'(?:[^']|'')*'|\S+)/i, '');
}

/**
 * Applica gli oggetti di schema di un backup al database di destinazione.
 *
 * L'ordine non è negoziabile: le chiavi esterne pretendono che tutte le tabelle
 * esistano; le view possono poggiare su altre view (si riprova finché si fa
 * progresso, invece di pretendere un ordinamento topologico che MySQL non
 * espone); i trigger pretendono le loro tabelle; gli eventi non dipendono da
 * nulla. Nessuno di questi oggetti fa fallire il ripristino dei DATI: un
 * problema viene registrato in `problems`, che il chiamante trasforma in un
 * ripristino dichiarato incompleto.
 */
async function restoreSchemaObjects({
  strategy, targetDb, dbType, oggetti, dbOrigine, problems, log, allowUnsafeSchema = false, applied = null, preserveViewIdentity = false,
}) {
  if (!oggetti || typeof oggetti !== 'object') return;

  // `runRestore` ha gia' controllato tutta la catena nel preflight. Questo
  // secondo passaggio mantiene sicuro anche il seam pubblico usato dalla
  // rinomina e dai test con strategia finta.
  oggetti = normalizzaLayerBackup({
    dbType,
    database: dbOrigine || targetDb,
    schemas: [],
    objects: oggetti,
    integrity: { verifiedCount: 0, unverifiableCount: 0 },
  }, { allowUnsafeSchema }).objects;

  if (dbType === 'mongodb') {
    const client = strategy.client;
    for (const opt of oggetti.collectionOptions || []) {
      try {
        await preparaCollectionMongo(client, targetDb, opt.name, opt.options, { metadata: opt });
      } catch (err) {
        problems.push(`opzioni di "${opt.name}": ${err.message}`);
      }
    }
    let pending = (oggetti.views || []).map(require('../../db/mongoSchemaBson').decodificaMetadati);
    while (pending.length) {
      const failed = [];
      for (const v of pending) {
        try {
          const database = client.db(targetDb);
          try {
            await database.createCollection(v.name, {
              viewOn: v.viewOn, pipeline: v.pipeline || [],
              ...(v.collation ? { collation: v.collation } : {}),
            });
          } catch (err) {
            if (err.code !== 48 && !/already exists/i.test(err.message)) throw err;
            const existing = (await database.listCollections({ name: v.name }).toArray()).find(item => item.name === v.name);
            if (existing?.type !== 'view') throw new Error(`"${v.name}" esiste ma non è una vista.`);
            // collMod aggiorna pipeline e viewOn; la collation è immutabile.
            const current = existing.options || {};
            if (JSON.stringify(current.collation || null) !== JSON.stringify(v.collation || null)) {
              await database.collection(v.name).drop();
              await database.createCollection(v.name, { viewOn: v.viewOn, pipeline: v.pipeline || [], ...(v.collation ? { collation: v.collation } : {}) });
            } else await database.command({ collMod: v.name, viewOn: v.viewOn, pipeline: v.pipeline || [] });
          }
        } catch (err) { failed.push({ ...v, error: err.message }); }
      }
      if (failed.length === pending.length) {
        problems.push(...failed.map(v => `view "${v.name}": ${v.error}`));
        break;
      }
      pending = failed;
    }
    const n = (oggetti.views || []).length + (oggetti.collectionOptions || []).length;
    if (n && log) log.info(`  Oggetti di schema applicati: ${n}`);
    return;
  }

  // --- SQL -----------------------------------------------------------------
  const visteDaSostituire = new Set();
  const materializzateDaAggiornare = new Set();
  const esegui = async (sql, cosa) => {
    const testo = String(sql).trim();
    // DEFINER= appartiene a MySQL. In PostgreSQL può comparire dentro una
    // stringa di un'espressione o di una routine: rimuoverlo altera la DDL.
    let pulito = riqualificaDdl(dbType === 'mysql' ? senzaDefiner(testo) : testo, dbOrigine, targetDb, dbType);
    if (dbType === 'postgresql') pulito = pulito.replace(/^CREATE\s+(FUNCTION|PROCEDURE)\b/i,'CREATE OR REPLACE $1');
    if (visteDaSostituire.has(cosa) && !/^CREATE\s+MATERIALIZED\s+VIEW/i.test(pulito)) {
      pulito = pulito.replace(/^CREATE\s+(?!OR\s+REPLACE\b)/i, 'CREATE OR REPLACE ');
    }
    if (applied?.has(pulito)) return;
    try { await strategy.collectionAggregate(targetDb, null, { pipeline: pulito }); }
    catch (err) {
      // MySQL non ha OR REPLACE per routine/eventi: sul solo nome dichiarato
      // si sostituisce l'oggetto preesistente, senza coinvolgere gli estranei.
      if (dbType !== 'mysql' || !/^(routine|evento) /.test(cosa)
          || !([1304, 1537].includes(err.errno) || /already exists/i.test(err.message))) throw err;
      const target = require('../../db/artefatti').estraiBersaglio(pulito);
      const kind = { 'create-function': 'FUNCTION', 'create-procedure': 'PROCEDURE', 'create-event': 'EVENT' }[target.kind];
      if (!kind) throw err;
      await strategy.collectionAggregate(targetDb, null, { pipeline: `DROP ${kind} ${myQid(targetDb)}.${myQid(target.object.name)}` });
      await strategy.collectionAggregate(targetDb, null, { pipeline: pulito });
    }
    if (applied) applied.add(pulito);
    if (log) log.info(`  ${cosa} applicato/a`);
  };

  if (oggetti.collations?.length) {
    const existing = await require('../../db/pg-types').readCollations((s,p)=>strategy.pool.query(s,p), targetDb);
    for (const c of oggetti.collations) {
      const found = existing.find(x=>x.name===c.name);
      if (found) {
        if (require('../../db/schemaObjects').canonicalSqlForDb(c.ddl,dbOrigine) !== require('../../db/schemaObjects').canonicalSqlForDb(found.ddl,targetDb)) throw new Error(`Collation "${c.name}" incompatibile con la destinazione.`);
      } else await esegui(c.ddl, `collation "${c.name}"`);
    }
  }
  let types = [...(oggetti.types || [])];
  if (types.length) {
    const existing=await require('../../db/pg-types').readTypes((s,p)=>strategy.pool.query(s,p),targetDb);
    const canonical=require('../../db/schemaObjects').canonicalSqlForDb;
    types=types.filter(t=>{
      const found=existing.find(x=>x.name===t.name);if(!found)return true;
      if(canonical(t.ddl,dbOrigine)!==canonical(found.ddl,targetDb))throw new Error(`Il tipo PostgreSQL "${t.name}" esiste con una definizione diversa.`);
      return false;
    });
  }
  for(const t of types.filter(t=>t.shell)) await esegui(`CREATE TYPE ${pgQid(t.name)}`,`tipo shell "${t.name}"`);
  let routines = [...(oggetti.typeRoutines || [])];
  // Anche senza tipi personalizzati, DEFAULT e CHECK possono richiedere una
  // routine prima del CREATE TABLE. Quelle dipendenti da tabelle/viste restano
  // differite alla fase successiva; ogni giro deve fare progresso reale.
  while (types.length || routines.length) {
    let routineProgress=false;
    const deferred=[];
    for(const r of routines){try{await esegui(r.ddl,`routine del tipo "${r.name}"`);routineProgress=true;}catch{deferred.push(r);}}
    routines=deferred;
    const failed = [];
    for (const t of types) {
      try { await esegui(t.ddl, `tipo "${t.name}"`); }
      catch (err) { failed.push({ ...t, error: err.message }); }
    }
    if (failed.length === types.length && !routineProgress) { problems.push(...failed.map(t => `tipo "${t.name}": ${t.error}`)); break; }
    types = failed;
  }

  // In un merge lo staging può già contenere le viste della fotografia.
  // Si ricreano soltanto quelle dichiarate, senza CASCADE: le viste estranee
  // e le loro dipendenze non vengono eliminate. L'ordine inverso si ottiene
  // riprovando le DROP bloccate finché c'è progresso. Se una dipendenza
  // estranea impedisce la DROP resta disponibile CREATE OR REPLACE.
  if (oggetti.views?.length && typeof strategy.pool?.query === 'function') {
    const names = new Set(oggetti.views.map(v => v.name));
    let existing;
    if (dbType === 'postgresql') {
      existing = (await strategy.pool.query(`SELECT c.relname AS name, c.relkind AS kind
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('v','m')`, [targetDb])).rows;
    } else {
      const [rows] = await strategy.pool.query(`SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA=?`, [targetDb]);
      existing = rows;
    }
    let pending = existing.filter(v => names.has(v.name));
    if (preserveViewIdentity) {
      for (const view of pending.filter(item => item.kind !== 'm')) visteDaSostituire.add(`view "${view.name}"`);
      const current = dbType === 'postgresql'
        ? await require('../../db/schemaObjects').readSchemaObjects(strategy, dbType, targetDb) : null;
      for (const view of pending.filter(item => item.kind === 'm')) {
        const wanted = oggetti.views.find(item => item.name === view.name);
        const found = current?.views.find(item => item.name === view.name);
        const canonical = require('../../db/schemaObjects').canonicalSqlForDb;
        if (wanted && found && canonical(wanted.ddl, dbOrigine) === canonical(found.ddl, targetDb)) {
          materializzateDaAggiornare.add(view.name);
        }
      }
      pending = pending.filter(item => item.kind === 'm');
      pending = pending.filter(item => !materializzateDaAggiornare.has(item.name));
    }
    while (pending.length) {
      const failed = [];
      for (const v of pending) {
        try {
          const quota = dbType === 'mysql' ? myQid : pgQid;
          await strategy.collectionAggregate(targetDb, null, { pipeline:
            `DROP ${v.kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${quota(targetDb)}.${quota(v.name)}` });
        } catch (error) { failed.push(v); }
      }
      if (failed.length === pending.length) {
        for (const v of failed) visteDaSostituire.add(`view "${v.name}"`);
        break;
      }
      pending = failed;
    }
  }

  // Le view possono usare routine nuove e le routine possono usare view.
  // Un'unica coda risolve entrambe le direzioni, con un limite naturale: ogni
  // giro deve applicare almeno un oggetto e nessun successo viene ripetuto.
  let rimaste = [
    ...(oggetti.routines || []).map(r => ({ ...r, etichetta: `routine "${r.name}"` })),
    ...(oggetti.views || []).map(v => ({ ...v, etichetta: `view "${v.name}"` })),
  ];
  while (rimaste.length) {
    const falliti = [];
    let progresso = false;
    for (const v of rimaste) {
      try {
        if (v.materialized && materializzateDaAggiornare.has(v.name)) {
          await strategy.pool.query(`REFRESH MATERIALIZED VIEW ${pgQid(targetDb)}.${pgQid(v.name)}`);
        } else await esegui(v.ddl, v.etichetta);
        progresso = true;
      } catch (err) {
        falliti.push({ ...v, errore: err.message });
      }
    }
    if (!progresso) {
      for (const v of falliti) problems.push(`${v.etichetta}: ${v.errore}`);
      break;
    }
    rimaste = falliti;
  }

  for (const gruppo of [
    { voci: oggetti.sequences || [], etichetta: (s) => `sequenza "${s.name}"` },
    { voci: oggetti.triggers || [], etichetta: (t) => `trigger "${t.name}"` },
    { voci: oggetti.events || [], etichetta: (e) => `evento "${e.name}"` },
  ]) {
    for (const voce of gruppo.voci) {
      try {
        await esegui(voce.ddl, gruppo.etichetta(voce));
        if (dbType === 'postgresql' && voce.ownerTable) {
          await strategy.collectionAggregate(targetDb, null, { pipeline:
            `ALTER SEQUENCE ${pgQid(targetDb)}.${pgQid(voce.name)} OWNED BY ${pgQid(targetDb)}.${pgQid(voce.ownerTable)}.${pgQid(voce.ownerColumn)}` });
        }
      } catch (err) {
        problems.push(`${gruppo.etichetta(voce)}: ${err.message}`);
      }
    }
  }

  // Le espressioni degli indici possono usare routine e collations. Una FK
  // può invece riferire un indice UNIQUE autonomo: va applicata dopo gli indici.
  for (const indice of oggetti.indexes || []) {
    try {
      await esegui(indice, 'indice');
    } catch (err) {
      // I layer storici ripetono gli stessi indici. Un nome già esistente non
      // basta: si tollera soltanto la stessa definizione sulla stessa tabella.
      let uguale = false;
      if (err.code === '42P07' || /already exists|esiste già/i.test(err.message)) {
        const target = require('../../db/artefatti').estraiBersaglio(indice);
        if (typeof strategy.tableAuxDdl === 'function') {
          try {
            const table = target.table.parts.at(-1);
            const aux = await strategy.tableAuxDdl(targetDb, table.quoted ? table.value : table.value.toLowerCase());
            const canonical = require('../../db/schemaObjects').canonicalSqlForDb;
            const expected = canonical(riqualificaDdl(indice, dbOrigine, targetDb, dbType), targetDb);
            uguale = (aux.indexes || []).some(sql => canonical(sql, targetDb) === expected);
          } catch (checkError) {
            problems.push(`Verifica dell'indice esistente: ${checkError.message}`);
          }
        }
      }
      if (!uguale) problems.push(`indice: ${err.message}`);
    }
  }
  for (const fk of oggetti.foreignKeys || []) {
    try { await esegui(fk, 'vincolo'); }
    catch (err) {
      if (!/duplicate|already exists|esiste già/i.test(err.message)) problems.push(`chiave esterna: ${err.message}`);
    }
  }

  // --- Valore corrente delle sequenze (PostgreSQL), per ULTIMO --------------
  //
  // Va dopo i dati, non prima: `setval` fissa il contatore al valore che aveva
  // l'originale, e caricare righe dopo averlo fissato lo lascerebbe indietro.
  //
  // È il pezzo che mancava del tutto: senza, una tabella con id 1..1000 si
  // ripristina con i dati giusti ma la sequenza riparte da 1, e il primo
  // INSERT dopo il ripristino sbatte contro la chiave primaria. Il restore si
  // dichiara riuscito e la tabella non accetta più scritture.
  for (const seq of oggetti.sequenceValues || []) {
    const cosa = `valore della sequenza "${seq.name}"`;
    try {
      const sql = String(seq.sql || '').trim();
      await strategy.collectionAggregate(targetDb, null, { pipeline: sql });
      if (log) log.info(`  ${cosa} ripristinato`);
    } catch (err) {
      problems.push(`${cosa}: ${err.message}`);
    }
  }
}

/* --- Restore MongoDB ------------------------------------------------------ */

async function restoreLayerMongo({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, tracker, mongoOptions }) {
  const client = strategy.client;
  const dataFiles = layer.manifest.files.filter(
    (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
  );
  let total = 0;
  for (const f of dataFiles) {
    registraFileAtteso(tracker, f);
    const collection = client.db(targetDb).collection(f.collection);
    if (isFirst && drop) {
      await eliminaSePresente(() => collection.drop(), {
        dbType: 'mongodb', target: `${targetDb}.${f.collection}`,
      });
    }
    // Su MongoDB una collection nasce alla prima scrittura: una collection
    // VUOTA nel backup non ne produce nessuna, quindi spariva dal ripristino
    // senza che nulla lo dicesse — e il conteggio tornava, perche' zero righe
    // attese contro una collection inesistente fa comunque zero. Il backup la
    // dichiara nel manifest: va materializzata, come fa gia' il motore del
    // piano per l'import.
    if (isFirst) {
      const metadata = mongoOptions.get(f.collection);
      await preparaCollectionMongo(client, targetDb, f.collection, metadata?.options || {}, { deferValidation: true, metadata });
    }
    if (!f.identity) {
      const empty = (await collection.countDocuments({})) === 0;
      assertColumnsAndIdentity(f, [], null, { empty });
    }

    const eliminazioni = layer.manifest.files.find((x) => x.kind === 'tombstones' && x.collection === f.collection);
    if (!isFirst && eliminazioni) {
      let batchDelete = [];
      const flushDelete = async () => {
        if (!batchDelete.length) return;
        if (eliminazioni.encoding === 'bson-base64') await require('../../db/mongoBson').deleteRows(client, targetDb, f.collection, batchDelete);
        else await collection.bulkWrite(
          batchDelete.map((id) => ({ deleteOne: { filter: id } })),
          { ordered: true }
        );
        batchDelete = [];
      };
      for await (const line of readLines(fileDelBackup(layer.dir, eliminazioni.path, 'file di cancellazioni'))) {
        batchDelete.push(eliminazioni.encoding === 'bson-base64' ? JSON.parse(line) : EJSON.parse(line, { relaxed: false }));
        if (batchDelete.length >= BATCH_SIZE) await flushDelete();
      }
      await flushDelete();
    }

    let batch = [];
    let applied = 0;
    const flush = async () => {
      if (!batch.length) return;
      if (f.encoding === 'bson-base64') {
        const result = await require('../../db/mongoBson').importRows(client, targetDb, f.collection, batch,
          !isFirst || (!drop && !!f.identity), { preservaIdentita: !drop && !!f.identity });
        if (result.failed) throw new Error(result.errors.join('; '));
      } else if (isFirst && (drop || !f.identity)) {
        await collection.insertMany(batch, { ordered: false });
      } else {
        await collection.bulkWrite(
          batch.map((doc) => {
            const { _id, ...fields } = doc;
            return { replaceOne: { filter: { _id }, replacement: !drop && f.identity ? fields : doc, upsert: true } };
          }),
          { ordered: false }
        );
      }
      batch = [];
    };
    for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
      const row = f.encoding === 'bson-base64' ? JSON.parse(line) : EJSON.parse(line, { relaxed: false });
      registraAttesa(tracker, f);
      batch.push(row);
      applied += 1;
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    total += applied;
    log.info(`  ${f.collection}: ${applied} documenti applicati (layer ${layer.manifest.id}).`);
    checkApplied(problems, layer, f, applied);

    // Gli indici vengono applicati dalla fotografia finale in runRestore,
    // dopo TUTTI i layer: i vincoli del full possono essere stati modificati.
  }
  return total;
}

/* --- Restore MySQL -------------------------------------------------------- */

async function mysqlTargetIdentity(conn, db, table, expectedIdentity = null) {
  const [columnsRows] = await conn.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [db, table],
  );
  const columns = columnsRows.map((c) => ({
    name: c.name,
    type: String(c.type).toLowerCase(),
    nullable: String(c.nullable).toUpperCase() === 'YES',
  }));
  const identities = await leggiIdentitaMySql(
    (sql, params) => conn.query(sql, params), db, table, columns,
  );
  return {
    columnSchema: columns,
    identity: identities.find((candidate) => identityCompatibile(expectedIdentity, candidate))
      || identities[0] || null,
  };
}

async function restoreLayerMySql({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, opts, tracker }) {
  const mysql = require('mysql2');
  const pool = strategy.pool;
  const conn = await pool.getConnection();
  let total = 0;
  let originalSession;
  try {
    [[originalSession]] = await conn.query('SELECT @@SESSION.time_zone AS timezone, @@SESSION.sql_mode AS mode');
    await conn.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_ALL_TABLES'");
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${myQid(targetDb)}`);
    await conn.query(`USE ${myQid(targetDb)}`);
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
      await conn.query('SET SESSION time_zone = ?', [f.timezone === 'UTC' ? '+00:00' : originalSession.timezone]);
      registraFileAtteso(tracker, f);
      const tableId = myQid(f.collection);
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
          const ddl = readSchemaFile(layer.dir, schemaFile, f.collection, {
            ...opts, dbType: 'mysql', database: layer.manifest.db,
          });
          const separated = require('./engine').splitMySqlForeignKeys(ddl, f.collection);
          await conn.query(riqualificaDdl(separated.ddl, layer.manifest.db, targetDb, 'mysql').replace(/;\s*$/, ''));
          existingTables.add(f.collection);
        }
      }

      const targetMeta = await mysqlTargetIdentity(conn, targetDb, f.collection, f.identity);
      let empty = false;
      if (!f.identity) {
        if (!isFirst && f.mode === 'full' && f.content?.mode === 'snapshot') {
          assertColumnsAndIdentity(f, targetMeta.columnSchema, targetMeta.identity, { empty: true });
          await conn.query(`DELETE FROM ${tableId}`);
        }
        const [[row]] = await conn.query(`SELECT NOT EXISTS(SELECT 1 FROM ${tableId} LIMIT 1) AS \`is_empty\``);
        empty = !!Number(row.is_empty);
      }
      assertColumnsAndIdentity(f, targetMeta.columnSchema, targetMeta.identity, { empty });

      const eliminazioni = layer.manifest.files.find((x) => x.kind === 'tombstones' && x.collection === f.collection);
      if (!isFirst && eliminazioni) {
        const binary = new Set((f.columnSchema || []).filter(c=>/^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/i.test(c.type)).map(c=>c.name));
        const whereDelete = f.identity.columns.map((c) => `${myQid(c)} = ${binary.has(c)?'UNHEX(?)':(f.ordinalColumns||[]).includes(c)?'CAST(? AS UNSIGNED)':'?'}`).join(' AND ');
        for await (const line of readLines(fileDelBackup(layer.dir, eliminazioni.path, 'file di cancellazioni'))) {
          const id = EJSON.parse(line, { relaxed: false });
          await conn.query(
            `DELETE FROM ${tableId} WHERE ${whereDelete}`,
            f.identity.columns.map((c) => toSqlValue(id[c]))
          );
        }
      }

      // Colonne geometriche della tabella di DESTINAZIONE, lette dopo la
      // CREATE TABLE. Il backup le contiene come GeoJSON (vedi il dump): un
      // segnaposto normale le passerebbe a MySQL come stringa e il motore
      // risponderebbe "Cannot get geometry object from data you send to the
      // GEOMETRY field". Vanno riscritte con ST_GeomFromGeoJSON e forzate al
      // SRID della colonna, perché ST_GeomFromGeoJSON produce sempre 4326 e
      // MySQL rifiuta la scrittura se non coincide con quello dichiarato.
      const geoTarget = await mysqlGeoTargetColumns(conn, targetDb, f.collection);
      // SRID con cui le geometrie erano espresse NELL'ORIGINE (vedi il dump).
      const sridOrigine = f.geoSrid || {};

      // I layer successivi al primo (e le tabelle senza colonna data incluse
      // per intero in un incrementale) vanno applicati come upsert.
      const upsert = !!f.identity && (!isFirst || !drop);
      const verb = upsert ? 'UPSERT' : 'INSERT';
      let batch = [];
      let columns = null;
      let applied = 0;
      const flush = async () => {
        if (!batch.length) return;
        const listaColonne = columns.map((c) => myQid(c)).join(', ');
        const conflictColumns = f.identity ? f.identity.columns : [];
        if (upsert && !conflictColumns.length) {
          throw new Error(`Upsert rifiutato per "${f.collection}": il manifest non dichiara un'identita stabile.`);
        }
        const aggiornabili = columns.filter((c) => !conflictColumns.includes(c));
        const upsertSql = upsert
          ? ` ON DUPLICATE KEY UPDATE ${(
            aggiornabili.length
              ? aggiornabili.map((c) => `${myQid(c)} = VALUES(${myQid(c)})`)
              : [`${myQid(conflictColumns[0])} = ${myQid(conflictColumns[0])}`]
          ).join(', ')}`
          : '';
        const ordinalColumns = new Set(f.ordinalColumns || []);
        const enumColumns = new Set((f.columnSchema || []).filter(require('../../db/mysql-ordinal').isEnum).map(c=>c.name));
        const zeroColumns = [];
        const geoNelBatch = columns.some((c) => geoTarget.has(c) || ordinalColumns.has(c));
        if (!geoNelBatch) {
          // Percorso veloce, invariato: nessuna geometria, insert multiplo.
          await require('../../db/mysql-ordinal').write(conn, `INSERT INTO ${tableId} (${listaColonne}) VALUES ?${upsertSql}`, [batch]);
        } else {
          // Con le geometrie ogni riga ha bisogno delle proprie espressioni,
          // quindi la clausola VALUES si costruisce esplicitamente.
          const params = [];
          const tuple = batch.map((riga, rowIndex) => {
            const segnaposti = columns.map((c, i) => {
              const info = geoTarget.get(c);
              const v = riga[i];
              if (ordinalColumns.has(c) && v != null) {
                const bind = require('../../db/mysql-ordinal').binding(require('bson').Decimal128.fromString(String(v)), {type:enumColumns.has(c)?'enum':'set'});
                if (bind.zero) zeroColumns.push({column:c,row:rowIndex+1});
                params.push(bind.param); return bind.sql;
              }
              if (!info || v == null) { params.push(v); return '?'; }
              // WKB esadecimale (formato del dump). I backup prodotti prima di
              // questa correzione non contengono geometrie utilizzabili — il
              // loro ripristino falliva — quindi non c'è un formato precedente
              // da riconoscere qui.
              if (info.kind !== 'bin' && f.geometryEncoding === 'mysql-internal-hex') {
                const bytes = Buffer.from(String(v), 'hex');
                if (bytes.length < 9 || bytes.length * 2 !== String(v).length) throw new Error('Geometria binaria del backup non valida.');
                params.push(bytes.subarray(4).toString('hex'));
                return `ST_GeomFromWKB(UNHEX(?), ${bytes.readUInt32LE(0)}, 'axis-order=long-lat')`;
              }
              params.push(String(v));
              // Binari (BLOB, BINARY, BIT…): esadecimale nel dump, UNHEX qui.
              if (info.kind === 'bin') return 'UNHEX(?)';
              // Il SRID è quello di ORIGINE, preso dal manifest — MAI quello
              // della colonna di destinazione. Usare il secondo faceva
              // "riuscire" un ripristino verso una colonna con SRID diverso
              // reinterpretando la geometria: stesse coordinate, punto diverso
              // sulla Terra, nessun errore. Con il SRID di origine è MySQL
              // stesso a rifiutare l'incompatibilità, ed è giusto che lo faccia
              // il motore invece di noi.
              return `ST_GeomFromWKB(UNHEX(?), ${Number(sridOrigine[c] ?? info.srid ?? 0)})`;
            });
            return `(${segnaposti.join(', ')})`;
          });
          await require('../../db/mysql-ordinal').write(
            conn, `INSERT INTO ${tableId} (${listaColonne}) VALUES ${tuple.join(', ')}${upsertSql}`, params, zeroColumns,
          );
        }
        applied += batch.length;
        batch = [];
      };
      for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
        // relaxed:true faceva di un `$numberLong` del file un Number gia'
        // arrotondato: la perdita avveniva PRIMA di toSqlValue, che non aveva
        // piu' niente da salvare. `parseClientValue` legge canonico e riporta a
        // Number solo cio' che vi rientra.
        const row = parseClientValue(line);
        registraAttesa(tracker, f);
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
        // Le geometriche restano la stringa WKB del backup: `toSqlValue` non
        // deve toccarla, la riscrive `flush` con ST_GeomFromWKB.
        batch.push(columns.map((c) => (geoTarget.has(c) ? row[c] : toSqlValue(row[c]))));
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      total += applied;
      log.info(`  ${f.collection}: ${applied} righe applicate (layer ${layer.manifest.id}, ${verb}).`);
      checkApplied(problems, layer, f, applied);
    }
  } finally {
    try {
      if (originalSession) await conn.query('SET SESSION time_zone = ?, SESSION sql_mode = ?', [originalSession.timezone, originalSession.mode]);
      conn.release();
    } catch (err) { conn.destroy(); throw err; }
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

async function pgTargetIdentity(strategy, schema, table, expectedIdentity = null) {
  const pool = strategy.pool;
  const columns = (await require('../../db/pg-ddl').pgColonne((s, p) => pool.query(s, p), schema, table)).map((c) => ({
    name: c.name,
    type: c.ctype.toLowerCase(),
    cast: c.ctype,
    nullable: !c.notnull,
  }));
  const identities = await leggiIdentitaPostgres(
    (sql, params) => pool.query(sql, params), schema, table, columns,
  );
  return {
    columnSchema: columns,
    identity: identities.find((candidate) => identityCompatibile(expectedIdentity, candidate))
      || identities[0] || null,
  };
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

async function restoreLayerPostgreSql({ strategy, targetDb, layer, isFirst, onlyCollections, drop, log, problems, opts, explicitTarget, tracker }) {
  const dataFiles = layer.manifest.files.filter(
    (f) => f.kind === 'data' && (!onlyCollections || onlyCollections.includes(f.collection))
  );
  // Schema effettivo di destinazione (retro-compatibile con i backup vecchi).
  targetDb = pgTargetSchema(targetDb, layer, explicitTarget);
  if (isFirst) {
    await strategy.pool.query(`CREATE SCHEMA IF NOT EXISTS ${pgQid(targetDb)}`);
    if (onlyCollections) {
      // Le routine condivise non appartengono alla tabella selezionata.
      // Si aggiornano quelle necessarie ai suoi vincoli, default e trigger;
      // le versioni locali estranee restano intatte.
      const sourceDdl = layer.manifest.files.filter(file => file.kind === 'schema' && onlyCollections.includes(file.collection))
        .map(file => readSchemaFile(layer.dir, file, file.collection, {
          ...opts, dbType: 'postgresql', database: layer.manifest.db,
        })).join('\n');
      opts.selectedRoutines = await require('../../db/pg-routine-selezione').routineSelettivePg({
        query: (sql, params) => strategy.pool.query(sql, params), targetDb, collections: onlyCollections,
        objects: opts.schemaSnapshot.objects, ddl: sourceDdl,
        references: opts.routineReferences,
      });
    }
    // DROP elimina anche le sequenze possedute: i prerequisiti vanno ricreati dopo.
    if (drop) for (const f of dataFiles) {
      await eliminaSePresente(() => strategy.dropCollection(targetDb, f.collection), {
        dbType: 'postgresql', target: `${targetDb}.${f.collection}`,
      });
    }
    {
      // La forma finale è già risolta prima dei dati. Precaricare la fotografia
      // full lascerebbe routine poi rimosse, e perderebbe quelle aggiunte dopo.
      const objects = opts.schemaSnapshot.objects;
      const sequences = (objects.sequences || []).filter(s => !onlyCollections || onlyCollections.includes(s.ownerTable));
      await require('../../db/pg-types').checkExtensions(strategy, objects.extensions);
      await restoreSchemaObjects({ strategy, targetDb, dbType: 'postgresql',
        oggetti: { collations: objects.collations, types: objects.types, typeRoutines: opts.selectedRoutines || objects.routines, sequences: sequences.map(({ ownerTable, ownerColumn, ...s }) => s) },
        dbOrigine: opts.schemaSnapshot.db, problems, log, allowUnsafeSchema: opts.allowUnsafeSchema, applied: opts.appliedObjects });
      if (problems.length) throw new Error(problems.join('; '));
    }
  }
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
      const schemaFile = layer.manifest.files.find((x) => x.kind === 'schema' && x.collection === f.collection);
      // Se non sappiamo cosa esiste, si prova comunque a creare: una CREATE su
      // tabella già presente fallisce in modo innocuo ed è l'unico errore che
      // qui va tollerato.
      const mustCreate = schemaFile && (!existingTables || !existingTables.has(f.collection));
      if (mustCreate) {
        const sql = riqualificaDdl(readSchemaFile(layer.dir, schemaFile, f.collection, {
          ...opts, dbType: 'postgresql', database: layer.manifest.db,
        }), layer.manifest.db, targetDb, 'postgresql');
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
  }
  if (isFirst) {
    const objects = opts.schemaSnapshot.objects;
    // Regproc può riferire routine senza tipi custom: servono prima dei dati.
    // Quelle che dipendono da view vengono riprovate nella fase finale.
    await restoreSchemaObjects({strategy,targetDb,dbType:'postgresql',oggetti:{routines:opts.selectedRoutines || objects.routines},dbOrigine:opts.schemaSnapshot.db,problems:[],log,allowUnsafeSchema:opts.allowUnsafeSchema,applied:opts.appliedObjects});
  }
  const referenceShapes=new Map();
  let wantedLargeObjects=null;
  if (onlyCollections) {
    wantedLargeObjects=new Set();
    opts.largeObjectReferences ||= new Map();
    for(const f of dataFiles) {
      const shape=await require('../../db/pg-references').columnReferences((s,p)=>strategy.pool.query(s,p),targetDb,f.collection);
      referenceShapes.set(f.collection,shape);
      if (f.mode === 'full' || !opts.largeObjectReferences.has(f.collection)) opts.largeObjectReferences.set(f.collection, new Map());
      const state = opts.largeObjectReferences.get(f.collection);
      const tombstone = layer.manifest.files.find(file => file.kind === 'tombstones' && file.collection === f.collection);
      if (tombstone) for await (const line of readLines(fileDelBackup(layer.dir, tombstone.path))) {
        state.delete(require('./content-state').chiaveRiga(parseClientValue(line), f));
      }
      let ordinal = 0;
      for await (const line of readLines(fileDelBackup(layer.dir,f.path,'riferimenti Large Objects'))) {
        const row = parseClientValue(line), ids = new Set();
        require('../../db/pg-references').rowReferences(row,shape,id=>{ids.add(id);return id;});
        state.set(f.identity ? require('./content-state').chiaveRiga(row, f) : ordinal++, ids);
      }
    }
    for (const state of opts.largeObjectReferences.values()) for (const ids of state.values()) for (const id of ids) wantedLargeObjects.add(id);
  }
  for (const file of layer.manifest.files.filter(f=>f.kind==='large-objects')) {
    const objects=JSON.parse(fs.readFileSync(fileDelBackup(layer.dir,file.path,'Large Objects'),'utf8'));
    const map=await require('../../db/pg-references').importLargeObjects(strategy.pool,objects.filter(o=>!wantedLargeObjects||wantedLargeObjects.has(o.oid)),opts.largeObjectMap);
    for(const [id,value]of map)opts.largeObjectMap.set(id,value);
  }
  const largeFiles=layer.manifest.files.filter(f=>f.kind==='large-object' && (!wantedLargeObjects||wantedLargeObjects.has(f.oid))).map(f=>({...f,path:fileDelBackup(layer.dir,f.path,'Large Object')}));
  if (largeFiles.length) {
    const map=await require('../../db/pg-references').importLargeObjectFiles(strategy.pool,largeFiles,opts.largeObjectMap);
    for(const [id,value]of map)opts.largeObjectMap.set(id,value);
  }
  for (const f of dataFiles) {
    registraFileAtteso(tracker, f);
    const references=referenceShapes.get(f.collection)||await require('../../db/pg-references').columnReferences((s,p)=>strategy.pool.query(s,p),targetDb,f.collection);
    const rewrite = row => require('../../db/pg-references').rowReferences(row,references,id=>opts.largeObjectMap.get(id)||id,
      (value,node)=>node.type==='regnamespace' && [layer.manifest.db,pgQid(layer.manifest.db)].includes(value) ? pgQid(targetDb) : riqualificaDdl(value,layer.manifest.db,targetDb,'postgresql'));
    const targetMeta = await pgTargetIdentity(strategy, targetDb, f.collection, f.identity);
    let empty = false;
    if (!f.identity) {
      if (!isFirst && f.mode === 'full' && f.content?.mode === 'snapshot') {
        const metadata = { ...f, columnSchema: f.columnSchema?.map(c => ({ ...c, type: riqualificaDdl(c.type, layer.manifest.db, targetDb, 'postgresql') })) };
        assertColumnsAndIdentity(metadata, targetMeta.columnSchema, targetMeta.identity, { empty: true });
        await strategy.pool.query(`DELETE FROM ${pgQid(targetDb)}.${pgQid(f.collection)}`);
      }
      const res = await strategy.pool.query(
        `SELECT NOT EXISTS(SELECT 1 FROM ${pgQid(targetDb)}.${pgQid(f.collection)} LIMIT 1) AS empty`,
      );
      empty = !!res.rows[0].empty;
    }
    const expectedMeta = { ...f, columnSchema: f.columnSchema?.map(c => ({ ...c, type: riqualificaDdl(c.type, layer.manifest.db, targetDb, 'postgresql') })) };
    assertColumnsAndIdentity(expectedMeta, targetMeta.columnSchema, targetMeta.identity, { empty });
    const eliminazioni = layer.manifest.files.find((x) => x.kind === 'tombstones' && x.collection === f.collection);
    if (!isFirst && eliminazioni) {
      const columnTypes = new Map(targetMeta.columnSchema.map(column => [column.name, column]));
      for await (const line of readLines(fileDelBackup(layer.dir, eliminazioni.path, 'file di cancellazioni'))) {
        const id = rewrite(EJSON.parse(line, { relaxed: false }));
        await require('../../db/pg-alias').resolveNested((sql, params) => strategy.pool.query(sql, params), [id], references);
        const params = [];
        const whereDelete = f.identity.columns.map(c => {
          const column = columnTypes.get(c), value = id[c];
          const reference = value?.$pgReference && value.$pgReference.kind === column.type
            ? require('../../db/pg-alias').binding(value) : null;
          params.push(reference ? reference.param : (f.binarie || []).includes(c) && typeof value === 'string' ? Buffer.from(value, 'hex') : toSqlValue(value));
          // record_eq non deduce il tipo composto dal solo operatore: il cast
          // proviene dal catalogo della destinazione, non dal file di backup.
          const placeholder = `$${params.length}`;
          return `${pgQid(c)} = ${reference ? reference.sql.replace('$1', placeholder) : `${placeholder}::${column.cast}`}`;
        }).join(' AND ');
        await strategy.pool.query(
          `DELETE FROM ${pgQid(targetDb)}.${pgQid(f.collection)} WHERE ${whereDelete}`,
          params,
        );
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
      const imp = await strategy.collectionImport(targetDb, f.collection, {
        docs: batch,
        upsert: !!f.identity && (!isFirst || !drop),
        conflictColumns: f.identity ? f.identity.columns : undefined,
      });
      applied += imp.inserted;
      // `collectionImport` non lancia sui singoli errori di riga: li restituisce.
      // Ignorarli significava dichiarare riuscito un ripristino di zero righe.
      failed += imp.failed || 0;
      for (const e of (imp.errors || [])) {
        if (firstErrors.length < 3) firstErrors.push(typeof e === 'string' ? e : (e.error || JSON.stringify(e)));
      }
      batch = [];
    };
    // Le righe vanno passate a `collectionImport` come OGGETTI, non come testo:
    // `EJSON.deserialize` di una stringa restituisce la stringa, che il metodo
    // rifiuta ("la riga deve essere un oggetto") — cioè ogni riga sarebbe
    // fallita. Qui si parsifica una volta sola, ed è anche il punto in cui le
    // colonne salvate in esadecimale tornano binarie (CDB-A87).
    const binarie = Array.isArray(f.binarie) ? f.binarie : [];
    for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
      let riga;
      try {
        riga = rewrite(parseClientValue(line)); // vedi la nota sul ramo MySQL
      } catch (err) {
        failed += 1;
        if (firstErrors.length < 3) firstErrors.push(`riga non leggibile: ${err.message}`);
        continue;
      }
      for (const col of binarie) {
        // `encode(col,'hex')` nel dump: senza riconvertirlo, PostgreSQL
        // scriverebbe in bytea i CARATTERI della stringa esadecimale invece
        // dei byte che rappresentano.
        if (typeof riga[col] === 'string') riga[col] = { $binary: { base64: Buffer.from(riga[col], 'hex').toString('base64'), subType: '00' } };
      }
      registraAttesa(tracker, f);
      batch.push(riga);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    total += applied;
    log.info(`  ${f.collection}: ${applied} righe applicate (layer ${layer.manifest.id}, ${!isFirst || (!drop && f.identity) ? 'UPSERT' : 'INSERT'}).`);
    if (failed) log.error(`  ${f.collection}: ${failed} righe NON applicate. Primi errori: ${firstErrors.join(' | ')}`);
    checkApplied(problems, layer, f, applied, failed ? `${failed} righe rifiutate (${firstErrors.join(' | ')})` : null);
  }
  return total;
}

async function cardinalitaDestinazione({ strategy, dbType, targetDb, collection, identity }) {
  if (dbType === 'mysql') {
    const conn = await strategy.pool.getConnection();
    try {
      const distinct = identity
        ? `COUNT(DISTINCT ${identity.columns.map(myQid).join(', ')})`
        : 'NULL';
      const [[row]] = await conn.query(
        `SELECT COUNT(*) AS cardinality, ${distinct} AS distinctIdentities FROM ${myQid(targetDb)}.${myQid(collection)}`,
      );
      return {
        cardinality: Number(row.cardinality),
        distinctIdentities: identity ? Number(row.distinctIdentities) : null,
      };
    } finally {
      conn.release();
    }
  }
  if (dbType === 'postgresql' || dbType === 'postgres') {
    const cols = identity && identity.columns.map(pgQid);
    const distinct = !cols ? 'NULL'
      : cols.length === 1 ? `COUNT(DISTINCT ${cols[0]})` : `COUNT(DISTINCT (${cols.join(', ')}))`;
    const res = await strategy.pool.query(
      `SELECT COUNT(*) AS cardinality, ${distinct} AS "distinctIdentities" FROM ${pgQid(targetDb)}.${pgQid(collection)}`,
    );
    return {
      cardinality: Number(res.rows[0].cardinality),
      distinctIdentities: identity ? Number(res.rows[0].distinctIdentities) : null,
    };
  }
  const collectionRef = strategy.client.db(targetDb).collection(collection);
  const cardinality = await collectionRef.countDocuments({});
  let distinctIdentities = null;
  if (identity) {
    const result = await collectionRef.aggregate([
      { $group: { _id: Object.fromEntries(identity.columns.map((c) => [c, `$${c}`])) } },
      { $count: 'n' },
    ]).toArray();
    distinctIdentities = result.length ? Number(result[0].n) : 0;
  }
  return { cardinality, distinctIdentities };
}

async function verificaRisultatoFinale({ strategy, dbType, targetDb, tracker, problems, log }) {
  let total = 0;
  let expectedTotal = 0;
  const collections = [];
  for (const [collection, expected] of tracker) {
    const target = await cardinalitaDestinazione({
      strategy, dbType, targetDb, collection, identity: expected.identity,
    });
    // Il valore atteso arriva dall'ULTIMO layer della catena ed e' stato
    // calcolato dal DBMS sorgente dentro la snapshot del backup. In questo modo
    // il confronto rispetta collation e tipi senza materializzare tutte le
    // chiavi in memoria e senza confondere le scritture ripetute con righe
    // finali distinte.
    const expectedCardinality = expected.expectedCardinality + (expected.preserved || 0);
    const expectedDistinct = expected.expectedDistinctIdentities == null ? null
      : expected.expectedDistinctIdentities + (expected.preserved || 0);
    total += target.cardinality;
    expectedTotal += expectedCardinality;
    collections.push({ collection, expected: expectedCardinality, preserved: expected.preserved || 0, ...target });
    if (target.cardinality !== expectedCardinality) {
      problems.push(
        `${collection}: cardinalita finale ${target.cardinality}, attese ${expectedCardinality} righe/documenti distinti`
      );
    }
    if (expected.identity && (target.distinctIdentities !== expectedDistinct
        || target.cardinality !== target.distinctIdentities)) {
      problems.push(
        `${collection}: ${target.cardinality} righe/documenti ma ${target.distinctIdentities} identita distinte `
        + `(attese ${expectedDistinct})`
      );
    }
    log.info(
      `  Verifica finale ${collection}: cardinalita ${target.cardinality}`
      + (expected.identity ? `, identita distinte ${target.distinctIdentities}` : '')
      + `, attese ${expectedCardinality}.`
    );
  }
  return { total, expectedTotal, collections };
}

/* --- Restore completo ----------------------------------------------------- */

async function runRestore({ session, backupDir, targetDb, onlyCollections, drop, log, allowUnsafeSchema = false, preserveViewIdentity = false }) {
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

  // Deve precedere anche un eventuale --drop: un backup alterato o incompleto
  // non può provocare alcuna mutazione prima che TUTTA la catena sia valida.
  await preflightChain(chain, log, { allowUnsafeSchema });
  const schemaSnapshot = risolviOggettiCatena(chain, { allowUnsafeSchema });
  const routineReferences = onlyCollections && ['postgresql', 'postgres'].includes(dbType)
    ? await require('../../db/pg-routine-selezione').riferimentiRoutineBackup(chain, onlyCollections) : [];
  if (schemaSnapshot.nota) (log.warn || log.info).call(log, `  Oggetti di schema: ${schemaSnapshot.nota}`);

  if (onlyCollections) {
    const available = new Set(chain.flatMap((l) => l.manifest.files.filter((f) => f.kind === 'data').map((f) => f.collection)));
    for (const c of onlyCollections) {
      if (!available.has(c)) throw new Error(`Collection/tabella "${c}" non presente nel backup.`);
    }
  }

  const preserved = new Map();
  if (!drop && typeof strategy.listCollections === 'function') {
    let existing;
    try { existing = await strategy.listCollections(db, { includeCounts: false }); }
    catch (err) { if (err.errno === 1049 || err.code === '3F000') existing = []; else throw err; }
    const names = new Set(existing.filter(item => item.type !== 'view').map(item => item.name));
    for (const file of first.files.filter(item => item.kind === 'data' && item.identity
      && names.has(item.collection) && (!onlyCollections || onlyCollections.includes(item.collection)))) {
      const count = await require('./merge-identita').contaIdentitaPreservate({
        strategy, dbType, targetDb: db, collection: file.collection, chain, file,
        retarget: (value, source, destination) => riqualificaDdl(value, source, destination, 'postgresql'),
      });
      preserved.set(file.collection, count);
    }
  }

  if (dbType === 'mongodb') {
    // Nel merge gli indici vecchi non devono impedire il caricamento di righe
    // ammesse dai vincoli finali. Si toccano soltanto nomi dichiarati nella
    // catena; _id e gli indici estranei restano intatti.
    for (const [name, indexNames] of Object.entries(schemaSnapshot.indexNames)) {
      if (onlyCollections && !onlyCollections.includes(name)) continue;
      for (const indexName of indexNames) {
        try { await strategy.client.db(db).collection(name).dropIndex(indexName); }
        catch (err) { if (![26, 27].includes(err.code) && !/ns not found|namespace.*not found|index not found/i.test(err.message)) throw err; }
      }
    }
  } else if (typeof strategy.listCollections === 'function') {
    // Solo oggetti dichiarati dalla catena e tabelle già presenti. Togliere
    // i trigger prima dei dati impedisce che il merge trasformi nuovamente
    // valori già salvati; indici e FK finali vengono ripristinati dopo i dati.
    let existing;
    try { existing = await strategy.listCollections(db, { includeCounts: false }); }
    catch (err) { if (err.errno === 1049 || err.code === '3F000') existing = []; else throw err; }
    const tables = new Set(existing.filter(item => item.type !== 'view').map(item => item.name));
    const quota = dbType === 'mysql' ? myQid : pgQid;
    for (const kind of ['triggers', 'foreignKeys', 'indexes']) {
      for (const item of schemaSnapshot.managedSql[kind]) {
        if (!tables.has(item.table) || (onlyCollections && !onlyCollections.includes(item.table))) continue;
        let sql;
        if (kind === 'triggers') sql = dbType === 'mysql'
          ? `DROP TRIGGER IF EXISTS ${quota(db)}.${quota(item.name)}`
          : `DROP TRIGGER IF EXISTS ${quota(item.name)} ON ${quota(db)}.${quota(item.table)}`;
        else if (kind === 'foreignKeys') sql = dbType === 'mysql'
          ? `ALTER TABLE ${quota(db)}.${quota(item.table)} DROP FOREIGN KEY ${quota(item.name)}`
          : `ALTER TABLE ${quota(db)}.${quota(item.table)} DROP CONSTRAINT IF EXISTS ${quota(item.name)}`;
        else sql = `DROP INDEX IF EXISTS ${quota(db)}.${quota(item.name)}`;
        try { await strategy.collectionAggregate(db, null, { pipeline: sql }); }
        catch (err) { if (dbType !== 'mysql' || err.errno !== 1091) throw err; }
      }
    }
  }

  // Le opzioni MongoDB servono alla creazione anche nel restore selettivo.
  // Le view e gli oggetti SQL restano invece successivi al caricamento.
  const mongoOptions = new Map();
  if (dbType === 'mongodb') {
    for (const item of schemaSnapshot.objects.collectionOptions || []) mongoOptions.set(item.name, item);
  }

  // Righe/documenti che la catena dichiara di contenere per le collection
  // effettivamente incluse nel ripristino: è il metro di paragone del risultato.
  let totalWrites = 0;
  const problems = [];
  const tracker = new Map();
  const largeObjectMap = new Map();
  const largeObjectReferences = new Map();
  const appliedObjects = new Set();
  for (let i = 0; i < chain.length; i++) {
    const args = { strategy, targetDb: db, layer: chain[i], isFirst: i === 0, onlyCollections, drop, log, problems, opts: { allowUnsafeSchema, largeObjectMap, largeObjectReferences, schemaSnapshot, appliedObjects, routineReferences }, explicitTarget, tracker, mongoOptions };
    totalWrites += dbType === 'mysql'
      ? await restoreLayerMySql(args)
      : (dbType === 'postgresql' || dbType === 'postgres')
        ? await restoreLayerPostgreSql(args)
        : await restoreLayerMongo(args);
  }
  for (const [name, count] of preserved) if (tracker.has(name)) tracker.get(name).preserved = count;

  // I validatori si applicano dopo i dati: la sorgente può contenere documenti
  // anteriori al validatore corrente. Vale anche per un restore selettivo.
  if (dbType === 'mongodb') {
    for (const [name, metadata] of mongoOptions) {
      if (onlyCollections && !onlyCollections.includes(name)) continue;
      await preparaCollectionMongo(strategy.client, db, name, metadata.options, { metadata });
    }
    // Ogni elenco finale, anche vuoto, sostituisce quello precedente. Gli
    // errori sono fatali: nessun restore riuscito può perdere un indice.
    for (const [collectionName, indexes] of Object.entries(schemaSnapshot.indexes)) {
      if (onlyCollections && !onlyCollections.includes(collectionName)) continue;
      const collection = strategy.client.db(db).collection(collectionName);
      for (const idx of indexes) {
        if (idx.name === '_id_') continue;
        const { key, name, v, ns, ...opts } = require('../../db/mongoSchemaBson').decodificaMetadati(idx);
        try { await collection.createIndex(key, { name, ...opts }); }
        catch (err) {
          throw new Error(`Indice "${name}" su "${collectionName}" non ricreato: ${err.message}. Il ripristino è incompleto.`);
        }
      }
    }
  }

  // Terza fase: oggetti di schema (chiavi esterne, view, routine, trigger,
  // eventi; su MongoDB view e opzioni di collection). Va DOPO tabelle e dati e
  // non prima, per due motivi indipendenti: una FK verso una tabella non ancora
  // creata fallisce, e una FK già attiva impone alle righe un ordine di
  // caricamento che il backup non descrive. Un ripristino selettivo
  // (onlyCollections) conserva soltanto gli ausiliari delle tabelle scelte.
  // I file degli oggetti sono fotografie complete: applicare ogni layer
  // ricreerebbe gli oggetti precedenti, inclusi quelli poi rimossi.
  const pg = dbType === 'postgresql' || dbType === 'postgres';
  if (!onlyCollections || pg || dbType === 'mysql') {
    try {
      let schemaObjects = { ...schemaSnapshot.objects };
      if (pg) schemaObjects.types = [];
      if (onlyCollections) {
        // Il formato storico mescolava indici e FK: normalizzarlo prima del
        // filtro permette di conservare entrambi per le sole tabelle scelte.
        schemaObjects = normalizzaLayerBackup({
          dbType, database: schemaSnapshot.db, schemas: [], objects: schemaObjects,
        }, { allowUnsafeSchema }).objects;
        const pertinente = sql => {
          const table = require('../../db/artefatti').estraiBersaglio(sql).table.parts.at(-1);
          return onlyCollections.includes(table.quoted || dbType === 'mysql' ? table.value : table.value.toLowerCase());
        };
        if (dbType === 'mysql') {
          schemaObjects = { foreignKeys: (schemaObjects.foreignKeys || []).filter(pertinente),
            triggers: (schemaObjects.triggers || []).filter(item => onlyCollections.includes(item.table)) };
        } else {
        const owned = await strategy.pool.query(`SELECT s.relname AS name FROM pg_catalog.pg_class s
          JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
          JOIN pg_catalog.pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
          JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
          WHERE s.relkind='S' AND n.nspname=$1 AND t.relname=ANY($2::text[])`, [db, onlyCollections]);
        const sequences = (schemaObjects.sequences || []).filter(s => onlyCollections.includes(s.ownerTable));
        const names = new Set([...owned.rows.map(s => s.name), ...sequences.map(s => s.name)]);
        schemaObjects = {
          sequences, sequenceValues: (schemaObjects.sequenceValues || []).filter(s => names.has(s.name)),
          indexes: (schemaObjects.indexes || []).filter(pertinente),
          foreignKeys: (schemaObjects.foreignKeys || []).filter(pertinente),
          triggers: (schemaObjects.triggers || []).filter(item => onlyCollections.includes(item.table)),
        };
        }
      }
      await restoreSchemaObjects({
        strategy, targetDb: db, dbType, oggetti: schemaObjects,
        // Il database in cui il backup è stato PRESO: serve a riqualificare le
        // DDL che nominano lo schema di origine (view e trigger di MySQL).
        dbOrigine: schemaSnapshot.db, problems, log, allowUnsafeSchema, applied: appliedObjects, preserveViewIdentity,
      });
    } catch (err) {
      problems.push(`oggetti di schema del layer ${schemaSnapshot.layerId || first.id}: ${err.message}`);
    }
  }

  const verifyDb = (dbType === 'postgresql' || dbType === 'postgres')
    ? pgTargetSchema(db, chain[0], explicitTarget)
    : db;
  const verified = await verificaRisultatoFinale({
    strategy, dbType, targetDb: verifyDb, tracker, problems, log,
  });

  const summary = {
    targetDb: db,
    layers: chain.length,
    totalDocs: verified.total,
    expectedDocs: verified.expectedTotal,
    totalWrites,
    collections: verified.collections,
    problems,
    equivalenzaDati: equivalenzaCatena(chain),
    equivalenza: equivalenzaConSchema(equivalenzaCatena(chain), schemaSnapshot),
    coerenzaSchema: coerenzaOggetti(schemaSnapshot),
    ...(largeObjectMap.size ? { largeObjects: [...largeObjectMap.values()] } : {}),
  };

  // Un ripristino incompleto non deve mai risultare "riuscito": né in UI, né
  // nell'audit, né nella notifica Slack. L'errore porta con sé il riepilogo, così
  // il chiamante può comunque dire quanto è stato applicato prima di fermarsi.
  if (problems.length) {
    const err = new Error(
      `Ripristino incompleto: cardinalita finale ${verified.total} di ${verified.expectedTotal} documenti/righe attesi `
      + `(${totalWrites} scritture applicate). ` +
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
  if (verified.total === 0 && hasUnknownCounts) {
    const err = new Error(
      'Ripristino terminato senza applicare alcun documento/riga: verifica i permessi sul database di destinazione e il contenuto del backup.'
    );
    err.summary = summary;
    throw err;
  }
  return summary;
}

module.exports = {
  runRestore,
  resolveChain,
  preflightChain,
  restoreSchemaObjects,
  riqualificaDdl,
  senzaDefiner,
  checkApplied,
  assertSafeSchemaSql,
  splitStatements,
  eliminaSePresente,
  cardinalitaDestinazione,
};
