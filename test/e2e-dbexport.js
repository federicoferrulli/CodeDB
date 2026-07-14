'use strict';

// Test end-to-end dell'export/import di interi database a livello socket:
// esercita i mattoni usati dal frontend (collection:export format json,
// collection:ddl, collection:import, db:create) su MongoDB e — se
// MYSQL_PASSWORD è impostata o il root locale ha password vuota — su MySQL.
// Richiede il server già avviato su :3030 (env PORT) e i DB locali.
// Uso: node test/e2e-dbexport.js

const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3030;
const DB = 'gui_e2e_dbexport';
const DB2 = 'gui_e2e_dbexport_copy';
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';

const socket = io(`http://localhost:${PORT}`);

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

async function testMongo() {
  console.log('MongoDB (tab "m")');
  const conn = await emit('mongo:connect', { host: 'localhost', port: 27017, tabId: 'm' });
  assert(conn.ok, `connessione (${conn.ok ? 'ok' : conn.error})`);
  if (!conn.ok) return;
  const t = (p) => ({ ...p, tabId: 'm' });
  try {
    await emit('db:drop', t({ db: DB }));
    await emit('db:drop', t({ db: DB2 }));
    await emit('doc:insert', t({ db: DB, coll: 'c1', doc: '{"n": 1, "quando": {"$date": "2026-01-01T00:00:00Z"}}' }));
    await emit('doc:insert', t({ db: DB, coll: 'c1', doc: '{"n": 2}' }));
    await emit('index:create', t({ db: DB, coll: 'c1', fields: '{"n": 1}', unique: true, name: 'n_unico' }));

    // Export: ddl (null su Mongo), indici da stats, docs a blocchi EJSON.
    const ddl = await emit('collection:ddl', t({ db: DB, coll: 'c1' }));
    assert(ddl.ok && ddl.ddl === null, 'collection:ddl → null su MongoDB');
    const stats = await emit('collection:stats', t({ db: DB, coll: 'c1' }));
    assert(stats.ok && stats.indexes.some((i) => i.name === 'n_unico'), 'indici presenti in collection:stats');
    const exp = await emit('collection:export', t({ db: DB, coll: 'c1', format: 'json', skip: 0, limit: 500 }));
    assert(exp.ok && exp.count === 2, `export json (${exp.ok ? exp.count : exp.error} documenti)`);

    // Import nel database di destinazione + ricreazione indice.
    const imp = await emit('collection:import', t({ db: DB2, coll: 'c1', docs: exp.lines.map((l) => JSON.parse(l)) }));
    assert(imp.ok && imp.inserted === 2, `import (${imp.ok ? imp.inserted : imp.error} documenti)`);
    const idx = await emit('index:create', t({ db: DB2, coll: 'c1', fields: '{"n": 1}', unique: true, name: 'n_unico' }));
    assert(idx.ok, 'indice ricreato nella destinazione');
    const chk = await emit('collection:find', t({ db: DB2, coll: 'c1', filter: '{"n": 1}' }));
    assert(chk.ok && chk.docs[0].quando && chk.docs[0].quando.$date, 'tipi EJSON preservati dopo il roundtrip');
  } finally {
    await emit('db:drop', t({ db: DB }));
    await emit('db:drop', t({ db: DB2 }));
    await emit('mongo:disconnect', { tabId: 'm' });
  }
}

async function testMySql() {
  console.log('MySQL (tab "s")');
  const conn = await emit('mongo:connect', {
    dbType: 'mysql', host: 'localhost', port: MYSQL_PORT, username: 'root', password: MYSQL_PASSWORD, tabId: 's',
  });
  if (!conn.ok) {
    console.log(`  SKIP MySQL non raggiungibile (${conn.error})`);
    return;
  }
  const t = (p) => ({ ...p, tabId: 's' });
  try {
    await emit('db:drop', t({ db: DB }));
    await emit('db:drop', t({ db: DB2 }));
    await emit('db:create', t({ db: DB }));
    await emit('collection:aggregate', t({ db: DB, coll: 'x', pipeline: `CREATE TABLE ${DB}.t1 (id INT PRIMARY KEY, nome VARCHAR(20))` }));
    await emit('collection:aggregate', t({ db: DB, coll: 'x', pipeline: `INSERT INTO ${DB}.t1 VALUES (1,'a'),(2,'b')` }));

    const ddl = await emit('collection:ddl', t({ db: DB, coll: 't1' }));
    assert(ddl.ok && /CREATE TABLE/.test(ddl.ddl), 'collection:ddl → CREATE TABLE');
    const exp = await emit('collection:export', t({ db: DB, coll: 't1', format: 'json', skip: 0, limit: 500 }));
    assert(exp.ok && exp.count === 2, `export json (${exp.ok ? exp.count : exp.error} righe)`);

    // Import: crea lo schema di destinazione, esegue il DDL, invia le righe.
    await emit('db:create', t({ db: DB2 }));
    const mkTable = await emit('collection:aggregate', t({ db: DB2, coll: 't1', pipeline: ddl.ddl }));
    assert(mkTable.ok, `DDL eseguito nella destinazione (${mkTable.ok ? 'ok' : mkTable.error})`);
    const imp = await emit('collection:import', t({ db: DB2, coll: 't1', docs: exp.lines.map((l) => JSON.parse(l)) }));
    assert(imp.ok && imp.inserted === 2, `import (${imp.ok ? imp.inserted : imp.error} righe)`);
  } finally {
    await emit('db:drop', t({ db: DB }));
    await emit('db:drop', t({ db: DB2 }));
    await emit('mongo:disconnect', { tabId: 's' });
  }
}

socket.on('connect', async () => {
  try {
    await testMongo();
    await testMySql();
    console.log(process.exitCode ? 'e2e-dbexport FALLITO' : 'e2e-dbexport: tutti i test superati.');
  } catch (err) {
    console.error('e2e-dbexport FALLITO:', err);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});

socket.on('connect_error', (err) => {
  console.error(`Server non raggiungibile su :${PORT} — avvialo con npm start. (${err.message})`);
  process.exitCode = 1;
  socket.close();
});
