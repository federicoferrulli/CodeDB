'use strict';

/* ---------------------------------------------------------------------------
 * Test unitari del monitor delle sessioni (db/sessioni.js). Nessun database:
 * le righe qui sotto hanno la forma esatta di quelle restituite da
 * `$currentOp`, `information_schema.PROCESSLIST` e `pg_stat_activity`.
 *
 * Cosa vale la pena verificare, perché sbagliato NON si vede:
 *
 *   1. il riconoscimento delle connessioni di CodeDB — se salta, l'interfaccia
 *      offre di terminare la propria scheda, e chi lo fa vede l'applicazione
 *      scollegarsi senza capire perché;
 *   2. i processi di SERVIZIO del server (autovacuum, replica, binlog dump):
 *      terminarli non sblocca niente, danneggia il server;
 *   3. "annulla la query" su una sessione ferma — riesce, non cambia nulla, e
 *      chi lo usa per liberare un lock crede di aver risolto;
 *   4. `idle in transaction`: ferma, invisibile fra le query lente, con i lock
 *      in mano. È la riga che si sta cercando quando "è tutto bloccato".
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const S = require('../db/sessioni');

console.log('--- Test Unitari Monitor Sessioni ---');

assert.strictEqual(S.assertIdentitaSessione('token-1', 'token-1'), true);
assert.throws(() => S.assertIdentitaSessione('token-1', 'token-2'), /sessione è cambiata|riutilizzato/i);
assert.throws(() => S.assertIdentitaSessione(null, 'token-2'), /identità stabile.*mancante/i);

/* --------------------------------- MongoDB -------------------------------- */

const opsMongo = [
  {
    opid: 4711,
    secs_running: 42,
    op: 'query',
    ns: 'shop.orders',
    client: '10.0.0.4:52344',
    appName: 'CodeDB',
    effectiveUsers: [{ user: 'app', db: 'admin' }],
    command: { find: 'orders', filter: { stato: 'aperto' }, $db: 'shop', lsid: { id: 'xxx' } },
    waitingForLock: false,
    desc: 'conn42',
  },
  {
    opid: 4712,
    microsecs_running: 300000, // 0,3 s: senza secs_running deve comunque avere una durata
    op: 'command',
    ns: 'shop.customers',
    client: '10.0.0.9:11111',
    appName: 'mongosh 2.1.0',
    command: { aggregate: 'customers', pipeline: [] },
    waitingForLock: true,
    desc: 'conn51',
  },
  { opid: 9, op: 'none', desc: 'ReplBatcher' }, // processo interno del server
];

const mongo = S.normalizzaMongo(opsMongo);
assert.strictEqual(mongo.length, 3);

const m1 = mongo.find((s) => s.id === '4711');
assert.strictEqual(m1.db, 'shop', 'db ricavato dal namespace');
assert.strictEqual(m1.utente, 'app');
assert.strictEqual(m1.secondi, 42);
assert.strictEqual(m1.secondiDi, 'query');
assert.strictEqual(m1.stato, S.STATO_ATTIVA);
assert.strictEqual(m1.nostra, true, 'appName CodeDB = connessione nostra');
assert.ok(m1.query.includes('"find":"orders"'), 'il comando finisce nel testo della query');
assert.ok(!m1.query.includes('$db') && !m1.query.includes('lsid'), 'le chiavi di protocollo non sono rumore da mostrare');

const m2 = mongo.find((s) => s.id === '4712');
assert.strictEqual(m2.secondi, 0.3, 'microsecs_running usato quando secs_running manca');
assert.strictEqual(m2.stato, S.STATO_ATTESA, 'waitingForLock = in attesa');
assert.strictEqual(m2.nostra, false);

assert.strictEqual(mongo.find((s) => s.id === '9').interna, true, 'ReplBatcher è un processo interno');
console.log('  OK   normalizzaMongo passed');

/* ---------------------------------- MySQL --------------------------------- */

