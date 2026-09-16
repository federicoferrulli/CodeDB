'use strict';

// La selezione di import si prova senza database e senza archivio: inventario
// e scelte sono dati. Ogni caso sbagliato qui è un import che scrive dove non
// deve — dati chiesti e assenti, merge senza identità che duplica, REPLACE
// spacciato per fondi.

const assert = require('assert');
const { creaSelezioneImport, verificaImpronta, POLITICHE } = require('../db/selezioneImport');

const inventario = {
  dbType: 'postgresql', db: 'negozio',
  oggetti: [
    { id: 'tabella:clienti', tipo: 'tabella', nome: 'clienti', haStruttura: true, haDati: true, identita: { kind: 'pk', columns: ['id'] } },
    { id: 'tabella:ordini', tipo: 'tabella', nome: 'ordini', haStruttura: true, haDati: true, identita: { kind: 'pk', columns: ['id'] } },
    { id: 'tabella:log', tipo: 'tabella', nome: 'log', haStruttura: true, haDati: true, identita: null },
    { id: 'vista:v_ordini', tipo: 'vista', nome: 'v_ordini', haStruttura: true, haDati: false },
  ],
};
const base = { inventario, connection: 'locale', targetDb: 'destinazione' };

(async () => {
  /* --- Default e politiche ------------------------------------------------------ */

  {
    const piano = creaSelezioneImport(base);
    assert.strictEqual(piano.voci.length, 4, 'senza selezione: tutto l inventario');
    assert.ok(piano.voci.every((v) => v.politica === 'crea-se-assente'));
    assert.strictEqual(piano.voci.find((v) => v.id === 'vista:v_ordini').dati, false);
    assert.strictEqual(piano.soloDati, false);
    verificaImpronta(piano);
    assert.ok(Object.isFrozen(piano) && Object.isFrozen(piano.voci[0]));
    const ripetuto = creaSelezioneImport(base);
    assert.strictEqual(ripetuto.fingerprint, piano.fingerprint, 'deterministico');
    assert.throws(() => verificaImpronta({ ...piano, targetDb: 'altra' }), /impronta/i);
    console.log('  OK   default fedele, contratto immutabile e firmato');
  }

  {
    const piano = creaSelezioneImport({
      ...base,
      selezione: {
        'tabella:ordini': { struttura: false, dati: true, politica: 'fondi' },
        'tabella:clienti': { struttura: true, dati: true, politica: 'accoda' },
        'tabella:log': { struttura: false, dati: false },
      },
    });
    const ordini = piano.voci.find((v) => v.id === 'tabella:ordini');
    assert.deepStrictEqual([ordini.struttura, ordini.dati, ordini.politica], [false, true, 'fondi']);
    assert.ok(piano.soloDati === false, 'clienti ha struttura: non è solo-dati');
    assert.deepStrictEqual(piano.esclusi.map((e) => e.id), ['tabella:log'],
      'solo il log esplicitamente escluso; la vista non nominata resta dentro di default');
    assert.strictEqual(piano.esclusi[0].motivo, 'escluso esplicitamente dalla selezione');
    console.log('  OK   politiche per oggetto ed esclusioni con motivo');
  }

  {
    const piano = creaSelezioneImport({
      ...base,
      selezione: {
        'tabella:ordini': { struttura: false, dati: true },
        'tabella:clienti': { struttura: false, dati: true },
        'tabella:log': { struttura: false, dati: false },
        'vista:v_ordini': { struttura: false, dati: false },
      },
    });
    assert.strictEqual(piano.soloDati, true, 'solo dati: l esecuzione non dovrà toccare lo schema');
    console.log('  OK   solo-dati dichiarato, niente DDL implicita');
  }

  /* --- Rifiuti ------------------------------------------------------------------------ */

  assert.throws(() => creaSelezioneImport({
    ...base, selezione: { 'tabella:fantasma': { struttura: true, dati: true } },
  }), /assente dall'archivio/, 'dati assenti non si richiedono');
  assert.throws(() => creaSelezioneImport({
    ...base, selezione: { 'vista:v_ordini': { struttura: true, dati: true } },
  }), /non contiene i dati/, 'dati di una vista non esistono');
  assert.throws(() => creaSelezioneImport({
    ...base, selezione: { 'tabella:log': { struttura: false, dati: true, politica: 'fondi' } },
  }), /identità stabile/, 'fondere senza identità duplica: rifiutato');
  assert.throws(() => creaSelezioneImport({
    ...base, selezione: { 'tabella:ordini': { struttura: true, dati: true, politica: 'sovrascrivi-tutto' } },
  }), /sconosciuta/, 'nessun sinonimo inventato per le politiche');
  assert.throws(() => creaSelezioneImport({
    ...base, selezione: { 'tabella:ordini': { struttura: true, dati: false, filtro: { condizioni: [] } } },
  }), /filtro/, 'filtro senza dati');
  assert.throws(() => creaSelezioneImport({
    ...base,
    selezione: {
      'tabella:ordini': { struttura: false, dati: false },
      'tabella:clienti': { struttura: false, dati: false },
      'tabella:log': { struttura: false, dati: false },
      'vista:v_ordini': { struttura: false, dati: false },
    },
  }), /alcun oggetto/, 'piano vuoto non è un piano');
  assert.throws(() => creaSelezioneImport({ ...base, connection: '' }), /Connessione/);
  assert.throws(() => creaSelezioneImport({ ...base, politicaDefault: 'prima-o-poi' }), /sconosciuta/);
  assert.deepStrictEqual(POLITICHE, ['crea-se-assente', 'accoda', 'fondi', 'sostituisci'],
    'quattro politiche, niente REPLACE generico');
  console.log('  OK   assenti, merge senza identità e sinonimi rifiutati');

  console.log('  OK   Selezione import con politiche passed');
})().catch((err) => {
  console.error('  FAIL Selezione import:', err.stack || err);
  process.exitCode = 1;
});
