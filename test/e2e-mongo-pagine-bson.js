'use strict';

const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('mongodb');
const { EJSON } = require('bson');
const Strategy = require('../db/MongoDbStrategy');
const { createE2eTargetRegistry } = require('./e2e-harness');

(async () => {
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017');
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_pagine' });
  const db = targets.target('misti');
  const strategy = new Strategy();
  strategy.client = client;
  let creata = false;
  try {
    await client.connect();
    targets.assertOwned(db);
    assert(!(await client.db('admin').admin().listDatabases()).databases.some(d => d.name === db));
    const c = await client.db(db).createCollection('dati');
    creata = true;
    const ids = [...Array.from({ length: 500 }, (_, i) => i), '$campo', { k: 1 }, new ObjectId()];
    await c.insertMany(ids.map(_id => ({ _id })));
    const attesi = (await c.find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()).map(d => EJSON.stringify(d._id, { relaxed: false }));
    const letti = [];
    let after = null;
    do {
      const page = await strategy.collectionExport(db, 'dati', { limit: 500, after });
      letti.push(...page.lines.map(line => JSON.stringify(JSON.parse(line)._id)));
      after = page.nextAfter;
    } while (after && letti.length < ids.length + 1);
    assert.deepEqual(letti, attesi, 'export oltre il passaggio di tipo BSON');
    async function leggi(keyset) {
      const r = await strategy.collectionFind(db, 'dati', { limit: 2, keyset, deferCount: true });
      return r.docs.map(d => d._id);
    }
    assert.deepEqual(await leggi({ after: attesi[499] }), ['$campo', { k: 1 }]);
    assert.deepEqual(await leggi({ from: attesi[500] }), ['$campo', { k: 1 }]);
    assert.deepEqual(await leggi({ before: attesi[501] }), [499, '$campo']);
    const piano = await c.find({ $expr: { $gt: ['$_id', { $literal: 499 }] } }).sort({ _id: 1 }).limit(2).explain('executionStats');
    assert(piano.executionStats.totalKeysExamined <= 4 && piano.executionStats.totalDocsExamined <= 3,
      'il salto oltre 500 chiavi non deve rileggere le pagine precedenti');
    console.log('OK export, paginazione BSON in entrambi i sensi e scansione limitata dell’indice');
  } finally {
    if (creata) await targets.drop(db, n => client.db(n).dropDatabase());
    await client.close();
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
