'use strict';

// Il riepilogo si prova senza browser: è logica pura e il wizard la riusa
// così com'è. Ciò che si prova è che l'anteprima dica tutto: conteggi,
// esclusioni, dipendenze, avvisi sulle righe orfane — e che senza impronta non
// esista anteprima.

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { creaPianoExport, MODALITA } = require('../db/exportPlan');
const { creaPianoImport } = require('../db/importPlan');

(async () => {
  const { riepilogoPiano } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'riepilogo-piano.js')).href
  );

  /* --- Export: piano vero --------------------------------------------------------- */

  const exportPlan = creaPianoExport({
    catalogo: {
      dbType: 'postgresql', db: 'negozio',
      oggetti: [
        { tipo: 'tabella', nome: 'clienti' },
        { tipo: 'tabella', nome: 'ordini' },
        { tipo: 'vista', nome: 'v_ordini' },
      ],
      dipendenze: [
        { da: 'tabella:ordini', a: 'tabella:clienti', tipo: 'fk', campo: 'cliente_id' },
        { da: 'vista:v_ordini', a: 'tabella:ordini', tipo: 'vista' },
      ],
    },
    connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: {
      'tabella:ordini': { struttura: true, dati: true },
    },
  });
  const riepilogo = riepilogoPiano(exportPlan);
  assert.strictEqual(riepilogo.titolo, 'Export negozio');
  assert.strictEqual(riepilogo.fingerprint, exportPlan.fingerprint, 'l impronta viaggia con l anteprima');
  const voce = (etichetta) => riepilogo.voci.find((v) => v.etichetta === etichetta).valore;
  assert.strictEqual(voce('Con dati'), '1');
  assert.strictEqual(voce('Solo struttura'), '0');
  assert.strictEqual(voce('Esclusi'), '2', 'clienti e vista restano fuori e si vedono');
  assert.ok(riepilogo.avvisi.some((a) => /orfane/.test(a) && /ordini/.test(a)),
    'ordini senza clienti: righe orfane dichiarate');
  assert.ok(riepilogo.avvisi.some((a) => /non ricreabile/.test(a)), 'vincolo senza bersaglio dichiarato');
  console.log('  OK   export: conteggi, esclusioni e avvisi dall oggetto vero');

  /* --- Import: piano vero ------------------------------------------------------------ */

  const importPlan = creaPianoImport({
    artifact: {
      formato: 'codedb-database', versione: 1, dbType: 'mongodb', db: 'origine',
      collections: [
        { name: 'clienti', indexes: [], docs: [{ _id: 1 }, { _id: 2 }] },
        { name: 'ordini', indexes: [], docs: [{ _id: 1 }] },
      ],
    },
    expectedDbType: 'mongodb', connection: 'locale', targetDb: 'destinazione', drop: true,
  });
  const riepilogoImport = riepilogoPiano(importPlan);
  assert.strictEqual(riepilogoImport.titolo, 'Import verso destinazione');
  assert.strictEqual(riepilogoImport.fingerprint, importPlan.fingerprint);
  const voceImport = (etichetta) => riepilogoImport.voci.find((v) => v.etichetta === etichetta).valore;
  assert.strictEqual(voceImport('Oggetti'), '2');
  assert.strictEqual(voceImport('Righe/documenti'), '3');
  assert.strictEqual(voceImport('Sostituisce la destinazione'), 'sì');
  assert.ok(riepilogoImport.avvisi.some((a) => /recupero/.test(a)), 'drop con recupero dichiarato');
  console.log('  OK   import: righe, drop e promozione dall oggetto vero');

  /* --- Rifiuti -------------------------------------------------------------------------------- */

  assert.throws(() => riepilogoPiano(null), /mancante/i);
  assert.throws(() => riepilogoPiano({ kind: 'export-database' }), /impronta/i,
    'senza impronta non è un contratto da mostrare');
  assert.throws(() => riepilogoPiano({ kind: 'piano-misterioso', fingerprint: 'x' }), /sconosciuto/i);
  console.log('  OK   senza impronta o con tipo ignoto non si mostra nulla');

  console.log('  OK   Riepilogo piano per l anteprima passed');
})().catch((err) => {
  console.error('  FAIL Riepilogo piano:', err.stack || err);
  process.exitCode = 1;
});
