'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MongoClient, Long, Decimal128, Binary, Code, BSONRegExp } = require('mongodb');
const { conSessioneExport, scaricaExport } = require('./e2e-export-formati');

// Esegue con mongosh il file effettivamente scaricato via HTTP. Il database
// casuale è sia la sorgente sia la destinazione dei replay su dati modificati.
(async () => {
  const porta = Number(process.env.EXPORT_MONGO_PORT);
  assert(porta, 'Indicare EXPORT_MONGO_PORT per un MongoDB di prova.');
  const uri = 'mongodb://127.0.0.1:' + porta;
  const client = new MongoClient(uri, { directConnection: true });
  const db = client.db('codedb_mongosh_' + randomUUID().replaceAll('-', ''));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedb-mongosh-'));
  const file = path.join(dir, 'prova.mongosh.js');
  const esegui = script => {
    const container = process.env.EXPORT_MONGO_CONTAINER;
    let risultato;
    if (container) {
      risultato = spawnSync('docker', ['exec', '-i', container, 'mongosh', '--norc', '--quiet', '--file', '/dev/stdin'],
        { input: script, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    } else {
      fs.writeFileSync(file, script);
      risultato = spawnSync(process.env.MONGOSH_BIN || 'mongosh', [uri, '--norc', '--quiet', '--file', file],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    }
    if (risultato.error) throw risultato.error;
    if (risultato.status !== 0) throw new Error(risultato.stderr || risultato.stdout);
  };
  try {
    const nome = 'listino 2026';
    const coll = db.collection(nome);
    const regole = { $jsonSchema: { bsonType: 'object', required: ['codice'] } };
    await db.createCollection(nome, { validator: regole });
    await coll.createIndex({ codice: 1 }, { unique: true, name: 'codice_unico' });
    const id = { area: 'nord', numero: Long.fromString('9007199254740993') };
    const origine = { _id: id, codice: 'A', prezzo: Decimal128.fromString('9999999999999999.01'),
      bytes: new Binary(Buffer.from([0, 255]), 128), note: 'disse "ciao"\n${ordine}',
      dettagli: { nome: 'originale' }, 'con.punto': 'campione', '$campo': 'letterale',
      tagLetterali: [{ $oid: 'letterale' }, { $numberLong: '42' }],
      codiceBson: new Code('return 7;'), regex: new BSONRegExp('(?i)abc', 'x') };
    await coll.insertMany([origine, { _id: 2, codice: 'B' }]);
    const raw = id => coll.findOne({ _id: id }, { raw: true });
    const bsonAtteso = await raw(id), secondoAtteso = await raw(2);
    await db.collection('esclusa').insertOne({ _id: 1, nota: 'presente' });
    await db.createCollection('v_listino', { viewOn: nome, pipeline: [{ $project: { codice: 1 } }] });
    await db.createCollection('sensori', { timeseries: { timeField: 'istante', metaField: 'zona' } });
    const sensori = db.collection('sensori');
    await sensori.dropIndex('zona_1_istante_1');
    await sensori.createIndex({ istante: 1 }, { name: 'per_istante' });
    // Il comando, a differenza dell'helper insertOne del driver, non aggiunge _id.
    await db.command({ insert: 'sensori', documents: [{ istante: new Date(0), zona: 'nord', n: 4 }] });
    const piani = await conSessioneExport('mongodb', porta, null, async (emit, url) => {
      const base = { db: db.databaseName, formato: 'mongosh', modalita: 'personalizzata' };
      const scarica = (collection, documenti, struttura) => scaricaExport(emit, url, {
        ...base, opzioniMongo: { collection, documenti }, selezione: { ['collection:' + nome]: { struttura, dati: true } },
      });
      const scripts = {};
      scripts.crea = await scarica('crea', 'inserisci', true);
      scripts.inserisci = await scarica('crea', 'inserisci', false);
      scripts.mantieni = await scarica('crea', 'mantieni', false);
      scripts.aggiorna = await scarica('se-assente', 'aggiorna', true);
      scripts.sostituisci = await scarica('crea', 'sostituisci', false);
      scripts.ricrea = await scarica('ricrea', 'inserisci', true);
      scripts.vista = await scaricaExport(emit, url, { ...base,
        opzioniMongo: { collection: 'ricrea' }, selezione: { 'vista:v_listino': { struttura: true } } });
      scripts.sensori = await scaricaExport(emit, url, { ...base, opzioniMongo: { collection: 'ricrea' },
        selezione: { 'collection:sensori': { struttura: true, dati: true } } });
      return scripts;
    });
    assert.throws(() => esegui(piani.crea));
    assert.throws(() => esegui(piani.inserisci), /11000|duplica/i);
    await coll.deleteOne({ _id: 2 });
    await coll.updateOne({ _id: id }, { $set: { locale: true, dettagli: { destinazione: true } } });
    await coll.insertOne({ _id: 3, codice: 'C' });
    await coll.createIndex({ locale: 1 }, { name: 'indice_locale' });
    await db.command({ collMod: nome, validator: { 'dettagli.nome': { $ne: 'originale' } } });
    esegui(piani.mantieni);
    assert.deepEqual((await coll.findOne({ _id: id }, { projection: { dettagli: 1 } })).dettagli, { destinazione: true });
    assert.deepEqual(await raw(2), secondoAtteso);
    await db.command({ collMod: nome, validator: regole });
    await coll.deleteOne({ _id: 2 });
    esegui(piani.aggiorna);
    const aggiornato = await coll.findOne({ _id: id }, { bsonRegExp: true });
    assert.deepEqual(await raw(2), secondoAtteso);
    assert.equal(aggiornato.locale, true);
    assert.deepEqual(aggiornato.dettagli, origine.dettagli);
    assert.equal(aggiornato.prezzo.toString(), origine.prezzo.toString());
    assert.equal(aggiornato.bytes.sub_type, 128);
    assert.deepEqual(aggiornato.bytes.buffer, origine.bytes.buffer);
    assert.equal(aggiornato.note, origine.note);
    assert.equal(aggiornato['con.punto'], 'campione');
    assert.equal(aggiornato.$campo, 'letterale');
    assert((await coll.indexes()).some(i => i.name === 'indice_locale'));
    await coll.deleteOne({ _id: 2 });
    esegui(piani.sostituisci);
    assert.deepEqual(await raw(id), bsonAtteso, 'la sostituzione elimina il campo locale e conserva ogni tipo BSON');
    assert.deepEqual(await raw(2), secondoAtteso);
    esegui(piani.vista);
    assert.equal(await db.collection('v_listino').countDocuments(), 3, 'la vista riusa la base implicita');
    await coll.deleteOne({ _id: 2 });
    await coll.insertOne({ _id: 4, codice: 'B' });
    for (const script of [piani.mantieni, piani.aggiorna, piani.sostituisci]) {
      assert.throws(() => esegui(script), /11000|duplica/i, 'una collisione su un altro indice resta un errore');
      assert.equal((await coll.findOne({ _id: 4 })).codice, 'B');
    }
    esegui(piani.ricrea);
    assert.equal(await coll.countDocuments(), 2);
    assert.deepEqual(await raw(id), bsonAtteso);
    assert.equal(await db.collection('esclusa').countDocuments(), 1);
    assert.deepEqual((await coll.indexes()).map(i => i.name).sort(), ['_id_', 'codice_unico']);
    assert.deepEqual((await db.listCollections({ name: nome }).next()).options.validator, regole);
    await coll.drop();
    assert.throws(() => esegui(piani.mantieni), /collection|collezione/i);
    assert.equal(await db.listCollections({ name: nome }).hasNext(), false);
    esegui(piani.aggiorna);
    assert.equal(await coll.countDocuments(), 2, 'se assente ricostruisce la collection');
    esegui(piani.sensori);
    assert.deepEqual(await sensori.find().toArray(), [{ istante: new Date(0), zona: 'nord', n: 4 }]);
    assert.deepEqual((await sensori.indexes()).map(i => i.name), ['per_istante']);
    console.log('OK export HTTP e mongosh reale: duplicati per _id, BSON, indici, selezione, viste e ricreazione.');
  } finally {
    try { await db.dropDatabase(); } finally {
      await client.close();
      fs.rmSync(file, { force: true });
      fs.rmdirSync(dir);
    }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
