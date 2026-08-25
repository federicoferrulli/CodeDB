'use strict';

/* ---------------------------------------------------------------------------
 * Test end-to-end del monitor delle sessioni (`db:sessions` / `db:killSession`)
 * sui tre DBMS. Come gli altri e2e, avvia una PROPRIA istanza di CodeDB su una
 * porta dedicata con un connections.ini temporaneo: nessuna dipendenza dal
 * server dell'utente e nessun rischio per il suo vault.
 *
 * MongoDB è obbligatorio; MySQL e PostgreSQL vengono provati solo se
 * raggiungibili (e saltati dicendolo, non silenziosamente).
 *
 * Cosa si verifica davvero, oltre al "risponde":
 *
 *   1. le connessioni di CodeDB si riconoscono e NON sono terminabili — è la
 *      barriera che impedisce all'utente di scollegarsi da solo credendo di
 *      fermare una query altrui;
 *   2. il rifiuto è del SERVER, non dei pulsanti: qui si parla via socket, i
 *      pulsanti non esistono;
 *   3. su MySQL e PostgreSQL una query lenta di un ALTRO client viene davvero
 *      interrotta — cioè il pannello fa la cosa che promette.
 *
 *   env: E2E_PORT, MYSQL_PORT/MYSQL_PASSWORD, PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const PG_PORT = parseInt(process.env.PG_PORT, 10) || 5432;
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'postgres';

let socket = null;
let testServer = null;

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.error(`  FAIL ${label}`); process.exitCode = 1; }
}

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('--- Test E2E Monitor Sessioni ---');
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3149 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  await testMongo();
  await testMysql();
  await testPostgres();

  socket.close();
  await testServer.stop();
  console.log(process.exitCode ? '\nAlcuni test sono falliti.' : '\nTutti i test del monitor sessioni superati!');
})().catch(async (err) => {
  console.error('Impossibile eseguire i test:', (err && err.message) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});

/* --------------------------------- MongoDB -------------------------------- */

async function testMongo() {
  console.log('\n1. MongoDB');
  const tabId = 'sess-mongo';
  const conn = await emit('mongo:connect', { host: 'localhost', port: 27017, tabId });
  if (!conn.ok) { console.error('  SALTATO: MongoDB non raggiungibile su localhost:27017'); process.exitCode = 1; return; }

  const res = await emit('db:sessions', { tabId });
  assert(res.ok && Array.isArray(res.sessioni), 'db:sessions risponde con un elenco');
  assert(res.capacita && res.capacita.annullaQuery === true, 'MongoDB dichiara di saper annullare l\'operazione');
  assert(res.capacita && res.capacita.terminaConnessione === false,
    'MongoDB dichiara di NON saper chiudere la connessione altrui (il pulsante non deve comparire)');

  // L'unica operazione in corso mentre si interroga $currentOp è $currentOp
  // stesso, che gira sulla NOSTRA connessione: deve essere riconosciuta.
  const nostra = res.sessioni.find((s) => s.nostra);
  assert(!!nostra, 'la connessione di CodeDB compare ed è marcata come nostra (appName)');
  if (nostra) {
    assert(/CodeDB/.test(nostra.blocchi.query || ''), 'e il server spiega perché non è annullabile');
    // Su MongoDB le nostre operazioni sono effimere — l'unica visibile è il
    // $currentOp che le ha elencate, e alla richiesta successiva non esiste
    // più. Qui si verifica quindi soltanto che il tentativo venga RIFIUTATO
    // (per un motivo o per l'altro); che il rifiuto sia proprio quello sulle
    // connessioni di CodeDB lo provano MySQL e PostgreSQL, dove i thread del
    // pool restano in vita fra una richiesta e l'altra.
    const rifiuto = await emit('db:killSession', { tabId, id: nostra.id, modo: 'query' });
    assert(!rifiuto.ok, 'il rifiuto arriva dal SERVER anche saltando l\'interfaccia');
  }

  const inesistente = await emit('db:killSession', { tabId, id: '999999999', modo: 'query' });
  assert(!inesistente.ok && /già terminata/.test(inesistente.error || ''),
    'una sessione sparita fra la lettura e il clic viene detta tale, non uccisa a caso');

  const modoStrano = await emit('db:killSession', { tabId, id: '1', modo: 'connessione' });
  assert(!modoStrano.ok, 'la chiusura di connessione su MongoDB è rifiutata');

  await emit('mongo:disconnect', { tabId });
}

