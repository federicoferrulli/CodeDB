'use strict';

// Il codec fedele si prova senza database: i valori BSON si costruiscono in
// memoria e devono tornare identici dopo il giro su testo. Ogni caso qui sotto
// è una riga della matrice di fedeltà (§1-bis): il relaxed perdeva Long e
// Double interi piccoli (tornavano Int32) senza alcun errore.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  Int32, Long, Double, Decimal128, ObjectId, Timestamp, Binary, MinKey, MaxKey, UUID,
} = require('bson');
const { stringifyRiga, parseRiga, serializeConservativo, deserializeConservativo } = require('../db/codecFedele');

function giro(valore) {
  return parseRiga(stringifyRiga(valore));
}

function tipoDi(v) {
  if (v == null || typeof v !== 'object') return typeof v;
  return v._bsontype || v.constructor.name;
}

(async () => {
  /* --- Numeri: il punto dove il relaxed perdeva -------------------------------- */

  const casi = new Map([
    // Un `number` JS è un Double anche in partenza: l'Int32 va costruito.
    ['Int32', new Int32(5)],
    ['Long oltre 2^53', Long.fromString('9007199254740993')],
    ['Long entro 2^53', Long.fromNumber(5)],
    ['Double intero', new Double(3)],
    ['Double frazionario', new Double(3.5)],
    ['Decimal128', Decimal128.fromString('12.340')],
  ]);
  for (const [nome, valore] of casi) {
    const tornato = giro(valore);
    assert.strictEqual(tipoDi(tornato), tipoDi(valore), `${nome}: il tipo deve tornare identico`);
    assert.strictEqual(String(tornato.valueOf()), String(valore.valueOf()), `${nome}: il valore deve tornare identico`);
  }
  // I due casi che il relaxed perdeva davvero (matrice §1-bis, misurati):
  assert.strictEqual(tipoDi(giro(Long.fromNumber(5))), 'Long', 'Long(5) resta Long, non diventa Int32');
  assert.strictEqual(tipoDi(giro(new Double(3))), 'Double', 'Double(3) resta Double, non diventa Int32');
  // Mai Number per interi oltre i 53 bit: il canonico li tiene come testo.
  assert.match(stringifyRiga(Long.fromString('9007199254740993')), /\$numberLong/, 'oltre 2^53 viaggia come testo');
  console.log('  OK   numeri BSON: tipi e valori intatti, oltre 2^53 come testo');

  /* --- Il resto dei tipi ---------------------------------------------------------- */

  const data = new Date('2026-03-15T10:20:30.123Z');
  assert.strictEqual(giro(data).getTime(), data.getTime(), 'Date al millisecondo');
  assert.ok(giro(new ObjectId('68c4a1b2c3d4e5f60718293a')) instanceof ObjectId, 'ObjectId');
  assert.ok(giro(new Timestamp(Long.fromNumber(42))) instanceof Timestamp, 'Timestamp');
  // Il giro canonico restituisce un BSONRegExp, non un RegExp JS: è il valore
  // che il driver accetta in scrittura, quindi il restore lo reinserisce così
  // com'è. Conta che pattern e opzioni tornino identici.
  const rxTornata = giro(new RegExp('abc', 'im'));
  assert.strictEqual(rxTornata.pattern, 'abc', 'regex: pattern');
  assert.strictEqual(rxTornata.options.split('').sort().join(''), 'im', 'regex: opzioni');
  // `g` non è un'opzione BSON (né MongoDB la memorizza): deve fallire qui,
  // non nel backup di notte.
  assert.throws(() => giro(new RegExp('abc', 'g')), /not supported/i, 'una regex /g/ non è rappresentabile in BSON');
  assert.ok(giro(new MinKey()) instanceof MinKey, 'MinKey');
  assert.ok(giro(new MaxKey()) instanceof MaxKey, 'MaxKey');
  const bin = giro(new Binary(Buffer.from([0, 255, 1, 2, 3])));
  assert.deepStrictEqual(Buffer.from(bin.buffer), Buffer.from([0, 255, 1, 2, 3]), 'binari: tutti i byte');
  const uuid = new UUID('12345678-1234-5678-1234-567812345678');
  assert.strictEqual(String(giro(uuid).toString()), String(uuid.toString()), 'UUID con sottotipo');
  const doc = giro({ a: 1, b: null, c: { d: [1, { e: Long.fromNumber(7) }] } });
  assert.strictEqual('mancante' in doc, false, 'campo mancante resta mancante');
  assert.strictEqual(doc.b, null, 'null resta null');
  assert.strictEqual(tipoDi(doc.c.d[1].e), 'Long', 'annidati conservati');
  assert.deepStrictEqual(Object.keys(giro({ z: 1, a: 2 })), ['z', 'a'], 'ordine dei campi');
  const dec = giro(Decimal128.fromString('0.1'));
  assert.strictEqual(dec.toString(), '0.1', 'Decimal128 senza errori di binario');
  console.log('  OK   temporali, ObjectId, regex, Min/MaxKey, binari, UUID, annidati');

  /* --- Corredo: indici e oggetti ---------------------------------------------------- */

  // Il canonico promuove i numeri a Int32 anche qui: per il corredo va bene
  // (il server accetta entrambe le forme nelle createIndex/DDL) e vale più
  // della forma esatta il fatto che nessun tipo BSON si perda in silenzio.
  const idx = deserializeConservativo(JSON.parse(JSON.stringify(serializeConservativo({ k: { a: 1 }, unique: true }))));
  assert.strictEqual(idx.k.a.valueOf(), 1);
  assert.strictEqual(idx.unique, true);
  console.log('  OK   corredo indici/oggetti intatto');

  /* --- Compatibilità: i file relaxed storici si leggono ancora ----------------------- */

  const { EJSON } = require('bson');
  const rigaStorica = EJSON.stringify({ n: Long.fromNumber(5), d: new Double(3.5) }, { relaxed: true });
  const letta = parseRiga(rigaStorica);
  assert.strictEqual(Number(letta.d && letta.d.valueOf()), 3.5, 'il valore dei file storici si legge');
  console.log('  OK   file relaxed storici ancora leggibili');

  /* --- Guardia statica: nessun relaxed distruttivo nel motore ------------------------- */

  // I commenti che RACCONTANO il bug passato (`relaxed:true faceva…`) non
  // contano: si spazzano via prima del controllo, così solo il codice parla.
  // E si divide su `\r?\n`: su un checkout CRLF il `\r` resta in coda alla
  // riga e `//.*$` non lo consuma (`.` non copre `\r`), quindi il commento
  // sopravviveva e la guardia falliva — la stessa classe di difetto del test
  // batch corretto in Fase 0.
  const senzaCommenti = (testo) => testo.split(/\r?\n/).map((riga) => riga.replace(/\/\/.*$/, '')).join('\n');
  const motore = senzaCommenti(fs.readFileSync(path.join(__dirname, '..', 'backup', 'lib', 'engine.js'), 'utf8'));
  assert.ok(!/relaxed:\s*true/.test(motore), 'engine.js non deve più scrivere relaxed');
  assert.ok(!/EJSON\./.test(motore), 'engine.js passa dal codec, non usa EJSON diretto');
  const restore = senzaCommenti(fs.readFileSync(path.join(__dirname, '..', 'backup', 'lib', 'restore.js'), 'utf8'));
  assert.ok(!/relaxed:\s*true/.test(restore), 'restore.js non deve leggere relaxed');
  console.log('  OK   guardia statica: relaxed distruttivo assente da engine e restore');

  /* --- Paginazione senza chiave: keyset su ctid, mai OFFSET ------------------------------ */

  const { paginaSenzaChiave } = require('../backup/lib/engine');
  const prima = paginaSenzaChiave({ qualified: '"pubblico"."ordini"', listaSelect: '"id", "tot"', batch: 1000 });
  assert.ok(!/OFFSET/i.test(prima.sql), 'niente OFFSET');
  assert.match(prima.sql, /ctid > \$1/, 'la prima pagina parte da un ctid minimo');
  assert.deepStrictEqual(prima.params, ['(0,0)', 1000]);
  assert.match(prima.sql, /ORDER BY ctid LIMIT \$2/, 'ordine stabile e limite parametrizzato');
  assert.match(prima.sql, /ctid AS __ctid/, 'il ctid viaggia nella riga per la pagina dopo');
  const dopo = paginaSenzaChiave({
    qualified: '"pubblico"."ordini"', listaSelect: '"id"', batch: 1000,
    sinceColumn: 'aggiornato', sinceParam: '2026-01-01', ultimoCtid: '(12,34)',
  });
  assert.deepStrictEqual(dopo.params, ['2026-01-01', '(12,34)', 1000], 'since prima, ctid dopo, limite ultimo');
  assert.match(dopo.sql, /"aggiornato" > \$1 AND ctid > \$2/, 'filtro e keyset composti');
  assert.ok(!/OFFSET/i.test(dopo.sql));
  console.log('  OK   pagine senza chiave: keyset ctid senza OFFSET');

  console.log('  OK   Codec fedele e paginazione senza chiave passed');
})().catch((err) => {
  console.error('  FAIL Codec fedele:', err.stack || err);
  process.exitCode = 1;
});
