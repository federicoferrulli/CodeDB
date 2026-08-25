'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { MongoClient } = require('mongodb');
const { creaPianoImport, creaPianoRestore, eseguiPianoImport } = require('../db/importPlan');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');
const { descriviBackup, createBackupRestoreAdapter } = require('../db/backupRestoreAdapter');
const { runBackup } = require('../backup/lib/engine');
const { eliminaSePresente } = require('../backup/lib/restore');
const { createE2eTargetRegistry } = require('./e2e-harness');
const { readSchemaObjects, canonicalSqlForDb } = require('../db/schemaObjects');
const { scegliIdentitaSql } = require('../backup/lib/identity');

const quiet = { info() {}, error() {} };

function assertDuplicateRejected({ dbType, targetDb, ddl, identity, docs }) {
  assert.throws(() => creaPianoImport({
    artifact: {
      formato: 'codedb-database', versione: 1, dbType, db: 'origine',
      collections: [{ name: 'duplicati', identity, ddl: ddl || null, indexes: [], postDdl: null, docs }],
    },
    expectedDbType: dbType, connection: `e2e-${dbType}`, targetDb, drop: true,
  }), /duplicata/i);
}

async function mongoDropNegato() {
  if (process.env.CODEDB_E2E_MONGO_AUTH !== '1') {
    console.log('  SKIP MongoDB drop negato: imposta CODEDB_E2E_MONGO_AUTH=1 con un MONGO_ADMIN_URI autenticato');
    return;
  }
  const adminUri = process.env.MONGO_ADMIN_URI;
  if (!adminUri) throw new Error('MONGO_ADMIN_URI e obbligatoria per la prova MongoDB con autorizzazione reale.');
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_mongo' });
  const db = targets.target('drop_denied');
  const admin = new MongoClient(adminUri);
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-import-mongo-'));
  let restricted = null;
  try {
    await admin.connect();
    await targets.drop(db, (name) => admin.db(name).dropDatabase());
    await admin.db(db).collection('items').insertOne({ _id: 1, valore: 'originale' });
    const username = `codedb_e2e_${targets.marker}`;
    const password = `Cdb-${targets.marker}-Aa1!`;
    await admin.db(db).command({ createUser: username, pwd: password, roles: [{ role: 'readWrite', db }] });
    const deniedUrl = new URL(adminUri);
    deniedUrl.username = username;
    deniedUrl.password = password;
    deniedUrl.pathname = `/${db}`;
    deniedUrl.searchParams.set('authSource', db);
    restricted = new MongoClient(deniedUrl.toString());
    await restricted.connect();
    let inserted = false;
    await assert.rejects(
      (async () => {
        await eliminaSePresente(() => restricted.db(db).dropDatabase(), { dbType: 'mongodb', target: db });
        inserted = true;
        await restricted.db(db).collection('items').insertOne({ _id: 2 });
      })(),
      (err) => [13, 8000].includes(err && err.code) || /not authorized|unauthorized/i.test(err && err.message),
    );
    assert.strictEqual(inserted, false, 'il drop negato blocca ogni inserimento successivo');
    assert.strictEqual(await admin.db(db).collection('items').countDocuments({}), 1);
    assertDuplicateRejected({
      dbType: 'mongodb', targetDb: db, identity: { kind: 'mongodb-id', columns: ['_id'] },
      docs: [{ _id: 1 }, { _id: 1 }],
    });
    assert.strictEqual(await admin.db(db).collection('items').countDocuments({}), 1);
    const strategy = new MongoDbStrategy();
    strategy.client = admin;
    const artifact = {
      formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
      collections: [{
        name: 'items', identity: { kind: 'mongodb-id', columns: ['_id'] },
        ddl: null, indexes: [], postDdl: null, docs: [{ _id: 99, valore: 'temporaneo' }],
      }],
    };
    const plan = creaPianoImport({
      artifact, expectedDbType: 'mongodb', connection: 'e2e-mongo', targetDb: db, drop: true,
    });
    const realAdapter = createImportArtifactAdapter({
      strategy, dbType: 'mongodb', connName: 'e2e-mongo', recoveryRoot, log: quiet,
    });
    const forcedFailure = {
      ...realAdapter,
      async verify(nextPlan, where, staging) {
        if (where === 'destinazione') return { ok: false, schemaObjects: false };
        return realAdapter.verify(nextPlan, where, staging);
      },
    };
    const recovered = await eseguiPianoImport(plan, { adapter: forcedFailure });
    assert.strictEqual(recovered.status, 'ripristinato_dopo_errore', JSON.stringify(recovered));
    assert.deepStrictEqual(await admin.db(db).collection('items').findOne({ _id: 1 }), { _id: 1, valore: 'originale' });
    await realAdapter.cleanup(recovered);
    console.log('  OK   MongoDB reale: errore dopo promozione ripristina il database originale');
    console.log('  OK   MongoDB reale: drop negato fail-closed senza inserimenti successivi');
  } finally {
    if (restricted) await restricted.close();
    try { await targets.cleanup((name) => admin.db(name).dropDatabase()); } catch (_) { /* cleanup best effort */ }
    await admin.close();
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }
}