/* ---------------------------------- MySQL --------------------------------- */

async function testMysql() {
  console.log('\n2. MySQL');
  const tabId = 'sess-mysql';
  const conn = await emit('mongo:connect', {
    dbType: 'mysql', host: 'localhost', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD, tabId,
  });
  if (!conn.ok) { console.log(`  SALTATO: MySQL non raggiungibile (${conn.error})`); return; }

  const res = await emit('db:sessions', { tabId });
  assert(res.ok && res.sessioni.length > 0, 'db:sessions elenca le sessioni del server');
  assert(res.capacita.terminaConnessione === true, 'MySQL dichiara KILL CONNECTION disponibile');
  assert(res.sessioni.some((s) => s.nostra), 'i thread del pool di CodeDB sono riconosciuti');
  assert(res.sessioni.filter((s) => s.nostra).every((s) => s.blocchi.query && s.blocchi.connessione),
    'e nessuno di essi è terminabile');

  // Il thread del pool sopravvive fra due richieste: è il bersaglio giusto per
  // provare che la barriera sta nel SERVER e non nei pulsanti disabilitati.
  const nostro = res.sessioni.find((s) => s.nostra);
  if (nostro) {
    const rifiuto = await emit('db:killSession', { tabId, id: nostro.id, modo: 'connessione' });
    assert(!rifiuto.ok && /CodeDB/.test(rifiuto.error || ''),
      'terminare una connessione di CodeDB è rifiutato dal server, non solo dall\'interfaccia');
  }

  // Una vittima vera: un altro client che dorme dentro il database.
  let mysql;
  try { mysql = require('mysql2/promise'); } catch { console.log('  SALTATO: driver mysql2 assente'); return; }
  const vittima = await mysql.createConnection({
    host: 'localhost', port: MYSQL_PORT, user: 'root', password: MYSQL_PASSWORD,
  });
  const t0 = Date.now();
  const lenta = vittima.query('SELECT SLEEP(20)').then(() => 'finita', () => 'errore');
  await attendi(700); // il tempo che la query compaia nella PROCESSLIST

  const dopo = await emit('db:sessions', { tabId });
  const bersaglio = dopo.sessioni.find((s) => /SLEEP\(20\)/i.test(s.query || '') && !s.nostra);
  assert(!!bersaglio, 'la query lenta dell\'altro client compare nel monitor');

  if (bersaglio) {
    assert(bersaglio.blocchi.query === null, 'ed è annullabile: non è nostra, non è di servizio');
    const kill = await emit('db:killSession', { tabId, id: bersaglio.id, modo: 'query' });
    assert(kill.ok && kill.terminata, 'db:killSession riporta la query annullata');
    // La prova dell'interruzione è il TEMPO, non l'errore: `KILL QUERY` su una
    // SLEEP la fa tornare subito con successo (SLEEP restituisce 1 quando
    // viene interrotta), quindi aspettarsi un errore fallirebbe pur avendo
    // fatto esattamente la cosa giusta.
    const esito = await Promise.race([lenta, attendi(8000).then(() => 'in corso')]);
    assert(esito !== 'in corso' && Date.now() - t0 < 15000,
      `la query da 20 s è finita dopo ${Math.round((Date.now() - t0) / 100) / 10} s: interrotta davvero`);
  }

  await vittima.end().catch(() => {});

  /* Blocco vero su InnoDB: A tiene il lock di riga e resta fermo, B lo aspetta.
   * Verifica il ramo `performance_schema.data_lock_waits`, che altrimenti
   * resterebbe non provato — e che è l'unica cosa che rende il pannello capace
   * di indicare la riga giusta invece della vittima. */
  const targets = createE2eTargetRegistry({ destructive: true, prefix: 'gui_mysql_sessioni' });
  const DB = targets.target('lock');
  const A = await mysql.createConnection({ host: 'localhost', port: MYSQL_PORT, user: 'root', password: MYSQL_PASSWORD });
  const B = await mysql.createConnection({ host: 'localhost', port: MYSQL_PORT, user: 'root', password: MYSQL_PASSWORD });
  try {
    await A.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    await A.query(`USE \`${DB}\``);
    await A.query('CREATE TABLE IF NOT EXISTS righe (id INT PRIMARY KEY, v INT) ENGINE=InnoDB');
    await A.query('INSERT IGNORE INTO righe VALUES (1, 1)');
    await A.query('BEGIN');
    await A.query('UPDATE righe SET v = v + 1 WHERE id = 1');
    await B.query(`USE \`${DB}\``);
    const bloccata = B.query('UPDATE righe SET v = v + 1 WHERE id = 1').then(() => 'finita', () => 'errore');
    await attendi(1200);

    const conBlocco = await emit('db:sessions', { tabId });
    const capisce = conBlocco.capacita && conBlocco.capacita.saBloccanti;
    assert(capisce, 'MySQL 8 sa indicare il bloccante (data_lock_waits leggibile)');
    if (capisce) {
      const bloccante = conBlocco.sessioni.find((s) => s.bloccaAltre > 0);
      assert(!!bloccante, 'il bloccante è individuato');
      assert(conBlocco.diagnosi && String(conBlocco.diagnosi.azione && conBlocco.diagnosi.azione.id) === String(bloccante && bloccante.id),
        'e il verdetto propone di agire su di lui');
      const kill = await emit('db:killSession', { tabId, id: bloccante.id, modo: 'connessione' });
      assert(kill.ok, 'terminarlo riesce');
      const esitoB = await Promise.race([bloccata, attendi(8000).then(() => 'in corso')]);
      assert(esitoB !== 'in corso', 'e la sessione che aspettava riparte');
    }
  } finally {
    try { await A.query('ROLLBACK'); } catch {}
    try { await targets.cleanup((name) => B.query(`DROP DATABASE IF EXISTS \`${name}\``)); } catch {}
    await A.end().catch(() => {});
    await B.end().catch(() => {});
  }

  await emit('mongo:disconnect', { tabId });
}

