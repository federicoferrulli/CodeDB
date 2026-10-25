'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// Backup temporali reali, senza dipendere da viste, FK o tipi generati.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-tempi.cjs [--sensitivity]
// LAB_BACKUP_TEMPI_CASE filtra gli scenari; LAB_REPORT_DIR separa i rapporti.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { readManifest, readLines, fileDelBackup, verifyBackupDir } = require('../../backup/lib/util');
const { parseRiga } = require('../../db/codecFedele');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/lab-reports/backup-tempi');
const hash = value => createHash('sha256').update(value).digest('hex');
const qid = value => '"' + value.replaceAll('"', '""') + '"';
const myid = value => '`' + value.replaceAll('`', '``') + '`';
const iso = ms => new Date(ms).toISOString();
const millis = text => Date.parse(text);
function micros(epoch) {
  const ms = epoch / 1000n, rest = epoch % 1000n;
  return iso(Number(ms)).replace('Z', String(rest).padStart(3, '0') + 'Z');
}
const silenzioso = { info() {}, error() {}, warn() {} };

function scenari() {
  const rows = [];
  for (const [tz, slug] of [['UTC', 'utc'], ['Europe/Rome', 'roma'], ['America/New_York', 'newyork']]) {
    for (const [zonaDb, suffix] of [['UTC', 'dbutc'], ['Europe/Rome', 'dbroma'], ['America/New_York', 'dbnewyork']]) {
      rows.push({ id: `pg-${slug}-${suffix}`, motore: 'postgresql', tz, zonaDb, istante: '2026-01-15T12:34:56.123Z', margine: 0 });
    }
    rows.push({ id: `pg-${slug}-estate`, motore: 'postgresql', tz, zonaDb: 'UTC', istante: '2026-07-15T12:34:56.123Z', margine: 2000 });
    rows.push({ id: `mysql-${slug}`, motore: 'mysql', tz, zonaDb: '+05:30', istante: '2026-07-15T12:34:56.123Z', margine: 2000 });
  }
  for (const [suffix, istante] of [
    ['marzo-prima', '2026-03-29T00:59:59.999Z'], ['marzo-dopo', '2026-03-29T01:00:00.001Z'],
    ['ottobre-prima', '2026-10-25T00:59:59.999Z'], ['ottobre-dopo', '2026-10-25T01:00:00.001Z'],
    ['mezzanotte', '2026-01-16T00:00:01.000Z'],
  ]) rows.push({ id: `pg-${suffix}`, motore: 'postgresql', tz: 'Europe/Rome', zonaDb: 'America/New_York', istante, margine: 2000 });
  rows.push({ id: 'pg-legacy-offset', motore: 'postgresql', tz: 'America/New_York', zonaDb: 'Europe/Rome', istante: '2026-07-15T14:34:56.123+02:00', margine: 2000, legacy: true });
  rows.push({ id: 'pg-smoke-clock', motore: 'postgresql', tz: 'Europe/Rome', zonaDb: 'UTC', smoke: true, margine: 2000 });
  rows.push({ id: 'mysql-mezzanotte', motore: 'mysql', tz: 'Europe/Rome', zonaDb: '-05:00', istante: '2026-01-16T00:00:01.000Z', margine: 2000 });
  return rows;
}