async function mysqlUpsertSenzaDelete() {
  const strategy = new MySqlStrategy();
  const port = parseInt(process.env.MYSQL_PORT, 10) || 3306;
  try {
    await strategy.connect({
      host: process.env.MYSQL_HOST || '127.0.0.1', port,
      username: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
    });
  } catch (err) {
    if (['ECONNREFUSED', 'ETIMEDOUT'].includes(err && err.code)) {
      console.log(`  SKIP MySQL integrità import: ${err.code}`);
      return;
    }
    throw err;
  }
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_mysql' });
  const db = targets.target('upsert');
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-import-mysql-'));
  try {
    await targets.drop(db, (name) => strategy.pool.query(`DROP DATABASE IF EXISTS \`${name}\``));
    await strategy.pool.query(`CREATE DATABASE \`${db}\``);
    await strategy.pool.query(`CREATE TABLE \`${db}\`.padri (id INT PRIMARY KEY, valore VARCHAR(30))`);
    await strategy.pool.query(`CREATE TABLE \`${db}\`.figli (
      id INT PRIMARY KEY, padre_id INT NOT NULL,
      CONSTRAINT fk_padre FOREIGN KEY (padre_id) REFERENCES padri(id) ON DELETE CASCADE
    )`);
    await strategy.pool.query(`CREATE TABLE \`${db}\`.delete_audit (n INT NOT NULL)`);
    await strategy.pool.query(`INSERT INTO \`${db}\`.delete_audit VALUES (0)`);
    await strategy.pool.query(`CREATE TRIGGER \`${db}\`.padri_delete BEFORE DELETE ON \`${db}\`.padri
      FOR EACH ROW UPDATE \`${db}\`.delete_audit SET n = n + 1`);
    await strategy.pool.query(`INSERT INTO \`${db}\`.padri VALUES (1, 'prima')`);
    await strategy.pool.query(`INSERT INTO \`${db}\`.figli VALUES (10, 1)`);

    const result = await strategy.collectionImport(db, 'padri', {
      docs: [{ id: 1, valore: 'dopo' }], upsert: true, conflictColumns: ['id'],
    });
    assert.strictEqual(result.inserted, 1);
    const [padri] = await strategy.pool.query(`SELECT valore FROM \`${db}\`.padri WHERE id = 1`);
    const [figli] = await strategy.pool.query(`SELECT COUNT(*) AS n FROM \`${db}\`.figli`);
    const [audit] = await strategy.pool.query(`SELECT n FROM \`${db}\`.delete_audit`);
    assert.strictEqual(padri[0].valore, 'dopo');
    assert.strictEqual(Number(figli[0].n), 1, 'la FK ON DELETE CASCADE non deve attivarsi');
    assert.strictEqual(Number(audit[0].n), 0, 'il trigger DELETE non deve attivarsi');

    await strategy.pool.query(`CREATE TABLE \`${db}\`.senza_identita (codice INT, valore VARCHAR(30))`);
    await assert.rejects(
      strategy.collectionImport(db, 'senza_identita', {
        docs: [{ codice: 1, valore: 'uno' }], upsert: true, conflictColumns: [],
      }),
      /identita stabile/i,
    );
    const [senzaIdentita] = await strategy.pool.query(`SELECT COUNT(*) AS n FROM \`${db}\`.senza_identita`);
    assert.strictEqual(Number(senzaIdentita[0].n), 0, 'MySQL rifiuta prima della prima riga senza identita');
    assertDuplicateRejected({
      dbType: 'mysql', targetDb: db, ddl: 'CREATE TABLE duplicati (id INT PRIMARY KEY);',
      identity: { kind: 'primary-key', columns: ['id'] }, docs: [{ id: 1 }, { id: 1 }],
    });

    const recoveryArtifact = {
      formato: 'codedb-database', versione: 1, dbType: 'mysql', db: 'origine',
      collections: [{
        name: 'padri', identity: { kind: 'primary-key', columns: ['id'] },
        ddl: 'CREATE TABLE padri (id INT PRIMARY KEY, valore VARCHAR(30));',
        indexes: null, postDdl: null, docs: [{ id: 99, valore: 'temporaneo' }],
      }],
    };
    const recoveryPlan = creaPianoImport({
      artifact: recoveryArtifact, expectedDbType: 'mysql', connection: 'e2e-mysql', targetDb: db, drop: true,
    });
    const realAdapter = createImportArtifactAdapter({
      strategy, dbType: 'mysql', connName: 'e2e-mysql', recoveryRoot, log: quiet,
    });
    const forcedFailure = {
      ...realAdapter,
      async verify(plan, where, staging) {
        if (where === 'destinazione') return { ok: false, schemaObjects: false };
        return realAdapter.verify(plan, where, staging);
      },
    };
    const recovered = await eseguiPianoImport(recoveryPlan, { adapter: forcedFailure });
    assert.strictEqual(recovered.status, 'ripristinato_dopo_errore', JSON.stringify(recovered));
    const [afterRecovery] = await strategy.pool.query(`SELECT valore FROM \`${db}\`.padri WHERE id = 1`);
    const [childrenAfterRecovery] = await strategy.pool.query(`SELECT COUNT(*) AS n FROM \`${db}\`.figli`);
    assert.strictEqual(afterRecovery[0].valore, 'dopo');
    assert.strictEqual(Number(childrenAfterRecovery[0].n), 1, 'il recupero full ripristina anche le tabelle non presenti nell artefatto');
    await realAdapter.cleanup(recovered);
    console.log('  OK   MySQL reale: errore dopo promozione ripristina dati e oggetti originali');
    console.log('  OK   MySQL reale: upsert incrementale senza DELETE/cascade/trigger');
  } finally {
    await targets.cleanup((name) => strategy.pool.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => {}));
    await strategy.disconnect();
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }
}

