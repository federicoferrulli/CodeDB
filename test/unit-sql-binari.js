'use strict';

const assert = require('node:assert/strict');
const { Binary, Decimal128, Long } = require('bson');
const sql = require('../db/sqlValori');
const DbStrategy = require('../db/DbStrategy');

// Il mutante rimuove soltanto in memoria i wrapper binari del risultato:
// deve fallire su SQL-BINARI-TIPO senza alterare numeri esatti o file su disco.
const originale = sql.serializeRow;
const mutante = process.argv.includes('--mutant');
function perdiTipoBinario(value) {
  if (value?.$binary) return Object.fromEntries([...Buffer.from(value.$binary.base64, 'base64')].map((byte, i) => [i, byte]));
  if (Array.isArray(value)) return value.map(perdiTipoBinario);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, perdiTipoBinario(v)]));
  return value;
}
if (mutante) sql.serializeRow = (...args) => perdiTipoBinario(originale(...args));

const bytes = [0, 255, 128, 39, 92, 10];
const hex = '00ff80275c0a';
const data = '2026-10-22T12:34:56.789Z';
const decimale = '0.100000000000000001';
const conRiserva = () => {
  const value = new Binary();
  bytes.forEach(byte => value.put(byte));
  assert(value.buffer.byteLength > value.position, 'La fixture Binary deve avere capacità non utilizzata');
  return value;
};
const casi = [
  { nome: 'Buffer', crea: () => Buffer.from(bytes), hex },
  { nome: 'Uint8Array', crea: () => Uint8Array.from(bytes), hex },
  { nome: 'Buffer con offset', crea: () => Buffer.from([17, ...bytes, 34]).subarray(1, 7), hex },
  { nome: 'Uint8Array con offset', crea: () => Uint8Array.from([17, ...bytes, 34]).subarray(1, 7), hex },
  { nome: 'Binary', crea: () => new Binary(Buffer.from(bytes)), hex },
  { nome: 'Binary con sottotipo applicativo', crea: () => new Binary(Buffer.from(bytes), 0x80), hex, subType: '80' },
  { nome: 'Binary con capacità oltre position', crea: conRiserva, hex },
  { nome: 'Buffer vuoto', crea: () => Buffer.alloc(0), hex: '' },
  { nome: 'Uint8Array vuoto', crea: () => new Uint8Array(0), hex: '' },
  { nome: 'Binary vuoto con capacità riservata', crea: () => new Binary(), hex: '' },
];

// La fotografia include capacità, offset e tipo nativo, oltre ai byte logici:
// accorciare o sostituire i valori della riga originale è una mutazione.
function fotografa(value) {
  if (value instanceof Date) return { tipo: 'Date', valore: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { tipo: value.constructor.name, offset: value.byteOffset, bytes: [...value] };
  }
  if (value?._bsontype === 'Binary') {
    return { tipo: 'Binary', position: value.position, sottotipo: value.sub_type, buffer: fotografa(value.buffer) };
  }
  if (value?._bsontype) return { tipo: value._bsontype, valore: value.toString() };
  if (Array.isArray(value)) return value.map(fotografa);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fotografa(v)]));
  return value;
}

function verificaParametro(value, atteso, contesto) {
  const parametro = sql.toSqlValue(value);
  assert(Buffer.isBuffer(parametro), `[SQL-BINARI-PARAMETRO] ${contesto}: il driver deve ricevere un Buffer`);
  assert.equal(parametro.toString('hex'), atteso, `[SQL-BINARI-BYTE] ${contesto}: soltanto i byte logici, senza offset o capacità residua`);
}