const rowsMysql = [
  { ID: 12, USER: 'app', HOST: '10.0.0.4:52344', DB: 'shop', COMMAND: 'Query', TIME: 130, STATE: 'Sending data', INFO: 'SELECT * FROM orders' },
  { ID: 13, USER: 'app', HOST: '10.0.0.4:52350', DB: 'shop', COMMAND: 'Query', TIME: 8, STATE: 'Waiting for table metadata lock', INFO: 'ALTER TABLE orders ADD c INT' },
  { ID: 14, USER: 'app', HOST: '10.0.0.4:52351', DB: 'shop', COMMAND: 'Sleep', TIME: 900, STATE: '', INFO: null },
  { ID: 15, USER: 'system user', HOST: '', DB: null, COMMAND: 'Daemon', TIME: 100000, STATE: 'Waiting on empty queue', INFO: null },
  { ID: 99, USER: 'codedb', HOST: '127.0.0.1:1', DB: 'shop', COMMAND: 'Query', TIME: 0, STATE: 'executing', INFO: 'SELECT ID FROM information_schema.PROCESSLIST' },
];

const my = S.normalizzaMysql(rowsMysql, { threadIds: [99] });
const byId = (l, id) => l.find((s) => s.id === String(id));

assert.strictEqual(byId(my, 12).stato, S.STATO_ATTIVA);
assert.strictEqual(byId(my, 12).secondiDi, 'query');
assert.strictEqual(byId(my, 13).stato, S.STATO_ATTESA, 'STATE con "Waiting" = in attesa');
assert.strictEqual(byId(my, 14).stato, S.STATO_INATTIVA, 'COMMAND Sleep = inattiva');
assert.strictEqual(byId(my, 14).secondiDi, 'inattivita', 'su una Sleep il tempo è di inattività, non di query');
assert.strictEqual(byId(my, 15).interna, true, 'il thread "system user"/Daemon è interno');
// Aspettare è il mestiere dei thread di servizio: un rosso permanente accanto a
// un thread che funziona insegna a ignorare il rosso.
assert.strictEqual(byId(my, 15).stato, S.STATO_ATTIVA,
  'e il suo "Waiting on empty queue" NON è un blocco da segnalare');
assert.strictEqual(byId(my, 15).secondiDi, 'inattivita',
  'né le sue 27 ore di vita sono la durata di una query');
assert.strictEqual(byId(my, 99).nostra, true, 'thread del nostro pool');
assert.strictEqual(byId(my, 12).nostra, false, 'stesso utente e stesso host NON bastano a dirla nostra');
console.log('  OK   normalizzaMysql passed');

/* ------------------------------- PostgreSQL -------------------------------- */

const rowsPg = [
  { pid: 101, usename: 'app', client_addr: '10.0.0.4', client_port: 52344, datname: 'shop', state: 'active', query: 'SELECT * FROM orders', wait_event_type: null, wait_event: null, backend_type: 'client backend', application_name: 'psql', secondi: 130 },
  { pid: 102, usename: 'app', client_addr: '10.0.0.4', client_port: 52350, datname: 'shop', state: 'active', query: 'UPDATE orders SET x=1', wait_event_type: 'Lock', wait_event: 'transactionid', backend_type: 'client backend', application_name: 'psql', secondi: 12 },
  { pid: 103, usename: 'app', client_addr: '10.0.0.4', client_port: 52351, datname: 'shop', state: 'idle in transaction', query: 'BEGIN', wait_event_type: 'Client', wait_event: 'ClientRead', backend_type: 'client backend', application_name: 'psql', secondi: 600 },
  { pid: 104, usename: 'app', client_addr: null, client_port: null, datname: 'shop', state: 'idle', query: 'SELECT 1', wait_event_type: 'Client', wait_event: 'ClientRead', backend_type: 'client backend', application_name: 'CodeDB', secondi: 3 },
  { pid: 105, usename: null, client_addr: null, client_port: null, datname: null, state: null, query: null, wait_event_type: 'Activity', wait_event: 'AutoVacuumMain', backend_type: 'autovacuum launcher', application_name: '', secondi: 90000 },
  { pid: 106, usename: 'app', client_addr: '10.0.0.7', client_port: 60000, datname: 'shop', state: 'active', query: 'SELECT * FROM lenta', wait_event_type: 'IO', wait_event: 'DataFileRead', backend_type: 'client backend', application_name: 'app', secondi: 5 },
];

const pg = S.normalizzaPostgres(rowsPg, { processIDs: [] });

