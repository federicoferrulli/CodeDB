'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createE2eTargetRegistry } = require('./e2e-harness');
const { creaPianoImport, eseguiPianoImport } = require('../db/importPlan');
const { createImportArtifactAdapter } = require('../db/importArtifactAdapter');

async function prova(type) {
  const mongo = type === 'mongodb';
  const strategy = mongo ? new (require('../db/MongoDbStrategy'))() : new (require('../db/MySqlStrategy'))();
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_merge' });
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-merge-'));
  try {
    if (mongo) {
      const { MongoClient } = require('mongodb');
      strategy.client = await new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017').connect();
    } else {
      await strategy.connect({ host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306),
        username: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '' });
    }
    const standalone = mongo && !(await strategy.client.db('admin').command({ hello:1 })).setName;
    const scenari = ['riuscito', 'conflitto', 'verifica'];
    if (standalone) scenari.push('modifica_dopo');
    for (const scenario of scenari) {
      const db = targets.target(scenario);
      targets.assertOwned(db);
      const col = mongo && strategy.client.db(db).collection('voci');
      const table = '\u0060' + db + '\u0060.voci';
      if (!mongo) {
        await strategy.createDatabase(db);
        await strategy.pool.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, valore VARCHAR(60)) ENGINE=InnoDB');
      }
      const key = mongo ? '_id' : 'id';
      const scrivi = (id, valore) => mongo ? col.updateOne({ _id: id }, { $set: { valore } }, { upsert: true })
        : strategy.pool.query('INSERT INTO ' + table + ' VALUES (?,?) ON DUPLICATE KEY UPDATE valore=VALUES(valore)', [id, valore]);
      const leggi = async id => mongo ? (await col.findOne({ _id: id }))?.valore
        : (await strategy.pool.query('SELECT valore FROM ' + table + ' WHERE id=?', [id]))[0][0]?.valore;
      await scrivi(1, 'prima');
      const ddl = mongo ? null : await strategy.tableDdl(db, 'voci');
      const artifact = { formato:'codedb-database', versione:1, dbType:type, db:'origine', collections:[{
        name:'voci', identity:{kind:mongo?'mongodb-id':'primary-key', columns:[key]}, ddl,
        docs:[{ [key]:1, valore:'importato' }, { [key]:2, valore:'nuovo' }],
      }] };
      const plan = creaPianoImport({ artifact, expectedDbType:type, connection:'merge', targetDb:db });
      const adapter = createImportArtifactAdapter({ strategy, dbType:type, connName:'merge', recoveryRoot });
      const result = await eseguiPianoImport(plan, { adapter: { ...adapter,
        async promote(...args) {
          await scrivi(9, 'concorrente');
          if (mongo) await strategy.client.db(db).createCollection('esterna');
          else await strategy.pool.query('CREATE TABLE '+table.replace('.voci','.esterna')+' (id INT PRIMARY KEY)');
          if (scenario === 'conflitto') await scrivi(1, 'modifica concorrente');
          return adapter.promote(...args);
        },
        async verify(p, where, staging) {
          if (scenario === 'modifica_dopo' && where === 'destinazione') {
            await scrivi(1,'modifica successiva');
            return { ok:false, schemaObjects:true };
          }
          if (scenario === 'verifica' && where === 'destinazione') return { ok:false, schemaObjects:true };
          return adapter.verify(p, where, staging);
        },
      } });
      assert.equal(result.status, scenario === 'riuscito' ? 'completato' : scenario === 'modifica_dopo' ? 'intervento_richiesto' : 'ripristinato_dopo_errore', JSON.stringify(result));
      assert.equal(await leggi(9), 'concorrente', 'la scrittura esterna dopo lo staging deve sopravvivere');
      assert.equal(await leggi(1), scenario === 'riuscito' ? 'importato' : scenario === 'conflitto' ? 'modifica concorrente' : scenario === 'modifica_dopo' ? 'modifica successiva' : 'prima');
      assert.equal(await leggi(2), scenario === 'riuscito' ? 'nuovo' : undefined);
      assert.ok((await strategy.listCollections(db)).some(c => c.name === 'esterna'));
      if (result.status === 'intervento_richiesto') {
        assert.ok(/^__codedb_staging_[0-9a-f]{10}$/.test(result.staging.db.slice(-27)));
        assert.equal(result.staging.db.slice(0,-27),db.slice(0,36));
        await strategy.dropDatabase(result.staging.db);
      } else await adapter.cleanup(result);
      console.log(type, scenario, 'OK');
    }
  } finally {
    await targets.cleanup(name => strategy.dropDatabase(name));
    if (mongo) await strategy.client?.close(); else await strategy.disconnect();
    fs.rmSync(recoveryRoot, { recursive:true, force:true });
  }
}
(async () => { for (const type of ['mongodb','mysql']) await prova(type); })().catch(err => { console.error(err); process.exitCode=1; });
