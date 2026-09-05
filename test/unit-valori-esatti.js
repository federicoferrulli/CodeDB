'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

module.exports = (async () => {
  const V = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'valori-esatti.js')).href);
  console.log('--- Test unitari codec dei valori esatti ---');

  const casiTabellari = [
    // [testo, metadato, attesoEjson, descrizione]
    // Limiti signed a 64 bit (-2^63 .. 2^63 - 1)
    ['-9223372036854775808', { type: 'bigint' }, { $numberLong: '-9223372036854775808' }, 'signed 64-bit min (-2^63)'],
    ['9223372036854775807', { type: 'bigint' }, { $numberLong: '9223372036854775807' }, 'signed 64-bit max (2^63 - 1)'],
    ['9223372036854775807', { declaredType: 'int8' }, { $numberLong: '9223372036854775807' }, 'PostgreSQL int8 signed max'],
    ['9007199254740993', { declaredType: 'serial8' }, { $numberLong: '9007199254740993' }, 'serial8 oltre 2^53'],
    ['-9007199254740993', { type: 'int64' }, { $numberLong: '-9007199254740993' }, 'int64 negativo oltre -2^53'],
    ['0', { type: 'bigint' }, { $numberLong: '0' }, 'signed bigint zero'],
    ['-1', { type: 'bigint' }, { $numberLong: '-1' }, 'signed bigint -1'],
    ['1', { type: 'bigint' }, { $numberLong: '1' }, 'signed bigint 1'],
    ['9007199254740995', { wrapper: '$numberLong' }, { $numberLong: '9007199254740995' }, 'wrapper BSON Long'],

    // Limiti unsigned a 64 bit (0 .. 2^64 - 1)
    ['0', { type: 'bigint unsigned' }, { $numberLong: '0' }, 'unsigned 64-bit zero'],
    ['9223372036854775807', { columnType: 'bigint(20) unsigned' }, { $numberLong: '9223372036854775807' }, 'unsigned entro 2^63 - 1 -> $numberLong'],
    ['9223372036854775808', { type: 'bigint unsigned' }, { $numberDecimal: '9223372036854775808' }, 'unsigned a 2^63 -> $numberDecimal'],
    ['18446744073709551615', { type: 'bigint unsigned' }, { $numberDecimal: '18446744073709551615' }, 'unsigned 64-bit max (2^64 - 1) -> $numberDecimal'],

    // Decimali ad alta precisione con molte cifre e BSON Decimal128
    ['1234567890.123456789012345678', { type: 'decimal(38,18)' }, { $numberDecimal: '1234567890.123456789012345678' }, 'decimal(38,18)'],
    ['12345678901234567890.12345678901234567890', { declaredType: 'numeric' }, { $numberDecimal: '12345678901234567890.12345678901234567890' }, 'numeric 40 cifre'],
    ['-99999999999999999999999999999999999999.99', { wrapper: '$numberDecimal' }, { $numberDecimal: '-99999999999999999999999999999999999999.99' }, 'decimal negativo esteso'],
    ['0.00000000000000000000000000000000000001', { type: 'decimal' }, { $numberDecimal: '0.00000000000000000000000000000000000001' }, 'decimal frazionario piccolissimo'],
    ['1.5e3', { type: 'decimal' }, { $numberDecimal: '1.5e3' }, 'notazione scientifica positiva in decimal'],
    ['-2.5e-2', { type: 'decimal' }, { $numberDecimal: '-2.5e-2' }, 'notazione scientifica negativa in decimal'],
  ];

  // 1. Codec pubblico esportato
  assert.strictEqual(typeof V.codecNumeroEsatto, 'object', 'codecNumeroEsatto deve essere esportato come oggetto');
  assert.strictEqual(typeof V.codecNumeroEsatto.aTesto, 'function', 'codecNumeroEsatto.aTesto deve essere una funzione');
  assert.strictEqual(typeof V.codecNumeroEsatto.aEjson, 'function', 'codecNumeroEsatto.aEjson deve essere una funzione');
  assert.strictEqual(typeof V.codecNumeroEsatto.richiedePrecisioneEsatta, 'function', 'codecNumeroEsatto.richiedePrecisioneEsatta deve essere una funzione');
  assert.strictEqual(typeof V.codecNumeroEsatto.metadatoNumerico, 'function', 'codecNumeroEsatto.metadatoNumerico deve essere una funzione');

  // 2. Esecuzione test tabellari
  for (const [testo, metadato, atteso, desc] of casiTabellari) {
    const decodificato = V.codecNumeroEsatto.aEjson(testo, metadato);
    assert.deepStrictEqual(decodificato, atteso, `aEjson fallito per ${desc}: atteso ${JSON.stringify(atteso)}, ottenuto ${JSON.stringify(decodificato)}`);
    const testoRiconvertito = V.codecNumeroEsatto.aTesto(decodificato);
    assert.strictEqual(testoRiconvertito, testo, `aTesto roundtrip fallito per ${desc}`);
  }

  // Tipi standard a virgola mobile non esatti
  assert.strictEqual(V.decodificaNumeroEsatto('12.5', { type: 'double' }), 12.5);
  assert.strictEqual(V.decodificaNumeroEsatto('42', { type: 'integer' }), 42);

  // 3. Rifiuto input fuori intervallo o incompatibili col tipo prima della scrittura
  const casiRifiuto = [
    ['9223372036854775808', { type: 'bigint' }, /intervallo/i, 'signed bigint oltre 2^63 - 1'],
    ['-9223372036854775809', { type: 'bigint' }, /intervallo/i, 'signed bigint sotto -2^63'],
    ['99999999999999999999', { declaredType: 'int8' }, /intervallo/i, 'int8 overflow massivo'],
    ['-1', { type: 'bigint unsigned' }, /intervallo/i, 'unsigned bigint negativo'],
    ['-9223372036854775808', { columnType: 'bigint unsigned' }, /intervallo/i, 'unsigned bigint grandemente negativo'],
    ['18446744073709551616', { type: 'bigint unsigned' }, /intervallo/i, 'unsigned bigint a 2^64 (overflow)'],
    ['12.3', { type: 'bigint' }, /intero/i, 'frazione in colonna bigint'],
    ['1e5', { type: 'bigint' }, /intero/i, 'notazione esponenziale in colonna bigint'],
    ['abc', { type: 'bigint' }, /intero/i, 'stringa alfabetica in bigint'],
    ['123abc', { type: 'bigint' }, /intero/i, 'stringa alfanumerica in bigint'],
    ['1.2.3', { type: 'decimal' }, /decimale/i, 'doppio punto decimale'],
    ['--10', { type: 'decimal' }, /decimale/i, 'doppio segno negativo'],
    ['abc', { type: 'decimal' }, /decimale/i, 'stringa alfabetica in decimal'],
    ['', { type: 'bigint' }, /vuoto/i, 'stringa vuota in bigint'],
    ['', { type: 'decimal' }, /vuoto/i, 'stringa vuota in decimal'],
    ['   ', { type: 'decimal' }, /vuoto/i, 'spazi in decimal'],
  ];

  for (const [testo, metadato, regexErrore, desc] of casiRifiuto) {
    assert.throws(
      () => V.codecNumeroEsatto.aEjson(testo, metadato),
      regexErrore,
      `Atteso rifiuto per ${desc}: valore "${testo}"`
    );
  }

  const long = { $numberLong: '9007199254740993' };
  assert.deepStrictEqual(V.metadatoNumerico(long), { wrapper: '$numberLong' });
  assert.strictEqual(V.testoNumeroEsatto(long), '9007199254740993');
  assert.deepStrictEqual(V.decodificaTemporale('2026-10-25T01:30:00Z', 'istante'),
    { $date: '2026-10-25T01:30:00.000Z' });
  assert.deepStrictEqual(V.decodificaTemporale('2026-10-25', 'data'), '2026-10-25');
  assert.strictEqual(V.decodificaTemporale('2026-10-25T01:30:00', 'locale'), '2026-10-25T01:30:00');
  assert.throws(() => V.decodificaTemporale('2026-10-25T01:30:00', 'istante'), /fuso|Z|offset/i);
  assert.deepStrictEqual(V.aggregaNumeriEsatti([
    { $numberLong: '9007199254740993' }, { $numberLong: '2' },
  ], 'somma').testo, '9007199254740995');
  assert.strictEqual(V.aggregaNumeriEsatti([
    { $numberDecimal: '0.1' }, { $numberDecimal: '0.2' },
  ], 'somma').testo, '0.3');
  assert.strictEqual(V.aggregaNumeriEsatti([
    { $numberDecimal: '0.1' }, { $numberDecimal: '0.2' },
  ], 'media').testo, '0.15');
  assert.strictEqual(V.richiedePrecisioneEsatta({ declaredType: 'bigint' }), true);
  assert.strictEqual(V.richiedePrecisioneEsatta({ declaredType: 'serial8' }), true);
  assert.strictEqual(V.richiedePrecisioneEsatta({ type: 'int64' }), true);
  assert.strictEqual(V.richiedePrecisioneEsatta({ columnType: 'bigint(20) unsigned' }), true);
  assert.strictEqual(V.richiedePrecisioneEsatta({ type: 'decimal(10,2)' }), true);
  assert.strictEqual(V.richiedePrecisioneEsatta({ declaredType: 'numeric' }), true);
  assert.strictEqual(V.richiedePrecisioneEsatta({ type: 'varchar(255)' }), false);
  assert.strictEqual(V.richiedePrecisioneEsatta({ type: 'int' }), false);
  assert.strictEqual(V.richiedePrecisioneEsatta({ type: 'double' }), false);

  // 4. Controprova di sensibilità: verificare che la conversione approssimata tramite Number/JSON.parse fallirebbe i test
  {
    const valoreOltre53Bit = '9007199254740993'; // 2^53 + 1
    const valoreMaxInt64 = '9223372036854775807'; // 2^63 - 1

    // Dimostrazione del difetto di Number:
    const approssimato53 = Number(valoreOltre53Bit);
    assert.notStrictEqual(String(approssimato53), valoreOltre53Bit,
      'Controprova: Number(2^53 + 1) DEVE perdere precisione diventando 9007199254740992');
    assert.strictEqual(String(approssimato53), '9007199254740992');

    const approssimato64 = Number(valoreMaxInt64);
    assert.notStrictEqual(String(approssimato64), valoreMaxInt64,
      'Controprova: Number(2^63 - 1) DEVE perdere le ultime cifre diventando 9223372036854776000');

    // Funzione difettosa ipotetica che usa Number invece del codec esatto:
    function decodificaConNumber(testo, meta) {
      if (meta && meta.wrapper === '$numberLong') {
        return { $numberLong: String(Number(testo)) };
      }
      return Number(testo);
    }

    // La controprova: dimostra che un'asserzione di esattezza su decodificaConNumber fallisce (diventa rossa)!
    let erroreRilevato = false;
    try {
      const risultatoDifettoso = decodificaConNumber(valoreOltre53Bit, { wrapper: '$numberLong' });
      assert.deepStrictEqual(risultatoDifettoso, { $numberLong: valoreOltre53Bit });
    } catch {
      erroreRilevato = true;
    }
    assert.strictEqual(erroreRilevato, true, 'La controprova deve rendere rosso il test se si reintroduce Number()');

    // Al contrario, il nostro codec esatto mantiene la precisione intatta:
    const risultatoEsatto = V.codecNumeroEsatto.aEjson(valoreOltre53Bit, { wrapper: '$numberLong' });
    assert.deepStrictEqual(risultatoEsatto, { $numberLong: valoreOltre53Bit });
    assert.strictEqual(V.codecNumeroEsatto.aTesto(risultatoEsatto), valoreOltre53Bit);
  }

  console.log('  OK   BIGINT, Long e Decimal non attraversano Number');
  console.log('  OK   test tabellari e controprova di sensibilità superati');
})();
