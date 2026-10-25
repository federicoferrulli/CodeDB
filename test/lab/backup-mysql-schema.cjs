'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// LAB007: oracoli nativi per FK, charset e collation. Il controllo positivo
// percorre il piano pubblico; le divergenze vengono create in DB usa e getta.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-mysql-schema.cjs [--sensitivity]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { readManifest, verifyBackupDir } = require('../../backup/lib/util');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-007/mysql-schema');
const hash = value => createHash('sha256').update(value).digest('hex');
const q = value => '`' + value.replaceAll('`', '``') + '`';
const table = (db, name) => `${q(db)}.${q(name)}`;
const log = { info() {}, warn() {}, error() {} };
const asPlain = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('utf8') : value])));

async function worker(mutant) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-mysql-schema', mutante: mutant, mutazioni: 0, verifiche: [], ripristini: [],
    sorgenti: {}, iniziato: new Date().toISOString() };
  for (const file of ['db/MySqlStrategy.js', 'db/mysql-ddl.js', 'db/backupRestoreAdapter.js', 'backup/lib/engine.js',
    'backup/lib/restore.js', 'backup/lib/schema-snapshot.js', 'test/lab/backup-mysql-schema.cjs']) report.sorgenti[file] = hash(fs.readFileSync(path.resolve(__dirname, '../..', file)));
  const { runBackup } = require('../../backup/lib/engine');
  const { descriviBackup, createBackupRestoreAdapter, runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
  const { creaPianoRestore } = require('../../db/importPlan');
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_ms' });
  let native, strategy;
  const query = async (sql, params = []) => (await native.query(sql, params))[0];
  const check = async (id, run) => {
    try { const dettagli = await run(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK mysql-schema/${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL mysql-schema/${id}: ${error.message}`); return false; }
  };
  async function catalogo(db) {
    const tables = asPlain(await query(`SELECT TABLE_NAME AS tabella,TABLE_TYPE AS tipo,TABLE_COLLATION AS collation
      FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME`, [db]));
    const columns = asPlain(await query(`SELECT TABLE_NAME AS tabella,COLUMN_NAME AS colonna,ORDINAL_POSITION AS posizione,
      COLUMN_TYPE AS tipo,IS_NULLABLE AS annullabile,COLUMN_DEFAULT AS valoreDefault,EXTRA AS extra,
      CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION`, [db]));
    const foreignKeys = asPlain(await query(`SELECT k.TABLE_NAME AS tabella,k.CONSTRAINT_NAME AS nome,k.COLUMN_NAME AS colonna,
      k.ORDINAL_POSITION AS posizione,k.REFERENCED_TABLE_SCHEMA=k.TABLE_SCHEMA AS schemaLocale,
      k.REFERENCED_TABLE_NAME AS tabellaReferenziata,k.REFERENCED_COLUMN_NAME AS colonnaReferenziata,
      r.DELETE_RULE AS onDelete,r.UPDATE_RULE AS onUpdate
      FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
      WHERE k.TABLE_SCHEMA=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`, [db]));
    return { tables, columns, foreignKeys };
  }
  async function dati(db) {
    const names = (await catalogo(db)).tables.map(item => item.tabella), result = {};
    for (const name of names) result[name] = asPlain(await query(`SELECT * FROM ${table(db, name)} ORDER BY id`));
    return result;
  }
  async function prepara(db, { fk, charset }) {
    await query(`CREATE DATABASE ${q(db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    if (fk) {
      await query(`CREATE TABLE ${table(db, 'z_padri')} (id INT PRIMARY KEY,codice INT NOT NULL UNIQUE) ENGINE=InnoDB`);
      await query(`CREATE TABLE ${table(db, 'a_figli')} (id INT PRIMARY KEY,padre_id INT NULL,codice_padre INT NULL,
        KEY padre_id(padre_id),KEY codice_padre(codice_padre),
        CONSTRAINT fk_padre FOREIGN KEY(padre_id) REFERENCES ${table(db, 'z_padri')}(id) ON DELETE CASCADE ON UPDATE RESTRICT,
        CONSTRAINT fk_codice FOREIGN KEY(codice_padre) REFERENCES ${table(db, 'z_padri')}(codice) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB`);
      await query(`INSERT INTO ${table(db, 'z_padri')} VALUES (1,10)`);
      await query(`INSERT INTO ${table(db, 'a_figli')} VALUES (1,1,NULL),(2,NULL,10)`);
    }
    if (charset) {
      await query(`CREATE TABLE ${table(db, 'testi')} (id INT PRIMARY KEY,nome VARCHAR(80) COLLATE utf8mb4_bin,
        nota VARCHAR(120) DEFAULT 'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
      await query(`INSERT INTO ${table(db, 'testi')} (id,nome) VALUES (1,'caffè'),(2,'CAFFE')`);
    }
  }
  async function provaVincoli(db) {
    const before = await dati(db);
    await native.beginTransaction();
    try {
      await assert.rejects(query(`INSERT INTO ${table(db, 'a_figli')} VALUES (90,999,NULL)`), error => error.errno === 1452,
        '[MYSQL-FK-ENFORCE] il riferimento orfano deve essere rifiutato');
      await assert.rejects(query(`UPDATE ${table(db, 'z_padri')} SET id=2 WHERE id=1`), error => error.errno === 1451,
        '[MYSQL-FK-ENFORCE] ON UPDATE RESTRICT deve proteggere la chiave referenziata');
      await query(`UPDATE ${table(db, 'z_padri')} SET codice=110 WHERE id=1`);
      assert.deepEqual(asPlain(await query(`SELECT id,padre_id,codice_padre FROM ${table(db, 'a_figli')} ORDER BY id`)),
        [{ id: 1, padre_id: 1, codice_padre: null }, { id: 2, padre_id: null, codice_padre: 110 }], '[MYSQL-FK-ENFORCE] ON UPDATE CASCADE');
      await query(`DELETE FROM ${table(db, 'z_padri')} WHERE id=1`);
      assert.deepEqual(asPlain(await query(`SELECT id,padre_id,codice_padre FROM ${table(db, 'a_figli')} ORDER BY id`)),
        [{ id: 2, padre_id: null, codice_padre: null }], '[MYSQL-FK-ENFORCE] ON DELETE CASCADE e SET NULL');
    } finally { await native.rollback(); }
    assert.deepEqual(await dati(db), before, 'La transazione di prova deve ripristinare tutte le righe');
    return { orfaniRifiutati: true, updateRestrict: true, updateCascade: true, deleteCascade: true, deleteSetNull: true };
  }
  async function provaCollation(db) {
    const rows = asPlain(await query(`SELECT id FROM ${table(db, 'testi')} WHERE nome='CAFFE' ORDER BY id`));
    assert.deepEqual(rows, [{ id: 2 }], '[MYSQL-COLLATION-ENFORCE] utf8mb4_bin distingue accenti e maiuscole');
    return rows;
  }
  function lettoreMutato() {
    const proxy = Object.create(strategy), cache = new Map();
    const method = mutant === 'fk-cache' ? 'tableAuxDdl' : mutant === 'charset-cache' ? 'tableDdl' : null;
    if (method) proxy[method] = async (db, name) => {
      const key = `${db}/${name}`;
      if (cache.has(key)) { report.mutazioni++; return cache.get(key); }
      const result = await strategy[method](db, name); cache.set(key, result); return result;
    };
    return proxy;
  }
  function legacyInline(backup, source) {
    const dest = path.join(reportDir, 'legacy-inline', path.basename(backup)); fs.cpSync(backup, dest, { recursive: true });
    const manifest = readManifest(dest), objectFile = manifest.files.find(file => file.kind === 'objects');
    const objects = JSON.parse(fs.readFileSync(path.join(dest, objectFile.path), 'utf8'));
    const update = (file, contents) => {
      fs.writeFileSync(path.join(dest, file.path), contents); const bytes = fs.readFileSync(path.join(dest, file.path));
      file.bytes = bytes.length; file.sha256 = hash(bytes);
    };
    const ddl = source.showCreate.a_figli;
    update(manifest.files.find(file => file.kind === 'schema' && file.collection === 'a_figli'), ddl + ';\n');
    objects.foreignKeys = []; update(objectFile, JSON.stringify(objects));
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2)); return dest;
  }
  function charsetImplicito(backup) {
    // La forma senza CHARACTER SET è DDL MySQL valida ed equivalente; vecchi
    // esportatori/cataloghi possono scriverla così. Il COLLATE resta esplicito.
    const manifest = readManifest(backup), file = manifest.files.find(item => item.kind === 'schema' && item.collection === 'testi');
    const absolute = path.join(backup, file.path), original = fs.readFileSync(absolute, 'utf8');
    const updated = original.replace('`nome` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', '`nome` varchar(80) COLLATE utf8mb4_bin');
    assert.notEqual(updated, original, 'La fixture deve omettere esattamente il charset ridondante della colonna nome');
    fs.writeFileSync(absolute, updated); const bytes = fs.readFileSync(absolute); file.bytes = bytes.length; file.sha256 = hash(bytes);
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    const mysql = require('mysql2/promise');
    const config = { host: process.env.LAB_MYSQL_HOST || '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306),
      user: 'root', password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql', timezone: 'Z' };
    native = await mysql.createConnection(config); strategy = new (require('../../db/MySqlStrategy'))();
    strategy.pool = mysql.createPool({ ...config, connectionLimit: 3 });
    const scenarios = [{ name: 'fk', fk: true }, { name: 'charset', charset: true }, { name: 'insieme', fk: true, charset: true }];
    const archives = [];
    for (const [index, scenario] of scenarios.entries()) {
      const source = registry.target(`s${index}`), target = registry.target(`d${index}`);
      await prepara(source, scenario);
      const expected = { schema: await catalogo(source), dati: await dati(source), showCreate: {} };
      for (const item of expected.schema.tables) expected.showCreate[item.tabella] = (await query(`SHOW CREATE TABLE ${table(source, item.tabella)}`))[0]['Create Table'];
      await check(`${scenario.name}-oracolo-sorgente`, async () => {
        assert.equal(expected.schema.foreignKeys.length, scenario.fk ? 2 : 0);
        if (scenario.fk) await provaVincoli(source);
        if (scenario.charset) await provaCollation(source);
        return expected;
      });
      const backup = await runBackup({ session: { strategy, dbType: 'mysql' }, connName: 'mysql-schema', db: source,
        type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: false, log });
      if (scenario.charset) charsetImplicito(backup.backupDir);
      archives.push({ ...scenario, backupDir: backup.backupDir, expected });
      await check(`${scenario.name}-archivio`, async () => {
        const manifest = readManifest(backup.backupDir); assert.equal((await verifyBackupDir(backup.backupDir)).valid, true);
        const objects = JSON.parse(fs.readFileSync(path.join(backup.backupDir, manifest.files.find(file => file.kind === 'objects').path), 'utf8'));
        assert.equal(objects.foreignKeys.length, scenario.fk ? 2 : 0);
        for (const file of manifest.files.filter(file => file.kind === 'schema')) assert.doesNotMatch(fs.readFileSync(path.join(backup.backupDir, file.path), 'utf8'), /FOREIGN KEY/);
        return { manifest, objects };
      });
      const completed = await check(`${scenario.name}-piano`, async () => {
        const result = await runRestoreViaPlan({ session: { strategy, dbType: 'mysql' }, backupDir: backup.backupDir,
          targetDb: target, drop: true, connName: 'mysql-schema', recoveryRoot: path.join(reportDir, 'recuperi'), log });
        report.ripristini.push({ scenario: scenario.name, ...result });
        assert.equal(result.status, 'completato', `[MYSQL-SCHEMA-PIANO] ${JSON.stringify(result)}`);
        assert.equal(result.verification.ok, true); assert.equal(result.verification.schemaObjects, true);
        assert.equal(result.totalDocs, Object.values(expected.dati).reduce((n, rows) => n + rows.length, 0));
        return result;
      });
      if (completed) await check(`${scenario.name}-oracolo-destinazione`, async () => {
        assert.deepEqual(await catalogo(target), expected.schema, '[MYSQL-SCHEMA-NATIVO] il catalogo deve coincidere esattamente');
        assert.deepEqual(await dati(target), expected.dati, '[MYSQL-SCHEMA-NATIVO] tutte le righe devono coincidere');
        if (scenario.fk) await provaVincoli(target);
        if (scenario.charset) await provaCollation(target);
        return { schema: await catalogo(target), dati: await dati(target) };
      });
      else (report.nonEseguiti ||= []).push({ id: `${scenario.name}-oracolo-destinazione`, motivo: 'Il piano non ha completato il ripristino.' });
    }
    const combined = archives.find(item => item.name === 'insieme');
    let legacyBackupDir;
    await check('legacy-inline', async () => {
      const backupDir = legacyBackupDir = legacyInline(combined.backupDir, combined.expected);
      assert.equal((await verifyBackupDir(backupDir)).valid, true);
      const target = registry.target('legacy');
      const result = await runRestoreViaPlan({ session: { strategy, dbType: 'mysql' }, backupDir, targetDb: target,
        drop: true, connName: 'mysql-schema', recoveryRoot: path.join(reportDir, 'recuperi'), log });
      report.ripristini.push({ scenario: 'legacy-inline', ...result });
      assert.equal(result.status, 'completato', `[MYSQL-SCHEMA-LEGACY] ${JSON.stringify(result)}`);
      assert.deepEqual(await catalogo(target), combined.expected.schema);
      assert.deepEqual(await dati(target), combined.expected.dati); await provaVincoli(target); await provaCollation(target);
      return result;
    });
    await check('legacy-inline-merge', async () => {
      assert(legacyBackupDir, 'L’archivio legacy deve essere stato preparato');
      const target = registry.target('legacy_merge');
      await prepara(target, { fk: true, charset: true });
      await query(`DELETE FROM ${table(target, 'a_figli')}`);
      await query(`DELETE FROM ${table(target, 'z_padri')}`);
      await query(`INSERT INTO ${table(target, 'z_padri')} VALUES (90,900)`);
      await query(`INSERT INTO ${table(target, 'a_figli')} VALUES (90,90,NULL)`);
      const expected = JSON.parse(JSON.stringify(combined.expected.dati));
      expected.z_padri.push({ id: 90, codice: 900 });
      expected.a_figli.push({ id: 90, padre_id: 90, codice_padre: null });
      // Le figlie sono caricate prima dei padri. Le FK già presenti nella
      // copia di destinazione devono essere differite anche con DDL legacy.
      const result = await runRestoreViaPlan({ session: { strategy, dbType: 'mysql' }, backupDir: legacyBackupDir,
        targetDb: target, drop: false, connName: 'mysql-schema', recoveryRoot: path.join(reportDir, 'recuperi'), log });
      report.ripristini.push({ scenario: 'legacy-inline-merge', ...result });
      assert.equal(result.status, 'completato', `[MYSQL-SCHEMA-LEGACY-MERGE] ${JSON.stringify(result)}`);
      assert.deepEqual(await catalogo(target), combined.expected.schema);
      assert.deepEqual(await dati(target), expected, 'Il merge deve aggiungere la sorgente e conservare le righe locali');
      await assert.rejects(query(`INSERT INTO ${table(target, 'a_figli')} VALUES (999,999,NULL)`), error => error.errno === 1452,
        'Dopo il caricamento il vincolo deve essere nuovamente attivo');
      return { result, ordineFigliePrimaDeiPadri: true, righeLocaliConservate: true };
    });
    await check('selettivo-diretto-fk', async () => {
      const target = registry.target('selettivo');
      await prepara(target, { fk: true, charset: true });
      await query(`INSERT INTO ${table(target, 'a_figli')} VALUES (90,1,NULL)`);
      const before = await dati(target);
      // Il gate selettivo pubblico è coperto separatamente da AUD014. Qui si
      // misura il ramo del motore che differisce e riapplica le sole FK scelte.
      const result = await require('../../backup/lib/restore').runRestore({ session: { strategy, dbType: 'mysql' },
        backupDir: combined.backupDir, targetDb: target, onlyCollections: ['a_figli'], drop: true, log });
      report.ripristini.push({ scenario: 'selettivo-diretto-fk', ...result });
      assert.equal(result.totalDocs, combined.expected.dati.a_figli.length);
      const after = await dati(target);
      assert.deepEqual(after.a_figli, combined.expected.dati.a_figli, 'Solo le righe della figlia selezionata vengono sostituite');
      assert.deepEqual(after.z_padri, before.z_padri); assert.deepEqual(after.testi, before.testi);
      assert.deepEqual(await catalogo(target), combined.expected.schema, 'Entrambe le FK selezionate devono tornare nel catalogo');
      await provaVincoli(target);
      return { result, vincoliNativiAttivi: true, padreNonSelezionatoPreservato: true };
    });
    const faults = [
      { name: 'fk-mancante', fk: true, mutate: db => query(`ALTER TABLE ${table(db, 'a_figli')} DROP FOREIGN KEY fk_padre`) },
      { name: 'fk-on-delete', fk: true, mutate: async db => {
        await query(`ALTER TABLE ${table(db, 'a_figli')} DROP FOREIGN KEY fk_padre`);
        await query(`ALTER TABLE ${table(db, 'a_figli')} ADD CONSTRAINT fk_padre FOREIGN KEY(padre_id) REFERENCES ${table(db, 'z_padri')}(id) ON DELETE RESTRICT ON UPDATE RESTRICT`);
      } },
      { name: 'collation-diversa', mutate: db => query(`ALTER TABLE ${table(db, 'testi')} MODIFY nome VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL`) },
      { name: 'charset-diverso', mutate: db => query(`ALTER TABLE ${table(db, 'testi')} MODIFY nome VARCHAR(80) CHARACTER SET latin1 COLLATE latin1_bin NULL`) },
    ];
    for (const [index, fault] of faults.entries()) await check(`rifiuto-${fault.name}`, async () => {
      const target = registry.target(`n${index}`), source = descriviBackup(combined.backupDir);
      const plan = creaPianoRestore({ source, expectedDbType: 'mysql', connection: 'mysql-schema', targetDb: target, drop: true });
      const adapter = createBackupRestoreAdapter({ strategy: lettoreMutato(), dbType: 'mysql', connName: 'mysql-schema',
        recoveryRoot: path.join(reportDir, 'recuperi'), log });
      await adapter.validatePlan(plan); await adapter.apply(plan, { db: target });
      const before = await adapter.verify(plan, 'staging', { db: target });
      assert.equal(before.ok, true, `[MYSQL-SCHEMA-PRECONDIZIONE] Prima della mutazione lo schema deve essere corretto: ${JSON.stringify(before.schemaDifferences)}`);
      const nativeBefore = await catalogo(target), dataBefore = await dati(target);
      await fault.mutate(target);
      const nativeAfter = await catalogo(target);
      assert.notDeepEqual(nativeAfter, nativeBefore, '[MYSQL-SCHEMA-ORACOLO] il DBMS conferma una differenza reale');
      assert.deepEqual(await dati(target), dataBefore, '[MYSQL-SCHEMA-ORACOLO] la mutazione cambia solo lo schema');
      if (fault.name === 'fk-mancante') {
        assert.deepEqual(nativeAfter.foreignKeys.map(item => item.nome), ['fk_codice']);
        await native.beginTransaction();
        try {
          await query(`INSERT INTO ${table(target, 'a_figli')} VALUES (90,999,NULL)`);
          assert.equal((await query(`SELECT COUNT(*) AS n FROM ${table(target, 'a_figli')} WHERE padre_id=999`))[0].n, 1,
            '[MYSQL-FK-ORACOLO] la rimozione del vincolo permette realmente un orfano');
        } finally { await native.rollback(); }
      } else if (fault.name === 'fk-on-delete') {
        assert.equal(nativeAfter.foreignKeys.find(item => item.nome === 'fk_padre').onDelete, 'RESTRICT');
        await native.beginTransaction();
        try {
          await assert.rejects(query(`DELETE FROM ${table(target, 'z_padri')} WHERE id=1`), error => error.errno === 1451,
            '[MYSQL-FK-ORACOLO] ON DELETE RESTRICT deve rifiutare la cancellazione del padre');
        } finally { await native.rollback(); }
      } else {
        const column = nativeAfter.columns.find(item => item.tabella === 'testi' && item.colonna === 'nome');
        assert.equal(column.charset, fault.name === 'charset-diverso' ? 'latin1' : 'utf8mb4');
        assert.equal(column.collation, fault.name === 'charset-diverso' ? 'latin1_bin' : 'utf8mb4_unicode_ci');
      }
      assert.deepEqual(await dati(target), dataBefore, 'Anche la prova comportamentale deve lasciare i dati intatti');
      const result = await adapter.verify(plan, 'destination', { db: target });
      assert.equal(result.ok, false, `[MYSQL-SCHEMA-DIVERGENZA] ${fault.name}: una differenza nativa non può passare`);
      assert.equal(result.schemaObjects, false); assert.deepEqual(result.missing, []);
      assert.deepEqual(result.snapshot.counts, before.snapshot.counts, 'Il rifiuto deve dipendere dallo schema, non dal numero di righe');
      assert(result.schemaDifferences.some(diff => diff.field === (fault.fk ? 'indexes:__all' : 'table:testi')),
        '[MYSQL-SCHEMA-DIVERGENZA] diagnosi specifica della differenza');
      return { nativeBefore, nativeAfter, verifica: result };
    });
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    try {
      if (native) {
        const databases = await query('SHOW DATABASES');
        for (const item of databases) {
          const name = Object.values(item)[0];
          const owner = registry.targets().find(base => name.startsWith(`${base}__codedb_`) && /__codedb_(staging|recovery)_[a-f0-9]{10}$/.test(name));
          if (owner) { registry.assertOwned(owner); await query(`DROP DATABASE ${q(name)}`); }
        }
        await registry.cleanup(db => query(`DROP DATABASE IF EXISTS ${q(db)}`));
      }
      report.pulizia = 'completata';
    } catch (error) { report.errorePulizia = error.stack; }
    if (strategy?.pool) await strategy.pool.end(); if (native) await native.end();
    report.ok = !report.erroreFatale && !report.errorePulizia && report.verifiche.length === 19 && report.verifiche.every(item => item.ok);
    report.terminato = new Date().toISOString(); fs.writeFileSync(path.join(reportDir, 'backup-mysql-schema.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

async function child(mutant) {
  const dir = path.join(reportDir, mutant ? `mutante-${mutant}` : 'controllo'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-mysql-schema.json'); fs.rmSync(file, { force: true });
  const output = fs.createWriteStream(path.join(dir, 'console.log'));
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, '--worker', ...(mutant ? ['--mutant', mutant] : [])],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_REPORT_DIR: dir } });
    inoltraOutputFiglio(proc, { log: output, mutante: mutant || null });
    proc.once('error', reject); proc.once('close', resolve);
  }).finally(() => new Promise(resolve => output.end(resolve)));
  return { exitCode, report: file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ok: false, erroreFatale: 'Rapporto assente' }) };
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-mysql-schema', controllo: await child(null), sensibilita: [], iniziato: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(reportDir, 'backup-mysql-schema.json'), JSON.stringify(report, null, 2)); save();
  if (process.argv.includes('--sensitivity')) for (const mutant of ['fk-cache', 'charset-cache']) {
    const result = await child(mutant), failures = (result.verifiche || []).filter(item => !item.ok);
    const expected = mutant === 'fk-cache' ? ['rifiuto-fk-mancante', 'rifiuto-fk-on-delete'] : ['rifiuto-collation-diversa', 'rifiuto-charset-diverso'];
    report.sensibilita.push({ mutante: mutant, risultato: result, rilevata: result.exitCode === 1 && result.mutazioni > 0
      && !result.erroreFatale && !result.errorePulizia && !result.erroreChiusura && result.pulizia === 'completata' && failures.length === expected.length
      && failures.every(item => expected.includes(item.id) && item.errore.includes('[MYSQL-SCHEMA-DIVERGENZA]')) }); save();
  }
  report.ok = report.controllo.ok && report.controllo.exitCode === 0 && report.sensibilita.every(item => item.rilevata);
  report.totali = { verifiche: report.controllo.verifiche?.length || 0,
    fallite: (report.controllo.verifiche || []).filter(item => !item.ok).length,
    mutanti: report.sensibilita.length, rilevati: report.sensibilita.filter(item => item.rilevata).length };
  report.terminato = new Date().toISOString(); save(); if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv.includes('--mutant') ? process.argv[process.argv.indexOf('--mutant') + 1] : null) : main())
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
