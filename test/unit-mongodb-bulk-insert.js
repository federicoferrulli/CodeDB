'use strict';

// Seam pubblico della strategia MongoDB: docInsert accetta sia il documento
// usato dalla griglia sia un array EJSON usato da execute_write. Il client
// finto registra quale primitiva del driver riceve i dati, senza richiedere un
// database locale.

const assert = require('assert');
const { ObjectId } = require('mongodb');
const MongoDbStrategy = require('../db/MongoDbStrategy');

console.log('--- Test insert MongoDB singolo e multiplo ---');

module.exports = (async () => {
  const chiamate = [];
  const collection = {
    async insertOne(doc) {
      chiamate.push({ metodo: 'insertOne', docs: [doc] });
      return { insertedId: new ObjectId('64b64c0f0000000000000001') };
    },
    async insertMany(docs) {
      chiamate.push({ metodo: 'insertMany', docs });
      return {
        insertedCount: docs.length,
        insertedIds: {
          0: new ObjectId('64b64c0f0000000000000002'),
          1: new ObjectId('64b64c0f0000000000000003'),
        },
      };
    },
  };
  const strategy = new MongoDbStrategy();
  strategy.client = { db: () => ({ collection: () => collection }) };

  const risultato = await strategy.docInsert('catalogo', 'eventi', {
    doc: '[{"_id":{"$oid":"64b64c0f0000000000000011"},"quando":{"$date":"2026-08-29T00:00:00.000Z"}},'
      + '{"_id":{"$oid":"64b64c0f0000000000000012"},"totale":{"$numberLong":"9007199254740993"}}]',
  });

  assert.strictEqual(chiamate.length, 1, 'l\'array deve produrre una sola chiamata al driver');
  assert.strictEqual(chiamate[0].metodo, 'insertMany', 'l\'array deve usare insertMany');
  assert.strictEqual(chiamate[0].docs.length, 2, 'insertMany deve ricevere tutti i documenti');
  assert(chiamate[0].docs[0]._id instanceof ObjectId, 'gli ObjectId EJSON devono restare BSON');
  assert(chiamate[0].docs[0].quando instanceof Date, 'le date EJSON devono restare Date');
  assert.strictEqual(chiamate[0].docs[1].totale.toString(), '9007199254740993', 'i Long EJSON non devono perdere precisione');
  assert.strictEqual(risultato.insertedCount, 2, 'il risultato deve riportare quanti documenti sono stati inseriti');
  assert.deepStrictEqual(
    risultato.insertedIds.map((id) => JSON.parse(id).$oid),
    ['64b64c0f0000000000000002', '64b64c0f0000000000000003'],
    'il risultato deve esporre tutti gli _id inseriti in EJSON',
  );

  console.log('  OK   array EJSON -> una insertMany con risultato completo');

  const singolo = await strategy.docInsert('catalogo', 'eventi', { doc: '{"nome":"Ada"}' });
  assert.strictEqual(chiamate[1].metodo, 'insertOne', 'il documento singolo deve continuare a usare insertOne');
  assert.deepStrictEqual(chiamate[1].docs, [{ nome: 'Ada' }], 'insertOne deve ricevere il documento originale');
  assert.strictEqual(
    JSON.parse(singolo.insertedId).$oid,
    '64b64c0f0000000000000001',
    'il risultato storico insertedId deve restare invariato',
  );

  const chiamatePrimaDegliErrori = chiamate.length;
  await assert.rejects(
    () => strategy.docInsert('catalogo', 'eventi', { doc: '[]' }),
    /elenco non vuoto di documenti/,
    'un array vuoto non rappresenta un inserimento valido',
  );
  await assert.rejects(
    () => strategy.docInsert('catalogo', 'eventi', { doc: '[{"nome":"Ada"},42]' }),
    /elenco non vuoto di documenti/,
    'ogni elemento dell\'array deve essere un documento',
  );
  await assert.rejects(
    () => strategy.docInsert('catalogo', 'eventi', { doc: '[{"$date":"2026-08-29T00:00:00.000Z"}]' }),
    /elenco non vuoto di documenti/,
    'un valore BSON scalare non deve essere scambiato per un documento',
  );
  assert.strictEqual(chiamate.length, chiamatePrimaDegliErrori, 'gli array non validi non devono raggiungere il driver');

  console.log('  OK   insert singolo compatibile e array malformati rifiutati prima del driver');

  const erroreParziale = new Error('E11000 duplicate key');
  erroreParziale.result = {
    insertedCount: 1,
    insertedIds: { 0: new ObjectId('64b64c0f0000000000000004') },
  };
  const strategiaParziale = new MongoDbStrategy();
  strategiaParziale.client = {
    db: () => ({ collection: () => ({ insertMany: async () => { throw erroreParziale; } }) }),
  };
  await assert.rejects(
    () => strategiaParziale.docInsert('catalogo', 'eventi', { doc: '[{"n":1},{"n":2}]' }),
    (err) => err === erroreParziale
      && err.auditResult.insertedCount === 1
      && JSON.parse(err.auditResult.insertedIds[0]).$oid === '64b64c0f0000000000000004',
    'un errore parziale deve conservare il risultato auditabile del driver',
  );

  console.log('  OK   un fallimento parziale conserva conteggio e _id per l\'audit');
})();
