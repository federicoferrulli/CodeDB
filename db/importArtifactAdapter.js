'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { runBackup } = require('../backup/lib/engine');
const {
  runRestore, preflightChain, resolveChain, riqualificaDdl, cardinalitaDestinazione, restoreSchemaObjects,
} = require('../backup/lib/restore');
const { verifyBackupDir } = require('../backup/lib/util');
const { quotaSempre } = require('./identificatori');
const {
  scegliIdentitaSql, identityCompatibile, validaIdentity, chiaveIdentita,
} = require('../backup/lib/identity');
const {
  readSchemaObjects, objectInventory, canonicalSqlForDb, canonicalSchemaInventory,
  canonicalMongoIndex, inventoryDifferences,
} = require('./schemaObjects');

const BATCH = 500;
const quietLog = { info() {}, error() {} };

function nomeTecnico(base, role, max) {
  const suffix = `__codedb_${role}_${crypto.randomBytes(5).toString('hex')}`;
  return `${String(base).slice(0, Math.max(1, max - suffix.length))}${suffix}`;
}

function abortIf(signal) {
  if (signal && signal.aborted) {
    const err = new Error('Import annullato cooperativamente.');
    err.code = 'IMPORT_ABORTED';
    throw err;
  }
}


function retargetSchemaObjects(objects, sourceDb, targetDb, dbType) {
  if (!objects) return objects;
  const copy = JSON.parse(JSON.stringify(objects));
  for (const values of Object.values(copy)) {
    if (!Array.isArray(values)) continue;
    for (let i = 0; i < values.length; i++) {
      if (typeof values[i] === 'string') values[i] = riqualificaDdl(values[i], sourceDb, targetDb, dbType);
      else if (values[i] && typeof values[i] === 'object') {
        if (values[i].ddl) values[i].ddl = riqualificaDdl(values[i].ddl, sourceDb, targetDb, dbType);
        if (values[i].sql) values[i].sql = riqualificaDdl(values[i].sql, sourceDb, targetDb, dbType);
      }
    }
  }
  return copy;
}

