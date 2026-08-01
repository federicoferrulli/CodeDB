'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E del runner di script (Fase A3): eventi socket `script:execute`,
 * `script:pause`, `script:resume`, `script:state`, `script:abort` e push
 * `script:progress`.
 *
 * Gira su MongoDB (localhost:27017), che è il database sempre richiesto dagli
 * altri e2e. Verifica le proprietà che rendono lo script una "query in
 * sospeso": ack immediato, progresso, PAUSA a metà e RIPRESA dal cursore senza
 * rieseguire ciò che era già passato, e "continua e riporta" sugli errori.
 *
 * Uso: node test/e2e-script-runner.js
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

let socket = null;
let testServer = null;
const DB = 'gui_mongodb_e2e';
const COLL = 'script_items';

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

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attende l'evento `script:progress` che soddisfa il predicato (con timeout). */
function attendiProgresso(pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('script:progress', onEv);
      reject(new Error('timeout in attesa di script:progress'));
    }, timeoutMs);
    function onEv(ev) {
      if (!pred(ev)) return;
      clearTimeout(timer);
      socket.off('script:progress', onEv);
      resolve(ev);
    }
    socket.on('script:progress', onEv);
  });
}

(async () => {
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3149 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  await runTests();
})().catch(async (err) => {
  console.error('Impossibile avviare i test:', (err && err.message) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});

async function runTests() {
  try {
    console.log('--- Test E2E runner di script ---');

    console.log('1. Connessione MongoDB');
    const conn = await emit('mongo:connect', { host: 'localhost', port: 27017 });
    assert(conn.ok, 'Connessione a MongoDB riuscita');
    if (!conn.ok) return socket.close();

    // Dati di partenza: lo script legge, quindi serve qualcosa da leggere.
    await emit('collection:drop', { db: DB, coll: COLL }).catch(() => {});
    for (let i = 1; i <= 5; i++) {
      await emit('doc:insert', { db: DB, coll: COLL, doc: JSON.stringify({ n: i, tipo: 'x' }) });
    }

    /* --- Script completo -------------------------------------------------- */
    console.log('2. Script di sole letture: ack immediato e progresso');
    const eventi = [];
    const raccogli = (ev) => eventi.push(ev);
    socket.on('script:progress', raccogli);

    const codice = [
      `db.${COLL}.find({ tipo: 'x' })`,
      `db.${COLL}.find({ n: 1 })`,
      `db.${COLL}.count()`,
    ].join(';\n');

    const avvio = await emit('script:execute', { db: DB, coll: COLL, code: codice, runId: 'e2e-1' });
    assert(avvio.ok && avvio.total === 3, `Ack immediato con total=3 (ricevuto ${avvio.total})`);

    const fine = await attendiProgresso((ev) => ev.runId === 'e2e-1' && ev.tipo === 'done');
    assert(fine.stato.status === 'done', 'Script terminato con stato done');
    assert(fine.stato.eseguiti === 3, `Tutte e 3 le istruzioni eseguite (${fine.stato.eseguiti})`);
    assert(fine.stato.falliti === 0, 'Nessun fallimento su script valido');
    assert(!!fine.ultimoRisultato, 'La fine porta con sé l\'ultimo result set da mostrare');
    socket.off('script:progress', raccogli);

    const conRiga = eventi.find((e) => e.tipo === 'statement' && e.result && e.result.line);
    assert(!!conRiga, 'Il progresso riporta la riga dell\'istruzione');

    /* --- Continua e riporta ----------------------------------------------- */
    console.log('3. Errore a metà: lo script CONTINUA e riporta');
    const codiceKo = [
      `db.${COLL}.find({ n: 1 })`,
      'db.$$$non_valido$$$.find({',            // errore di sintassi
      `db.${COLL}.find({ n: 2 })`,
    ].join(';\n');

    const avvio2 = await emit('script:execute', { db: DB, coll: COLL, code: codiceKo, runId: 'e2e-2' });
    assert(avvio2.ok, 'Script con errore avviato');

    const fine2 = await attendiProgresso((ev) => ev.runId === 'e2e-2' && ev.tipo === 'done');
    assert(fine2.stato.eseguiti === 3, `Tutte le istruzioni tentate nonostante l'errore (${fine2.stato.eseguiti})`);
    assert(fine2.stato.falliti === 1, `Un solo fallimento registrato (${fine2.stato.falliti})`);
    const voceKo = fine2.stato.results.find((r) => !r.ok);
    assert(!!(voceKo && voceKo.error), 'Il messaggio d\'errore è nel resoconto');
    assert(voceKo && voceKo.line === 2, `L'errore punta la riga 2 (riga ${voceKo && voceKo.line})`);

    /* --- stopOnError ------------------------------------------------------ */
    console.log('4. stopOnError: si ferma in pausa ed è riprendibile');
    const avvio3 = await emit('script:execute', {
      db: DB, coll: COLL, code: codiceKo, runId: 'e2e-3', stopOnError: true,
    });
    assert(avvio3.ok, 'Script stopOnError avviato');

    const pausa3 = await attendiProgresso((ev) => ev.runId === 'e2e-3' && ev.tipo === 'paused');
    assert(pausa3.stato.status === 'paused', 'Fermato in pausa al primo errore');
    assert(pausa3.stato.eseguiti === 2, `Eseguite 2 istruzioni prima di fermarsi (${pausa3.stato.eseguiti})`);
    assert(pausa3.stato.cursor === 2, 'Il cursore ha superato l\'istruzione fallita');

    const ripresa3 = await emit('script:resume', { runId: 'e2e-3' });
    assert(ripresa3.ok, 'Ripresa accettata');
    const fine3 = await attendiProgresso((ev) => ev.runId === 'e2e-3' && ev.tipo === 'done');
    assert(fine3.stato.eseguiti === 3, `Alla ripresa si completa l'ultima istruzione (${fine3.stato.eseguiti})`);

    /* --- Pausa e ripresa a metà ------------------------------------------- */
    console.log('5. Pausa a metà e ripresa dal cursore (nessun doppione)');
    // Istruzioni volutamente LENTE (qualche decimo di secondo l'una): con
    // letture istantanee lo script finirebbe prima che la pausa arrivi e il
    // test proverebbe solo che il server risponde, non che la pausa funziona.
    const lenta = `db.${COLL}.aggregate([{ "$limit": 1 }, { "$addFields": { "z": { "$range": [0, 400000] } } }, { "$unwind": "$z" }, { "$group": { "_id": null, "n": { "$sum": "$z" } } }])`;
    const molte = Array.from({ length: 12 }, () => lenta).join(';\n');
    const avvio4 = await emit('script:execute', { db: DB, coll: COLL, code: molte, runId: 'e2e-4' });
    assert(avvio4.ok && avvio4.total === 12, `Script da 12 istruzioni lente avviato (${avvio4.total})`);

    // Pausa quasi subito: si ferma DOPO l'istruzione in corso.
    await attendiProgresso((ev) => ev.runId === 'e2e-4' && ev.tipo === 'statement');
    const pausa4 = await emit('script:pause', { runId: 'e2e-4' });
    assert(pausa4.ok && pausa4.paused, 'Pausa accettata');

    await attendiProgresso((ev) => ev.runId === 'e2e-4' && ev.tipo === 'paused');
    const stato4 = await emit('script:state', { runId: 'e2e-4' });
    const cursorePausa = stato4.stato.cursor;
    assert(stato4.stato.status === 'paused', 'Stato interrogabile: in pausa');
    assert(cursorePausa > 0 && cursorePausa < 12, `Fermato a metà (cursore ${cursorePausa}/12)`);

    // Nessun avanzamento mentre è in pausa: è la proprietà che rende la pausa
    // una pausa vera e non solo un'etichetta nella UI.
    await attesa(400);
    const statoFermo = await emit('script:state', { runId: 'e2e-4' });
    assert(statoFermo.stato.cursor === cursorePausa, 'In pausa il cursore non avanza');

    await emit('script:resume', { runId: 'e2e-4' });
    const fine4 = await attendiProgresso((ev) => ev.runId === 'e2e-4' && ev.tipo === 'done', 60000);
    assert(fine4.stato.eseguiti === 12, `Riprende e completa tutte le 12 (${fine4.stato.eseguiti})`);
    assert(fine4.stato.falliti === 0, 'Nessun errore dopo la ripresa');

    /* --- Pausa FORZATA: tronca l'istruzione in corso ---------------------- */
    console.log('5-bis. Pausa forzata: l\'istruzione troncata non conta come errore');
    const avvio4b = await emit('script:execute', { db: DB, coll: COLL, code: molte, runId: 'e2e-4b' });
    assert(avvio4b.ok, 'Script per la pausa forzata avviato');
    await attendiProgresso((ev) => ev.runId === 'e2e-4b' && ev.tipo === 'statement');

    const forzata = await emit('script:pause', { runId: 'e2e-4b', force: true });
    assert(forzata.ok && forzata.paused, 'Pausa forzata accettata');
    const pausa4b = await attendiProgresso((ev) => ev.runId === 'e2e-4b' && ev.tipo === 'paused');
    // Se il troncamento è arrivato a segno, l'istruzione risulta `interrupted`:
    // non è un fallimento e il cursore non l'ha superata, così la ripresa la
    // rilancia invece di saltarla.
    const troncata = pausa4b.stato.results.find((r) => r.interrupted);
    if (troncata) {
      assert(pausa4b.stato.falliti === 0, 'L\'istruzione troncata non è contata fra i falliti');
      assert(pausa4b.stato.cursor === troncata.index, 'Il cursore resta sull\'istruzione troncata');
    } else {
      assert(pausa4b.stato.status === 'paused', 'Pausa forzata: script fermo (istruzione già conclusa)');
    }
    await emit('script:abort', { runId: 'e2e-4b' });

    /* --- Abort ------------------------------------------------------------ */
    console.log('6. Abort: interruzione definitiva');
    const avvio5 = await emit('script:execute', { db: DB, coll: COLL, code: molte, runId: 'e2e-5' });
    assert(avvio5.ok, 'Script da interrompere avviato');
    await attendiProgresso((ev) => ev.runId === 'e2e-5' && ev.tipo === 'statement');
    const stop = await emit('script:abort', { runId: 'e2e-5' });
    assert(stop.ok && stop.aborted, 'Abort accettato');

    await attesa(300);
    const dopoAbort = await emit('script:state', { runId: 'e2e-5' });
    assert(dopoAbort.stato === null, 'Il run interrotto non è più attivo');

    /* --- Scritture reali dallo script ------------------------------------- */
    console.log('7. Lo script scrive davvero sul database');
    const dropRes = await emit('collection:drop', { db: DB, coll: 'script_out' }).catch(() => ({}));
    void dropRes;
    const scrittura = [
      `db.${COLL}.aggregate([{ "$match": { "tipo": "x" } }, { "$out": "script_out" }])`,
      'db.script_out.count()',
    ].join(';\n');
    const avvio6 = await emit('script:execute', { db: DB, coll: COLL, code: scrittura, runId: 'e2e-6' });
    assert(avvio6.ok, 'Script di scrittura avviato');
    const fine6 = await attendiProgresso((ev) => ev.runId === 'e2e-6' && ev.tipo === 'done');
    assert(fine6.stato.falliti === 0, `Scrittura riuscita senza errori (${JSON.stringify(fine6.stato.results.filter((r) => !r.ok).map((r) => r.error))})`);

    const conteggio = await emit('collection:count', { db: DB, coll: 'script_out', filter: '{}' });
    assert(conteggio.ok && conteggio.total === 5, `La collection creata dallo script contiene 5 documenti (${conteggio.total})`);

    /* --- Casi limite ------------------------------------------------------ */
    console.log('8. Casi limite');
    const vuoto = await emit('script:execute', { db: DB, coll: COLL, code: '   ', runId: 'e2e-7' });
    assert(!vuoto.ok, 'Script vuoto rifiutato con errore');

    const senzaRunId = await emit('script:execute', { db: DB, coll: COLL, code: 'db.x.find({})' });
    assert(!senzaRunId.ok, 'runId mancante rifiutato');

    const soloCommenti = await emit('script:execute', { db: DB, coll: COLL, code: '-- solo commenti\n;', runId: 'e2e-8' });
    assert(!soloCommenti.ok, 'Script senza istruzioni eseguibili rifiutato');

    const doppione = await emit('script:execute', { db: DB, coll: COLL, code: molte, runId: 'e2e-9' });
    assert(doppione.ok, 'Script avviato per il test del doppio runId');
    const bis = await emit('script:execute', { db: DB, coll: COLL, code: molte, runId: 'e2e-9' });
    assert(!bis.ok, 'runId già in uso rifiutato');
    await emit('script:abort', { runId: 'e2e-9' });

    const inesistente = await emit('script:resume', { runId: 'mai-esistito' });
    assert(!inesistente.ok, 'Ripresa di uno script inesistente rifiutata con errore chiaro');

    console.log('9. Pulizia');
    await emit('collection:drop', { db: DB, coll: COLL }).catch(() => {});
    await emit('collection:drop', { db: DB, coll: 'script_out' }).catch(() => {});

    if (process.exitCode) console.error('\n--- Alcuni test FALLITI ---');
    else console.log('\n--- Tutti i test del runner di script superati! ---');
  } catch (err) {
    console.error('Errore durante i test:', (err && err.stack) || err);
    process.exitCode = 1;
  } finally {
    socket.close();
    if (testServer) await testServer.stop();
  }
}
