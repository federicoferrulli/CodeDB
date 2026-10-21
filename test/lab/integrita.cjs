'use strict';

// Laboratorio reale: i confronti leggono i database con driver indipendenti da
// CodeDB. Ogni esecuzione possiede soltanto database/schema dal nome casuale.
// Richiede CODEDB_E2E_DESTRUCTIVE=1; non legge vault o connessioni dell'utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { MongoClient } = require('mongodb');
const bson = require('bson');
const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const { io } = require('socket.io-client');
const { createE2eTargetRegistry, startTestServer } = require('../e2e-harness');

const report = { suite: 'integrita', iniziato: new Date().toISOString(), verifiche: [], versioni: {} };
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/lab-reports');
const artifactsDir = path.join(reportDir, 'integrita-artifacts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-lab-integrita-'));
const ini = path.join(root, 'connections.ini');
const backupRoot = path.join(root, 'backups');
const cliPath = path.resolve(__dirname, '../../backup/cli.js');
let server, socket;

function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canon(value[k])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
function equivalente(actual, expected, label) {
  assert.equal(digest(actual), digest(expected), `${label}: contenuto diverso; atteso ${digest(expected)}, ottenuto ${digest(actual)}`);
}
async function prova(nome, action) {
  const start = Date.now();
  try {
    const dettagli = await action();
    report.verifiche.push({ nome, esito: 'PASS', ms: Date.now() - start, dettagli });
    console.log(`PASS ${nome} (${Date.now() - start} ms)`);
    return true;
  } catch (error) {
    report.verifiche.push({ nome, esito: 'FAIL', ms: Date.now() - start, errore: error.message, stack: error.stack });
    console.error(`FAIL ${nome}: ${error.message}`);
    process.exitCode = 1;
    return false;
  }
}
function cli(...args) {
  try {
    return execFileSync(process.execPath, [cliPath, ...args, '--dest', backupRoot], {
      windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEDB_CONNECTIONS_FILE: ini, CODEDB_CONNECTIONS_DIR: path.join(root, 'connections'),
        GUI_MONGO_PASSPHRASE: '', CODEDB_RBAC: 'off', CODEDB_BACKUPS_DIR: backupRoot,
        CODEDB_BACKUP_MARGINE_MS: '2000', SLACK_WEBHOOK_URL: '', TZ: 'Europe/Rome' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`CLI ${args[0]}: ${(error.stderr || error.stdout || error.message).toString().slice(-6500)}`);
  }
}
async function emit(event, data) {
  return new Promise((resolve, reject) => socket.timeout(30000).emit(event, data, (error, result) => {
    if (error) reject(error);
    else if (!result?.ok) reject(new Error(`${event}: ${result?.error || JSON.stringify(result)}`));
    else resolve(result);
  }));
}
async function waitOperation(event, payload) {
  const deadline = Date.now() + 180000;
  for (;;) {
    assert(Date.now() < deadline, `${event}: scadenza di tre minuti superata`);
    const { operation } = await emit(event, payload);
    if (operation.status !== 'in_corso') {
      assert.equal(operation.status, 'completato', JSON.stringify(operation));
      return operation;
    }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}
function catalog(fixture) {
  const dir = path.join(backupRoot, `${fixture.type}_${fixture.source}`);
  return JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).backups.map(b => ({ ...b, dir: path.join(dir, b.id) }));
}
// Gli artefatti di recupero hanno un nome derivato dal bersaglio e un suffisso
// casuale. I nomi brevi della fixture conservano per intero il suo marcatore.
async function pulisciStaging(registry, nomi, drop) {
  const owned = registry.targets();
  for (const name of nomi) {
    if (owned.some(base => name.startsWith(`${base}__codedb_`)) && /__codedb_(staging|recovery)_[a-f0-9]{10}$/.test(name)) {
      const base = owned.find(value => name.startsWith(`${value}__codedb_`));
      registry.assertOwned(base);
      await drop(name);
    }
  }
}
async function backup(fixture, type) {
  const output = cli('backup', '--conn', fixture.type, '--db', fixture.source, '--type', type,
    ...(fixture.type === 'mongodb' && type !== 'full' ? ['--since-field', 'updatedAt'] : []));
  assert.match(output, /stato=SUCCESSO/);
  const entries = catalog(fixture);
  const entry = entries[entries.length - 1];
  assert.equal(entry.type, type);
  assert.match(cli('verify', '--from', entry.dir), /0 problemi/);
  return entry;
}
async function restore(fixture, entry, target) {
  const output = cli('restore', '--conn', fixture.type, '--from', entry.dir, '--target-db', target, '--drop');
  assert.match(output, /stato=SUCCESSO/);
}
async function exportImport(fixture, target, formato) {
  const tabId = fixture.type;
  const { plan } = await emit('database:export:plan', { tabId, db: fixture.source, formato });
  await assert.rejects(emit('database:export:start', { tabId, fingerprint: 'impronta-diversa' }), /piano.*cambiato/i);
  const { operation: started } = await emit('database:export:start', { tabId, fingerprint: plan.fingerprint });
  const operation = await waitOperation('database:export:status', { tabId, db: fixture.source, operationId: started.id });
  const response = await fetch(server.url + operation.url);
  assert.equal(response.status, 200);
  const content = await response.text();
  assert.equal((await fetch(server.url + operation.url.split('?')[0])).status, 403, 'download senza ticket rifiutato');
  const { uploadId } = await emit('database:import:upload:start', { tabId, format: formato });
  for (let offset = 0, index = 0; offset < content.length; offset += 16384) {
    await emit('database:import:upload:chunk', { tabId, uploadId, index: index++, chunk: content.slice(offset, offset + 16384) });
  }
  await emit('database:import:upload:finish', { tabId, uploadId });
  const request = { tabId, uploadId, targetDb: target, drop: true };
  const preview = await emit('database:import:start', { ...request, previewOnly: true });
  assert(preview.plan?.fingerprint, 'il piano deve avere una impronta');
  await assert.rejects(emit('database:import:start', { ...request, expectedFingerprint: 'impronta-diversa' }), /piano|impronta|fingerprint/i);
  const { accepted } = await emit('database:import:start', { ...request, expectedFingerprint: preview.plan.fingerprint });
  const result = await waitOperation('database:import:state', { tabId, operationId: accepted.operationId });
  await emit('database:import:cleanup', { tabId, operationId: accepted.operationId });
  return { bytes: Buffer.byteLength(content), stato: result.status };
}

async function fixtureMongo() {
  const type = 'mongodb';
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lint_m' });
  const source = registry.target('origine');
  registry.assertOwned(source);
  const port = Number(process.env.MONGO_PORT || 37017);
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 6000 });
  await client.connect();
  report.versioni.mongodb = (await client.db('admin').command({ buildInfo: 1 })).version;
  let mutation = 0;
  const fixture = { type, source, registry, config: { dbType: type, host: '127.0.0.1', port, directConnection: true },
    async diagnostics() {
      const names = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(d => d.name);
      const results = {};
      for (const name of names.filter(n => registry.targets().some(base => n === base || n.startsWith(`${base}__codedb_`)))) {
        results[name] = await client.db(name).listCollections().toArray();
      }
      return results;
    },
    async cleanup() {
      try {
        const databases = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases;
        await pulisciStaging(registry, databases.map(d => d.name), name => client.db(name).dropDatabase());
        await registry.cleanup(name => client.db(name).dropDatabase());
      } finally { await client.close(); }
    },
    async snapshot(db) {
      const docs = await client.db(db).collection('misure').find({}, { promoteValues: false }).sort({ _id: 1 }).toArray();
      const indexes = await client.db(db).collection('misure').indexes();
      const metadata = await client.db(db).listCollections({ name: 'misure' }).next();
      return { docs: docs.map(d => bson.EJSON.serialize(d, { relaxed: false })),
        indexes: indexes.map(({ v, ns, ...i }) => i).sort((a, b) => a.name.localeCompare(b.name)), options: metadata.options,
        vuota: Boolean(await client.db(db).listCollections({ name: 'vuota' }).next()) };
    },
    async mutate() {
      mutation += 1;
      const coll = client.db(source).collection('misure');
      await coll.updateOne({ _id: 1 }, { $set: { testo: `Aggiornato dopo full 🧪 ${mutation}`, updatedAt: new Date() } });
      await coll.deleteOne({ _id: 1 + mutation });
      await coll.insertOne({ _id: 9000 + mutation, testo: 'Nuovo', updatedAt: new Date(), totale: bson.Long.fromString('9007199254740997') });
    },
    async damage(db) { await client.db(db).collection('misure').deleteOne({ _id: 10 }); },
    async sentinel(db) { await client.db(db).collection('sentinella').insertOne({ _id: 1, preservare: 'Non cancellare' }); },
    async checkSentinel(db) { assert.equal((await client.db(db).collection('sentinella').findOne({ _id: 1 })).preservare, 'Non cancellare'); },
    async normalizza() {
      await client.db(source).command({ collMod: 'misure', validationLevel: 'strict', validationAction: 'error' });
    },
  };
  try {
    await client.db(source).createCollection('misure', { validator: { $jsonSchema: { bsonType: 'object', required: ['testo'], properties: { testo: { bsonType: 'string' } } } } });
    await client.db(source).createCollection('vuota');
    const docs = Array.from({ length: 2507 }, (_, i) => ({
      _id: i, testo: `riga ${i}: apice ' barra \\ CR\rLF\n tab\t emoji 🧪 è 漢字`,
      aggiornato: new Date('2026-10-20T23:59:59.123Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
      totale: bson.Long.fromString(String(9007199254740993n + BigInt(i))),
      decimale: bson.Decimal128.fromString('12345678901234567890.12345678901234'),
      piccolo: new bson.Int32(i), frazione: new bson.Double(i ? 0.125 : -0),
      byte: new bson.Binary(Buffer.from([0, 255, i % 256, 128])),
      uuid: new bson.UUID('00112233-4455-6677-8899-aabbccddeeff'),
      tempo: new bson.Timestamp({ t: 1761000000, i }), regex: new bson.BSONRegExp('^test.*\\n$', 'im'),
      estremi: [new bson.MinKey(), new bson.MaxKey(), bson.Decimal128.fromString('NaN')],
      annidato: { vuoto: [], nullo: null, array: [false, '', { codice: new bson.ObjectId('507f1f77bcf86cd799439011') }] },
      luogo: { type: 'Point', coordinates: [12.123456789, 41.987654321] },
    }));
    await client.db(source).collection('misure').insertMany(docs);
    await client.db(source).collection('misure').createIndex({ testo: 1, piccolo: -1 }, { name: 'indice_composto', partialFilterExpression: { piccolo: { $gte: 10 } } });
    await client.db(source).collection('misure').createIndex({ luogo: '2dsphere' }, { name: 'mappa' });
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}

async function fixtureSql(type) {
  const isMysql = type === 'mysql';
  const registry = createE2eTargetRegistry({ destructive: true, prefix: `lint_${isMysql ? 'my' : 'pg'}` });
  const source = registry.target('origine');
  registry.assertOwned(source);
  const config = { dbType: type, host: '127.0.0.1', port: Number(process.env[isMysql ? 'MYSQL_PORT' : 'PG_PORT'] || (isMysql ? 33306 : 35432)),
    username: isMysql ? 'root' : 'postgres', password: process.env[isMysql ? 'MYSQL_PASSWORD' : 'PG_PASSWORD'] || (isMysql ? 'lab_mysql' : 'lab_postgres'), database: isMysql ? '' : 'postgres' };
  const conn = isMysql
    ? await mysql.createConnection({ host: config.host, port: config.port, user: config.username, password: config.password, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, charset: 'utf8mb4' })
    : new PgClient({ host: config.host, port: config.port, user: config.username, password: config.password, database: config.database, connectionTimeoutMillis: 6000 });
  if (!isMysql) await conn.connect();
  const q = async (sql, params) => { const r = await conn.query(sql, params); return isMysql ? r[0] : r.rows; };
  const id = value => isMysql ? '`' + value.replaceAll('`', '``') + '`' : '"' + value.replaceAll('"', '""') + '"';
  const table = (db, name = 'Misure Storiche') => `${id(db)}.${id(name)}`;
  let mutation = 0;
  const fixture = { type, source, registry, config,
    async diagnostics() {
      const all = isMysql ? await q('SHOW DATABASES') : await q('SELECT schema_name FROM information_schema.schemata');
      const names = all.map(d => Object.values(d)[0]).filter(n => registry.targets().some(base => n === base || n.startsWith(`${base}__codedb_`)));
      const results = {};
      for (const db of names) {
        const detail = results[db] = {};
        if (isMysql) {
          const tables = await q('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE=\'BASE TABLE\'', [db]);
          for (const row of tables) detail[row.TABLE_NAME] = (await q(`SHOW CREATE TABLE ${table(db, row.TABLE_NAME)}`))[0]['Create Table'];
        } else detail.colonne = await q(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS tipo,pg_get_expr(d.adbin,d.adrelid) AS default_expr
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
          LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
          WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [db]);
        try {
          const rows = isMysql ? await q(`SELECT CAST(id AS CHAR) id FROM ${table(db)} ORDER BY tenant,id`)
            : await q(`SELECT id::text FROM ${table(db)} ORDER BY tenant,id`);
          const sourceRows = isMysql ? await q(`SELECT CAST(id AS CHAR) id FROM ${table(source)} ORDER BY tenant,id`)
            : await q(`SELECT id::text FROM ${table(source)} ORDER BY tenant,id`);
          const actualIds = new Set(rows.map(r => r.id));
          const expectedIds = new Set(sourceRows.map(r => r.id));
          detail.righe = rows.length;
          detail.idMancantiRispettoOrigineFinale = [...expectedIds].filter(n => !actualIds.has(n));
          detail.idInattesiRispettoOrigineFinale = [...actualIds].filter(n => !expectedIds.has(n));
        } catch (error) { detail.lettura = error.message; }
      }
      return results;
    },
    async cleanup() {
      try {
        const databases = isMysql ? await q('SHOW DATABASES') : await q('SELECT schema_name FROM information_schema.schemata');
        const drop = name => q(`DROP ${isMysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${id(name)}${isMysql ? '' : ' CASCADE'}`);
        await pulisciStaging(registry, databases.map(d => Object.values(d)[0]), drop);
        await registry.cleanup(drop);
      }
      finally { await conn.end(); }
    },
    async snapshot(db) {
      const rows = isMysql
        ? await q(`SELECT tenant,CAST(id AS CHAR) id,CAST(importo AS CHAR) importo,testo,HEX(binario) binario,CAST(istante AS CHAR) istante,CAST(ora AS CHAR) ora,CAST(giorno AS CHAR) giorno,CAST(documento AS CHAR) documento,HEX(ST_AsWKB(luogo)) luogo,ST_SRID(luogo) srid,stato,scelte,HEX(flag) flag,CAST(calcolato AS CHAR) calcolato,CAST(updated_at AS CHAR) updated_at FROM ${table(db)} ORDER BY tenant,id`)
        : await q(`SELECT tenant,id::text,importo::text,testo,encode(binario,'hex') binario,istante::text,ora::text,giorno::text,documento::text,luogo::text,stato::text,numeri::text,intervallo::text,periodo::text,indirizzo::text,uuid::text,flag::text,calcolato::text,updated_at::text FROM ${table(db)} ORDER BY tenant,id`);
      const parents = await q(`SELECT * FROM ${table(db, 'padri')} ORDER BY id`);
      const views = await q(`SELECT * FROM ${table(db, 'riepilogo')} ORDER BY tenant`);
      return { rows, parents, views, vuota: await q(`SELECT * FROM ${table(db, 'vuota')}`) };
    },
    async mutate() {
      mutation += 1;
      await q(`UPDATE ${table(source)} SET testo='Aggiornato dopo full ${mutation}',updated_at=CURRENT_TIMESTAMP${isMysql ? '(6)' : ''} WHERE tenant=1 AND id=9007199254740994`);
      await q(`DELETE FROM ${table(source)} WHERE tenant=1 AND id=${9007199254740994n + BigInt(mutation)}`);
      await q(`INSERT INTO ${table(source)} (tenant,id,importo,testo,updated_at) VALUES (1,${9007199254750998n + BigInt(mutation)},12345678901234567890.1234567890,'Nuovo',CURRENT_TIMESTAMP${isMysql ? '(6)' : ''})`);
    },
    async damage(db) { await q(`DELETE FROM ${table(db)} WHERE tenant=1 AND id=9007199254741003`); },
    async sentinel(db) {
      await q(`CREATE ${isMysql ? 'DATABASE' : 'SCHEMA'} ${id(db)}`);
      await q(`CREATE TABLE ${table(db, 'sentinella')} (id INT PRIMARY KEY, testo VARCHAR(40))`);
      await q(`INSERT INTO ${table(db, 'sentinella')} VALUES (1,'Non cancellare')`);
    },
    async checkSentinel(db) { assert.equal((await q(`SELECT testo FROM ${table(db, 'sentinella')}`))[0].testo, 'Non cancellare'); },
    async constraints(db) {
      await assert.rejects(q(`INSERT INTO ${table(db)} (tenant,id,testo) VALUES (999,1,'orfano')`), /foreign key|vincolo/i);
      if (!isMysql) await assert.rejects(q(`INSERT INTO ${table(db)} (tenant,id,testo,importo) VALUES (1,1,'negativo',-1)`), /check|vincolo/i);
      const generated = await q(`SELECT calcolato${isMysql ? '' : '::text'} AS calcolato FROM ${table(db)} WHERE tenant=1 AND id=9007199254740993`);
      assert.equal(generated[0].calcolato, '24691357802469135780.2469135780');
    },
    async normalizza() {
      if (!isMysql) await q(`DROP INDEX ${table(source, 'idx_parziale')}`);
    },
    async minimoIncrementale() {
      const temp = registry.target('tempo');
      const tempFixture = { ...fixture, source: temp };
      await q(`CREATE ${isMysql ? 'DATABASE' : 'SCHEMA'} ${id(temp)}`);
      await q(`CREATE TABLE ${table(temp, 'eventi')} (id INT PRIMARY KEY, testo TEXT, updated_at ${isMysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'})`);
      await q(`INSERT INTO ${table(temp, 'eventi')} VALUES (1,'prima','2026-01-01 00:00:00')`);
      const base = await backup(tempFixture, 'full');
      await q(`INSERT INTO ${table(temp, 'eventi')} VALUES (2,'dopo',CURRENT_TIMESTAMP${isMysql ? '(6)' : ''})`);
      const layer = await backup(tempFixture, 'incremental');
      const manifest = JSON.parse(fs.readFileSync(path.join(layer.dir, 'manifest.json'), 'utf8'));
      const data = manifest.files.find(f => f.kind === 'data' && f.collection === 'eventi');
      const details = { timezoneCli: 'Europe/Rome', timezoneSessione: 'UTC', tipo: isMysql ? 'DATETIME(6)' : 'TIMESTAMP(6)',
        expectedRigheIncrementali: 1, actualRigheIncrementali: data.count, base: base.id, layer: layer.id,
        server: await q(isMysql ? 'SELECT CURRENT_TIMESTAMP(6) AS ora,@@time_zone AS zona' : 'SELECT CURRENT_TIMESTAMP::text AS ora,current_setting(\'TimeZone\') AS zona') };
      report.diagnosticaTemporale ||= {};
      report.diagnosticaTemporale[type] = details;
      assert.equal(data.count, 1, JSON.stringify(details));
      const target = registry.target('tempo_copy');
      await restore(tempFixture, layer, target);
      const actual = await q(`SELECT id,testo FROM ${table(target, 'eventi')} ORDER BY id`);
      assert.deepEqual(actual.map(row => ({ ...row })), [{ id: 1, testo: 'prima' }, { id: 2, testo: 'dopo' }]);
      return details;
    },
    async minimoView() {
      const temp = registry.target('viste');
      const tempFixture = { ...fixture, source: temp };
      await q(`CREATE ${isMysql ? 'DATABASE' : 'SCHEMA'} ${id(temp)}`);
      await q(`CREATE TABLE ${table(temp, 'eventi')} (id INT PRIMARY KEY, testo VARCHAR(40))`);
      await q(`INSERT INTO ${table(temp, 'eventi')} VALUES (1,'prima')`);
      await q(`CREATE VIEW ${table(temp, 'vista')} AS SELECT id,testo FROM ${table(temp, 'eventi')}`);
      const base = await backup(tempFixture, 'full');
      await q(`INSERT INTO ${table(temp, 'eventi')} VALUES (2,'dopo')`);
      const layer = await backup(tempFixture, 'incremental');
      const target = registry.target('viste_copy');
      await restore(tempFixture, layer, target);
      assert.deepEqual((await q(`SELECT id,testo FROM ${table(target, 'vista')} ORDER BY id`)).map(row => ({ ...row })),
        [{ id: 1, testo: 'prima' }, { id: 2, testo: 'dopo' }]);
      return { base: base.id, layer: layer.id, righeAttese: 2 };
    },
  };
  try {
    report.versioni[type] = (await q(isMysql ? 'SELECT VERSION() AS versione' : 'SHOW server_version'))[0];
    await q(isMysql ? "SET time_zone='+00:00'" : "SET TIME ZONE 'UTC'");
    await q(`CREATE ${isMysql ? 'DATABASE' : 'SCHEMA'} ${id(source)}${isMysql ? ' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin' : ''}`);
    await q(`CREATE TABLE ${table(source, 'padri')} (id INT PRIMARY KEY, nome VARCHAR(40) NOT NULL UNIQUE)`);
    await q(`INSERT INTO ${table(source, 'padri')} VALUES (1,'Primo'),(2,'Secondo')`);
    await q(`CREATE TABLE ${table(source, 'vuota')} (id INT PRIMARY KEY)`);
    if (!isMysql) {
      await q(`CREATE TYPE ${table(source, 'stato_ordine')} AS ENUM ('nuovo','in corso','chiuso')`);
      await q(`CREATE DOMAIN ${table(source, 'importo_positivo')} AS NUMERIC(40,10) CHECK (VALUE>=0)`);
    }
    await q(`CREATE TABLE ${table(source)} (
      tenant INT NOT NULL, id BIGINT${isMysql ? ' UNSIGNED' : ''} NOT NULL,
      importo ${isMysql ? 'DECIMAL(40,10)' : table(source, 'importo_positivo')}, testo TEXT NOT NULL,
      binario ${isMysql ? 'LONGBLOB' : 'BYTEA'}, istante ${isMysql ? 'TIMESTAMP(6)' : 'TIMESTAMPTZ(6)'},
      ora TIME(6), giorno DATE, documento ${isMysql ? 'JSON' : 'JSONB'}, luogo ${isMysql ? 'GEOMETRY' : 'POINT'},
      stato ${isMysql ? "ENUM('nuovo','in corso','chiuso')" : table(source, 'stato_ordine')},
      ${isMysql ? "scelte SET('uno','due','tre'), flag BIT(9)," : 'numeri NUMERIC[][], intervallo INTERVAL, periodo TSTZRANGE, indirizzo INET, uuid UUID, flag BIT(9),'}
      calcolato ${isMysql ? 'DECIMAL(41,10)' : 'NUMERIC(41,10)'} GENERATED ALWAYS AS (importo*2) STORED,
      updated_at ${isMysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'} NOT NULL DEFAULT CURRENT_TIMESTAMP${isMysql ? '(6)' : ''},
      PRIMARY KEY(tenant,id), CONSTRAINT fk_padre FOREIGN KEY(tenant) REFERENCES ${table(source, 'padri')}(id)
    )`);
    if (isMysql) {
      const sql = `INSERT INTO ${table(source)} (tenant,id,importo,testo,binario,istante,ora,giorno,documento,luogo,stato,scelte,flag,updated_at)
        VALUES ?`;
      const rows = Array.from({ length: 2203 }, (_, n) => [1, String(9007199254740993n + BigInt(n)), '12345678901234567890.1234567890',
        `riga ${n}: apice ' backslash \\ CR\rLF\n tab\t emoji 🧪 è 漢字`, Buffer.from([0, 255, n % 256, 128]),
        '2026-10-20 23:59:59.123456', '23:59:59.987654', n % 2 ? '1000-01-01' : '9999-12-31',
        '{"intero":9007199254740993,"annidato":[null,true,"\\n"]}', null, 'in corso', 'uno,tre', 257, '2026-01-01 00:00:00.000001']);
      for (let n = 0; n < rows.length; n += 400) await q(sql, [rows.slice(n, n + 400)]);
      await q(`UPDATE ${table(source)} SET luogo=ST_GeomFromText('POINT(41.123456789 12.987654321)',4326)`);
    } else {
      await q(`INSERT INTO ${table(source)} (tenant,id,importo,testo,binario,istante,ora,giorno,documento,luogo,stato,numeri,intervallo,periodo,indirizzo,uuid,flag,updated_at)
        SELECT 1,9007199254740993+i,12345678901234567890.1234567890,$1||i,decode('00ff80','hex'),
        '2026-10-20 23:59:59.123456+05:30','23:59:59.987654','9999-12-31',
        '{"intero":9007199254740993,"annidato":[null,true,"\\n"]}',point(12.123456789,41.987654321),'in corso',
        ARRAY[[12345678901234567890.1234567890::numeric,NULL],[0.0000000001,-9007199254740993]],
        '1 year 2 mons -3 days 04:05:06.123456','[2026-01-01 00:00:00+00,2026-12-31 23:59:59.999999+00)',
        '2001:db8::1/64','00112233-4455-6677-8899-aabbccddeeff',B'100000001','2026-01-01 00:00:00.000001'
        FROM generate_series(0,2202) AS i`, ["apice ' backslash \\ CR\rLF\n tab\t emoji 🧪 è 漢字 "]);
      await q(`CREATE INDEX idx_parziale ON ${table(source)}(id) WHERE tenant=1`);
    }
    await q(`CREATE VIEW ${table(source, 'riepilogo')} AS SELECT tenant,COUNT(*) AS righe FROM ${table(source)} GROUP BY tenant`);
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}

async function esercita(fixture) {
  const { type, registry } = fixture;
  fs.appendFileSync(ini, `[${type}]\n${Object.entries(fixture.config).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  let full;
  const expected = await fixture.snapshot(fixture.source);
  await prova(`${type}: oracolo indipendente sensibile a perdita e alterazione`, async () => {
    const altered = structuredClone(expected);
    const array = altered.docs || altered.rows;
    array.pop();
    assert.throws(() => equivalente(altered, expected, 'riga rimossa'), /contenuto diverso/);
    const alteredValue = structuredClone(expected);
    (alteredValue.docs || alteredValue.rows)[0].testo = 'Valore corrotto deliberatamente';
    assert.throws(() => equivalente(alteredValue, expected, 'valore alterato'), /contenuto diverso/);
    return { righe: (expected.docs || expected.rows).length, sha256: digest(expected) };
  });
  await prova(`${type}: backup full e verify`, async () => {
    full = await backup(fixture, 'full');
    return { id: full.id, righe: (expected.docs || expected.rows).length };
  });
  if (full) {
    const copy = registry.target('ripristino');
    await prova(`${type}: restore full, tipi, metadati e sensibilita reale`, async () => {
      await restore(fixture, full, copy);
      equivalente(await fixture.snapshot(copy), expected, 'full');
      if (fixture.constraints) await fixture.constraints(copy);
      await fixture.damage(copy);
      const damaged = await fixture.snapshot(copy);
      assert.throws(() => equivalente(damaged, expected, 'riga cancellata'), /contenuto diverso/);
      return { sha256: digest(expected), mutazione: 'riga eliminata realmente nella copia rilevata dal confronto' };
    });
    await prova(`${type}: archivio corrotto rifiutato prima di modificare la destinazione`, async () => {
      const corrupt = path.join(root, `corrotto-${type}`);
      fs.cpSync(full.dir, corrupt, { recursive: true });
      const manifest = JSON.parse(fs.readFileSync(path.join(corrupt, 'manifest.json'), 'utf8'));
      const data = manifest.files.find(f => f.kind === 'data' && f.count > 0);
      fs.appendFileSync(path.join(corrupt, data.path), Buffer.from('CORRUZIONE DELIBERATA'));
      assert.throws(() => cli('verify', '--from', corrupt), /checksum|problemi|verifica|integrit/i);
      const target = registry.target('corrotto');
      await fixture.sentinel(target);
      assert.throws(() => cli('restore', '--conn', type, '--from', corrupt, '--target-db', target, '--drop'), /checksum|integrit|verifica|corrott/i);
      await fixture.checkSentinel(target);
      return { mutazione: 'byte aggiunti al vero archivio; verify e restore falliscono' };
    });
    await fixture.mutate();
    const changed = await fixture.snapshot(fixture.source);
    for (const mode of ['incremental', 'differential']) await prova(`${type}: ${mode} con update e cancellazioni`, async () => {
      const layer = await backup(fixture, mode);
      const target = registry.target(mode === 'incremental' ? 'inc' : 'diff');
      await restore(fixture, layer, target);
      equivalente(await fixture.snapshot(target), changed, mode);
      return { sha256: digest(changed), full: full.id, layer: layer.id };
    });
  }
  await emit('mongo:connect', { tabId: type, ...fixture.config });
  for (const formato of type === 'mongodb' ? ['codedb-json'] : ['codedb-json', 'sql']) {
    await prova(`${type}: export HTTP e import socket ${formato} con dati complessi`, async () => {
      const expectedNow = await fixture.snapshot(fixture.source);
      const target = registry.target(formato === 'sql' ? 'export_sql' : 'export_json');
      const result = await exportImport(fixture, target, formato);
      equivalente(await fixture.snapshot(target), expectedNow, `export ${formato}`);
      if (fixture.constraints) await fixture.constraints(target);
      await fixture.damage(target);
      const damaged = await fixture.snapshot(target);
      assert.throws(() => equivalente(damaged, expectedNow, 'cancellazione nella copia importata'), /contenuto diverso/);
      return { ...result, sha256: digest(expectedNow), mutazione: 'cancellazione reale nella copia importata rilevata' };
    });
  }
  // Prove ulteriori indipendenti: il difetto di metadati resta registrato sopra,
  // ma non deve impedire di esercitare il trasferimento dei valori e le catene.
  if (type !== 'mysql') {
    const variante = type === 'mongodb' ? 'validator con default espliciti' : 'schema senza indice aggiuntivo';
    await fixture.normalizza();
    let base;
    await prova(`${type}: full e sensibilita reale, ${variante}`, async () => {
      const expectedNow = await fixture.snapshot(fixture.source);
      base = await backup(fixture, 'full');
      const target = registry.target('norm_full');
      await restore(fixture, base, target);
      equivalente(await fixture.snapshot(target), expectedNow, 'full normalizzato');
      if (fixture.constraints) await fixture.constraints(target);
      await fixture.damage(target);
      const damaged = await fixture.snapshot(target);
      assert.throws(() => equivalente(damaged, expectedNow, 'riga cancellata realmente'), /contenuto diverso/);
      return { sha256: digest(expectedNow), mutazione: 'cancellazione reale nella copia rilevata' };
    });
    if (base) {
      await fixture.mutate();
      const expectedNow = await fixture.snapshot(fixture.source);
      for (const mode of ['incremental', 'differential']) {
        await prova(`${type}: ${mode} indipendente, ${variante}`, async () => {
          const layer = await backup(fixture, mode);
          const target = registry.target(mode === 'incremental' ? 'norm_inc' : 'norm_diff');
          await restore(fixture, layer, target);
          equivalente(await fixture.snapshot(target), expectedNow, mode);
          return { sha256: digest(expectedNow), base: base.id, layer: layer.id };
        });
      }
    }
    if (type === 'mongodb') await prova(`${type}: export/import con default del validator espliciti`, async () => {
      const expectedNow = await fixture.snapshot(fixture.source);
      const target = registry.target('norm_json');
      const result = await exportImport(fixture, target, 'codedb-json');
      equivalente(await fixture.snapshot(target), expectedNow, 'export BSON');
      return { ...result, sha256: digest(expectedNow) };
    });
  }
  if (fixture.minimoIncrementale) await prova(`${type}: riproduzione minima incrementale con fusi diversi`, () => fixture.minimoIncrementale());
  if (fixture.minimoView) await prova(`${type}: riproduzione minima catena incrementale con vista`, () => fixture.minimoView());
  await emit('mongo:disconnect', { tabId: type });
}

(async () => {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Impostare CODEDB_E2E_DESTRUCTIVE=1 per i soli database Docker del laboratorio.');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(ini, '');
  server = await startTestServer({ port: Number(process.env.LAB_INTEGRITA_PORT || 3244) });
  socket = io(server.url, { reconnection: false, timeout: 10000 });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const type of ['mongodb', 'mysql', 'postgresql']) {
    let fixture;
    const seeded = await prova(`${type}: fixture reale indipendente`, async () => {
      fixture = type === 'mongodb' ? await fixtureMongo() : await fixtureSql(type);
      return { origine: fixture.source };
    });
    if (!seeded) continue;
    try { await esercita(fixture); }
    catch (error) { await prova(`${type}: completamento del protocollo`, async () => { throw error; }); }
    finally {
      await prova(`${type}: raccolta evidenze native`, async () => {
        fs.mkdirSync(artifactsDir, { recursive: true });
        fs.writeFileSync(path.join(artifactsDir, `${type}-schema-nativo.json`), JSON.stringify(await fixture.diagnostics(), null, 2));
      });
      await prova(`${type}: pulizia dei soli bersagli posseduti`, () => fixture.cleanup());
    }
  }
})().catch(error => { report.erroreFatale = error.stack; console.error(error); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  if (server) await server.stop();
  report.terminato = new Date().toISOString();
  report.totali = { pass: report.verifiche.filter(x => x.esito === 'PASS').length, fail: report.verifiche.filter(x => x.esito === 'FAIL').length };
  fs.mkdirSync(reportDir, { recursive: true });
  if (fs.existsSync(backupRoot)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.cpSync(backupRoot, path.join(artifactsDir, 'backups'), { recursive: true });
  }
  fs.writeFileSync(path.join(reportDir, 'integrita.json'), JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`Report integrita: ${JSON.stringify(report.totali)}`);
});
