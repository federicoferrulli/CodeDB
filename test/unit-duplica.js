'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari della duplicazione di righe/documenti (db/duplica.js).
 * Nessun database: il modulo è puro proprio per poter essere provato qui, e
 * perché è qui che stanno le decisioni che sbagliate NON si vedono.
 *
 * Cosa vale la pena verificare:
 *   1. la chiave primaria è SEMPRE nuova, in tutte e due le modalità — è la
 *      sola che collide con certezza, e un duplicato che la conserva non è un
 *      duplicato ma un errore del driver;
 *   2. "senza chiavi" tocca anche gli indici unici, "con chiavi" no: se le due
 *      modalità facessero la stessa cosa la voce di menu mentirebbe;
 *   3. le colonne CALCOLATE dal DBMS escono sempre: nominarle nell'INSERT è un
 *      errore SQL, non una scelta dell'utente;
 *   4. una chiave composta non viene rifatta per intero: cambiare anche
 *      `ordine_id` sposterebbe la riga in un altro ordine, e sembrerebbe
 *      giusto;
 *   5. il valore nuovo evita quelli già occupati (MAX+1 non basta se il MAX è
 *      stato letto e poi occupato, e un suffisso "-copia" può essere già lì);
 *   6. il duplicato di un intero resta un intero: `{$numberInt}` che diventa
 *      un double dà una collection con due tipi sullo stesso campo.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const {
  OMESSA, AZZERATA, RICALCOLA, CONSERVATA,
  valoreSemplice, categoriaTipo, lunghezzaMassima, candidatoTesto,
  pianificaDuplicazione, calcolaNuovoValore, documentoSorgente, applicaRicalcolo, riavvolgi,
} = require('../db/duplica');

console.log('--- Test Unitari Duplicazione Riga ---');

// Tabella di riferimento: la forma più comune (PK auto, una email unica NOT
// NULL, uno slug unico annullabile, una colonna calcolata).
const COLONNE = [
  { name: 'id', tipo: 'int', pk: true, nullable: false, generabile: true, generata: false },
  { name: 'email', tipo: 'varchar(120)', pk: false, nullable: false, generabile: false, generata: false },
  { name: 'slug', tipo: 'varchar(40)', pk: false, nullable: true, generabile: false, generata: false },
  { name: 'nome', tipo: 'varchar(80)', pk: false, nullable: false, generabile: false, generata: false },
  { name: 'nome_upper', tipo: 'varchar(80)', pk: false, nullable: false, generabile: false, generata: true },
];
const UNICHE = [['email'], ['slug']];
const RIGA = { _id: { id: 7 }, id: 7, email: 'a@b.it', slug: 'rossi', nome: 'Rossi', nome_upper: 'ROSSI' };

