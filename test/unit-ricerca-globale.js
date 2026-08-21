'use strict';

const assert = require('assert');
const {
  normalizzaRicerca,
  catalogoDaDocumenti,
  filtroMongo,
  clausolaMySql,
  clausolaPostgres,
  separaCataloghiJson,
} = require('../db/ricercaGlobale');

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

console.log('  --- Ricerca globale server-side ---');

prova('accetta soltanto l\'intenzione contieneOvunque', () => {
  assert.strictEqual(normalizzaRicerca({ operatore: 'contieneOvunque', valore: ' Membro ' }), 'Membro');
  assert.throws(() => normalizzaRicerca({ operatore: '$where', valore: 'x' }), /operatore atteso/);
});

prova('il catalogo attraversa oggetti e array fino ai valori scalari', () => {
  const cat = catalogoDaDocumenti([{ gruppi: [{ label: 'Membro', livello: 2 }], attivo: true }]);
  const firme = [...cat.keys()];
  assert.ok(firme.includes('."gruppi"[]."label"'));
  assert.ok(firme.includes('."gruppi"[]."livello"'));
  assert.ok(firme.includes('."attivo"'));
});

prova('Mongo cerca case-insensitive anche in valori annidati, array e _id', () => {
  const cat = catalogoDaDocumenti([{
    _id: { _bsontype: 'ObjectId', toString() { return 'abc'; } },
    gruppi: [{ label: 'Membro', livello: 2 }],
  }]);
  const filtro = filtroMongo('mEmBrO', cat);
  const testo = JSON.stringify(filtro);
  assert.ok(testo.includes('label'));
  assert.ok(testo.includes('$anyElementTrue'));
  assert.ok(testo.includes('_id'));
  assert.ok(testo.includes('"options":"i"'));
});

prova('MySQL include tutte le colonne e nei JSON estrae valori, non chiavi', () => {
  const colonne = [
    ...Array.from({ length: 7 }, (_, i) => ({ name: `c${i}`, type: 'varchar' })),
    { name: 'label', type: 'varchar' },
    { name: 'meta', type: 'json' },
  ];
  const flat = catalogoDaDocumenti([{ meta: { gruppi: [{ label: 'Membro' }] } }]);
  const json = separaCataloghiJson(flat, ['meta']);
  const res = clausolaMySql('MeMbRo', colonne, json, (n) => `\`${n}\``);
  assert.ok(res.sql.includes('`label`'), 'la colonna dopo le prime sei deve esserci');
  assert.ok(res.sql.includes('JSON_EXTRACT(`meta`, ?)'));
  assert.ok(res.params.includes('$."gruppi"[*]."label"'));
  assert.ok(!res.sql.includes('Membro'), 'il valore deve restare parametrizzato');
});

prova('PostgreSQL attraversa JSON/array e usa confronto case-insensitive parametrizzato', () => {
  const res = clausolaPostgres('Membro', [
    { name: 'id', type: 'integer' },
    { name: 'label', type: 'text' },
    { name: 'meta', type: 'jsonb' },
  ], (n) => `"${n}"`, (n) => `$${n}`, 3);
  assert.ok(res.sql.includes('jsonb_path_query'));
  assert.ok(res.sql.includes('LOWER'));
  assert.ok(res.sql.includes('$3'));
  assert.ok(res.sql.includes('$5'));
  assert.deepStrictEqual(res.params, ['%Membro%', '%Membro%', '%Membro%']);
});

prova('i caratteri LIKE restano letterali', () => {
  const res = clausolaMySql('50%_ok', [{ name: 'label', type: 'varchar' }], new Map(), (n) => `\`${n}\``);
  assert.deepStrictEqual(res.params, ['%50=%=_ok%']);
  assert.ok(res.sql.includes("ESCAPE '='"));
});

prova('MySQL ignora il case ma non gli accenti', () => {
  const res = clausolaMySql('Membro', [{ name: 'label', type: 'varchar' }], new Map(), (n) => `\`${n}\``);
  assert.ok(res.sql.includes('LOWER'));
  assert.ok(res.sql.includes('utf8mb4_bin'));
});

if (falliti) throw new Error(`${falliti} test della ricerca globale falliti`);
console.log('  Ricerca globale: valori scalari, percorsi annidati e nessun tetto di colonne.');
