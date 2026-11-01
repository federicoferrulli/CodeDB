'use strict';

// AUD012: volume oltre i blocchi da 1000, oracolo nativo completo e misure
// descrittive. Nessuna soglia temporale o di memoria dipendente dall'hardware.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-incrementali-volume.cjs --sensitivity
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-012/volume-host');
const COUNT = 10000, BATCH = 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const root = path.resolve(__dirname, '../..');
const log = { info() {}, warn() {}, error() {} };
const changedIds = [1000, 1001, ...Array.from({ length: 98 }, (_, i) => 1 + i * 97)].sort((a, b) => a - b);
const deletedIds = Array.from({ length: 100 }, (_, i) => 9901 + i);
const insertedIds = Array.from({ length: 100 }, (_, i) => 10001 + i);
const textOf = id => `riga ${String(id).padStart(5, '0')} ${hash('contenuto-' + id).slice(0, 48)} Ω漢字`;
const record = id => ({ id, valore: id * 7, testo: textOf(id), updated_at: '2020-01-01T00:00:00.000Z' });

async function worker(type, mutant) {
  fs.mkdirSync(reportDir, { recursive: true });
  const mongo = type === 'mongodb', mysql = type === 'mysql';
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_iv' });
  const source = registry.target(type), q = name => mysql ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"';
  const table = db => `${q(db)}.${q('righe')}`;
  const report = { suite: 'backup-incrementali-volume', motore: type, mutante: mutant, iniziato: new Date().toISOString(), righe: COUNT,
    verifiche: [], misure: [], archivi: [], mutazioni: 0, sorgenti: {} };
  const files = ['backup/lib/engine.js', 'backup/lib/content-state.js', 'backup/lib/restore.js', 'backup/lib/identity.js', 'backup/lib/tombstones.js', 'backup/lib/util.js', 'test/lab/backup-incrementali-volume.cjs'];
  for (const file of files) report.sorgenti[file] = hash(fs.readFileSync(path.join(root, file)));
  let native, strategy, active = null, mutationArmed = false;
  const query = async (sql, params = []) => mysql ? (await native.query(sql, params))[0] : (await native.query(sql, params)).rows;
  const util = require('../../backup/lib/util'), originalSink = util.createFileSink;
  function decodeLine(line) {
    const parsed = JSON.parse(line);
    return mongo ? require('bson').deserialize(require('../../db/mongoBson').decode(parsed)) : require('../../db/codecFedele').parseRiga(line);
  }
  util.createFileSink = (file, options) => {
    const sink = originalSink(file, options);
    if (!mutant || !mutationArmed || path.basename(path.dirname(file)) !== 'data') return sink;
    const write = sink.writeLine;
    sink.writeLine = function (line) {
      if (mutationArmed && Number(decodeLine(line).id) === 1000) {
        mutationArmed = false; report.mutazioni++;
        return undefined;
      }
      return write.call(this, line);
    };
    return sink;
  };
  const { runBackup } = require('../../backup/lib/engine');
  const { runRestore } = require('../../backup/lib/restore');
  async function check(id, action) {
    try { const dettagli = await action(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${type}/${id}`); }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${type}/${id}: ${error.message.split('\n')[0]}`); }
  }
  async function measure(label, action, observe = false) {
    const before = process.memoryUsage(), cpu = process.cpuUsage(), start = process.hrtime.bigint();
    const metric = { fase: label, query: 0, righeLetteDriver: 0, scansioni: [], blocchi: [], memoriaPrima: before,
      piccoCampionato: { rss: before.rss, heapUsed: before.heapUsed, external: before.external } };
    const sample = () => { const value = process.memoryUsage(); for (const key of Object.keys(metric.piccoCampionato)) metric.piccoCampionato[key] = Math.max(metric.piccoCampionato[key], value[key]); };
    const timer = setInterval(sample, 10); if (observe) active = metric;
    try { return await action(); }
    finally {
      if (observe) active = null; clearInterval(timer); sample(); metric.ms = Number(process.hrtime.bigint() - start) / 1e6;
      metric.cpuMicrosecondi = process.cpuUsage(cpu); metric.memoriaDopo = process.memoryUsage(); report.misure.push(metric);
    }
  }
  async function nativeDigest(db) {
    const digest = createHash('sha256'); let count = 0, previous = 0, pages = 0;
    const append = row => { assert(Number(row.id) > previous, 'Ordine/identità nativa duplicata');
      if (mongo) assert.equal(Number(row._id), Number(row.id), 'Identità MongoDB nativa conservata');
      previous = Number(row.id); count++;
      digest.update(JSON.stringify({ id: Number(row.id), valore: Number(row.valore), testo: row.testo,
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at }) + '\n'); };
    if (mongo) {
      const cursor = native.db(db).collection('righe').find({}).sort({ id: 1 }).batchSize(BATCH);
      try { for await (const row of cursor) append(row); } finally { await cursor.close(); }
    } else {
      for (;;) {
        const date = mysql ? "DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.000Z')" : "to_char(updated_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
        const rows = await query(`SELECT id,valore,testo,${date} AS updated_at FROM ${table(db)} WHERE id>${previous} ORDER BY id LIMIT ${BATCH}`);
        pages++; for (const row of rows) append(row); if (rows.length < BATCH) break;
      }
    }
    return { count, sha256: digest.digest('hex'), ...(mongo ? {} : { pagineOracolo: pages }) };
  }
  async function insert(ids) {
    for (let offset = 0; offset < ids.length; offset += BATCH) {
      const rows = ids.slice(offset, offset + BATCH).map(record);
      if (mongo) await native.db(source).collection('righe').insertMany(rows.map(row => ({ _id: row.id, ...row, updated_at: new Date(row.updated_at) })));
      else {
        const values = rows.flatMap(row => [row.id, row.valore, row.testo, '2020-01-01 00:00:00']);
        const tuples = rows.map((_, i) => '(' + Array.from({ length: 4 }, (_, j) => mysql ? '?' : `$${i * 4 + j + 1}`).join(',') + ')');
        await query(`INSERT INTO ${table(source)} (id,valore,testo,updated_at) VALUES ${tuples.join(',')}`, values);
      }
    }
  }
  async function archive(kind, label) {
    const result = await measure('backup-' + label, () => runBackup({ session: { strategy, dbType: type }, connName: 'incrementali-volume',
      db: source, type: kind, destRoot: path.join(reportDir, 'archivi'), compress: true, log }), true);
    const manifestPath = path.join(result.backupDir, 'manifest.json');
    const manifest = util.readManifest(result.backupDir);
    if (mutant && label === 'scarso' && report.mutazioni === 1) {
      // Il mutante simula un confronto di contenuto che ignora un update:
      // checksum e numero di righe restano coerenti; la cardinalità finale
      // resta 10k e soltanto l'oracolo dei valori può rilevare quella perdita.
      manifest.files.find(file => file.kind === 'data' && file.collection === 'righe').count--;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    const entry = { label, backupDir: result.backupDir, manifest, bytes: fs.statSync(manifestPath).size,
      bytesDati: 0, bytesDatiEspansi: 0, dati: [], tombstones: [] };
    for (const file of manifest.files) {
      const fullPath = path.join(result.backupDir, file.path); entry.bytes += fs.statSync(fullPath).size;
      if (file.kind === 'data') {
        entry.bytesDati += fs.statSync(fullPath).size;
        for await (const line of util.readLines(fullPath)) {
          entry.bytesDatiEspansi += Buffer.byteLength(line + '\n');
          const row = decodeLine(line); entry.dati.push({ id: Number(row.id), valore: Number(row.valore) });
        }
      } else if (file.kind === 'tombstones') {
        for await (const line of util.readLines(fullPath)) {
          const parsed = JSON.parse(line);
          entry.tombstones.push(mongo ? Number(require('bson').deserialize(require('../../db/mongoBson').decodeId(parsed))._id)
            : Number(require('../../db/codecFedele').parseRiga(line).id));
        }
      }
    }
    entry.dati.sort((a, b) => a.id - b.id); entry.tombstones.sort((a, b) => a - b);
    entry.righeArchiviate = entry.dati.length;
    entry.digestValoriArchivio = hash(JSON.stringify(entry.dati));
    report.archivi.push(entry);
    await check(label + '-integrita-archivio', async () => assert.equal((await util.verifyBackupDir(result.backupDir)).valid, true));
    return entry;
  }
  async function restore(entry, label, expected) {
    const target = registry.target(label + '_' + type); let outcome;
    await check(label + '-ripristino', async () => {
      outcome = await measure('restore-' + label, () => runRestore({ session: { strategy, dbType: type }, backupDir: entry.backupDir,
        targetDb: target, drop: true, log }));
      assert(outcome);
    });
    await check(label + '-digest-nativo', async () => {
      const actual = await nativeDigest(target);
      assert.equal(actual.count, expected.count, 'Cardinalità nativa');
      assert.equal(actual.sha256, expected.sha256, '[VOLUME-CONTENUTO] digest di tutti i valori nativi, in ordine di identità');
      return actual;
    });
  }
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    if (mongo) {
      const { MongoClient } = require('mongodb');
      native = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.LAB_MONGO_PORT || 37017)}/?directConnection=true`, { monitorCommands: true });
      const requests = new Map(), cursors = new Map();
      native.on('commandStarted', event => {
        if (!active || event.databaseName !== source) return;
        active.query++;
        if (event.command.find === 'righe' || event.command.collection === 'righe' && event.command.getMore) {
          const key = event.command.getMore?.toString();
          requests.set(event.requestId, { metric: active, kind: key ? cursors.get(key) || 'getMore' : event.command.projection ? 'identita' : 'dati',
            batchSize: event.command.batchSize || null });
        }
      });
      native.on('commandSucceeded', event => {
        const item = requests.get(event.requestId); if (!item) return; requests.delete(event.requestId);
        const cursor = event.reply.cursor, rows = cursor?.firstBatch || cursor?.nextBatch || [];
        item.metric.righeLetteDriver += rows.length; item.metric.blocchi.push({ tipo: item.kind, righe: rows.length, richieste: item.batchSize });
        if (cursor?.id) cursors.set(cursor.id.toString(), item.kind);
      });
      await native.connect(); strategy = new (require('../../db/MongoDbStrategy'))(); strategy.client = native;
      await native.db(source).createCollection('righe');
    } else if (mysql) {
      const driver = require('mysql2/promise'), config = { host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), user: 'root', password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql' };
      native = await driver.createConnection(config); strategy = new (require('../../db/MySqlStrategy'))(); strategy.pool = driver.createPool({ ...config, connectionLimit: 3 });
      strategy.pool.pool.on('connection', connection => {
        const original = connection.query;
        connection.query = function (...args) {
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql || '', metric = active, result = original.apply(this, args);
          if (metric) {
            metric.query++;
            if (/^SELECT\b/i.test(sql) && sql.includes(`FROM ${table(source)}`) && !/\bCOUNT\(/i.test(sql)) {
              const scan = { sql, righe: 0 }; metric.scansioni.push(scan);
              result.on('result', () => { scan.righe++; metric.righeLetteDriver++; });
            }
          }
          return result;
        };
      });
      await query(`CREATE DATABASE ${q(source)} CHARACTER SET utf8mb4`);
    } else {
      const { Client, Pool } = require('pg'), config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
      native = new Client(config); await native.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool({ ...config, max: 3 });
      strategy.pool.on('connect', client => {
        const original = client.query;
        client.query = function (...args) {
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '', metric = active, result = original.apply(this, args);
          if (!metric) return result; metric.query++;
          if (!/^FETCH\b/i.test(sql) || !result?.then) return result;
          return result.then(value => { metric.righeLetteDriver += value.rows.length; metric.blocchi.push({ sql, righe: value.rows.length }); return value; });
        };
      });
      await query(`CREATE SCHEMA ${q(source)}`);
    }
    if (!mongo) await query(`CREATE TABLE ${table(source)} (id INT PRIMARY KEY,valore INT NOT NULL,testo VARCHAR(160) NOT NULL,updated_at ${mysql ? 'DATETIME(6)' : 'TIMESTAMP(6)'} NOT NULL)`);
    await measure('fixture', () => insert(Array.from({ length: COUNT }, (_, i) => i + 1)));
    const initial = await nativeDigest(source); report.digestIniziale = initial;
    await check('fixture-10k', async () => assert.equal(initial.count, COUNT));
    const full = await archive('full', 'full');
    await check('full-contenuto-archivio', async () => assert.deepEqual(full.dati, Array.from({ length: COUNT }, (_, i) => ({ id: i + 1, valore: (i + 1) * 7 }))));
    // Il contenuto completo resta nell'archivio; il rapporto non trattiene
    // 10k oggetti durante le successive misure del processo.
    delete full.dati;
    await restore(full, 'full', initial);
    const empty = await archive('incremental', 'invariato');
    await check('invariato-zero-delta', async () => { assert.deepEqual(empty.dati, []); assert.deepEqual(empty.tombstones, []); });
    await restore(empty, 'invariato', initial);
    if (mongo) {
      await native.db(source).collection('righe').updateMany({ id: { $in: changedIds } }, { $inc: { valore: 100000 } });
      await native.db(source).collection('righe').deleteMany({ id: { $in: deletedIds } });
    } else {
      await query(`UPDATE ${table(source)} SET valore=valore+100000 WHERE id IN (${changedIds.join(',')})`);
      await query(`DELETE FROM ${table(source)} WHERE id IN (${deletedIds.join(',')})`);
    }
    await insert(insertedIds); const final = await nativeDigest(source); report.digestFinale = final;
    await check('modifiche-cardinalita-ferma', async () => { assert.equal(final.count, COUNT); assert.notEqual(final.sha256, initial.sha256); });
    mutationArmed = !!mutant;
    const sparse = await archive('incremental', 'scarso');
    await check('scarso-contenuto-archivio', async () => {
      const expected = [...changedIds.map(id => ({ id, valore: id * 7 + 100000 })), ...insertedIds.map(id => ({ id, valore: id * 7 }))].sort((a, b) => a.id - b.id);
      assert.deepEqual(sparse.dati, expected, '200 righe cambiate, comprese le posizioni intorno al blocco 1000');
      assert.deepEqual(sparse.tombstones, deletedIds);
    });
    await restore(sparse, 'scarso', final);
    await check('compressione-delta-osservabile', async () => { assert(empty.bytesDati < full.bytesDati); assert(sparse.bytesDati < full.bytesDati); });
    await check('sorgente-inalterata-da-backup-restore', async () => assert.deepEqual(await nativeDigest(source), final));
    await check('letture-driver-osservate', async () => {
      const fullMetric = report.misure.find(item => item.fase === 'backup-full');
      assert(fullMetric.righeLetteDriver >= COUNT, 'La strumentazione deve osservare almeno la lettura full');
      if (!mysql) { assert(fullMetric.blocchi.length >= COUNT / BATCH); assert(fullMetric.blocchi.every(item => item.righe <= BATCH)); }
    });
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    util.createFileSink = originalSink;
    if (native) {
      try {
        const owned = registry.targets(), drop = db => mongo ? native.db(db).dropDatabase() : query(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${q(db)}${mysql ? '' : ' CASCADE'}`);
        await registry.cleanup(drop);
        const remaining = mongo ? (await native.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(db => db.name)
          : (await query(mysql ? 'SHOW DATABASES' : 'SELECT schema_name FROM information_schema.schemata')).map(row => Object.values(row)[0]);
        assert.deepEqual(remaining.filter(name => owned.includes(name)), []); report.pulizia = 'completata';
      } catch (error) { report.errorePulizia = error.stack; }
      await (mongo ? native.close() : native.end()).catch(error => { report.erroreChiusura = error.message; });
    }
    if (strategy?.pool) await strategy.pool.end().catch(error => { report.erroreChiusura = error.message; });
    report.hashStabili = files.every(file => report.sorgenti[file] === hash(fs.readFileSync(path.join(root, file))));
    report.fallimenti = report.verifiche.filter(item => !item.ok).map(item => item.id); report.terminato = new Date().toISOString();
    report.ok = report.verifiche.length > 0 && !report.fallimenti.length && report.hashStabili && !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.pulizia === 'completata';
    fs.writeFileSync(path.join(reportDir, 'backup-incrementali-volume.json'), JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
  }
}
async function child(type, mutant) {
  const directory = path.join(reportDir, type + (mutant ? '-salta-update' : '')); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'backup-incrementali-volume.json'); fs.rmSync(file, { force: true });
  const output = fs.createWriteStream(path.join(directory, 'console.log'));
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, '--worker', type, ...(mutant ? ['--mutant'] : [])], {
      env: { ...process.env, LAB_REPORT_DIR: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    inoltraOutputFiglio(proc, { log: output, mutante: mutant ? `${type}/salta-update` : null }); proc.once('error', reject); proc.once('close', resolve);
  }).finally(() => new Promise(resolve => output.end(resolve)));
  return { exitCode, file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { erroreFatale: 'Rapporto figlio assente', ok: false }) };
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1'); fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-incrementali-volume', iniziato: new Date().toISOString(), risultati: [], sensibilita: [] };
  const save = () => fs.writeFileSync(path.join(reportDir, 'backup-incrementali-volume.json'), JSON.stringify(report, null, 2));
  const types = ['mongodb', 'mysql', 'postgresql'].filter(type => !process.env.LAB_VOLUME_ENGINE || process.env.LAB_VOLUME_ENGINE === type); assert(types.length);
  for (const type of types) { report.risultati.push(await child(type, false)); save(); }
  if (process.argv.includes('--sensitivity') && report.risultati.every(item => item.ok && item.exitCode === 0)) for (const type of types) {
    const result = await child(type, true), expected = ['scarso-contenuto-archivio', 'scarso-digest-nativo'].sort();
    report.sensibilita.push({ motore: type, risultato: result,
      rilevata: result.exitCode === 1 && result.mutazioni === 1 && result.hashStabili && !result.erroreFatale && !result.errorePulizia && !result.erroreChiusura
        && result.pulizia === 'completata' && JSON.stringify([...result.fallimenti].sort()) === JSON.stringify(expected) }); save();
  }
  report.ok = report.risultati.every(item => item.ok && item.exitCode === 0)
    && (!process.argv.includes('--sensitivity') || report.sensibilita.length === types.length && report.sensibilita.every(item => item.rilevata));
  report.totali = { verifiche: report.risultati.reduce((n, item) => n + item.verifiche.length, 0), fallite: report.risultati.reduce((n, item) => n + item.fallimenti.length, 0) };
  report.terminato = new Date().toISOString(); save(); if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv[process.argv.indexOf('--worker') + 1], process.argv.includes('--mutant')) : main())
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
