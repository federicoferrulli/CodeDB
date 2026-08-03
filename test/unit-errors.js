'use strict';

/* Errori parlanti (db/errors.js).
 *
 * Cosa si verifica qui, e perché proprio questo:
 *  - i codici dei driver che l'utente incontra davvero (timeout, credenziali,
 *    porta chiusa, vincoli) producono una spiegazione con un rimedio;
 *  - il dettaglio tecnico non si perde MAI: senza, una segnalazione dalla beta
 *    arriva senza il codice del driver e non è diagnosticabile;
 *  - un errore sconosciuto torna indietro IMMUTATO: una spiegazione inventata
 *    è peggio del messaggio grezzo, perché manda a cercare la causa sbagliata;
 *  - la funzione è idempotente: viene applicata nei punti di uscita, che
 *    ricevono anche messaggi già spiegati (o già nostri).
 */

const assert = require('assert');
const { spiegaErrore, descriviErrore, MARCATORE } = require('../db/errors');

console.log('--- Test Errori Parlanti ---');

// Helper: l'errore così come arriva dai driver (codice + messaggio).
function errore(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// --- Struttura del messaggio ------------------------------------------------
{
  const msg = spiegaErrore(errore('operation exceeded time limit', { code: 50, codeName: 'MaxTimeMSExpired' }));
  assert.ok(msg.includes(MARCATORE), 'la spiegazione deve contenere il rimedio');
  assert.ok(/tempo massimo/i.test(msg), 'deve dire cosa è successo, in italiano');
  assert.ok(msg.includes('CODEDB_QUERY_TIMEOUT_MS'), 'deve nominare la variabile con cui si alza il limite');
  assert.ok(msg.includes('operation exceeded time limit'), 'il dettaglio tecnico originale non deve andare perso');
  console.log('  OK   Timeout MongoDB: causa, rimedio e dettaglio tecnico');
}

// --- Idempotenza ------------------------------------------------------------
{
  const primo = spiegaErrore(errore('connect ECONNREFUSED 127.0.0.1:27017', { code: 'ECONNREFUSED' }));
  const secondo = spiegaErrore(new Error(primo));
  assert.strictEqual(secondo, primo, 'un messaggio già spiegato non deve essere spiegato di nuovo');
  console.log('  OK   Idempotenza (nessuna spiegazione annidata)');
}

// --- Errori sconosciuti: nessuna invenzione ---------------------------------
{
  const grezzo = 'qualcosa di molto specifico che non sappiamo interpretare';
  assert.strictEqual(spiegaErrore(new Error(grezzo)), grezzo, 'un errore non riconosciuto torna immutato');
  assert.strictEqual(descriviErrore(new Error(grezzo)), null, 'e non produce alcuna descrizione');
  assert.strictEqual(spiegaErrore(null), '', 'errore nullo: stringa vuota, nessun crash');
  assert.strictEqual(spiegaErrore('testo semplice'), 'testo semplice', 'una stringa non riconosciuta resta tale');
  console.log('  OK   Errori sconosciuti restituiti immutati');
}

// --- Rete: la destinazione compare nel messaggio quando è nota ---------------
{
  const conCtx = spiegaErrore(errore('connect ECONNREFUSED 10.0.0.5:3306', { code: 'ECONNREFUSED' }),
    { dbType: 'mysql', host: '10.0.0.5', port: '3306' });
  assert.ok(conCtx.includes('10.0.0.5:3306'), 'con il contesto, il messaggio nomina host e porta');

  const senzaCtx = spiegaErrore(errore('connect ECONNREFUSED', { code: 'ECONNREFUSED' }));
  assert.ok(/rifiutata/i.test(senzaCtx) && !senzaCtx.includes('undefined'),
    'senza contesto resta comprensibile e non stampa "undefined"');
  console.log('  OK   Rete: destinazione citata solo quando nota');
}

// --- Casi che un utente incontra nel primo giorno di beta -------------------
{
  const casi = [
    // [errore, frammento atteso nella causa, nota]
    [errore('getaddrinfo ENOTFOUND db.interno', { code: 'ENOTFOUND' }), /host non risolto/i, 'DNS'],
    [errore('Authentication failed.', { code: 18, codeName: 'AuthenticationFailed' }), /autenticazione/i, 'Mongo auth'],
    [errore("Access denied for user 'root'@'localhost'", { code: 'ER_ACCESS_DENIED_ERROR' }), /accesso negato/i, 'MySQL auth'],
    [errore('password authentication failed', { code: '28P01' }), /password/i, 'PostgreSQL auth'],
    [errore('canceling statement due to statement timeout', { code: '57014' }), /tempo massimo/i, 'PG timeout'],
    [errore("Table 'shop.ordini' doesn't exist", { code: 'ER_NO_SUCH_TABLE' }), /non esiste/i, 'tabella assente'],
    [errore('relation "ordini" does not exist', { code: '42P01' }), /non esiste/i, 'relazione assente'],
    [errore("Unknown column 'nome' in 'field list'", { code: 'ER_BAD_FIELD_ERROR' }), /colonna/i, 'colonna assente'],
    [errore('You have an error in your SQL syntax', { code: 'ER_PARSE_ERROR' }), /sintassi/i, 'sintassi SQL'],
    [errore("Duplicate entry 'a@b.it' for key 'email'", { code: 'ER_DUP_ENTRY' }), /duplicat/i, 'unicità MySQL'],
    [errore('duplicate key value violates unique constraint', { code: '23505' }), /duplicat/i, 'unicità PG'],
    [errore('E11000 duplicate key error collection', { code: 11000 }), /duplicat/i, 'unicità Mongo'],
    [errore('Cannot add or update a child row', { code: 'ER_NO_REFERENCED_ROW_2' }), /chiave esterna/i, 'FK'],
    [errore('null value in column "email" violates not-null', { code: '23502' }), /obbligatoria/i, 'NOT NULL'],
    [errore('invalid input syntax for type integer', { code: '22P02' }), /tipo della colonna/i, 'tipo errato'],
    [errore('Too many connections', { code: 'ER_CON_COUNT_ERROR' }), /numero massimo di connessioni/i, 'pool esaurito'],
    [errore('Lock wait timeout exceeded', { code: 'ER_LOCK_WAIT_TIMEOUT' }), /bloccata/i, 'lock'],
    [errore('Deadlock found when trying to get lock', { code: 'ER_LOCK_DEADLOCK' }), /deadlock/i, 'deadlock'],
    [errore('permission denied for table clienti', { code: '42501' }), /privilegi/i, 'privilegi PG'],
    [errore('EACCES: permission denied, open \'connections.ini\'', { code: 'EACCES' }), /permessi del file system/i, 'FS'],
    [errore('All configured authentication methods failed'), /ssh ha rifiutato/i, 'SSH auth'],
  ];

  for (const [err, atteso, nota] of casi) {
    const d = descriviErrore(err);
    assert.ok(d, `${nota}: l'errore deve essere riconosciuto`);
    assert.ok(atteso.test(d.causa), `${nota}: la causa deve spiegare il problema (ottenuto: "${d.causa}")`);
    assert.ok(d.rimedio && d.rimedio.length > 10, `${nota}: deve esserci un rimedio concreto`);
    assert.ok(spiegaErrore(err).includes(err.message), `${nota}: il dettaglio tecnico resta in coda`);
  }
  console.log(`  OK   ${casi.length} errori tipici di driver riconosciuti`);
}

// --- Il timeout citato è quello realmente configurato -----------------------
{
  const prima = process.env.CODEDB_QUERY_TIMEOUT_MS;
  process.env.CODEDB_QUERY_TIMEOUT_MS = '90000';
  const msg = spiegaErrore(errore('canceling statement due to statement timeout', { code: '57014' }));
  assert.ok(msg.includes('90000 ms'), 'il messaggio deve citare il limite configurato, non un valore fisso');
  if (prima === undefined) delete process.env.CODEDB_QUERY_TIMEOUT_MS;
  else process.env.CODEDB_QUERY_TIMEOUT_MS = prima;
  console.log('  OK   Il limite citato segue la configurazione');
}

// --- Timeout interni di CodeDB (withTimeout) --------------------------------
{
  const msg = spiegaErrore(new Error('Ping scaduta dopo 5000 ms'));
  assert.ok(/non ha risposto entro 5000 ms/.test(msg), 'i timeout interni ottengono anch\'essi un rimedio');
  assert.ok(/Salute delle Connessioni/.test(msg), 'e indirizzano dove si verifica lo stato della connessione');
  console.log('  OK   Timeout interni (withTimeout) spiegati');
}

// --- Stati di CodeDB già in italiano: spiegati, non riscritti ---------------
{
  const msg = spiegaErrore(new Error('Nessuna connessione attiva al database.'));
  assert.ok(msg.startsWith('Nessuna connessione attiva'), 'la causa già chiara resta in testa');
  assert.ok(msg.includes(MARCATORE), 'ma guadagna il "cosa fare"');
  assert.ok(!msg.includes('dettaglio tecnico'),
    'un messaggio già nostro non deve essere ripetuto come "dettaglio tecnico"');

  const negato = spiegaErrore(new Error('Permesso negato: non hai i privilegi per l\'operazione "doc:insert".'));
  assert.ok(negato.startsWith('Permesso negato'), 'il permesso negato resta riconoscibile in testa');
  assert.ok(!negato.includes('dettaglio tecnico'), 'e non si ripete in coda');
  console.log('  OK   Messaggi CodeDB arricchiti col rimedio');
}

// --- Una regola difettosa non deve mai sostituire l'errore vero -------------
{
  // Errore con getter che esplode: la funzione non deve propagare l'eccezione.
  const ostile = { get message() { throw new Error('boom'); } };
  assert.doesNotThrow(() => spiegaErrore(ostile), 'un errore malformato non deve far cadere il gestore');
  console.log('  OK   Robustezza su errori malformati');
}

console.log('Tutti i test sugli errori parlanti superati.\n');
