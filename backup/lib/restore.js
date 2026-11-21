'use strict';

/* ---------------------------------------------------------------------------
 * Orchestratore del ripristino da una cartella di backup.
 *
 * I sottosistemi dedicati vivono nei moduli interni di `backup/lib/`:
 * - `restore-catena.js`: risoluzione catena, preflight SHA-256/righe e guardie DDL
 * - `restore-oggetti.js`: riqualificazione DDL, rimozione DEFINER e oggetti di schema
 * - `restore-mongo.js`: applicazione layer su MongoDB
 * - `restore-mysql.js`: applicazione layer su MySQL
 * - `restore-postgres.js`: applicazione layer su PostgreSQL
 * ------------------------------------------------------------------------- */

const { preparaCollectionMongo } = require('../../db/mongoCollectionOptions');
const { quotaSempre } = require('../../db/identificatori');
const { normalizzaLayerBackup } = require('../../db/artefatti');
const { equivalenzaCatena } = require('./tombstones');
const fotografieSchema = require('./schema-snapshot');
const { livelliAttivi, ultimaRimozione } = require('./inventario-entita');

const {
  eliminaSePresente, checkApplied, resolveChain, preflightChain,
  splitStatements, assertSafeSchemaSql,
} = require('./restore-catena');
const { riqualificaDdl, senzaDefiner, restoreSchemaObjects } = require('./restore-oggetti');
const { restoreLayerMongo } = require('./restore-mongo');
const { restoreLayerMySql } = require('./restore-mysql');
const { pgTargetSchema, restoreLayerPostgreSql } = require('./restore-postgres');

const myQid = (name) => quotaSempre(name, 'mysql');
const pgQid = (name) => quotaSempre(name, 'postgresql');

async function cardinalitaDestinazione({ strategy, dbType, targetDb, collection, identity, pgPhysical = false, mongoSession = null }) {
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
      `SELECT COUNT(*) AS cardinality, ${distinct} AS "distinctIdentities" FROM ${pgPhysical ? 'ONLY ' : ''}${pgQid(targetDb)}.${pgQid(collection)}`,
    );
    return {
      cardinality: Number(res.rows[0].cardinality),
      distinctIdentities: identity ? Number(res.rows[0].distinctIdentities) : null,
    };
  }
  const collectionRef = strategy.client.db(targetDb).collection(collection);
  const options = mongoSession ? { session:mongoSession } : {};
  const cardinality = await collectionRef.countDocuments({}, options);
  let distinctIdentities = null;
  if (identity) {
    const result = await collectionRef.aggregate([
      { $group: { _id: Object.fromEntries(identity.columns.map((c) => [c, `$${c}`])) } },
      { $count: 'n' },
    ], options).toArray();
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
      strategy, dbType, targetDb, collection, identity: expected.identity, pgPhysical:expected.pgPhysical,
    });
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

