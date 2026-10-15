'use strict';
require('./sql-native-dns.cjs');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { setTimeout: delay } = require('node:timers/promises');
// Fra nodi si usa la rete Docker, senza tornare attraverso il port forwarding Windows.
const config = { _id: 'codedbtest', members: [27039, 27040, 27041].map((port, _id) => ({ _id, host: `codedb-sql-node-${port}:${port}` })) };
(async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27039/?directConnection=true', { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const admin = client.db('admin');
    try {
      const current = (await admin.command({ replSetGetConfig: 1 })).config;
      assert.equal(current._id, config._id);
      assert.deepEqual(current.members.map(m => m.host), config.members.map(m => m.host));
    } catch (err) {
      if (err.code !== 94) throw err;
      await admin.command({ replSetInitiate: config });
    }
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const status = await admin.command({ replSetGetStatus: 1 });
      if (status.members.length === 3 && status.members.some(m => m.state === 1)
          && status.members.every(m => m.health === 1 && [1, 2].includes(m.state))) {
        console.log('OK replica set di prova: un primario e due secondari'); return;
      }
      await delay(200);
    }
    throw new Error('Replica set di prova non pronto entro 30 secondi');
  } finally { await client.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
