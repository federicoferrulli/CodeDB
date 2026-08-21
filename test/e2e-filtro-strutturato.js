'use strict';

/* ---------------------------------------------------------------------------
 * Il filtro strutturato contro i tre motori VERI.
 *
 * `test/unit-filtro.js` prova che il valore non finisca nel testo della query.
 * Quello che un modulo puro non può provare è che i tre motori accettino
 * davvero ciò che viene loro mandato, e che uno stesso filtro dia lo stesso
 * insieme di righe su tutti e tre — che è il punto dell'intero lotto: la firma
 * smette di significare tre cose diverse.
 *
 * E la prova che conta di più: un valore ostile arriva al motore come VALORE.
 * Non si verifica che venga «sanificato» — non viene sanificato affatto: viene
 * parametrizzato, e la tabella resta in piedi.
 *
 * Uso: node test/e2e-filtro-strutturato.js
 *   MongoDB:    MONGO_HOST (127.0.0.1), MONGO_PORT (27017)
 *   MySQL:      MYSQL_PORT (3306), MYSQL_PASSWORD ('')
 *   PostgreSQL: PG_HOST (127.0.0.1), PG_PORT (5432), PG_USER (postgres),
 *               PG_PASSWORD (''), PG_DATABASE (postgres)
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

const DB = 'codedb_e2e_filtro';
const COLL = 'clienti';

const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';
const MONGO_PORT = parseInt(process.env.MONGO_PORT, 10) || 27017;
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.PG_PORT, 10) || 5432;
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'postgres';

let socket = null;
let testServer = null;
const saltati = [];
/** Righe trovate per motore e per filtro: è ciò che alla fine viene confrontato. */
const osservato = {};

// Il valore ostile è anche un DATO REALE della tabella: se venisse interpretato
// invece che confrontato, il filtro non lo troverebbe — e il test lo vedrebbe.
const OSTILE = "a' OR 1=1 --";

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

function salta(motore, motivo) {
  saltati.push(motore);
  console.log(`  SALTATO ${motore}: ${motivo}`);
}

const sql = (db, query) => emit('collection:aggregate', { db, coll: null, pipeline: query, tabId: 'tab-f' });

/** Legge con un filtro STRUTTURATO e restituisce i nomi trovati, ordinati. */
async function conFiltro(condizioni, unione) {
  const res = await emit('collection:find', {
    db: DB, coll: COLL, filtro: { condizioni, unione }, limit: 100, skip: 0, tabId: 'tab-f',
  });
  if (!res.ok) throw new Error(res.error);
  return (res.docs || []).map((d) => String(d.nome)).sort();
}

