'use strict';

/* ---------------------------------------------------------------------------
 * Test end-to-end del percorso PostgreSQL.
 *
 * Nasce dalla correzione CDB-04: il livello "database" dell'interfaccia è lo
 * SCHEMA del database connesso. Prima `qtable()` scartava lo schema e ogni
 * operazione veniva risolta dal `search_path`, quindi con TABELLE OMONIME in
 * schemi diversi si leggeva, si modificava e si eliminava la riga sbagliata.
 * Il test costruisce apposta due schemi con la stessa tabella e verifica che
 * ogni operazione colpisca quella giusta.
 *
 * Avvia una propria istanza di CodeDB (test/e2e-harness.js) e richiede un
 * PostgreSQL locale:
 *   env PG_PORT (default 5432), PG_USER (postgres), PG_PASSWORD, PG_DATABASE.
 * Uso: node test/e2e-postgres.js
 * ------------------------------------------------------------------------- */

const { io } = require('socket.io-client');
const { startTestServer } = require('./e2e-harness');

const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.PG_PORT, 10) || 5432;
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'postgres';

// Due schemi con la STESSA tabella: è la configurazione che faceva sbagliare
// bersaglio a ogni operazione.
const SCHEMA_A = 'codedb_e2e_a';
const SCHEMA_B = 'codedb_e2e_b';
const TABLE = 'ordini';

let socket = null;
let testServer = null;

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

async function withAdmin(fn) {
  const pg = require('pg');
  const client = new pg.Client({
    host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD,
    database: PG_DATABASE, connectionTimeoutMillis: 6000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function seed() {
  await withAdmin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS ${JSON.stringify(SCHEMA_A).replace(/"/g, '"')} CASCADE`);
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA_B}" CASCADE`);
    await c.query(`CREATE SCHEMA "${SCHEMA_A}"`);
    await c.query(`CREATE SCHEMA "${SCHEMA_B}"`);
    // Stessa tabella, colonne e chiavi DIVERSE: se un'operazione sbaglia schema
    // il test se ne accorge dai dati, non solo dai nomi.
    await c.query(`CREATE TABLE "${SCHEMA_A}"."${TABLE}" (id SERIAL PRIMARY KEY, cliente TEXT, totale INT)`);
    await c.query(`CREATE TABLE "${SCHEMA_B}"."${TABLE}" (id SERIAL PRIMARY KEY, cliente TEXT, totale INT)`);
    await c.query(`INSERT INTO "${SCHEMA_A}"."${TABLE}" (cliente, totale) VALUES ('A-uno', 10), ('A-due', 20)`);
    await c.query(`INSERT INTO "${SCHEMA_B}"."${TABLE}" (cliente, totale) VALUES ('B-uno', 100)`);
    // Tabella presente solo in B: serve a verificare che listCollections filtri.
    await c.query(`CREATE TABLE "${SCHEMA_B}".solo_b (id SERIAL PRIMARY KEY)`);
    // Chiave esterna che ATTRAVERSA gli schemi. Nella UI il "database" è lo
    // schema, quindi questa è a tutti gli effetti una FK verso un altro
    // database: è il caso in cui è facile assumere lo schema di partenza e
    // finire a interrogare la tabella omonima sbagliata — che qui esiste
    // davvero in entrambi gli schemi, apposta.
    await c.query(`CREATE TABLE "${SCHEMA_A}".righe (
      id SERIAL PRIMARY KEY,
      ordine_b_id INT REFERENCES "${SCHEMA_B}"."${TABLE}"(id),
      nota TEXT
    )`);
    await c.query(`INSERT INTO "${SCHEMA_A}".righe (ordine_b_id, nota)
                   SELECT id, 'riga uno' FROM "${SCHEMA_B}"."${TABLE}" WHERE cliente = 'B-uno'`);
  });
}

async function cleanup() {
  await withAdmin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA_A}" CASCADE`);
    await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA_B}" CASCADE`);
    await c.query('DROP SCHEMA IF EXISTS codedb_e2e_nuovo CASCADE');
    await c.query('DROP SCHEMA IF EXISTS codedb_e2e_rinominato CASCADE');
  }).catch(() => {});
}

