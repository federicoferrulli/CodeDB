'use strict';

// Il piano di EXPORT si prova senza alcun database: il catalogo e' un dato, e
// tutto cio' che `creaPianoExport` fa e' decidere. Le decisioni provate qui
// sono quelle che, sbagliate, producono un export che si dichiara completo e
// non lo e': una dipendenza non chiusa, un oggetto sparito senza motivo, un
// ordine di ricostruzione che non regge, un conteggio lanciato in «solo
// struttura».

const assert = require('assert');
const { creaPianoExport, verificaImpronta, databaseDiSistema, MODALITA } = require('../db/exportPlan');

// Catalogo di riferimento: due tabelle legate da una FK, una vista sopra una
// delle due, un trigger, una sequenza posseduta, una routine con SQL dinamico
// e una tabella che nessuno riferisce.
const catalogo = {
  dbType: 'postgresql',
  db: 'negozio',
  oggetti: [
    { tipo: 'tabella', nome: 'clienti', righeStimate: 10, identita: { kind: 'pk', columns: ['id'] } },
    { tipo: 'tabella', nome: 'ordini', righeStimate: 500, identita: { kind: 'pk', columns: ['id'] } },
    { tipo: 'tabella', nome: 'log', righeStimate: 900000, identita: null },
    { tipo: 'vista', nome: 'v_ordini' },
    { tipo: 'trigger', nome: 'trg_ordini', tabella: 'ordini' },
    { tipo: 'sequenza', nome: 'ordini_id_seq' },
    { tipo: 'routine', nome: 'ricalcola' },
  ],
  dipendenze: [
    { da: 'tabella:ordini', a: 'tabella:clienti', tipo: 'fk', campo: 'cliente_id' },
    { da: 'vista:v_ordini', a: 'tabella:ordini', tipo: 'vista' },
    { da: 'trigger:trg_ordini', a: 'tabella:ordini', tipo: 'trigger' },
    { da: 'tabella:ordini', a: 'sequenza:ordini_id_seq', tipo: 'sequenza' },
    { da: 'routine:ricalcola', a: null, tipo: 'dinamica', nota: 'il corpo compone SQL a runtime' },
  ],
};

const sola = (id) => ({ [id]: { struttura: true, dati: false } });
const trova = (plan, id) => plan.oggetti.find((o) => o.id === id);

