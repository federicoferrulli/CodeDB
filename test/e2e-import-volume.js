'use strict';

// Porte esplicite e schemi casuali: nessun database dell'utente viene toccato.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { roundtripJson } = require('./e2e-export-formati');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');
const { EJSON, Long } = require('bson');
const quiet = { info() {}, error() {} };
const report = [];
const hash = rows => crypto.createHash('sha256').update(EJSON.stringify(rows, { relaxed: false })).digest('hex');

(async () => {
  for (const type of ['mysql', 'postgresql', 'mongodb']) {
    const port = Number(process.env[{ mysql: 'EXPORT_MYSQL_PORT', postgresql: 'EXPORT_PG_PORT', mongodb: 'EXPORT_MONGO_PORT' }[type]]);
    assert(port, 'Indicare porte di server usa-e-getta.');
    const Strategy = require(`../db/${{ mysql: 'MySql', postgresql: 'PostgreSql', mongodb: 'MongoDb' }[type]}Strategy`);
    const st = new Strategy();
    await st.connect({ host: '127.0.0.1', port, username: type === 'mysql' ? 'root' : 'postgres', password: '', database: type === 'postgresql' ? 'postgres' : undefined,
      ...(type === 'mongodb' ? { username: '', uri: `mongodb://127.0.0.1:${port}` } : {}) });
    const source = 'codedb_volume_' + crypto.randomBytes(6).toString('hex');
    const target = source + '_copy';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-sequenze-'));
    const mysql = type === 'mysql', mongo = type === 'mongodb';
    const drop = db => mongo ? st.client.db(db).dropDatabase() : st.pool.query(mysql ? `DROP DATABASE IF EXISTS \`${db}\`` : `DROP SCHEMA IF EXISTS "${db}" CASCADE`);
    const read = async db => {
      if (mongo) return st.client.db(db).collection('righe').find().sort({ _id: 1 }).toArray();
      const result = await st.pool.query(`SELECT id, valore, testo FROM ${mysql ? '`' : '"'}${db}${mysql ? '`' : '"'}.righe ORDER BY id`);
      return mysql ? result[0] : result.rows;
    };
    try {
      if (!mongo) {
        await st.pool.query(mysql ? `CREATE DATABASE \`${source}\`` : `CREATE SCHEMA "${source}"`);
        await st.pool.query(`CREATE TABLE ${mysql ? '`' : '"'}${source}${mysql ? '`' : '"'}.righe (id BIGINT PRIMARY KEY, valore DECIMAL(30,10), testo TEXT)`);
      }
      const count = Number(process.env.EXPORT_VOLUME_ROWS) || 12000;
      for (let offset = 0; offset < count; offset += 500) {
        const docs = Array.from({ length: Math.min(500, count-offset) }, (_, i) => ({
          [mongo ? '_id' : 'id']: mongo ? Long.fromString(String(9007199254740993n + BigInt(offset + i))) : String(9007199254740993n + BigInt(offset + i)),
          valore: '12345678901234567890.1234567890', testo: `riga ${offset + i} · à 🦊\n` + 'dati; '.repeat(30),
        }));
        if (mongo) await st.client.db(source).collection('righe').insertMany(docs);
        else assert.equal((await st.collectionImport(source, 'righe', { docs })).inserted, docs.length);
      }
      const before = hash(await read(source));
      const started = performance.now();
      await roundtripJson(type, port, source, target);
      const elapsed = Math.round(performance.now() - started);
      if (process.argv.includes('--mutant')) await st.pool.query(`DELETE FROM \`${target}\`.righe WHERE id='9007199254740993'`);
      const after = await read(target);
      assert.equal(after.length, count);
      assert.equal(hash(after), before, 'confronto di ogni valore, oltre ai conteggi');
      report.push({ motore: type, righe: count, roundtripMs: elapsed, hashIdentico: true });
      console.log(`  OK ${type}: ${count} righe identiche, export/upload/import/verifica ${elapsed} ms`);
      if (type === 'postgresql') {
        await st.pool.query(`CREATE TABLE "${source}".contatori (id BIGINT GENERATED ALWAYS AS IDENTITY (INCREMENT BY 5), seriale BIGSERIAL, PRIMARY KEY(id))`);
        await st.pool.query(`ALTER SEQUENCE "${source}".contatori_seriale_seq RENAME TO "Seq personale"`);
        await st.pool.query(`ALTER SEQUENCE "${source}"."Seq personale" INCREMENT BY 7`);
        await st.pool.query(`INSERT INTO "${source}".contatori DEFAULT VALUES`);
        await st.pool.query(`SELECT setval('"${source}"."Seq personale"', 101, false)`);
        const backup = await runBackup({ session: { strategy: st, dbType: type }, connName: 'e2e-volume', db: source,
          type: 'full', destRoot: root, compress: true, level: 1, log: quiet });
        await st.pool.query(`CREATE TABLE "${target}".estranea (id BIGSERIAL PRIMARY KEY)`);
        await st.pool.query(`SELECT setval('"${target}".estranea_id_seq', 701, false)`);
        for (const drop of [false, true]) {
          await runRestore({ session: { strategy: st, dbType: type }, backupDir: backup.backupDir, targetDb: target,
            onlyCollections: ['contatori'], drop, log: quiet });
          const row = (await st.pool.query(`INSERT INTO "${target}".contatori DEFAULT VALUES RETURNING id, seriale`)).rows[0];
          assert.deepEqual(row, { id: '6', seriale: '101' });
          const owner = (await st.pool.query('SELECT pg_get_serial_sequence($1,$2) AS name', [`"${target}".contatori`, 'seriale'])).rows[0].name;
          assert.equal(owner, `${target}."Seq personale"`);
        }
        assert.equal((await st.pool.query(`SELECT nextval('"${target}".estranea_id_seq')::text AS n`)).rows[0].n, '701');
        console.log('  OK PostgreSQL: restore selettivo, DROP, ownership, passo e is_called; sequenze estranee intatte');
      }
    } finally {
      await drop(source); await drop(target); await st.disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  fs.mkdirSync('test-reports/import-export-2026-10-12', { recursive: true });
  fs.writeFileSync('test-reports/import-export-2026-10-12/volume.json', JSON.stringify(report, null, 2));
})().catch(err => { console.error(err); process.exitCode = 1; });
