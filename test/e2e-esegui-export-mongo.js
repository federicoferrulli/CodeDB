'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MongoClient, Long, Decimal128 } = require('mongodb');
const { creaPianoExport } = require('../db/exportPlan');
const { leggiCatalogoExport } = require('../db/exportCatalogo');
const { eseguiExportMongo } = require('../db/eseguiExportMongo');
const { createE2eTargetRegistry } = require('./e2e-harness');

(async () => {
  assert(process.env.EXPORT_MONGO_PORT, 'Indicare la porta del MongoDB usa-e-getta.');
  const uri = 'mongodb://127.0.0.1:' + process.env.EXPORT_MONGO_PORT;
  const sorgente = { client: new MongoClient(uri), type: 'mongodb' };
  const destinazione = { client: new MongoClient(uri), type: 'mongodb' };
  const bersagli = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_diretto' });
  const nome = bersagli.target('origine');
  const da = sorgente.client.db(nome);
  const a = destinazione.client.db(bersagli.target('copia'));
  const col = 'prezzi';
  const origine = da.collection(col), arrivo = a.collection(col);
  const zero = { inseriti: 0, mantenuti: 0, aggiornati: 0, sostituiti: 0, collectionCreate: 0, collectionRicreate: 0, visteCreate: 0, visteRicreate: 0 };
  const piano = async (documenti, collection = 'crea', modalita = 'solo-dati', selezione, db = a.databaseName) =>
    creaPianoExport({ connection: 'locale', catalogo: await leggiCatalogoExport(sorgente, 'mongodb', nome),
      formato: 'mongosh', modalita, selezione, opzioniMongo: { collection, documenti },
      ...(db && { destinazioneMongo: { tabId: 'dest', connection: 'replica', db }, idConfermaMongo: randomUUID() }) });
  const esegui = (plan, extra) => eseguiExportMongo({ sorgente, destinazione, plan, dbDestinazione: a.databaseName, ...extra });
  try {
    await da.createCollection(col);
    await origine.createIndex({ codice: 1 }, { unique: true });
    const id = { ordine: Long.fromString('9007199254740997') };
    await origine.insertMany([{ _id: id, codice: 'uno', prezzo: Decimal128.fromString('12345.678'), 'a.b': '$prezzo' }, { _id: 2, codice: 'due' }]);
    await da.createCollection('v', { viewOn: col, pipeline: [{ $project: { codice: 1 } }] });
    const full = await piano('inserisci', 'ricrea', 'struttura-e-dati');
    // Il conflitto di tipo è sull'ultimo oggetto; nemmeno il primo è creato.
    await a.createCollection('v');
    await assert.rejects(esegui(full), err => {
      assert.match(err.message, /tipo/); assert.deepEqual(err.risultato, zero); return true;
    });
    assert.equal(await a.listCollections({ name: col }).hasNext(), false);
    await a.collection('v').drop();
    const passaggi = [];
    assert.deepEqual(await esegui(full, { onProgress: p => { passaggi.push(p); } }),
      { ...zero, collectionCreate: 1, visteCreate: 1, inseriti: 2 });
    assert.equal(passaggi.at(-1).rows, 2);
    assert.deepEqual(await arrivo.findOne({ _id: id }, { raw: true }), await origine.findOne({ _id: id }, { raw: true }));
    assert.equal(await a.collection('v').countDocuments(), 2);
    assert.deepEqual(await esegui(full), { ...zero, collectionRicreate: 1, visteRicreate: 1, inseriti: 2 });
    const merge = await piano('aggiorna');
    const sostituzione = await piano('sostituisci');
    const conserva = await piano('mantieni');
    await arrivo.updateOne({ _id: id }, { $set: { locale: 'presente', prezzo: 17 } });
    await arrivo.deleteOne({ _id: 2 });
    assert.deepEqual(await esegui(conserva), { ...zero, inseriti: 1, mantenuti: 1 });
    assert.equal((await arrivo.findOne({ _id: id })).prezzo, 17);
    assert.deepEqual(await esegui(merge), { ...zero, aggiornati: 1, mantenuti: 1 });
    assert.equal((await arrivo.findOne({ _id: id })).locale, 'presente');
    assert.deepEqual(await esegui(sostituzione), { ...zero, sostituiti: 1, mantenuti: 1 });
    assert.equal((await arrivo.findOne({ _id: id })).locale, undefined);
    assert.deepEqual(await esegui(sostituzione), { ...zero, mantenuti: 2 });
    await arrivo.deleteMany({});
    await arrivo.insertOne({ _id: 99, codice: 'due' });
    await assert.rejects(esegui(conserva), err => {
      assert.match(err.message, /duplicate key/i); assert.deepEqual(err.risultato, { ...zero, inseriti: 1 }); return true;
    });
    assert.equal(await arrivo.countDocuments({}), 2);
    const nonLeggere = { client: { db() { throw new Error('I/O senza conferma del bersaglio'); } } };
    await assert.rejects(esegui(full, { dbDestinazione: nome, sorgente: nonLeggere }), /confermato nel piano/);
    const file = await piano('inserisci', 'crea', 'solo-dati', undefined, null);
    await assert.rejects(esegui(file, { sorgente: nonLeggere }), /confermato nel piano/);
    const alias = await piano('inserisci', 'ricrea', 'struttura-e-dati', undefined, nome);
    await assert.rejects(esegui(alias, { dbDestinazione: nome }), /stesso database/);
    assert.equal(await origine.countDocuments({}), 2);
    const vista = await piano('inserisci', 'ricrea', 'personalizzata', { 'vista:v': { struttura: true } }, nome);
    await assert.rejects(esegui(vista, { dbDestinazione: nome }), /stesso database/);
    // Simula una ricreazione completa fra i due cataloghi. Gli UUID disgiunti
    // non autorizzano la scrittura se i due alias raggiungono lo stesso primario.
    let sonde = 0;
    const altroCatalogo = { client: { db(dbName) {
      const reale = destinazione.client.db(dbName);
      return Object.create(reale, {
        listCollections: { value: (_filtro, opts) => ({
          async toArray() {
            assert.equal(opts.readPreference, 'primary');
            return [{ name: col, type: 'collection', info: { uuid: Buffer.alloc(16, 7) } }];
          },
        }) },
        command: { value: (cmd, opts) => {
          assert.equal(cmd.hello, 1, 'nessuna scrittura verso lo stesso primario');
          assert.equal(opts.readPreference, 'primary');
          sonde++;
          return reale.command(cmd, opts);
        } },
      });
    } } };
    await assert.rejects(esegui(alias, { destinazione: altroCatalogo, dbDestinazione: nome }), /stesso database/);
    assert.equal(sonde, 1);
    await da.createCollection('misure', { timeseries: { timeField: 'quando' } });
    await da.command({ insert: 'misure', documents: [{ quando: new Date(0), gradi: 7 }] });
    const ts = await piano('inserisci', 'crea', 'personalizzata', { 'collection:misure': { struttura: true, dati: true } });
    assert.deepEqual(await esegui(ts), { ...zero, collectionCreate: 1, inseriti: 1 });
    assert.deepEqual(await a.collection('misure').findOne({}, { raw: true }), await da.collection('misure').findOne({}, { raw: true }));
    const prima = await a.listCollections({ name: col }).next();
    const target = { client: { db: () => Object.create(a, {
      command: { value: cmd => {
        if (cmd.create === col) throw new Error('CREATE interrotta');
        return a.command(cmd);
      } },
    }) } };
    await assert.rejects(esegui(full, { destinazione: target }), err => {
      assert.match(err.message, /rimosso.*ricreazione.*CREATE interrotta/);
      assert.deepEqual(err.risultato, zero); return true;
    });
    assert(prima.info.uuid);
    assert.equal(await a.listCollections({ name: col }).hasNext(), false);
    console.log('OK copia diretta MongoDB: contatori, BSON, duplicati, preflight, alias, time-series e DDL interrotta.');
  } finally {
    try { await bersagli.cleanup(db => sorgente.client.db(db).dropDatabase()); }
    finally { await Promise.all([sorgente.client.close(), destinazione.client.close()]); }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
