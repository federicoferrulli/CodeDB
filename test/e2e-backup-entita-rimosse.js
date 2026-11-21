'use strict';

const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createE2eTargetRegistry } = require('./e2e-harness');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');
const { descriviBackup } = require('../db/backupRestoreAdapter');

(async () => {
  const t = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_entita' });
  const db = t.target('origine'), dest = t.target('dest');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-entita-'));
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017');
  const strategy = new (require('../db/MongoDbStrategy'))();
  strategy.client = client;
  const opts = { session: { strategy, dbType: 'mongodb' }, log: { info() {}, error() {} } };
  const backup = async (type, onlyCollections = null) => (await runBackup({ ...opts,
    db, type, onlyCollections, destRoot: dir, connName: 'locale' })).backupDir;
  const descrivi = d => descriviBackup(d).collections.map(c => c.name).sort();
  const creati = [];
  try {
    await client.connect();
    for (const n of [db, dest]) {
      t.assertOwned(n);
      assert(!(await client.db().admin().listDatabases()).databases.some(d => d.name === n));
      await client.db(n).createCollection('rimossa'); creati.push(n);
    }
    const c = client.db(db);
    await c.collection('rimossa').insertOne({ _id: 1 });
    await c.collection('rimossa').createIndex({ valore: 1 });
    await c.collection('viva').insertOne({ _id: 2 });
    await backup('full');
    await c.collection('rimossa').drop();
    const parziale = await backup('incremental', ['viva']);
    assert.deepEqual(descrivi(parziale), ['rimossa', 'viva']);
    const delta = await backup('incremental');
    assert.deepEqual(descrivi(delta), ['viva'], 'il piano esclude la collection rimossa');
    await runRestore({ ...opts, backupDir: delta, targetDb: dest, drop: true });
    assert.deepEqual((await client.db(dest).listCollections().toArray()).map(i => i.name), ['viva']);
    assert.equal((await client.db(dest).collection('viva').findOne())._id, 2);
    await c.collection('viva').drop();
    const vuoto = await backup('incremental');
    assert.deepEqual(descrivi(vuoto), []);
    await c.collection('rimossa').insertOne({ _id: 10 });
    const ricreata = await backup('incremental');
    assert.deepEqual(descrivi(ricreata), ['rimossa']);
    await runRestore({ ...opts, backupDir: ricreata, targetDb: dest, drop: true });
    assert.deepEqual(await client.db(dest).collection('rimossa').distinct('_id'), [10]);
    assert.deepEqual((await client.db(dest).listCollections().toArray()).map(i => i.name), ['rimossa']);
    console.log('OK selezione, rimozione, database vuoto e ricreazione in catena');
  } finally {
    for (const n of creati) await t.drop(n, name => client.db(name).dropDatabase());
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
