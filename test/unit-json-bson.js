'use strict';

/* ---------------------------------------------------------------------------
 * Test unitario di public/js/json-bson.js — validazione, formattazione e
 * minificazione di JSON/BSON.
 *
 * Due proprietà contano più dell'estetica:
 *
 *  1. **Non si perdono dati.** Formattare e minificare non devono cambiare un
 *     valore: `NumberLong("9007199254740993")` non deve passare da un `Number`
 *     (che perderebbe l'ultima cifra) e `ObjectId(...)` non deve diventare una
 *     stringa. Per questo il round-trip è verificato token per token.
 *  2. **Gli errori dicono DOVE.** Un linter che sa solo dire "non valido" non
 *     serve a nessuno: riga e colonna sono la metà utile del messaggio.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let falliti = 0;
function prova(nome, fn) {
  try {
    fn();
    console.log(`  OK   ${nome}`);
  } catch (err) {
    falliti++;
    console.error(`  FAIL ${nome}\n       ${err.message}`);
  }
}

(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'json-bson.js')).href;
  const {
    analizzaJsonBson, formattaJsonBson, minificaJsonBson, sembraJsonBson,
    posizioneDi, tokenizzaJsonBson,
  } = await import(url);

  console.log('--- Test unitari JSON/BSON (validazione, formatta, minifica) ---');

  /* --- Validazione: casi buoni ----------------------------------------- */

  const validi = [
    '{}',
    '[]',
    '{"a": 1}',
    '{ "a": [1, 2, 3], "b": { "c": null } }',
    "{ nome: 'Anna', eta: 30 }",                       // chiavi nude, apici singoli
    '{ _id: ObjectId("64f0aa11bb22cc33dd44ee55") }',   // costruttore BSON
    '{ creato: ISODate("2026-01-01T00:00:00Z") }',
    '{ quando: new Date("2026-01-01") }',
    '{ n: NumberLong("9007199254740993") }',
    '{ i: NumberInt("42"), d: NumberDecimal("1.25"), u: UUID("01234567-89ab-cdef-0123-456789abcdef") }',
    '{ nome: /^an/i }',                                 // espressione regolare
    '{ "a": 1, }',                                      // virgola finale (shell)
    '{ /* nota */ "a": 1 } // fine',                    // commenti
    '{ "a": -1.5e-3, "b": 0x1f, "c": true, "d": null }',
    '[{ "$match": { "eta": { "$gt": 30 } } }]',
  ];
  for (const testo of validi) {
    prova(`Valido: ${testo.slice(0, 46)}`, () => {
      const r = analizzaJsonBson(testo);
      assert.strictEqual(r.ok, true, `atteso valido, invece: ${r.messaggio}`);
    });
  }

  /* --- Validazione: casi rotti, con posizione --------------------------- */

  prova('Manca la virgola fra due campi (riga e colonna giuste)', () => {
    const testo = '{\n  "a": 1\n  "b": 2\n}';
    const r = analizzaJsonBson(testo);
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /virgola/i, r.messaggio);
    assert.strictEqual(r.riga, 3, `riga attesa 3, avuta ${r.riga}`);
    assert.strictEqual(r.colonna, 3, `colonna attesa 3, avuta ${r.colonna}`);
  });

  prova('Graffa mai chiusa', () => {
    const r = analizzaJsonBson('{ "a": 1');
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /mai chiusa/i, r.messaggio);
  });

  prova('Stringa mai chiusa', () => {
    const r = analizzaJsonBson('{ "a": "senza fine }');
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /stringa/i, r.messaggio);
  });

  prova('Testo nudo al posto di una stringa', () => {
    const r = analizzaJsonBson('{ "stato": attivo }');
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /virgolette/i, r.messaggio);
  });

  prova('Manca il due punti', () => {
    const r = analizzaJsonBson('{ "a" 1 }');
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /due punti/i, r.messaggio);
  });

  prova('Spazzatura dopo la fine del documento', () => {
    const r = analizzaJsonBson('{ "a": 1 } pippo');
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /dopo la fine/i, r.messaggio);
  });

  prova('Documento vuoto', () => {
    const r = analizzaJsonBson('   ');
    assert.strictEqual(r.ok, false);
  });

  prova('Un costruttore sconosciuto è rifiutato alla sua posizione', () => {
    const r = analizzaJsonBson('{\n  x: Sconosciuto(1)\n}');
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /costruttore non supportato.*Sconosciuto/i);
    assert.strictEqual(r.riga, 2);
    assert.strictEqual(r.colonna, 6);
  });

  for (const testo of ['{ a: 1, "a": 2 }', '{ a: 1, "\\u0061": 2 }']) {
    prova(`Chiavi equivalenti duplicate: ${testo}`, () => {
      const r = analizzaJsonBson(testo);
      assert.strictEqual(r.ok, false);
      assert.match(r.messaggio, /campo duplicato/i);
    });
  }

  prova('Il testo del frammento sbagliato compare nel messaggio', () => {
    const r = analizzaJsonBson('{ "a": 1 "b": 2 }');
    assert.strictEqual(r.ok, false);
    assert.ok(r.messaggio.includes('"b"'), r.messaggio);
  });

  /* --- Formattazione ---------------------------------------------------- */

  prova('Indentazione a due spazi, una voce per riga', () => {
    const out = formattaJsonBson('{"stato":"attivo","eta":{"$gt":30}}');
    assert.deepStrictEqual(out.split('\n'), [
      '{',
      '  "stato": "attivo",',
      '  "eta": {',
      '    "$gt": 30',
      '  }',
      '}',
    ]);
  });

  prova('Array indentato', () => {
    const out = formattaJsonBson('[1,2,{"a":3}]');
    assert.deepStrictEqual(out.split('\n'), ['[', '  1,', '  2,', '  {', '    "a": 3', '  }', ']']);
  });

  prova('Oggetto e array vuoti restano su una riga', () => {
    assert.strictEqual(formattaJsonBson('{"a":{},"b":[]}'), '{\n  "a": {},\n  "b": []\n}');
  });

  prova('I costruttori BSON non vengono toccati', () => {
    const src = '{_id:ObjectId("64f0aa11bb22cc33dd44ee55"),n:NumberLong("9007199254740993"),d:new Date("2026-01-01")}';
    const out = formattaJsonBson(src);
    assert.ok(out.includes('ObjectId("64f0aa11bb22cc33dd44ee55")'), out);
    assert.ok(out.includes('NumberLong("9007199254740993")'), out);
    assert.ok(out.includes('new Date("2026-01-01")'), out);
  });

  prova('Un intero oltre i 53 bit sopravvive alla formattazione', () => {
    // Questo è il caso che `JSON.parse` + `JSON.stringify` rovinerebbe in
    // silenzio: 9007199254740993 diventerebbe 9007199254740992.
    const out = formattaJsonBson('{"n":9007199254740993}');
    assert.ok(out.includes('9007199254740993'), out);
  });

  prova('Gli apici singoli e le chiavi nude restano come sono', () => {
    const out = formattaJsonBson("{nome:'Anna'}");
    assert.strictEqual(out, "{\n  nome: 'Anna'\n}");
  });

  prova('La virgola finale sparisce', () => {
    assert.strictEqual(formattaJsonBson('{"a":1,}'), '{\n  "a": 1\n}');
  });

  prova('I commenti sopravvivono alla formattazione', () => {
    const out = formattaJsonBson('{ // il campo\n"a":1}');
    assert.ok(out.includes('// il campo'), out);
  });

  prova('Un testo non valido fa lanciare (chi chiama decide)', () => {
    assert.throws(() => formattaJsonBson('{ "a": }'), /valore|Trovato/i);
  });

  /* --- Minificazione ----------------------------------------------------- */

  prova('Minifica toglie spazi e a capo', () => {
    assert.strictEqual(minificaJsonBson('{\n  "a": 1,\n  "b": [1, 2]\n}'), '{"a":1,"b":[1,2]}');
  });

  prova('Minifica non tocca gli spazi DENTRO le stringhe', () => {
    assert.strictEqual(minificaJsonBson('{ "a": "due  spazi" }'), '{"a":"due  spazi"}');
  });

  prova('Minifica toglie i commenti (su una riga sola mangerebbero tutto)', () => {
    const out = minificaJsonBson('{ // nota\n "a": 1 }');
    assert.strictEqual(out, '{"a":1}');
    assert.ok(!out.includes('//'), out);
  });

  prova('Formatta e minifica sono l\'una l\'inversa dell\'altra', () => {
    const src = '{"a":1,"b":[{"c":"x"},2],"d":{}}';
    assert.strictEqual(minificaJsonBson(formattaJsonBson(src)), src);
  });

  /* --- Riconoscimento e posizioni --------------------------------------- */

  prova('sembraJsonBson distingue un documento da una SELECT', () => {
    assert.strictEqual(sembraJsonBson('  { "a": 1 }'), true);
    assert.strictEqual(sembraJsonBson('[1,2]'), true);
    assert.strictEqual(sembraJsonBson('SELECT * FROM t'), false);
  });

  prova('posizioneDi conta righe e colonne da 1', () => {
    assert.deepStrictEqual(posizioneDi('ab\ncd', 0), { riga: 1, colonna: 1 });
    assert.deepStrictEqual(posizioneDi('ab\ncd', 3), { riga: 2, colonna: 1 });
    assert.deepStrictEqual(posizioneDi('ab\ncd', 4), { riga: 2, colonna: 2 });
  });

  prova('Il tokenizzatore tiene insieme una chiamata con parentesi annidate', () => {
    const toks = tokenizzaJsonBson('{ a: ObjectId(Bar("x, y")) }');
    const valore = toks.find((t) => t.t === 'valore');
    assert.strictEqual(valore.v, 'ObjectId(Bar("x, y"))');
  });

  prova('Nessun crash su un documento profondissimo (limite di ricorsione)', () => {
    const profondo = '['.repeat(500) + ']'.repeat(500);
    const r = analizzaJsonBson(profondo);
    assert.strictEqual(r.ok, false);
    assert.match(r.messaggio, /profondità/i, r.messaggio);
  });

  console.log(falliti === 0
    ? '  Tutti i test JSON/BSON superati.'
    : `  ${falliti} test JSON/BSON FALLITI.`);
  if (falliti > 0) process.exitCode = 1;
})();