async function runRestore(options) {
  let { session, backupDir, targetDb, onlyCollections, drop, log, allowUnsafeSchema = false, filtraErroreOrigine } = options;
  const { strategy, dbType } = session;
  const originali = resolveChain(backupDir);
  const chain = livelliAttivi(originali);
  const first = chain[0].manifest;
  if (first.dbType !== dbType) {
    throw new Error(`Il backup è di tipo "${first.dbType}" ma la connessione di destinazione è "${dbType}".`);
  }
  const db = targetDb || first.db;
  const explicitTarget = targetDb || null;
  log.info(`Catena di ripristino (${chain.length} layer): ${chain.map((l) => l.manifest.id).join(' → ')}`);
  log.info(`Database di destinazione: ${db}`);

  await preflightChain(originali, log, { allowUnsafeSchema, filtraErroreOrigine });
  const schemaSnapshot = fotografieSchema.risolviOggettiCatena(originali, { allowUnsafeSchema, filtraErroreOrigine });
  const postgres = ['postgresql', 'postgres'].includes(dbType);
  if (postgres) onlyCollections = require('../../db/pg-partizioni').selezionePartizioni(chain, onlyCollections);
  const ddlSelezionate = onlyCollections && postgres
    ? require('../../db/pg-routine-selezione').ddlSelettiveBackup(chain, onlyCollections, { allowUnsafeSchema }) : null;
  const routineReferences = onlyCollections && ['postgresql', 'postgres'].includes(dbType)
    ? await require('../../db/pg-routine-selezione').riferimentiRoutineBackup(chain, onlyCollections) : [];
  if (schemaSnapshot.nota) (log.warn || log.info).call(log, `  Oggetti di schema: ${schemaSnapshot.nota}`);

  if (onlyCollections) {
    const available = new Set(chain.flatMap((l) => l.manifest.files.filter((f) => f.kind === 'data').map((f) => f.collection)));
    for (const c of onlyCollections) {
      if (!available.has(c)) throw new Error(`Collection/tabella "${c}" non presente nel backup.`);
    }
  }

  const prime = new Map();
  for (const layer of chain) for (const file of layer.manifest.files) {
    if (file.kind !== 'data' || prime.has(file.collection) || (onlyCollections && !onlyCollections.includes(file.collection))) continue;
    const schema = layer.manifest.files.find(f=>f.kind==='schema' && f.collection===file.collection);
    if (drop && dbType !== 'mongodb' && !schema) throw new Error('Schema di "'+file.collection+'" assente dal backup: impossibile sostituire la tabella.');
    prime.set(file.collection,file);
  }
  const contesto = { chain, originali, schemaSnapshot, prime, db, explicitTarget, onlyCollections, ddlSelezionate, routineReferences };
  if (!postgres || !drop) return applicaCatena(strategy, options, contesto);
  // DROP, dati, oggetti e controlli finali devono riuscire sulla medesima
  // connessione prima che la sostituzione diventi visibile.
  const tx = await require('../../db/pg-restore-transaction').apriTransazioneRipristino(strategy);
  try {
    const result = await applicaCatena(tx.strategy, options, contesto);
    await tx.commit();
    return result;
  } catch (error) {
    if (tx.state === 'aperta') await tx.rollback();
    throw error;
  }
}