module.exports = (async () => {
 let verificati = 0;
 try {
  console.log('--- Test unitari trasporto binari SQL ---');
  for (const conColonne of [false, true]) {
    const modo = conColonne ? 'con colonne' : 'senza metadati';
    for (const caso of casi) {
      const valore = caso.crea();
      const riga = Object.freeze({
        dato: valore,
        _id: Object.freeze({ chiave: valore }),
        documento: Object.freeze({ copia: valore }),
        lista: Object.freeze([valore, Object.freeze({ copia: valore })]),
        quando: new Date(data), piccolo: Long.fromString('42'),
        decimale: Decimal128.fromString(decimale), nullo: null,
      });
      const prima = fotografa(riga);
      const colonne = conColonne ? [
        { name: 'dato', declaredType: 'bytea' },
        { name: '_id', type: 'json' },
        { name: 'piccolo', type: 'bigint' },
        { name: 'decimale', type: 'numeric' },
        { name: 'quando', type: 'timestamp' },
      ] : undefined;
      const serializzato = sql.serializeRow(riga, colonne);
      const atteso = { $binary: { base64: Buffer.from(caso.hex, 'hex').toString('base64'), subType: caso.subType || '00' } };
      const contesto = `${caso.nome}, ${modo}`;
      assert.deepEqual(serializzato.dato, atteso, `[SQL-BINARI-TIPO] ${contesto}: il trasporto deve conservare il wrapper EJSON $binary`);
      assert.deepEqual(serializzato._id, { chiave: atteso }, `${contesto}: identificatore composto con chiave binaria`);
      assert.deepEqual(serializzato.documento, { copia: atteso }, `${contesto}: binario nel sottodocumento`);
      assert.deepEqual(serializzato.lista, [atteso, { copia: atteso }], `${contesto}: binari negli array e nei loro sottodocumenti`);
      assert.deepEqual(serializzato.quando, { $date: data }, `${contesto}: la data conserva il tipo`);
      assert.deepEqual(serializzato.piccolo, conColonne ? { $numberLong: '42' } : 42, `${contesto}: Long mantiene il contratto con/senza metadati`);
      assert.deepEqual(serializzato.decimale, { $numberDecimal: decimale }, `${contesto}: Decimal128 non perde cifre`);
      assert.equal(serializzato.nullo, null);
      assert.deepEqual(fotografa(riga), prima, `${contesto}: serializeRow non modifica la riga né i suoi valori annidati`);

      // Entrambi gli ingressi del protocollo devono ricostruire lo stesso valore.
      for (const [ingresso, ripristinato] of [
        ['deserializeClientObject', sql.deserializeClientObject(serializzato)],
        ['parseClientValue', sql.parseClientValue(JSON.stringify(serializzato))],
      ]) {
        for (const [campo, binario] of [
          ['dato', ripristinato.dato], ['_id.chiave', ripristinato._id.chiave],
          ['documento.copia', ripristinato.documento.copia], ['lista[0]', ripristinato.lista[0]],
          ['lista[1].copia', ripristinato.lista[1].copia],
        ]) {
          assert.equal(binario._bsontype, 'Binary', `${contesto}, ${ingresso}, ${campo}: tipo BSON ripristinato`);
          assert.equal(binario.sub_type, parseInt(caso.subType || '00', 16), `${contesto}: sottotipo preservato`);
          verificaParametro(binario, caso.hex, `${contesto}, ${ingresso}, ${campo}`);
        }
        assert(sql.toSqlValue(ripristinato.quando) instanceof Date, `${contesto}: il bind della data resta Date`);
        assert.equal(sql.toSqlValue(ripristinato.quando).toISOString(), data);
        assert.equal(sql.toSqlValue(ripristinato.piccolo), conColonne ? '42' : 42);
        assert.equal(sql.toSqlValue(ripristinato.decimale), decimale);
      }
      // L'editing di una singola cella passa un valore EJSON, non una riga.
      verificaParametro(sql.parseClientValue(JSON.stringify(atteso)), caso.hex, `${contesto}, cella singola`);
      verificaParametro(valore, caso.hex, `${contesto}, valore nativo diretto`);
      assert.deepEqual(fotografa(riga), prima, `${contesto}: il ciclo completo non modifica la riga originale`);
      verificati++;
    }
  }

  // I tipi numerici esatti con metadati SQL devono convivere con il binario.
  const grande = '9007199254740993';
  const rigaEsatta = sql.serializeRow({ id: Long.fromString(grande), dato: Buffer.from(bytes) }, [
    { name: 'id', declaredType: 'bigint' }, { name: 'dato', declaredType: 'varbinary(6)' },
  ]);
  assert.deepEqual(rigaEsatta.id, { $numberLong: grande }, 'Long oltre 53 bit resta esatto nella riga con binario');
  assert.equal(sql.toSqlValue(sql.parseClientValue(JSON.stringify(rigaEsatta)).id), grande);

  // Il limite misura la forma inviata sul filo, non migliaia di chiavi "0", "1".
  const rigaBudget = Object.freeze({ dato: Buffer.alloc(1024, 255), _id: Object.freeze({ chiave: Buffer.from(bytes) }) });
  const righe = Object.freeze([rigaBudget, Object.freeze({ dato: Uint8Array.from(bytes) })]);
  const fotoBudget = fotografa(righe);
  for (const numero of [1, 2]) {
    const campione = righe.slice(0, numero);
    const budget = Buffer.byteLength(JSON.stringify(campione.map(row => sql.serializeRow(row))), 'utf8');
    const completo = DbStrategy.truncateBySize(campione, budget);
    assert.equal(completo.truncated, false, '[SQL-BINARI-BUDGET] il budget EJSON esatto deve contenere tutte le righe binarie');
    assert.strictEqual(completo.rows, campione, 'Il controllo byte conserva la lista originale quando entra nel budget');
    completo.rows.forEach((row, i) => assert.strictEqual(row, campione[i], 'Il controllo byte non sostituisce la riga nativa'));
    const troncato = DbStrategy.truncateBySize(campione, budget - 1);
    assert.equal(troncato.truncated, true, 'Un byte sotto il budget deve segnalare il troncamento');
    assert.deepEqual(troncato.rows, campione.slice(0, -1), 'Rimane soltanto il prefisso che entra nel budget');

    for (const limite of [budget, budget - 1]) {
      let chiuso = false;
      async function* cursore() { try { yield* campione; } finally { chiuso = true; } }
      const raccolto = await DbStrategy.collectCapped(cursore(), 100, limite);
      assert.equal(raccolto.truncated, limite < budget, '[SQL-BINARI-CURSORE] stessa soglia EJSON del risultato materializzato');
      assert.deepEqual(raccolto.docs, limite < budget ? campione.slice(0, -1) : campione);
      raccolto.docs.forEach((row, i) => assert.strictEqual(row, campione[i], 'Il cursore conserva le righe native'));
      assert(chiuso, 'Il cursore viene chiuso anche se il budget interrompe la lettura');
    }
  }
  assert.deepEqual(fotografa(righe), fotoBudget, 'I controlli del budget conservano Buffer, offset e contenuto originali');
  console.log(`  OK   ${verificati} casi binari: metadati, offset, sottotipi, capacità, annidamento e ciclo EJSON/SQL`);
  console.log('  OK   riga originale immutata; Date, Long e Decimal128 preservati');
  console.log('  OK   budget EJSON esatto e limite meno un byte, su righe e cursore');
 } finally {
  sql.serializeRow = originale;
 }
 return { verificati };
})();