/* ------------------------------- PostgreSQL -------------------------------- */

async function testPostgres() {
  console.log('\n3. PostgreSQL');
  const tabId = 'sess-pg';
  const conn = await emit('mongo:connect', {
    dbType: 'postgresql', host: 'localhost', port: PG_PORT,
    username: PG_USER, password: PG_PASSWORD, database: PG_DATABASE, tabId,
  });
  if (!conn.ok) { console.log(`  SALTATO: PostgreSQL non raggiungibile (${conn.error})`); return; }

  const res = await emit('db:sessions', { tabId });
  assert(res.ok && res.sessioni.length > 0, 'db:sessions elenca le sessioni del server');
  assert(res.sessioni.some((s) => s.nostra), 'le connessioni di CodeDB sono riconosciute (application_name)');

  const nostro = res.sessioni.find((s) => s.nostra);
  if (nostro) {
    const rifiuto = await emit('db:killSession', { tabId, id: nostro.id, modo: 'connessione' });
    assert(!rifiuto.ok && /CodeDB/.test(rifiuto.error || ''),
      'terminare una connessione di CodeDB è rifiutato dal server, non solo dall\'interfaccia');
  }

  let pg;
  try { pg = require('pg'); } catch { console.log('  SALTATO: driver pg assente'); return; }
  // `application_name` diverso di proposito: con "CodeDB" la vittima verrebbe
  // riconosciuta come nostra e — correttamente — rifiutata.
  const vittima = new pg.Client({
    host: 'localhost', port: PG_PORT, user: PG_USER, password: PG_PASSWORD,
    database: PG_DATABASE, application_name: 'e2e-vittima',
  });
  await vittima.connect();
  const t0 = Date.now();
  const lenta = vittima.query('SELECT pg_sleep(20)').then(() => 'finita', () => 'errore');
  await attendi(700);

  const dopo = await emit('db:sessions', { tabId });
  const bersaglio = dopo.sessioni.find((s) => /pg_sleep\(20\)/i.test(s.query || '') && !s.nostra);
  assert(!!bersaglio, 'la query lenta dell\'altro client compare nel monitor');

  if (bersaglio) {
    assert(bersaglio.stato === 'attiva', 'ed è vista come attiva');
    const kill = await emit('db:killSession', { tabId, id: bersaglio.id, modo: 'query' });
    assert(kill.ok && kill.terminata, 'pg_cancel_backend riporta l\'annullamento');
    const esito = await Promise.race([lenta, attendi(8000).then(() => 'in corso')]);
    assert(esito === 'errore' && Date.now() - t0 < 15000,
      'la query da 20 s è stata interrotta sul server (57014 query_canceled)');
  }

  /* Un blocco VERO: A tiene il lock e resta fermo, B lo aspetta. È il caso per
   * cui il pannello esiste — e quello in cui la riga da colpire (A) non è
   * quella che salta all'occhio (B, ferma e visibile). */
  const clienteA = new pg.Client({ host: 'localhost', port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE, application_name: 'e2e-A' });
  const clienteB = new pg.Client({ host: 'localhost', port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE, application_name: 'e2e-B' });
  // Terminare A gli fa arrivare un 57P01 (admin shutdown) come EVENTO sul
  // client: senza un gestore, `pg` lo rilancia come eccezione non catturata e
  // il test muore proprio quando ha appena fatto la cosa giusta.
  clienteA.on('error', () => {});
  clienteB.on('error', () => {});
  await clienteA.connect(); await clienteB.connect();
  try {
    await clienteA.query('CREATE TABLE IF NOT EXISTS codedb_sess_e2e (id int primary key, v int)');
    await clienteA.query('INSERT INTO codedb_sess_e2e VALUES (1, 1) ON CONFLICT (id) DO NOTHING');
    await clienteA.query('BEGIN');
    await clienteA.query('UPDATE codedb_sess_e2e SET v = v + 1 WHERE id = 1');
    // A ora è "idle in transaction" con il lock in mano; B ci va a sbattere.
    const bloccata = clienteB.query('UPDATE codedb_sess_e2e SET v = v + 1 WHERE id = 1').then(() => 'finita', () => 'errore');
    await attendi(1000);

    const conBlocco = await emit('db:sessions', { tabId });
    const vittima = conBlocco.sessioni.find((s) => s.stato === 'in attesa' && (s.bloccataDa || []).length);
    assert(!!vittima, 'la sessione bloccata è riconosciuta come tale');
    const bloccante = conBlocco.sessioni.find((s) => s.bloccaAltre > 0);
    assert(!!bloccante && vittima && vittima.bloccataDa.includes(String(bloccante.id)),
      'e pg_blocking_pids collega la vittima a CHI la tiene ferma');
    assert(bloccante && bloccante.transazioneAperta,
      'il bloccante è la transazione aperta e ferma, cioè la riga che da sola non si noterebbe');

    const d = conBlocco.diagnosi;
    assert(d && d.livello === 'allarme', 'il verdetto segnala l\'allarme');
    assert(d && d.azione && String(d.azione.id) === String(bloccante.id),
      'e propone di agire sul BLOCCANTE, non sulla vittima');
    assert(d && d.azione && d.azione.modo === 'connessione',
      'con il modo giusto: su una sessione ferma annullare la query non farebbe nulla');

    // E l'azione proposta funziona davvero.
    const kill = await emit('db:killSession', { tabId, id: d.azione.id, modo: d.azione.modo });
    assert(kill.ok && kill.terminata, 'terminare il bloccante riesce');
    const esitoB = await Promise.race([bloccata, attendi(8000).then(() => 'in corso')]);
    assert(esitoB !== 'in corso', 'e la sessione che aspettava riparte');
  } finally {
    try { await clienteA.query('ROLLBACK'); } catch { /* la connessione può essere già stata terminata */ }
    try { await clienteB.query('DROP TABLE IF EXISTS codedb_sess_e2e'); } catch {}
    await clienteA.end().catch(() => {});
    await clienteB.end().catch(() => {});
  }

  // I processi di servizio (autovacuum, checkpointer) non devono essere
  // terminabili: è l'altra metà della regola, e su PostgreSQL è visibile.
  const servizio = dopo.sessioni.find((s) => s.interna);
  if (servizio) {
    const rifiuto = await emit('db:killSession', { tabId, id: servizio.id, modo: 'connessione' });
    assert(!rifiuto.ok && /servizio/.test(rifiuto.error || ''),
      'un processo di servizio del server non è terminabile');
  } else {
    console.log('  (nessun processo di servizio visibile: controllo saltato)');
  }

  await vittima.end().catch(() => {});
  await emit('mongo:disconnect', { tabId });
}