async function rowsOf(schema) {
  return withAdmin((c) =>
    c.query(`SELECT cliente, totale FROM "${schema}"."${TABLE}" ORDER BY id`).then((r) => r.rows)
  );
}

async function runTests() {
  console.log('1. connessione');
  const conn = await emit('mongo:connect', {
    dbType: 'postgresql', host: PG_HOST, port: PG_PORT,
    username: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
  });
  assert(conn.ok && conn.dbType === 'postgresql', `connessione riuscita (${conn.ok ? conn.databases.length + ' schemi' : conn.error})`);
  if (!conn.ok) return;

  console.log('2. db:list = schemi del database connesso');
  const dbs = await emit('db:list', {});
  const names = dbs.ok ? dbs.databases.map((d) => d.name) : [];
  assert(dbs.ok && names.includes(SCHEMA_A) && names.includes(SCHEMA_B), 'gli schemi di prova compaiono nell\'elenco');
  assert(!names.includes('pg_catalog') && !names.includes('information_schema'), 'gli schemi di sistema restano nascosti');
  assert(!names.includes('template0') && !names.includes('template1'), 'non vengono più elencati i database del cluster');

  console.log('3. db:collections filtrata per schema');
  const collA = await emit('db:collections', { db: SCHEMA_A });
  const collB = await emit('db:collections', { db: SCHEMA_B });
  const nA = collA.ok ? collA.collections.map((c) => c.name) : [];
  const nB = collB.ok ? collB.collections.map((c) => c.name) : [];
  assert(collA.ok && nA.slice().sort().join(',') === [TABLE, 'righe'].sort().join(','),
    `schema A mostra esattamente le sue tabelle (${nA.join(', ')})`);
  assert(collB.ok && nB.slice().sort().join(',') === [TABLE, 'solo_b'].sort().join(','),
    `schema B mostra esattamente le sue tabelle (${nB.join(', ')})`);
  // Le tabelle omonime in schemi diversi non devono comparire più volte: il
  // join su pg_class deve passare per pg_namespace, non solo per il nome.
  assert(new Set(nA).size === nA.length && new Set(nB).size === nB.length, 'nessuna tabella duplicata nell\'elenco');

  console.log('4. lettura: ogni schema restituisce le PROPRIE righe');
  const findA = await emit('collection:find', { db: SCHEMA_A, coll: TABLE, filter: '', limit: 50, skip: 0 });
  const findB = await emit('collection:find', { db: SCHEMA_B, coll: TABLE, filter: '', limit: 50, skip: 0 });
  assert(findA.ok && findA.docs.length === 2 && findA.docs.every((d) => String(d.cliente).startsWith('A-')),
    `schema A: 2 righe proprie (${findA.ok ? findA.docs.map((d) => d.cliente).join(', ') : findA.error})`);
  assert(findB.ok && findB.docs.length === 1 && findB.docs[0].cliente === 'B-uno',
    `schema B: 1 riga propria (${findB.ok ? findB.docs.map((d) => d.cliente).join(', ') : findB.error})`);

  console.log('5. conteggio per schema');
  const cntA = await emit('collection:count', { db: SCHEMA_A, coll: TABLE, filter: '' });
  const cntB = await emit('collection:count', { db: SCHEMA_B, coll: TABLE, filter: '' });
  assert(cntA.ok && cntA.total === 2, `conteggio schema A = 2 (${cntA.ok ? cntA.total : cntA.error})`);
  assert(cntB.ok && cntB.total === 1, `conteggio schema B = 1 (${cntB.ok ? cntB.total : cntB.error})`);

  console.log('6. scrittura: l\'inserimento non deve finire nell\'altro schema');
  const ins = await emit('doc:insert', { db: SCHEMA_A, coll: TABLE, doc: JSON.stringify({ cliente: 'A-tre', totale: 30 }) });
  assert(ins.ok, `inserimento in A riuscito (${ins.ok ? 'ok' : ins.error})`);
  assert((await rowsOf(SCHEMA_A)).length === 3, 'la riga è finita nello schema A');
  assert((await rowsOf(SCHEMA_B)).length === 1, 'lo schema B è rimasto intatto');

  console.log('7. aggiornamento: _id virtuale dalla PK dello schema giusto');
  const row = findA.docs.find((d) => d.cliente === 'A-uno');
  const upd = await emit('doc:update', { db: SCHEMA_A, coll: TABLE, id: JSON.stringify(row._id), set: { totale: 999 } });
  assert(upd.ok, `aggiornamento riuscito (${upd.ok ? 'ok' : upd.error})`);
  const afterA = await rowsOf(SCHEMA_A);
  const afterB = await rowsOf(SCHEMA_B);
  assert(afterA.some((r) => r.cliente === 'A-uno' && r.totale === 999), 'la modifica ha colpito la riga giusta in A');
  assert(afterB.every((r) => r.totale === 100), 'nessuna riga di B è stata toccata');

  console.log('8. eliminazione mirata');
  const findA2 = await emit('collection:find', { db: SCHEMA_A, coll: TABLE, filter: "cliente = 'A-tre'", limit: 50, skip: 0 });
  assert(findA2.ok && findA2.docs.length === 1, 'filtro WHERE libero applicato allo schema giusto');
  const del = await emit('doc:delete', { db: SCHEMA_A, coll: TABLE, id: JSON.stringify(findA2.docs[0]._id) });
  assert(del.ok, `eliminazione riuscita (${del.ok ? 'ok' : del.error})`);
  assert((await rowsOf(SCHEMA_A)).length === 2 && (await rowsOf(SCHEMA_B)).length === 1, 'eliminata la riga giusta, B intatto');

  console.log('9. statistiche, schema e indici per schema');
  const stats = await emit('collection:stats', { db: SCHEMA_B, coll: TABLE });
  assert(stats.ok && stats.stats.count === 1, `statistiche dello schema B (count=${stats.ok ? stats.stats.count : stats.error})`);
  assert(stats.ok && stats.fields.some((f) => f.name === 'cliente'), 'colonne lette dallo schema giusto');
  const schema = await emit('db:schema', { db: SCHEMA_B });
  const schemaColls = schema.ok ? schema.collections.map((c) => c.name).sort() : [];
  assert(schema.ok && schemaColls.join(',') === ['solo_b', TABLE].sort().join(','),
    `db:schema limitato allo schema B (${schemaColls.join(', ')})`);

  console.log('9-bis. collection:relations + relation:rows attraverso gli schemi (pannello 🔗)');
  const rel = await emit('collection:relations', { db: SCHEMA_A, coll: 'righe' });
  const fkDesc = rel.ok && rel.relazioni.find((r) => r.campo === 'ordine_b_id');
  assert(fkDesc, `FK di "righe" rilevata (${rel.ok ? JSON.stringify(rel.relazioni) : rel.error})`);
  // Il punto del test: il bersaglio è nello schema B, non in quello aperto.
  // Le due tabelle sono OMONIME, quindi un descrittore che dimentica lo schema
  // sembrerebbe corretto e porterebbe a leggere le righe sbagliate.
  assert(fkDesc && fkDesc.db === SCHEMA_B && fkDesc.tabella === TABLE && fkDesc.colonna === 'id',
    `bersaglio qualificato con lo schema giusto (${JSON.stringify(fkDesc)})`);
  assert(fkDesc && fkDesc.origine === 'vincolo', 'vincolo dichiarato, non ipotesi');

  // Riga riferita letta DALLO SCHEMA B: 'B-uno', non 'A-uno'.
  const righeA = await emit('collection:find', { db: SCHEMA_A, coll: 'righe', filter: '', limit: 50, skip: 0 });
  const valore = righeA.ok && righeA.docs[0] && righeA.docs[0].ordine_b_id;
  const rigaRif = await emit('relation:rows', { db: fkDesc.db, coll: fkDesc.tabella, colonna: fkDesc.colonna, valore, limit: 1 });
  assert(rigaRif.ok && rigaRif.righe.length === 1 && rigaRif.righe[0].cliente === 'B-uno',
    `riga riferita presa dallo schema B (${rigaRif.ok ? JSON.stringify(rigaRif.righe[0] && rigaRif.righe[0].cliente) : rigaRif.error})`);

  // La ricerca resta confinata allo schema indicato: 'A-uno' esiste, ma in A.
  const cercaB = await emit('relation:rows', { db: SCHEMA_B, coll: TABLE, colonna: 'id', cerca: 'A-uno', limit: 50 });
  assert(cercaB.ok && cercaB.righe.length === 0, 'la ricerca non sconfina nell\'altro schema');
  const cercaOk = await emit('relation:rows', { db: SCHEMA_B, coll: TABLE, colonna: 'id', cerca: 'B-uno', limit: 50 });
  assert(cercaOk.ok && cercaOk.righe.length === 1, `ricerca testuale in B (${cercaOk.ok ? cercaOk.righe.length : cercaOk.error})`);

  // Colonna inventata: rifiutata prima di finire quotata nella query.
  const finta = await emit('relation:rows', { db: SCHEMA_B, coll: TABLE, colonna: 'non_esiste', valore: 1 });
  assert(!finta.ok && /non esiste/i.test(finta.error), 'colonna inesistente rifiutata');

  console.log('10. SQL Raw: i nomi non qualificati si risolvono nello schema aperto');
  const raw = await emit('collection:aggregate', { db: SCHEMA_B, coll: TABLE, pipeline: `SELECT cliente FROM ${TABLE}` });
  assert(raw.ok && raw.docs.length === 1 && raw.docs[0].cliente === 'B-uno',
    `SELECT non qualificata risolta in B (${raw.ok ? raw.docs.map((d) => d.cliente).join(', ') : raw.error})`);

  console.log('11. DDL sul livello "database" = schema');
  const created = await emit('db:create', { db: 'codedb_e2e_nuovo', coll: 'prima_tabella' });
  assert(created.ok, `creazione schema riuscita (${created.ok ? 'ok' : created.error})`);
  const listAfter = await emit('db:list', {});
  assert(listAfter.ok && listAfter.databases.some((d) => d.name === 'codedb_e2e_nuovo'), 'il nuovo schema compare nell\'elenco');
  const collNew = await emit('db:collections', { db: 'codedb_e2e_nuovo' });
  assert(collNew.ok && collNew.collections.some((c) => c.name === 'prima_tabella'),
    'la prima tabella è stata creata NELLO schema nuovo (prima finiva in un database irraggiungibile)');
  const renamed = await emit('db:rename', { db: 'codedb_e2e_nuovo', newName: 'codedb_e2e_rinominato' });
  assert(renamed.ok, `rinomina schema riuscita (${renamed.ok ? 'ok' : renamed.error})`);
  const dropped = await emit('db:drop', { db: 'codedb_e2e_rinominato' });
  assert(dropped.ok, `eliminazione schema riuscita (${dropped.ok ? 'ok' : dropped.error})`);
  const sysDrop = await emit('db:drop', { db: 'information_schema' });
  assert(!sysDrop.ok, 'eliminazione di uno schema di sistema rifiutata');

  console.log('12. nomi pericolosi rifiutati alla creazione (CDB-57)');
  const evil = await emit('db:create', { db: '<img src=x onerror=alert(1)>' });
  assert(!evil.ok, `nome con markup rifiutato (${evil.ok ? 'AMMESSO!' : 'ok'})`);

  console.log(process.exitCode ? '\nTEST POSTGRESQL FALLITI' : '\nTUTTI I TEST POSTGRESQL SUPERATI');
}

(async () => {
  await seed();
  testServer = await startTestServer({ port: parseInt(process.env.E2E_PORT, 10) || 3148 });
  socket = io(testServer.url);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  try {
    await runTests();
  } finally {
    socket.close();
    await testServer.stop();
    await cleanup();
  }
})().catch(async (err) => {
  console.error('Errore inatteso:', (err && err.message) || err);
  process.exitCode = 1;
  if (socket) socket.close();
  if (testServer) await testServer.stop();
  await cleanup();
});

setTimeout(() => {
  console.error('Timeout: il server non risponde.');
  process.exit(1);
}, 90000).unref();
