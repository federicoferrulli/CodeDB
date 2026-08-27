'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari delle decisioni del pannello delle chiavi esterne
 * (public/js/fk-relazioni.js). Nessun database, nessun browser: il modulo non
 * importa nulla proprio per essere provabile qui.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede — il pannello si
 * apre lo stesso, con l'aria di funzionare:
 *   1. l'ORIGINE del collegamento sopravvive alla normalizzazione: un'ipotesi
 *      sul nome del campo mostrata come vincolo del database fa fidare
 *      l'utente di un riferimento che nessuno garantisce;
 *   2. l'etichetta cade sulla colonna che DISTINGUE le righe: su "stato"
 *      invece che su "ragione_sociale" l'elenco mostra venti voci uguali e
 *      sembra un elenco fatto bene di dati fatti male;
 *   3. la riga corrente si riconosce anche quando la chiave cambia tipo lungo
 *      la strada (42 dalla griglia, "42" dalla ricerca): senza, la spunta
 *      sparisce proprio mentre si decide se cambiare o riconfermare;
 *   4. i valori Extended JSON si leggono come valori e non come JSON grezzo
 *      ($oid, $date, $numberLong).
 * ------------------------------------------------------------------------- */

const assert = require('assert');

console.log('--- Test Unitari Relazioni (Chiavi Esterne) ---');

