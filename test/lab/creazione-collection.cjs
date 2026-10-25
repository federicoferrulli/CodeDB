'use strict';
const { formattaOutputMutante } = require('./output-mutanti.cjs');

// LAB011: handler registrato e strategia veri, catalogo e comportamento letti
// con il driver Mongo indipendente; database casuale posseduto dalla fixture.
// CODEDB_E2E_DESTRUCTIVE=1 node test/lab/creazione-collection.cjs [--sensitivity]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const { catalogoEventi } = require('../server-fixture');
const { createE2eTargetRegistry } = require('../e2e-harness');
const MyStrategy = require('../../db/MongoDbStrategy');
const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/fix-audit-2026-10-22/lab-011/creazione-collection');
const handler = catalogoEventi().find(item => item.evento === 'collection:create')?.handler;
const report = { suite: 'creazione-collection', iniziato: new Date().toISOString(), risultati: [], sensibilita: [], sorgenti: {} };
for (const file of ['server/eventi-dati.js', 'db/MongoDbStrategy.js', 'test/lab/creazione-collection.cjs']) {
  report.sorgenti[file] = createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../..', file))).digest('hex');
}
const canonical = value => EJSON.serialize(value, { relaxed: false });
const cases = [
  { name: 'semplice', options: {}, async prove(collection) {
    await collection.insertOne({ _id: 1, quantita: 7 }); assert.deepEqual(await collection.find({}).toArray(), [{ _id: 1, quantita: 7 }]);
  } },
  { name: 'validator', options: { validator: { $jsonSchema: { bsonType: 'object', required: ['quantita'],
    properties: { quantita: { bsonType: 'int', minimum: 0 } } } }, validationLevel: 'strict', validationAction: 'error' },
  async prove(collection) {
    await collection.insertOne({ _id: 1, quantita: 7 });
    for (const document of [{ _id: 2, quantita: 'sette' }, { _id: 3 }, { _id: 4, quantita: -1 }]) {
      await assert.rejects(collection.insertOne(document), error => error.code === 121, '[COLLECTION-VALIDATOR] Mongo rifiuta tipo, campo mancante e valore negativo');
    }
    assert.equal(await collection.countDocuments(), 1);
  } },
  { name: 'collation', options: { collation: { locale: 'it', strength: 1 } }, async prove(collection) {
    await collection.createIndex({ nome: 1 }, { unique: true });
    await collection.insertOne({ _id: 1, nome: 'caffè' });
    assert.deepEqual((await collection.find({ nome: 'CAFFE' }).toArray()).map(row => row._id), [1], '[COLLECTION-COLLATION] uguaglianza nativa accent/case insensitive');
    await assert.rejects(collection.insertOne({ _id: 2, nome: 'CAFFE' }), error => error.code === 11000);
    assert.equal(await collection.countDocuments(), 1);
  } },
  { name: 'capped', options: { capped: true, size: 4096, max: 2 }, async prove(collection) {
    await collection.insertMany([1, 2, 3].map(_id => ({ _id, testo: 'contenuto verificato' })));
    assert.deepEqual((await collection.find({}).sort({ $natural: 1 }).toArray()).map(row => row._id), [2, 3], '[COLLECTION-CAPPED] il limite nativo conserva gli ultimi due documenti');
    assert.equal(await collection.countDocuments(), 2);
  } },
];
async function run(mutant) {
  const registry = createE2eTargetRegistry({ destructive: true, prefix: 'lab_create' });
  const db = registry.target('mongo'), client = new MongoClient(`mongodb://127.0.0.1:${Number(process.env.LAB_MONGO_PORT || 37017)}/?directConnection=true`, { serverSelectionTimeoutMS: 6000 });
  const result = { mutante: mutant, verifiche: [], mutazioni: 0 };
  try {
    await client.connect(); const strategy = new MyStrategy(); strategy.client = client;
    if (mutant) {
      const original = strategy.createCollection.bind(strategy);
      strategy.createCollection = (database, name, options) => {
        result.mutazioni++; return original(database, name, { ...options, db: database, name, tabId: 'scheda-fixture' });
      };
    }
    for (const scenario of cases) {
      const entry = { id: scenario.name, ok: false };
      try {
        const control = await client.db(db).createCollection(`${scenario.name}_controllo`, scenario.options);
        await scenario.prove(control);
        const expected = (await client.db(db).listCollections({ name: control.collectionName }).toArray())[0].options;
        entry.oracoloControllo = { catalogo: canonical(expected), comportamento: 'verificato' };
        const payload = { db, name: scenario.name, tabId: 'scheda-fixture',
          runId: 'creazione-fixture', opHandle: { runId: 'creazione-fixture' },
          run: { contesto: 'solo-server' }, sessions: { contesto: 'solo-server' }, ...scenario.options };
        const before = JSON.stringify(payload); let response, error;
        try { response = await handler(strategy, payload, { dbType: 'mongodb' }); } catch (failure) { error = failure; }
        const actual = await client.db(db).listCollections({ name: scenario.name }).toArray();
        entry.handler = { response, error: error?.message, code: error?.code, catalogo: canonical(actual.map(item => item.options)) };
        assert(!error, `[COLLECTION-HANDLER] opzioni native valide rifiutate: ${error?.message}; collection persistite=${actual.length}`);
        assert.deepEqual(response, {}); assert.equal(JSON.stringify(payload), before);
        assert.equal(actual.length, 1, '[COLLECTION-CATALOGO] esattamente una collection nel DB di destinazione');
        assert.deepEqual(canonical(actual[0].options), canonical(expected), '[COLLECTION-OPZIONI] opzioni native preservate integralmente');
        await scenario.prove(client.db(db).collection(scenario.name)); entry.ok = true;
      } catch (error) { entry.errore = error.stack; }
      result.verifiche.push(entry); console.log(formattaOutputMutante(mutant ? 'metadata-reinoltrati' : null,
        `${entry.ok ? 'OK' : 'FAIL'} ${mutant ? 'mutante' : 'controllo'}/${scenario.name}${entry.ok ? '' : ': ' + entry.errore.split('\n')[0]}`));
    }
  } catch (error) { result.erroreFatale = error.stack; }
  finally {
    try { await registry.cleanup(database => client.db(database).dropDatabase()); result.pulizia = 'completata'; }
    catch (error) { result.errorePulizia = error.stack; }
    await client.close();
  }
  result.ok = !result.erroreFatale && !result.errorePulizia && result.verifiche.length === 4 && result.verifiche.every(item => item.ok);
  return result;
}
(async () => {
  assert.equal(process.env.CODEDB_E2E_DESTRUCTIVE, '1', 'Serve CODEDB_E2E_DESTRUCTIVE=1');
  fs.mkdirSync(reportDir, { recursive: true });
  report.risultati = await run(false);
  if (process.argv.includes('--sensitivity')) {
    const result = await run(true), failures = result.verifiche.filter(item => !item.ok);
    report.sensibilita.push({ mutante: 'metadata-reinoltrati', risultato: result, rilevata: result.mutazioni === 4 && !result.erroreFatale && !result.errorePulizia
      && failures.length === 4 && failures.every(item => item.oracoloControllo && item.errore.includes('[COLLECTION-HANDLER]')) });
  }
  report.ok = report.risultati.ok && report.sensibilita.every(item => item.rilevata); report.terminato = new Date().toISOString();
  fs.writeFileSync(path.join(reportDir, 'creazione-collection.json'), JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