async function worker(scenario) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-tempi', scenario, iniziato: new Date().toISOString(), verifiche: [], mutazioni: 0,
    sorgenti: { engine: hash(fs.readFileSync(path.resolve(__dirname, '../../backup/lib/engine.js'))), fixture: hash(fs.readFileSync(__filename)) } };
  const helper = path.resolve(__dirname, '../../backup/lib/confine-sql.js');
  if (fs.existsSync(helper)) report.sorgenti.confine = hash(fs.readFileSync(helper));
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_tempo' });
  const schema = registry.target('origine');
  const mysql = scenario.motore === 'mysql';
  const quota = mysql ? myid : qid;
  const tab = (name, db = schema) => `${quota(db)}.${quota(name)}`;
  const artifacts = path.join(reportDir, 'archivi');
  let native, strategy;
  if (scenario.mutant) {
    // Precaricamento del solo helper: engine continua a comporre ed eseguire
    // le query vere. Il mutante non tocca sorgenti, driver o risposta del DB.
    const confini = require('../../backup/lib/confine-sql');
    const method = mysql ? 'confineMySql' : 'confinePostgres';
    const original = confini[method];
    confini[method] = (type, boundary) => {
      const result = original(type, boundary);
      if (scenario.mutant === 'locale' && /timestamp/.test(type) && !/with time zone/.test(type)) {
        report.mutazioni++;
        return { operator: '>', expression: '$1', parameter: new Date(boundary) };
      }
      if (scenario.mutant === 'giorno' && type === 'date') {
        report.mutazioni++;
        return { ...result, operator: '>' };
      }
      return result;
    };
  }
  // La fixture attraversa anche il prossimo cambio DST: il suo confine può
  // trovarsi nel futuro rispetto al giorno di esecuzione. L'orologio del solo
  // writer segue il layer della prova, senza alterare Date globale, driver,
  // timeout o la funzione temporale che stiamo verificando.
  let backupClock = null;
  const RealDate = Date;
  class WriterDate extends RealDate {
    constructor(...args) { super(...(!args.length && backupClock != null ? [backupClock] : args)); }
  }
  const Module = require('node:module'), enginePath = require.resolve('../../backup/lib/engine');
  const isolatedEngine = new Module(enginePath, module);
  isolatedEngine.filename = enginePath; isolatedEngine.paths = Module._nodeModulePaths(path.dirname(enginePath));
  isolatedEngine.require = name => name === './__clock_fixture' ? WriterDate : Module.prototype.require.call(isolatedEngine, name);
  isolatedEngine._compile('"use strict";\nconst Date = require("./__clock_fixture");\n' + fs.readFileSync(enginePath, 'utf8'), enginePath);
  const { runBackup } = isolatedEngine.exports;
  const specs = mysql ? [{ name: 'dt6', type: 'DATETIME(6)' }, { name: 'giorni', type: 'DATE', giorno: true }]
    : [{ name: 'ts0', type: 'TIMESTAMP(0)', secondi: true }, { name: 'ts6', type: 'TIMESTAMP(6)' },
      { name: 'tz6', type: 'TIMESTAMPTZ(6)', zonato: true }, { name: 'giorni', type: 'DATE', giorno: true }];
  const selezionati = scenario.focus ? specs.filter(s => s.name === scenario.focus) : specs;
  const query = async (sql, params = []) => mysql ? (await native.query(sql, params))[0] : (await native.query(sql, params)).rows;
  async function check(id, fn) {
    try { const dettagli = await fn(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${scenario.id}/${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${scenario.id}/${id}: ${error.message}`); return false; }
  }
  const snapshot = async (spec, where = '', db = schema) => query(mysql
    ? `SELECT CAST(id AS CHAR) id,testo,CAST(updated_at AS CHAR) updated_at FROM ${tab(spec.name, db)} ${where} ORDER BY id+0`
    : `SELECT id::text,testo,updated_at::text FROM ${tab(spec.name, db)} ${where} ORDER BY id::int`);
  function condizione(spec, cutoff) {
    const value = iso(cutoff);
    if (spec.giorno) return `WHERE updated_at >= '${value.slice(0, 10)}'`;
    if (mysql) return `WHERE updated_at > '${value.replace('T', ' ').slice(0, -1)}'`;
    return `WHERE updated_at > ${spec.zonato ? 'TIMESTAMPTZ' : 'TIMESTAMP'} '${value}'`;
  }
  async function inserisci(spec, id, text, value) {
    const values = [id, text, spec.zonato ? value : value.replace('T', ' ').replace(/Z$/, '')];
    await query(`INSERT INTO ${tab(spec.name)} (id,testo,updated_at) VALUES (${mysql ? '?,?,?' : '$1,$2,$3'})`, values);
  }
  async function archive(type, baseTime) {
    backupClock = baseTime == null ? null : baseTime + 1;
    const result = await runBackup({ session: { strategy, dbType: scenario.motore }, connName: scenario.id, db: schema,
      type, sinceField: 'updated_at', onlyCollections: selezionati.map(s => s.name), destRoot: artifacts, compress: true, log: silenzioso });
    const verified = await verifyBackupDir(result.backupDir);
    assert.equal(verified.failedCount, 0, JSON.stringify(verified));
    return result;
  }
  function stamp(result, value) {
    // Solo gli artefatti posseduti dalla fixture: non si falsifica l'orologio globale.
    const file = path.join(result.backupDir, 'manifest.json');
    const manifest = readManifest(result.backupDir);
    manifest.startedAt = value; manifest.endedAt = iso(millis(value) + 1);
    if (scenario.legacy) delete manifest.coerenza;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    const catalogFile = path.join(path.dirname(result.backupDir), 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    Object.assign(catalog.backups.find(b => b.id === result.id), { startedAt: manifest.startedAt, endedAt: manifest.endedAt });
    fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
  }
  async function controllaLayer(result, cutoff, label, baseId) {
    const manifest = readManifest(result.backupDir);
    assert.equal(manifest.baseId, baseId, 'La catena deve scegliere la base corretta');
    for (const spec of selezionati) await check(`${label}-${spec.name}`, async () => {
      const file = manifest.files.find(f => f.kind === 'data' && f.collection === spec.name);
      assert(file, 'File dati assente');
      assert.equal(file.mode, 'incremental', 'Il caso non deve passare grazie a un dump completo');
      const rows = [];
      for await (const line of readLines(fileDelBackup(result.backupDir, file.path))) {
        const row = parseRiga(line); rows.push({ id: String(row.id), testo: row.testo, updated_at: row.updated_at });
      }
      rows.sort((a, b) => Number(a.id) - Number(b.id));
      const expected = (await snapshot(spec, condizione(spec, cutoff))).map(r => ({ ...r }));
      assert(expected.length > 0, 'L’oracolo deve contenere righe');
      assert.equal(file.count, rows.length);
      assert.deepEqual(rows, expected, `Confine ${iso(cutoff)}; nessuna riga o frazione temporale può andare persa`);
      return { cutoff: iso(cutoff), tipo: spec.type, ids: rows.map(r => r.id), sha256: hash(JSON.stringify(rows)), file: file.path };
    });
  }
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    assert.equal(process.env.TZ, scenario.tz, 'Il fuso deve essere impostato prima di avviare il processo');
    process.env.CODEDB_BACKUP_MARGINE_MS = String(scenario.margine);
    registry.assertOwned(schema);
    if (mysql) {
      const driver = require('mysql2/promise');
      const config = { host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), user: 'root', password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql', dateStrings: true };
      native = await driver.createConnection(config);
      strategy = new (require('../../db/MySqlStrategy'))();
      strategy.pool = driver.createPool({ ...config, connectionLimit: 3 });
      const get = strategy.pool.getConnection.bind(strategy.pool);
      strategy.pool.getConnection = async () => { const c = await get(); await c.query('SET SESSION time_zone=?', [scenario.zonaDb]); return c; };
      await query("SET SESSION time_zone='+00:00'");
      report.versione = (await query('SELECT VERSION() versione'))[0].versione;
      await query(`CREATE DATABASE ${quota(schema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    } else {
      const { Client, Pool } = require('pg');
      const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres', connectionTimeoutMillis: 6000 };
      native = new Client(config); await native.connect(); await query("SET TIME ZONE 'UTC'");
      report.versione = (await query('SHOW server_version'))[0].server_version;
      strategy = new (require('../../db/PostgreSqlStrategy'))();
      strategy.pool = new Pool({ ...config, max: 3, options: `-c timezone=${scenario.zonaDb}` });
      await query(`CREATE SCHEMA ${quota(schema)}`);
    }
    for (const spec of selezionati) await query(`CREATE TABLE ${tab(spec.name)} (id INT PRIMARY KEY,testo TEXT,updated_at ${spec.type} NOT NULL)`);
    if (scenario.smoke) {
      for (const spec of selezionati) await inserisci(spec, 1, 'prima', spec.giorno ? '2020-01-01' : '2020-01-01T00:00:00.000Z');
      const full = await archive('full');
      const since = millis(readManifest(full.backupDir).startedAt);
      for (const spec of selezionati) await query(`INSERT INTO ${tab(spec.name)} VALUES (2,'dopo',CURRENT_TIMESTAMP)`);
      const inc = await archive('incremental', since);
      await controllaLayer(inc, since - scenario.margine, 'smoke', full.id);
    } else {
      const t = millis(scenario.istante), cutoff = t - scenario.margine;
      for (const spec of selezionati) {
        let times;
        if (spec.giorno) { const day = millis(iso(cutoff).slice(0, 10)); times = [-1, 0, 1].map(d => iso(day + d * 86400000).slice(0, 10)); }
        else if (spec.secondi) times = [-1, 0, 1].map(s => iso(Math.floor(cutoff / 1000) * 1000 + s * 1000));
        else times = [-1n, 0n, 1n, 999n, 1000n].map(us => micros(BigInt(cutoff) * 1000n + us));
        for (let i = 0; i < times.length; i++) await inserisci(spec, i + 1, 'prima', times[i]);
      }
      const full = await archive('full'); stamp(full, scenario.istante);
      for (const spec of selezionati) {
        await query(`UPDATE ${tab(spec.name)} SET testo='aggiornato' ${condizione(spec, cutoff)}`);
        await inserisci(spec, 99, 'nuovo', spec.giorno ? iso(cutoff).slice(0, 10)
          : spec.secondi ? iso(t + 1000) : micros(BigInt(t) * 1000n + 1n));
      }
      const inc = await archive('incremental', t); stamp(inc, iso(t + 10000));
      await controllaLayer(inc, cutoff, 'incremental', full.id);
      for (const spec of selezionati) await inserisci(spec, 100, 'nuovo-secondo', spec.giorno ? iso(t + 10000).slice(0, 10)
        : spec.secondi ? iso(t + 11000) : micros(BigInt(t + 10000) * 1000n + 1n));
      const inc2 = await archive('incremental', t + 10000); stamp(inc2, iso(t + 20000));
      await controllaLayer(inc2, t + 10000 - scenario.margine, 'incremental2', inc.id);
      const diff = await archive('differential', t); stamp(diff, iso(t + 30000));
      await controllaLayer(diff, cutoff, 'differential', full.id);
      // Una sola fixture semplice prova anche il restore, senza moltiplicare i DDL.
      if (scenario.id === 'pg-utc-dbutc' && report.verifiche.every(v => v.ok)) await check('restore-semplice', async () => {
        const target = registry.target('copia'); registry.assertOwned(target);
        await require('../../backup/lib/restore').runRestore({ session: { strategy, dbType: scenario.motore }, backupDir: diff.backupDir, targetDb: target, drop: true, log: silenzioso });
        for (const spec of selezionati) assert.deepEqual(await snapshot(spec, '', target), await snapshot(spec));
        return { target, layer: diff.id };
      });
    }
    if (!mysql) await check('sessione-ripristinata', async () => {
      const settings = await strategy.pool.query('SHOW TimeZone');
      assert.equal(settings.rows[0].TimeZone, scenario.zonaDb);
      return { zonaIniziale: scenario.zonaDb, zonaFinale: settings.rows[0].TimeZone };
    });
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    if (native) {
      try {
        // Il restore può lasciare uno staging: lo si elimina solo se derivato da un bersaglio posseduto.
        if (!mysql) {
          const names = await query('SELECT schema_name FROM information_schema.schemata');
          for (const { schema_name: name } of names) {
            const owner = registry.targets().find(base => name.startsWith(`${base}__codedb_`) && /__codedb_(staging|recovery)_[a-f0-9]{10}$/.test(name));
            if (owner) { registry.assertOwned(owner); await query(`DROP SCHEMA ${quota(name)} CASCADE`); }
          }
        }
        await registry.cleanup(name => query(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${quota(name)}${mysql ? '' : ' CASCADE'}`));
        report.pulizia = 'completata';
      } catch (error) { report.errorePulizia = error.stack; }
      await native.end().catch(error => { report.erroreChiusura = error.message; });
    }
    if (strategy?.pool) await strategy.pool.end().catch(error => { report.erroreChiusura = error.message; });
    report.terminato = new Date().toISOString();
    report.ok = !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.verifiche.length > 0 && report.verifiche.every(v => v.ok);
    fs.writeFileSync(path.join(reportDir, 'backup-tempi.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

async function child(scenario) {
  const dir = path.join(reportDir, scenario.id); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-tempi.json'); fs.rmSync(file, { force: true });
  const log = fs.createWriteStream(path.join(dir, 'console.log'));
  const started = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, '--worker'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TZ: scenario.tz, LAB_REPORT_DIR: dir, LAB_BACKUP_TEMPI_SCENARIO: JSON.stringify(scenario) } });
    const timeout = setTimeout(() => proc.kill(), 180000);
    inoltraOutputFiglio(proc, { log, mutante: scenario.mutant ? scenario.id : null });
    proc.once('error', error => { clearTimeout(timeout); reject(error); });
    proc.once('close', code => { clearTimeout(timeout); resolve(code); });
  }).finally(() => new Promise(resolve => log.end(resolve)));
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { erroreFatale: 'Rapporto figlio assente', ok: false };
  return { scenario: scenario.id, exitCode, ms: Date.now() - started, report: file, ...result };
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
  fs.mkdirSync(reportDir, { recursive: true });
  const selected = scenari().filter(s => !process.env.LAB_BACKUP_TEMPI_CASE || s.id.includes(process.env.LAB_BACKUP_TEMPI_CASE));
  assert(selected.length, 'Nessuno scenario selezionato');
  const report = { suite: 'backup-tempi', iniziato: new Date().toISOString(), risultati: [], sensibilita: [] };
  const save = () => fs.writeFileSync(path.join(reportDir, 'backup-tempi.json'), JSON.stringify(report, null, 2));
  for (const scenario of selected) { report.risultati.push(await child(scenario)); save(); }
  if (process.argv.includes('--sensitivity')) for (const [mutant, focus, cause, motore] of [
    ['locale', 'ts6', 'fuso-locale', 'postgresql'], ['giorno', 'giorni', 'giorno-escluso-pg', 'postgresql'],
    ['giorno', 'giorni', 'giorno-escluso-mysql', 'mysql'],
  ]) {
    const result = await child({ id: `mutante-${cause}`, motore, tz: 'Europe/Rome', zonaDb: motore === 'mysql' ? '+00:00' : 'UTC', istante: '2026-07-15T12:34:56.123Z', margine: 2000, mutant, focus });
    const failures = (result.verifiche || []).filter(v => !v.ok);
    const expected = ['incremental', 'incremental2', 'differential'].map(layer => `${layer}-${focus}`).sort();
    const detected = result.exitCode === 1 && result.mutazioni > 0 && !result.erroreFatale && !result.errorePulizia && !result.erroreChiusura
      && JSON.stringify(failures.map(v => v.id).sort()) === JSON.stringify(expected) && result.pulizia === 'completata';
    report.sensibilita.push({ causa: cause, rilevata: detected, risultato: result }); save();
  }
  report.ok = report.risultati.every(r => r.ok && r.exitCode === 0) && report.sensibilita.every(r => r.rilevata);
  report.totali = { scenari: report.risultati.length, verifiche: report.risultati.reduce((n, r) => n + (r.verifiche || []).length, 0),
    fallite: report.risultati.reduce((n, r) => n + (r.verifiche || []).filter(v => !v.ok).length, 0) };
  report.terminato = new Date().toISOString(); save();
  if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(JSON.parse(process.env.LAB_BACKUP_TEMPI_SCENARIO)) : main())
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