(async () => {
  const {
    descrittoreRelazione, indicizzaRelazioni, bersaglioRelazione, notaOrigine,
    testoValore, chiaveValore, stessoValore, scegliEtichetta, etichettaRiga,
    setDaRelazione,
    VINCOLO, EURISTICA,
  } = await import('../public/js/fk-relazioni.js');

  /* --- 1. Descrittori: normalizzazione delle tre sorgenti ----------------- */
  {
    // MySQL / PostgreSQL: vincolo dichiarato.
    const sql = descrittoreRelazione({
      campo: 'cliente_id', db: 'shop', tabella: 'clienti', colonna: 'id',
      origine: 'vincolo', molti: false,
    });
    assert.strictEqual(sql.origine, VINCOLO, 'il vincolo resta un vincolo');
    assert.strictEqual(sql.colonna, 'id');

    // MongoDB: euristica sul nome, colonna riferita implicita.
    const mongo = descrittoreRelazione({
      campo: 'people_id', db: 'test', tabella: 'people', colonna: '_id',
      origine: 'euristica', molti: false,
    });
    assert.strictEqual(mongo.origine, EURISTICA, "l'euristica resta un'ipotesi");

    // Un'origine sconosciuta NON diventa un vincolo: nel dubbio si dichiara
    // meno, mai di più.
    const ignota = descrittoreRelazione({ campo: 'x_id', tabella: 'x', origine: 'boh' });
    assert.strictEqual(ignota.origine, EURISTICA, "origine ignota degrada a ipotesi");
    assert.strictEqual(ignota.colonna, '_id', 'colonna mancante ripiega su _id');

    // Descrittori inutilizzabili: scartati, non mostrati a metà.
    assert.strictEqual(descrittoreRelazione(null), null);
    assert.strictEqual(descrittoreRelazione({ campo: 'a' }), null, 'senza tabella non è una relazione');
    assert.strictEqual(descrittoreRelazione({ tabella: 'b' }), null, 'senza campo non è una relazione');
  }
  console.log('  OK   Descrittori normalizzati dalle tre sorgenti, origine preservata');

  /* --- 2. Indice per la griglia ------------------------------------------ */
  {
    const indice = indicizzaRelazioni([
      { campo: 'cliente_id', tabella: 'clienti', colonna: 'id', origine: 'vincolo' },
      { campo: 'nulla', tabella: '' },                       // scartata
      { campo: 'sede_id', tabella: 'sedi', colonna: 'id', origine: 'euristica' },
    ]);
    assert.strictEqual(indice.size, 2, 'i descrittori inutilizzabili non entrano nell\'indice');
    assert.strictEqual(indice.get('cliente_id').tabella, 'clienti');
    assert.strictEqual(indice.get('nulla'), undefined);

    // Chiave composita: vince la prima colonna del vincolo.
    const composita = indicizzaRelazioni([
      { campo: 'k', tabella: 'primaria', colonna: 'a', origine: 'vincolo' },
      { campo: 'k', tabella: 'secondaria', colonna: 'b', origine: 'vincolo' },
    ]);
    assert.strictEqual(composita.get('k').tabella, 'primaria');

    // Ma un vincolo dichiarato sostituisce sempre un'ipotesi sullo stesso
    // campo: è l'ordine in cui il backend le concatena, e non deve contare.
    const misto = indicizzaRelazioni([
      { campo: 'cliente_id', tabella: 'indovinata', origine: 'euristica' },
      { campo: 'cliente_id', tabella: 'clienti', colonna: 'id', origine: 'vincolo' },
    ]);
    assert.strictEqual(misto.get('cliente_id').tabella, 'clienti', 'il vincolo batte l\'ipotesi');
    assert.strictEqual(misto.get('cliente_id').origine, VINCOLO);
  }
  console.log('  OK   Indice campo → relazione, vincolo prevalente sull\'ipotesi');

  {
    const indice = indicizzaRelazioni([{
      nome: 'fk_ordine_cliente', db: 'crm', tabella: 'clienti', origine: 'vincolo',
      coppie: [
        { campo: 'tenant_id', colonna: 'tenant', ordine: 1 },
        { campo: 'cliente_id', colonna: 'codice', ordine: 2 },
      ],
    }]);
    const relazione = indice.get('tenant_id');
    assert.strictEqual(relazione, indice.get('cliente_id'), 'le colonne indicano lo stesso vincolo');
    assert.deepStrictEqual(relazione.coppie.map((p) => [p.campo, p.colonna]), [
      ['tenant_id', 'tenant'], ['cliente_id', 'codice'],
    ]);
    assert.deepStrictEqual(setDaRelazione(relazione, { tenant: 7, codice: 42 }), {
      tenant_id: 7, cliente_id: 42,
    });
    assert.throws(() => setDaRelazione(relazione, { tenant: 7 }), /codice.*mancante/i);
  }
  console.log('  OK   FK composita: coppie ordinate e aggiornamento completo');

  /* --- 3. Bersaglio: lo schema si nomina solo se è un altro --------------- */
  {
    const stessoDb = { campo: 'c_id', db: 'shop', tabella: 'clienti', colonna: 'id', origine: VINCOLO };
    assert.strictEqual(bersaglioRelazione(stessoDb, 'shop'), 'clienti.id');
    // Su PostgreSQL il "database" della UI è lo SCHEMA: una FK verso un altro
    // schema è a tutti gli effetti una FK altrove, e va detto.
    assert.strictEqual(bersaglioRelazione(stessoDb, 'vendite'), 'shop.clienti.id');
    assert.ok(/dichiarata/.test(notaOrigine(stessoDb)));
    assert.ok(/ipotizzato/.test(notaOrigine({ origine: EURISTICA })));
  }
  console.log('  OK   Bersaglio qualificato solo quando cambia database/schema');

  /* --- 4. Valori Extended JSON leggibili --------------------------------- */
  {
    assert.strictEqual(testoValore({ $oid: '507f1f77bcf86cd799439011' }), '507f1f77bcf86cd799439011');
    assert.strictEqual(testoValore({ $numberLong: '9007199254740993' }), '9007199254740993',
      'un intero a 64 bit non deve passare da Number e perdere cifre');
    assert.strictEqual(testoValore({ $numberDecimal: '19.99' }), '19.99');
    assert.strictEqual(testoValore({ $date: '2026-03-01T10:00:00.000Z' }), '2026-03-01T10:00:00.000Z');
    assert.strictEqual(testoValore(null), 'null');
    assert.strictEqual(testoValore(undefined), '');
    assert.strictEqual(testoValore(42), '42');
    assert.strictEqual(testoValore(true), 'true');
    assert.strictEqual(testoValore([1, 2, 3]), '[3 elementi]');
    // Un testo lunghissimo non deve sfondare la riga dell'elenco.
    assert.ok(testoValore('x'.repeat(500)).length <= 120);
  }
  console.log('  OK   Valori EJSON mostrati come valori, non come JSON grezzo');

  /* --- 5. Confronto permissivo fra chiavi -------------------------------- */
  {
    assert.ok(stessoValore(42, '42'), 'la stessa chiave con tipo diverso è la stessa chiave');
    assert.ok(stessoValore({ $oid: 'aa' }, { $oid: 'aa' }));
    assert.ok(stessoValore({ $numberLong: '7' }, 7));
    assert.ok(!stessoValore(42, 43));
    assert.ok(!stessoValore(null, 0), 'nullo e zero non sono lo stesso riferimento');
    assert.ok(!stessoValore('abc', 'abd'));
    // Il testo che non è un numero resta il testo che è.
    assert.strictEqual(chiaveValore('ABC-1'), 'ABC-1');
  }
  console.log('  OK   Riga corrente riconosciuta anche se la chiave cambia tipo');

  /* --- 6. Scelta dell'etichetta: il caso che non si vede ----------------- */
  {
    const righe = [
      { id: 1, ragione_sociale: 'Rossi S.p.A.', stato: 'attivo', note: null },
      { id: 2, ragione_sociale: 'Bianchi Srl', stato: 'attivo', note: null },
      { id: 3, ragione_sociale: 'Verdi & C.', stato: 'attivo', note: 'x' },
    ];
    assert.strictEqual(scegliEtichetta(righe, 'id'), 'ragione_sociale',
      "l'etichetta va sulla colonna che distingue le righe");

    // Colonna costante: non distingue nulla, non fa da etichetta.
    const costanti = [{ id: 1, stato: 'attivo' }, { id: 2, stato: 'attivo' }];
    assert.strictEqual(scegliEtichetta(costanti, 'id'), null);

    // Colonna piena a metà: farebbe sembrare vuote righe che non lo sono.
    const bucata = [
      { id: 1, descr: 'uno' }, { id: 2, descr: null }, { id: 3, descr: null }, { id: 4, descr: null },
    ];
    assert.strictEqual(scegliEtichetta(bucata, 'id'), null);

    // Nessuna colonna testuale: si mostra la sola chiave, senza inventare.
    const soloNumeri = [{ id: 1, qta: 10 }, { id: 2, qta: 20 }];
    assert.strictEqual(scegliEtichetta(soloNumeri, 'id'), null);

    // La chiave non può fare da etichetta di sé stessa, e nemmeno l'_id
    // sintetico che CodeDB aggiunge alle righe SQL.
    const soloChiave = [{ id: 'a', _id: '{"id":"a"}' }, { id: 'b', _id: '{"id":"b"}' }];
    assert.strictEqual(scegliEtichetta(soloChiave, 'id'), null);

    // Una riga sola: la distintività non è calcolabile, ma un'etichetta piena
    // resta utile — è il caso "chi è il cliente 42", il più frequente di tutti.
    assert.strictEqual(scegliEtichetta([{ id: 42, nome: 'Rossi' }], 'id'), 'nome');

    // Elenco vuoto: nessuna etichetta, nessuna eccezione.
    assert.strictEqual(scegliEtichetta([], 'id'), null);
    assert.strictEqual(scegliEtichetta(null, 'id'), null);
  }
  console.log('  OK   Etichetta scelta dai dati, colonne costanti e bucate scartate');

  /* --- 7. Testo di una riga nell'elenco ---------------------------------- */
  {
    const riga = { id: 42, nome: 'Rossi S.p.A.' };
    assert.strictEqual(etichettaRiga(riga, 'id', 'nome'), '42 — Rossi S.p.A.');
    assert.strictEqual(etichettaRiga(riga, 'id', null), '42', 'senza etichetta resta la chiave');
    // Etichetta nulla su quella riga: la chiave da sola, non "42 — null".
    assert.strictEqual(etichettaRiga({ id: 7, nome: null }, 'id', 'nome'), '7');
    assert.strictEqual(etichettaRiga({ _id: { $oid: 'abc' } }, '_id', null), 'abc');
  }
  console.log('  OK   Righe dell\'elenco leggibili, chiave sempre in testa');

  console.log('Tutti i test unitari sulle relazioni superati!');
})().catch((err) => {
  console.error('\nFALLITO (relazioni):', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