assert.strictEqual(byId(pg, 101).stato, S.STATO_ATTIVA);
assert.strictEqual(byId(pg, 102).stato, S.STATO_ATTESA, 'wait_event_type Lock = bloccata da un\'altra transazione');
assert.strictEqual(byId(pg, 106).stato, S.STATO_ATTIVA, 'un\'attesa di IO non è un blocco: resta attiva');
assert.strictEqual(byId(pg, 103).stato, S.STATO_INATTIVA);
assert.strictEqual(byId(pg, 103).transazioneAperta, true, 'idle in transaction va marcata: tiene i lock');
assert.strictEqual(byId(pg, 104).nostra, true, 'application_name riconosce anche un\'ALTRA istanza di CodeDB');
assert.strictEqual(byId(pg, 104).host, 'locale', 'client_addr nullo su un client = socket UNIX');
assert.strictEqual(byId(pg, 105).interna, true, 'autovacuum launcher non è un client backend');
assert.strictEqual(byId(pg, 105).host, null, 'un processo di servizio non ha un host da mostrare');
assert.strictEqual(S.normalizzaPostgres([{ pid: 7, state: 'active', durata: 4 }])[0].secondi, 4, 'accettato anche il nome "durata"');
console.log('  OK   normalizzaPostgres passed');

/* ------------------------------- Ordinamento ------------------------------- */

const ordinate = S.ordina(pg);
assert.strictEqual(ordinate[0].id, '102', 'le bloccate per prime: sono quelle su cui si interviene');
assert.strictEqual(ordinate[1].id, '101', 'poi le attive, dalla più vecchia');
assert.strictEqual(ordinate[ordinate.length - 1].id, '105', 'i processi di servizio sempre in fondo, per quanto vecchi');
console.log('  OK   ordina passed');

/* ---------------------- Cosa NON si può terminare -------------------------- */

const tutte = { annullaQuery: true, terminaConnessione: true };
const trova = (id) => byId(pg, id);

