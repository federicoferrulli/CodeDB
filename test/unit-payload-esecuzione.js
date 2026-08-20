'use strict';

/* ---------------------------------------------------------------------------
 * I residui del payload di `query:execute` (spec: approfondimento-moduli, 02).
 *
 * Il perché della regola sta in `db/payloadEsecuzione.js`: qui si prova il
 * comportamento all'interfaccia, cioè la regola pura e il suo chiamante vero
 * (`executeQueryCode`), invocato con una sessione finta — nessun socket,
 * nessun database.
 *
 * Il difetto provato: il REGISTRO DELL'ESECUZIONE (`run`) arrivava dal client e
 * il server lo adottava, mentre `opHandle` era neutralizzato solo perché scritto
 * DOPO lo spread `{ ...payload, runId, opHandle }` — un accidente d'ordine.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const {
  CAMPI_IMPOSTI_DAL_SERVER,
  payloadEsecuzione,
  payloadMarcato,
} = require('../db/payloadEsecuzione');
const { executeQueryCode } = require('../server');

module.exports = (async () => {
console.log('--- Test payload dell\'esecuzione di query ---');

/**
 * La regola di audit di `finalizzaScript` (server.js), RICOPIATA qui: quella vera
 * vive dentro la chiusura del gestore socket e non è raggiungibile da un test
 * finché il contesto della sessione resta catturato invece che passato (spec:
 * lotto 5). Serve a leggere che cosa significherebbe la sostituzione del
 * registro, non a provare quella funzione: se la regola là cambia, questa copia
 * non se ne accorge.
 */
function categoriaAudit(run) {
  return run.categoria === 'write' || run.haScritto ? 'write' : 'read';
}

/** Sessione finta: una strategia MongoDB che registra le scritture ricevute. */
function sessioneFinta() {
  const scritture = [];
  return {
    scritture,
    closed: false,
    strategy: {
      type: 'mongodb',
      currentDb: 'test',
      async shellWrite(db, coll, payload) {
        scritture.push({ db, coll, payload });
        return { insertedCount: 1 };
      },
    },
  };
}

const CODICE_SCRITTURA = "INSERT INTO clienti (nome) VALUES ('Keus')";

// --- 1. La rimozione avviene per regola, non per ordine delle chiavi --------
{
  const registroDelClient = { categoria: 'read' };
  const handleDelClient = { runId: 'del-client' };

  const primaIcampiRiservati = payloadEsecuzione(
    { run: registroDelClient, opHandle: handleDelClient, runId: 'x', code: 'SELECT 1', db: 'test' },
    { runId: 'del-server' }
  );
  const dopoIcampiRiservati = payloadEsecuzione(
    { code: 'SELECT 1', db: 'test', runId: 'x', opHandle: handleDelClient, run: registroDelClient },
    { runId: 'del-server' }
  );

  assert.deepStrictEqual(primaIcampiRiservati, dopoIcampiRiservati,
    'Riordinare le chiavi del letterale non deve cambiare il risultato');
  assert.deepStrictEqual(primaIcampiRiservati, { code: 'SELECT 1', db: 'test', runId: 'del-server' },
    'Dei campi del server deve restare solo ciò che il server ha fornito');
  assert.strictEqual('run' in primaIcampiRiservati, false, 'Il registro del client non deve sopravvivere');
  assert.strictEqual('opHandle' in primaIcampiRiservati, false, 'Il riferimento di annullamento del client non deve sopravvivere');
  console.log('  OK   Campi riservati tolti per regola, indipendentemente dall\'ordine');
}

// --- 2. L'elenco dei campi riservati è uno solo ed è chiuso ----------------
{
  assert.deepStrictEqual([...CAMPI_IMPOSTI_DAL_SERVER], ['runId', 'opHandle', 'run']);
  assert.strictEqual(Object.isFrozen(CAMPI_IMPOSTI_DAL_SERVER), true,
    "L'elenco dev'essere congelato dal modulo, non dal test");
  assert.throws(() => CAMPI_IMPOSTI_DAL_SERVER.push('altro'), TypeError,
    "Aggiungere un campo all'elenco dall'esterno dev'essere un errore");
  assert.throws(() => payloadEsecuzione({ code: 'x' }, { maxRows: 10 }),
    /non è un campo del server/, 'Il contesto del server accetta solo campi dichiarati');
  console.log('  OK   Elenco dei campi del server unico e chiuso');
}

// --- 3. Il payload non composto dalla regola viene rifiutato ---------------
{
  assert.strictEqual(payloadMarcato({ code: 'x' }), false);
  assert.strictEqual(payloadMarcato({ ...payloadEsecuzione({ code: 'x' }) }), false,
    'Uno spread perde la marcatura: ricomporre a mano deve ripassare dalla regola');
  assert.strictEqual(payloadMarcato(payloadEsecuzione({ code: 'x' })), true);
  console.log('  OK   Marcatura del payload composto dalla regola');
}

// --- 4. Il registro dell'esecuzione proviene solo dal server ---------------
// È la prova di regressione: prima della correzione il registro mandato dal
// client veniva adottato e la scrittura lo marcava, cioè chi manda la richiesta
// decideva la struttura da cui deriva la categoria di audit.
{
  const session = sessioneFinta();
  const registroDelClient = { categoria: 'read' };

  // Esattamente ciò che il gestore passava prima: lo spread del payload del
  // client, con le due chiavi del server aggiunte in coda.
  const payloadCrudo = {
    code: CODICE_SCRITTURA, engine: 'mongodb', db: 'test', coll: 'clienti',
    run: registroDelClient,
    runId: 'r1',
    opHandle: { runId: 'r1' },
  };

  let rifiutato = null;
  try {
    await executeQueryCode(session, payloadCrudo);
  } catch (err) {
    rifiutato = err;
  }

  assert.strictEqual(registroDelClient.haScritto, undefined,
    'Il registro dell\'esecuzione mandato dal client non deve essere adottato dal server');
  assert.strictEqual(categoriaAudit(registroDelClient), 'read',
    'Un registro del client non deve poter essere marcato come scrittura dal server');
  assert.ok(rifiutato && /payloadEsecuzione/.test(rifiutato.message),
    'Un payload non composto dalla regola dev\'essere rifiutato con un messaggio esplicito');
  console.log('  OK   Il registro dell\'esecuzione non è costruibile dal client');
}

// --- 5. Il registro del server, invece, viene marcato dalla scrittura ------
{
  const session = sessioneFinta();
  const registroDelServer = { categoria: 'read' };
  const registroDelClient = { categoria: 'read' };

  const esito = await executeQueryCode(session, payloadEsecuzione(
    { code: CODICE_SCRITTURA, engine: 'mongodb', db: 'test', coll: 'clienti', run: registroDelClient },
    { runId: 'r2', opHandle: { runId: 'r2' }, run: registroDelServer }
  ));

  assert.strictEqual(esito.category, 'write');
  assert.strictEqual(session.scritture.length, 1, 'La scrittura dev\'essere arrivata alla strategia');
  assert.strictEqual(categoriaAudit(registroDelServer), 'write',
    'Il registro del server dev\'essere marcato dalla scrittura');
  assert.strictEqual(categoriaAudit(registroDelClient), 'read',
    'Il registro mandato dal client resta estraneo anche quando il payload passa dalla regola');
  console.log('  OK   Il registro del server segna la scrittura, quello del client no');
}

console.log('--- Payload dell\'esecuzione: tutti i test superati ---');
})();
