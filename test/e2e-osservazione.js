'use strict';

/* ---------------------------------------------------------------------------
 * L'osservazione da capo a fondo, e la riconnessione che ha guadagnato.
 *
 * `test/unit-osservazione-giuntura.js` prova le decisioni: che i quattro eventi
 * passino dalla giuntura dei dati, che rispondano, che abbiano una capability.
 * Quello che un contesto finto non può provare è il comportamento vero:
 *
 *  1. che mettere in osservazione una collezione **funzioni** contro un
 *     MongoDB vero, e che un cambiamento arrivi al client come push;
 *  2. che i due eventi che TOLGONO l'osservazione rispondano davvero: prima
 *     non lo facevano, e qui un ack mancante si vedrebbe come test appeso.
 *
 * CHE COSA QUESTO TEST NON PROVA, dichiarato: la riconnessione automatica in
 * azione. Farla scattare significa far girare il vero ciclo di ripristino —
 * quattordici tentativi con attese crescenti, minuti — e abbattere la
 * connessione sotto la sessione senza toccare il server non è raggiungibile da
 * qui. Che i quattro eventi stiano sulla via che riprova (`executeWithReconnect`,
 * dentro `delegate`) è verificato staticamente in
 * test/unit-osservazione-giuntura.js; che quella via funzioni lo provano i test
 * di riconnessione già esistenti.
 *
 * Uso: node test/e2e-osservazione.js
 * Richiede un MongoDB su MONGO_HOST (127.0.0.1) : MONGO_PORT (27017).
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

const DB = 'codedb_e2e_osservazione';
const COLL = 'eventi';
const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';
const MONGO_PORT = parseInt(process.env.MONGO_PORT, 10) || 27017;

let socket = null;
let testServer = null;
let saltato = false;

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function assert(cond, label, dettaglio = '') {
  if (cond) console.log(`  OK   ${label}`);
  else {
    console.error(`  FAIL ${label}${dettaglio ? `\n       ${dettaglio}` : ''}`);
    process.exitCode = 1;
  }
}

/** Aspetta un push del server, con scadenza. */
function attendiPush(evento, ms = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(evento, ascolta); resolve(null); }, ms);
    const ascolta = (payload) => { clearTimeout(timer); socket.off(evento, ascolta); resolve(payload); };
    socket.on(evento, ascolta);
  });
}

(async () => {
  console.log('--- E2E: osservazione e riconnessione dei quattro eventi ---');
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3155 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  try {
    const conn = await emit('mongo:connect', {
      dbType: 'mongodb', host: MONGO_HOST, port: MONGO_PORT, tabId: 'tab-osserva',
    });
    if (!conn.ok) {
      saltato = true;
      console.log(`  SALTATO: MongoDB non raggiungibile (${conn.error})`);
      return;
    }

    await emit('db:drop', { db: DB, tabId: 'tab-osserva' });
    await emit('db:create', { db: DB, coll: COLL, tabId: 'tab-osserva' });

    /* --- 1. I quattro eventi rispondono ------------------------------- */

    const messa = await emit('collection:watch', { db: DB, coll: COLL, tabId: 'tab-osserva' });
    assert(messa.ok, 'collection:watch risponde', messa.error);

    const schema = await emit('schema:watch', { tabId: 'tab-osserva' });
    assert(schema.ok, 'schema:watch risponde', schema.error);

    // Prima del ticket 17 questi due non rispondevano affatto: il client
    // restava in attesa di un ack che non arrivava mai. Qui l'attesa avrebbe
    // scadenza, quindi un ack mancante si vede come test appeso.
    const tolta = await emit('collection:unwatch', { tabId: 'tab-osserva' });
    assert(tolta && tolta.ok, 'collection:unwatch RISPONDE (prima non lo faceva)', tolta && tolta.error);

    const toltaSchema = await emit('schema:unwatch', { tabId: 'tab-osserva' });
    assert(toltaSchema && toltaSchema.ok, 'schema:unwatch RISPONDE (prima non lo faceva)',
      toltaSchema && toltaSchema.error);

    /* --- 2. Un cambiamento arriva al client --------------------------- */

    const riMessa = await emit('collection:watch', { db: DB, coll: COLL, tabId: 'tab-osserva' });
    assert(riMessa.ok, 'collection:watch di nuovo attivo', riMessa.error);

    // Su MongoDB standalone i change stream non esistono: il server manda
    // `watch:unavailable` e il frontend ripiega sul polling. Entrambe le
    // risposte sono corrette, e il test le distingue invece di pretenderne una.
    const push = await Promise.race([
      attendiPush('collection:changed', 6000),
      attendiPush('watch:unavailable', 6000),
    ]);
    const scritto = await emit('doc:insert', {
      db: DB, coll: COLL, tabId: 'tab-osserva', doc: JSON.stringify({ nome: 'osservato' }),
    });
    assert(scritto.ok, 'documento inserito nella collezione osservata', scritto.error);
    const arrivato = push || await Promise.race([
      attendiPush('collection:changed', 6000),
      attendiPush('watch:unavailable', 6000),
    ]);
    assert(!!arrivato, 'il server ha risposto sull\'osservazione (cambiamento o indisponibilità)');

    /* --- 3. Rimettere l'osservazione è idempotente -------------------- */

    const dopo = await emit('collection:watch', { db: DB, coll: COLL, tabId: 'tab-osserva' });
    assert(dopo.ok, "rimettere l'osservazione su una già attiva non è un errore", dopo.error);

    /* --- 4. Un tab inesistente riceve il messaggio della giuntura ------ */

    const orfano = await emit('collection:watch', { db: DB, coll: COLL, tabId: 'tab-che-non-esiste' });
    assert(!orfano.ok && /Nessuna connessione attiva/.test(orfano.error || ''),
      'senza sessione risponde con il messaggio della giuntura', orfano.error);

    await emit('collection:unwatch', { tabId: 'tab-osserva' });
    await emit('schema:unwatch', { tabId: 'tab-osserva' });
    await emit('db:drop', { db: DB, tabId: 'tab-osserva' });
    await emit('mongo:disconnect', { tabId: 'tab-osserva' });
  } finally {
    socket.close();
    await testServer.stop();
  }

  if (saltato) {
    console.log('\nSALTATO: nessuna prova eseguita, l\'osservazione NON risulta verificata.');
    process.exitCode = 1;
  } else {
    console.log(process.exitCode ? '\nALCUNI TEST FALLITI' : '\nTUTTI I TEST SUPERATI');
  }
})().catch(async (err) => {
  console.error('Errore imprevisto:', (err && err.stack) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});
