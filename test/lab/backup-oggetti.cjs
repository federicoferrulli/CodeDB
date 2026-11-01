'use strict';
const { inoltraOutputFiglio } = require('./output-mutanti.cjs');

// Stato finale degli oggetti nelle catene, con oracoli nativi indipendenti.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-oggetti.cjs [--sensitivity]
// LAB_OGGETTI_ENGINE limita il motore; LAB_REPORT_DIR separa gli artefatti.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createE2eTargetRegistry } = require('../e2e-harness');
const { readManifest, fileDelBackup, verifyBackupDir } = require('../../backup/lib/util');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-005/reali-host');
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const silenzioso = { info() {}, error() {}, warn() {} };

async function worker(type, mutante) {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = { suite: 'backup-oggetti', motore: type, mutante, iniziato: new Date().toISOString(),
    verifiche: [], ripristini: [], fallback: [], mutazioni: 0, sorgenti: {} };
  for (const name of ['backup/lib/engine.js', 'backup/lib/restore.js', 'backup/lib/schema-snapshot.js',
    'backup/lib/merge-identita.js', 'db/backupRestoreAdapter.js', 'db/schemaObjects.js', 'test/lab/backup-oggetti.cjs']) {
    const file = path.resolve(__dirname, '../..', name);
    if (fs.existsSync(file)) report.sorgenti[name] = hash(fs.readFileSync(file));
  }
  if (mutante) {
    // Il consumer torna deliberatamente alla foto del full. Anche se il gate
    // condivide quel resolver, catalogo e risultati nativi devono accorgersene.
    const helper = require('../../backup/lib/schema-snapshot');
    const original = helper.risolviOggettiCatena;
    helper.risolviOggettiCatena = (chain, options) => {
      if (chain.length > 1 && mutante === 'ordine-key') {
        const result = original(chain, options);
        const { decodificaMetadati, codificaMetadati } = require('../../db/mongoSchemaBson');
        result.indexes.eventi = (result.indexes.eventi || []).map(index => {
          if (index.name !== 'da_cambiare') return index;
          // Il guasto deve raggiungere il driver: il gemello leggibile e il
          // BSON restano coerenti, cambia soltanto l'ordine composto reale.
          const native = decodificaMetadati(index);
          native.key = Object.fromEntries(Object.entries(native.key).reverse());
          report.mutazioni++;
          return codificaMetadati(native);
        });
        return result;
      }
      if (chain.length > 1) { report.mutazioni++; return original([chain[0]], options); }
      return original(chain, options);
    };
  }
  const { runBackup } = require('../../backup/lib/engine');
  const { runRestore } = require('../../backup/lib/restore');
  const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
  const mongo = type === 'mongodb', mysql = type === 'mysql';
  const registry = createE2eTargetRegistry({ destructive: true, prefix: mongo ? 'lab_og_m' : mysql ? 'lab_og_y' : 'lab_og_p' });
  const source = registry.target('origine');
  const qid = value => mysql ? '`' + value.replaceAll('`', '``') + '`' : '"' + value.replaceAll('"', '""') + '"';
  const table = (db, name) => `${qid(db)}.${qid(name)}`;
  let native, strategy;
  const query = async (sql, params = []) => plain(mysql ? (await native.query(sql, params))[0] : (await native.query(sql, params)).rows);
  const records = db => mongo ? native.db(db).collection('eventi').find({}).sort({ _id: 1 }).toArray()
    : query(`SELECT id,valore,marker FROM ${table(db, 'eventi')} ORDER BY id`);
  async function check(id, action) {
    try { const dettagli = await action(); report.verifiche.push({ id, ok: true, dettagli }); console.log(`OK ${type}/${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${type}/${id}: ${error.message}`); return false; }
  }
  async function snapshot(db) {
    let catalogo, definitions;
    if (mongo) {
      const infos = await native.db(db).listCollections().toArray();
      catalogo = {
        views: infos.filter(i => i.type === 'view').map(i => ({ name: i.name, ...i.options })).sort((a, b) => a.name.localeCompare(b.name)),
        indexes: (await native.db(db).collection('eventi').indexes()).filter(i => i.name !== '_id_').map(i => {
          const { v, ns, ...definition } = i;
          // L'ordine delle chiavi composte è semantico; deepEqual su oggetti
          // normali lo ignora, su questa sequenza di coppie invece lo verifica.
          return { ...definition, key: Object.entries(definition.key) };
        }).sort((a, b) => a.name.localeCompare(b.name)),
      };
    } else if (mysql) {
      // Le dipendenze vengono dal catalogo, non da una riscrittura della DDL.
      catalogo = {
        views: await query('SELECT TABLE_NAME AS name,CHECK_OPTION,IS_UPDATABLE,SECURITY_TYPE FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [db]),
        tables: await query('SELECT VIEW_NAME,TABLE_NAME,TABLE_SCHEMA=? AS locale FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA=? ORDER BY VIEW_NAME,TABLE_NAME', [db, db]),
        routines: await query('SELECT ROUTINE_NAME AS name,ROUTINE_TYPE,ROUTINE_DEFINITION,IS_DETERMINISTIC,SQL_DATA_ACCESS,SECURITY_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME', [db]),
        // MySQL 8.4 ripete la stessa dipendenza per routine omonime in altri
        // schemi: confronto l'insieme dei riferimenti, mantenendo invece il
        // nome esatto di ogni schema esterno. La riproduzione nativa è negli
        // artefatti LAB-005 diagnostica-mysql-deps (senza chiamate a CodeDB).
        routineDeps: await query('SELECT DISTINCT TABLE_NAME,SPECIFIC_NAME,IF(SPECIFIC_SCHEMA=?,NULL,SPECIFIC_SCHEMA) AS schemaEsterno FROM information_schema.VIEW_ROUTINE_USAGE WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,SPECIFIC_NAME,schemaEsterno', [db, db]),
        triggers: await query('SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME', [db]),
      };
      definitions = await query('SELECT TABLE_NAME,VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [db]);
    } else {
      // Il deparser nativo con search_path della destinazione emette riferimenti
      // locali confrontabili: non si sostituisce testo dentro stringhe SQL.
      await query(`SET search_path TO ${qid(db)},pg_catalog`);
      catalogo = {
        views: await query(`SELECT c.relname AS name,c.relkind,pg_get_viewdef(c.oid,true) AS definizione FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('v','m') ORDER BY c.relname`, [db]),
        routines: await query(`SELECT p.proname AS name,p.prokind,p.provolatile,pg_get_function_identity_arguments(p.oid) AS argomenti,
          pg_get_function_result(p.oid) AS risultato,p.prosrc AS corpo FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname=$1 ORDER BY p.proname,argomenti`, [db]),
        triggers: await query(`SELECT t.tgname AS name,c.relname AS tabella,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definizione
          FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`, [db]),
        indexes: await query(`SELECT i.relname AS name,x.indisunique AS unico,x.indisvalid AS valido,
          ARRAY(SELECT pg_get_indexdef(x.indexrelid,p,true) FROM generate_series(1,x.indnatts) p) AS elementi,
          pg_get_expr(x.indpred,x.indrelid,true) AS predicato FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
          JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE n.nspname=$1 AND NOT x.indisprimary ORDER BY i.relname`, [db]),
      };
    }
    const views = {};
    for (const v of catalogo.views) views[v.name] = mongo
      ? await native.db(db).collection(v.name).find({}).sort({ _id: 1 }).toArray()
      : await query(`SELECT * FROM ${table(db, v.name)} ORDER BY id`);
    return plain({ catalogo, dati: await records(db), views, ...(definitions ? { definitions } : {}) });
  }
  async function createDb(db) {
    if (mongo) await native.db(db).createCollection('eventi');
    else {
      await query(`CREATE ${mysql ? 'DATABASE' : 'SCHEMA'} ${qid(db)}`);
      await query(`CREATE TABLE ${table(db, 'eventi')}(id INT PRIMARY KEY,valore INT NOT NULL,marker INT NOT NULL)`);
    }
  }
  async function insert(db, id, value) {
    if (mongo) await native.db(db).collection('eventi').insertOne({ _id: id, valore: value, marker: 0 });
    else await query(`INSERT INTO ${table(db, 'eventi')} VALUES(${id},${value},0)`);
  }
  async function routine(name, multiplier) {
    await query(mysql ? `CREATE FUNCTION ${table(source, name)}(x INT) RETURNS INT DETERMINISTIC RETURN x * ${multiplier}`
      : `CREATE FUNCTION ${table(source, name)}(x INT) RETURNS INT LANGUAGE SQL IMMUTABLE AS 'SELECT x * ${multiplier}'`);
  }
  async function trigger(increment) {
    if (mysql) await query(`CREATE TRIGGER ${table(source, 'marca')} BEFORE INSERT ON ${table(source, 'eventi')} FOR EACH ROW SET NEW.marker = NEW.marker + ${increment}`);
    else {
      await query(`CREATE OR REPLACE FUNCTION ${table(source, 'fn_marca')}() RETURNS TRIGGER LANGUAGE plpgsql AS $$BEGIN NEW.marker := NEW.marker + ${increment}; RETURN NEW; END$$`);
      if (increment === 1) await query(`CREATE TRIGGER marca BEFORE INSERT ON ${table(source, 'eventi')} FOR EACH ROW EXECUTE FUNCTION ${table(source, 'fn_marca')}()`);
    }
  }
  async function view(name, base, stage, simple = false, db = source) {
    if (mongo) {
      const pipeline = simple ? [{ $project: { _id: 1, valore: 1 } }]
        : name === 'z_base' ? [{ $match: { valore: { $gte: stage === 2 ? 20 : 10 } } }, { $project: { _id: 1, calcolo: { $multiply: ['$valore', stage === 2 ? 3 : 2] } } }]
          : name === 'a_seconda' ? [{ $project: { _id: 1, risultato: { $add: ['$calcolo', 1] } } }]
            : [{ $match: { valore: name === 'obsoleta' ? { $lt: 20 } : { $gte: 30 } } }, { $project: { _id: 1 } }];
      await native.db(db).createCollection(name, { viewOn: base, pipeline });
    } else {
      const sql = simple ? `SELECT id,valore FROM ${table(db, base)}`
        : name === 'z_base' ? `SELECT id,${table(db, stage === 2 ? 'f_nuova' : 'f_base')}(valore) AS calcolo FROM ${table(db, base)} WHERE valore>=${stage === 2 ? 20 : 10}`
          : name === 'a_seconda' ? `SELECT id,calcolo+1 AS risultato FROM ${table(db, base)}`
            : `SELECT id FROM ${table(db, base)} WHERE valore${name === 'obsoleta' ? '<20' : '>=30'}`;
      await query(`CREATE VIEW ${table(db, name)} AS ${sql}`);
    }
  }
  async function dropViews(names) {
    for (const name of names) {
      if (mongo) await native.db(source).collection(name).drop();
      else await query(`DROP VIEW ${table(source, name)}`);
    }
  }
  async function cambiaIndici(stage) {
    if (mysql) return;
    const collection = mongo && native.db(source).collection('eventi');
    if (stage > 0) for (const name of ['da_cambiare', stage === 2 ? 'da_rimuovere' : 'nuovo']) {
      if (mongo) await collection.dropIndex(name);
      else await query(`DROP INDEX ${table(source, name)}`);
    }
    if (stage === 3) return;
    if (mongo) {
      await collection.createIndex(stage === 2 ? { valore: 1, marker: 1 } : { marker: 1, valore: 1 }, {
        name: 'da_cambiare', ...(stage === 2 ? { unique: true } : {}), partialFilterExpression: { valore: { $gte: stage === 2 ? 20 : 10 } },
      });
      await collection.createIndex(stage === 2 ? { marker: 1, valore: 1 } : { marker: 1 }, {
        name: stage === 2 ? 'nuovo' : 'da_rimuovere',
        ...(stage === 2 ? { partialFilterExpression: { annidato: { $eq: { a: 1, b: 2 } } } } : { sparse: true }),
      });
    } else {
      await query(`CREATE INDEX da_cambiare ON ${table(source, 'eventi')}(valore${stage === 2 ? ' DESC' : ''}) WHERE valore>=${stage === 2 ? 20 : 10}`);
      await query(`CREATE INDEX ${qid(stage === 2 ? 'nuovo' : 'da_rimuovere')} ON ${table(source, 'eventi')}(${stage === 2 ? 'marker,valore' : 'marker'})`);
    }
  }
  async function archive(mode, label, baseId, empty = false) {
    const result = await runBackup({ session: { strategy, dbType: type }, connName: 'oggetti', db: source,
      type: mode, destRoot: path.join(reportDir, 'archivi'), compress: true, log: silenzioso });
    await check(`${label}-archivio`, async () => {
      const manifest = readManifest(result.backupDir);
      assert.equal(manifest.type, mode); assert.equal(manifest.baseId, baseId);
      assert.equal((await verifyBackupDir(result.backupDir)).valid, true);
      const file = manifest.files.find(f => f.kind === 'objects');
      assert(file, 'Ogni layer deve contenere la foto degli oggetti, anche vuota');
      assert.equal(file.mode, 'snapshot');
      const objects = JSON.parse(fs.readFileSync(fileDelBackup(result.backupDir, file.path), 'utf8'));
      assert.equal(objects.views.length, empty ? 0 : 3);
      if (empty) assert(Object.values(objects).filter(Array.isArray).every(items => items.length === 0), 'La foto finale deve essere completamente vuota');
      if (mongo) {
        const indexFile = manifest.files.find(f => f.kind === 'indexes' && f.collection === 'eventi');
        assert(indexFile, 'Ogni layer Mongo deve fotografare gli indici'); assert.equal(indexFile.mode, 'snapshot');
        const indexes = JSON.parse(fs.readFileSync(fileDelBackup(result.backupDir, indexFile.path), 'utf8'));
        assert.equal(indexes.filter(i => i.name !== '_id_').length, empty ? 0 : 2);
      }
      return { backup: result.backupDir, baseId: manifest.baseId, objects };
    });
    return result;
  }
  async function restore(result, label, expected, triggerValue, seed = null) {
    let destination = registry.target(label);
    let rawApplied = false;
    const restored = await check(`${label}-restore`, async () => {
      if (seed) {
        const initial = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir: seed.backupDir,
          targetDb: destination, drop: true, connName: 'oggetti', log: silenzioso, recoveryRoot: path.join(reportDir, 'recovery') });
        report.ripristini.push({ label: `${label}-seme`, percorso: 'piano', ...initial });
        assert.equal(initial.status, 'completato', JSON.stringify(initial));
        // Una riga estranea alla catena deve sopravvivere alla fusione. Il
        // valore è fuori dai filtri delle viste finali, così il loro oracolo
        // resta quello del database sorgente senza riscriverne la semantica.
        await insert(destination, 8000, 7);
        const sentinella = (await records(destination)).find(row => (row.id ?? row._id) === 8000);
        assert(sentinella, 'La sentinella del merge deve esistere prima del ripristino');
        expected = { ...expected, dati: [...expected.dati, plain(sentinella)]
          .sort((a, b) => (a.id ?? a._id) - (b.id ?? b._id)) };
      }
      let outcome;
      try { outcome = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir: result.backupDir,
        targetDb: destination, drop: !seed, connName: 'oggetti', log: silenzioso, recoveryRoot: path.join(reportDir, 'recovery') }); }
      catch (error) { outcome = { status: 'errore', error: error.message }; }
      report.ripristini.push({ label, percorso: 'piano', ...outcome });
      if (seed) assert.equal(outcome.status, 'completato', JSON.stringify(outcome));
      if (outcome.status !== 'completato') {
        // Il motore sottostante serve soltanto alla diagnosi: un rifiuto del
        // piano resta rosso, anche quando il catalogo nativo risulta corretto.
        report.fallback.push({ label, soloDiagnostica: true, idLimite: null, motivo: outcome.error, verification: outcome.verification });
        destination = registry.target(`${label}_raw`);
        const raw = await runRestore({ session: { strategy, dbType: type }, backupDir: result.backupDir,
          targetDb: destination, drop: true, log: silenzioso });
        report.ripristini.push({ label, percorso: 'motore-con-oracolo-nativo', ...raw });
        rawApplied = true;
        assert.equal(outcome.status, 'completato', JSON.stringify({ error: outcome.error, verification: outcome.verification }));
      } else {
        assert.equal(outcome.verification.ok, true);
        assert.equal(outcome.totalDocs, expected.dati.length, 'Il totale deve contare i dati utente, compresa la sentinella, senza documenti di sistema');
      }
      return { target: destination, percorso: outcome.status === 'completato' ? 'piano' : 'motore-con-oracolo-nativo' };
    });
    if (!restored && !rawApplied) return;
    let actual;
    await check(`${label}-catalogo`, async () => {
      actual = await snapshot(destination);
      assert.deepEqual(actual.catalogo, expected.catalogo, 'Il catalogo deve descrivere solo gli oggetti finali');
      return { catalogo: actual.catalogo, definitions: actual.definitions };
    });
    await check(`${label}-dati-viste`, async () => {
      actual ||= await snapshot(destination);
      assert.deepEqual(actual.dati, expected.dati, 'I trigger non devono modificare i dati caricati');
      assert.deepEqual(actual.views, expected.views, 'Le viste devono avere la semantica finale');
      return { righe: actual.dati.length, viste: actual.views };
    });
    if (!mongo) await check(`${label}-trigger`, async () => {
      await insert(destination, 9000, 70);
      const row = (await query(`SELECT marker FROM ${table(destination, 'eventi')} WHERE id=9000`))[0];
      assert.equal(row.marker, triggerValue, 'Il trigger finale deve intervenire una sola volta, oppure essere assente');
      await query(`DELETE FROM ${table(destination, 'eventi')} WHERE id=9000`);
      return { marker: row.marker };
    });
    if (mongo && triggerValue === 10) await check(`${label}-indice-unique`, async () => {
      const collection = native.db(destination).collection('eventi');
      await assert.rejects(collection.insertOne({ _id: 9000, valore: 30, marker: 0 }), error => error.code === 11000);
      await collection.insertMany([{ _id: 9001, valore: 1, marker: 0 }, { _id: 9002, valore: 1, marker: 0 }]);
      await collection.deleteMany({ _id: { $in: [9001, 9002] } });
      return { unico: true, filtroParzialeApplicato: true };
    });
    if (mongo && triggerValue === 10) await check(`${label}-indice-letterale`, async () => {
      const rows = await native.db(destination).collection('eventi')
        .find({ annidato: { $eq: { a: 1, b: 2 } } }).hint('nuovo').project({ _id: 1 }).toArray();
      assert.deepEqual(rows, [{ _id: 101 }], 'Il literal BSON del filtro parziale deve conservare l’ordine dei campi');
      return { documentiIndicizzati: rows };
    });
  }
  async function smokeCli() {
    const db = registry.target('cli'), destination = registry.target('cli_copy');
    const merged = mongo ? null : registry.target('cli_merge');
    await createDb(db); await insert(db, 1, 10); await view('vista', 'eventi', 0, true, db);
    const dir = path.join(reportDir, 'cli'); fs.mkdirSync(dir, { recursive: true });
    const ini = path.join(dir, 'connections.ini'), root = path.join(dir, 'backups');
    const port = Number(process.env[mongo ? 'LAB_MONGO_PORT' : mysql ? 'LAB_MYSQL_PORT' : 'LAB_PG_PORT'] || (mongo ? 37017 : mysql ? 33306 : 35432));
    fs.writeFileSync(ini, `[lab]\ndbType=${type}\nhost=127.0.0.1\nport=${port}\n${mongo ? 'directConnection=true' : `username=${mysql ? 'root' : 'postgres'}\npassword=${mysql ? 'lab_mysql' : 'lab_postgres'}\n${mysql ? '' : 'database=postgres'}`}\n`);
    let callNo = 0;
    const cli = (...args) => {
      let output;
      try { output = execFileSync(process.execPath, [path.resolve(__dirname, '../../backup/cli.js'), ...args, '--dest', root], {
        windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CODEDB_CONNECTIONS_FILE: ini, CODEDB_CONNECTIONS_DIR: path.join(dir, 'connections'),
          CODEDB_BACKUPS_DIR: root, CODEDB_RBAC: 'off', GUI_MONGO_PASSPHRASE: '', SLACK_WEBHOOK_URL: '' },
      }); } catch (error) { output = String(error.stdout || '') + String(error.stderr || '') + error.message; throw new Error(output); }
      finally { fs.writeFileSync(path.join(dir, `${++callNo}-${args[0]}.log`), output || ''); }
      return output;
    };
    const latestBackup = () => {
      const group = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name)).find(d => {
        const file = path.join(d, 'catalog.json');
        return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).backups.some(b => b.db === db);
      });
      assert(group, 'Catalogo CLI della fixture corrente assente');
      const catalog = JSON.parse(fs.readFileSync(path.join(group, 'catalog.json'), 'utf8'));
      return path.join(group, catalog.backups.at(-1).id);
    };
    assert.match(cli('backup', '--conn', 'lab', '--db', db, '--type', 'full'), /stato=SUCCESSO/);
    if (merged) {
      assert.match(cli('restore', '--conn', 'lab', '--from', latestBackup(), '--target-db', merged, '--drop'), /stato=SUCCESSO/);
      await query(`CREATE OR REPLACE VIEW ${table(db, 'vista')} AS SELECT id,valore*2 AS valore FROM ${table(db, 'eventi')} WHERE valore>=20`);
    }
    await insert(db, 2, 20);
    assert.match(cli('backup', '--conn', 'lab', '--db', db, '--type', 'incremental'), /stato=SUCCESSO/);
    const backupDir = latestBackup();
    assert.match(cli('restore', '--conn', 'lab', '--from', backupDir, '--target-db', destination, '--drop'), /stato=SUCCESSO/);
    const actual = await snapshot(destination), expected = await snapshot(db);
    assert.deepEqual(actual.catalogo, expected.catalogo); assert.deepEqual(actual.dati, expected.dati); assert.deepEqual(actual.views, expected.views);
    if (merged) {
      const outcome = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir, targetDb: merged,
        drop: false, connName: 'oggetti', log: silenzioso, recoveryRoot: path.join(reportDir, 'recovery') });
      report.ripristini.push({ label: 'cli-merge', percorso: 'piano-drop-false', ...outcome });
      assert.equal(outcome.status, 'completato', JSON.stringify(outcome));
      const mergedSnapshot = await snapshot(merged);
      assert.deepEqual(mergedSnapshot.catalogo, expected.catalogo);
      assert.deepEqual(mergedSnapshot.dati, expected.dati); assert.deepEqual(mergedSnapshot.views, expected.views);
    }
    return { source: db, target: destination, merge: merged, backupDir };
  }
  async function vistaEstraneaProtetta(full, finale) {
    const destination = registry.target('vista_estranea');
    const seeded = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir: full.backupDir,
      targetDb: destination, drop: true, connName: 'oggetti', log: silenzioso, recoveryRoot: path.join(reportDir, 'recovery') });
    assert.equal(seeded.status, 'completato', JSON.stringify(seeded));
    await insert(destination, 8000, 7);
    if (mongo) await native.db(destination).command({ collMod: 'obsoleta', viewOn: 'eventi',
      pipeline: [{ $project: { _id: 1, protetto: { $literal: 'modifica locale' } } }] });
    else await query(`CREATE OR REPLACE VIEW ${table(destination, 'obsoleta')} AS SELECT id,valore AS protetto FROM ${table(destination, 'eventi')} WHERE valore>=10`);
    const before = await snapshot(destination);
    const fasi = [];
    const outcome = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir: finale.backupDir,
      targetDb: destination, drop: false, connName: 'oggetti', log: silenzioso, recoveryRoot: path.join(reportDir, 'recovery'),
      onProgress: evento => fasi.push(evento) });
    report.ripristini.push({ label: 'merge-vista-estranea', percorso: 'piano-drop-false', ...outcome });
    assert.notEqual(outcome.status, 'completato', 'Una vista modificata fuori dalla catena deve fermare la promozione');
    assert(outcome.error, 'Il conflitto deve avere una diagnosi osservabile');
    assert(!fasi.some(evento => evento.phase === 'promozione'), 'Il conflitto deve essere individuato prima di iniziare la promozione');
    assert.deepEqual(await snapshot(destination), before, 'Il fallimento deve lasciare identici catalogo, dati e risultati delle viste originali');
    return { stato: outcome.status, errore: outcome.error, originalePreservato: true, target: destination, fasi };
  }
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    if (mongo) {
      const { MongoClient } = require('mongodb');
      native = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.LAB_MONGO_PORT || 37017)}/?directConnection=true`, { serverSelectionTimeoutMS: 6000 });
      await native.connect(); strategy = new (require('../../db/MongoDbStrategy'))(); strategy.client = native;
    } else if (mysql) {
      const driver = require('mysql2/promise');
      const config = { host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), user: 'root', password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql' };
      native = await driver.createConnection(config); strategy = new (require('../../db/MySqlStrategy'))(); strategy.pool = driver.createPool({ ...config, connectionLimit: 3 });
    } else {
      const { Client, Pool } = require('pg');
      const config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres', connectionTimeoutMillis: 6000 };
      native = new Client(config); await native.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool({ ...config, max: 3 });
    }
    await createDb(source);
    await cambiaIndici(0);
    if (!mongo) { await routine('f_base', 2); await trigger(1); }
    await view('z_base', 'eventi', 0); await view('a_seconda', 'z_base', 0); await view('obsoleta', 'eventi', 0);
    for (const [id, value] of [[1, 10], [2, 20], [3, 30]]) await insert(source, id, value);
    if (mongo) await native.db(source).collection('eventi').insertMany([
      { _id: 101, valore: 2, marker: 0, annidato: { a: 1, b: 2 } },
      { _id: 102, valore: 2, marker: 0, annidato: { b: 2, a: 1 } },
    ]);
    const full = await archive('full', 'full', null);
    if (!mutante) await restore(full, 'full', await snapshot(source), 1);
    await insert(source, 4, 40);
    if (mongo) await native.db(source).collection('eventi').updateOne({ _id: 1 }, { $set: { valore: 11 } });
    else await query(`UPDATE ${table(source, 'eventi')} SET valore=11 WHERE id=1`);
    const i1 = await archive('incremental', 'i1', full.id);
    if (!mutante) await restore(i1, 'i1', await snapshot(source), 1);
    await dropViews(['a_seconda', 'z_base', 'obsoleta']);
    await cambiaIndici(2);
    if (!mongo) {
      await query(`DROP FUNCTION ${table(source, 'f_base')}${mysql ? '' : '(INT)'}`);
      await routine('f_nuova', 3);
      if (mysql) await query(`DROP TRIGGER ${table(source, 'marca')}`);
      await trigger(10);
    }
    await view('z_base', 'eventi', 2); await view('a_seconda', 'z_base', 2); await view('nuova', 'eventi', 2);
    await insert(source, 5, 50);
    const i2 = await archive('incremental', 'i2', i1.id);
    await restore(i2, 'i2', await snapshot(source), 10);
    if (!mutante) {
      await restore(i2, 'merge', await snapshot(source), 10, full);
      await check('merge-vista-estranea-protetta', () => vistaEstraneaProtetta(full, i2));
      const d2 = await archive('differential', 'd2', full.id);
      await restore(d2, 'd2', await snapshot(source), 10);
      await dropViews(['a_seconda', 'z_base', 'nuova']);
      await cambiaIndici(3);
      if (!mongo) {
        await query(mysql ? `DROP TRIGGER ${table(source, 'marca')}` : `DROP TRIGGER marca ON ${table(source, 'eventi')}`);
        await query(`DROP FUNCTION ${table(source, 'f_nuova')}${mysql ? '' : '(INT)'}`);
        if (!mysql) await query(`DROP FUNCTION ${table(source, 'fn_marca')}()`);
      }
      await insert(source, 6, 60);
      const i3 = await archive('incremental', 'i3', d2.id, true);
      await restore(i3, 'i3', await snapshot(source), 0);
      const d3 = await archive('differential', 'd3', full.id, true);
      await restore(d3, 'd3', await snapshot(source), 0);
      await check('cli-full-incremental', smokeCli);
    }
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    if (native) {
      try {
        const names = mongo ? (await native.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(d => d.name)
          : (await query(mysql ? 'SHOW DATABASES' : 'SELECT schema_name FROM information_schema.schemata')).map(row => Object.values(row)[0]);
        const drop = name => mongo ? native.db(name).dropDatabase() : query(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${qid(name)}${mysql ? '' : ' CASCADE'}`);
        for (const name of names) {
          const owner = registry.targets().find(base => name.startsWith(`${base}__codedb_`) && /__codedb_(staging|recovery)_[a-f0-9]{10}$/.test(name));
          if (owner) { registry.assertOwned(owner); await drop(name); }
        }
        await registry.cleanup(drop); report.pulizia = 'completata';
      } catch (error) { report.errorePulizia = error.stack; }
      await (mongo ? native.close() : native.end()).catch(error => { report.erroreChiusura = error.message; });
    }
    if (strategy?.pool) await strategy.pool.end().catch(error => { report.erroreChiusura = error.message; });
    report.terminato = new Date().toISOString();
    report.ok = !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.verifiche.length > 0 && report.verifiche.every(v => v.ok);
    fs.writeFileSync(path.join(reportDir, 'backup-oggetti.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
async function child(type, mutante) {
  const dir = path.join(reportDir, `${type}${mutante ? `-mutante-${mutante}` : ''}`); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backup-oggetti.json'); fs.rmSync(file, { force: true });
  const log = fs.createWriteStream(path.join(dir, 'console.log'));
  const exitCode = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [__filename, '--worker', type, ...(mutante ? ['--mutant'] : []), ...(mutante === 'ordine-key' ? ['--mutant-order'] : [])], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_REPORT_DIR: dir } });
    inoltraOutputFiglio(proc, { log, mutante: mutante ? `${type}/${mutante}` : null });
    proc.once('error', reject); proc.once('close', resolve);
  }).finally(() => new Promise(resolve => log.end(resolve)));
  return { exitCode, report: file, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ok: false, erroreFatale: 'Rapporto assente' }) };
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
  fs.mkdirSync(reportDir, { recursive: true });
  const motors = ['postgresql', 'mysql', 'mongodb'].filter(type => !process.env.LAB_OGGETTI_ENGINE || process.env.LAB_OGGETTI_ENGINE === type);
  assert(motors.length, 'Nessun motore selezionato');
  const report = { suite: 'backup-oggetti', iniziato: new Date().toISOString(), risultati: [], sensibilita: [] };
  const save = () => fs.writeFileSync(path.join(reportDir, 'backup-oggetti.json'), JSON.stringify(report, null, 2));
  for (const type of motors) { report.risultati.push(await child(type, false)); save(); }
  if (process.argv.includes('--sensitivity')) for (const type of motors) {
    const result = await child(type, 'foto-full'), failures = (result.verifiche || []).filter(v => !v.ok);
    const expected = type === 'mongodb' ? ['i2-catalogo', 'i2-dati-viste', 'i2-indice-unique', 'i2-indice-letterale']
      : ['i2-catalogo', 'i2-dati-viste', 'i2-trigger'];
    report.sensibilita.push({ motore: type, causa: 'foto-full-al-posto-dello-stato-finale', risultato: result,
      rilevata: result.exitCode === 1 && result.mutazioni > 0 && !result.erroreFatale && !result.errorePulizia && !result.erroreChiusura
        && result.pulizia === 'completata'
        && JSON.stringify(failures.map(v => v.id).sort()) === JSON.stringify(expected.sort()) });
    save();
  }
  if (process.argv.includes('--sensitivity') && motors.includes('mongodb')) {
    const result = await child('mongodb', 'ordine-key'), failures = (result.verifiche || []).filter(v => !v.ok);
    report.sensibilita.push({ motore: 'mongodb', causa: 'ordine-chiave-composta-invertito', risultato: result,
      rilevata: result.exitCode === 1 && result.mutazioni > 0 && !result.erroreFatale && !result.errorePulizia && !result.erroreChiusura
        && result.pulizia === 'completata' && failures.length === 1 && failures[0].id === 'i2-catalogo' });
    save();
  }
  report.ok = report.risultati.every(r => r.ok && r.exitCode === 0) && report.sensibilita.every(s => s.rilevata);
  report.totali = { verifiche: report.risultati.reduce((n, r) => n + (r.verifiche || []).length, 0),
    fallite: report.risultati.reduce((n, r) => n + (r.verifiche || []).filter(v => !v.ok).length, 0),
    fallback: report.risultati.reduce((n, r) => n + (r.fallback || []).length, 0) };
  report.terminato = new Date().toISOString(); save(); if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv[process.argv.indexOf('--worker') + 1],
  process.argv.includes('--mutant-order') ? 'ordine-key' : process.argv.includes('--mutant') ? 'foto-full' : null) : main())
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
