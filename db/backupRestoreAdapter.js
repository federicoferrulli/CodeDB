'use strict';

const path = require('path');
const fs = require('fs');
const { EJSON } = require('bson');
const { resolveChain, preflightChain, runRestore, cardinalitaDestinazione } = require('../backup/lib/restore');
const { createImportArtifactAdapter } = require('./importArtifactAdapter');
const { riqualificaDdl } = require('../backup/lib/restore');
const { equivalenzaCatena } = require('../backup/lib/tombstones');
const {
  readSchemaObjects, canonicalSql, canonicalSqlForDb, canonicalSchemaInventory,
  canonicalMongoIndex, inventoryDifferences,
} = require('./schemaObjects');

function descriviBackup(backupDir, onlyCollections = null) {
  const resolved = path.resolve(backupDir);
  const chain = resolveChain(resolved);
  const first = chain[0].manifest;
  const selected = onlyCollections ? new Set(onlyCollections) : null;
  const latest = new Map();
  for (const layer of chain) {
    for (const file of layer.manifest.files.filter((item) => item.kind === 'data')) {
      if (!selected || selected.has(file.collection)) latest.set(file.collection, file);
    }
  }
  if (selected) {
    for (const name of selected) if (!latest.has(name)) throw new Error(`Collection/tabella "${name}" non presente nel backup.`);
  }
  return {
    kind: 'backup-chain', backupDir: resolved, dbType: first.dbType,
    sourceDb: first.db, onlyCollections: onlyCollections || null,
    equivalenza: equivalenzaCatena(chain),
    layers: chain.map(({ manifest }) => ({
      id: manifest.id, type: manifest.type,
      manifestSha256: manifest.files.map((file) => file.sha256 || null),
    })),
    collections: [...latest].map(([name, file]) => ({
      name, rows: Number.isSafeInteger(file.sourceCardinality) ? file.sourceCardinality : file.count,
      identity: file.identity || null, schemaObjects: 0,
    })),
  };
}

