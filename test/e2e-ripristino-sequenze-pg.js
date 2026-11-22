'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createE2eTargetRegistry } = require('./e2e-harness');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');
const { runRestoreViaPlan } = require('../db/backupRestoreAdapter');
const log = { info() {}, error() {} };

(async () => {
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_seq' });
  const source = targets.target('origine');
  targets.assertOwned(source);
  const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-sequenze-pg-'));
  const strategy = new PostgreSqlStrategy();
  const contesto = { connName: 'sequenze', principal: require('../auth/principal').ROOT_PRINCIPAL };
  const session = { strategy: require('../auth/guardStrategy').guardStrategy(strategy, contesto), dbType: 'postgresql' };
  const recoveryRoot = path.join(destRoot, 'recupero');
  const ricevute = [];
  const piano = async args => {
    const result = await runRestoreViaPlan(args);
    ricevute.push(result);
    return result;
  };
  const sql = (schema, statement, params) => strategy.pool.query(statement.replaceAll('@', '"' + schema + '".'), params);
  async function prepara(db, nome, origine) {
    await strategy.createDatabase(db);
    await sql(db, 'CREATE TABLE @contatori (id bigint GENERATED ALWAYS AS IDENTITY (INCREMENT BY 5) PRIMARY KEY, seriale bigserial)');
    if (nome !== 'contatori_seriale_seq') await sql(db, 'ALTER SEQUENCE @contatori_seriale_seq RENAME TO "' + nome + '"');
    await sql(db, 'ALTER SEQUENCE @"' + nome + '" INCREMENT BY 7');
    await sql(db, 'INSERT INTO @contatori (seriale) VALUES ($1)', [origine ? 1 : 888]);
    await sql(db, 'SELECT setval(pg_get_serial_sequence($1,$2), $3, false)', [db + '.contatori', 'seriale', origine ? 101 : 909]);
    await sql(db, 'CREATE SEQUENCE @libera START WITH 13');
    await sql(db, "SELECT setval('@libera', $1, false)", [origine ? 123 : 987]);
    if (!origine) {
      await sql(db, 'CREATE TABLE @estranea (id bigint PRIMARY KEY)');
      await sql(db, 'INSERT INTO @estranea VALUES (701)');
    }
  }
  try {
    await strategy.connect({ host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
      username: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || '', database: process.env.PGDATABASE || 'postgres' });
    for (const nome of ['contatori_seriale_seq', 'Seq personale']) {
      await prepara(source, nome, true);
      const backup = await runBackup({ session, connName: 'sequenze', db: source, type: 'full', destRoot, compress: false, log });
      for (const [percorso, restore] of [['diretto', runRestore], ['piano', piano]]) {
        for (const onlyCollections of [null, ['contatori']]) {
          const targetDb = targets.target(percorso + (onlyCollections ? '_selettivo' : '_intero'));
          // Una sequenza rinominata nell'origine deve sostituire anche il
          // vecchio nome standard ancora presente in destinazione.
          await prepara(targetDb, 'contatori_seriale_seq', false);
          await sql(targetDb, 'ALTER SEQUENCE @contatori_id_seq INCREMENT BY 9');
          await sql(targetDb, 'ALTER SEQUENCE @contatori_seriale_seq INCREMENT BY 13');
          const oid = (await sql(targetDb, "SELECT '@contatori_seriale_seq'::regclass::oid AS n")).rows[0].n;
          const args = { session, backupDir: backup.backupDir, recoveryRoot, targetDb, drop: true, onlyCollections, log };
          const result = await restore(args);
          if (percorso === 'piano') assert.equal(result.status, 'completato', JSON.stringify(result));
          assert.deepEqual((await sql(targetDb, 'SELECT id, seriale FROM @contatori')).rows, [{ id: '1', seriale: '1' }]);
          const owned = await sql(targetDb, 'SELECT pg_get_serial_sequence($1,$2)::regclass::oid = $3::regclass::oid AS corretta',
            [targetDb + '.contatori', 'seriale', targetDb + '."' + nome + '"']);
          assert.equal(owned.rows[0].corretta, true);
          if (percorso === 'piano') assert.equal((await sql(targetDb, 'SELECT $1::regclass::oid AS n', [targetDb + '."' + nome + '"'])).rows[0].n, oid);
          const inserisci = () => sql(targetDb, 'INSERT INTO @contatori DEFAULT VALUES RETURNING id, seriale');
          assert.deepEqual((await inserisci()).rows[0], { id: '6', seriale: '101' });
          assert.deepEqual((await inserisci()).rows[0], { id: '11', seriale: '108' });
          if (onlyCollections) assert.deepEqual((await sql(targetDb, 'SELECT id FROM @estranea')).rows, [{ id: '701' }]);
          assert.deepEqual((await sql(targetDb, 'SELECT last_value, is_called FROM @libera')).rows[0],
            { last_value: onlyCollections ? '987' : '123', is_called: false });
          await strategy.dropDatabase(targetDb);
          console.log(percorso, onlyCollections ? 'selettivo' : 'integrale', nome, 'OK');
        }
      }
      const targetDb = targets.target('annullamento');
      await prepara(targetDb, nome, false);
      // Un errore dopo il ripristino dei contatori deve annullare insieme DDL, dati e setval.
      const logErrore = { ...log, info(msg) { if (msg.includes('Verifica finale')) throw new Error('errore finale di prova'); } };
      await assert.rejects(runRestore({ session, backupDir: backup.backupDir, targetDb, drop: true, log: logErrore }), /errore finale di prova/);
      const annullato = await piano({ session, backupDir: backup.backupDir, recoveryRoot, targetDb, drop: true, log,
        onProgress(event) {
          if (event.phase === 'verifica_finale' && event.status === 'completata') throw new Error('errore prima del commit');
        } });
      assert.equal(annullato.status, 'ripristinato_dopo_errore', JSON.stringify(annullato));
      assert.equal(annullato.error, 'errore prima del commit');
      assert.deepEqual((await sql(targetDb, 'SELECT id, seriale FROM @contatori')).rows, [{ id: '1', seriale: '888' }]);
      assert.deepEqual((await sql(targetDb, 'INSERT INTO @contatori DEFAULT VALUES RETURNING id, seriale')).rows[0], { id: '6', seriale: '909' });
      assert.deepEqual((await sql(targetDb, 'SELECT last_value, is_called FROM @libera')).rows[0], { last_value: '987', is_called: false });
      await strategy.dropDatabase(targetDb);
      const conflitto = targets.target('omonima');
      await prepara(conflitto, nome, false);
      await sql(conflitto, 'ALTER SEQUENCE @"' + nome + '" OWNED BY @estranea.id');
      await sql(conflitto, 'ALTER TABLE @contatori ALTER COLUMN seriale DROP DEFAULT');
      const args = { session, backupDir: backup.backupDir, recoveryRoot, targetDb: conflitto, drop: true, onlyCollections: ['contatori'], log };
      await assert.rejects(runRestore(args), /sequenza.*estranea/i);
      const rifiutato = await piano(args);
      assert.equal(rifiutato.status, 'ripristinato_dopo_errore');
      assert.match(rifiutato.error, /sequenza.*estranea/i);
      assert.deepEqual((await sql(conflitto, 'SELECT seriale FROM @contatori')).rows, [{ seriale: '888' }]);
      const esterna = await sql(conflitto, 'SELECT pg_get_serial_sequence($1,$2)::regclass::oid = $3::regclass::oid AS sua',
        [conflitto + '.estranea', 'id', conflitto + '."' + nome + '"']);
      assert.equal(esterna.rows[0].sua, true);
      assert.deepEqual((await sql(conflitto, 'SELECT last_value, is_called FROM @"' + nome + '"')).rows[0], { last_value: '909', is_called: false });
      await strategy.dropDatabase(conflitto);
      await strategy.dropDatabase(source);
    }
  } finally {
    try {
      const adapter = require('../db/backupRestoreAdapter').createBackupRestoreAdapter({ ...session, connName: 'sequenze', recoveryRoot, log });
      for (const result of ricevute) await adapter.cleanup(result);
      if (strategy.pool) await targets.cleanup(name => strategy.pool.query('DROP SCHEMA IF EXISTS "' + name + '" CASCADE'));
    }
    finally { await strategy.disconnect(); fs.rmSync(destRoot, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