async function applicaCatena(strategy, options, contesto) {
  const { session: { dbType }, drop, log, allowUnsafeSchema = false, preserveViewIdentity = false } = options;
  const { chain, originali, schemaSnapshot, prime, db, explicitTarget, onlyCollections, ddlSelezionate, routineReferences } = contesto;
  const first = chain[0].manifest;
  const preserved = new Map();
  if (!drop && typeof strategy.listCollections === 'function') {
    let existing;
    try { existing = await strategy.listCollections(db, { includeCounts: false }); }
    catch (err) { if (err.errno === 1049 || err.code === '3F000') existing = []; else throw err; }
    const names = new Set(existing.filter(item => item.type !== 'view').map(item => item.name));
    for (const file of prime.values()) {
      if (!file.identity || !names.has(file.collection) || (onlyCollections && !onlyCollections.includes(file.collection))) continue;
      const count = await require('./merge-identita').contaIdentitaPreservate({
        strategy, dbType, targetDb: db, collection: file.collection, chain, file,
        retarget: (value, source, destination) => riqualificaDdl(value, source, destination, 'postgresql'),
      });
      preserved.set(file.collection, count);
    }
  }

  if (dbType === 'mongodb') {
    for (const [name, indexNames] of Object.entries(schemaSnapshot.indexNames)) {
      if (onlyCollections && !onlyCollections.includes(name)) continue;
      for (const indexName of indexNames) {
        try { await strategy.client.db(db).collection(name).dropIndex(indexName); }
        catch (err) { if (![26, 27].includes(err.code) && !/ns not found|namespace.*not found|index not found/i.test(err.message)) throw err; }
      }
    }
  } else if (typeof strategy.listCollections === 'function') {
    let existing;
    try { existing = await strategy.listCollections(db, { includeCounts: false }); }
    catch (err) { if (err.errno === 1049 || err.code === '3F000') existing = []; else throw err; }
    const tables = new Set(existing.filter(item => item.type !== 'view').map(item => item.name));
    const quota = dbType === 'mysql' ? myQid : pgQid;
    // PostgreSQL elimina gli indici attaccati insieme al loro indice padre.
    const indiciFigli = dbType === 'mysql' ? new Set() : new Set((await strategy.pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_inherits i ON i.inhrelid=c.oid WHERE c.relkind IN ('i','I') AND n.nspname=$1`, [db])).rows.map(r=>r.relname));
    for (const kind of ['triggers', 'foreignKeys', 'indexes']) {
      for (const item of schemaSnapshot.managedSql[kind]) {
        if (kind === 'indexes' && indiciFigli.has(item.name)) continue;
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

  if (drop) {
    const rimosse = ultimaRimozione(originali);
    if (rimosse.size) {
      const presenti = new Set((await strategy.listCollections(db, { includeCounts: false })).filter(c => c.type !== 'view').map(c => c.name));
      for (const nome of rimosse.keys()) {
        if (presenti.has(nome) && (!onlyCollections || onlyCollections.includes(nome))) await strategy.dropCollection(db, nome);
      }
    }
  }
  const mongoOptions = new Map();
  if (dbType === 'mongodb') {
    for (const item of schemaSnapshot.objects.collectionOptions || []) mongoOptions.set(item.name, item);
  }

  let totalWrites = 0;
  const problems = [];
  const tracker = new Map();
  const largeObjectMap = new Map();
  const largeObjectReferences = new Map();
  const appliedObjects = new Set();
  for (let i = 0; i < chain.length; i++) {
    const args = {
      strategy, targetDb: db, layer: chain[i], isFirst: i === 0, onlyCollections, drop, log, problems,
      opts: { allowUnsafeSchema, largeObjectMap, largeObjectReferences, schemaSnapshot, appliedObjects, routineReferences, ddlSelezionate, tabelleDaSostituire: prime.keys() },
      explicitTarget, tracker, mongoOptions,
    };
    totalWrites += dbType === 'mysql'
      ? await restoreLayerMySql(args)
      : (dbType === 'postgresql' || dbType === 'postgres')
        ? await restoreLayerPostgreSql(args)
        : await restoreLayerMongo(args);
  }
  for (const [name, count] of preserved) if (tracker.has(name)) tracker.get(name).preserved = count;

  if (dbType === 'mongodb') {
    for (const [name, metadata] of mongoOptions) {
      if (onlyCollections && !onlyCollections.includes(name)) continue;
      await preparaCollectionMongo(strategy.client, db, name, metadata.options, { metadata });
    }
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

  const pg = dbType === 'postgresql' || dbType === 'postgres';
  if (!onlyCollections || pg || dbType === 'mysql') {
    try {
      let schemaObjects = { ...schemaSnapshot.objects };
      if (pg) {
        schemaObjects.types = [];
        const esistenti = new Set((await strategy.listCollections(db,{includeCounts:false})).map(t=>t.name));
        schemaObjects.sequenceValues = [...(schemaObjects.sequenceValues || []), ...require('../../db/pg-partizioni').valoriAutonomi(chain,onlyCollections,esistenti)];
      }
      if (onlyCollections) {
        schemaObjects = normalizzaLayerBackup({
          dbType, database: schemaSnapshot.db, schemas: [], objects: schemaObjects,
        }, { allowUnsafeSchema }).objects;
        const pertinente = sql => {
          const table = require('../../db/artefatti').estraiBersaglio(sql).table.parts.at(-1);
          return onlyCollections.includes(table.quoted || dbType === 'mysql' ? table.value : table.value.toLowerCase());
        };
        if (dbType === 'mysql') {
          schemaObjects = {
            foreignKeys: (schemaObjects.foreignKeys || []).filter(pertinente),
            triggers: (schemaObjects.triggers || []).filter(item => onlyCollections.includes(item.table)),
          };
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
    equivalenzaDati: equivalenzaCatena(originali),
    equivalenza: fotografieSchema.equivalenzaConSchema(equivalenzaCatena(originali), schemaSnapshot),
    coerenzaSchema: fotografieSchema.coerenzaOggetti(schemaSnapshot),
    ...(largeObjectMap.size ? { largeObjects: [...largeObjectMap.values()] } : {}),
  };

  if (problems.length) {
    const err = new Error(
      `Ripristino incompleto: cardinalita finale ${verified.total} di ${verified.expectedTotal} documenti/righe attesi `
      + `(${totalWrites} scritture applicate). ` +
      problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` (e altri ${problems.length - 5})` : '')
    );
    err.summary = summary;
    throw err;
  }
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