function createBackupRestoreAdapter({ strategy, dbType, connName, recoveryRoot, log, signal = null }) {
  const type = dbType === 'postgres' ? 'postgresql' : dbType;
  const shell = createImportArtifactAdapter({ strategy, dbType: type, connName, recoveryRoot, log, signal });
  let activeSignal = signal;
  let snapshot = null;
  let expectedSchema = null;
  let identities = new Map();



  function retargetObjects(objects, sourceDb, targetDb) {
    const copy = JSON.parse(JSON.stringify(objects || {}));
    for (const values of Object.values(copy)) {
      if (!Array.isArray(values)) continue;
      for (let i = 0; i < values.length; i++) {
        if (typeof values[i] === 'string') values[i] = riqualificaDdl(values[i], sourceDb, targetDb, type);
        else if (values[i] && typeof values[i] === 'object') {
          if (values[i].ddl) values[i].ddl = riqualificaDdl(values[i].ddl, sourceDb, targetDb, type);
          if (values[i].sql) values[i].sql = riqualificaDdl(values[i].sql, sourceDb, targetDb, type);
        }
      }
    }
    return copy;
  }

  function expectedSchemaOf(plan, stagingDb) {
    const chain = resolveChain(plan.source.backupDir);
    let objects = {};
    const indexes = {};
    const tables = {};
    for (const layer of chain) {
      for (const file of layer.manifest.files) {
        const absolute = path.join(layer.dir, file.path);
        if (file.kind === 'objects') objects = EJSON.parse(fs.readFileSync(absolute, 'utf8'));
        if (file.kind === 'schema' && (!plan.source.onlyCollections || plan.source.onlyCollections.includes(file.collection))) {
          tables[file.collection] = canonicalSqlForDb(riqualificaDdl(
            fs.readFileSync(absolute, 'utf8'), plan.sourceDb, stagingDb, type
          ), stagingDb);
        }
        if (file.kind === 'indexes' && (!plan.source.onlyCollections || plan.source.onlyCollections.includes(file.collection))) {
          indexes[file.collection] = EJSON.parse(fs.readFileSync(absolute, 'utf8'))
            .filter((index) => index.name !== '_id_').map(canonicalMongoIndex).sort();
        }
      }
    }
    const retargeted = retargetObjects(objects, plan.sourceDb, stagingDb);
    if (type !== 'mongodb') {
      indexes.__all = (retargeted.foreignKeys || []).map((sql) => canonicalSqlForDb(sql, stagingDb)).sort();
      delete retargeted.foreignKeys;
    }
    return { objects: canonicalSchemaInventory(retargeted, { db: stagingDb }), indexes, tables };
  }

  async function schemaOf(db, plannedCollections) {
    const result = {
      objects: canonicalSchemaInventory(await readSchemaObjects(strategy, type, db), { db }),
      indexes: {}, tables: {},
    };
    const sqlAux = [];
    for (const collection of plannedCollections) {
      if (type === 'mongodb') {
        // Senza questo metodo il lato REALE del confronto resterebbe vuoto e
        // ogni indice atteso risulterebbe mancante: una divergenza inventata,
        // non misurata. Finche' era un `typeof ... === 'function'` opzionale, e
        // `MongoDbStrategy` non lo implementava, ogni ripristino di un database
        // con un indice falliva la verifica dello staging.
        if (typeof strategy.indexList !== 'function') {
          throw new Error(`La strategia ${type} non espone indexList: gli indici non sono verificabili.`);
        }
        result.indexes[collection.name] = (await strategy.indexList(db, collection.name))
          .filter((index) => index.name !== '_id_').map(canonicalMongoIndex).sort();
      } else if (type !== 'mongodb' && typeof strategy.tableAuxDdl === 'function') {
        const aux = await strategy.tableAuxDdl(db, collection.name);
        sqlAux.push(...(type === 'mysql' ? [] : (aux.indexes || [])), ...(aux.foreignKeys || []));
      }
      if (type !== 'mongodb' && typeof strategy.tableDdl === 'function') {
        result.tables[collection.name] = canonicalSqlForDb(await strategy.tableDdl(db, collection.name), db);
      }
    }
    if (type !== 'mongodb') result.indexes.__all = sqlAux.map((sql) => canonicalSqlForDb(sql, db)).sort();
    return result;
  }

  async function snapshotOf(db) {
    const collections = (await strategy.listCollections(db)).filter((item) => item.type !== 'view');
    const counts = [];
    for (const collection of collections) {
      const planned = snapshot && snapshot.counts.find((item) => item.name === collection.name);
      const identity = planned ? planned.identity : identities.get(collection.name) || null;
      const value = await cardinalitaDestinazione({
        strategy, dbType: type, targetDb: db, collection: collection.name, identity,
      });
      counts.push({ name: collection.name, identity, ...value });
    }
    return {
      counts: counts.sort((a, b) => a.name.localeCompare(b.name)),
      schema: await schemaOf(db, collections),
    };
  }

  return {
    setSignal(next) { activeSignal = next; shell.setSignal(next); },
    async validatePlan(plan) {
      if (plan.kind !== 'restore-backup' || plan.dbType !== type) throw new Error('Piano restore incompatibile con la strategia.');
      const current = descriviBackup(plan.source.backupDir, plan.source.onlyCollections);
      if (JSON.stringify(current) !== JSON.stringify(plan.source)) {
        throw new Error('La catena backup e cambiata dopo la conferma del piano.');
      }
      await preflightChain(resolveChain(plan.source.backupDir), log, { allowUnsafeSchema: plan.allowUnsafeSchema === true });
      identities = new Map(plan.collections.map((collection) => [collection.name, collection.identity || null]));
    },
    destinationExists: shell.destinationExists,
    createRecovery: shell.createRecovery,
    prepareStaging(plan, recovery, targetExists) {
      // Un restore selettivo parte sempre dalla copia corrente; `drop` elimina
      // soltanto le entita selezionate, non il resto del database.
      const basePlan = plan.source.onlyCollections && targetExists ? { ...plan, drop: false } : plan;
      return shell.prepareStaging(basePlan, recovery, targetExists);
    },
    async apply(plan, staging) {
      if (activeSignal && activeSignal.aborted) throw Object.assign(new Error('Restore annullato.'), { code: 'IMPORT_ABORTED' });
      const summary = await runRestore({
        session: { strategy, dbType: type }, backupDir: plan.source.backupDir,
        targetDb: staging.db, onlyCollections: plan.source.onlyCollections,
        drop: !!plan.drop, log, allowUnsafeSchema: plan.allowUnsafeSchema === true,
      });
      expectedSchema = expectedSchemaOf(plan, staging.db);
      snapshot = await snapshotOf(staging.db);
      return summary;
    },
    async verify(_plan, where, staging) {
      if (!snapshot) throw new Error('Snapshot verificata dello staging mancante.');
      const actual = where === 'staging' ? snapshot : await snapshotOf(_plan.targetDb);
      const baseline = where === 'staging' ? { ...snapshot, schema: expectedSchema } : snapshot;

      // Le collection ATTESE dal piano, confrontate con quelle presenti. Per lo
      // staging `actual.counts` e `snapshot.counts` sono lo stesso oggetto,
      // quindi il confronto dei conteggi non poteva accorgersi di una
      // collection MANCANTE: entrambe le liste la omettevano insieme. Una
      // collection dichiarata dal backup e assente dalla destinazione e' una
      // perdita di dati, non un dettaglio di schema.
      const presenti = new Set(actual.counts.map((item) => item.name));
      const collezioniMancanti = _plan.collections
        .map((collection) => collection.name)
        .filter((name) => !presenti.has(name));

      const schemaDifferences = [
        ...inventoryDifferences(baseline.schema.objects, actual.schema.objects, { exact: true }),
      ];
      for (const name of new Set([
        ...Object.keys(baseline.schema.indexes || {}), ...Object.keys(actual.schema.indexes || {}),
      ])) {
        schemaDifferences.push(...inventoryDifferences(
          { [`indexes:${name}`]: baseline.schema.indexes[name] || [] },
          { [`indexes:${name}`]: actual.schema.indexes[name] || [] }, { exact: true }
        ));
      }
      for (const name of new Set([
        ...Object.keys(baseline.schema.tables || {}), ...Object.keys(actual.schema.tables || {}),
      ])) {
        if (baseline.schema.tables[name] !== actual.schema.tables[name]) {
          schemaDifferences.push({ field: `table:${name}`, missing: [baseline.schema.tables[name]], extras: [actual.schema.tables[name]] });
        }
      }
      const countsOk = JSON.stringify(actual.counts) === JSON.stringify(snapshot.counts);
      const ok = countsOk && !collezioniMancanti.length && schemaDifferences.length === 0;
      return {
        ok, schemaObjects: schemaDifferences.length === 0, schemaDifferences,
        missing: collezioniMancanti, snapshot: actual,
      };
    },
    promote: shell.promote,
    restore: shell.restore,
    cleanup: shell.cleanup,
  };
}

async function runRestoreViaPlan({
  session, backupDir, targetDb, onlyCollections, drop, log, recoveryRoot, connName = 'restore', onProgress,
  allowUnsafeSchema = false,
}) {
  const source = descriviBackup(backupDir, onlyCollections);
  const plan = require('./importPlan').creaPianoRestore({
    source, expectedDbType: session.dbType, connection: connName,
    targetDb: targetDb || source.sourceDb, drop: !!drop, allowUnsafeSchema,
  });
  const adapter = createBackupRestoreAdapter({
    strategy: session.strategy, dbType: session.dbType, connName,
    recoveryRoot, log,
  });
  const result = await require('./importPlan').eseguiPianoImport(plan, { adapter, onProgress });
  return { ...result,
    targetDb: plan.targetDb, layers: source.layers.length, fingerprint: plan.fingerprint,
    totalDocs: (result.verification && result.verification.snapshot && result.verification.snapshot.counts || [])
      .reduce((sum, item) => sum + item.cardinality, 0),
  };
}

module.exports = { descriviBackup, createBackupRestoreAdapter, runRestoreViaPlan };
