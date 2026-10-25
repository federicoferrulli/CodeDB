'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// Indici PostgreSQL: archivio moderno/legacy, restore verificato e catene.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-indici.cjs [--sensitivity]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { readManifest, fileDelBackup, verifyBackupDir } = require('../../backup/lib/util');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-004/reali');
const hash = value => createHash('sha256').update(value).digest('hex');
const qid = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const silenzioso = { info() {}, error() {}, warn() {} };
const table = 'Figli "日本語"';
const uniqueIndex = 'univoco É';

async function worker(mutante) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-indici', iniziato: new Date().toISOString(), mutante,
    verifiche: [], ripristini: [], sorgenti: {}, mutazioni: 0 };
  for (const name of ['backup/lib/engine.js', 'backup/lib/restore.js', 'db/backupRestoreAdapter.js']) {
    report.sorgenti[name] = hash(fs.readFileSync(path.resolve(__dirname, '../..', name)));
  }
  if (mutante) {
    // Mutazione del consumer, soltanto nel processo figlio: l'archivio e la
    // verifica degli oggetti restano intatti e devono rilevare gli indici persi.
    const target = require.resolve('../../backup/lib/restore');
    const source = fs.readFileSync(target, 'utf8');
    const seam = 'for (const indice of oggetti.indexes || [])';
    assert.equal(source.split(seam).length, 2, 'Punto di mutazione assente o ambiguo');
    global.__labIndexOmissions = 0;
    const original = require.extensions['.js'];
    const omitted = JSON.stringify(`CREATE INDEX ${qid('indice "quantità"')} `);
    const replacement = `for (const indice of (oggetti.indexes || []).filter(sql => !sql.startsWith(${omitted}) || (global.__labIndexOmissions++, false)))`;
    require.extensions['.js'] = (mod, filename) => filename === target
      ? mod._compile(source.replace(seam, replacement), filename)
      : original(mod, filename);
    try { require(target); } finally { require.extensions['.js'] = original; }
  }
  const { runBackup } = require('../../backup/lib/engine');
  const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_indici' });
  const schema = registry.target('origine');
  const tab = (name = table, db = schema) => `${qid(db)}.${qid(name)}`;
  const artifacts = path.join(reportDir, 'archivi');
  let native, strategy;
  const query = async (sql, params = []) => (await native.query(sql, params)).rows;
  async function check(id, fn) {
    try { const dettagli = await fn(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${id}: ${error.message}`); return false; }
  }
  const dati = db => query(`SELECT id,parent_id,tenant,valore,codice,testo,attivo FROM ${tab(table, db)} ORDER BY id`);
  // Gli elementi di pg_get_indexdef non contengono il nome dello schema della
  // tabella: nessun replace può nascondere la corruzione di un letterale SQL.
  const indici = db => query(`SELECT t.relname AS tabella,i.relname AS nome,x.indisunique AS unico,
    x.indisprimary AS primario,x.indisvalid AS valido,x.indisready AS pronto,am.amname AS metodo,
    x.indnkeyatts AS chiavi,x.indnatts AS attributi,
    ARRAY(SELECT pg_get_indexdef(x.indexrelid,n,true) FROM generate_series(1,x.indnatts) n) AS elementi,
    pg_get_expr(x.indpred,x.indrelid,true) AS predicato
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace ns ON ns.oid=t.relnamespace JOIN pg_am am ON am.oid=i.relam
    WHERE ns.nspname=$1 ORDER BY t.relname,i.relname`, [db]);
  const foreignKeys = db => query(`SELECT c.conname AS nome,t.relname AS tabella,p.relname AS padre,
    pn.nspname=$1 AS padre_locale,c.convalidated AS valido,c.confupdtype,c.confdeltype,
    ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(num,pos)
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num ORDER BY k.pos) AS colonne,
    ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(num,pos)
      JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.num ORDER BY k.pos) AS riferimenti
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
    JOIN pg_class p ON p.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    WHERE ns.nspname=$1 AND c.contype='f' ORDER BY c.conname`, [db]);
  async function archive(type) {
    const result = await runBackup({ session: { strategy, dbType: 'postgresql' }, connName: 'indici', db: schema,
      type, destRoot: artifacts, compress: true, log: silenzioso });
    assert.equal((await verifyBackupDir(result.backupDir)).valid, true, 'Checksum del backup');
    return result;
  }
  function objectsOf(dir) {
    const manifest = readManifest(dir), file = manifest.files.find(f => f.kind === 'objects');
    assert(file, 'Inventario oggetti assente');
    const filename = fileDelBackup(dir, file.path);
    return { manifest, file, filename, objects: JSON.parse(fs.readFileSync(filename, 'utf8')) };
  }
  async function checkArchive(result, id) {
    await check(`${id}-archivio`, async () => {
      const { manifest, objects } = objectsOf(result.backupDir);
      assert.equal(objects.indexes.length, 8, 'Sette indici sul figlio e UNIQUE autonomo referenziato dalla FK');
      assert(objects.indexes.every(sql => /^CREATE (?:UNIQUE )?INDEX\b/i.test(sql)));
      assert.equal(objects.foreignKeys.length, 1);
      assert(objects.foreignKeys.every(sql => /^ALTER TABLE\b[\s\S]*FOREIGN KEY\b/i.test(sql)));
      assert(objects.indexes.some(sql => sql.includes(`${schema}.marker`) && sql.includes(`prefix ${schema}.marker`)));
      assert(objects.indexes.some(sql => sql.includes(`prefix DEFINER=root@local valore ${schema}.marker`)));
      assert.equal(manifest.type, id);
      return { backup: result.backupDir, indici: objects.indexes, foreignKeys: objects.foreignKeys, baseId: manifest.baseId };
    });
  }
  async function vincolo(db, codice, constraint) {
    await query('BEGIN');
    try {
      await assert.rejects(query(`INSERT INTO ${tab(table, db)} (id,parent_id,tenant,valore,codice,testo,attivo)
        VALUES(99999,$1,1,1,$2,'prova',true)`, [codice === '23503' ? 99999 : 1, codice === '23505' ? 'C0042' : 'nuovo']),
      error => error.code === codice && error.constraint === constraint, `Vincolo ${constraint} applicato dal DB`);
    } finally { await query('ROLLBACK'); }
  }
  async function restore(result, label) {
    const destination = registry.target(label);
    const restored = await check(`${label}-restore`, async () => {
      const outcome = await runRestoreViaPlan({ session: { strategy, dbType: 'postgresql' }, backupDir: result.backupDir,
        targetDb: destination, drop: true, connName: 'indici', log: silenzioso, recoveryRoot: path.join(reportDir, 'recovery') });
      report.ripristini.push({ label, ...outcome });
      assert.equal(outcome.status, 'completato', JSON.stringify({ error: outcome.error, verification: outcome.verification }));
      assert.equal(outcome.verification.ok, true);
      assert.equal(outcome.verification.schemaObjects, true);
      return { target: destination, layers: outcome.layers, totalDocs: outcome.totalDocs };
    });
    if (!restored) return;
    await check(`${label}-catalogo-dati`, async () => {
      const actual = await indici(destination), expected = await indici(schema);
      assert.equal(actual.length, 10, 'Otto indici espliciti e due PK');
      assert(actual.every(i => i.valido && i.pronto));
      assert.deepEqual(actual, expected, 'Definizioni native, inclusi letterali, collation e INCLUDE');
      assert.deepEqual(await foreignKeys(destination), await foreignKeys(schema), 'FK verso lo schema ripristinato');
      assert.deepEqual(await dati(destination), await dati(schema));
      assert.deepEqual(await query(`SELECT * FROM ${tab('Padri', destination)}`), await query(`SELECT * FROM ${tab('Padri')}`));
      return { indici: actual, foreignKeys: await foreignKeys(destination), righe: (await dati(destination)).length };
    });
    await check(`${label}-vincoli-piano`, async () => {
      await vincolo(destination, '23505', uniqueIndex);
      await vincolo(destination, '23503', 'fk padre reale');
      await query(`ANALYZE ${tab(table, destination)}`);
      let explain;
      await query('BEGIN');
      try {
        await query('SET LOCAL enable_seqscan=off');
        explain = (await query(`EXPLAIN (FORMAT JSON) SELECT id FROM ${tab(table, destination)} WHERE codice='C0042'`))[0]['QUERY PLAN'][0].Plan;
      } finally { await query('ROLLBACK'); }
      const names = [], walk = node => { if (node['Index Name']) names.push(node['Index Name']); for (const child of node.Plans || []) walk(child); };
      walk(explain);
      assert(names.includes(uniqueIndex), 'La ricerca univoca deve usare l’indice ricreato');
      return { vincoli: ['23505', '23503'], piano: explain };
    });
  }
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
    const { Client, Pool } = require('pg');
    const config = { host: process.env.LAB_PG_HOST || '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432),
      user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres', connectionTimeoutMillis: 6000 };
    native = new Client(config); await native.connect();
    strategy = new (require('../../db/PostgreSqlStrategy'))();
    strategy.pool = new Pool({ ...config, max: 3, options: '-c timezone=UTC' });
    await query(`CREATE SCHEMA ${qid(schema)}`);
    await query(`CREATE TABLE ${tab('Padri')}(id integer PRIMARY KEY, codice integer NOT NULL, nome text NOT NULL)`);
    await query(`CREATE UNIQUE INDEX ${qid('padre codice unico')} ON ${tab('Padri')}(codice)`);
    await query(`CREATE TABLE ${tab()}(id integer PRIMARY KEY,parent_id integer NOT NULL,tenant integer NOT NULL,
      valore integer NOT NULL,codice text NOT NULL,testo text NOT NULL,attivo boolean NOT NULL,
      CONSTRAINT ${qid('fk padre reale')} FOREIGN KEY(parent_id) REFERENCES ${tab('Padri')}(codice) ON UPDATE CASCADE)`);
    await query(`INSERT INTO ${tab('Padri')} VALUES(1,1,'genitore')`);
    await query(`INSERT INTO ${tab()} SELECT n,1,n%5,n,'C'||lpad(n::text,4,'0'),'Testo '||n,n%2=0 FROM generate_series(1,200) n`);
    for (const [name, definition, unique] of [
      ['indice "quantità"', '(valore DESC NULLS LAST)'], [uniqueIndex, '(codice)', true],
      ['parziale valido', '(valore) WHERE attivo AND valore > 10'], ['espressione', '(lower(testo))'],
      ['copertura', '(tenant,valore) INCLUDE(testo)'], ['collazione', '(testo COLLATE "C")'],
      ['letterale 名', `((testo || ${literal(`${schema}.marker`)} || ${literal(`"${schema}".marker`)})) WHERE testo <> ${literal(`prefix ${schema}.marker`)} AND testo <> ${literal(`prefix DEFINER=root@local valore ${schema}.marker`)}`],
    ]) await query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${qid(name)} ON ${tab()} ${definition}`);
    const full = await archive('full');
    await checkArchive(full, 'full');
    await restore(full, 'full');
    if (!mutante) {
      const legacyDir = path.join(reportDir, 'legacy', path.basename(full.backupDir));
      fs.cpSync(full.backupDir, legacyDir, { recursive: true, errorOnExist: true, force: false });
      const legacy = objectsOf(legacyDir);
      legacy.objects.foreignKeys.push(...legacy.objects.indexes); delete legacy.objects.indexes;
      const content = JSON.stringify(legacy.objects, null, 2);
      fs.writeFileSync(legacy.filename, content);
      Object.assign(legacy.file, { bytes: Buffer.byteLength(content), sha256: hash(content) });
      fs.writeFileSync(path.join(legacyDir, 'manifest.json'), JSON.stringify(legacy.manifest, null, 2));
      const before = hash(fs.readFileSync(legacy.filename));
      await check('legacy-checksum', async () => {
        assert.equal((await verifyBackupDir(legacyDir)).valid, true);
        assert.equal(legacy.objects.foreignKeys.length, 9);
        return { backup: legacyDir, foreignKeysMiste: 9 };
      });
      await restore({ backupDir: legacyDir }, 'legacy');
      await check('legacy-immutato', async () => assert.equal(hash(fs.readFileSync(legacy.filename)), before));
      await check('selettivo-preserva-esclusi', async () => {
        const destination = registry.target('scelta');
        await query(`CREATE SCHEMA ${qid(destination)}`);
        await query(`CREATE TABLE ${tab('Padri', destination)} (LIKE ${tab('Padri')} INCLUDING ALL)`);
        await query(`INSERT INTO ${tab('Padri', destination)} SELECT * FROM ${tab('Padri')}`);
        await query(`CREATE TABLE ${tab('Esclusa', destination)} (id integer PRIMARY KEY, testo text NOT NULL)`);
        await query(`CREATE INDEX ${qid('indice escluso')} ON ${tab('Esclusa', destination)} (lower(testo))`);
        await query(`INSERT INTO ${tab('Esclusa', destination)} VALUES(999,'sentinella intatta')`);
        const excluded = (await indici(destination)).filter(i => i.tabella !== table);
        const { runRestore } = require('../../backup/lib/restore');
        const outcome = await runRestore({ session: { strategy, dbType: 'postgresql' }, backupDir: full.backupDir,
          targetDb: destination, onlyCollections: [table], drop: true, log: silenzioso });
        assert.deepEqual((await indici(destination)).filter(i => i.tabella !== table), excluded);
        assert.deepEqual((await indici(destination)).filter(i => i.tabella === table), (await indici(schema)).filter(i => i.tabella === table));
        assert.deepEqual(await query(`SELECT * FROM ${tab('Esclusa', destination)}`), [{ id: 999, testo: 'sentinella intatta' }]);
        assert.deepEqual(await dati(destination), await dati(schema));
        assert.deepEqual(await foreignKeys(destination), await foreignKeys(schema));
        await vincolo(destination, '23505', uniqueIndex);
        await vincolo(destination, '23503', 'fk padre reale');
        return { target: destination, outcome, esclusi: excluded };
      });
      await query(`UPDATE ${tab()} SET valore=valore+1000 WHERE id=42`);
      await query(`INSERT INTO ${tab()} VALUES(201,1,1,201,'C0201','nuovo',true)`);
      const incremental = await archive('incremental');
      await checkArchive(incremental, 'incremental');
      await restore(incremental, 'inc');
      await query(`UPDATE ${tab()} SET testo='aggiornato' WHERE id=43`);
      await query(`INSERT INTO ${tab()} VALUES(202,1,2,202,'C0202','differenziale',true)`);
      const differential = await archive('differential');
      await checkArchive(differential, 'differential');
      await restore(differential, 'diff');
    }
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    report.mutazioni = global.__labIndexOmissions || 0;
    if (native) {
      try {
        for (const { schema_name: name } of await query('SELECT schema_name FROM information_schema.schemata')) {
          const owner = registry.targets().find(base => name.startsWith(`${base}__codedb_`) && /__codedb_(staging|recovery)_[a-f0-9]{10}$/.test(name));
          if (owner) { registry.assertOwned(owner); await query(`DROP SCHEMA ${qid(name)} CASCADE`); }
        }
        await registry.cleanup(name => query(`DROP SCHEMA IF EXISTS ${qid(name)} CASCADE`));
        report.pulizia = 'completata';
      } catch (error) { report.errorePulizia = error.stack; }
      await native.end().catch(error => { report.erroreChiusura = error.message; });
    }
    if (strategy?.pool) await strategy.pool.end().catch(error => { report.erroreChiusura = error.message; });
    report.terminato = new Date().toISOString();
    report.ok = !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.verifiche.length > 0 && report.verifiche.every(v => v.ok);
    fs.writeFileSync(path.join(reportDir, 'backup-indici.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
async function child(name, mutant) {
  const dir = path.join(reportDir, name); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-indici.json'); fs.rmSync(file, { force: true });
  const log = fs.createWriteStream(path.join(dir, 'console.log'));
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, '--worker', ...(mutant ? ['--mutant'] : [])], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_REPORT_DIR: dir } });
    inoltraOutputFiglio(proc, { log, mutante: mutant ? name : null });
    proc.once('error', reject); proc.once('close', resolve);
  }).finally(() => new Promise(resolve => log.end(resolve)));
  return { exitCode, report: file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { erroreFatale: 'Rapporto assente', ok: false }) };
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-indici', iniziato: new Date().toISOString(), baseline: await child('baseline', false) };
  if (process.argv.includes('--sensitivity')) {
    const result = await child('mutante-omissione', true);
    const failures = (result.verifiche || []).filter(v => !v.ok);
    const focal = result.ripristini?.find(r => r.label === 'full');
    report.sensibilita = { causa: 'indice-ordinario-omesso-nel-restore', risultato: result,
      rilevata: result.exitCode === 1 && result.mutazioni > 0 && !result.erroreFatale && !result.errorePulizia && !result.erroreChiusura
        && result.pulizia === 'completata' && failures.length === 1 && failures[0].id === 'full-restore'
        && focal?.verification?.schemaDifferences?.some(d => String(d.field).includes('indexes')) };
  }
  report.ok = report.baseline.ok && report.baseline.exitCode === 0 && (!report.sensibilita || report.sensibilita.rilevata);
  report.terminato = new Date().toISOString();
  fs.writeFileSync(path.join(reportDir, 'backup-indici.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv.includes('--mutant')) : main())
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
