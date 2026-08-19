'use strict';

/* ---------------------------------------------------------------------------
 * Tetto di tempo sulla query libera di SCRITTURA, contro un server VERO.
 *
 * `test/unit-tetto-tempo.js` prova la decisione: che il limite venga imposto,
 * su entrambi i rami e su entrambi i motori, e che segua la configurazione.
 * Quello che un pool finto non può provare è che il limite MORDA davvero:
 * che una scrittura lunga venga interrotta dal motore invece di tenere la
 * connessione fino alla fine.
 *
 * Il server di test viene avviato con CODEDB_AGGREGATE_TIMEOUT_MS = 2000 e
 * riceve una scrittura che dorme 8 secondi. Deve tornare un errore entro pochi
 * secondi, e la connessione deve restare utilizzabile subito dopo (su MySQL la
 * connessione avvelenata viene distrutta e il pool ne apre un'altra).
 *
 * Uso:  node test/e2e-tetto-scrittura.js
 * Motori non raggiungibili vengono SALTATI con un messaggio esplicito: il test
 * non finge di aver provato ciò che non ha provato.
 *   MySQL:      MYSQL_PORT (3306), MYSQL_PASSWORD ('')
 *   PostgreSQL: PG_HOST (127.0.0.1), PG_PORT (5432), PG_USER (postgres),
 *               PG_PASSWORD (''), PG_DATABASE (postgres)
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

const TETTO_MS = 2000;
const DB = 'codedb_e2e_tetto';

const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.PG_PORT, 10) || 5432;
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'postgres';

let socket = null;
let testServer = null;
let saltati = 0;

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

function salta(motore, motivo) {
  saltati++;
  console.log(`  SALTATO ${motore}: ${motivo}`);
}

function sql(db, query) {
  return emit('collection:aggregate', { db, coll: null, pipeline: query });
}

// --- MySQL -----------------------------------------------------------------
async function provaMySql() {
  console.log('\n--- MySQL ---');
  const conn = await emit('mongo:connect', {
    dbType: 'mysql', host: '127.0.0.1', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD,
  });
  if (!conn.ok) return salta('MySQL', conn.error || 'connessione non riuscita');

  await emit('db:drop', { db: DB });
  const creato = await emit('db:create', { db: DB, coll: '' });
  if (!creato.ok) return salta('MySQL', `db:create non riuscito (${creato.error})`);
  try {
    await sql(DB, 'CREATE TABLE lenta (id INT PRIMARY KEY, n INT)');
    await sql(DB, 'INSERT INTO lenta (id, n) VALUES (1, 0)');

    // SLEEP() viene valutata una volta per riga: una riga, otto secondi.
    const t0 = Date.now();
    const res = await sql(DB, 'UPDATE lenta SET n = n + SLEEP(8)');
    const durata = Date.now() - t0;
    assert(!res.ok, `la scrittura lunga è stata interrotta (${res.ok ? 'NON interrotta' : res.error})`);
    assert(durata < 7000, `interrotta entro il tetto e non alla fine degli 8 s (${durata} ms)`);
    assert(!res.ok && /tempo massimo/i.test(res.error || ''),
      'il messaggio dice che è scaduto il tempo massimo');

    // KILL QUERY fa fare a InnoDB il rollback dell'istruzione: non esiste lo
    // stato "metà righe aggiornate", che è la ragione per cui un tetto sulla
    // scrittura è sicuro (a differenza di $out/$merge su MongoDB).
    const letta = await sql(DB, 'SELECT n FROM lenta WHERE id = 1');
    assert(letta.ok && Number(letta.docs[0].n) === 0,
      `la scrittura interrotta non ha lasciato traccia (${letta.ok ? letta.docs[0].n : letta.error})`);

    // La connessione avvelenata non deve restare nel pool: la query successiva
    // deve rispondere normalmente, non ricevere il result set arretrato.
    const dopo = await sql(DB, 'SELECT 1 AS vivo');
    assert(dopo.ok && dopo.docs && Number(dopo.docs[0].vivo) === 1,
      `la connessione successiva è sana (${dopo.ok ? 'ok' : dopo.error})`);
  } finally {
    await emit('db:drop', { db: DB });
    await emit('mongo:disconnect', {});
  }
}

// --- PostgreSQL ------------------------------------------------------------
async function provaPostgres() {
  console.log('\n--- PostgreSQL ---');
  const conn = await emit('mongo:connect', {
    dbType: 'postgresql', host: PG_HOST, port: PG_PORT,
    username: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
  });
  if (!conn.ok) return salta('PostgreSQL', conn.error || 'connessione non riuscita');

  await emit('db:drop', { db: DB });
  const creato = await emit('db:create', { db: DB, coll: '' });
  if (!creato.ok) return salta('PostgreSQL', `db:create non riuscito (${creato.error})`);
  try {
    await sql(DB, 'CREATE TABLE lenta (id INT PRIMARY KEY, n INT)');
    await sql(DB, 'INSERT INTO lenta (id, n) VALUES (1, 0)');

    // pg_sleep restituisce void: il cast a testo serve solo a poterla usare
    // dentro l'assegnamento della UPDATE.
    const t0 = Date.now();
    const res = await sql(DB, "UPDATE lenta SET n = length(pg_sleep(8)::text)");
    const durata = Date.now() - t0;
    assert(!res.ok, `la scrittura lunga è stata interrotta (${res.ok ? 'NON interrotta' : res.error})`);
    assert(durata < 7000, `interrotta entro il tetto e non alla fine degli 8 s (${durata} ms)`);

    // La riga non deve essere stata modificata: statement_timeout annulla
    // l'istruzione, che è la sua transazione implicita.
    const letta = await sql(DB, 'SELECT n FROM lenta WHERE id = 1');
    assert(letta.ok && Number(letta.docs[0].n) === 0,
      `la scrittura interrotta non ha lasciato traccia (${letta.ok ? letta.docs[0].n : letta.error})`);

    // La connessione deve tornare al pool utilizzabile. Che il `RESET
    // statement_timeout` venga davvero emesso è provato da `unit-tetto-tempo.js`
    // sulla sequenza di comandi; qui si controlla solo che la connessione
    // successiva risponda.
    const dopo = await sql(DB, 'SELECT 1 AS vivo');
    assert(dopo.ok && Number(dopo.docs[0].vivo) === 1,
      `la connessione successiva è sana (${dopo.ok ? 'ok' : dopo.error})`);
  } finally {
    await emit('db:drop', { db: DB });
    await emit('mongo:disconnect', {});
  }
}

(async () => {
  console.log(`--- Tetto di tempo sulla scrittura (CODEDB_AGGREGATE_TIMEOUT_MS=${TETTO_MS}) ---`);
  testServer = await startTestServer({
    port: parseInt(process.env.E2E_PORT, 10) || 3151,
    env: { CODEDB_AGGREGATE_TIMEOUT_MS: String(TETTO_MS) },
  });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  try {
    await provaMySql();
    await provaPostgres();
  } finally {
    socket.close();
    await testServer.stop();
  }
  if (saltati) console.log(`\n${saltati} motore/i saltato/i: la prova NON copre quel percorso.`);
  // Zero motori raggiungibili significa zero asserzioni: dichiararlo "superato"
  // sarebbe la bugia peggiore, perché è quella che ci si porta dietro.
  if (saltati === 2) console.log('\nNESSUNA PROVA ESEGUITA: nessun motore raggiungibile, il tetto NON risulta verificato.');
  else console.log(process.exitCode ? '\nALCUNI TEST FALLITI' : '\nTUTTI I TEST ESEGUITI SUPERATI');
})().catch(async (err) => {
  console.error('Errore imprevisto:', (err && err.stack) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});