(async () => {
  /* --- 1. Senza chiavi: primaria via DBMS, uniche svuotate --------------- */
  {
    const p = pianificaDuplicazione({
      doc: RIGA, colonne: COLONNE, uniche: UNICHE, conChiavi: false, idVirtuale: true,
    });
    assert.ok(!('_id' in p.doc), '_id virtuale non è una colonna: non va inserito');
    assert.ok(!('id' in p.doc), 'la chiave primaria auto va omessa, la genera il DBMS');
    assert.strictEqual(p.azioni.id, OMESSA);
    assert.strictEqual(p.doc.slug, null, 'chiave unica annullabile → NULL');
    assert.strictEqual(p.azioni.slug, AZZERATA);
    assert.strictEqual(p.azioni.email, RICALCOLA, 'unica NOT NULL → serve un valore nuovo');
    assert.deepStrictEqual(p.ricalcola, ['email']);
    assert.ok(!('nome_upper' in p.doc), 'colonna calcolata: non va scritta');
    assert.strictEqual(p.doc.nome, 'Rossi', 'i dati veri restano quelli della riga sorgente');
  }
  console.log('  OK   Senza chiavi: primaria omessa, uniche svuotate o ricalcolate');

  /* --- 2. Con chiavi: cambia SOLO la primaria ---------------------------- */
  {
    const p = pianificaDuplicazione({
      doc: RIGA, colonne: COLONNE, uniche: UNICHE, conChiavi: true, idVirtuale: true,
    });
    assert.ok(!('id' in p.doc), 'la primaria è nuova anche qui');
    assert.strictEqual(p.doc.email, 'a@b.it', 'con chiavi le uniche restano com\'erano');
    assert.strictEqual(p.doc.slug, 'rossi');
    assert.deepStrictEqual(p.ricalcola, [], 'nessun valore da calcolare: la primaria la fa il DBMS');
    assert.ok(!('nome_upper' in p.doc), 'la colonna calcolata esce anche con le chiavi');
    assert.ok(
      p.note.some((n) => n.includes('email') && n.toLowerCase().includes('conservate')),
      'va detto che le uniche restano: l\'inserimento può fallire'
    );
  }
  console.log('  OK   Con chiavi: cambia solo la primaria, il resto resta');

  /* --- 3. Primaria non generabile: valore nuovo, non NULL ---------------- */
  {
    const colonne = [
      { name: 'codice', tipo: 'varchar(10)', pk: true, nullable: false, generabile: false, generata: false },
      { name: 'descr', tipo: 'text', pk: false, nullable: true, generabile: false, generata: false },
    ];
    for (const conChiavi of [false, true]) {
      const p = pianificaDuplicazione({
        doc: { codice: 'AB', descr: 'x' }, colonne, uniche: [], conChiavi, idVirtuale: false,
      });
      assert.deepStrictEqual(p.ricalcola, ['codice'], `codice va ricalcolato (conChiavi=${conChiavi})`);
      assert.strictEqual(p.doc.codice, 'AB', 'il valore vecchio resta finché la strategia non calcola il nuovo');
    }
  }
  console.log('  OK   Primaria senza generatore: sempre ricalcolata');

  /* --- 4. Primaria composta: si rifà solo l'ultima componente ------------ */
  {
    const colonne = [
      { name: 'ordine_id', tipo: 'int', pk: true, nullable: false, generabile: false, generata: false },
      { name: 'riga', tipo: 'int', pk: true, nullable: false, generabile: false, generata: false },
      { name: 'qta', tipo: 'int', pk: false, nullable: false, generabile: false, generata: false },
    ];
    const p = pianificaDuplicazione({
      doc: { ordine_id: 3, riga: 1, qta: 5 }, colonne, uniche: [], conChiavi: true, idVirtuale: false,
    });
    assert.deepStrictEqual(p.ricalcola, ['riga'], 'si ricalcola l\'ultima componente');
    assert.strictEqual(p.azioni.ordine_id, CONSERVATA, 'l\'ordine non cambia: il duplicato resta nel suo ordine');
    assert.strictEqual(p.doc.ordine_id, 3);
    assert.ok(p.note.some((n) => n.includes('composta')), 'una chiave composta va spiegata');
  }
  console.log('  OK   Chiave composta: cambia l\'ultima componente, il contesto resta');

  /* --- 5. `_id` colonna VERA: non è la chiave virtuale ------------------- */
  {
    const colonne = [
      { name: '_id', tipo: 'varchar(24)', pk: true, nullable: false, generabile: false, generata: false },
      { name: 'v', tipo: 'int', pk: false, nullable: true, generabile: false, generata: false },
    ];
    const p = pianificaDuplicazione({
      doc: { _id: 'abc', v: 1 }, colonne, uniche: [], conChiavi: false, idVirtuale: false,
    });
    assert.deepStrictEqual(p.ricalcola, ['_id'], 'una colonna _id vera va ricalcolata, non buttata');
    assert.strictEqual(p.doc._id, 'abc');
  }
  console.log('  OK   `_id` colonna vera distinto dalla chiave virtuale SQL');

  /* --- 6. Documenti MongoDB: _id ObjectId generabile, unici ricalcolati -- */
  {
    const colonne = [
      { name: '_id', tipo: '', pk: true, nullable: false, generabile: true, generata: false },
      { name: 'codice', tipo: '', pk: false, nullable: false, generabile: false, generata: false },
    ];
    const doc = { _id: { $oid: '65'.padEnd(24, '0') }, codice: 'X1', note: 'ciao' };
    const senza = pianificaDuplicazione({ doc, colonne, uniche: [['codice']], conChiavi: false });
    assert.ok(!('_id' in senza.doc), 'ObjectId: basta non scriverlo, lo genera il server');
    assert.deepStrictEqual(senza.ricalcola, ['codice'], 'su MongoDB null non salva da un indice unico');
    const con = pianificaDuplicazione({ doc, colonne, uniche: [['codice']], conChiavi: true });
    assert.strictEqual(con.doc.codice, 'X1');
    assert.strictEqual(con.doc.note, 'ciao');
  }
  console.log('  OK   MongoDB: _id rigenerato, campi unici trattati come non annullabili');

  /* --- 7. Tipi, lunghezze e candidati testuali --------------------------- */
  {
    assert.strictEqual(categoriaTipo('int unsigned'), 'numero');
    assert.strictEqual(categoriaTipo('bigint'), 'numero');
    assert.strictEqual(categoriaTipo('numeric(12,2)'), 'numero');
    assert.strictEqual(categoriaTipo('character varying(80)'), 'testo');
    assert.strictEqual(categoriaTipo('text'), 'testo');
    assert.strictEqual(categoriaTipo('uuid'), 'uuid');
    assert.strictEqual(categoriaTipo('timestamp with time zone'), 'altro');
    assert.strictEqual(lunghezzaMassima('varchar(80)'), 80);
    assert.strictEqual(lunghezzaMassima('character varying(12)'), 12);
    assert.strictEqual(lunghezzaMassima('text'), null);
    assert.strictEqual(candidatoTesto('Rossi', 1, null), 'Rossi-copia');
    assert.strictEqual(candidatoTesto('Rossi', 3, null), 'Rossi-copia-3');
    // varchar(10): è la BASE ad accorciarsi, il suffisso deve restare intero o
    // il secondo tentativo sarebbe identico al primo.
    assert.strictEqual(candidatoTesto('Rossini', 1, 10), 'Ross-copia');
    assert.strictEqual(candidatoTesto('Rossini', 1, 10).length, 10);
    assert.notStrictEqual(candidatoTesto('Rossini', 1, 10), candidatoTesto('Rossini', 2, 10));
  }
  console.log('  OK   Tipi, lunghezze e suffissi');

  /* --- 8. Valore nuovo: evita quelli già occupati ------------------------ */
  {
    const occupati = new Set([4, 5, 6]);
    const num = await calcolaNuovoValore({
      tipo: 'int',
      originale: 1,
      massimo: async () => 3,
      esiste: async (v) => occupati.has(v),
    });
    assert.strictEqual(num.valore, 7, 'MAX+1 occupato: si va avanti finché è libero');

    const testo = await calcolaNuovoValore({
      tipo: 'varchar(40)',
      originale: 'Rossi',
      massimo: async () => null,
      esiste: async (v) => v === 'Rossi-copia',
    });
    assert.strictEqual(testo.valore, 'Rossi-copia-2', 'il primo suffisso era già preso');

    const vuoto = await calcolaNuovoValore({
      tipo: 'int', originale: null, massimo: async () => null, esiste: async () => false,
    });
    assert.strictEqual(vuoto.valore, 1, 'tabella vuota: si parte da 1');

    // Tipo senza una regola sensata (una data come chiave): meglio dire di no
    // che inventare un valore.
    const nulla = await calcolaNuovoValore({
      tipo: 'timestamp', originale: '2024-01-01', massimo: async () => null, esiste: async () => false,
    });
    assert.strictEqual(nulla, null);

    // MongoDB non dichiara tipi: lo dice il valore.
    const mongoNum = await calcolaNuovoValore({
      tipo: '', originale: 41, massimo: async () => 41, esiste: async () => false,
    });
    assert.strictEqual(mongoNum.valore, 42);
    const mongoTxt = await calcolaNuovoValore({
      tipo: '', originale: 'utente-1', massimo: async () => null, esiste: async () => false,
    });
    assert.strictEqual(mongoTxt.valore, 'utente-1-copia');

    // Suffissi finiti: nessun valore, non un valore qualsiasi.
    const esaurito = await calcolaNuovoValore({
      tipo: 'varchar(40)', originale: 'x', massimo: async () => null, esiste: async () => true, tentativi: 3,
    });
    assert.strictEqual(esaurito, null);
  }
  console.log('  OK   Valore nuovo calcolato evitando quelli occupati');

  /* --- 9. Involucri Extended JSON ---------------------------------------- */
  {
    assert.strictEqual(valoreSemplice({ $numberLong: '9007199254740993' }), 9007199254740993);
    assert.strictEqual(valoreSemplice({ $oid: 'abc' }), 'abc');
    assert.strictEqual(valoreSemplice('x'), 'x');
    assert.strictEqual(valoreSemplice(null), null);
    assert.deepStrictEqual(riavvolgi({ $numberInt: '5' }, 6), { $numberInt: '6' }, 'un int resta un int');
    assert.deepStrictEqual(riavvolgi({ $numberLong: '5' }, 6), { $numberLong: '6' });
    assert.strictEqual(riavvolgi(5, 6), 6, 'un numero nudo resta nudo');
    assert.strictEqual(riavvolgi({ $numberInt: '5' }, 'testo'), 'testo', 'il testo non si riavvolge');
  }
  console.log('  OK   Involucri EJSON conservati nel valore nuovo');

  /* --- 10. Documento sorgente e esito del ricalcolo ---------------------- */
  {
    assert.deepStrictEqual(documentoSorgente('{"a":1}'), { a: 1 });
    assert.throws(() => documentoSorgente('['), /non valido/);
    assert.throws(() => documentoSorgente('[1,2]'), /non valido/, 'un array non è una riga');
    assert.throws(() => documentoSorgente('null'), /non valido/);

    const piano = { doc: { id: 1 }, azioni: {}, note: [], ricalcola: [] };
    applicaRicalcolo(piano, 'id', { valore: 9, come: 'max+1' }, { pk: true });
    assert.strictEqual(piano.doc.id, 9);
    assert.ok(piano.note.some((n) => n.includes('id')));

    // Primaria non calcolabile: errore parlante, non un INSERT che fallirà.
    assert.throws(
      () => applicaRicalcolo({ doc: {}, azioni: {}, note: [] }, 'k', null, { pk: true, etichetta: 'bytea' }),
      /chiave primaria/i
    );
    // Unica secondaria non calcolabile: il valore resta, ma va detto.
    const p2 = { doc: { email: 'a@b.it' }, azioni: {}, note: [] };
    applicaRicalcolo(p2, 'email', null, { pk: false });
    assert.strictEqual(p2.doc.email, 'a@b.it');
    assert.strictEqual(p2.azioni.email, CONSERVATA);
    assert.ok(p2.note.some((n) => n.includes('email')));
  }
  console.log('  OK   Sorgente validata ed esiti del ricalcolo riportati');

  console.log('Tutti i test unitari sulla duplicazione superati!');
})().catch((err) => {
  console.error('\nFALLITO (duplicazione):', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