(async () => {
  /* --- Le quattro modalita' ---------------------------------------------- */

  const completo = creaPianoExport({ catalogo, connection: 'locale', modalita: MODALITA.STRUTTURA_E_DATI });
  assert.strictEqual(completo.oggetti.length, 7, 'struttura e dati prende tutto il catalogo');
  assert.strictEqual(trova(completo, 'tabella:ordini').dati, true);
  assert.strictEqual(trova(completo, 'vista:v_ordini').dati, false, 'una vista non porta righe');
  assert.strictEqual(completo.contaRighe, true);

  const struttura = creaPianoExport({ catalogo, connection: 'locale', modalita: MODALITA.SOLO_STRUTTURA });
  assert.ok(struttura.oggetti.every((o) => o.dati === false), 'solo struttura non seleziona dati');
  // §3 del piano: solo struttura non scorre i dati e non lancia COUNT(*). Il
  // piano lo DICHIARA, cosi' nessuna fase puo' decidere da se' di contare.
  assert.strictEqual(struttura.contaRighe, false, 'solo struttura non deve contare righe');
  assert.strictEqual(struttura.verifica.dati, 'nessuna');
  assert.ok(struttura.oggetti.every((o) => o.righeStimate === null),
    'senza dati nel piano non compare nemmeno una stima di righe');

  const dati = creaPianoExport({ catalogo, connection: 'locale', modalita: MODALITA.SOLO_DATI });
  assert.ok(dati.oggetti.every((o) => o.struttura === false), 'solo dati non crea nulla');
  assert.deepStrictEqual(dati.oggetti.map((o) => o.id).sort(),
    ['tabella:clienti', 'tabella:log', 'tabella:ordini'],
    'solo dati tiene esclusivamente cio che porta righe');

  const mista = creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: {
      'tabella:ordini': { struttura: true, dati: true },
      'tabella:clienti': { struttura: true, dati: true },
      'tabella:log': { struttura: true, dati: false },
    },
  });
  assert.strictEqual(trova(mista, 'tabella:log').dati, false, 'la tabella voluminosa resta senza dati');
  assert.strictEqual(trova(mista, 'tabella:log').struttura, true, 'ma la sua struttura c e');
  console.log('  OK   le quattro modalita producono le selezioni dichiarate');

  /* --- Il piano e' un contratto ------------------------------------------ */

  verificaImpronta(completo);
  assert.ok(Object.isFrozen(completo) && Object.isFrozen(completo.oggetti[0]),
    'il piano e i suoi rami sono congelati');
  assert.throws(() => verificaImpronta({ ...completo, sourceDb: 'altro' }), /impronta/i,
    'cambiare il piano dopo la firma deve essere rifiutato');

  // Stesso catalogo, stessa impronta: l'anteprima e l'esecuzione possono
  // ricostruire il piano invece di trasportarlo, e restano confrontabili.
  const ripetuto = creaPianoExport({ catalogo, connection: 'locale', modalita: MODALITA.STRUTTURA_E_DATI });
  assert.strictEqual(ripetuto.fingerprint, completo.fingerprint, 'il piano deve essere deterministico');
  // E l'ordine con cui si scrivono le chiavi della selezione non e' una scelta
  // dell'utente: due selezioni uguali devono dare la stessa impronta.
  const a = creaPianoExport({ catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: { 'tabella:ordini': { struttura: true, dati: true }, 'tabella:clienti': { struttura: true, dati: true } } });
  const b = creaPianoExport({ catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: { 'tabella:clienti': { struttura: true, dati: true }, 'tabella:ordini': { struttura: true, dati: true } } });
  assert.strictEqual(a.fingerprint, b.fingerprint, 'l ordine delle chiavi non deve cambiare l impronta');
  console.log('  OK   il piano e immutabile, firmato e deterministico');

  /* --- Chiusura delle dipendenze ----------------------------------------- */

  // Chiedere la sola vista deve portare dentro la tabella su cui poggia, e
  // dirlo: un albero di selezione in cui compaiono oggetti dal nulla non e'
  // un'anteprima, e' una sorpresa.
  const conVista = creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA, selezione: sola('vista:v_ordini'),
  });
  assert.ok(trova(conVista, 'tabella:ordini'), 'la vista tira dentro la tabella');
  assert.ok(trova(conVista, 'sequenza:ordini_id_seq'), 'e la chiusura e transitiva: la tabella tira la sequenza');
  const motivo = conVista.dipendenzeAggiunte.find((d) => d.id === 'tabella:ordini');
  assert.strictEqual(motivo.richiestoDa, 'vista:v_ordini');
  assert.match(motivo.motivo, /vista/, 'il motivo dice quale legame ha aggiunto l oggetto');
  assert.strictEqual(trova(conVista, 'tabella:ordini').aggiuntoPerDipendenza, true);

  // La FK NON e' una dipendenza di creazione: chiedere gli ordini non tira
  // dentro i clienti per creare la tabella. Il vincolo resta pero' dichiarato,
  // con l'informazione che il suo bersaglio non e' nel perimetro.
  const soliOrdini = creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA, selezione: sola('tabella:ordini'),
  });
  assert.ok(!trova(soliOrdini, 'tabella:clienti'), 'una FK non allarga il perimetro di nascosto');
  const vincolo = soliOrdini.ordine.vincoli.find((v) => v.a === 'tabella:clienti');
  assert.strictEqual(vincolo.presente, false, 'il vincolo dichiara che il bersaglio manca');

  // Una dipendenza fuori dal database e' un PREREQUISITO, non un oggetto da
  // aggiungere: confondere i due casi produce un export che si crede completo.
  const conEsterna = creaPianoExport({
    catalogo: {
      ...catalogo,
      dipendenze: [...catalogo.dipendenze,
        { da: 'tabella:ordini', a: 'tabella:listino', tipo: 'fk', esterna: true, db: 'anagrafiche' }],
    },
    connection: 'locale', modalita: MODALITA.STRUTTURA_E_DATI,
  });
  assert.strictEqual(conEsterna.prerequisitiEsterni.length, 1);
  assert.strictEqual(conEsterna.prerequisitiEsterni[0].db, 'anagrafiche');
  assert.ok(!conEsterna.oggetti.some((o) => o.nome === 'listino'), 'un prerequisito esterno non entra nel perimetro');

  // Un corpo di routine con SQL dinamico ha dipendenze che il catalogo non
  // conosce: vanno dichiarate, non date per assenti.
  assert.strictEqual(completo.dipendenzeNonDeducibili.length, 1);
  assert.match(completo.dipendenzeNonDeducibili[0].nota, /runtime/);
  console.log('  OK   la chiusura dichiara aggiunte, prerequisiti esterni e dipendenze non deducibili');

  /* --- Ordine di ricostruzione ------------------------------------------- */

  const ordine = completo.ordine.creazione;
  assert.ok(ordine.indexOf('tabella:ordini') < ordine.indexOf('vista:v_ordini'),
    'la tabella va creata prima della vista che la usa');
  assert.ok(ordine.indexOf('sequenza:ordini_id_seq') < ordine.indexOf('tabella:ordini'),
    'la sequenza va creata prima della tabella che la possiede');
  assert.deepStrictEqual(completo.ordine.cicli, [], 'qui non ci sono cicli di creazione');

  // Due tabelle che si riferiscono a vicenda sono legali e comuni. Poiche' le
  // FK si applicano dopo i dati, questo NON e' un ciclo di creazione: se
  // finisse fra i cicli, un export normalissimo verrebbe dichiarato irregolare.
  const fkCircolare = creaPianoExport({
    catalogo: {
      ...catalogo,
      dipendenze: [...catalogo.dipendenze, { da: 'tabella:clienti', a: 'tabella:ordini', tipo: 'fk', campo: 'ultimo' }],
    },
    connection: 'locale', modalita: MODALITA.STRUTTURA_E_DATI,
  });
  assert.deepStrictEqual(fkCircolare.ordine.cicli, [], 'un ciclo di FK non e un ciclo di creazione');
  assert.strictEqual(fkCircolare.ordine.vincoli.length, 2, 'ma entrambi i vincoli restano da applicare dopo i dati');

  // Un ciclo VERO fra dipendenze di creazione si dichiara invece di essere
  // nascosto sotto un ordine inventato.
  const cicloVero = creaPianoExport({
    catalogo: {
      dbType: 'postgresql', db: 'negozio',
      oggetti: [{ tipo: 'routine', nome: 'uno' }, { tipo: 'routine', nome: 'due' }],
      dipendenze: [
        { da: 'routine:uno', a: 'routine:due', tipo: 'routine' },
        { da: 'routine:due', a: 'routine:uno', tipo: 'routine' },
      ],
    },
    connection: 'locale', modalita: MODALITA.SOLO_STRUTTURA,
  });
  assert.deepStrictEqual([...cicloVero.ordine.cicli].sort(), ['routine:due', 'routine:uno']);
  console.log('  OK   l ordine separa creazione, dati e vincoli, e dichiara i cicli veri');

  /* --- Esclusioni e dipendenze dei dati ---------------------------------- */

  assert.deepStrictEqual(
    soliOrdini.esclusi.map((e) => e.id).sort(),
    ['routine:ricalcola', 'tabella:clienti', 'tabella:log', 'trigger:trg_ordini', 'vista:v_ordini'],
    'tutto cio che resta fuori e elencato, non semplicemente assente',
  );
  assert.strictEqual(soliOrdini.esclusi[0].motivo, 'non selezionato');
  const escluso = creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: { 'tabella:ordini': { struttura: true, dati: true }, 'tabella:log': { struttura: false, dati: false } },
  });
  assert.strictEqual(escluso.esclusi.find((e) => e.id === 'tabella:log').motivo,
    'escluso esplicitamente dalla selezione', 'scegliere di escludere non e lo stesso che non scegliere');

  // La chiusura dello SCHEMA non e' la chiusura dei DATI: esportare gli ordini
  // senza i clienti produce righe orfane. Non e' un errore, ma non puo'
  // restare invisibile.
  const orfane = creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: {
      'tabella:ordini': { struttura: true, dati: true },
      'tabella:clienti': { struttura: true, dati: false },
    },
  });
  const avviso = orfane.dipendenzeDati.find((d) => d.da === 'tabella:ordini');
  assert.strictEqual(avviso.stato, 'bersaglio-senza-dati');
  assert.strictEqual(avviso.campo, 'cliente_id');

  const filtrato = creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: {
      'tabella:ordini': { struttura: true, dati: true, filtro: { condizioni: [{ campo: 'anno', operatore: 'uguale', valore: 2026 }], unione: 'tutte' } },
      'tabella:clienti': { struttura: true, dati: true },
    },
  });
  assert.strictEqual(filtrato.dipendenzeDati[0].stato, 'chiusura-dati-non-garantita');
  assert.ok(trova(filtrato, 'tabella:ordini').filtro, 'il filtro viaggia nel piano');
  console.log('  OK   esclusioni con motivo e dipendenze dei dati dichiarate');

  /* --- Cio' che deve essere rifiutato ------------------------------------ */

  assert.throws(() => creaPianoExport({ catalogo, connection: 'locale', modalita: 'quasi-tutto' }),
    /Modalità di export sconosciuta/, 'una modalita inventata non vale «fai qualcosa»');
  assert.throws(() => creaPianoExport({ catalogo, connection: '', modalita: MODALITA.STRUTTURA_E_DATI }),
    /Connessione/, 'senza connessione i permessi non poggiano su nulla');
  // Un nome scritto male non deve produrre un export silenziosamente vuoto.
  assert.throws(() => creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA, selezione: sola('tabella:ordni'),
  }), /assente dal catalogo/, 'una selezione che nomina un oggetto inesistente e un errore');
  assert.throws(() => creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: { 'routine:ricalcola': { struttura: true, dati: true } },
  }), /non porta righe/, 'i dati di una routine non esistono');
  assert.throws(() => creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: { 'tabella:ordini': { struttura: true, dati: false, filtro: { condizioni: [] } } },
  }), /filtro/, 'un filtro senza dati non significa niente');
  assert.throws(() => creaPianoExport({
    catalogo, connection: 'locale', modalita: MODALITA.PERSONALIZZATA,
    selezione: { 'tabella:ordini': { struttura: false, dati: false } },
  }), /non contiene alcun oggetto/, 'un piano vuoto non e un piano');
  assert.throws(() => creaPianoExport({ catalogo, connection: 'locale' , modalita: MODALITA.PERSONALIZZATA }),
    /richiede una selezione/);

  // Il controllo sui database di sistema viveva SOLO nel browser: chi parlava
  // direttamente col socket poteva chiedere l'export di `mysql`.
  for (const [tipo, nome] of [['mysql', 'mysql'], ['postgresql', 'pg_catalog'], ['mongodb', 'admin']]) {
    assert.ok(databaseDiSistema(tipo, nome), `${nome} deve essere riconosciuto di sistema su ${tipo}`);
    assert.throws(() => creaPianoExport({
      catalogo: { ...catalogo, dbType: tipo, db: nome }, connection: 'locale', modalita: MODALITA.SOLO_STRUTTURA,
    }), /database di sistema/);
  }
  assert.ok(!databaseDiSistema('mysql', 'negozio'));

  // Un catalogo malformato si ferma alla costruzione del piano, cioe' prima
  // che qualunque cosa venga letta dal database.
  assert.throws(() => creaPianoExport({
    catalogo: { dbType: 'mysql', db: 'x', oggetti: [{ tipo: 'tabellina', nome: 'y' }] },
    connection: 'locale', modalita: MODALITA.SOLO_STRUTTURA,
  }), /Tipo di oggetto sconosciuto/);
  assert.throws(() => creaPianoExport({
    catalogo: { dbType: 'mysql', db: 'x', oggetti: [{ tipo: 'tabella', nome: 'y' }, { tipo: 'tabella', nome: 'y' }] },
    connection: 'locale', modalita: MODALITA.SOLO_STRUTTURA,
  }), /due volte/);
  assert.throws(() => creaPianoExport({
    catalogo: {
      dbType: 'mysql', db: 'x', oggetti: [{ tipo: 'tabella', nome: 'y' }],
      dipendenze: [{ da: 'tabella:y', a: 'tabella:mai-vista', tipo: 'fk' }],
    },
    connection: 'locale', modalita: MODALITA.SOLO_STRUTTURA,
  }), /non dichiarata esterna/, 'una dipendenza verso il nulla non si ignora');
  console.log('  OK   cio che non e esprimibile viene rifiutato prima di ogni lettura');

  console.log('  OK   Piano di export: modalita, chiusura, ordine ed esclusioni passed');
})().catch((err) => {
  console.error('  FAIL Piano di export:', err.stack || err);
  process.exitCode = 1;
});
