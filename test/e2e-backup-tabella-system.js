'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');
const { improntaDatabase } = require('../db/rinominaSicura');
const { createE2eTargetRegistry } = require('./e2e-harness');

(async () => {
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_system' });
  const db = targets.target('origine'), dest = targets.target('copia');
  const strategy = new (require('../db/PostgreSqlStrategy'))();
  const session = { strategy, dbType: 'postgresql' };
  const opts = { session, log: { info() {}, error() {} } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-system-'));
  const creati = [];
  try {
    await strategy.connect({ host: '127.0.0.1', port: Number(process.env.PG_PORT) || 5432,
      username: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || '', database: 'postgres' });
    for (const schema of [db, dest]) {
      targets.assertOwned(schema);
      await strategy.pool.query('CREATE SCHEMA "' + schema + '"');
      creati.push(schema);
    }
    await strategy.pool.query('CREATE TABLE "' + db + '"."system.eventi" (id int primary key)');
    await strategy.pool.query('INSERT INTO "' + db + '"."system.eventi" VALUES (42)');
    const backup = await runBackup({ ...opts, connName: 'prova', db, type: 'full', destRoot: dir });
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.backupDir, 'manifest.json'), 'utf8'));
    assert(manifest.files.some(f => f.kind === 'data' && f.collection === 'system.eventi'), 'tabella presente nel manifest');
    await runRestore({ ...opts, backupDir: backup.backupDir, targetDb: dest });
    assert.deepEqual((await strategy.pool.query('SELECT id FROM "' + dest + '"."system.eventi"')).rows, [{ id: 42 }]);
    assert.deepEqual(await improntaDatabase(strategy, db), await improntaDatabase(strategy, dest));
    await strategy.pool.query('DELETE FROM "' + dest + '"."system.eventi"');
    assert.notDeepEqual(await improntaDatabase(strategy, db), await improntaDatabase(strategy, dest));
    console.log('OK tabella SQL system.eventi nel backup, nel restore e nella verifica della copia');
  } finally {
    for (const schema of creati) await targets.drop(schema, n => strategy.dropDatabase(n));
    await strategy.disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
