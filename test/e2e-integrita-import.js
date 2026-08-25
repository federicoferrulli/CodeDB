'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const { MongoClient } = require('mongodb');
const { creaPianoImport, eseguiPianoImport } = require('../db/importPlan');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');
const { eliminaSePresente } = require('../backup/lib/restore');
const { createE2eTargetRegistry } = require('./e2e-harness');

const quiet = { info() {}, error() {} };

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
    console.log('  OK   MongoDB reale: drop negato fail-closed senza inserimenti successivi');
  } finally {
    if (restricted) await restricted.close();
    try { await targets.cleanup((name) => admin.db(name).dropDatabase()); } catch (_) { /* cleanup best effort */ }
    await admin.close();
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
    console.log('  OK   MySQL reale: upsert incrementale senza DELETE/cascade/trigger');
  } finally {
    await targets.cleanup((name) => strategy.pool.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => {}));
    await strategy.disconnect();
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
  } finally {
    reading = false;
    if (reader) await reader;
    await targets.cleanup((name) => strategy.pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`).catch(() => {}));
    await strategy.disconnect();
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }
}

(async () => {
  await mongoDropNegato();
  await mysqlUpsertSenzaDelete();
  await postgresSwapAtomico();
})().catch((err) => {
  console.error('e2e-integrita-import FALLITO:', err.stack || err);
  process.exitCode = 1;
});
