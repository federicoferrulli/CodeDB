'use strict';

/* Laboratorio query/CRUD su TRE database reali obbligatori.
 * Avvio: CODEDB_E2E_DESTRUCTIVE=1 node test/lab/query.cjs
 * Sensibilità: aggiungere --sensitivity (tre processi server deliberatamente guasti).
 * Porte/password: LAB_MONGO_PORT, LAB_MYSQL_PORT/PASSWORD, LAB_PG_PORT/PASSWORD.
 * Solo bersagli casuali posseduti dalla fixture possono essere cancellati.
 * I driver indipendenti creano i dati e verificano gli effetti persistiti.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { io } = require('socket.io-client');
const { MongoClient } = require('mongodb');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const { startTestServer, createE2eTargetRegistry } = require('../e2e-harness');

const reportDir = path.resolve(process.env.LAB_REPORT_DIR || '.scratch/lab-reports');
const reportFile = path.join(reportDir, `query${process.env.LAB_QUERY_MUTANT ? `-${process.env.LAB_QUERY_MUTANT}` : ''}.json`);
const registry = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_lab_query' });
const db = registry.target('dati');
const tipi = ['mongodb', 'mysql', 'postgresql'];
const cfg = {
  mongodb: { dbType: 'mongodb', host: '127.0.0.1', port: Number(process.env.LAB_MONGO_PORT || 37017), directConnection: true },
  mysql: { dbType: 'mysql', host: '127.0.0.1', port: Number(process.env.LAB_MYSQL_PORT || 33306), username: 'root', password: process.env.LAB_MYSQL_PASSWORD ?? 'lab_mysql' },
  postgresql: { dbType: 'postgresql', host: '127.0.0.1', port: Number(process.env.LAB_PG_PORT || 35432), username: 'postgres', password: process.env.LAB_PG_PASSWORD ?? 'lab_postgres', database: 'postgres' },
};
let mongo, my, pg, server, socket;
const esiti = [], cleanupErrors = [];
const metriche = { nota: 'Misure locali con altri test/container potenzialmente attivi: soglie anti-blocco conservative, nessuna promessa SLA.', campioni: [] };
const ambiente = { node: process.version, piattaforma: process.platform, architettura: process.arch };
const started = new Date().toISOString();
const seed = Number(process.env.LAB_QUERY_SEED || 20102026) >>> 0;
let state = seed;
function random() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }
const fixture = Array.from({ length: 257 }, (_, id) => ({ id, g: ['a', 'b', 'c', 'd'][random() % 4], n: id % 11 === 0 ? null : random() % 201 - 100, testo: ['caffè ☕', "l'apostrofo", '日本語', '😀🚀', 'e\u0301', ''][id % 6] }));
const quota = (type, name) => type === 'mysql' ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"';
const tabella = (type, name) => `${quota(type, db)}.${quota(type, name)}`;
const raw = (event, payload) => new Promise((resolve, reject) => socket.timeout(25000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res)));
async function emit(event, payload) { const r = await raw(event, payload); assert.equal(r?.ok, true, `${event}: ${r?.error}`); return r; }
async function query(type, code, extra = {}) { return emit('query:execute', { tabId: type, engine: type, db, coll: 'campione', code, ...extra }); }
async function native(type, code, params = []) { return type === 'mysql' ? (await my.query(code, params))[0] : (await pg.query(code, params)).rows; }
async function prova(id, nome, fn) {
  if (process.env.LAB_QUERY_CASE && !id.includes(process.env.LAB_QUERY_CASE)) return;
  const t = performance.now();
  try { await fn(); esiti.push({ id, nome, ok: true, ms: Math.round(performance.now() - t) }); console.log(`OK ${id}: ${nome}`); }
  catch (err) { esiti.push({ id, nome, ok: false, ms: Math.round(performance.now() - t), errore: err.message, stack: err.stack }); console.error(`FAIL ${id}: ${nome}\n${err.stack}`); }
}

// Solo i risultati delle query aritmetiche su interi piccoli usano questa
// normalizzazione. I test di precisione NON convertono i numeri in Number.
function piccolo(value) {
  if (Array.isArray(value)) return value.map(piccolo);
  if (value && typeof value === 'object') {
    if ('$numberLong' in value || '$numberDecimal' in value) return Number(value.$numberLong ?? value.$numberDecimal);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, piccolo(v)]));
  }
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}
function valoreEsatto(value) {
  if (value && typeof value === 'object') return value.$numberLong ?? value.$numberDecimal ?? value.toString();
  return String(value);
}
function dataISO(value) { return new Date(value?.$date ?? value).toISOString(); }
function binario(value) {
  if (value?.$binary) return value.$binary.base64;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value?.buffer) return Buffer.from(value.buffer).toString('base64');
  assert(Array.isArray(value) || value instanceof Uint8Array, `Il binario non ha una rappresentazione tipizzata: ${JSON.stringify(value)}`);
  return Buffer.from(value).toString('base64');
}

async function prepara() {
  registry.assertOwned(db);
  mongo = new MongoClient(`mongodb://127.0.0.1:${cfg.mongodb.port}/?directConnection=true`, { serverSelectionTimeoutMS: 6000, promoteLongs: false });
  await mongo.connect();
  my = await mysql.createConnection({ host: cfg.mysql.host, port: cfg.mysql.port, user: cfg.mysql.username, password: cfg.mysql.password, supportBigNumbers: true, bigNumberStrings: true });
  pg = new Client({ host: cfg.postgresql.host, port: cfg.postgresql.port, user: cfg.postgresql.username, password: cfg.postgresql.password, database: 'postgres', connectionTimeoutMillis: 6000 });
  await pg.connect();
  ambiente.mongodb = (await mongo.db('admin').command({ buildInfo: 1 })).version;
  ambiente.mysql = (await my.query('SELECT VERSION() AS versione'))[0][0].versione;
  ambiente.postgresql = (await pg.query('SHOW server_version')).rows[0].server_version;
  await my.query(`CREATE DATABASE ${quota('mysql', db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await my.query(`USE ${quota('mysql', db)}`);
  await pg.query(`CREATE SCHEMA ${quota('postgresql', db)}`);
  await pg.query(`SET search_path TO ${quota('postgresql', db)}`);
  await mongo.db(db).collection('campione').insertMany(fixture.map(r => ({ ...r })));
  const duplicati = [{ id: 1, k: 'x' }, { id: 2, k: 'x' }, { id: 3, k: null }, { id: 4, k: "l'apostrofo" }, { id: 5, k: 'assente' }];
  const destra = [{ id: 10, k: 'x' }, { id: 11, k: 'x' }, { id: 12, k: null }, { id: 13, k: "l'apostrofo" }];
  for (const [nome, rows] of [['sinistra', duplicati], ['destra', destra]]) await mongo.db(db).collection(nome).insertMany(rows.map(r => ({ ...r })));
  for (const type of ['mysql', 'postgresql']) {
    await native(type, 'CREATE TABLE campione(id INT PRIMARY KEY,g VARCHAR(8),n INT,testo TEXT)');
    for (const r of fixture) await native(type, type === 'mysql' ? 'INSERT INTO campione VALUES(?,?,?,?)' : 'INSERT INTO campione VALUES($1,$2,$3,$4)', Object.values(r));
    for (const [nome, rows] of [['sinistra', duplicati], ['destra', destra]]) {
      await native(type, `CREATE TABLE ${nome}(id INT PRIMARY KEY,k VARCHAR(80))`);
      for (const r of rows) await native(type, type === 'mysql' ? `INSERT INTO ${nome} VALUES(?,?)` : `INSERT INTO ${nome} VALUES($1,$2)`, [r.id, r.k]);
    }
    await native(type, `CREATE TABLE ${quota(type, 'Ordini Strani')} (tenant VARCHAR(30), codice BIGINT, nota TEXT, totale DECIMAL(30,6), PRIMARY KEY(tenant,codice))`);
    await native(type, `CREATE TABLE ${quota(type, 'tipi')} (id INT PRIMARY KEY, grande BIGINT, decimale DECIMAL(30,6), testo TEXT, istante ${type === 'mysql' ? 'DATETIME(3)' : 'TIMESTAMPTZ(3)'}, dati ${type === 'mysql' ? 'VARBINARY(100)' : 'BYTEA'})`);
    await native(type, 'CREATE TABLE contatore(id INT PRIMARY KEY,n INT)');
    await native(type, 'INSERT INTO contatore VALUES(1,0)');
    const p = type === 'mysql' ? '(?,?,?,?)' : '($1,$2,$3,$4)';
    for (const tenant of ['a', 'b']) await native(type, `INSERT INTO ${quota(type, 'Ordini Strani')} VALUES${p}`, [tenant, '9007199254740993', `originale-${tenant}`, '123456789012345678.123456']);
  }
  await mongo.db(db).collection('contatore').insertOne({ _id: 1, n: 0 });
  const serverEnv = { CODEDB_MAX_RESULT_BYTES: '4194304' };
  if (process.env.LAB_QUERY_MUTANT) serverEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require="${path.join(__dirname, 'query-mutants.cjs').replaceAll('\\', '/')}"`;
  server = await startTestServer({ port: Number(process.env.E2E_PORT || 3191), env: serverEnv });
  socket = io(server.url, { reconnection: false, transports: ['websocket'] });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  for (const type of tipi) await emit('mongo:connect', { ...cfg[type], tabId: type });
}

async function proveQuery() {
  const sqls = [
    ['righe', 'SELECT id,g,n,testo FROM campione ORDER BY id'],
    ['null', 'SELECT id FROM campione WHERE n IS NULL ORDER BY id'],
    ['not-in-null', 'SELECT id FROM campione WHERE n NOT IN (1,2,NULL) ORDER BY id'],
    ['precedenza', 'SELECT id,n FROM campione WHERE (n BETWEEN -40 AND 25 OR n IS NULL) AND id>=11 ORDER BY id'],
    ['aggregati', 'SELECT g,COUNT(*) AS c,COUNT(n) AS cn,SUM(n) AS s,MIN(n) AS mi,MAX(n) AS ma FROM campione GROUP BY g ORDER BY g'],
    ['vuoto', 'SELECT COUNT(*) AS c,COUNT(n) AS cn,SUM(n) AS s,MIN(n) AS mi FROM campione WHERE id<0'],
    ['case', "SELECT id,CASE WHEN n IS NULL THEN 'vuoto' WHEN n<0 THEN 'negativo' ELSE 'positivo' END AS classe FROM campione ORDER BY id"],
    ['pagina', 'SELECT id,n FROM campione ORDER BY id DESC LIMIT 23 OFFSET 49'],
    ['distinct', 'SELECT DISTINCT g FROM campione ORDER BY g'],
    ['having', 'SELECT g,COUNT(*) AS c,SUM(n) AS s FROM campione GROUP BY g HAVING COUNT(*)>10 ORDER BY g'],
    ['finestra', 'SELECT id,SUM(COALESCE(n,0)) OVER(ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS s FROM campione ORDER BY id'],
    ['left-join', 'SELECT a.id AS l,b.id AS r FROM sinistra a LEFT JOIN destra b ON a.k=b.k ORDER BY a.id,b.id'],
    ['subquery', 'SELECT id FROM campione WHERE n IN(SELECT n FROM campione WHERE id<25) ORDER BY id'],
    ['union', 'SELECT id FROM campione WHERE id<8 UNION SELECT id FROM campione WHERE id BETWEEN 5 AND 12 ORDER BY id'],
  ];
  for (const [name, sql] of sqls) for (const type of tipi) await prova(`differenziale-${type}-${name}`, `Risultato completo confrontato con driver ${type === 'mongodb' ? 'PostgreSQL' : type}`, async () => {
    const expected = piccolo(await native(type === 'mysql' ? 'mysql' : 'postgresql', sql));
    const actual = piccolo((await query(type, sql)).data);
    assert.deepEqual(actual, expected, sql);
  });
  for (const type of tipi) await prova(`pagine-${type}`, '257 righe attraversano 9 pagine senza perdite, duplicati o conteggi errati', async () => {
    const ids = [];
    for (let skip = 0; skip < fixture.length; skip += 31) {
      const r = await emit('collection:find', { tabId: type, db, coll: 'campione', filter: '', sort: '{"id":1}', skip, limit: 31, deferCount: true });
      assert.equal(r.docs.length, Math.min(31, fixture.length - skip));
      ids.push(...r.docs.map(row => row.id));
    }
    assert.deepEqual(ids, fixture.map(r => r.id));
    // Un conteggio senza filtro può essere una stima dichiarata dal DBMS.
    // Il filtro vero su tutte le PK forza il percorso di conteggio esatto.
    const count = await emit('collection:count', { tabId: type, db, coll: 'campione', filter: type === 'mongodb' ? '{"id":{"$gte":0}}' : 'id >= 0' });
    assert.equal(count.approx, undefined); assert.equal(count.total, fixture.length);
  });
}

async function proveCrud() {
  for (const conValidator of [false, true]) await prova(`collection-create-mongodb-${conValidator ? 'validator' : 'semplice'}`,
    conValidator ? 'Creazione via socket conserva il validator e il database rifiuta documenti non validi' : 'Creazione collection via socket verificata nel catalogo MongoDB indipendente', async () => {
      const name = conValidator ? 'creata_socket_validator' : 'creata_socket_semplice';
      const options = conValidator ? {
        validator: { $jsonSchema: { bsonType: 'object', required: ['quantita'], properties: { quantita: { bsonType: 'int', minimum: 0 } } } },
        validationLevel: 'strict', validationAction: 'error',
      } : {};
      // Il controllo diretto verifica prima permessi e opzioni sullo stesso DB
      // posseduto: un rifiuto socket non può essere attribuito a queste precondizioni.
      const control = await mongo.db(db).createCollection(name + '_controllo', options);
      assert.equal((await mongo.db(db).listCollections({ name: control.collectionName }).toArray()).length, 1);
      if (conValidator) {
        await control.insertOne({ _id: 'valido', quantita: 7 });
        await assert.rejects(() => control.insertOne({ _id: 'invalido', quantita: 'sette' }), err => err.code === 121);
      }
      assert.equal((await mongo.db(db).listCollections({ name }).toArray()).length, 0);
      const response = await raw('collection:create', { tabId: 'mongodb', db, name, ...options });
      // Leggere sempre l'effetto persistito anche se il server risponde errore.
      const catalog = await mongo.db(db).listCollections({ name }).toArray();
      assert.equal(response?.ok, true, `collection:create: ${response?.error}; collection presente nel catalogo: ${catalog.length === 1}`);
      assert.equal(catalog.length, 1, 'Ack positivo senza collection persistita');
      const created = mongo.db(db).collection(name);
      if (conValidator) {
        assert.deepEqual(catalog[0].options.validator, options.validator);
        assert.equal(catalog[0].options.validationLevel, 'strict');
        assert.equal(catalog[0].options.validationAction, 'error');
        await assert.rejects(() => created.insertOne({ _id: 'invalido', quantita: 'sette' }), err => err.code === 121);
        await assert.rejects(() => created.insertOne({ _id: 'mancante', etichetta: 'senza quantita' }), err => err.code === 121);
      }
      const valid = { _id: 'valido', quantita: 7, etichetta: 'caffè 😀' };
      await created.insertOne(valid);
      assert.deepEqual(await created.find().toArray(), [valid]);
    });
  for (const type of tipi) await prova(`tipi-${type}`, 'Scrittura e lettura esatte: BIGINT, DECIMAL, UTF-8, data e binario', async () => {
    const document = { id: 1, grande: { $numberLong: '9007199254740993' }, decimale: { $numberDecimal: '123456789012345678.123456' }, testo: "日本語 😀 caffè e\u0301 ' \\ \n", istante: { $date: '2024-02-29T23:59:59.123Z' }, dati: { $binary: { base64: Buffer.from([0, 255, 128, 39, 92, 10]).toString('base64'), subType: '00' } } };
    await emit('doc:insert', { tabId: type, db, coll: 'tipi', doc: JSON.stringify(document) });
    const persisted = type === 'mongodb' ? await mongo.db(db).collection('tipi').findOne({ id: 1 }) : (await native(type, 'SELECT * FROM tipi WHERE id=1'))[0];
    assert.equal(valoreEsatto(persisted.grande), '9007199254740993');
    assert.equal(valoreEsatto(persisted.decimale), '123456789012345678.123456');
    assert.equal(persisted.testo, document.testo);
    assert.equal(dataISO(persisted.istante), document.istante.$date);
    assert.equal(binario(persisted.dati), document.dati.$binary.base64);
    const row = (await emit('collection:find', { tabId: type, db, coll: 'tipi', filter: '', limit: 10 })).docs[0];
    assert.equal(valoreEsatto(row.grande), '9007199254740993');
    assert.equal(valoreEsatto(row.decimale), '123456789012345678.123456');
    assert.equal(row.testo, document.testo);
    assert.equal(dataISO(row.istante), document.istante.$date);
    assert.equal(binario(row.dati), document.dati.$binary.base64);
  });
  for (const type of ['mysql', 'postgresql']) {
    await prova(`binario-volume-${type}`, 'Binari grandi, vuoti e NULL mantengono tipo, byte e budget del risultato', async () => {
      await native(type, `CREATE TABLE volume_binario(id INT PRIMARY KEY,dati ${type === 'mysql' ? 'LONGBLOB' : 'BYTEA'})`);
      const bytes = Buffer.alloc(512 * 1024, 0x80);
      const valori = [bytes, Buffer.alloc(0), null];
      for (let i = 0; i < valori.length; i++) await native(type,
        type === 'mysql' ? 'INSERT INTO volume_binario VALUES(?,?)' : 'INSERT INTO volume_binario VALUES($1,$2)', [i, valori[i]]);
      for (const risultato of [await query(type, 'SELECT id,dati FROM volume_binario ORDER BY id'),
        await emit('collection:find', { tabId: type, db, coll: 'volume_binario', sort: '{"id":1}', limit: 10 })]) {
        const rows = risultato.data || risultato.docs;
        assert.equal(rows.length, 3, 'Il budget deve misurare il binario EJSON, non enumerare i byte');
        assert.deepEqual(rows[0].dati, { $binary: { base64: bytes.toString('base64'), subType: '00' } });
        assert.deepEqual(rows[1].dati, { $binary: { base64: '', subType: '00' } });
        assert.equal(rows[2].dati, null);
      }
    });
    await prova(`binario-identita-reale-${type}`, 'PK composta con binario e colonna _id reale mantiene rowIds riutilizzabili', async () => {
      await native(type, `CREATE TABLE identita_binaria(k ${type === 'mysql' ? 'VARBINARY(16)' : 'BYTEA'},tenant INT,_id VARCHAR(20),n INT,PRIMARY KEY(k,tenant))`);
      const bytes = Buffer.from([0, 255, 128]);
      for (const tenant of [1, 2]) await native(type, type === 'mysql'
        ? 'INSERT INTO identita_binaria VALUES(?,?,?,?)' : 'INSERT INTO identita_binaria VALUES($1,$2,$3,$4)', [bytes, tenant, 'reale', 10]);
      const found = await emit('collection:find', { tabId: type, db, coll: 'identita_binaria', sort: '{"tenant":1}', limit: 10 });
      assert.equal(found.docs[0]._id, 'reale');
      assert.deepEqual(found.rowIds[0], { k: { $binary: { base64: bytes.toString('base64'), subType: '00' } }, tenant: 1 });
      const updated = await emit('doc:update', { tabId: type, db, coll: 'identita_binaria', id: JSON.stringify(found.rowIds[0]), set: { n: 20 } });
      assert.equal(updated.matched, 1);
      assert.deepEqual(await native(type, 'SELECT tenant,n FROM identita_binaria ORDER BY tenant'), [{ tenant: 1, n: 20 }, { tenant: 2, n: 10 }]);
    });
    await prova(`chiave-binaria-${type}`, 'Una PK binaria rimane utilizzabile per aggiornare esattamente la riga letta', async () => {
      await native(type, `CREATE TABLE chiavi_binarie(k ${type === 'mysql' ? 'VARBINARY(16)' : 'BYTEA'} PRIMARY KEY,n INT)`);
      const bytes = Buffer.from([0, 255, 128, 39, 92, 10]);
      await native(type, type === 'mysql' ? 'INSERT INTO chiavi_binarie VALUES(?,10)' : 'INSERT INTO chiavi_binarie VALUES($1,10)', [bytes]);
      const row = (await emit('collection:find', { tabId: type, db, coll: 'chiavi_binarie', filter: '', limit: 10 })).docs[0];
      const result = await emit('doc:update', { tabId: type, db, coll: 'chiavi_binarie', id: JSON.stringify(row._id), set: { n: 20 } });
      assert.equal(result.matched, 1, 'La PK restituita deve identificare la riga originale');
      const after = await native(type, 'SELECT k,n FROM chiavi_binarie');
      assert.equal(after.length, 1); assert.equal(after[0].n, 20); assert.equal(binario(after[0].k), bytes.toString('base64'));
      const trovato = await emit('collection:find', { tabId: type, db, coll: 'chiavi_binarie',
        filtro: { condizioni: [{ campo: 'k', operatore: 'uguale', valore: row.k }] }, limit: 10 });
      assert.equal(trovato.docs.length, 1, 'Il filtro strutturato conserva il parametro binario');
      assert.equal(trovato.docs[0].n, 20);
      await emit('doc:delete', { tabId: type, db, coll: 'chiavi_binarie', id: JSON.stringify(row._id) });
      assert.deepEqual(await native(type, 'SELECT k,n FROM chiavi_binarie'), [], 'La PK binaria elimina la sola riga selezionata');
    });
    if (type === 'postgresql') await prova('binario-inserted-id-postgresql', 'La chiave BYTEA restituita da INSERT è riutilizzabile per UPDATE', async () => {
      await native(type, 'CREATE TABLE inserita_binaria(k BYTEA PRIMARY KEY,n INT)');
      const k = { $binary: { base64: Buffer.from([0, 255, 1]).toString('base64'), subType: '00' } };
      const inserita = await emit('doc:insert', { tabId: type, db, coll: 'inserita_binaria', doc: JSON.stringify({ k, n: 10 }) });
      assert.deepEqual(JSON.parse(inserita.insertedId), { k }, 'INSERT deve restituire la PK in EJSON');
      const aggiornata = await emit('doc:update', { tabId: type, db, coll: 'inserita_binaria', id: inserita.insertedId, set: { n: 20 } });
      assert.equal(aggiornata.matched, 1);
      assert.equal((await native(type, 'SELECT n FROM inserita_binaria'))[0].n, 20);
    });
    await prova(`binario-roundtrip-${type}`, 'Riaprire e salvare una riga senza modifiche conserva tutti i byte SQL', async () => {
      const bytes = Buffer.from([0, 255, 128, 39, 92, 10]);
      await native(type, type === 'mysql' ? 'INSERT INTO tipi(id,dati) VALUES(2,?)' : 'INSERT INTO tipi(id,dati) VALUES(2,$1)', [bytes]);
      const row = (await emit('collection:find', { tabId: type, db, coll: 'tipi', filter: 'id=2', limit: 10 })).docs[0];
      await emit('doc:replace', { tabId: type, db, coll: 'tipi', id: JSON.stringify(row._id), doc: JSON.stringify(row) });
      const after = (await native(type, 'SELECT dati FROM tipi WHERE id=2'))[0].dati;
      assert.equal(binario(after), bytes.toString('base64'), `Byte dopo round-trip: ${Buffer.from(after).toString('hex')}`);
    });
    await prova(`binario-export-cursore-${type}`, 'Export CSV paginato su PK binaria attraversa tutte le righe senza perdite', async () => {
      await native(type, `CREATE TABLE export_binario(k ${type === 'mysql' ? 'VARBINARY(16)' : 'BYTEA'} PRIMARY KEY,n INT)`);
      const chiavi = [Buffer.from([0, 255]), Buffer.from([128, 0]), Buffer.from([255, 1])];
      for (let i = 0; i < chiavi.length; i++) await native(type,
        type === 'mysql' ? 'INSERT INTO export_binario VALUES(?,?)' : 'INSERT INTO export_binario VALUES($1,$2)', [chiavi[i], i]);
      let after;
      for (const bytes of chiavi) {
        const pagina = await emit('collection:export', { tabId: type, db, coll: 'export_binario', format: 'csv', limit: 1, after });
        assert.equal(pagina.lines.length, 1);
        const cursore = JSON.parse(pagina.nextAfter);
        assert.deepEqual(cursore, [{ $binary: { base64: bytes.toString('base64'), subType: '00' } }]);
        after = pagina.nextAfter;
      }
      const ultima = await emit('collection:export', { tabId: type, db, coll: 'export_binario', format: 'csv', limit: 1, after });
      assert.equal(ultima.lines.length, 0, 'Nessuna riga ripetuta oltre l’ultima chiave');
    });
    await prova(`crud-composito-${type}`, 'UPDATE con PK composta, BIGINT oltre 2^53 e identificatore con spazi modifica solo il bersaglio', async () => {
      const rows = (await emit('collection:find', { tabId: type, db, coll: 'Ordini Strani', filter: '', sort: '{"tenant":1}', limit: 10 })).docs;
      const row = rows.find(r => r.tenant === 'a');
      assert(row?._id, 'Chiave virtuale della riga assente');
      const r = await emit('doc:update', { tabId: type, db, coll: 'Ordini Strani', id: JSON.stringify(row._id), set: { nota: "modificato ' 😀", totale: { $numberDecimal: '123456789012345678.000001' } } });
      assert.equal(r.matched, 1);
      const after = await native(type, `SELECT * FROM ${quota(type, 'Ordini Strani')} ORDER BY tenant`);
      assert.equal(after[0].nota, "modificato ' 😀");
      assert.equal(valoreEsatto(after[0].totale), '123456789012345678.000001');
      assert.equal(after[1].nota, 'originale-b');
      assert.equal(after.length, 2);
    });
    await prova(`delete-composito-${type}`, 'DELETE con PK composta elimina una sola riga e conserva il tenant adiacente', async () => {
      const rows = (await emit('collection:find', { tabId: type, db, coll: 'Ordini Strani', filter: '', limit: 10 })).docs;
      const row = rows.find(r => r.tenant === 'b');
      await emit('doc:delete', { tabId: type, db, coll: 'Ordini Strani', id: JSON.stringify(row._id) });
      const after = await native(type, `SELECT * FROM ${quota(type, 'Ordini Strani')}`);
      assert.equal(after.length, 1); assert.equal(after[0].tenant, 'a');
    });
  }
  for (const type of tipi) await prova(`concorrenza-${type}`, '24 incrementi simultanei persistono tutti e ogni richiesta riceve la propria risposta', async () => {
    const results = await Promise.all(Array.from({ length: 24 }, () => query(type, type === 'mongodb' ? 'db.contatore.updateOne({_id:1},{$inc:{n:1}})' : 'UPDATE contatore SET n=n+1 WHERE id=1')));
    assert.equal(results.length, 24);
    const actual = type === 'mongodb' ? (await mongo.db(db).collection('contatore').findOne({ _id: 1 })).n : (await native(type, 'SELECT n FROM contatore WHERE id=1'))[0].n;
    assert.equal(actual, 24);
  });
  for (const modo of ['update', 'roundtrip']) await prova(`array-postgresql-${modo}`, `Array SQL con NULL, Unicode e delimitatori: ${modo} conserva il tipo nativo`, async () => {
    const name = `array_${modo}`;
    const original = { numeri: [1, null, 3], testi: ['日本語', 'a,b', '"citazione"', '\\'] };
    await native('postgresql', `CREATE TABLE ${name}(id INT PRIMARY KEY,numeri INT[],testi TEXT[])`);
    await native('postgresql', `INSERT INTO ${name} VALUES(1,$1,$2)`, [original.numeri, original.testi]);
    const row = (await emit('collection:find', { tabId: 'postgresql', db, coll: name, filter: '', limit: 10 })).docs[0];
    const next = modo === 'update' ? { numeri: [2, null, 4], testi: ['l\'apostrofo', 'a,b', '"citazione"', '\\', '日本語'] } : original;
    if (modo === 'update') await emit('doc:update', { tabId: 'postgresql', db, coll: name, id: JSON.stringify(row._id), set: next });
    else await emit('doc:replace', { tabId: 'postgresql', db, coll: name, id: JSON.stringify(row._id), doc: JSON.stringify(row) });
    assert.deepEqual(await native('postgresql', `SELECT numeri,testi FROM ${name}`), [next]);
  });
  for (const modo of ['insert', 'update', 'roundtrip', 'import']) await prova(`array-postgresql-estesi-${modo}`, `Array nativi, domini e JSON: ${modo} conserva tutti i valori tramite oracolo testuale`, async () => {
    const name = `array_estesi_${modo}`;
    await native('postgresql', `CREATE TYPE ${name}_umore AS ENUM ('caffè','日本語','a,b')`);
    await native('postgresql', `CREATE DOMAIN ${name}_vettore AS INTEGER[]`);
    await native('postgresql', `CREATE TABLE ${name}(id INT PRIMARY KEY,numeri INT[],testi TEXT[],matrice INT[][],vuoti TEXT[],binari BYTEA[],esatti NUMERIC(60,30)[],interi BIGINT[],logici BOOLEAN[],jsonv JSONB,jsona JSONB[],tempi TIMESTAMP(6)[],umori ${name}_umore[],dominio ${name}_vettore,domini ${name}_vettore[])`);
    const decimal = '123456789012345678901234567890.123456789012345678901234567890';
    const document = { numeri: [1, null, 3], testi: ['NULL', '', 'a,b', '"citazione"', '\\', '日本語'], matrice: [[1, null], [3, 4]], vuoti: [],
      binari: [{ $binary: { base64: 'AP+A', subType: '00' } }, null, { $binary: { base64: '', subType: '00' } }],
      esatti: [{ $numberDecimal: decimal }, null], interi: [{ $numberLong: '9007199254740993' }, null, { $numberLong: '-9223372036854775808' }],
      logici: [true, false, null], jsonv: [1, { testo: 'caffè' }, null], jsona: [{ a: '日本語' }, [1, null, { deep: true }], null, 42, '"'],
      tempi: ['2024-02-29 23:59:59.123456', null], umori: ['caffè', null, 'a,b'], dominio: [1, null, 9], domini: [[1, null], [2, 3]] };
    const columns = Object.keys(document);
    const nativi = { ...document, binari: [Buffer.from([0, 255, 128]), null, Buffer.alloc(0)], esatti: [decimal, null],
      interi: ['9007199254740993', null, '-9223372036854775808'], jsonv: JSON.stringify(document.jsonv),
      jsona: document.jsona.map(v => v === null ? null : JSON.stringify(v)), domini: ['{1,NULL}', '{2,3}'] };
    const insert = `INSERT INTO ${name}(id,${columns.join(',')}) VALUES($1,${columns.map((_, i) => '$' + (i + 2)).join(',')})`;
    await native('postgresql', insert, [0, ...Object.values(nativi)]);
    await native('postgresql', `INSERT INTO ${name}(id) VALUES(2)`);
    const snapshot = async id => (await native('postgresql', `SELECT ${columns.map(c => `${c}::text AS ${c}`).join(',')} FROM ${name} WHERE id=$1`, [id]))[0];
    const expected = await snapshot(0);
    const sentinel = await snapshot(2);
    if (modo === 'insert') await emit('doc:insert', { tabId: 'postgresql', db, coll: name, doc: JSON.stringify({ id: 1, ...document }) });
    if (modo === 'update') {
      await native('postgresql', `INSERT INTO ${name}(id) VALUES(1)`);
      await emit('doc:update', { tabId: 'postgresql', db, coll: name, id: '{"id":1}', set: document });
    }
    if (modo === 'roundtrip') {
      await native('postgresql', insert, [1, ...Object.values(nativi)]);
      const row = (await emit('collection:find', { tabId: 'postgresql', db, coll: name, filter: 'id=1', limit: 10 })).docs[0];
      await emit('doc:replace', { tabId: 'postgresql', db, coll: name, id: JSON.stringify(row._id), doc: JSON.stringify(row) });
    }
    if (modo === 'import') {
      const result = await emit('collection:import', { tabId: 'postgresql', db, coll: name, docs: [{ id: 1, ...document }] });
      assert.equal(result.inserted, 1, JSON.stringify(result));
      assert.deepEqual(result.errors, []);
    }
    assert.deepEqual(await snapshot(1), expected, '[PG-ARRAY-ESATTI] Tutti gli elementi coincidono con il driver indipendente');
    assert.deepEqual(await snapshot(2), sentinel, 'La riga estranea non cambia');
  });
  for (const modo of ['insert', 'replace']) await prova(`array-postgresql-testo-esatto-${modo}`, `Numeri nel testo JSON di ${modo} conservano tutte le cifre negli array SQL e JSONB`, async () => {
    const name = `array_testo_${modo}`;
    await native('postgresql', `CREATE TABLE ${name}(id INT PRIMARY KEY,n NUMERIC[],j JSONB[])`);
    const numero = '12345678901234567890.12345678901234567890';
    await native('postgresql', `INSERT INTO ${name} VALUES(0,ARRAY[${numero}]::numeric[],ARRAY['{"n":${numero}}'::jsonb,'[9007199254740993]'::jsonb])`);
    const doc = `{"id":1,"n":[${numero}],"j":[{"n":${numero}},[9007199254740993]]}`;
    if (modo === 'insert') await emit('doc:insert', { tabId: 'postgresql', db, coll: name, doc });
    else {
      await native('postgresql', `INSERT INTO ${name}(id) VALUES(1)`);
      await emit('doc:replace', { tabId: 'postgresql', db, coll: name, id: '{"id":1}', doc });
    }
    const rows = await native('postgresql', `SELECT n::text,j::text FROM ${name} ORDER BY id`);
    assert.deepEqual(rows[1], rows[0], '[PG-ARRAY-TESTO] Il parsing del documento non deve arrotondare le cifre digitate');
  });
  await prova('array-postgresql-metadati', 'Il dominio numerico array conserva il tipo fino al selettore dell’editor', async () => {
    await native('postgresql', 'CREATE DOMAIN "numeric" AS NUMERIC[]');
    await native('postgresql', `CREATE TABLE array_metadati(id INT PRIMARY KEY,a "${db}"."numeric",n NUMERIC)`);
    await native('postgresql', 'INSERT INTO array_metadati VALUES(1,ARRAY[9007199254740993.123456789],9007199254740993.123456789)');
    const result = await emit('collection:find', { tabId: 'postgresql', db, coll: 'array_metadati', limit: 10 });
    assert.equal(result.columnMeta.a.pgType?.kind, 'array', '[PG-ARRAY-METADATI] Il trasporto deve rendere riconoscibile il dominio array');
    const codec = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../../public/js/valori-esatti.js')).href);
    assert.equal(codec.richiedePrecisioneEsatta(result.columnMeta.a), false, 'Il dominio array usa l’editor strutturato');
    assert.equal(codec.richiedePrecisioneEsatta(result.columnMeta.n), true, 'Il numero scalare mantiene l’editor esatto');
    const before = await native('postgresql', 'SELECT a::text,n::text FROM array_metadati');
    await emit('doc:replace', { tabId: 'postgresql', db, coll: 'array_metadati', id: JSON.stringify(result.docs[0]._id), doc: JSON.stringify(result.docs[0]) });
    assert.deepEqual(await native('postgresql', 'SELECT a::text,n::text FROM array_metadati'), before);
  });
  await prova('array-postgresql-limiti', 'Lettura e reinserimento conservano lower bounds, dimensioni e microsecondi', async () => {
    const name = 'array_limiti';
    await native('postgresql', `CREATE TABLE ${name}(id INT PRIMARY KEY,a INT[],b INT[][],t TIMESTAMP(6)[])`);
    await native('postgresql', `INSERT INTO ${name} VALUES(1,'[0:2]={1,NULL,3}','[2:3][4:5]={{1,2},{3,4}}',ARRAY['2024-02-29 23:59:59.123456'::timestamp])`);
    const snapshot = async () => native('postgresql', `SELECT a::text,b::text,t::text FROM ${name}`);
    const before = await snapshot();
    const row = (await emit('collection:find', { tabId: 'postgresql', db, coll: name, limit: 10 })).docs[0];
    await emit('doc:replace', { tabId: 'postgresql', db, coll: name, id: JSON.stringify(row._id), doc: JSON.stringify(row) });
    assert.deepEqual(await snapshot(), before, '[PG-ARRAY-LIMITI] Gli indici e la precisione temporale non devono cambiare');
  });
  await prova('array-postgresql-export', 'Export CSV con PK array conserva precisione e cursori fra le pagine', async () => {
    const name = 'array_export';
    await native('postgresql', `CREATE TABLE ${name}(k NUMERIC[] PRIMARY KEY,n INT)`);
    await native('postgresql', `INSERT INTO ${name} VALUES('{9007199254740993.123456789}',1),('{9007199254740994.123456789}',2),('{9007199254740995.123456789}',3)`);
    const expected = await native('postgresql', `SELECT k::text FROM ${name} ORDER BY k`);
    let after;
    for (const row of expected) {
      const page = await emit('collection:export', { tabId: 'postgresql', db, coll: name, format: 'csv', limit: 1, after });
      assert.equal(page.lines.length, 1);
      assert.deepEqual(JSON.parse(page.nextAfter), [row.k], '[PG-ARRAY-CURSORE] La chiave deve conservare tutte le cifre');
      after = page.nextAfter;
    }
    const last = await emit('collection:export', { tabId: 'postgresql', db, coll: name, format: 'csv', limit: 1, after });
    assert.equal(last.lines.length, 0);
  });
  for (const tipo of ['int[]', 'jsonb']) await prova(`array-postgresql-identita-${tipo}`, `Filtri, keyset e identità distinguono una colonna ${tipo} da JSON`, async () => {
    const name = tipo === 'jsonb' ? 'identita_json' : 'identita_array';
    await native('postgresql', `CREATE TABLE ${name}(k ${tipo} PRIMARY KEY,n INT)`);
    for (const i of [1, 2, 3]) await native('postgresql', `INSERT INTO ${name} VALUES($1,$2)`, [tipo === 'jsonb' ? JSON.stringify([i]) : [i], i]);
    const find = payload => emit('collection:find', { tabId: 'postgresql', db, coll: name, limit: 10, ...payload });
    const equal = await find({ filtro: { condizioni: [{ campo: 'k', operatore: 'uguale', valore: [2] }] } });
    assert.deepEqual(equal.docs.map(r => r.n), [2]);
    const inside = await find({ filtro: { condizioni: [{ campo: 'k', operatore: 'dentro', valore: [[1], [3]] }] } });
    assert.deepEqual(inside.docs.map(r => r.n).sort(), [1, 3]);
    const page = await find({ limit: 1, keyset: { after: JSON.stringify({ k: [1] }) } });
    assert.deepEqual(page.docs.map(r => r.n), [2]);
    await emit('doc:update', { tabId: 'postgresql', db, coll: name, id: JSON.stringify({ k: [2] }), set: { n: 20 } });
    await emit('doc:delete', { tabId: 'postgresql', db, coll: name, id: JSON.stringify({ k: [3] }) });
    assert.deepEqual(await native('postgresql', `SELECT n FROM ${name} ORDER BY k`), [{ n: 1 }, { n: 20 }]);
  });
  for (const type of ['mysql', 'postgresql']) await prova(`sessioni-${type}`, 'Due schede isolate: transazione invisibile prima del commit e rollback alla disconnessione', async () => {
    const tabId = `${type}-seconda`;
    await emit('mongo:connect', { ...cfg[type], tabId });
    try {
      await query(type, 'BEGIN');
      await query(type, 'INSERT INTO contatore VALUES(90,90)');
      assert.deepEqual((await query(type, 'SELECT id FROM contatore WHERE id=90')).data, [{ id: 90 }]);
      assert.deepEqual((await query(type, 'SELECT id FROM contatore WHERE id=90', { tabId })).data, []);
      await query(type, 'COMMIT');
      assert.deepEqual((await query(type, 'SELECT id FROM contatore WHERE id=90', { tabId })).data, [{ id: 90 }]);
      await query(type, 'BEGIN', { tabId });
      await query(type, 'INSERT INTO contatore VALUES(91,91)', { tabId });
      await emit('mongo:disconnect', { tabId });
      await delay(50);
      assert.deepEqual(await native(type, 'SELECT id FROM contatore WHERE id=91'), []);
    } finally {
      await raw('mongo:disconnect', { tabId });
      await query(type, 'ROLLBACK').catch(() => {});
    }
  });
}

async function join(left, right, extra = {}) {
  return raw('query:execute', { tabId: left, engine: 'crossdb', db, code: JSON.stringify({ virtualJoin: {
    sourceA: { tabId: left, db, dbType: left, table: 'sinistra', collection: 'sinistra' },
    sourceB: { tabId: right, db, dbType: right, table: 'destra', collection: 'destra' },
    on: { leftKey: 'k', rightKey: 'k' }, as: 'unito', maxPayloadSize: 100, ...extra,
  } }) });
}
async function proveJoin() {
  const expected = (await pg.query('SELECT a.id AS l,b.id AS r FROM sinistra a LEFT JOIN destra b ON a.k=b.k ORDER BY a.id,b.id')).rows;
  for (const left of tipi) for (const right of tipi) if (left !== right) await prova(`join-${left}-${right}`, 'JOIN reale molti-a-molti conserva 7 righe, NULL, apostrofi e sorgenti senza match', async () => {
    const res = await join(left, right); assert.equal(res.ok, true, res.error);
    const pairs = res.data.map(r => ({ l: r.id, r: r.unito?.id ?? null })).sort((a, b) => a.l - b.l || (a.r ?? -1) - (b.r ?? -1));
    assert.deepEqual(pairs, expected);
  });
  await prova('join-budget', 'Budget insufficiente produce errore esplicito senza un successo parziale', async () => {
    const res = await join('mysql', 'mongodb', { maxPayloadSize: 3 });
    assert.equal(res.ok, false); assert.match(res.error, /budget|incomplet|limite/i);
  });
  await prova('join-budget-destra', 'Il tetto sulla seconda sorgente impedisce di perdere corrispondenze duplicate', async () => {
    const res = await join('mysql', 'mongodb', { maxPayloadSize: 1,
      sourceA: { tabId: 'mysql', db, table: 'sinistra', query: 'SELECT * FROM sinistra WHERE id=1' } });
    assert.equal(res.ok, false); assert.match(res.error, /budget|incomplet|limite/i);
  });
  await prova('join-budget-merge', 'L\'espansione molti-a-molti oltre il tetto fallisce anche se entrambe le sorgenti rientrano', async () => {
    const res = await join('mysql', 'mongodb', { maxPayloadSize: 5 });
    assert.equal(res.ok, false); assert.match(res.error, /budget|incomplet|limite/i);
  });
  await prova('join-sola-lettura', 'Una sorgente di scrittura viene rifiutata prima di alterare i dati', async () => {
    const before = await native('mysql', 'SELECT * FROM destra ORDER BY id');
    const res = await join('postgresql', 'mysql', { sourceB: { tabId: 'mysql', db, table: 'destra', query: 'DELETE FROM destra' } });
    assert.equal(res.ok, false);
    assert.deepEqual(await native('mysql', 'SELECT * FROM destra ORDER BY id'), before);
  });
}

const percentile = (valori, p) => [...valori].sort((a, b) => a - b)[Math.max(0, Math.ceil(valori.length * p) - 1)] || 0;
const misura = valori => ({ campioni: valori.length, p50ms: Math.round(percentile(valori, 0.50)), p95ms: Math.round(percentile(valori, 0.95)), maxms: Math.round(Math.max(...valori, 0)) });
const digestRighe = rows => { const hash = createHash('sha256'); for (const r of rows) hash.update(JSON.stringify([r.id, r.g, r.n, r.testo]) + '\n'); return hash.digest('hex'); };
async function proveVolume() {
  for (const type of tipi) await prova(`volume-${type}`, '20.017 righe: hash completo, 41 pagine ordinate, conteggio e latenza sotto carico', async () => {
    const volume = Array.from({ length: 20017 }, (_, id) => ({ id, g: `gruppo-${id % 17}`, n: id % 13 === 0 ? null : id * 17 % 997, testo: `${id}:日本語 😀 caffè` }));
    if (type === 'mongodb') {
      await mongo.db(db).collection('volume').insertMany(volume.map(r => ({ ...r })));
      await mongo.db(db).collection('volume').createIndex({ id: 1 }, { unique: true });
    } else {
      await native(type, 'CREATE TABLE volume(id INT PRIMARY KEY,g VARCHAR(30),n INT,testo TEXT)');
      for (let start = 0; start < volume.length; start += 1000) {
        const batch = volume.slice(start, start + 1000);
        if (type === 'mysql') await my.query('INSERT INTO volume VALUES ?', [batch.map(Object.values)]);
        else await pg.query('INSERT INTO volume SELECT * FROM UNNEST($1::int[],$2::text[],$3::int[],$4::text[])', ['id', 'g', 'n', 'testo'].map(k => batch.map(r => r[k])));
      }
    }
    const oracle = type === 'mongodb' ? await mongo.db(db).collection('volume').find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray() : await native(type, 'SELECT id,g,n,testo FROM volume ORDER BY id');
    const expected = digestRighe(oracle);
    assert.equal(expected, digestRighe(volume), 'Fixture reale identica ai dati generati');
    const actual = [], pages = [];
    for (let skip = 0; skip < volume.length; skip += 500) {
      const t = performance.now();
      const r = await emit('collection:find', { tabId: type, db, coll: 'volume', filter: '', sort: '{"id":1}', skip, limit: 500, deferCount: true });
      pages.push(performance.now() - t);
      assert.equal(r.docs.length, Math.min(500, volume.length - skip));
      actual.push(...r.docs);
    }
    assert.equal(actual.length, volume.length);
    assert.equal(digestRighe(actual), expected, 'Nessuna perdita, duplicazione, riordinamento o corruzione nelle pagine');
    const count = await emit('collection:count', { tabId: type, db, coll: 'volume', filter: type === 'mongodb' ? '{"id":{"$gte":0}}' : 'id >= 0' });
    assert.equal(count.approx, undefined); assert.equal(count.total, volume.length);
    const tempi = [], salute = [];
    let termina = false, erroreSalute;
    const monitor = (async () => {
      while (!termina) {
        const t = performance.now();
        const res = await fetch(server.url + '/handshake-check', { signal: AbortSignal.timeout(10000) });
        await res.arrayBuffer(); assert.equal(res.status, 200, 'Endpoint salute raggiungibile durante le query');
        salute.push(performance.now() - t); await delay(20);
      }
    })().catch(err => { erroreSalute = err; });
    let prossimo = 0;
    try {
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (prossimo++ < 48) {
          const t = performance.now();
          const r = await query(type, 'SELECT g,COUNT(*) AS c,SUM(n) AS s FROM volume GROUP BY g ORDER BY g', { coll: 'volume' });
          tempi.push(performance.now() - t);
          assert.equal(r.data.length, 17);
          assert.equal(piccolo(r.data).reduce((n, row) => n + row.c, 0), volume.length);
        }
      }));
    } finally { termina = true; await monitor; }
    if (erroreSalute) throw erroreSalute;
    const limiteQuery = Number(process.env.LAB_QUERY_P95_MS || 5000), limiteSalute = Number(process.env.LAB_HEALTH_P95_MS || 2000);
    const campione = { tipo: type, righe: volume.length, sha256: expected, pagine: misura(pages), query: misura(tempi), salute: misura(salute), soglie: { queryP95ms: limiteQuery, saluteP95ms: limiteSalute } };
    metriche.campioni.push(campione);
    assert(tempi.length === 48 && salute.length > 0, 'Campionamento effettivo sotto carico');
    assert(campione.pagine.p95ms < limiteQuery, JSON.stringify(campione));
    assert(campione.query.p95ms < limiteQuery, JSON.stringify(campione));
    assert(campione.salute.p95ms < limiteSalute, JSON.stringify(campione));
    console.log(`METRICHE ${JSON.stringify(campione)}`);
  });
  for (const type of ['mysql', 'postgresql']) await prova(`rilascio-pool-${type}`, '12 cicli apri/query/chiudi rilasciano davvero le sessioni native', async () => {
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const tabId = `pool-${type}-${i}`;
      try {
        await emit('mongo:connect', { ...cfg[type], tabId });
        const q = type === 'mysql' ? 'SELECT CONNECTION_ID() AS id' : 'SELECT pg_backend_pid() AS id';
        ids.push(Number((await query(type, q, { tabId })).data[0].id));
      } finally { await emit('mongo:disconnect', { tabId }); }
    }
    let remaining = [];
    for (let retry = 0; retry < 30; retry++) {
      const nativeIds = type === 'mysql' ? await native(type, 'SELECT ID AS id FROM information_schema.PROCESSLIST') : await native(type, 'SELECT pid AS id FROM pg_stat_activity');
      remaining = nativeIds.filter(row => ids.includes(Number(row.id)));
      if (!remaining.length) break;
      await delay(100);
    }
    assert.deepEqual(remaining, [], 'Sessioni proprie ancora vive dopo chiusura');
  });
}

async function pulisci() {
  socket?.disconnect();
  if (server) await server.stop();
  const cleanup = async (nome, fn) => { try { await registry.drop(db, fn); } catch (err) { cleanupErrors.push({ nome, errore: err.message }); } };
  if (mongo) await cleanup('mongodb', name => mongo.db(name).dropDatabase());
  if (my) await cleanup('mysql', name => my.query(`DROP DATABASE IF EXISTS ${quota('mysql', name)}`));
  if (pg) await cleanup('postgresql', name => pg.query(`DROP SCHEMA IF EXISTS ${quota('postgresql', name)} CASCADE`));
  await Promise.allSettled([mongo?.close(), my?.end(), pg?.end()]);
}

async function sensibilita() {
  const prove = [['perdita-riga', 'differenziale-mongodb-righe'], ['update-saltato', 'crud-composito-mysql'], ['join-deduplicato', 'join-mysql-mongodb'], ['array-cifre', 'array-postgresql-testo-esatto-insert']];
  const risultati = [];
  for (const [mutant, caso] of prove) {
    const baseline = esiti.find(e => e.id === caso);
    assert.equal(baseline?.ok, true, `Serve prima la baseline verde: ${caso}`);
    const reportFile = path.join(reportDir, `query-${mutant}.json`);
    fs.rmSync(reportFile, { force: true });
    let output = ''; const rawOutput = [];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, LAB_QUERY_MUTANT: mutant, LAB_QUERY_CASE: caso }, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout verifica mutazione ${mutant}`)); }, 120000);
      child.stdout.on('data', b => { rawOutput.push(b); output += b; });
      child.stderr.on('data', b => { rawOutput.push(b); output += b; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', c => { clearTimeout(timer); resolve(c); });
    }).finally(() => fs.writeFileSync(path.join(reportDir, `query-${mutant}.log`), Buffer.concat(rawOutput)));
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(code, 1, `La mutazione ${mutant} deve fallire\n${output}`);
    assert.deepEqual(report.esiti.filter(e => !e.ok).map(e => e.id), [caso], 'Solo il caso atteso deve rilevare il guasto');
    assert.equal(report.erroreAvvio, undefined, 'Nessun errore estraneo di avvio');
    assert.equal(report.cleanupErrors.length, 0, 'La pulizia deve riuscire anche dopo il guasto');
    risultati.push({ mutant, caso, rilevata: true });
    console.log(`OK sensibilità: ${mutant} rilevata da ${caso}`);
  }
  fs.writeFileSync(path.join(reportDir, 'query-sensitivity.json'), JSON.stringify({ started, risultati }, null, 2));
}

(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  let erroreAvvio;
  try {
    await prepara();
    await proveQuery(); await proveCrud(); await proveJoin(); await proveVolume();
  } catch (err) { erroreAvvio = err.stack; console.error(err); }
  finally {
    await pulisci();
    const report = { started, finished: new Date().toISOString(), seed, db, ambiente, mutant: process.env.LAB_QUERY_MUTANT || null, casi: esiti.length, falliti: esiti.filter(e => !e.ok).length, esiti, metriche, cleanupErrors, erroreAvvio };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`REPORT ${reportFile}: ${report.casi} casi, ${report.falliti} falliti, ${cleanupErrors.length} errori pulizia`);
    if (erroreAvvio || !esiti.length || report.falliti || cleanupErrors.length) process.exitCode = 1;
  }
  if (process.argv.includes('--sensitivity') && !process.env.LAB_QUERY_MUTANT) await sensibilita();
})().catch(err => { console.error(err); process.exitCode = 1; });