function createImportArtifactAdapter({ strategy, dbType, connName, recoveryRoot, log = quietLog, signal = null }) {
  const type = dbType === 'postgres' ? 'postgresql' : dbType;
  const session = { strategy, dbType: type };
  let activeSignal = signal;

  async function databases() {
    return (await strategy.listDatabases()).map((db) => db.name);
  }

  async function exists(name) {
    return (await databases()).includes(name);
  }

  async function validaIdentitaMerge(plan) {
    for (const collection of plan.artifact.collections) {
      const planned = plan.collections.find((item) => item.name === collection.name);
      const expected = planned && planned.identity;
      if (!expected || !Array.isArray(expected.columns) || !expected.columns.length) {
        throw new Error(`La tabella "${collection.name}" non dichiara un'identita stabile.`);
      }
      validaIdentity(expected, { collection: collection.name });
      const identities = new Set();
      collection.docs.forEach((row, index) => {
        let key;
        try { key = chiaveIdentita(row, expected); }
        catch (err) { throw new Error(`Riga ${index + 1} di "${collection.name}": ${err.message}`); }
        if (identities.has(key)) {
          throw new Error(`La collection/tabella "${collection.name}" contiene un'identita duplicata alla riga ${index + 1}.`);
        }
        identities.add(key);
      });
      if (type === 'mongodb') continue;
      const info = await strategy.tableColumnsInfo(plan.targetDb, collection.name);
      const primary = await strategy.primaryKey(plan.targetDb, collection.name);
      const uniques = await strategy.uniqueIndexes(plan.targetDb, collection.name);
      const constraints = [];
      if (primary.length) constraints.push({ kind: 'primary-key', name: 'PRIMARY', columns: primary });
      for (let i = 0; i < uniques.length; i++) {
        constraints.push({ kind: 'unique', name: `unique_${i + 1}`, columns: uniques[i] });
      }
      const actual = scegliIdentitaSql(info.columns, constraints);
      if (!identityCompatibile(expected, actual)) {
        throw new Error(`L'identita della tabella "${collection.name}" diverge dal piano.`);
      }
    }
  }

  async function applicaArtefatto(plan, db, { upsert = false } = {}) {
    abortIf(activeSignal);
    const artifact = plan.artifact;
    const first = artifact.collections[0];
    if (!(await exists(db)) && (type !== 'mongodb' || artifact.collections.length)) {
      await strategy.createDatabase(db, type === 'mongodb' && first ? first.name : undefined);
    }

    // Prima si materializza TUTTO lo schema nello staging. Solo dopo che ogni
    // tabella e ogni identita sono compatibili puo partire la prima riga.
    for (const collection of artifact.collections) {
      const present = (await strategy.listCollections(db)).some((c) => c.name === collection.name);
      if (present) continue;
      if (type === 'mongodb') await strategy.createCollection(db, collection.name, {});
      else {
        if (!collection.ddl) throw new Error(`DDL di "${collection.name}" assente: impossibile creare la tabella.`);
        await strategy.collectionAggregate(db, collection.name, {
          pipeline: riqualificaDdl(collection.ddl, artifact.db, db, type),
        });
      }
    }
    for (const collection of artifact.collections) {
      abortIf(activeSignal);
      const identity = collection.identity || (type === 'mongodb'
        ? { kind: 'mongodb-id', columns: ['_id'] }
        : null);
      if (upsert && !identity) {
        throw new Error(`La tabella "${collection.name}" non dichiara un'identita stabile: il piano non puo fare upsert.`);
      }
      for (let i = 0; i < collection.docs.length; i += BATCH) {
        abortIf(activeSignal);
        const docs = collection.docs.slice(i, i + BATCH);
        if (!docs.length) continue;
        const result = await strategy.collectionImport(db, collection.name, {
          docs, upsert, conflictColumns: identity ? identity.columns : undefined,
        });
        if (!result || result.failed || result.inserted !== docs.length) {
          // `collectionImport` sa gia' PERCHE' ogni riga e' stata rifiutata:
          // ripete il batch riga per riga proprio per isolarlo. Riportare solo
          // «applicate 0 di 6» buttava via l'unica informazione con cui si puo'
          // fare qualcosa — quale colonna, quale vincolo, quale valore.
          const motivi = (result && Array.isArray(result.errors) ? result.errors : []).slice(0, 3);
          throw new Error(
            `Import incompleto di "${collection.name}": applicate ${result && result.inserted || 0} `
            + `di ${docs.length} righe/documenti.`
            + (motivi.length ? ` Motivo: ${motivi.join('; ')}.` : '')
          );
        }
      }
      if (type === 'mongodb') {
        for (const index of collection.indexes || []) {
          if (index.name === '_id_') continue;
          // L'indice si ricrea con TUTTE le opzioni che l'artefatto dichiara:
          // ricrearlo come indice semplice perdeva TTL, indici parziali,
          // sparsi e collation, cioe' vincoli che la destinazione non aveva
          // piu' anche quando l'import si dichiarava riuscito.
          await strategy.createIndex(db, collection.name, {
            fields: JSON.stringify(index.key), unique: !!index.unique, name: index.name,
            sparse: !!index.sparse,
            expireAfterSeconds: index.expireAfterSeconds,
            partialFilterExpression: index.partialFilterExpression,
            collation: index.collation,
            wildcardProjection: index.wildcardProjection,
          });
        }
      }
    }
    if (type !== 'mongodb') {
      for (const collection of artifact.collections) {
        for (const sql of collection.postDdl || []) {
          abortIf(activeSignal);
          await strategy.collectionAggregate(db, collection.name, {
            pipeline: riqualificaDdl(sql, artifact.db, db, type),
          });
        }
      }
    }
    if (artifact.objects) {
      const problems = [];
      await restoreSchemaObjects({
        strategy, targetDb: db, dbType: type, oggetti: artifact.objects,
        dbOrigine: artifact.db, problems, log, allowUnsafeSchema: false,
      });
      if (problems.length) throw new Error(`Oggetti di schema incompleti: ${problems.join('; ')}`);
    }
  }

  async function verifica(plan, db) {
    const actual = (await strategy.listCollections(db)).filter((c) => c.type !== 'view');
    const actualNames = new Set(actual.map((c) => c.name));
    const expectedNames = new Set(plan.collections.map((c) => c.name));
    const extras = [...actualNames].filter((name) => !expectedNames.has(name));
    const missing = [...expectedNames].filter((name) => !actualNames.has(name));
    let rows = 0;
    const mismatches = [];
    for (const collection of plan.collections) {
      const identity = plan.artifact.collections.find((item) => item.name === collection.name).identity;
      const counts = await cardinalitaDestinazione({
        strategy, dbType: type, targetDb: db, collection: collection.name, identity,
      });
      const count = counts.cardinality;
      rows += count;
      const wrong = plan.drop ? count !== collection.rows : count < collection.rows;
      if (wrong) mismatches.push(`${collection.name}: ${count}/${collection.rows}`);
      if (identity && counts.distinctIdentities !== count) {
        mismatches.push(`${collection.name}: ${count} righe ma ${counts.distinctIdentities} identita distinte`);
      }
    }
    let schemaObjects = true;
    const objectMismatches = [];
    if (type === 'mongodb') {
      for (const collection of plan.artifact.collections) {
        if (!collection.indexes || !collection.indexes.length) continue;
        // `continue` su un metodo assente significava saltare la verifica
        // dichiarandola fatta: l'altra faccia dello stesso difetto che sul
        // ripristino inventava divergenze. Se non si puo' verificare, si dice.
        if (typeof strategy.indexList !== 'function') {
          throw new Error(`La strategia ${type} non espone indexList: gli indici non sono verificabili.`);
        }
        const indexes = await strategy.indexList(db, collection.name);
        const expected = collection.indexes.filter((idx) => idx.name !== '_id_').map(canonicalMongoIndex).sort();
        const actualIndexes = indexes.filter((idx) => idx.name !== '_id_').map(canonicalMongoIndex).sort();
        const differences = inventoryDifferences({ indexes: expected }, { indexes: actualIndexes }, { exact: plan.drop });
        if (differences.length) objectMismatches.push(`${collection.name}: indici divergenti`);
      }
    } else if (typeof strategy.tableAuxDdl === 'function') {
      for (const collection of plan.artifact.collections) {
        const expected = (collection.postDdl || [])
          .map((sql) => canonicalSqlForDb(riqualificaDdl(sql, plan.sourceDb, db, type), db)).sort();
        const aux = await strategy.tableAuxDdl(db, collection.name);
        const actualDdl = [...(aux.indexes || []), ...(aux.foreignKeys || [])]
          .map((sql) => canonicalSqlForDb(sql, db)).sort();
        const differences = inventoryDifferences({ ddl: expected }, { ddl: actualDdl }, { exact: plan.drop });
        if (differences.length) objectMismatches.push(`${collection.name}: indici/vincoli divergenti`);
      }
    }
    if (plan.artifact.objects) {
      const expectedObjects = canonicalSchemaInventory(
        retargetSchemaObjects(plan.artifact.objects, plan.sourceDb, db, type), { db }
      );
      const actualObjects = canonicalSchemaInventory(await readSchemaObjects(strategy, type, db), { db });
      for (const difference of inventoryDifferences(expectedObjects, actualObjects, { exact: plan.drop })) {
        objectMismatches.push(`${difference.field}: definizioni mancanti ${difference.missing.length}, inattese ${difference.extras.length}`);
      }
    }
    if (objectMismatches.length) schemaObjects = false;
    return {
      ok: !missing.length && (plan.drop ? !extras.length : true) && !mismatches.length && schemaObjects,
      collections: actual.length, rows, missing, extras, mismatches, objectMismatches, schemaObjects,
    };
  }

  return {
    setSignal(next) { activeSignal = next; },
    async validatePlan(plan) {
      if (plan.dbType !== type) throw new Error(`Piano ${plan.dbType} incompatibile con la strategia ${type}.`);
      if (!recoveryRoot) throw new Error('Radice delle copie di recupero mancante.');
      for (const collection of plan.artifact.collections) {
        const identity = collection.identity || (type === 'mongodb'
          ? { kind: 'mongodb-id', columns: ['_id'] } : null);
        if (type === 'mongodb' && (!identity || identity.kind !== 'mongodb-id'
            || identity.columns.length !== 1 || identity.columns[0] !== '_id')) {
          throw new Error(`La collection MongoDB "${collection.name}" deve usare l'identita stabile _id.`);
        }
        if (identity) {
          validaIdentity(identity, { collection: collection.name });
          const seen = new Set();
          collection.docs.forEach((row, index) => {
            let key;
            try { key = chiaveIdentita(row, identity); }
            catch (err) { throw new Error(`Riga ${index + 1} di "${collection.name}": ${err.message}`); }
            if (seen.has(key)) throw new Error(`Identita duplicata in "${collection.name}" alla riga ${index + 1}.`);
            seen.add(key);
          });
        }
      }
      const targetExists = await exists(plan.targetDb);
      if (targetExists && !plan.drop) {
        await validaIdentitaMerge(plan);
      }
    },

    destinationExists: (plan) => exists(plan.targetDb),

    async createRecovery(plan) {
      const physical = (await strategy.listCollections(plan.targetDb)).filter((item) => item.type !== 'view');
      const inventory = objectInventory(await readSchemaObjects(strategy, type, plan.targetDb));
      const objectCount = Object.values(inventory).reduce((sum, names) => sum + names.length, 0);
      if (!physical.length && objectCount === 0) {
        return { id: `empty-${plan.fingerprint.slice(0, 12)}`, empty: true, verified: true, physicalDb: null };
      }
      const result = await runBackup({
        session, connName: `${connName}__recupero`, db: plan.targetDb, type: 'full',
        onlyCollections: null, sinceField: null, destRoot: recoveryRoot,
        compress: true, level: 6, log,
      });
      const verified = await verifyBackupDir(result.backupDir);
      if (!verified.valid) throw new Error('La copia full di recupero non supera checksum e manifest.');
      await preflightChain(resolveChain(result.backupDir), log);
      return { id: result.id, backupDir: result.backupDir, verified: true, physicalDb: null };
    },

    async prepareStaging(plan, recovery, targetExists) {
      const db = nomeTecnico(plan.targetDb, 'staging', type === 'mysql' ? 64 : 63);
      if (targetExists && !plan.drop && recovery && !recovery.empty) {
        await runRestore({
          session, backupDir: recovery.backupDir, targetDb: db,
          onlyCollections: null, drop: false, log, allowUnsafeSchema: false,
        });
      } else if (type !== 'mongodb' || plan.collections.length) {
        await strategy.createDatabase(db, type === 'mongodb' && plan.collections[0]
          ? plan.collections[0].name : undefined);
      }
      return { db, retained: type !== 'postgresql' };
    },

    async apply(plan, staging) {
      return applicaArtefatto(plan, staging.db, { upsert: !plan.drop && !!(await exists(plan.targetDb)) });
    },

    async verify(plan, where, staging) {
      return verifica(plan, where === 'staging' ? staging.db : plan.targetDb);
    },

    async promote(plan, staging, recovery) {
      if (type === 'postgresql') {
        const client = await strategy.pool.connect();
        const q = (name) => quotaSempre(name, 'postgresql');
        const old = nomeTecnico(plan.targetDb, 'recupero', 63);
        let renamedOld = false;
        let commitAttempted = false;
        try {
          await client.query('BEGIN');
          if (await exists(plan.targetDb)) {
            await client.query(`ALTER SCHEMA ${q(plan.targetDb)} RENAME TO ${q(old)}`);
            renamedOld = true;
          }
          await client.query(`ALTER SCHEMA ${q(staging.db)} RENAME TO ${q(plan.targetDb)}`);
          commitAttempted = true;
          await client.query('COMMIT');
          if (renamedOld && recovery) recovery.physicalDb = old;
        } catch (err) {
          let rolledBack = false;
          await client.query('ROLLBACK').then(() => { rolledBack = true; }).catch(() => {});
          if (rolledBack && !commitAttempted) err.targetUnchanged = true;
          throw err;
        } finally {
          client.release();
        }
        return;
      }
      let targetMutationStarted = false;
      try {
        const stagedBackup = await runBackup({
          session, connName: `${connName}__staging`, db: staging.db, type: 'full',
          onlyCollections: null, sinceField: null, destRoot: recoveryRoot,
          compress: true, level: 6, log,
        });
        const verified = await verifyBackupDir(stagedBackup.backupDir);
        if (!verified.valid) throw new Error('Lo staging non produce una copia promuovibile verificata.');
        staging.backupDir = stagedBackup.backupDir;
        if (await exists(plan.targetDb)) {
          targetMutationStarted = true;
          try { await strategy.dropDatabase(plan.targetDb); }
          catch (err) { if (err && !err.target) err.target = plan.targetDb; throw err; }
        }
        targetMutationStarted = true;
        await runRestore({
          session, backupDir: stagedBackup.backupDir, targetDb: plan.targetDb,
          onlyCollections: null, drop: false, log, allowUnsafeSchema: false,
        });
      } catch (err) {
        if (!targetMutationStarted) err.targetUnchanged = true;
        throw err;
      }
    },

    async restore(plan, recovery) {
      if (type === 'postgresql' && recovery && recovery.physicalDb) {
        const client = await strategy.pool.connect();
        const q = (name) => quotaSempre(name, 'postgresql');
        try {
          await client.query('BEGIN');
          if (await exists(plan.targetDb)) await client.query(`DROP SCHEMA ${q(plan.targetDb)} CASCADE`);
          await client.query(`ALTER SCHEMA ${q(recovery.physicalDb)} RENAME TO ${q(plan.targetDb)}`);
          await client.query('COMMIT');
          return;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally { client.release(); }
      }
      if (await exists(plan.targetDb)) {
        try { await strategy.dropDatabase(plan.targetDb); }
        catch (err) { if (err && !err.target) err.target = plan.targetDb; throw err; }
      }
      if (recovery) {
        if (recovery.empty) await strategy.createDatabase(plan.targetDb);
        else {
          await runRestore({
            session, backupDir: recovery.backupDir, targetDb: plan.targetDb,
            onlyCollections: null, drop: false, log, allowUnsafeSchema: false,
          });
        }
      }
    },

    async cleanup(result) {
      if (!result) return;
      if (result.staging && result.staging.retained && await exists(result.staging.db)) {
        await strategy.dropDatabase(result.staging.db);
      }
      if (result.recovery && result.recovery.physicalDb && await exists(result.recovery.physicalDb)) {
        await strategy.dropDatabase(result.recovery.physicalDb);
      }
      if (result.recovery && result.recovery.backupDir) {
        fs.rmSync(result.recovery.backupDir, { recursive: true, force: true });
      }
      if (result.staging && result.staging.backupDir) {
        fs.rmSync(result.staging.backupDir, { recursive: true, force: true });
      }
    },
  };
}

module.exports = { createImportArtifactAdapter };