assert.strictEqual(motivo(trova(101), 'query'), null, 'una query attiva altrui si annulla');
assert.strictEqual(motivo(trova(101), 'connessione'), null);
assert.ok(/CodeDB/.test(motivo(trova(104), 'connessione')), 'mai la nostra connessione');
assert.ok(/CodeDB/.test(motivo(trova(104), 'query')), 'nemmeno annullandone la query');
assert.ok(/servizio/.test(motivo(trova(105), 'connessione')), 'mai un processo di servizio del server');
assert.ok(/non c'è una query da annullare/.test(motivo(byId(pg, 104), 'query')) === false, 'la nostra vince sul resto: il motivo più importante per primo');

// La idle "normale" di un altro client: annullare la query non ha senso,
// terminare la connessione sì.
const idleAltrui = S.normalizzaPostgres([{ pid: 200, usename: 'x', state: 'idle', query: 'SELECT 1', backend_type: 'client backend', secondi: 10 }])[0];
assert.ok(/non c'è una query da annullare/.test(motivo(idleAltrui, 'query')));
assert.strictEqual(motivo(idleAltrui, 'connessione'), null);

// Idle in transaction: stessa conclusione, ma il motivo deve spiegare i lock —
// è l'informazione per cui si è aperto il monitor.
assert.ok(/transazione aperta/.test(motivo(trova(103), 'query')));
assert.strictEqual(motivo(trova(103), 'connessione'), null);

// MongoDB non chiude le connessioni altrui: il pulsante non deve esistere.
assert.ok(/non espone la chiusura/.test(
  S.motivoNonTerminabile(m2, 'connessione', { annullaQuery: true, terminaConnessione: false })
));
assert.strictEqual(S.motivoNonTerminabile(m2, 'query', { annullaQuery: true, terminaConnessione: false }), null);

assert.ok(/già terminata/.test(motivo(undefined, 'query')), 'sessione sparita fra il disegno e il clic');
assert.ok(/sconosciuto/.test(motivo(trova(101), 'ammazzala')), 'un modo inventato non passa per omissione');

function motivo(s, modo) { return S.motivoNonTerminabile(s, modo, tutte); }
console.log('  OK   motivoNonTerminabile passed');

/* ---------------------------- Chi blocca chi -------------------------------
 * È il dato che trasforma l'elenco in una risposta: senza, si termina la
 * sessione in attesa (la vittima) e non cambia nulla.
 * ------------------------------------------------------------------------- */

// 102 e 106 aspettano il lock che tiene 103 (idle in transaction).
const conBlocchi = S.collegaBlocchi(
  S.normalizzaPostgres(rowsPg, { processIDs: [] }),
  [{ attesa: 102, blocca: 103 }, { attesa: 106, blocca: 103 }, { attesa: 101, blocca: 999 }]
);
assert.deepStrictEqual(byId(conBlocchi, 102).bloccataDa, ['103']);
assert.strictEqual(byId(conBlocchi, 103).bloccaAltre, 2, 'il bloccante sa quante ne tiene ferme');
assert.deepStrictEqual(byId(conBlocchi, 101).bloccataDa, ['999'],
  'un bloccante fuori elenco si registra comunque: sapere che esiste è metà della risposta');
assert.strictEqual(byId(conBlocchi, 106).bloccaAltre, 0);

// La tabella dei lock batte lo stato riportato dal DBMS. Su MySQL è l'UNICA
// fonte: un'attesa su un lock di riga non compare in `STATE`, la sessione
// risulta semplicemente in esecuzione — e senza questa promozione la vittima
// non veniva vista come bloccata, quindi il verdetto non si accorgeva di nulla.
const myBlocco = S.collegaBlocchi(
  S.normalizzaMysql([
    { ID: 30, USER: 'app', COMMAND: 'Query', TIME: 4, STATE: 'updating', INFO: 'UPDATE righe SET v=1' },
    { ID: 31, USER: 'app', COMMAND: 'Sleep', TIME: 40, STATE: '', INFO: null },
  ], { transazioni: [31] }),
  [{ attesa: 30, blocca: 31 }]
);
assert.strictEqual(byId(myBlocco, 30).stato, S.STATO_ATTESA,
  'la vittima è "in attesa" per via della tabella dei lock, non del suo STATE');
assert.strictEqual(byId(myBlocco, 31).transazioneAperta, true,
  'e il bloccante fermo in Sleep è riconosciuto come transazione aperta (innodb_trx)');
console.log('  OK   collegaBlocchi passed');

// Il bloccante va in cima anche se per stato è la riga più tranquilla della
// tabella: senza questa regola una "idle in transaction" finirebbe in fondo.
assert.strictEqual(S.ordina(conBlocchi)[0].id, '103', 'chi blocca gli altri viene prima di tutti');
console.log('  OK   ordina mette il bloccante in cima passed');

/* --------------------------------- Verdetto --------------------------------- */

const senzaBlocchi = (s) => ({ ...s, blocchi: { query: null, connessione: null } });

const dBlocco = S.diagnosi(conBlocchi.map(senzaBlocchi));
assert.strictEqual(dBlocco.livello, 'allarme');
assert.ok(/in attesa di un lock/.test(dBlocco.titolo));
assert.ok(/103/.test(dBlocco.dettaglio), 'il verdetto NOMINA il bloccante');
assert.ok(/transazione aperta/.test(dBlocco.dettaglio), 'e dice in che stato si trova');
assert.strictEqual(dBlocco.azione.id, '103', 'l\'azione punta al bloccante, non alla vittima');
assert.strictEqual(dBlocco.azione.modo, 'connessione',
  'e su una sessione ferma il modo è terminare la connessione: annullarne la query non farebbe nulla');
console.log('  OK   diagnosi: blocco con bloccante noto passed');

// Se non si sa chi blocca, lo si dice invece di indicare a caso.
const soloAttesa = S.normalizzaPostgres([
  { pid: 1, usename: 'a', state: 'active', query: 'UPDATE x', wait_event_type: 'Lock', backend_type: 'client backend', secondi: 9 },
], {}).map(senzaBlocchi);
const dIgnoto = S.diagnosi(soloAttesa);
assert.strictEqual(dIgnoto.livello, 'allarme');
assert.strictEqual(dIgnoto.azione, null, 'nessuna azione proposta se il bersaglio non è noto');
assert.ok(/non riporta quale sessione/.test(dIgnoto.dettaglio));
console.log('  OK   diagnosi: blocco senza bloccante noto passed');

// Query lenta: il caso ovvio, e infatti quello per cui il pannello serve meno.
const dLenta = S.diagnosi(S.normalizzaMysql([
  { ID: 7, USER: 'app', COMMAND: 'Query', TIME: 120, STATE: 'Sending data', INFO: 'SELECT 1' },
], {}).map(senzaBlocchi));
assert.strictEqual(dLenta.livello, 'attenzione');
assert.ok(/2 m 0 s/.test(dLenta.titolo), 'la durata è leggibile, non in secondi grezzi');
assert.strictEqual(dLenta.azione.modo, 'query');
console.log('  OK   diagnosi: query lenta passed');

// Sotto soglia non si allarma nessuno.
const dCalma = S.diagnosi(S.normalizzaMysql([
  { ID: 7, USER: 'app', COMMAND: 'Query', TIME: 2, STATE: 'executing', INFO: 'SELECT 1' },
], {}).map(senzaBlocchi));
assert.strictEqual(dCalma.livello, 'ok');
assert.ok(/1 in esecuzione/.test(dCalma.titolo), '"nessun problema" è una risposta, e va data');
assert.strictEqual(S.diagnosi([]).livello, 'ok');
console.log('  OK   diagnosi: nessun problema passed');

// Una transazione aperta su una query IN CORSO è lavoro normale: chiamarla
// "aperta e ferma" sarebbe falso oltre che allarmistico.
const trxAttiva = S.normalizzaMysql([
  { ID: 9, USER: 'app', COMMAND: 'Query', TIME: 5, STATE: 'updating', INFO: 'UPDATE x SET a=1' },
], { transazioni: [9] }).map(senzaBlocchi);
assert.strictEqual(trxAttiva[0].transazioneAperta, true, 'il fatto resta registrato');
assert.strictEqual(S.diagnosi(trxAttiva).livello, 'ok', 'ma non fa scattare nessun allarme');

// Ferma da oltre un minuto con i lock in mano: quello sì.
const trxFerma = S.normalizzaMysql([
  { ID: 9, USER: 'app', COMMAND: 'Sleep', TIME: 300, STATE: '', INFO: null },
], { transazioni: [9] }).map(senzaBlocchi);
const dTrx = S.diagnosi(trxFerma);
assert.strictEqual(dTrx.livello, 'attenzione');
assert.strictEqual(dTrx.azione.modo, 'connessione');
console.log('  OK   diagnosi: transazione aperta solo se ferma passed');

// Un'azione impedita non viene proposta come se fosse possibile.
const nostroBloccante = conBlocchi.map((s) => (s.id === '103'
  ? { ...s, blocchi: { query: 'motivo', connessione: 'È una connessione aperta da CodeDB…' } }
  : senzaBlocchi(s)));
assert.ok(/CodeDB/.test(S.diagnosi(nostroBloccante).azione.impedita),
  'se il bloccante non è terminabile il verdetto lo dice invece di offrire un pulsante che fallirà');
console.log('  OK   diagnosi: azione impedita passed');

// I processi di servizio non entrano mai nel verdetto: aspettare è il loro
// mestiere e un allarme permanente insegna a ignorare gli allarmi.
const soloServizio = S.normalizzaMysql([
  { ID: 5, USER: 'system user', COMMAND: 'Daemon', TIME: 90000, STATE: 'Waiting on empty queue' },
], {}).map(senzaBlocchi);
assert.strictEqual(S.diagnosi(soloServizio).livello, 'ok');
console.log('  OK   diagnosi: i processi di servizio non fanno rumore passed');

assert.strictEqual(S.formattaDurata(45), '45 s');
assert.strictEqual(S.formattaDurata(3600), '1 h 0 m');
assert.strictEqual(S.formattaDurata(null), '—');

/* ------------------------------- Troncamenti -------------------------------- */

const lunga = 'x'.repeat(S.MAX_TESTO_QUERY + 500);
const troncata = S.normalizzaMysql([{ ID: 1, COMMAND: 'Query', TIME: 1, INFO: lunga }])[0];
assert.strictEqual(troncata.query.length, S.MAX_TESTO_QUERY);
assert.strictEqual(troncata.queryTroncata, true, 'il troncamento va dichiarato, non subito');
console.log('  OK   troncamento del testo delle query passed');