async function provaMotore(nome, connessione, prepara, pulisci) {
  console.log(`\n--- ${nome} ---`);
  const conn = await emit('mongo:connect', { ...connessione, tabId: 'tab-f' });
  if (!conn.ok) return salta(nome, conn.error || 'connessione non riuscita');
  try {
    const pronto = await prepara();
    if (pronto !== true) return salta(nome, pronto);

    const trovati = {};
    trovati.uguale = await conFiltro([{ campo: 'nome', operatore: 'uguale', valore: 'anna' }]);
    trovati.contiene = await conFiltro([{ campo: 'nome', operatore: 'contiene', valore: 'nn' }]);
    trovati.iniziaCon = await conFiltro([{ campo: 'nome', operatore: 'iniziaCon', valore: 'b' }]);
    trovati.maggiore = await conFiltro([{ campo: 'eta', operatore: 'maggiore', valore: 30 }]);
    trovati.dentro = await conFiltro([{ campo: 'nome', operatore: 'dentro', valore: ['anna', 'bruno'] }]);
    trovati.vuoto = await conFiltro([{ campo: 'nome', operatore: 'vuoto' }]);
    trovati.nonVuoto = await conFiltro([{ campo: 'nome', operatore: 'nonVuoto' }]);
    trovati.due = await conFiltro([
      { campo: 'eta', operatore: 'maggiore', valore: 20 },
      { campo: 'nome', operatore: 'iniziaCon', valore: 'a' },
    ]);
    trovati.oppure = await conFiltro([
      { campo: 'nome', operatore: 'uguale', valore: 'anna' },
      { campo: 'nome', operatore: 'uguale', valore: 'bruno' },
    ], 'o');
    // La prova che conta: il valore ostile è un dato della tabella, e il filtro
    // deve trovarlo ESATTAMENTE — cioè averlo confrontato, non interpretato.
    trovati.ostile = await conFiltro([{ campo: 'nome', operatore: 'uguale', valore: OSTILE }]);

    osservato[nome] = trovati;

    assert(trovati.uguale.length === 1 && trovati.uguale[0] === 'anna',
      `${nome}: uguale`, JSON.stringify(trovati.uguale));
    assert(trovati.contiene.join() === 'anna', `${nome}: contiene`, JSON.stringify(trovati.contiene));
    assert(trovati.iniziaCon.join() === 'bruno', `${nome}: iniziaCon`, JSON.stringify(trovati.iniziaCon));
    assert(trovati.maggiore.join() === 'bruno', `${nome}: maggiore`, JSON.stringify(trovati.maggiore));
    assert(trovati.dentro.join() === 'anna,bruno', `${nome}: dentro`, JSON.stringify(trovati.dentro));
    assert(trovati.vuoto.length === 1, `${nome}: vuoto trova la riga senza nome`, JSON.stringify(trovati.vuoto));
    assert(trovati.nonVuoto.length === 3, `${nome}: nonVuoto trova le altre tre`, JSON.stringify(trovati.nonVuoto));
    assert(trovati.due.join() === 'anna', `${nome}: due condizioni in AND`, JSON.stringify(trovati.due));
    assert(trovati.oppure.join() === 'anna,bruno', `${nome}: due condizioni in OR`, JSON.stringify(trovati.oppure));

    assert(trovati.ostile.length === 1 && trovati.ostile[0] === OSTILE,
      `${nome}: il valore ostile è stato CONFRONTATO, non interpretato`,
      JSON.stringify(trovati.ostile));

    // E la tabella è ancora lì con tutte le sue righe.
    const dopo = await conFiltro([{ campo: 'id', operatore: 'maggiore', valore: 0 }]);
    assert(dopo.length === 4, `${nome}: la tabella è intatta dopo il filtro ostile (${dopo.length} righe)`);
  } catch (err) {
    assert(false, `${nome}: prova interrotta`, err.message);
  } finally {
    await pulisci().catch(() => {});
    await emit('mongo:disconnect', { tabId: 'tab-f' });
  }
}

async function provaMySql() {
  await provaMotore('MySQL',
    { dbType: 'mysql', host: '127.0.0.1', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD },
    async () => {
      await emit('db:drop', { db: DB, tabId: 'tab-f' });
      const creato = await emit('db:create', { db: DB, coll: '', tabId: 'tab-f' });
      if (!creato.ok) return `db:create non riuscito (${creato.error})`;
      const creata = await sql(DB, `CREATE TABLE ${COLL} (id INT PRIMARY KEY, nome VARCHAR(80) NULL, eta INT NULL)`);
      if (!creata.ok) return `CREATE TABLE non riuscita (${creata.error})`;
      // L'apice nel valore ostile si raddoppia: è la forma standard, e MySQL la
      // accetta come PostgreSQL. Il risultato dell'INSERT si CONTROLLA — un
      // inserimento fallito in silenzio darebbe una tabella vuota e dieci
      // fallimenti che sembrano del filtro.
      const inserite = await sql(DB, `INSERT INTO ${COLL} (id, nome, eta) VALUES `
        + `(1, 'anna', 25), (2, 'bruno', 40), (3, NULL, 10), (4, 'a'' OR 1=1 --', 1)`);
      if (!inserite.ok) return `INSERT non riuscita (${inserite.error})`;
      return true;
    },
    () => emit('db:drop', { db: DB, tabId: 'tab-f' }));
}

