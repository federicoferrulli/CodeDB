'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { runBackup } = require('../backup/lib/engine');
const {
  runRestore, preflightChain, resolveChain, riqualificaDdl, cardinalitaDestinazione,
} = require('../backup/lib/restore');
const { verifyBackupDir } = require('../backup/lib/util');
const { quotaSempre } = require('./identificatori');
const { scegliIdentitaSql, identityCompatibile } = require('../backup/lib/identity');

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
      const incomplete = collection.docs.findIndex((row) => (
        !row || typeof row !== 'object'
        || expected.columns.some((column) => !Object.prototype.hasOwnProperty.call(row, column))
      ));
      if (incomplete >= 0) {
        throw new Error(
          `La riga ${incomplete + 1} di "${collection.name}" non contiene tutta l'identita stabile `
          + `(${expected.columns.join(', ')}).`
        );
      }
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
    if (!(await exists(db))) await strategy.createDatabase(db, type === 'mongodb' && first ? first.name : undefined);

    // Prima si materializza TUTTO lo schema nello staging. Solo dopo che ogni
    // tabella e ogni identita sono compatibili puo partire la prima riga.
    for (const collection of artifact.collections) {
      const present = (await strategy.listCollections(db)).some((c) => c.name === collection.name);
      if (present) continue;
      if (type === 'mongodb') await strategy.createCollection(db, collection.name, {});
      else {
        if (!collection.ddl) throw new Error(`DDL di "${collection.name}" assente: impossibile creare la tabella.`);
        await strategy.collectionAggregate(db, collection.name, {
          pipeline: riqualificaDdl(collection.ddl, artifact.db, db),
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
          throw new Error(
            `Import incompleto di "${collection.name}": applicate ${result && result.inserted || 0} `
            + `di ${docs.length} righe/documenti.`
          );
        }
      }
      if (type === 'mongodb') {
        for (const index of collection.indexes || []) {
          if (index.name === '_id_') continue;
          await strategy.createIndex(db, collection.name, {
            fields: JSON.stringify(index.key), unique: !!index.unique, name: index.name,
          });
        }
      }
    }
    if (type !== 'mongodb') {
      for (const collection of artifact.collections) {
        for (const sql of collection.postDdl || []) {
          abortIf(activeSignal);
          await strategy.collectionAggregate(db, collection.name, {
            pipeline: riqualificaDdl(sql, artifact.db, db),
          });
        }
      }
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
    if (type === 'mongodb') {
      for (const collection of plan.artifact.collections) {
        if (!collection.indexes || !collection.indexes.length || typeof strategy.indexList !== 'function') continue;
        const indexes = await strategy.indexList(db, collection.name);
        const names = new Set(indexes.map((idx) => idx.name));
        if (collection.indexes.some((idx) => idx.name !== '_id_' && !names.has(idx.name))) schemaObjects = false;
      }
    } else if (typeof strategy.tableAuxDdl === 'function') {
      for (const collection of plan.artifact.collections) {
        const expected = (collection.postDdl || []).length;
        if (!expected) continue;
        const actual = await strategy.tableAuxDdl(db, collection.name);
        const count = [...(actual.indexes || []), ...(actual.foreignKeys || [])].length;
        if (count < expected) schemaObjects = false;
      }
    }
    return {
      ok: !missing.length && (plan.drop ? !extras.length : true) && !mismatches.length && schemaObjects,
      collections: actual.length, rows, missing, extras, mismatches, schemaObjects,
    };
  }

  return {
    setSignal(next) { activeSignal = next; },
    async validatePlan(plan) {
      if (plan.dbType !== type) throw new Error(`Piano ${plan.dbType} incompatibile con la strategia ${type}.`);
      if (!recoveryRoot) throw new Error('Radice delle copie di recupero mancante.');
      const targetExists = await exists(plan.targetDb);
      if (targetExists && !plan.drop) {
        await validaIdentitaMerge(plan);
      }
    },

    destinationExists: (plan) => exists(plan.targetDb),

    async createRecovery(plan) {
      const current = (await strategy.listCollections(plan.targetDb)).filter((c) => c.type !== 'view');
      if (!current.length) {
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
      } else {
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
        try {
          await client.query('BEGIN');
          if (await exists(plan.targetDb)) {
            await client.query(`ALTER SCHEMA ${q(plan.targetDb)} RENAME TO ${q(old)}`);
            if (recovery) recovery.physicalDb = old;
          }
          await client.query(`ALTER SCHEMA ${q(staging.db)} RENAME TO ${q(plan.targetDb)}`);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        return;
      }
      const stagedBackup = await runBackup({
        session, connName: `${connName}__staging`, db: staging.db, type: 'full',
        onlyCollections: null, sinceField: null, destRoot: recoveryRoot,
        compress: true, level: 6, log,
      });
      const verified = await verifyBackupDir(stagedBackup.backupDir);
      if (!verified.valid) throw new Error('Lo staging non produce una copia promuovibile verificata.');
      staging.backupDir = stagedBackup.backupDir;
      if (await exists(plan.targetDb)) {
        try { await strategy.dropDatabase(plan.targetDb); }
        catch (err) { if (err && !err.target) err.target = plan.targetDb; throw err; }
      }
      await runRestore({
        session, backupDir: stagedBackup.backupDir, targetDb: plan.targetDb,
        onlyCollections: null, drop: false, log, allowUnsafeSchema: false,
      });
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
