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
const { startTestServer, createE2eTargetRegistry } = require('./e2e-harness');

const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.PG_PORT, 10) || 5432;
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'postgres';

// Due schemi con la STESSA tabella: è la configurazione che faceva sbagliare
// bersaglio a ogni operazione.
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_pg' });
const SCHEMA_A = targets.target('a');
const SCHEMA_B = targets.target('b');
const SCHEMA_NEW = targets.target('nuovo');
const SCHEMA_RENAMED = targets.target('rinominato');
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
    await targets.drop(SCHEMA_A, (name) => c.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
    await targets.drop(SCHEMA_B, (name) => c.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
    await c.query(`CREATE SCHEMA "${SCHEMA_A}"`);
    await c.query(`CREATE SCHEMA "${SCHEMA_B}"`);
    // Stessa tabella, colonne e chiavi DIVERSE: se un'operazione sbaglia schema
    // il test se ne accorge dai dati, non solo dai nomi.
    await c.query(`CREATE TABLE "${SCHEMA_A}"."${TABLE}" (id SERIAL PRIMARY KEY, cliente TEXT, totale INT, label TEXT, meta JSONB)`);
    await c.query(`CREATE TABLE "${SCHEMA_B}"."${TABLE}" (id SERIAL PRIMARY KEY, cliente TEXT, totale INT, label TEXT, meta JSONB)`);
    await c.query(`INSERT INTO "${SCHEMA_A}"."${TABLE}" (cliente, totale, label, meta) VALUES
      ('A-uno', 10, 'Responsabile', '{"gruppi":[{"label":"Membro"}]}'),
      ('A-due', 20, NULL, NULL)`);
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
    // FK composita: l'ordine del vincolo non coincide con l'ordine fisico
    // delle colonne, e i nomi locali sono diversi da quelli referenziati.
    await c.query(`CREATE TABLE "${SCHEMA_B}".destinazioni_composte (
      codice TEXT,
      versione INT,
      descrizione TEXT,
      PRIMARY KEY (versione, codice)
    )`);
    await c.query(`INSERT INTO "${SCHEMA_B}".destinazioni_composte VALUES
      ('X', 1, 'prima'), ('Y', 2, 'seconda')`);
    await c.query(`CREATE TABLE "${SCHEMA_A}".righe_composite (
      id SERIAL PRIMARY KEY,
      codice_esterno TEXT,
      versione_esterna INT,
      CONSTRAINT fk_destinazione_composta
        FOREIGN KEY (versione_esterna, codice_esterno)
        REFERENCES "${SCHEMA_B}".destinazioni_composte (versione, codice)
    )`);
    await c.query(`INSERT INTO "${SCHEMA_A}".righe_composite (codice_esterno, versione_esterna)
                   VALUES ('X', 1)`);
  });
}

