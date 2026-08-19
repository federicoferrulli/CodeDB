'use strict';

/* ---------------------------------------------------------------------------
 * Test E2E: quale risultato mostra uno SCRIPT a più istruzioni (MySQL).
 *
 *   MYSQL_PASSWORD=root node test/e2e-script-risultati.js
 *
 * IL DIFETTO. `USE Prova_; SELECT * FROM Pippo;` su una tabella vuota mostrava
 * nella griglia il messaggio della `USE` — «Database attivo cambiato in
 * Prova_» — cioè il risultato di UN'ALTRA istruzione, con tutta l'aria di
 * essere la risposta alla SELECT appena scritta. La causa era una riga sola:
 * l'ultimo risultato veniva aggiornato solo se aveva `docs.length`, e zero
 * righe è un RISULTATO, non l'assenza di uno.
 *
 * Distinguere le due cose non si può fare guardando i `docs`: lo dichiara la
 * strategia con `resultSet`, l'unica a sapere se il driver ha restituito righe
 * o un riepilogo di scrittura. Per questo il test guarda anche i casi di
 * scrittura e DDL: la correzione non doveva far sparire i loro riepiloghi.
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const DB = 'codedb_e2e_script_risultati';

let socket, testServer;
let falliti = 0;
const emit = (ev, p) => new Promise((r) => socket.emit(ev, p, r));
const ok = (cond, etichetta, dettaglio = '') => {
  if (cond) console.log(`  OK   ${etichetta}`);
  else { console.error(`  FAIL ${etichetta}${dettaglio ? `\n       ${dettaglio}` : ''}`); falliti++; }
};

// Esegue uno script e aspetta l'evento terminale, restituendo ciò su cui il
// pannello si basa: l'ultimo risultato e il resoconto delle istruzioni.
function eseguiScript(code, db) {
  const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const scaduto = setTimeout(() => reject(new Error('script senza evento terminale entro 15 s')), 15000);
    const onProgress = (ev) => {
      if (ev.runId !== runId || ev.tipo !== 'done') return;
      clearTimeout(scaduto);
      socket.off('script:progress', onProgress);
      resolve({ ultimoRisultato: ev.ultimoRisultato, stato: ev.stato });
    };
    socket.on('script:progress', onProgress);
    socket.emit('script:execute', { runId, code, engine: 'auto', db, coll: null, stopOnError: false }, (ack) => {
      if (!ack || !ack.ok) { clearTimeout(scaduto); socket.off('script:progress', onProgress); reject(new Error(ack && ack.error)); }
    });
  });
}

(async () => {
  console.log('--- E2E: risultato mostrato da uno script (MySQL) ---');
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3147 });
  socket = io(testServer.url);
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('connect_error', rej); });

  const conn = await emit('mongo:connect', {
    dbType: 'mysql', host: 'localhost', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD,
  });
  if (!conn.ok) {
    console.log(`  SKIP Nessun MySQL utilizzabile: ${conn.error}`);
    socket.close(); await testServer.stop();
    return;
  }

  try {
    await emit('db:drop', { db: DB });
    await emit('db:create', { db: DB, coll: '' });
    const sql = (q) => emit('collection:aggregate', { db: DB, coll: null, pipeline: q });
    await sql('CREATE TABLE vuota (id INT PRIMARY KEY, addsa VARCHAR(20))');
    await sql('CREATE TABLE piena (id INT PRIMARY KEY, addsa VARCHAR(20))');
    await sql("INSERT INTO piena VALUES (1,'a'),(2,'b')");

    // 1. IL CASO DEL DIFETTO: l'ultima istruzione è una SELECT senza righe.
    //    La griglia deve ricevere un result set VUOTO con le sue colonne, non
    //    il messaggio della USE.
    {
      const { ultimoRisultato: u, stato } = await eseguiScript(`USE ${DB};\nSELECT * FROM vuota;`, DB);
      ok(u && Array.isArray(u.docs) && u.docs.length === 0,
        'SELECT senza righe: la griglia riceve un result set vuoto',
        `ricevuto: ${JSON.stringify(u)}`);
      ok(u && Array.isArray(u.columns) && u.columns.includes('addsa'),
        'e con le colonne della SELECT (non quelle della USE)',
        `colonne: ${JSON.stringify(u && u.columns)}`);
      ok(!(u && u.docs[0] && 'activeDb' in u.docs[0]),
        'il messaggio della USE non finisce più nella griglia');
      // È da qui che il pannello ricostruisce il log diradato: se il resoconto
      // non elencasse entrambe le istruzioni, il log resterebbe monco.
      ok(stato && Array.isArray(stato.results) && stato.results.length === 2,
        'il resoconto finale elenca entrambe le istruzioni',
        `results: ${JSON.stringify(stato && stato.results)}`);
      ok(stato && stato.results[1] && stato.results[1].rows === 0,
        'e riporta le zero righe della seconda');
    }

    // 2. Il caso che già funzionava non deve rompersi.
    {
      const { ultimoRisultato: u } = await eseguiScript(`USE ${DB};\nSELECT * FROM piena;`, DB);
      ok(u && u.docs.length === 2 && u.docs[0].addsa === 'a',
        'SELECT con righe: la griglia riceve le righe', `ricevuto: ${JSON.stringify(u)}`);
    }

    // 3. Uno script che NON produce result set (scrittura, DDL) deve continuare
    //    a mostrare il proprio riepilogo: la correzione riguardava i result set
    //    vuoti, non i riepiloghi.
    {
      const { ultimoRisultato: u } = await eseguiScript(`USE ${DB};\nINSERT INTO vuota VALUES (9,'z');`, DB);
      ok(u && u.docs.length === 1 && u.docs[0] && 'righeCoinvolte' in u.docs[0],
        'script di sola scrittura: resta il riepilogo delle righe coinvolte',
        `ricevuto: ${JSON.stringify(u)}`);
    }

    // 4. L'ordine conta: se DOPO una SELECT vuota arriva una scrittura, è il
    //    riepilogo della scrittura a essere l'ultimo risultato.
    {
      const { ultimoRisultato: u } = await eseguiScript(
        `USE ${DB};\nSELECT * FROM vuota WHERE id < 0;\nUPDATE vuota SET addsa='y' WHERE id = 9;`, DB);
      ok(u && u.docs.length === 1 && u.docs[0] && 'righeCoinvolte' in u.docs[0],
        'l\'ultimo risultato è davvero l\'ULTIMO, non il primo non vuoto',
        `ricevuto: ${JSON.stringify(u)}`);
    }
  } finally {
    await emit('db:drop', { db: DB }).catch(() => {});
    socket.close();
    await testServer.stop();
  }

  if (falliti) { console.error(`\n${falliti} test falliti.`); process.exitCode = 1; }
  else console.log('Tutti i test E2E sul risultato dello script superati!');
})().catch(async (err) => {
  console.error('FALLITO:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});
