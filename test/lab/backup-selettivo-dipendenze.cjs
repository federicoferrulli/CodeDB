'use strict';

// AUD014: dipendenze SQL reali del ripristino selettivo, senza alterare il motore.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/backup-selettivo-dipendenze.cjs
// LAB_SELETTIVO_ENGINE può limitare la prova a mysql oppure postgresql.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createE2eTargetRegistry } = require('../e2e-harness');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/aud-014/dipendenze-host');
const hash = data => createHash('sha256').update(data).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const log = { info() {}, warn() {}, error() {} };

async function worker(type) {
  fs.mkdirSync(reportDir, { recursive: true });
  const mysql = type === 'mysql', registry = createE2eTargetRegistry({ destructive: true, prefix: mysql ? 'lab_sd_y' : 'lab_sd_p' });
  const report = { suite: 'backup-selettivo-dipendenze', motore: type, iniziato: new Date().toISOString(), verifiche: [], operazioni: [], sorgenti: {} };
  const sourceFiles = ['db/schema-merge.js', 'db/pg-routine-selezione.js', 'db/pg-promozione.js', 'db/pg-restore-transaction.js', 'db/importPlan.js', 'db/backupRestoreAdapter.js', 'db/importArtifactAdapter.js', 'db/schemaObjects.js', 'db/pg-ddl.js', 'db/pg-types.js',
    'backup/lib/restore.js', 'backup/lib/schema-snapshot.js', 'test/lab/backup-selettivo-dipendenze.cjs'];
  for (const file of sourceFiles) report.sorgenti[file] = hash(fs.readFileSync(path.resolve(__dirname, '../..', file)));
  const q = name => mysql ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"';
  const table = (db, name) => `${q(db)}.${q(name)}`;
  let native, strategy, activeTarget = null;
  const stages = new Map();
  const query = async (sql, params = []) => plain(mysql ? (await native.query(sql, params))[0] : (await native.query(sql, params)).rows);
  const ownedStage = (name, owned = registry.targets()) => {
    const suffix = /__codedb_(staging|recovery|recupero)_[a-f0-9]{10}$/.exec(name)?.[0];
    return suffix && owned.find(base => name === base.slice(0, 63 - suffix.length) + suffix);
  };
  async function check(id, action) {
    try { const details = await action(); report.verifiche.push({ id, ok: true, dettagli: details }); console.log(`OK ${type}/${id}`); return true; }
    catch (error) { report.verifiche.push({ id, ok: false, errore: error.message, stack: error.stack }); console.error(`FAIL ${type}/${id}: ${error.message}`); return false; }
  }
  function normalize(value, db) {
    // Nei DDL della fixture lo schema appare solo come qualificatore; i corpi
    // delle routine contengono esclusivamente costanti numeriche e colonne.
    if (typeof value === 'string') return value.replaceAll(q(db) + '.', q('__db__') + '.').replaceAll(db + '.', '__db__.');
    if (Array.isArray(value)) return value.map(item => normalize(item, db));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, db)]));
    return value;
  }
  async function snapshot(db) {
    if (!mysql) await query(`SET search_path TO ${q(db)},pg_catalog`);
    const names = mysql ? await query('SELECT TABLE_NAME AS name,TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [db])
      : await query(`SELECT c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('r','v','m') ORDER BY c.relname`, [db]);
    const rows = {};
    for (const { name } of names) rows[name] = await query(`SELECT * FROM ${table(db, name)} ORDER BY id`);
    const columns = mysql ? await query(`SELECT TABLE_NAME AS tabella,COLUMN_NAME AS nome,ORDINAL_POSITION AS posizione,
      COLUMN_TYPE AS tipo,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS valoreDefault,EXTRA AS extra
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION`, [db])
      : await query(`SELECT table_name AS tabella,column_name AS nome,ordinal_position AS posizione,
        data_type AS tipo,udt_name AS tipoNativo,is_nullable AS nullable,column_default AS valoreDefault
        FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position`, [db]);
    const indexes = mysql ? await query(`SELECT TABLE_NAME AS tabella,INDEX_NAME AS nome,NON_UNIQUE AS nonUnico,SEQ_IN_INDEX AS posizione,
      COLUMN_NAME AS colonna,COLLATION AS ordine FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`, [db])
      : await query(`SELECT t.relname AS tabella,i.relname AS nome,x.indisunique AS unico,x.indisprimary AS primario,
        ARRAY(SELECT pg_get_indexdef(x.indexrelid,p,true) FROM generate_series(1,x.indnatts) p) AS elementi,
        pg_get_expr(x.indpred,x.indrelid,true) AS predicato FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
        JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 ORDER BY t.relname,i.relname`, [db]);
    const triggers = mysql ? await query(`SELECT TRIGGER_NAME AS nome,EVENT_OBJECT_TABLE AS tabella,EVENT_MANIPULATION AS evento,
      ACTION_TIMING AS momento,ACTION_STATEMENT AS corpo FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME`, [db])
      : await query(`SELECT t.tgname AS nome,c.relname AS tabella,pg_get_triggerdef(t.oid,true) AS ddl
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [db]);
    const foreignKeys = mysql ? await query(`SELECT k.TABLE_NAME AS tabella,k.CONSTRAINT_NAME AS nome,k.COLUMN_NAME AS colonna,
      k.ORDINAL_POSITION AS posizione,k.REFERENCED_TABLE_SCHEMA=k.TABLE_SCHEMA AS schemaLocale,
      k.REFERENCED_TABLE_NAME AS padre,k.REFERENCED_COLUMN_NAME AS colonnaPadre,r.DELETE_RULE AS onDelete,r.UPDATE_RULE AS onUpdate
      FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
      WHERE k.TABLE_SCHEMA=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`, [db])
      : await query(`SELECT c.relname AS tabella,k.conname AS nome,pg_get_constraintdef(k.oid,true) AS ddl
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND k.contype='f' ORDER BY c.relname,k.conname`, [db]);
    const views = mysql ? await query('SELECT TABLE_NAME AS nome,VIEW_DEFINITION AS ddl FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [db])
      : await query(`SELECT c.relname AS nome,pg_get_viewdef(c.oid,true) AS ddl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('v','m') ORDER BY c.relname`, [db]);
    const routines = mysql ? await query(`SELECT ROUTINE_NAME AS nome,ROUTINE_TYPE AS tipo,DTD_IDENTIFIER AS ritorno,ROUTINE_DEFINITION AS corpo
      FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME,ROUTINE_TYPE`, [db])
      : await query(`SELECT p.proname AS nome,pg_get_function_identity_arguments(p.oid) AS firma,pg_get_functiondef(p.oid) AS ddl
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN ('f','p') ORDER BY p.proname,firma`, [db]);
    const types = mysql ? [] : await query(`SELECT t.typname AS nome,e.enumlabel AS etichetta,e.enumsortorder AS posizione
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
      WHERE n.nspname=$1 ORDER BY t.typname,e.enumsortorder`, [db]);
    return normalize({ names, rows, columns, indexes, triggers, foreignKeys, views, routines, types }, db);
  }
  const restoreModule = require('../../backup/lib/restore'), originalRestore = restoreModule.runRestore;
  const planModule = require('../../db/importPlan'), originalPlan = planModule.eseguiPianoImport;
  planModule.eseguiPianoImport = async (plan, options) => {
    const verify = options.adapter.verify.bind(options.adapter);
    options.adapter.verify = async (currentPlan, where, staging) => {
      // La fotografia è presa dopo TUTTA l'applicazione, prima del gate e
      // della promozione: anche le dipendenze sospese devono già essere tornate.
      if (where === 'staging' && activeTarget && ownedStage(staging.db) === activeTarget) {
        stages.set(activeTarget, { db: staging.db, snapshot: await snapshot(staging.db) });
      }
      return verify(currentPlan, where, staging);
    };
    return originalPlan(plan, options);
  };
  const { runBackup } = require('../../backup/lib/engine');
  const { runRestoreViaPlan } = require('../../db/backupRestoreAdapter');
  async function database(label) {
    const db = registry.target(label); registry.assertOwned(db);
    await query(`CREATE ${mysql ? 'DATABASE' : 'SCHEMA'} ${q(db)}`); return db;
  }
  async function simple(db, name, values) {
    await query(`CREATE TABLE ${table(db, name)} (id INT PRIMARY KEY,valore INT NOT NULL)`);
    for (const [id, value] of values) await query(`INSERT INTO ${table(db, name)} VALUES (${id},${value})`);
  }
  async function backup(source) {
    return runBackup({ session: { strategy, dbType: type }, connName: 'selettivo-dipendenze', db: source,
      type: 'full', destRoot: path.join(reportDir, 'archivi'), compress: true, log });
  }
  async function restore(id, archive, target, drop, selective = true) {
    const phases = []; let result;
    activeTarget = target;
    try {
      result = await runRestoreViaPlan({ session: { strategy, dbType: type }, backupDir: archive.backupDir,
        targetDb: target, onlyCollections: selective ? ['scelta'] : null, drop, connName: 'selettivo-dipendenze',
        recoveryRoot: path.join(reportDir, 'recovery'), log, onProgress: event => phases.push(event) });
    } catch (error) { result = { status: 'eccezione', error: error.message, stack: error.stack }; }
    finally { activeTarget = null; }
    const operation = { id, target, drop, selective, result, phases, staging: stages.get(target) || null };
    report.operazioni.push(operation); return operation;
  }
  async function expectCompleted(id, operation) {
    return check(id, async () => assert.equal(operation.result.status, 'completato', operation.result.error || JSON.stringify(operation.result.verification)));
  }
  async function trigger(db) {
    if (mysql) await query(`CREATE TRIGGER ${table(db, 'tr_scelta')} BEFORE INSERT ON ${table(db, 'scelta')} FOR EACH ROW SET NEW.valore=NEW.valore+10`);
    else {
      await query(`CREATE FUNCTION ${table(db, 'f_incrementa')}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.valore:=NEW.valore+10; RETURN NEW; END$$`);
      await query(`CREATE TRIGGER tr_scelta BEFORE INSERT ON ${table(db, 'scelta')} FOR EACH ROW EXECUTE FUNCTION ${table(db, 'f_incrementa')}()`);
    }
  }
  async function triggerWorks(db) {
    await query('BEGIN');
    try {
      await query(`INSERT INTO ${table(db, 'scelta')} VALUES (999,5)`);
      assert.deepEqual(await query(`SELECT valore FROM ${table(db, 'scelta')} WHERE id=999`), [{ valore: 15 }]);
    } finally { await query('ROLLBACK'); }
  }
  const dbNames = async () => (await query(mysql ? 'SHOW DATABASES' : 'SELECT schema_name FROM information_schema.schemata')).map(row => Object.values(row)[0]);
  const dropDb = name => query(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${q(name)}${mysql ? '' : ' CASCADE'}`);
  try {
    assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1');
    if (mysql) {
      const driver = require('mysql2/promise'), config = { host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), user: 'root', password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql' };
      native = await driver.createConnection(config); strategy = new (require('../../db/MySqlStrategy'))(); strategy.pool = driver.createPool({ ...config, connectionLimit: 3 });
    } else {
      const { Client, Pool } = require('pg'), config = { host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), user: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' };
      native = new Client(config); await native.connect(); strategy = new (require('../../db/PostgreSqlStrategy'))(); strategy.pool = new Pool({ ...config, max: 3 });
    }

    // Il full positivo dimostra che la fixture del trigger è restaurabile.
    const triggerSource = await database('tr_origine'); await simple(triggerSource, 'scelta', []); await trigger(triggerSource);
    await query(`INSERT INTO ${table(triggerSource, 'scelta')} VALUES (1,1),(2,2)`);
    const triggerBefore = await snapshot(triggerSource), triggerArchive = await backup(triggerSource);
    const fullTarget = await database('tr_full');
    const full = await restore('trigger-full-controllo', triggerArchive, fullTarget, true, false);
    await expectCompleted('trigger-full-controllo-esito', full);
    await check('trigger-full-controllo-nativo', async () => { assert.deepEqual(await snapshot(fullTarget), triggerBefore); await triggerWorks(fullTarget); });
    for (const drop of [true, false]) {
      const mode = drop ? 'drop' : 'merge', target = await database('tr_' + mode);
      await simple(target, 'scelta', []); await trigger(target); await query(`INSERT INTO ${table(target, 'scelta')} VALUES (90,900)`);
      const before = await snapshot(target), operation = await restore('trigger-' + mode, triggerArchive, target, drop);
      await expectCompleted(`trigger-${mode}-esito`, operation);
      await check(`trigger-${mode}-presente-nello-staging`, async () => assert.deepEqual(operation.staging?.snapshot.triggers, triggerBefore.triggers,
        'Il ramo selettivo deve ricreare il trigger rimosso prima dei dati'));
      await check(`trigger-${mode}-dati-catalogo-nativi`, async () => {
        const expected = plain(triggerBefore); if (!drop) expected.rows.scelta.push(...before.rows.scelta);
        assert.deepEqual(await snapshot(target), expected); await triggerWorks(target);
      });
      await check(`trigger-${mode}-originale-se-rifiutato`, async () => {
        if (operation.result.status !== 'completato') { assert.deepEqual(await snapshot(target), before); assert(!operation.phases.some(event => event.phase === 'promozione')); }
      });
    }
    await check('trigger-origine-inalterata', async () => assert.deepEqual(await snapshot(triggerSource), triggerBefore));

    // FK entrante da tabella non scelta e vista locale dipendente: entrambe
    // devono sopravvivere anche quando la tabella padre viene ricreata.
    const source = await database('fk_origine'); await simple(source, 'scelta', [[1,100], [2,200]]);
    const sourceBefore = await snapshot(source), archive = await backup(source);
    for (const drop of [true, false]) {
      const mode = drop ? 'drop' : 'merge', target = await database('fk_' + mode);
      await simple(target, 'scelta', [[1,-1], [90,900]]);
      await query(`CREATE TABLE ${table(target, 'ignorata')} (id INT PRIMARY KEY,padre_id INT NOT NULL,nota VARCHAR(40),
        CONSTRAINT fk_locale FOREIGN KEY(padre_id) REFERENCES ${table(target, 'scelta')}(id) ON DELETE RESTRICT ON UPDATE CASCADE)`);
      await query(`INSERT INTO ${table(target, 'ignorata')} VALUES (10,1,'preservare')`);
      await query(`CREATE VIEW ${table(target, 'vista_locale')} AS SELECT id,valore*7 AS valore FROM ${table(target, 'scelta')}`);
      const before = await snapshot(target), operation = await restore('dipendenze-' + mode, archive, target, drop);
      await expectCompleted(`dipendenze-${mode}-esito`, operation);
      await check(`dipendenze-${mode}-dati-scelti`, async () => {
        const expected = plain(sourceBefore.rows.scelta); if (!drop) expected.push(before.rows.scelta.find(row => row.id === 90));
        assert.deepEqual((await snapshot(target)).rows.scelta, expected);
      });
      await check(`dipendenze-${mode}-fk-vista-locali`, async () => {
        const after = await snapshot(target);
        assert.deepEqual(after.rows.ignorata, before.rows.ignorata); assert.deepEqual(after.foreignKeys, before.foreignKeys); assert.deepEqual(after.views, before.views);
        assert.deepEqual(after.columns.filter(row => row.tabella === 'ignorata'), before.columns.filter(row => row.tabella === 'ignorata'));
        assert.deepEqual(after.indexes.filter(row => row.tabella === 'ignorata'), before.indexes.filter(row => row.tabella === 'ignorata'));
        assert.deepEqual(after.rows.vista_locale, after.rows.scelta.map(row => ({ id: row.id, valore: row.valore * 7 })));
        await assert.rejects(query(`INSERT INTO ${table(target, 'ignorata')} VALUES (99,999,'orfano')`), error => mysql ? error.errno === 1452 : error.code === '23503');
      });
      await check(`dipendenze-${mode}-originale-se-rifiutato`, async () => {
        if (operation.result.status !== 'completato') { assert.deepEqual(await snapshot(target), before); assert(!operation.phases.some(event => event.phase === 'promozione')); }
      });
    }
    await check('dipendenze-origine-inalterata', async () => assert.deepEqual(await snapshot(source), sourceBefore));

    // Il merge aggiorna le colonne del backup e conserva valori/default delle
    // colonne locali. La verifica indipendente deve continuare a controllarle.
    {
      const source = await database('col_origine'); await simple(source, 'scelta', [[1,100],[2,200]]);
      const target = await database('col_locale'); await simple(target, 'scelta', [[1,-1],[90,900]]);
      await query(`ALTER TABLE ${table(target, 'scelta')} ADD COLUMN nota VARCHAR(100) DEFAULT 'locale, (test)'`);
      await query(`UPDATE ${table(target, 'scelta')} SET nota='personale' WHERE id=1`);
      const before = await snapshot(target), operation = await restore('colonne-locali', await backup(source), target, false);
      await expectCompleted('colonne-locali-esito', operation);
      await check('colonne-locali-valori-default', async () => {
        assert.deepEqual(await query(`SELECT * FROM ${table(target, 'scelta')} ORDER BY id`), [
          { id: 1, valore: 100, nota: 'personale' }, { id: 2, valore: 200, nota: 'locale, (test)' },
          { id: 90, valore: 900, nota: 'locale, (test)' },
        ]);
      });
      await check('colonne-locali-schema-invariato', async () => assert.deepEqual((await snapshot(target)).columns, before.columns));
    }

    if (!mysql) {
      {
        const source = await database('default_origine'), target = await database('default_locale');
        for (const [db, factor] of [[source, 2], [target, 7]]) {
          await query(`CREATE FUNCTION ${table(db, 'calcolo locale')}(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT n*${factor}$$`);
          await query(`CREATE TABLE ${table(db, 'scelta')} (id INT PRIMARY KEY,valore INT DEFAULT ${table(db, 'calcolo locale')}(3))`);
          await query(`INSERT INTO ${table(db, 'scelta')}(id) VALUES (1)`);
        }
        const operation = await restore('routine-default', await backup(source), target, true);
        await expectCompleted('routine-default-esito', operation);
        await check('routine-default-corpo-e-dati', async () => {
          assert.deepEqual(await query(`SELECT * FROM ${table(target, 'scelta')}`), [{ id: 1, valore: 6 }]);
          await query(`INSERT INTO ${table(target, 'scelta')}(id) VALUES (2)`);
          assert.deepEqual(await query(`SELECT valore FROM ${table(target, 'scelta')} WHERE id=2`), [{ valore: 6 }]);
        });
      }
      // La routine del backup è estranea alla tabella selezionata. La versione
      // locale, usata dalla vista ignorata, deve restare anche nello staging.
      const routineSource = await database('fn_origine'); await simple(routineSource, 'scelta', [[1,100]]);
      await query(`CREATE FUNCTION ${table(routineSource, 'f_locale')}(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT n*2$$`);
      const original = await snapshot(routineSource), routineArchive = await backup(routineSource);
      const target = await database('fn_locale'); await simple(target, 'scelta', [[90,900]]); await simple(target, 'ignorata', [[10,1000]]);
      await query(`CREATE FUNCTION ${table(target, 'f_locale')}(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT n*7$$`);
      await query(`CREATE VIEW ${table(target, 'vista_locale')} AS SELECT id,${table(target, 'f_locale')}(valore) AS valore FROM ${table(target, 'ignorata')}`);
      const before = await snapshot(target), operation = await restore('routine-locale', routineArchive, target, true);
      await expectCompleted('routine-locale-esito', operation);
      await check('routine-locale-staging-preservato', async () => {
        assert.deepEqual(operation.staging?.snapshot.routines, before.routines, 'La routine non scelta non deve essere sostituita con quella del backup');
        assert.deepEqual(operation.staging.snapshot.rows.vista_locale, before.rows.vista_locale);
      });
      await check('routine-locale-dati-catalogo-nativi', async () => {
        const after = await snapshot(target); assert.deepEqual(after.rows.scelta, original.rows.scelta);
        assert.deepEqual(after.routines, before.routines); assert.deepEqual(after.views, before.views);
        assert.deepEqual(after.rows.ignorata, before.rows.ignorata); assert.deepEqual(after.rows.vista_locale, [{ id: 10, valore: 7000 }]);
      });
      await check('routine-locale-originale-se-rifiutato', async () => {
        if (operation.result.status !== 'completato') { assert.deepEqual(await snapshot(target), before); assert(!operation.phases.some(event => event.phase === 'promozione')); }
      });
      await check('routine-origine-inalterata', async () => assert.deepEqual(await snapshot(routineSource), original));

      const typeSource = await database('tipo_origine');
      await query(`CREATE TYPE ${table(typeSource, 'colore')} AS ENUM ('rosso','verde')`);
      await query(`CREATE TABLE ${table(typeSource, 'scelta')} (id INT PRIMARY KEY,valore ${table(typeSource, 'colore')} NOT NULL)`);
      await query(`INSERT INTO ${table(typeSource, 'scelta')} VALUES (1,'rosso')`);
      const typeBefore = await snapshot(typeSource), typeArchive = await backup(typeSource);
      {
        const target = await database('tipo_nuovo'); await simple(target, 'ignorata', [[10,1000]]);
        const operation = await restore('tipo-nuovo', typeArchive, target, true);
        await expectCompleted('tipo-nuovo-esito', operation);
        await check('tipo-nuovo-catalogo-dati', async () => {
          const after = await snapshot(target);
          assert.deepEqual(after.types, typeBefore.types); assert.deepEqual(after.rows.scelta, typeBefore.rows.scelta);
          assert.deepEqual(after.rows.ignorata, [{ id: 10, valore: 1000 }]);
        });
      }
      for (const conflict of [false, true]) {
        const label = conflict ? 'conflitto' : 'compatibile', target = await database('tipo_' + label);
        await query(`CREATE TYPE ${table(target, 'colore')} AS ENUM ('rosso','verde'${conflict ? ",'locale'" : ''})`);
        for (const name of ['scelta', 'ignorata']) await query(`CREATE TABLE ${table(target, name)} (id INT PRIMARY KEY,valore ${table(target, 'colore')} NOT NULL)`);
        await query(`INSERT INTO ${table(target, 'scelta')} VALUES (90,'rosso')`);
        await query(`INSERT INTO ${table(target, 'ignorata')} VALUES (10,'${conflict ? 'locale' : 'verde'}')`);
        const before = await snapshot(target), operation = await restore('tipo-' + label, typeArchive, target, true);
        if (conflict) {
          await check('tipo-conflitto-rifiuto-causale', async () => {
            assert.notEqual(operation.result.status, 'completato'); assert.match(operation.result.error, /tipo.*colore.*(divers|incompatibil)/i);
            assert(!operation.phases.some(event => event.phase === 'promozione'), 'Nessuna promozione con un tipo condiviso incompatibile');
          });
          await check('tipo-conflitto-originale-intatto', async () => assert.deepEqual(await snapshot(target), before));
        } else {
          await expectCompleted('tipo-compatibile-esito', operation);
          await check('tipo-compatibile-dati-catalogo-nativi', async () => {
            const expected = plain(before); expected.rows.scelta = typeBefore.rows.scelta; assert.deepEqual(await snapshot(target), expected);
          });
          await check('tipo-compatibile-originale-se-rifiutato', async () => {
            if (operation.result.status !== 'completato') { assert.deepEqual(await snapshot(target), before); assert(!operation.phases.some(event => event.phase === 'promozione')); }
          });
        }
      }
      await check('tipo-origine-inalterata', async () => assert.deepEqual(await snapshot(typeSource), typeBefore));
    }
  } catch (error) { report.erroreFatale = error.stack; console.error(error.stack); }
  finally {
    restoreModule.runRestore = originalRestore;
    planModule.eseguiPianoImport = originalPlan;
    if (native) {
      try {
        const owned = registry.targets();
        for (const name of await dbNames()) { const owner = ownedStage(name); if (owner) { registry.assertOwned(owner); await dropDb(name); } }
        await registry.cleanup(dropDb);
        assert.deepEqual((await dbNames()).filter(name => owned.includes(name) || ownedStage(name, owned)), [], 'Nessuna risorsa fixture residua');
        report.pulizia = 'completata';
      } catch (error) { report.errorePulizia = error.stack; }
      await native.end().catch(error => { report.erroreChiusura = error.message; });
    }
    if (strategy?.pool) await strategy.pool.end().catch(error => { report.erroreChiusura = error.message; });
    report.sorgentiStabili = sourceFiles.every(file => report.sorgenti[file] === hash(fs.readFileSync(path.resolve(__dirname, '../..', file))));
    report.ok = !report.erroreFatale && !report.errorePulizia && !report.erroreChiusura && report.sorgentiStabili && report.verifiche.every(item => item.ok);
    report.terminato = new Date().toISOString();
    fs.writeFileSync(path.join(reportDir, 'backup-selettivo-dipendenze.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
async function main() {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1'); fs.mkdirSync(reportDir, { recursive: true });
  const engines = ['mysql', 'postgresql'].filter(type => !process.env.LAB_SELETTIVO_ENGINE || process.env.LAB_SELETTIVO_ENGINE === type);
  assert(engines.length, 'Motore SQL non selezionato');
  const report = { suite: 'backup-selettivo-dipendenze', risultati: [] };
  for (const type of engines) {
    const dir = path.join(reportDir, type); fs.mkdirSync(dir, { recursive: true });
    const output = fs.createWriteStream(path.join(dir, 'console.log'));
    const child = spawn(process.execPath, [__filename, '--worker', type], { cwd: path.resolve(__dirname, '../..'), windowsHide: true,
      env: { ...process.env, LAB_REPORT_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output.write(data); process.stdout.write(data); });
    child.stderr.on('data', data => { output.write(data); process.stderr.write(data); });
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await new Promise(resolve => output.end(resolve));
    const file = path.join(dir, 'backup-selettivo-dipendenze.json');
    report.risultati.push({ exitCode, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { erroreFatale: 'Rapporto mancante' }) });
  }
  report.totali = { verifiche: report.risultati.reduce((n, result) => n + (result.verifiche || []).length, 0),
    fallite: report.risultati.reduce((n, result) => n + (result.verifiche || []).filter(check => !check.ok).length, 0) };
  report.ok = report.risultati.every(result => result.ok && result.exitCode === 0);
  fs.writeFileSync(path.join(reportDir, 'backup-selettivo-dipendenze.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
(process.argv.includes('--worker') ? worker(process.argv[process.argv.indexOf('--worker') + 1]) : main()).catch(error => { console.error(error.stack); process.exitCode = 1; });