async function postgresSwapAtomico() {
  const strategy = new PostgreSqlStrategy();
  const cfg = {
    host: process.env.PG_HOST || '127.0.0.1', port: parseInt(process.env.PG_PORT, 10) || 5432,
    username: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || '',
    database: process.env.PG_DATABASE || 'postgres',
  };
  try {
    await strategy.connect(cfg);
  } catch (err) {
    if (['ECONNREFUSED', 'ETIMEDOUT'].includes(err && err.code)) {
      console.log(`  SKIP PostgreSQL integrità import: ${err.code}`);
      return;
    }
    throw err;
  }
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_pg' });
  const target = targets.target('swap');
  const restoreTarget = targets.target('restore');
  const objectOnlyTarget = targets.target('object_only');
  const emptyTarget = targets.target('empty');
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-import-pg-'));
  let result = null;
  let reader = null;
  let reading = false;
  try {
    await targets.drop(target, (name) => strategy.pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
    await strategy.pool.query(`CREATE SCHEMA "${target}"`);
    await strategy.pool.query(`CREATE TABLE "${target}".items (id INT PRIMARY KEY, valore TEXT NOT NULL)`);
    await strategy.pool.query(`INSERT INTO "${target}".items VALUES (1, 'vecchio')`);
    await strategy.pool.query(`CREATE TABLE "${target}".senza_identita (codice INT, valore TEXT)`);
    await assert.rejects(
      strategy.collectionImport(target, 'senza_identita', {
        docs: [{ codice: 1, valore: 'uno' }], upsert: true, conflictColumns: [],
      }),
      /identita stabile/i,
    );
    const untouched = await strategy.pool.query(`SELECT COUNT(*)::int AS n FROM "${target}".senza_identita`);
    assert.strictEqual(untouched.rows[0].n, 0, 'PostgreSQL rifiuta prima della prima riga senza identita');
    assertDuplicateRejected({
      dbType: 'postgresql', targetDb: target, ddl: 'CREATE TABLE duplicati (id INT PRIMARY KEY);',
      identity: { kind: 'primary-key', columns: ['id'] }, docs: [{ id: 1 }, { id: 1 }],
    });
    const docs = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, valore: `nuovo-${i + 1}` }));
    const artifact = {
      formato: 'codedb-database', versione: 1, dbType: 'postgresql', db: 'origine',
      collections: [{
        name: 'items', identity: { kind: 'primary-key', columns: ['id'] },
        ddl: 'CREATE TABLE items (id INT PRIMARY KEY, valore TEXT NOT NULL);',
        indexes: null, postDdl: null, docs,
      }],
    };
    const plan = creaPianoImport({
      artifact, expectedDbType: 'postgresql', connection: 'e2e-pg', targetDb: target, drop: true,
    });
    const adapter = createImportArtifactAdapter({
      strategy, dbType: 'postgresql', connName: 'e2e-pg', recoveryRoot, log: quiet,
    });
    const observations = [];
    reading = true;
    reader = (async () => {
      while (reading) {
        try {
          const row = await strategy.pool.query(`SELECT COUNT(*)::int AS n FROM "${target}".items`);
          observations.push(row.rows[0].n);
        } catch (err) { observations.push(`errore:${err.code || err.message}`); }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    result = await eseguiPianoImport(plan, { adapter });
    reading = false;
    await reader;
    reader = null;
    assert.strictEqual(result.status, 'completato');
    assert(observations.length > 0);
    assert(observations.every((n) => n === 1 || n === 1200), `stato intermedio esposto: ${observations.find((n) => n !== 1 && n !== 1200)}`);
    console.log('  OK   PostgreSQL reale: swap schema atomico per lettore concorrente');
    await adapter.cleanup(result);

    await strategy.pool.query(`CREATE VIEW "${target}".items_view AS SELECT id FROM "${target}".items WHERE id <= 2`);
    const backup = await runBackup({
      session: { strategy, dbType: 'postgresql' }, connName: 'e2e-pg-restore', db: target,
      type: 'full', onlyCollections: null, sinceField: null, destRoot: recoveryRoot,
      compress: true, level: 6, log: quiet,
    });
    const source = descriviBackup(backup.backupDir);
    const restorePlan = creaPianoRestore({
      source, expectedDbType: 'postgresql', connection: 'e2e-pg-restore',
      targetDb: restoreTarget, drop: true,
    });
    const restoreAdapter = createBackupRestoreAdapter({
      strategy, dbType: 'postgresql', connName: 'e2e-pg-restore', recoveryRoot, log: quiet,
    });
    const restored = await eseguiPianoImport(restorePlan, { adapter: restoreAdapter });
    assert.strictEqual(restored.status, 'completato', JSON.stringify(restored));
    const restoredRows = await strategy.pool.query(`SELECT COUNT(*)::int AS n FROM "${restoreTarget}".items`);
    assert.strictEqual(restoredRows.rows[0].n, 1200);
    const restoredView = await strategy.pool.query(
      'SELECT COUNT(*)::int AS n FROM information_schema.views WHERE table_schema = $1 AND table_name = $2',
      [restoreTarget, 'items_view'],
    );
    assert.strictEqual(restoredView.rows[0].n, 1, 'il restore comune conserva e verifica le view');
    await strategy.pool.query(`DROP VIEW "${restoreTarget}".items_view`);
    const missingObject = await restoreAdapter.verify(restorePlan, 'destinazione', restored.staging);
    assert.strictEqual(missingObject.ok, false, 'una view realmente mancante impedisce la verifica finale');
    await strategy.pool.query(`CREATE VIEW "${restoreTarget}".items_view AS SELECT id FROM "${restoreTarget}".items WHERE id <= 2`);
    await strategy.pool.query(`DELETE FROM "${restoreTarget}".items WHERE id = 1200`);
    const wrongCount = await restoreAdapter.verify(restorePlan, 'destinazione', restored.staging);
    assert.strictEqual(wrongCount.ok, false, 'una cardinalita realmente divergente impedisce la verifica finale');
    await strategy.pool.query(`INSERT INTO "${restoreTarget}".items VALUES (1200, 'nuovo-1200')`);
    console.log('  OK   PostgreSQL reale: restore backup usa piano comune e conserva gli oggetti');

    const failedArtifact = {
      formato: 'codedb-database', versione: 1, dbType: 'postgresql', db: 'origine',
      collections: [{
        name: 'items', identity: { kind: 'primary-key', columns: ['id'] },
        ddl: 'CREATE TABLE items (id INT PRIMARY KEY, valore TEXT NOT NULL);',
        indexes: null, postDdl: null, docs: [{ id: 9999, valore: 'temporaneo' }],
      }],
    };
    const failedPlan = creaPianoImport({
      artifact: failedArtifact, expectedDbType: 'postgresql', connection: 'e2e-pg-failure',
      targetDb: restoreTarget, drop: true,
    });
    const realFailureAdapter = createImportArtifactAdapter({
      strategy, dbType: 'postgresql', connName: 'e2e-pg-failure', recoveryRoot, log: quiet,
    });
    const forcedFailureAdapter = {
      ...realFailureAdapter,
      async verify(plan, where, staging) {
        if (where === 'destinazione') return { ok: false, schemaObjects: false };
        return realFailureAdapter.verify(plan, where, staging);
      },
    };
    const recovered = await eseguiPianoImport(failedPlan, { adapter: forcedFailureAdapter });
    assert.strictEqual(recovered.status, 'ripristinato_dopo_errore');
    const recoveredRows = await strategy.pool.query(`SELECT COUNT(*)::int AS n FROM "${restoreTarget}".items`);
    assert.strictEqual(recoveredRows.rows[0].n, 1200);
    const recoveredView = await strategy.pool.query(`SELECT COUNT(*)::int AS n FROM "${restoreTarget}".items_view`);
    assert.strictEqual(recoveredView.rows[0].n, 2);
    await realFailureAdapter.cleanup(recovered);
    await restoreAdapter.cleanup(restored);
    console.log('  OK   PostgreSQL reale: errore dopo promozione esegue il recupero full');

    for (const [schema, existingObject] of [[objectOnlyTarget, true], [emptyTarget, false]]) {
      await targets.drop(schema, (name) => strategy.pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
      await strategy.pool.query(`CREATE SCHEMA "${schema}"`);
      if (existingObject) await strategy.pool.query(`CREATE VIEW "${schema}".vecchia_view AS SELECT 1 AS n`);
      const objectPlan = creaPianoImport({
        artifact: {
          formato: 'codedb-database', versione: 1, dbType: 'postgresql', db: 'origine', collections: [],
          objects: { views: [{ name: 'nuova_view', materialized: false, ddl: 'CREATE VIEW "nuova_view" AS SELECT 2 AS n' }] },
        },
        expectedDbType: 'postgresql', connection: 'e2e-pg-object-only', targetDb: schema, drop: true,
      });
      const objectAdapter = createImportArtifactAdapter({
        strategy, dbType: 'postgresql', connName: 'e2e-pg-object-only', recoveryRoot, log: quiet,
      });
      const objectResult = await eseguiPianoImport(objectPlan, { adapter: objectAdapter });
      assert.strictEqual(objectResult.status, 'completato', JSON.stringify(objectResult));
      const value = await strategy.pool.query(`SELECT n FROM "${schema}".nuova_view`);
      assert.strictEqual(value.rows[0].n, 2);
      await objectAdapter.cleanup(objectResult);
    }
    console.log('  OK   PostgreSQL reale: recupero di schema vuoto e con soli oggetti');
  } finally {
    reading = false;
    if (reader) await reader;
    await targets.cleanup((name) => strategy.pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`).catch(() => {}));
    await strategy.disconnect();
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }
}

/**
 * Ripristino MongoDB di un database che ha collection VUOTE e indici veri.
 *
 * Due invarianti che una strategia finta non puo' dimostrare, perche' dipendono
 * da come MongoDB tratta davvero le collection:
 *
 *  - una collection nasce alla PRIMA SCRITTURA, quindi una collection vuota nel
 *    backup non ne produceva nessuna nella destinazione: spariva, e il conteggio
 *    tornava lo stesso (zero attese contro zero presenti), cioe' un `completato`
 *    che aveva perso una collection;
 *  - gli indici vanno CONFRONTATI leggendoli dal server. `MongoDbStrategy` non
 *    esponeva `indexList`, e il lato reale del confronto restava vuoto: ogni
 *    indice atteso risultava mancante e ogni ripristino di un database con
 *    almeno un indice falliva la verifica dello staging.
 */
async function mongoRestoreCollezioniVuoteEIndici() {
  const uri = process.env.MONGO_URI || process.env.MONGO_ADMIN_URI;
  if (!uri) {
    console.log('  SKIP MongoDB restore vuote/indici: imposta MONGO_URI');
    return;
  }
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_mongo_restore' });
  const origine = targets.target('origine');
  const destinazione = targets.target('destinazione');
  const strategy = new MongoDbStrategy();
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-restore-mongo-'));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-restore-bk-'));
  try {
    await strategy.connect({ uri });
    const client = strategy.client;
    await targets.drop(origine, (name) => client.db(name).dropDatabase());
    await targets.drop(destinazione, (name) => client.db(name).dropDatabase());

    await client.db(origine).collection('utenti').insertMany([{ n: 1 }, { n: 2 }]);
    await client.db(origine).createCollection('sessioni');   // VUOTA
    await client.db(origine).createCollection('telemetrie'); // VUOTA e senza indici
    await client.db(origine).collection('sessioni')
      .createIndex({ creataIl: 1 }, { expireAfterSeconds: 3600, name: 'ttl_sessioni' });
    await client.db(origine).collection('utenti')
      .createIndex({ n: 1 }, { unique: true, name: 'uniq_n' });

    const backup = await runBackup({
      session: { strategy, dbType: 'mongodb' }, connName: 'e2e-restore', db: origine,
      type: 'full', destRoot: backupRoot, compress: true, level: 1, log: quiet,
    });

    // La destinazione esiste gia': il piano deve fare la copia di recupero.
    await client.db(destinazione).collection('vecchia').insertOne({ x: 1 });

    const source = descriviBackup(backup.backupDir, null);
    const plan = creaPianoRestore({
      source, expectedDbType: 'mongodb', connection: 'e2e-restore',
      targetDb: destinazione, drop: true,
    });
    const adapter = createBackupRestoreAdapter({
      strategy, dbType: 'mongodb', connName: 'e2e-restore', recoveryRoot, log: quiet,
    });
    const result = await eseguiPianoImport(plan, { adapter });
    assert.strictEqual(result.status, 'completato',
      `il ripristino doveva riuscire: ${result.error || ''}`);

    const presenti = (await strategy.listCollections(destinazione)).map((c) => c.name).sort();
    assert.deepStrictEqual(presenti, ['sessioni', 'telemetrie', 'utenti'],
      `le collection vuote devono sopravvivere al ripristino: ${presenti.join(', ')}`);
    console.log('  OK   MongoDB reale: una collection VUOTA sopravvive al ripristino');

    const indici = await strategy.indexList(destinazione, 'sessioni');
    const ttl = indici.find((i) => i.name === 'ttl_sessioni');
    assert.ok(ttl && ttl.expireAfterSeconds === 3600,
      `l'indice TTL della collection vuota deve essere ricreato: ${JSON.stringify(indici)}`);
    console.log('  OK   MongoDB reale: gli indici di una collection vuota sono ricreati e verificati');

    // `indexList` deve rendere i descrittori COSI' come li dichiara il server:
    // normalizzarli (per esempio `unique: false`) inventerebbe divergenze.
    const suUtenti = await strategy.indexList(destinazione, 'utenti');
    const uniq = suUtenti.find((i) => i.name === 'uniq_n');
    assert.ok(uniq && uniq.unique === true, 'un indice univoco resta univoco');
    const primario = suUtenti.find((i) => i.name === '_id_');
    assert.ok(primario && !('unique' in primario) && !('v' in primario),
      `_id_ non dichiara unique e non porta il formato interno: ${JSON.stringify(primario)}`);
    console.log('  OK   MongoDB reale: indexList non aggiunge campi che il backup non ha');

    await adapter.cleanup(result);
  } finally {
    await targets.cleanup((name) => strategy.client
      ? strategy.client.db(name).dropDatabase().catch(() => {}) : Promise.resolve());
    await strategy.disconnect().catch(() => {});
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

/**
 * Import di un `.codedb.json` sui DUE motori, con gli oggetti che un'app vera
 * possiede: su MongoDB indici non univoci e un TTL, su MySQL una view.
 *
 * Sono due facce dello stesso difetto — la forma canonica non era canonica, e
 * la verifica confrontava la PRESENTAZIONE invece della semantica:
 *
 *  - MongoDB: il server omette le opzioni al valore predefinito, l'export le
 *    scriveva come `unique: false`. Ogni indice non univoco risultava
 *    divergente, quindi l'import falliva su qualunque database con un indice.
 *    E l'indice veniva ricreato senza `expireAfterSeconds`: un TTL che non
 *    scade piu', cioe' una perdita vera e non solo un falso allarme.
 *  - MySQL: `SHOW CREATE VIEW` qualifica il nome del database solo quando NON
 *    e' quello corrente della connessione, e la canonicalizzazione toglieva la
 *    qualificazione in ogni forma tranne quella fra apici inversi — l'unica
 *    che MySQL usa. La stessa view risultava mancante da se stessa.
 */
async function importArtefattoConOggettiReali() {
  const uri = process.env.MONGO_URI || process.env.MONGO_ADMIN_URI;
  if (uri) {
    const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_imp_mongo' });
    const origine = targets.target('origine');
    const destinazione = targets.target('destinazione');
    const strategy = new MongoDbStrategy();
    const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-imp-mongo-'));
    try {
      await strategy.connect({ uri });
      const client = strategy.client;
      await targets.drop(origine, (name) => client.db(name).dropDatabase());
      await targets.drop(destinazione, (name) => client.db(name).dropDatabase());

      await client.db(origine).collection('sessioni').insertOne({ _id: 1, tok: 'a' });
      await client.db(origine).collection('sessioni')
        .createIndex({ creataIl: 1 }, { expireAfterSeconds: 3600, name: 'ttl' });
      await client.db(origine).collection('log').insertOne({ _id: 1, liv: 'info' });
      // NON univoco: e' il caso che faceva fallire ogni import.
      await client.db(origine).collection('log').createIndex({ liv: 1 }, { name: 'idx_liv' });

      // L'artefatto si costruisce dalla stessa sorgente che usa l'export UI.
      const collections = [];
      for (const name of ['sessioni', 'log']) {
        const stats = await strategy.collectionStats(origine, name);
        const docs = await client.db(origine).collection(name).find({}).toArray();
        let indexes = (stats.indexes || []).filter((i) => i.name !== '_id_');
        // `log` porta la forma STORICA del file: le versioni precedenti
        // riducevano ogni indice a `{name, key, unique}` con `unique: false`
        // esplicito. I file gia' esportati dagli utenti hanno questa forma e
        // devono restare importabili, altrimenti la correzione varrebbe solo
        // per gli export futuri.
        if (name === 'log') {
          indexes = indexes.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique }));
        }
        collections.push({
          name, ddl: null, postDdl: null,
          identity: { kind: 'mongodb-id', columns: ['_id'] },
          indexes, docs,
        });
      }
      assert.strictEqual(collections[1].indexes[0].unique, false,
        'il caso storico deve davvero portare `unique: false`');
      const plan = creaPianoImport({
        artifact: { formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: origine, collections },
        expectedDbType: 'mongodb', connection: 'e2e-imp-mongo', targetDb: destinazione, drop: false,
      });
      const adapter = createImportArtifactAdapter({
        strategy, dbType: 'mongodb', connName: 'e2e-imp-mongo', recoveryRoot, log: quiet,
      });
      const result = await eseguiPianoImport(plan, { adapter });
      assert.strictEqual(result.status, 'completato',
        `import MongoDB con indici doveva riuscire: ${result.error || ''}`);
      console.log('  OK   MongoDB reale: import di un file STORICO con `unique: false` esplicito');

      const ttl = (await strategy.indexList(destinazione, 'sessioni')).find((i) => i.name === 'ttl');
      assert.ok(ttl && ttl.expireAfterSeconds === 3600,
        `il TTL deve sopravvivere all'import: ${JSON.stringify(ttl)}`);
      console.log('  OK   MongoDB reale: l indice TTL conserva expireAfterSeconds');
      await adapter.cleanup(result);
    } finally {
      await targets.cleanup((name) => strategy.client
        ? strategy.client.db(name).dropDatabase().catch(() => {}) : Promise.resolve());
      await strategy.disconnect().catch(() => {});
      fs.rmSync(recoveryRoot, { recursive: true, force: true });
    }
  } else {
    console.log('  SKIP import MongoDB con oggetti reali: imposta MONGO_URI');
  }

  const mysqlPort = parseInt(process.env.MYSQL_PORT, 10) || 3306;
  const strategy = new MySqlStrategy();
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_imp_mysql' });
  const origine = targets.target('origine');
  const destinazione = targets.target('destinazione');
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-imp-mysql-'));
  const q = (name) => '`' + name + '`';
  try {
    await strategy.connect({
      host: process.env.MYSQL_HOST || '127.0.0.1', port: mysqlPort,
      username: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
    });
  } catch (err) {
    console.log(`  SKIP import MySQL con oggetti reali: MySQL non raggiungibile (${err.message})`);
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
    return;
  }
  try {
    await targets.drop(origine, (name) => strategy.pool.query(`DROP DATABASE IF EXISTS ${q(name)}`));
    await targets.drop(destinazione, (name) => strategy.pool.query(`DROP DATABASE IF EXISTS ${q(name)}`));
    await strategy.pool.query(`CREATE DATABASE ${q(origine)}`);
    await strategy.pool.query(`CREATE TABLE ${q(origine)}.clienti (id INT PRIMARY KEY, email VARCHAR(80))`);
    await strategy.pool.query(`INSERT INTO ${q(origine)}.clienti VALUES (1,'a@b.c')`);
    await strategy.pool.query(
      `CREATE VIEW ${q(origine)}.v_clienti AS SELECT id, email FROM ${q(origine)}.clienti`);

    const objects = await readSchemaObjects(strategy, 'mysql', origine);
    const info = await strategy.tableColumnsInfo(origine, 'clienti');
    const primary = await strategy.primaryKey(origine, 'clienti');
    const identity = scegliIdentitaSql(info.columns, primary.length
      ? [{ kind: 'primary-key', name: 'PRIMARY', columns: primary }] : []);
    const righe = await strategy.collectionFind(origine, 'clienti', { limit: 100, skip: 0 });
    const plan = creaPianoImport({
      artifact: {
        formato: 'codedb-database', versione: 1, dbType: 'mysql', db: origine, objects,
        collections: [{
          name: 'clienti', ddl: await strategy.tableDdl(origine, 'clienti'), postDdl: null,
          identity, indexes: null,
          docs: righe.docs.map(({ _id, ...r }) => r),
        }],
      },
      expectedDbType: 'mysql', connection: 'e2e-imp-mysql', targetDb: destinazione, drop: false,
    });
    const adapter = createImportArtifactAdapter({
      strategy, dbType: 'mysql', connName: 'e2e-imp-mysql', recoveryRoot, log: quiet,
    });
    const result = await eseguiPianoImport(plan, { adapter });
    assert.strictEqual(result.status, 'completato',
      `import MySQL con una view doveva riuscire: ${result.error || ''}`);
    const finali = await readSchemaObjects(strategy, 'mysql', destinazione);
    assert.strictEqual(finali.views.length, 1, 'la view deve esistere nella destinazione');
    console.log('  OK   MySQL reale: una view non e piu mancante da se stessa');
    await adapter.cleanup(result);
  } finally {
    await targets.cleanup((name) => strategy.pool.query(`DROP DATABASE IF EXISTS ${q(name)}`).catch(() => {}));
    await strategy.disconnect().catch(() => {});
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }

  // --- PostgreSQL -----------------------------------------------------------
  // Lo stesso meccanismo di MySQL, con un'altra leva: `pg_get_viewdef` qualifica
  // i nomi in base al `search_path`, quindi la stessa view torna qualificata o
  // nuda a seconda della connessione. Qui PostgreSQL usa le virgolette doppie o
  // nessuna quotatura, forme che la canonicalizzazione gia' toglieva: il caso e'
  // coperto per costruzione, e questo test serve a non farlo scoprire di nuovo.
  const pgStrategy = new PostgreSqlStrategy();
  const pgTargets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_imp_pg' });
  const pgOrigine = pgTargets.target('origine');
  const pgDestinazione = pgTargets.target('destinazione');
  const pgRecoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-imp-pg-'));
  try {
    await pgStrategy.connect({
      host: process.env.PG_HOST || '127.0.0.1', port: parseInt(process.env.PG_PORT, 10) || 5432,
      username: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || '',
      database: process.env.PG_DATABASE || 'postgres',
    });
  } catch (err) {
    console.log(`  SKIP import PostgreSQL con oggetti reali: ${err.message}`);
    fs.rmSync(pgRecoveryRoot, { recursive: true, force: true });
    return;
  }
  try {
    await pgTargets.drop(pgOrigine, (n) => pgStrategy.pool.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`));
    await pgTargets.drop(pgDestinazione, (n) => pgStrategy.pool.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`));
    await pgStrategy.pool.query(`CREATE SCHEMA "${pgOrigine}"`);
    await pgStrategy.pool.query(`CREATE TABLE "${pgOrigine}".clienti (id INT PRIMARY KEY, email TEXT)`);
    await pgStrategy.pool.query(`INSERT INTO "${pgOrigine}".clienti VALUES (1,'a@b.c')`);
    await pgStrategy.pool.query(
      `CREATE VIEW "${pgOrigine}".v_clienti AS SELECT id, email FROM "${pgOrigine}".clienti`);

    // La definizione dipende davvero dal search_path: e' il meccanismo, e va
    // MISURATO invece che dato per scontato.
    const defCon = async (searchPath) => {
      const client = await pgStrategy.pool.connect();
      try {
        await client.query(`SET search_path TO ${searchPath}`);
        const r = await client.query(
          `SELECT pg_catalog.pg_get_viewdef(c.oid, true) AS def
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = 'v_clienti'`, [pgOrigine]);
        return String(r.rows[0].def).replace(/\s+/g, ' ').trim();
      } finally { client.release(); }
    };
    assert.notStrictEqual(await defCon(`"${pgOrigine}"`), await defCon('public'),
      'la definizione di una view PostgreSQL dipende dal search_path');
    // ...ma le due forme devono valere lo stesso una volta canonicalizzate.
    assert.strictEqual(
      canonicalSqlForDb(await defCon(`"${pgOrigine}"`), pgOrigine),
      canonicalSqlForDb(await defCon('public'), pgOrigine),
      'le due forme della stessa view devono canonicalizzarsi uguali',
    );
    console.log('  OK   PostgreSQL reale: la view dipende dal search_path ma la forma canonica no');

    const pgObjects = await readSchemaObjects(pgStrategy, 'postgresql', pgOrigine);
    const pgInfo = await pgStrategy.tableColumnsInfo(pgOrigine, 'clienti');
    const pgPrimary = await pgStrategy.primaryKey(pgOrigine, 'clienti');
    const pgIdentity = scegliIdentitaSql(pgInfo.columns, pgPrimary.length
      ? [{ kind: 'primary-key', name: 'PRIMARY', columns: pgPrimary }] : []);
    const pgRighe = await pgStrategy.collectionFind(pgOrigine, 'clienti', { limit: 100, skip: 0 });
    const pgPlan = creaPianoImport({
      artifact: {
        formato: 'codedb-database', versione: 1, dbType: 'postgresql', db: pgOrigine, objects: pgObjects,
        collections: [{
          name: 'clienti', ddl: await pgStrategy.tableDdl(pgOrigine, 'clienti'), postDdl: null,
          identity: pgIdentity, indexes: null,
          docs: pgRighe.docs.map(({ _id, ...r }) => r),
        }],
      },
      expectedDbType: 'postgresql', connection: 'e2e-imp-pg', targetDb: pgDestinazione, drop: false,
    });
    const pgAdapter = createImportArtifactAdapter({
      strategy: pgStrategy, dbType: 'postgresql', connName: 'e2e-imp-pg', recoveryRoot: pgRecoveryRoot, log: quiet,
    });
    const pgResult = await eseguiPianoImport(pgPlan, { adapter: pgAdapter });
    assert.strictEqual(pgResult.status, 'completato',
      `import PostgreSQL con una view doveva riuscire: ${pgResult.error || ''}`);
    const pgFinali = await readSchemaObjects(pgStrategy, 'postgresql', pgDestinazione);
    assert.strictEqual(pgFinali.views.length, 1, 'la view deve esistere nello schema di destinazione');
    console.log('  OK   PostgreSQL reale: import di un artefatto con una view');
    await pgAdapter.cleanup(pgResult);
  } finally {
    await pgTargets.cleanup((n) => pgStrategy.pool.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`).catch(() => {}));
    await pgStrategy.disconnect().catch(() => {});
    fs.rmSync(pgRecoveryRoot, { recursive: true, force: true });
  }
}

/**
 * Le colonne che un `INSERT` non puo' scrivere alla lettera: GENERATE e
 * GEOMETRICHE. Sono la seconda meta' dello stesso difetto — l'export dell'intero
 * database leggeva con `SELECT *` cio' che il motore di backup gia' sapeva di
 * non poter riscrivere, e l'import lo riscriveva:
 *
 *  - una colonna GENERATA nominata in un INSERT e' un errore, non un valore in
 *    piu': ogni riga veniva rifiutata e l'import falliva su qualunque tabella
 *    con una colonna calcolata;
 *  - una GEOMETRIA letta con `SELECT *` esce nella forma privata del driver
 *    (`{ x, y }`), che riscritta MySQL rifiuta con «Cannot get geometry object».
 *
 * E una volta scrivibile, la geometria deve tornare UGUALE: su una colonna che
 * non dichiara un SRID, `ST_GeomFromGeoJSON` produce SRID 4326, dove MySQL usa
 * l'ordine latitudine-longitudine — il poligono tornava con le coordinate
 * scambiate. Per questo il poligono di prova e' ASIMMETRICO: su un triangolo
 * simmetrico uno scambio di assi e' invisibile, e il test passerebbe a difetto
 * presente.
 */
async function colonneNonScrivibili() {
  const mysqlPort = parseInt(process.env.MYSQL_PORT, 10) || 3306;
  const strategy = new MySqlStrategy();
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_integrita_colonne' });
  const origine = targets.target('origine');
  const destinazione = targets.target('destinazione');
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-colonne-'));
  const q = (name) => '`' + name + '`';
  const POLIGONO = 'POLYGON((0 0,3 0,3 1,0 0))'; // asimmetrico: uno scambio si vede
  try {
    await strategy.connect({
      host: process.env.MYSQL_HOST || '127.0.0.1', port: mysqlPort,
      username: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
    });
  } catch (err) {
    console.log(`  SKIP colonne non scrivibili: MySQL non raggiungibile (${err.message})`);
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
    return;
  }
  const ddlTabella = (db) => `CREATE TABLE ${q(db)}.Pippo (`
    + 'id INT AUTO_INCREMENT PRIMARY KEY, a INT, b INT,'
    + ' somma INT AS (a + b) STORED, area POLYGON)';
  try {
    await targets.drop(origine, (n) => strategy.pool.query(`DROP DATABASE IF EXISTS ${q(n)}`));
    await targets.drop(destinazione, (n) => strategy.pool.query(`DROP DATABASE IF EXISTS ${q(n)}`));
    await strategy.pool.query(`CREATE DATABASE ${q(origine)}`);
    await strategy.pool.query(ddlTabella(origine));
    for (let i = 1; i <= 3; i++) {
      await strategy.pool.query(
        `INSERT INTO ${q(origine)}.Pippo (a, b, area) VALUES (?, ?, ST_GeomFromText(?))`,
        [i, i * 2, POLIGONO]);
    }

    // L'export passa dallo stesso metodo che usa la UI.
    const esportate = await strategy.collectionExport(origine, 'Pippo', {
      format: 'json', limit: 1000, skip: 0,
    });
    const docs = esportate.lines.map((l) => JSON.parse(l));
    assert.ok(!('somma' in docs[0]),
      `una colonna generata non deve finire nell'export: ${esportate.lines[0]}`);
    assert.strictEqual(docs[0].area && docs[0].area.type, 'Polygon',
      `la geometria deve uscire come GeoJSON: ${esportate.lines[0]}`);
    console.log('  OK   MySQL reale: export senza colonne generate e con geometrie GeoJSON');

    const ddl = await strategy.tableDdl(origine, 'Pippo');
    const info = await strategy.tableColumnsInfo(origine, 'Pippo');
    const primary = await strategy.primaryKey(origine, 'Pippo');
    const identity = scegliIdentitaSql(info.columns, primary.length
      ? [{ kind: 'primary-key', name: 'PRIMARY', columns: primary }] : []);

    const importa = async (righe, etichetta) => {
      await strategy.pool.query(`DROP DATABASE IF EXISTS ${q(destinazione)}`);
      await strategy.pool.query(`CREATE DATABASE ${q(destinazione)}`);
      await strategy.pool.query(ddlTabella(destinazione));
      const plan = creaPianoImport({
        artifact: {
          formato: 'codedb-database', versione: 1, dbType: 'mysql', db: origine,
          collections: [{ name: 'Pippo', ddl, identity, indexes: null, postDdl: null, docs: righe }],
        },
        expectedDbType: 'mysql', connection: 'e2e-colonne', targetDb: destinazione, drop: false,
      });
      const adapter = createImportArtifactAdapter({
        strategy, dbType: 'mysql', connName: 'e2e-colonne', recoveryRoot, log: quiet,
      });
      const result = await eseguiPianoImport(plan, { adapter });
      assert.strictEqual(result.status, 'completato', `${etichetta}: ${result.error || ''}`);
      const [righeFinali] = await strategy.pool.query(
        `SELECT id, somma, ST_AsText(area) AS area FROM ${q(destinazione)}.Pippo ORDER BY id`);
      await adapter.cleanup(result);
      return righeFinali;
    };

    const finali = await importa(docs, 'import con colonna generata e geometria');
    assert.strictEqual(finali.length, 3, 'tutte le righe devono essere applicate');
    assert.strictEqual(finali[0].somma, 3, 'la colonna generata la ricalcola il database');
    assert.strictEqual(finali[0].area, POLIGONO,
      `la geometria deve tornare IDENTICA, assi compresi: ${finali[0].area}`);
    console.log('  OK   MySQL reale: import applica le righe e la geometria torna identica');

    // Il file GIA' ESPORTATO dalla versione difettosa: colonna generata dentro e
    // geometria nella forma grezza del driver. Deve restare importabile, perche'
    // a produrlo cosi' e' stato un difetto nostro.
    const [grezze] = await strategy.pool.query(`SELECT * FROM ${q(origine)}.Pippo ORDER BY id`);
    const storiche = JSON.parse(JSON.stringify(grezze));
    assert.ok('somma' in storiche[0] && storiche[0].area && Array.isArray(storiche[0].area),
      `il caso storico deve davvero portare la colonna generata e la forma grezza: ${JSON.stringify(storiche[0])}`);
    const finaliStoriche = await importa(storiche, 'import di un file storico');
    assert.strictEqual(finaliStoriche[0].area, POLIGONO,
      `anche dal file storico la geometria deve tornare identica: ${finaliStoriche[0].area}`);
    console.log('  OK   MySQL reale: un file esportato dalla versione difettosa resta importabile');
  } finally {
    await targets.cleanup((n) => strategy.pool.query(`DROP DATABASE IF EXISTS ${q(n)}`).catch(() => {}));
    await strategy.disconnect().catch(() => {});
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }
}

(async () => {
  await mongoDropNegato();
  await mongoRestoreCollezioniVuoteEIndici();
  await importArtefattoConOggettiReali();
  await colonneNonScrivibili();
  await mysqlUpsertSenzaDelete();
  await postgresSwapAtomico();
})().catch((err) => {
  console.error('e2e-integrita-import FALLITO:', err.stack || err);
  process.exitCode = 1;
});
