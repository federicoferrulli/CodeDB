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
const { readLines, readManifest, fileDelBackup, verifyBackupDir } = require('./util');
const { isSqlGeometryType } = require('../../db/geometry');
// Come si scrive il nome di una tabella o di una colonna: regola unica per
// tutto il repo (vedi db/identificatori.js).
const { quotaSempre } = require('../../db/identificatori');
const { normalizzaLayerBackup, validaDdlCollezione } = require('../../db/artefatti');
const myQid = (name) => quotaSempre(name, 'mysql');

// Tipi che il dump salva in esadecimale perché il driver li consegna come
// Buffer, che non sopravvive al giro EJSON del file NDJSON. Vedi engine.js.
const TIPI_BINARI_MYSQL = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit',
]);

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
    const objects = objectsFile
      ? EJSON.parse(fs.readFileSync(fileDelBackup(layer.dir, objectsFile.path, 'file di oggetti'), 'utf8'))
      : null;
    normalizzaLayerBackup({
      dbType: layer.manifest.dbType,
      database: layer.manifest.db,
      schemas,
      collections: layer.manifest.files.filter((f) => f.kind === 'data').map((f) => f.collection),
      objects,
      integrity: { verifiedCount: report.okCount, unverifiableCount: report.unverifiableCount },
    }, { allowUnsafeSchema });
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
function riqualificaDdl(ddl, dbOrigine, dbDestinazione) {
  if (!dbOrigine || dbOrigine === dbDestinazione) return String(ddl);
  const esc = String(dbOrigine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const riscritta = String(ddl).replace(
    new RegExp('`' + esc + '`\\s*\\.', 'g'),
    myQid(dbDestinazione) + '.',
  );

  // La sostituzione copre la forma che `SHOW CREATE VIEW`/`TRIGGER` producono
  // davvero (nome fra backtick seguito da un punto). Se DOPO la riscrittura il
  // nome del database di origine compare ancora, vuol dire che era scritto in
  // una forma non prevista — e proseguire creerebbe un oggetto che continua a
  // leggere il database ORIGINALE: il ripristino "riesce" e punta altrove.
  // Meglio fermarsi e dirlo: era il fallimento silenzioso che questa funzione
  // deve impedire, non uno che può permettersi di produrre.
  const residuo = new RegExp('(^|[^\\w`])' + esc + '(?![\\w])', 'i');
  if (residuo.test(riscritta.replace(new RegExp('`' + esc + '`(?!\\s*\\.)', 'g'), ''))) {
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
async function restoreSchemaObjects({ strategy, targetDb, dbType, oggetti, dbOrigine, problems, log }) {
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
  }).objects;

  if (dbType === 'mongodb') {
    const client = strategy.client;
    for (const opt of oggetti.collectionOptions || []) {
      try {
        // `collMod` applica le opzioni a una collection che i dati hanno già
        // creato; se non esiste ancora (collection vuota) la si crea.
        await client.db(targetDb).command({ collMod: opt.name, ...opt.options });
      } catch (err) {
        if (/not found|NamespaceNotFound/i.test(err.message)) {
          await client.db(targetDb).createCollection(opt.name, opt.options)
            .catch((e) => problems.push(`opzioni di "${opt.name}": ${e.message}`));
        } else {
          problems.push(`opzioni di "${opt.name}": ${err.message}`);
        }
      }
    }
    for (const v of oggetti.views || []) {
      try {
        await client.db(targetDb).createCollection(v.name, {
          viewOn: v.viewOn,
          pipeline: v.pipeline || [],
          ...(v.collation ? { collation: v.collation } : {}),
        });
      } catch (err) {
        if (!/already exists/i.test(err.message)) problems.push(`view "${v.name}": ${err.message}`);
      }
    }
    const n = (oggetti.views || []).length + (oggetti.collectionOptions || []).length;
    if (n && log) log.info(`  Oggetti di schema applicati: ${n}`);
    return;
  }

  // --- SQL -----------------------------------------------------------------
  const esegui = async (sql, cosa) => {
    const pulito = riqualificaDdl(senzaDefiner(String(sql).trim()), dbOrigine, targetDb);
    await strategy.collectionAggregate(targetDb, null, { pipeline: pulito });
    if (log) log.info(`  ${cosa} applicato/a`);
  };

  for (const fk of oggetti.foreignKeys || []) {
    try {
      await esegui(fk, 'vincolo');
    } catch (err) {
      if (!/duplicate|already exists|esiste già/i.test(err.message)) {
        problems.push(`chiave esterna: ${err.message}`);
      }
    }
  }

  // Le view possono dipendere da altre view: invece di indovinare un ordine, si
  // riprova finché almeno una riesce. Il ciclo termina sempre — o non resta
  // nulla, o un giro intero non fa progresso.
  let rimaste = [...(oggetti.views || [])];
  while (rimaste.length) {
    const falliti = [];
    let progresso = false;
    for (const v of rimaste) {
      try {
        await esegui(v.ddl, `view "${v.name}"`);
        progresso = true;
      } catch (err) {
        falliti.push({ ...v, errore: err.message });
      }
    }
    if (!progresso) {
      for (const v of falliti) problems.push(`view "${v.name}": ${v.errore}`);
      break;
    }
    rimaste = falliti;
  }

  for (const gruppo of [
    { voci: oggetti.sequences || [], etichetta: (s) => `sequenza "${s.name}"` },
    { voci: oggetti.routines || [], etichetta: (r) => `routine "${r.name}"` },
    { voci: oggetti.triggers || [], etichetta: (t) => `trigger "${t.name}"` },
    { voci: oggetti.events || [], etichetta: (e) => `evento "${e.name}"` },
  ]) {
    for (const voce of gruppo.voci) {
      try {
        await esegui(voce.ddl, gruppo.etichetta(voce));
      } catch (err) {
        problems.push(`${gruppo.etichetta(voce)}: ${err.message}`);
      }
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
    for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
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
        const idxPath = fileDelBackup(layer.dir, idxFile.path, 'file degli indici');
        const indexes = EJSON.deserialize(JSON.parse(fs.readFileSync(idxPath, 'utf8')), { relaxed: false });
        for (const idx of indexes) {
          if (idx.name === '_id_') continue;
          const { key, name, v, ns, ...opts } = idx;
          try {
            await collection.createIndex(key, { name, ...opts });
          } catch (err) {
            throw new Error(
              `Indice "${name || '(senza nome)'}" su "${f.collection}" non ricreato: ${err.message}. `
              + 'Il ripristino è stato interrotto per non dichiarare riuscito un database privo dei vincoli originali.'
            );
          }
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
          await conn.query(ddl.replace(/;\s*$/, ''));
          existingTables.add(f.collection);
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
      const verb = isFirst ? 'INSERT' : 'REPLACE';
      let batch = [];
      let columns = null;
      let applied = 0;
      const flush = async () => {
        if (!batch.length) return;
        const listaColonne = columns.map((c) => myQid(c)).join(', ');
        const geoNelBatch = columns.some((c) => geoTarget.has(c));
        if (!geoNelBatch) {
          // Percorso veloce, invariato: nessuna geometria, insert multiplo.
          await conn.query(`${verb} INTO ${tableId} (${listaColonne}) VALUES ?`, [batch]);
        } else {
          // Con le geometrie ogni riga ha bisogno delle proprie espressioni,
          // quindi la clausola VALUES si costruisce esplicitamente.
          const params = [];
          const tuple = batch.map((riga) => {
            const segnaposti = columns.map((c, i) => {
              const info = geoTarget.get(c);
              const v = riga[i];
              if (!info || v == null) { params.push(v); return '?'; }
              // WKB esadecimale (formato del dump). I backup prodotti prima di
              // questa correzione non contengono geometrie utilizzabili — il
              // loro ripristino falliva — quindi non c'è un formato precedente
              // da riconoscere qui.
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
          await conn.query(
            `${verb} INTO ${tableId} (${listaColonne}) VALUES ${tuple.join(', ')}`, params,
          );
        }
        applied += batch.length;
        batch = [];
      };
      for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
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
        const sql = readSchemaFile(layer.dir, schemaFile, f.collection, {
          ...opts, dbType: 'postgresql', database: schemaFile.schema || layer.manifest.db,
        });
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
    // Le righe vanno passate a `collectionImport` come OGGETTI, non come testo:
    // `EJSON.deserialize` di una stringa restituisce la stringa, che il metodo
    // rifiuta ("la riga deve essere un oggetto") — cioè ogni riga sarebbe
    // fallita. Qui si parsifica una volta sola, ed è anche il punto in cui le
    // colonne salvate in esadecimale tornano binarie (CDB-A87).
    const binarie = Array.isArray(f.binarie) ? f.binarie : [];
    for await (const line of readLines(fileDelBackup(layer.dir, f.path, 'file di dati'))) {
      let riga;
      try {
        riga = EJSON.parse(line, { relaxed: true });
      } catch (err) {
        failed += 1;
        if (firstErrors.length < 3) firstErrors.push(`riga non leggibile: ${err.message}`);
        continue;
      }
      for (const col of binarie) {
        // `encode(col,'hex')` nel dump: senza riconvertirlo, PostgreSQL
        // scriverebbe in bytea i CARATTERI della stringa esadecimale invece
        // dei byte che rappresentano.
        if (typeof riga[col] === 'string') riga[col] = Buffer.from(riga[col], 'hex');
      }
      batch.push(riga);
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

  // Deve precedere anche un eventuale --drop: un backup alterato o incompleto
  // non può provocare alcuna mutazione prima che TUTTA la catena sia valida.
  await preflightChain(chain, log, { allowUnsafeSchema });

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

  // Terza fase: oggetti di schema (chiavi esterne, view, routine, trigger,
  // eventi; su MongoDB view e opzioni di collection). Va DOPO tabelle e dati e
  // non prima, per due motivi indipendenti: una FK verso una tabella non ancora
  // creata fallisce, e una FK già attiva impone alle righe un ordine di
  // caricamento che il backup non descrive. Un ripristino selettivo
  // (onlyCollections) non li tocca: gli oggetti descrivono l'intero database.
  const oggetti = onlyCollections ? [] : chain
    .map((l) => ({ layer: l, file: l.manifest.files.find((f) => f.kind === 'objects') }))
    .filter((x) => x.file);
  for (const { layer, file } of oggetti) {
    try {
      const testo = fs.readFileSync(fileDelBackup(layer.dir, file.path, 'file di oggetti'), 'utf8');
      await restoreSchemaObjects({
        strategy, targetDb: db, dbType, oggetti: EJSON.parse(testo),
        // Il database in cui il backup è stato PRESO: serve a riqualificare le
        // DDL che nominano lo schema di origine (view e trigger di MySQL).
        dbOrigine: layer.manifest.db, problems, log,
      });
    } catch (err) {
      problems.push(`oggetti di schema del layer ${layer.manifest.id}: ${err.message}`);
    }
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
};
