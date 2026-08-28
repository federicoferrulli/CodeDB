'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari: l'export a blocchi calcola il totale (COUNT/countDocuments)
 * SOLO al primo blocco (db/MySqlStrategy.js, db/PostgreSqlStrategy.js,
 * db/MongoDbStrategy.js — collectionExport).
 *
 * collectionExport pagina un'intera tabella/collection e viene richiamato in
 * loop da chi la esporta (public/js/exportimport.js, backup/lib/engine.js,
 * db/rinominaSicura.js): un COUNT(*)/countDocuments() a OGNI blocco ripete la
 * stessa scansione dell'intera tabella tante volte quante sono i blocchi, per
 * un numero che comunque non cambia da un blocco all'altro. Si calcola quindi
 * solo al PRIMO blocco — né `skip` né `after` ricevuti — e i blocchi
 * successivi lo OMETTONO (`total: undefined`, mai azzerato): chi pagina lo
 * riusa dal primo blocco invece di aspettarselo su ognuno.
 *
 * Pool/client finti: nessun database, come test/unit-sql-metadati.js. Si
 * provano entrambi i rami di collectionExport — chiave primaria (keyset via
 * `after`) e ripiego skip/offset — perché sono due strade di codice diverse
 * che devono arrivare alla stessa decisione sul conteggio.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const { EJSON } = require('bson');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');

console.log('--- Test unitari: conteggio dell\'export su un solo blocco ---');

// Pool finto MySQL/PostgreSQL: registra le query COUNT(*) ricevute e risponde
// in base al testo. `conPk` decide se la tabella ha una chiave primaria, per
// esercitare la paginazione keyset invece del ripiego skip/offset.
function fintoPoolSql(motore, { conPk }) {
  const conteggi = [];
  const query = async (sql) => {
    const testo = typeof sql === 'string' ? sql : sql.sql;
    if (/COUNT\(\*\)/i.test(testo)) {
      conteggi.push(testo);
      const riga = { total: 3 };
      return motore === 'mysql' ? [[riga], []] : { rows: [riga] };
    }
    if (/PRIMARY/i.test(testo)) {
      const righe = conPk ? [{ name: 'id' }] : [];
      return motore === 'mysql' ? [righe, []] : { rows: righe };
    }
    // La SELECT dei dati: una riga finta, il contenuto non è oggetto del test.
    const righe = [{ id: 1 }];
    return motore === 'mysql'
      ? [righe, [{ name: 'id' }]]
      : { rows: righe, fields: [{ name: 'id' }] };
  };
  return { query, conteggi };
}

module.exports = (async () => {

for (const [motore, Strategy] of [['mysql', MySqlStrategy], ['postgresql', PostgreSqlStrategy]]) {
  for (const conPk of [false, true]) {
    const s = new Strategy();
    const { query, conteggi } = fintoPoolSql(motore, { conPk });
    s.pool = { query };
    const etichetta = conPk ? 'con chiave primaria (keyset)' : 'senza chiave primaria (skip/offset)';

    // Primo blocco: né skip né after. Il COUNT si calcola.
    const primo = await s.collectionExport('d', 't', { limit: 10 });
    assert.strictEqual(conteggi.length, 1, `${motore} ${etichetta}: il primo blocco deve calcolare il COUNT`);
    assert.strictEqual(primo.total, 3, `${motore} ${etichetta}: il primo blocco deve riportare il totale`);

    // Blocco successivo: skip avanza sempre (è così che ogni chiamante reale
    // procede, PK o no) e, quando la tabella ha una PK, arriva anche `after`.
    // Il COUNT non deve ripetersi in nessuno dei due casi.
    const after = conPk ? EJSON.stringify([1], { relaxed: true }) : null;
    const successivo = await s.collectionExport('d', 't', { limit: 10, skip: 10, after });
    assert.strictEqual(conteggi.length, 1, `${motore} ${etichetta}: il blocco successivo non deve ripetere il COUNT`);
    assert.strictEqual(successivo.total, undefined, `${motore} ${etichetta}: il blocco successivo non deve riportare un totale`);
  }
  console.log(`  OK   ${motore}: COUNT(*) solo al primo blocco, con e senza chiave primaria`);
}

// MongoDB: stessa regola su countDocuments(), gate unico su `after`.
{
  const conteggi = [];
  const mongo = new MongoDbStrategy();
  mongo.client = {
    db() {
      return {
        collection() {
          return {
            find() {
              return {
                sort() { return this; },
                limit() { return this; },
                async toArray() { return [{ _id: 1 }]; },
              };
            },
            async countDocuments() { conteggi.push(true); return 5; },
          };
        },
      };
    },
  };

  const primo = await mongo.collectionExport('d', 'c', { limit: 10 });
  assert.strictEqual(conteggi.length, 1, 'mongodb: il primo blocco deve chiamare countDocuments');
  assert.strictEqual(primo.total, 5, 'mongodb: il primo blocco deve riportare il totale');

  const after = EJSON.stringify(1, { relaxed: false });
  const successivo = await mongo.collectionExport('d', 'c', { limit: 10, after });
  assert.strictEqual(conteggi.length, 1, 'mongodb: il blocco successivo non deve richiamare countDocuments');
  assert.strictEqual(successivo.total, undefined, 'mongodb: il blocco successivo non deve riportare un totale');
  console.log('  OK   mongodb: countDocuments() solo al primo blocco');
}

})();