async function cleanup() {
  await withAdmin(async (c) => {
    await targets.cleanup((name) => c.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
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
  assert(collA.ok && nA.slice().sort().join(',') === [TABLE, 'righe', 'righe_composite'].sort().join(','),
    `schema A mostra esattamente le sue tabelle (${nA.join(', ')})`);
  assert(collB.ok && nB.slice().sort().join(',') === [TABLE, 'solo_b', 'destinazioni_composte'].sort().join(','),
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

  const globaleLabel = await emit('collection:find', {
    db: SCHEMA_A, coll: TABLE,
    cercaOvunque: { operatore: 'contieneOvunque', valore: 'RESPONSABILE' },
    limit: 50, skip: 0,
  });
  assert(globaleLabel.ok && globaleLabel.docs.length === 1 && globaleLabel.docs[0].cliente === 'A-uno',
    `ricerca globale case-insensitive sulle colonne (${globaleLabel.ok ? globaleLabel.docs.length : globaleLabel.error})`);
  const globaleJson = await emit('collection:find', {
    db: SCHEMA_A, coll: TABLE,
    cercaOvunque: { operatore: 'contieneOvunque', valore: 'mEmBrO' },
    limit: 50, skip: 0,
  });
  assert(globaleJson.ok && globaleJson.docs.length === 1 && globaleJson.docs[0].cliente === 'A-uno',
    `ricerca globale nei valori JSON annidati (${globaleJson.ok ? globaleJson.docs.length : globaleJson.error})`);

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

  console.log('9-bis. collection:relations + filtro strutturato attraverso gli schemi (pannello 🔗)');
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
  // Il pannello 🔗 non ha più un evento proprio: chiede `collection:find` con un
  // filtro STRUTTURATO, che è la stessa via della griglia (ticket 22-24).
  const conFiltro = (db, coll, condizioni, limit = 50) =>
    emit('collection:find', { db, coll, filtro: { condizioni }, limit, skip: 0 });

  const rigaRif = await conFiltro(fkDesc.db, fkDesc.tabella,
    [{ campo: fkDesc.colonna, operatore: 'uguale', valore }], 1);
  assert(rigaRif.ok && rigaRif.docs.length === 1 && rigaRif.docs[0].cliente === 'B-uno',
    `riga riferita presa dallo schema B (${rigaRif.ok ? JSON.stringify(rigaRif.docs[0] && rigaRif.docs[0].cliente) : rigaRif.error})`);

  // La ricerca resta confinata allo schema indicato: 'A-uno' esiste, ma in A.
  const cercaB = await conFiltro(SCHEMA_B, TABLE, [{ campo: 'cliente', operatore: 'contiene', valore: 'A-uno' }]);
  assert(cercaB.ok && cercaB.docs.length === 0, 'la ricerca non sconfina nell\'altro schema');
  const cercaOk = await conFiltro(SCHEMA_B, TABLE, [{ campo: 'cliente', operatore: 'contiene', valore: 'B-uno' }]);
  assert(cercaOk.ok && cercaOk.docs.length === 1, `ricerca testuale in B (${cercaOk.ok ? cercaOk.docs.length : cercaOk.error})`);

  // Colonna inventata: l'errore arriva dal motore, e dice che non esiste.
  const finta = await conFiltro(SCHEMA_B, TABLE, [{ campo: 'non_esiste', operatore: 'uguale', valore: 1 }]);
  assert(!finta.ok && /non esist|does not exist/i.test(finta.error),
    `colonna inesistente rifiutata (${finta.error})`);

  // Un nome di campo che su MongoDB sarebbe un OPERATORE è rifiutato prima di
  // toccare il database, su qualunque motore.
  const operatore = await conFiltro(SCHEMA_B, TABLE, [{ campo: '$where', operatore: 'uguale', valore: 1 }]);
  assert(!operatore.ok && /nome di campo non valido/i.test(operatore.error),
    `un campo con prefisso $ è rifiutato (${operatore.error})`);

  console.log('9-bis-b. FK composita: ordinali, nomi differenti e modifica unica');
  const composite = await emit('collection:relations', { db: SCHEMA_A, coll: 'righe_composite' });
  const vincoloComposito = composite.ok && composite.relazioni.find((r) => r.nome === 'fk_destinazione_composta');
  assert(vincoloComposito && vincoloComposito.db === SCHEMA_B
      && vincoloComposito.tabella === 'destinazioni_composte',
  `FK composita qualificata (${composite.ok ? JSON.stringify(vincoloComposito) : composite.error})`);
  assert(vincoloComposito && JSON.stringify(vincoloComposito.coppie) === JSON.stringify([
    { campo: 'versione_esterna', colonna: 'versione', ordine: 1 },
    { campo: 'codice_esterno', colonna: 'codice', ordine: 2 },
  ]), `coppie conservate nello stesso vincolo e nello stesso ordinale (${JSON.stringify(vincoloComposito && vincoloComposito.coppie)})`);
  const candidate = await conFiltro(SCHEMA_B, 'destinazioni_composte', [
    { campo: 'versione', operatore: 'uguale', valore: 2 },
    { campo: 'codice', operatore: 'uguale', valore: 'Y' },
  ], 1);
  assert(candidate.ok && candidate.docs.length === 1 && candidate.docs[0].descrizione === 'seconda',
    'la selezione composita usa tutte le componenti');
  const localComposite = await emit('collection:find', {
    db: SCHEMA_A, coll: 'righe_composite', filter: '', limit: 10, skip: 0,
  });
  const updateComposite = await emit('doc:update', {
    db: SCHEMA_A, coll: 'righe_composite', id: JSON.stringify(localComposite.docs[0]._id),
    set: { versione_esterna: 2, codice_esterno: 'Y' },
  });
  assert(updateComposite.ok, `aggiornamento delle due componenti in una sola mutazione (${updateComposite.ok ? 'ok' : updateComposite.error})`);
  const changedComposite = await emit('collection:find', {
    db: SCHEMA_A, coll: 'righe_composite', filter: '', limit: 10, skip: 0,
  });
  assert(changedComposite.ok && changedComposite.docs[0].versione_esterna === 2
      && changedComposite.docs[0].codice_esterno === 'Y',
  'la FK composita non resta in uno stato aggiornato a metà');

  console.log('9-ter. doc:duplicate (chiavi rifatte, schema rispettato)');
  // La tabella di prova nasce nello schema A, ma il duplicato piu' insidioso e'
  // quello di "ordini": esiste in ENTRAMBI gli schemi, quindi una duplicazione
  // che perde lo schema scrive nella tabella sbagliata senza dare errore.
  await withAdmin((c) => c.query(`CREATE TABLE "${SCHEMA_A}".dup_test (
    id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    codice TEXT UNIQUE,
    nome TEXT NOT NULL,
    nome_upper TEXT GENERATED ALWAYS AS (upper(nome)) STORED
  )`));
  await withAdmin((c) => c.query(
    `INSERT INTO "${SCHEMA_A}".dup_test (email, codice, nome) VALUES ('ada@x.it', 'A1', 'Ada')`
  ));
  const dupOrig = await emit('collection:find', { db: SCHEMA_A, coll: 'dup_test', filter: '', limit: 10, skip: 0 });
  const dupRiga = dupOrig.ok && dupOrig.docs[0];

  const dupSenza = await emit('doc:duplicate', {
    db: SCHEMA_A, coll: 'dup_test', doc: JSON.stringify(dupRiga), conChiavi: false,
  });
  assert(dupSenza.ok, `duplicato senza chiavi inserito (${dupSenza.ok ? 'ok' : dupSenza.error})`);
  const dupDopo = await withAdmin((c) =>
    c.query(`SELECT id, email, codice, nome, nome_upper FROM "${SCHEMA_A}".dup_test ORDER BY id`).then((r) => r.rows));
  assert(dupDopo.length === 2, `due righe dopo il duplicato (${dupDopo.length})`);
  assert(dupDopo[1] && dupDopo[1].id !== dupDopo[0].id, 'identity: chiave primaria nuova');
  assert(dupDopo[1] && dupDopo[1].email !== dupDopo[0].email, `email unica ricalcolata (${dupDopo[1] && dupDopo[1].email})`);
  assert(dupDopo[1] && dupDopo[1].codice === null, 'colonna unica annullabile azzerata');
  assert(dupDopo[1] && dupDopo[1].nome_upper === 'ADA', 'colonna GENERATED ALWAYS rifatta dal database');

  // Con chiavi: l'email unica resta, quindi PostgreSQL rifiuta - risposta
  // corretta e parlante, non un difetto della duplicazione.
  const dupCon = await emit('doc:duplicate', {
    db: SCHEMA_A, coll: 'dup_test', doc: JSON.stringify(dupRiga), conChiavi: true,
  });
  assert(!dupCon.ok && /duplicat/i.test(dupCon.error || ''),
    `con chiavi su una unica collidente: errore parlante (${dupCon.ok ? 'inserito!' : dupCon.error})`);

  // Tabella omonima nei due schemi: il duplicato di una riga di B deve restare
  // in B. L'`_id` virtuale della griglia (la PK impacchettata) non e' una
  // colonna e non deve mai finire nell'INSERT.
  const rigaB = await emit('collection:find', { db: SCHEMA_B, coll: TABLE, filter: '', limit: 10, skip: 0 });
  const primaA = (await rowsOf(SCHEMA_A)).length;
  const dupB = await emit('doc:duplicate', {
    db: SCHEMA_B, coll: TABLE, doc: JSON.stringify(rigaB.docs[0]), conChiavi: true,
  });
  assert(dupB.ok, `riga di B duplicata (${dupB.ok ? 'ok' : dupB.error})`);
  const dopoB = await rowsOf(SCHEMA_B);
  const dopoA = await rowsOf(SCHEMA_A);
  assert(dopoB.length === 2 && dopoB[1].cliente === 'B-uno', `il duplicato e' nello schema B (${dopoB.map((r) => r.cliente).join(', ')})`);
  assert(dopoA.length === primaA, 'lo schema A non e\' stato toccato');
  // Ripulisce: le sezioni successive contano le righe di B.
  await withAdmin((c) => c.query(`DELETE FROM "${SCHEMA_B}"."${TABLE}" WHERE id = (SELECT MAX(id) FROM "${SCHEMA_B}"."${TABLE}")`));

  // Anteprima: calcola e non scrive.
  const anteprima = await emit('doc:duplicate', {
    db: SCHEMA_A, coll: 'dup_test', doc: JSON.stringify(dupRiga), conChiavi: false, soloAnteprima: true,
  });
  const conteggio = await withAdmin((c) =>
    c.query(`SELECT COUNT(*)::int AS n FROM "${SCHEMA_A}".dup_test`).then((r) => r.rows[0].n));
  assert(anteprima.ok && !('id' in JSON.parse(anteprima.doc || '{}')) && !('_id' in JSON.parse(anteprima.doc || '{}')),
    'anteprima senza chiave primaria ne\' _id virtuale');
  assert(conteggio === 2, `l'anteprima non inserisce nulla (righe: ${conteggio})`);

  // Indici: le colonne vere, non il nome dell'indice (la vista Dettagli
  // mostrava "Chiavi: {dup_test_email_key: 1}", che non e' una chiave).
  const idx = await emit('collection:stats', { db: SCHEMA_A, coll: 'dup_test' });
  const unico = idx.ok && idx.indexes.find((i) => i.unique && Object.keys(i.key).includes('email'));
  assert(unico, `indice unico su "email" con la colonna vera (${idx.ok ? JSON.stringify(idx.indexes) : idx.error})`);

  console.log('10. SQL Raw: i nomi non qualificati si risolvono nello schema aperto');
  const raw = await emit('collection:aggregate', { db: SCHEMA_B, coll: TABLE, pipeline: `SELECT cliente FROM ${TABLE}` });
  assert(raw.ok && raw.docs.length === 1 && raw.docs[0].cliente === 'B-uno',
    `SELECT non qualificata risolta in B (${raw.ok ? raw.docs.map((d) => d.cliente).join(', ') : raw.error})`);

  console.log('11. DDL sul livello "database" = schema');
  const created = await emit('db:create', { db: SCHEMA_NEW, coll: 'prima_tabella' });
  assert(created.ok, `creazione schema riuscita (${created.ok ? 'ok' : created.error})`);
  const listAfter = await emit('db:list', {});
  assert(listAfter.ok && listAfter.databases.some((d) => d.name === SCHEMA_NEW), 'il nuovo schema compare nell\'elenco');
  const collNew = await emit('db:collections', { db: SCHEMA_NEW });
  assert(collNew.ok && collNew.collections.some((c) => c.name === 'prima_tabella'),
    'la prima tabella è stata creata NELLO schema nuovo (prima finiva in un database irraggiungibile)');
  const renamed = await emit('db:rename', { db: SCHEMA_NEW, newName: SCHEMA_RENAMED });
  assert(renamed.ok, `rinomina schema riuscita (${renamed.ok ? 'ok' : renamed.error})`);
  const dropped = await emit('db:drop', { db: SCHEMA_RENAMED });
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