async function provaPostgres() {
  await provaMotore('PostgreSQL',
    {
      dbType: 'postgresql', host: PG_HOST, port: PG_PORT,
      username: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
    },
    async () => {
      await emit('db:drop', { db: DB, tabId: 'tab-f' });
      const creato = await emit('db:create', { db: DB, coll: '', tabId: 'tab-f' });
      if (!creato.ok) return `db:create non riuscito (${creato.error})`;
      const creata = await sql(DB, `CREATE TABLE ${COLL} (id INT PRIMARY KEY, nome VARCHAR(80) NULL, eta INT NULL)`);
      if (!creata.ok) return `CREATE TABLE non riuscita (${creata.error})`;
      const inserite = await sql(DB, `INSERT INTO ${COLL} (id, nome, eta) VALUES `
        + `(1, 'anna', 25), (2, 'bruno', 40), (3, NULL, 10), (4, 'a'' OR 1=1 --', 1)`);
      if (!inserite.ok) return `INSERT non riuscita (${inserite.error})`;
      return true;
    },
    () => emit('db:drop', { db: DB, tabId: 'tab-f' }));
}

async function provaMongo() {
  await provaMotore('MongoDB',
    { dbType: 'mongodb', host: MONGO_HOST, port: MONGO_PORT },
    async () => {
      await emit('db:drop', { db: DB, tabId: 'tab-f' });
      const creato = await emit('db:create', { db: DB, coll: COLL, tabId: 'tab-f' });
      if (!creato.ok) return `db:create non riuscito (${creato.error})`;
      const righe = [
        { id: 1, nome: 'anna', eta: 25 },
        { id: 2, nome: 'bruno', eta: 40 },
        { id: 3, nome: null, eta: 10 },
        { id: 4, nome: OSTILE, eta: 1 },
      ];
      for (const doc of righe) {
        const r = await emit('doc:insert', { db: DB, coll: COLL, doc: JSON.stringify(doc), tabId: 'tab-f' });
        if (!r.ok) return `inserimento non riuscito (${r.error})`;
      }
      return true;
    },
    () => emit('db:drop', { db: DB, tabId: 'tab-f' }));
}

/** Il confronto fra i motori: la stessa domanda, la stessa risposta. */
function confronta() {
  console.log('\n--- Confronto fra i motori ---');
  const motori = Object.keys(osservato);
  if (motori.length < 2) {
    console.log(`  IMPOSSIBILE: motori disponibili ${motori.length}, ne servono almeno 2.`);
    return;
  }
  const riferimento = osservato[motori[0]];
  for (const m of motori.slice(1)) {
    const diversi = Object.keys(riferimento).filter(
      (k) => JSON.stringify(osservato[m][k]) !== JSON.stringify(riferimento[k])
    );
    assert(diversi.length === 0,
      `${m} risponde come ${motori[0]} a tutti i filtri`,
      diversi.map((k) => `${k}: ${motori[0]}=${JSON.stringify(riferimento[k])} ${m}=${JSON.stringify(osservato[m][k])}`).join('\n       '));
  }
}

(async () => {
  console.log('--- E2E: il filtro strutturato sui tre motori ---');
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3157 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  try {
    await provaMongo();
    await provaMySql();
    await provaPostgres();
    confronta();
  } finally {
    socket.close();
    await testServer.stop();
  }

  if (saltati.length) {
    console.log(`\n${saltati.length} motore/i saltato/i (${saltati.join(', ')}): la prova NON copre quel percorso.`);
  }
  if (Object.keys(osservato).length < 2) {
    console.log('\nNESSUN CONFRONTO ESEGUITO: l\'equivalenza fra i motori NON risulta verificata.');
    process.exitCode = 1;
  } else {
    console.log(process.exitCode ? '\nALCUNI TEST FALLITI' : '\nTUTTI I TEST ESEGUITI SUPERATI');
  }
})().catch(async (err) => {
  console.error('Errore imprevisto:', (err && err.stack) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
});
