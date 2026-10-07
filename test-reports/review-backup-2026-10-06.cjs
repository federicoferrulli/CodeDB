'use strict';

// Diagnostica isolata: motore backup/restore reale, MongoDB simulato in memoria.
// FAIL segnala un contratto violato. Nessuna connessione o configurazione utente.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ObjectId } = require('bson');
const { stringifyRiga } = require('../db/codecFedele');
const { runBackup } = require('../backup/lib/engine');
const { runRestore } = require('../backup/lib/restore');
const { descriviBackup } = require('../db/backupRestoreAdapter');
const risultati = [];
const tipo = process.argv.includes('--differential') ? 'differential' : 'incremental';

async function scenario(nome, modifica, verifica, sinceField = 'updatedAt') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-review-backup-'));
  const database = new Map();
  const key = (db, coll) => `${db}\0${coll}`;
  const dati = (db, coll) => {
    if (!database.has(key(db, coll))) database.set(key(db, coll), {
      docs: new Map(), indexes: [{ name: '_id_', key: { _id: 1 } }],
    });
    return database.get(key(db, coll));
  };
  const nomi = db => [...database.keys()].filter(k => k.startsWith(`${db}\0`))
    .map(k => ({ name: k.split('\0')[1], type: 'collection', options: {} }));
  const id = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 86400);
  dati('origine', 'utenti').docs.set(String(id), { _id: id, nome: 'Prima', updatedAt: new Date(0) });
  dati('origine', 'archivio').docs.set(String(id), { _id: id, nome: 'Storico', updatedAt: new Date(0) });
  const collection = (db, coll) => ({
    find(filter = {}) {
      const righe = [...dati(db, coll).docs.values()].filter(row =>
        Object.entries(filter).every(([field, condition]) => {
          const expected = condition.$gt;
          assert(expected instanceof ObjectId || expected instanceof Date, 'Filtro simulato non supportato');
          return expected instanceof ObjectId
            ? row[field] instanceof ObjectId && row[field].toHexString() > expected.toHexString()
            : row[field] instanceof Date && row[field] > expected;
        }));
      return { batchSize() { return this; }, async close() {}, async *[Symbol.asyncIterator]() { yield* righe; } };
    },
    async indexes() { return dati(db, coll).indexes; },
    async countDocuments() { return dati(db, coll).docs.size; },
    async insertMany(rows) { for (const row of rows) dati(db, coll).docs.set(String(row._id), row); },
    async bulkWrite(ops) {
      for (const op of ops) {
        if (op.deleteOne) dati(db, coll).docs.delete(String(op.deleteOne.filter._id));
        if (op.replaceOne) {
          const row = op.replaceOne.replacement;
          dati(db, coll).docs.set(String(row._id), row);
        }
      }
    },
    aggregate() { return { async toArray() { return [{ n: dati(db, coll).docs.size }]; } }; },
    async createIndex(indexKey, opts) { dati(db, coll).indexes.push({ key: indexKey, ...opts }); },
    async drop() { database.delete(key(db, coll)); },
  });
  const client = { db(db) { return {
    collection: coll => collection(db, coll),
    listCollections() { return { async toArray() { return nomi(db); } }; },
    async createCollection(coll) { dati(db, coll); },
    async command(cmd) { assert(cmd.hello); return { isWritablePrimary: true }; },
  }; } };
  const strategy = {
    client,
    async listCollections(db) { return nomi(db); },
    async collectionExport(db, coll, payload) {
      const rows = [...dati(db, coll).docs.values()];
      const page = rows.slice(payload.skip, payload.skip + payload.limit);
      return { lines: page.map(stringifyRiga), count: page.length, total: rows.length };
    },
  };
  const session = { strategy, dbType: 'mongodb' };
  const log = { info() {} };
  try {
    const common = { session, connName: 'review', db: 'origine', destRoot: root, compress: false, log };
    const full = await runBackup({ ...common, type: 'full' });
    const controllo = await runRestore({ session, backupDir: full.backupDir, targetDb: 'controllo', drop: true, log });
    assert.equal(controllo.problems.length, 0);
    assert.equal(dati('controllo', 'utenti').docs.get(String(id)).nome, 'Prima');
    await modifica({ dati, database, key, id });
    const inc = await runBackup({ ...common, type: tipo, sinceField });
    const summary = await runRestore({ session, backupDir: inc.backupDir, targetDb: 'ripristino', drop: true, log });
    const osservato = {
      equivalenza: summary.equivalenza, problems: summary.problems,
      nomeRipristinato: dati('ripristino', 'utenti').docs.get(String(id)).nome,
      collezioni: nomi('ripristino').map(x => x.name),
      indici: dati('ripristino', 'utenti').indexes.map(x => x.name),
      piano: descriviBackup(inc.backupDir).collections.map(x => x.name),
    };
    try {
      verifica(osservato);
      risultati.push({ nome, esito: 'PASS', osservato });
    } catch (err) {
      if (err.code !== 'ERR_ASSERTION') throw err;
      risultati.push({ nome, esito: 'FAIL', dettaglio: err.message, osservato });
    }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('codedb-review-backup-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const modificaNome = ({ dati, id }) => {
    dati('origine', 'utenti').docs.set(String(id), { _id: id, nome: 'Dopo', updatedAt: new Date() });
  };
  const verificaNome = r => assert.equal(r.nomeRipristinato, 'Dopo', 'Il restore deve conservare la modifica');
  await scenario('CDB-F09: aggiornamento con incrementale Mongo predefinito', modificaNome, verificaNome, null);
  // Sensibilita: lo stesso controllo deve passare quando la selezione include la modifica.
  await scenario('Controllo: campo updatedAt mantenuto correttamente', modificaNome, verificaNome);
  await scenario('CDB-F10: collezione eliminata dopo il full', ({ database, key }) => {
    database.delete(key('origine', 'archivio'));
  }, r => assert(!r.collezioni.includes('archivio'), 'La collezione eliminata non deve ricomparire'));
  await scenario('CDB-F11: indice UNIQUE creato dopo il full', ({ dati }) => {
    dati('origine', 'utenti').indexes.push({ name: 'nome_unique', key: { nome: 1 }, unique: true });
  }, r => assert(r.indici.includes('nome_unique'), 'Il restore deve conservare il nuovo vincolo UNIQUE'));
  console.log(JSON.stringify({ tipo, risultati }, null, 2));
  process.exitCode = risultati.some(r => r.esito === 'FAIL') ? 1 : 0;
})().catch(err => { console.error('ERRORE DEL RUNNER', err); process.exitCode = 2; });
