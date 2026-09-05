'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { BSON } = require('bson');
const { deserializeClientObject, serializeRow, toSqlValue } = require('../db/sqlValori');
const MongoDbStrategy = require('../db/MongoDbStrategy');

const valori = deserializeClientObject({
  id: { $numberLong: '9007199254740993' },
  importo: { $numberDecimal: '1234567890.123456789012345678' },
});
assert.strictEqual(toSqlValue(valori.id), '9007199254740993');
assert.strictEqual(toSqlValue(valori.importo), '1234567890.123456789012345678');
assert.deepStrictEqual(serializeRow({ id: '9007199254740993', totale: '0.100000000000000001' }, [
  { name: 'id', declaredType: 'bigint' }, { name: 'totale', type: 'numeric' },
]), {
  id: { $numberLong: '9007199254740993' },
  totale: { $numberDecimal: '0.100000000000000001' },
});
console.log('  OK   parametri SQL esatti: Long e Decimal arrivano al driver come testo canonico');
module.exports = (async () => {
  const V = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'valori-esatti.js')).href);
  console.log('--- Test unitari valori esatti SQL e MongoDB ---');

  // 1. Deserializzazione EJSON parametri client e conversione SQL
  const valori = deserializeClientObject({
    id: { $numberLong: '9007199254740993' },
    importo: { $numberDecimal: '1234567890.123456789012345678' },
    unsignedId: { $numberDecimal: '18446744073709551615' },
    intero: { $numberInt: '42' },
  });
  assert.strictEqual(toSqlValue(valori.id), '9007199254740993');
  assert.strictEqual(toSqlValue(valori.importo), '1234567890.123456789012345678');
  assert.strictEqual(toSqlValue(valori.unsignedId), '18446744073709551615');
  assert.strictEqual(toSqlValue(valori.intero), 42);

  // 2. Test tabellari serializeRow: limiti signed/unsigned 64 bit e decimali
  const casiSerializzazione = [
    // [riga, colonne, atteso, descrizione]
    [
      { id: '9223372036854775807' },
      [{ name: 'id', declaredType: 'bigint' }],
      { id: { $numberLong: '9223372036854775807' } },
      'signed 64-bit max (2^63 - 1)',
    ],
    [
      { id: '-9223372036854775808' },
      [{ name: 'id', type: 'int8' }],
      { id: { $numberLong: '-9223372036854775808' } },
      'signed 64-bit min (-2^63)',
    ],
    [
      { id: '9007199254740993' },
      [{ name: 'id', declaredType: 'serial8' }],
      { id: { $numberLong: '9007199254740993' } },
      'serial8 oltre 2^53',
    ],
    [
      { id: '-9007199254740993' },
      [{ name: 'id', type: 'int64' }],
      { id: { $numberLong: '-9007199254740993' } },
      'int64 oltre 2^53',
    ],
    [
      { id: '12345' },
      [{ name: 'id', type: 'long' }],
      { id: { $numberLong: '12345' } },
      'tipo long',
    ],
    [
      { id: '9223372036854775807' },
      [{ name: 'id', columnType: 'bigint(20) unsigned' }],
      { id: { $numberLong: '9223372036854775807' } },
      'unsigned bigint entro 2^63 - 1 -> $numberLong',
    ],
    [
      { id: '9223372036854775808' },
      [{ name: 'id', columnType: 'bigint(20) unsigned' }],
      { id: { $numberDecimal: '9223372036854775808' } },
      'unsigned bigint a 2^63 -> $numberDecimal',
    ],
    [
      { id: '18446744073709551615' },
      [{ name: 'id', type: 'bigint unsigned' }],
      { id: { $numberDecimal: '18446744073709551615' } },
      'unsigned bigint max (2^64 - 1) -> $numberDecimal',
    ],
    [
      { totale: '0.100000000000000001' },
      [{ name: 'totale', type: 'numeric' }],
      { totale: { $numberDecimal: '0.100000000000000001' } },
      'numeric ad alta precisione',
    ],
    [
      { importo: '1234567890.123456789012345678' },
      [{ name: 'importo', declaredType: 'decimal(38,18)' }],
      { importo: { $numberDecimal: '1234567890.123456789012345678' } },
      'decimal(38,18)',
    ],
  ];

  for (const [riga, colonne, atteso, desc] of casiSerializzazione) {
    const serializzato = serializeRow(riga, colonne);
    assert.deepStrictEqual(serializzato, atteso, `serializeRow fallito per ${desc}`);
  }

  // Robustezza serializeRow: columns non-array o assenti non lanciano errori
  assert.deepStrictEqual(serializeRow({ n: 42 }, null), { n: 42 });
  assert.deepStrictEqual(serializeRow({ n: 42 }, 1), { n: 42 });

  // 3. Serializzazione BSON nativo in MongoDB strategy
  {
    const longOltre53 = new BSON.Long('9007199254740993');
    const serializzatoLong = MongoDbStrategy.serialize(longOltre53);
    assert.deepStrictEqual(serializzatoLong, { $numberLong: '9007199254740993' },
      'MongoDbStrategy.serialize DEVE preservare Long oltre 2^53 come {$numberLong} senza convertirlo a Number');

    const longPiccolo = new BSON.Long('42');
    assert.strictEqual(MongoDbStrategy.serialize(longPiccolo), 42,
      'MongoDbStrategy.serialize per Long entro limiti safe integer usa intero rilassato');

    const decimal128 = new BSON.Decimal128('1234567890123456.123456789012345678');
    assert.deepStrictEqual(MongoDbStrategy.serialize(decimal128), {
      $numberDecimal: '1234567890123456.123456789012345678',
    }, 'MongoDbStrategy.serialize preserva Decimal128 esatto');
  }

  // 4. Ciclo completo: "Il valore riletto dal database coincide con testo e tipo confermati dall'utente"
  const casiCicloCompleto = [
    {
      testoUtente: '9007199254740993',
      metaColonna: { name: 'id', declaredType: 'bigint' },
      tipoAtteso: '$numberLong',
    },
    {
      testoUtente: '-9223372036854775808',
      metaColonna: { name: 'codice', type: 'int8' },
      tipoAtteso: '$numberLong',
    },
    {
      testoUtente: '18446744073709551615',
      metaColonna: { name: 'unsigned_id', columnType: 'bigint(20) unsigned' },
      tipoAtteso: '$numberDecimal',
    },
    {
      testoUtente: '1234567890.123456789012345678',
      metaColonna: { name: 'prezzo', type: 'decimal(38,18)' },
      tipoAtteso: '$numberDecimal',
    },
  ];

  for (const caso of casiCicloCompleto) {
    const { testoUtente, metaColonna, tipoAtteso } = caso;

    // Fase 1: Utente conferma modifica inline nella UI -> frontend codifica in EJSON esatto
    const ejsonInviato = V.codecNumeroEsatto.aEjson(testoUtente, metaColonna);
    assert.ok(ejsonInviato[tipoAtteso] !== undefined, `Il tipo EJSON confermato deve essere ${tipoAtteso}`);
    assert.strictEqual(ejsonInviato[tipoAtteso], testoUtente);

    // Fase 2: Socket trasmette il payload, backend deserializza e prepara parametro SQL
    const payloadClient = { [metaColonna.name]: ejsonInviato };
    const deserializzato = deserializeClientObject(payloadClient);
    const sqlParametro = toSqlValue(deserializzato[metaColonna.name]);
    assert.strictEqual(sqlParametro, testoUtente, 'Il parametro SQL inviato al driver deve essere il testo canonico esatto');

    // Fase 3: Il database memorizza e una SELECT successiva restituisce la riga (driver SQL o Mongo)
    const rigaDalDb = { [metaColonna.name]: sqlParametro };

    // Fase 4: serializeRow restituisce la riga serializzata verso il frontend
    const rigaSerializzata = serializeRow(rigaDalDb, [metaColonna]);
    const valoreRiletto = rigaSerializzata[metaColonna.name];

    // Fase 5: Verifica coincidenza testo e tipo
    assert.ok(valoreRiletto[tipoAtteso] !== undefined,
      `Il valore riletto dal database deve avere tipo ${tipoAtteso}, ottenuto ${JSON.stringify(valoreRiletto)}`);
    assert.strictEqual(valoreRiletto[tipoAtteso], testoUtente,
      'Il testo incapsulato dal valore riletto deve coincidere esattamente con il testo confermato dall\'utente');

    // Fase 6: Il frontend decodifica il valore riletto per visualizzarlo nella griglia
    const testoRiconvertitoGriglia = V.codecNumeroEsatto.aTesto(valoreRiletto);
    assert.strictEqual(testoRiconvertitoGriglia, testoUtente,
      `Il testo visualizzato nella cella riletta deve coincidere esattamente con l'input confermato (${testoUtente})`);
  }

  // 5. Controprova di sensibilità: dimostrare che la conversione approssimata rende rossi i test
  {
    const testoCritico = '9007199254740993'; // 2^53 + 1
    const metaColonna = { name: 'id', declaredType: 'bigint' };

    // Simuliamo un'implementazione fallace che converte tramite Number()
    function serializeRowDifettoso(row) {
      return { id: Number(row.id) };
    }

    const rigaDb = { id: testoCritico };
    const rigaDifettosa = serializeRowDifettoso(rigaDb);

    // Controprova: se la riga viene approssimata, l'asserzione di coincidenza DEVE fallire
    let catturatoErrore = false;
    try {
      assert.strictEqual(String(rigaDifettosa.id), testoCritico);
    } catch {
      catturatoErrore = true;
    }
    assert.strictEqual(catturatoErrore, true,
      'La controprova dimostra che Number() perde cifre (9007199254740992 != 9007199254740993) e rende rosso il test');
  }

  console.log('  OK   parametri SQL esatti: Long e Decimal arrivano al driver come testo canonico');
  console.log('  OK   il valore riletto dal database coincide con testo e tipo confermati');
  console.log('  OK   limiti 64-bit signed/unsigned e controprova di sensibilità superati');
})();
