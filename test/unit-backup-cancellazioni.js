'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EJSON } = require('bson');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');

module.exports = (async () => {
  console.log('--- Test integrazione tombstone MongoDB ---');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-delete-chain-'));
  const database = new Map();
  const docsDi = (db, coll) => {
    const key = `${db}\0${coll}`;
    if (!database.has(key)) database.set(key, new Map());
    return database.get(key);
  };
  docsDi('origine', 'utenti').set('1', { _id: 1, nome: 'Anna' });
  docsDi('origine', 'utenti').set('2', { _id: 2, nome: 'Bruno' });

  const collection = (db, coll) => ({
    find() {
      const righe = [...docsDi(db, coll).values()];
      return { batchSize() { return this; }, async close() {}, async *[Symbol.asyncIterator]() { yield* righe; } };
    },
    async indexes() { return [{ name: '_id_', key: { _id: 1 } }]; },
    async countDocuments() { return docsDi(db, coll).size; },
    async insertMany(rows) { for (const row of rows) docsDi(db, coll).set(String(row._id), row); },
    async bulkWrite(ops) {
      for (const op of ops) {
        if (op.deleteOne) docsDi(db, coll).delete(String(op.deleteOne.filter._id));
        if (op.replaceOne) docsDi(db, coll).set(String(op.replaceOne.replacement._id), op.replaceOne.replacement);
      }
    },
    aggregate() {
      return { async toArray() { return docsDi(db, coll).size ? [{ n: docsDi(db, coll).size }] : []; } };
    },
    async createIndex() {},
    async drop() { docsDi(db, coll).clear(); },
  });
  const client = {
    db(db) {
      return {
        collection(coll) { return collection(db, coll); },
        listCollections() {
          const names = [...database.keys()].filter((key) => key.startsWith(`${db}\0`))
            .map((key) => ({ name: key.split('\0')[1], type: 'collection', options: {} }));
          return { async toArray() { return names; } };
        },
        async createCollection(coll) { docsDi(db, coll); },
      };
    },
  };
  const strategy = {
    client,
    async listCollections(db) {
      return [...database.keys()].filter((key) => key.startsWith(`${db}\0`))
        .map((key) => ({ name: key.split('\0')[1] }));
    },
    async collectionExport(db, coll, payload) {
      const rows = [...docsDi(db, coll).values()].sort((a, b) => a._id - b._id);
      const page = rows.slice(payload.skip, payload.skip + payload.limit);
      return {
        lines: page.map((row) => EJSON.stringify(row, { relaxed: true })),
        count: page.length, total: rows.length,
      };
    },
  };
  const comune = {
    session: { strategy, dbType: 'mongodb' }, connName: 'c', db: 'origine', destRoot: root,
    compress: false, level: 0, log: { info() {} },
  };
  try {
    await runBackup({ ...comune, type: 'full' });
    const sorgente = docsDi('origine', 'utenti');
    sorgente.delete('1');
    sorgente.set('2', { _id: 2, nome: 'Bruno aggiornato' });
    sorgente.set('3', { _id: 3, nome: 'Carla' });

    const inc = await runBackup({ ...comune, type: 'incremental' });
    const manifest = JSON.parse(fs.readFileSync(path.join(inc.backupDir, 'manifest.json'), 'utf8'));
    const tombstone = manifest.files.find((file) => file.kind === 'tombstones');
    assert(tombstone && tombstone.count === 1, 'il layer deve dichiarare una cancellazione');

    const summary = await runRestore({
      session: { strategy, dbType: 'mongodb' }, backupDir: inc.backupDir,
      targetDb: 'ripristino', drop: true, log: { info() {} },
    });
    assert.strictEqual(summary.equivalenza.completa, true);
    assert.strictEqual(
      EJSON.stringify([...docsDi('ripristino', 'utenti').values()], { relaxed: true }),
      EJSON.stringify([...sorgente.values()], { relaxed: true })
    );

    console.log('  OK   full → insert/update/delete → incremental → restore esatto');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
