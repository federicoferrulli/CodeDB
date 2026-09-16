'use strict';

// Lo stato dell'albero di selezione si prova senza browser: è logica pura e
// il wizard la riusa così com'è. Ciò che si prova è ciò che, sbagliato,
// produce un export diverso da quello mostrato: ricerca che deseleziona,
// genitore spuntato a metà che dichiara tutto, gruppo che non propaga.

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { creaStatoSelezione, STATI } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'export-selezione.js')).href
  );

  const oggetti = [
    { id: 'tabella:clienti', tipo: 'tabella', nome: 'clienti', gruppo: 'pubblico' },
    { id: 'tabella:ordini', tipo: 'tabella', nome: 'ordini', gruppo: 'pubblico' },
    { id: 'vista:v_ordini', tipo: 'vista', nome: 'v_ordini', gruppo: 'pubblico' },
    { id: 'tabella:log', tipo: 'tabella', nome: 'log', gruppo: 'privato' },
  ];
  const nuovo = () => creaStatoSelezione(oggetti);

  /* --- Default e tre stati ---------------------------------------------------- */

  {
    const s = nuovo();
    assert.strictEqual(s.stato('pubblico', 'struttura'), STATI.TUTTO, 'default: tutto selezionato');
    assert.strictEqual(s.stato('vista:v_ordini', 'dati'), STATI.NIENTE, 'una vista non porta righe');
    s.imposta('tabella:ordini', 'dati', false);
    assert.strictEqual(s.stato('pubblico', 'dati'), STATI.MISTO, 'un figlio spento: genitore a metà');
    assert.strictEqual(s.stato('tabella:ordini', 'dati'), STATI.NIENTE);
    s.imposta('pubblico', 'dati', true);
    assert.strictEqual(s.stato('pubblico', 'dati'), STATI.TUTTO, 'il gruppo riaccende i figli');
    console.log('  OK   default tutto-selezionato e propagazione a tre stati');
  }

  /* --- La ricerca non è una selezione -------------------------------------------- */

  {
    const s = nuovo();
    s.imposta('tabella:log', 'dati', false);
    const visibili = s.cerca('ord');
    assert.deepStrictEqual([...visibili].sort(), ['tabella:ordini', 'vista:v_ordini']);
    assert.strictEqual(s.stato('tabella:log', 'dati'), STATI.NIENTE, 'nascosto ma non toccato');
    assert.strictEqual(s.stato('tabella:clienti', 'struttura'), STATI.TUTTO, 'fuori filtro ma selezionato');
    assert.deepStrictEqual(s.cerca(''), ['tabella:clienti', 'tabella:ordini', 'vista:v_ordini', 'tabella:log'],
      'ricerca vuota: tutto visibile');
    assert.deepStrictEqual(s.cerca('ORDINI'), ['tabella:ordini', 'vista:v_ordini'], 'maiuscole indifferenti');
    console.log('  OK   filtrare non deseleziona mai');
  }

  /* --- Azioni globali e riepilogo --------------------------------------------------- */

  {
    const s = nuovo();
    s.deselezionaTutto();
    assert.deepStrictEqual(s.riepilogo(), {
      oggetti: 4, conStruttura: 0, conDati: 0,
      esclusi: ['tabella:clienti', 'tabella:ordini', 'vista:v_ordini', 'tabella:log'],
    });
    s.soloStruttura();
    assert.strictEqual(s.riepilogo().conDati, 0);
    assert.strictEqual(s.riepilogo().conStruttura, 4);
    s.soloDati();
    assert.deepStrictEqual(s.riepilogo().esclusi, ['vista:v_ordini'], 'solo-dati esclude la vista');
    s.selezionaTutto();
    assert.strictEqual(s.riepilogo().conDati, 3, 'tutto: dati solo dove hanno senso');
    console.log('  OK   azioni globali e riepilogo per la conferma');
  }

  /* --- Verso il piano ----------------------------------------------------------------- */

  {
    const s = nuovo();
    s.imposta('tabella:log', 'struttura', false).imposta('tabella:log', 'dati', false);
    const mappa = s.perPiano();
    assert.deepStrictEqual(mappa['tabella:log'], { struttura: false, dati: false });
    assert.deepStrictEqual(mappa['tabella:ordini'], { struttura: true, dati: true });
    // La mappa entra nel piano personalizzato così com'è: se le due forme
    // divergono il difetto si scopre in produzione, non qui.
    const { creaPianoExport, MODALITA } = require('../db/exportPlan');
    const piano = creaPianoExport({
      catalogo: {
        dbType: 'postgresql', db: 'negozio',
        oggetti: [
          { tipo: 'tabella', nome: 'clienti' }, { tipo: 'tabella', nome: 'ordini' },
          { tipo: 'vista', nome: 'v_ordini' }, { tipo: 'tabella', nome: 'log' },
        ],
        dipendenze: [{ da: 'vista:v_ordini', a: 'tabella:ordini', tipo: 'vista' }],
      },
      connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
      selezione: Object.fromEntries(
        Object.entries(mappa).filter(([, v]) => v.struttura || v.dati).map(([k, v]) => [k, v]),
      ),
    });
    assert.ok(piano.oggetti.some((o) => o.id === 'tabella:ordini' && o.dati));
    assert.ok(!piano.oggetti.some((o) => o.id === 'tabella:log'), 'deselezionato resta fuori');
    console.log('  OK   la mappa alimenta il piano senza adattamenti');
  }

  /* --- Rifiuti --------------------------------------------------------------------------- */

  {
    const s = nuovo();
    assert.throws(() => s.imposta('vista:v_ordini', 'dati', true), /non porta righe/);
    assert.throws(() => s.imposta('tabella:mai', 'dati', true), /assente/);
    assert.throws(() => s.imposta('tabella:ordini', 'colore', true), /Colonna sconosciuta/);
    assert.throws(() => creaStatoSelezione([
      { id: 'tabella:a', tipo: 'tabella', nome: 'a' },
      { id: 'tabella:a', tipo: 'tabella', nome: 'a' },
    ]), /duplicato/);
    console.log('  OK   dati sulle view, nomi inventati e duplicati rifiutati');
  }

  /* --- Scala -------------------------------------------------------------------------------- */

  {
    const molti = Array.from({ length: 5000 }, (_, i) => ({
      id: `tabella:t${i}`, tipo: 'tabella', nome: `t${i}`, gruppo: `g${i % 50}`,
    }));
    const s = creaStatoSelezione(molti);
    s.imposta('g7', 'dati', false);
    assert.strictEqual(s.stato('g7', 'dati'), STATI.NIENTE);
    assert.strictEqual(s.cerca('t4999').length, 1);
    assert.strictEqual(s.riepilogo().oggetti, 5000);
    console.log('  OK   cinquemila oggetti senza sforzo');
  }

  console.log('  OK   Selezione export del wizard passed');
})().catch((err) => {
  console.error('  FAIL Selezione export:', err.stack || err);
  process.exitCode = 1;
});
