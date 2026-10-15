'use strict';
const assert = require('node:assert/strict');
const mutant = process.argv.find(a => a.startsWith('--mutant='))?.split('=')[1];
const variants = {
  mql: ['sqlScrittureMongo.js', 'api.mutazioni(collection, triggers)', 'collection'],
  singolo: ['sqlTriggerMongo.js', "limit: name.endsWith('Many') ? 0 : 1", 'limit: 0'],
  bson: ['mongoBson.js', 'if (triggers) await triggers.dopo(previous, ids);', '/* evento rimosso */'],
  griglia: ['insertBson.js', 'if (triggers) await triggers.dopo', 'if (false) await triggers.dopo'],
  before: ['sqlTriggerMongo.js', "triggers.filter(t => t.events.includes(event) && t.timing === timing)", "triggers.filter(t => t.events.includes(event) && t.timing === timing && timing !== 'BEFORE')"],
  cascata: ['sqlVincoliReferenziali.js', 'const child = await mutations(name);', 'const child = database.collection(name);'],
  cursore: ['sqlProcedureMongo.js', 'const row = c.rows[c.at++];', 'const row = c.rows[++c.at];'],
  handler: ['sqlProcedureMongo.js', "if (handler.action === 'exit') return 'return';", "if (false) return 'return';"],
  opzioni: ['sqlTriggerMongo.js', '.find(filter, selected)', '.find(filter, readOptions)'],
  nullid: ['sqlTriggerMongo.js', "else if (Object.hasOwn(result.lastErrorObject || {}, 'upserted'))", 'else if (result.lastErrorObject?.upserted != null)'],
};
let mutated = false;
if (mutant) require('node:module').registerHooks({ load(url, ctx, next) {
  const result = next(url, ctx), [file, from, to] = variants[mutant];
  if (!url.endsWith('/' + file)) return result;
  assert.ok(String(result.source).includes(from), `Mutazione ${mutant} non applicata`); mutated = true;
  return { ...result, source: String(result.source).replace(from, to) };
} });
const { MongoClient } = require('mongodb');
const { EJSON, Int32 } = require('bson');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { guardStrategy } = require('../auth/guardStrategy');
const { makePrincipal } = require('../auth/principal');
const { createE2eTargetRegistry } = require('./e2e-harness');
const sql = require('../db/SqlToMql'), trigger = require('../db/sqlTriggerMongo'), procedures = require('../db/sqlProcedureMongo');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_eventi' }), db = targets.target('mongo');
const client = new MongoClient(`mongodb://127.0.0.1:${process.env.MONGO_PORT || 27039}`, { serverSelectionTimeoutMS: 5000 });
const base = new MongoDbStrategy({ env: {} }); base.client = client;
process.env.CODEDB_RBAC = 'on';
const protectedStrategy = (collections = ['*']) => guardStrategy(base, { connName: 'test', principal: makePrincipal(
  { _id: 'test', type: 'subuser', ownerId: 'owner' }, [{ connName: 'test', capabilities: ['read', 'write', 'delete', 'ddl'], scope: { databases: [db], collections } }]) });
const strategy = protectedStrategy();
async function execute(text, target = strategy, extra = {}) {
  if (procedures.riconosci(text)) return target.mongoSqlProcedure(db, procedures.parse(text).name, { sql: text, ...extra });
  if (trigger.riconosci(text)) return strategy.mongoSqlTrigger(db, trigger.parse(text).coll, { sql: text });
  const plan = sql.looksLikeSql(text) ? sql.translate(text) : sql.translateWrite(text);
  return strategy[plan.kind === 'ddl' ? 'mongoSqlSchema' : plan.kind === 'write' ? 'mongoSqlReturning' : 'mongoSqlRead'](db, plan.coll, { sql: text });
}
const shell = (op, fields, target = strategy) => target.shellWrite(db, 'eventi', { op, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, EJSON.stringify(v)])) });
let checks = 0, connected = false;
(async () => {
  targets.assertOwned(db); await client.connect(); connected = true;
  const database = client.db(db), logs = database.collection('tracce');
  await execute('CREATE TABLE eventi(id INT PRIMARY KEY,n INT)');
  await execute('CREATE TABLE tracce(evento TEXT,id INT,prima INT,dopo INT)');
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) await execute(`CREATE TRIGGER traccia_${event} AFTER ${event} ON eventi FOR EACH ROW INSERT INTO tracce VALUES('${event}',${event === 'DELETE' ? 'OLD' : 'NEW'}.id,${event === 'INSERT' ? 'NULL' : 'OLD.n'},${event === 'DELETE' ? 'NULL' : 'NEW.n'})`);
  async function check(label, work, expected) {
    await logs.deleteMany({}); const result = await work();
    assert.deepEqual(await logs.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(), expected.map(([evento, id, prima, dopo]) => ({ evento, id, prima, dopo })), label);
    console.log(`  OK   ${label}`); checks++; return result;
  }
  await check('MQL insertMany', () => shell('insertMany', { docs: [{ _id: 1, id: 1, n: 10 }, { _id: 2, id: 2, n: 20 }] }), [['INSERT', 1, null, 10], ['INSERT', 2, null, 20]]);
  await check('MQL updateOne sort: solo la riga scelta', () => shell('updateOne', { filter: {}, update: { $inc: { n: 1 } }, options: { sort: { id: -1 } } }), [['UPDATE', 2, 20, 21]]);
  await check('Opzioni della scrittura non possono nascondere OLD/NEW', () => shell('updateOne', { filter: { id: 1 }, update: { $inc: { n: 0 } }, options: { skip: 99, projection: { _id: 0 }, returnKey: true } }), [['UPDATE', 1, 10, 10]]);
  await check('MQL updateMany senza modifiche', () => shell('updateMany', { filter: {}, update: { $inc: { n: 0 } } }), [['UPDATE', 1, 10, 10], ['UPDATE', 2, 21, 21]]);
  await check('MQL pipeline e variabili let', () => shell('updateMany', { filter: { id: 1 }, update: [{ $set: { n: { $add: ['$n', '$$delta'] } } }], options: { let: { delta: 2 } } }), [['UPDATE', 1, 10, 12]]);
  const replaced = await check('findOneAndReplace: OLD e trigger', () => shell('findOneAndReplace', { filter: { id: 1 }, doc: { id: 1, n: 12 }, options: { projection: { _id: 0, n: 1 } } }), [['UPDATE', 1, 12, 12]]);
  assert.deepEqual(replaced.doc, { n: 12 });
  const old = await check('findOneAndUpdate: OLD proiettato e sort', () => shell('findOneAndUpdate', { filter: {}, update: { $inc: { n: 1 } }, options: { sort: { id: -1 }, projection: { _id: 0, n: 1 } } }), [['UPDATE', 2, 21, 22]]);
  assert.deepEqual(old.doc, { n: 21 });
  const inserted = await check('findOneAndUpdate upsert: identità anche con OLD null', () => shell('findOneAndUpdate', { filter: { _id: 3, id: 3 }, update: { $set: { n: 30 } }, options: { upsert: true } }), [['INSERT', 3, null, 30]]);
  assert.equal(inserted.doc, null);
  await check('findOneAndUpdate upsert con metadati', () => shell('findOneAndUpdate', { filter: { _id: 4, id: 4 }, update: { $set: { n: 40 } }, options: { upsert: true, includeResultMetadata: true, returnDocument: 'after' } }), [['INSERT', 4, null, 40]]);
  await check('Upsert con identità BSON null', () => shell('findOneAndUpdate', { filter: { _id: null, id: 9 }, update: { $set: { n: 90 } }, options: { upsert: true } }), [['INSERT', 9, null, 90]]);
  await check('Eliminazione con identità BSON null', () => shell('deleteOne', { filter: { _id: null } }), [['DELETE', 9, 90, null]]);
  await check('replaceOne con upsert', () => shell('replaceOne', { filter: { _id: 5 }, doc: { _id: 5, id: 5, n: 50 }, options: { upsert: true } }), [['INSERT', 5, null, 50]]);
  await check('Griglia: inserimento BSON esatto', () => strategy.docInsert(db, 'eventi', { doc: '[{"_id":6,"id":6,"n":60},{"_id":7,"id":7,"n":70}]' }), [['INSERT', 6, null, 60], ['INSERT', 7, null, 70]]);
  await check('Griglia: modifica', () => strategy.docUpdate(db, 'eventi', { id: '6', set: { n: 61 } }), [['UPDATE', 6, 60, 61]]);
  await check('Griglia: sostituzione', () => strategy.docReplace(db, 'eventi', { id: '6', doc: '{"id":6,"n":62}' }), [['UPDATE', 6, 61, 62]]);
  await check('MCP: aggiornamento di massa', () => strategy.collectionUpdateMany(db, 'eventi', { filter: '{"id":6}', set: '{"n":63}' }), [['UPDATE', 6, 62, 63]]);
  await check('Import EJSON: upsert ripetuti conservano ogni OLD/NEW', () => strategy.collectionImport(db, 'eventi', { upsert: true, docs: [{ _id: 6, id: 6, n: 64 }, { _id: 6, id: 6, n: 65 }] }), [['UPDATE', 6, 63, 64], ['UPDATE', 6, 64, 65]]);
  const bson = require('../db/mongoBson');
  await check('Import BSON: upsert ripetuti conservano ogni OLD/NEW', () => strategy.collectionImport(db, 'eventi', { encoding: bson.ENCODING, upsert: true, docs: [66, 67].map(n => bson.encode({ _id: new Int32(6), id: new Int32(6), n: new Int32(n) })) }), [['UPDATE', 6, 65, 66], ['UPDATE', 6, 66, 67]]);
  await check('Import BSON: inserimento', () => strategy.collectionImport(db, 'eventi', { encoding: bson.ENCODING, docs: [bson.encode({ _id: new Int32(8), id: new Int32(8), n: new Int32(80) })] }), [['INSERT', 8, null, 80]]);
  await check('Griglia: elimina', () => strategy.docDelete(db, 'eventi', { id: '7' }), [['DELETE', 7, 70, null]]);
  await check('MQL deleteOne', () => shell('deleteOne', { filter: { id: { $gte: 6 } } }), [['DELETE', 6, 67, null]]);
  await check('MQL findOneAndDelete sort', () => shell('findOneAndDelete', { filter: {}, options: { sort: { id: -1 } } }), [['DELETE', 8, 80, null]]);
  await check('MQL deleteMany', () => shell('deleteMany', { filter: { id: { $gte: 4 } } }), [['DELETE', 4, 40, null], ['DELETE', 5, 50, null]]);
  await check('MQL nessuna corrispondenza: nessun evento', () => shell('updateOne', { filter: { id: 99 }, update: { $set: { n: 1 } } }), []);
  await check('Trigger MQL rispetta gli scope', () => assert.rejects(shell('updateOne', { filter: { id: 1 }, update: { $inc: { n: 1 } } }, protectedStrategy(['eventi'])), /Permesso negato/), []);
  assert.equal((await database.collection('eventi').findOne({ id: 1 })).n, 12);
  await execute("CREATE TRIGGER z_errore AFTER UPDATE ON eventi FOR EACH ROW BEGIN IF NEW.n=99 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='annulla tutto'; END IF; END");
  const before = await database.collection('eventi').find().toArray();
  await check('Trigger fallito annulla updateMany e tutti gli audit', () => assert.rejects(shell('updateMany', { filter: {}, update: { $set: { n: 99 } } }), /annulla tutto/), []);
  assert.deepEqual(await database.collection('eventi').find().toArray(), before);
  await check('Trigger fallito annulla import BSON e tutti gli audit', () => assert.rejects(strategy.collectionImport(db, 'eventi', { encoding: bson.ENCODING, upsert: true, docs: [bson.encode({ _id: new Int32(1), id: new Int32(1), n: new Int32(99) })] }), /annulla tutto/), []);
  assert.deepEqual(await database.collection('eventi').find().toArray(), before);
  await execute('DROP TRIGGER z_errore ON eventi');
  await check('Eliminazione di massa della griglia', () => strategy.collectionDeleteMany(db, 'eventi', { filter: '{"id":3}' }), [['DELETE', 3, 30, null]]);
  await execute('CREATE TABLE preparata(id INT PRIMARY KEY,n INT,payload JSON)');
  await execute('CREATE TABLE vista_prima(id INT,n INT)');
  await execute('CREATE TRIGGER prepara_i BEFORE INSERT ON preparata FOR EACH ROW SET NEW.n=COALESCE(NEW.n,0)+1');
  await execute('CREATE TRIGGER prepara_u BEFORE UPDATE ON preparata FOR EACH ROW BEGIN INSERT INTO vista_prima SELECT id,n FROM preparata WHERE id=OLD.id; SET NEW.n=NEW.n+1; END');
  await execute("CREATE TRIGGER prepara_d BEFORE DELETE ON preparata FOR EACH ROW BEGIN IF OLD.n=99 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='non eliminabile'; END IF; END");
  const pshell = (op, fields) => strategy.shellWrite(db, 'preparata', { op, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, EJSON.stringify(v)])) });
  await execute('INSERT INTO preparata(id,n) VALUES(1,10)');
  assert.equal((await database.collection('preparata').findOne({ id: 1 })).n, 11);
  await execute('UPDATE preparata SET n=n+1 WHERE id=1');
  assert.deepEqual((await execute('SELECT id,n FROM vista_prima')).docs, [{ id: 1, n: 11 }]);
  assert.equal((await database.collection('preparata').findOne({ id: 1 })).n, 13);
  await pshell('updateOne', { filter: { id: 1 }, update: { $inc: { n: 1 } } });
  assert.equal((await database.collection('preparata').findOne({ id: 1 })).n, 15);
  assert.deepEqual((await execute('SELECT id,n FROM vista_prima ORDER BY n')).docs, [{ id: 1, n: 11 }, { id: 1, n: 13 }]);
  const pold = await pshell('findOneAndUpdate', { filter: { id: 1 }, update: { $inc: { n: 1 } }, options: { projection: { _id: 0, n: 1 } } });
  assert.deepEqual(pold.doc, { n: 15 });
  const pnew = await pshell('findOneAndUpdate', { filter: { id: 1 }, update: [{ $set: { n: { $add: ['$n', '$$delta'] } } }], options: { let: { delta: 1 }, returnDocument: 'after', projection: { _id: 0, n: 1 } } });
  assert.deepEqual(pnew.doc, { n: 19 });
  await pshell('updateOne', { filter: { _id: 2, id: 2 }, update: { $set: { n: 20, payload: { items: [1, 2] } } }, options: { upsert: true } });
  await pshell('updateOne', { filter: { id: 2, 'payload.items': 2 }, update: { $inc: { 'payload.items.$': 1 } } });
  await pshell('updateMany', { filter: { id: 2 }, update: { $inc: { 'payload.items.$[i]': 10 } }, options: { arrayFilters: [{ i: { $gte: 2 } }] } });
  assert.deepEqual((await database.collection('preparata').findOne({ id: 2 })).payload, { items: [1, 13] });
  await pshell('replaceOne', { filter: { id: 2 }, doc: { id: 2, n: 24 } });
  assert.equal((await database.collection('preparata').findOne({ id: 2 })).n, 25);
  await database.collection('preparata').createIndex({ n: 1 }, { name: 'prima_trenta', partialFilterExpression: { n: { $lt: 30 } } });
  const moved = await pshell('findOneAndUpdate', { filter: { id: 2, n: 25 }, update: { $set: { n: 40 } }, options: { hint: 'prima_trenta', returnDocument: 'after', projection: { _id: 0, n: 1 } } });
  assert.deepEqual(moved.doc, { n: 41 }, 'NEW resta disponibile quando esce dall’indice parziale usato per la selezione');
  const beforeReplace = await pshell('findOneAndReplace', { filter: { id: 2 }, doc: { id: 2, n: 24 }, options: { returnDocument: 'after', projection: { _id: 0, n: 1 } } });
  assert.deepEqual(beforeReplace.doc, { n: 25 });
  const nullId = await pshell('updateOne', { filter: { _id: null, id: 7 }, update: { $set: { n: 70 } }, options: { upsert: true } });
  assert.equal(nullId.upserted, 1);
  await pshell('updateOne', { filter: { _id: null }, update: { $inc: { n: 1 } } });
  assert.equal((await database.collection('preparata').findOne({ _id: null })).n, 73);
  await pshell('deleteOne', { filter: { _id: null } });
  await strategy.docInsert(db, 'preparata', { doc: '{"_id":3,"id":3,"n":30,"payload":{"legacy":{"$undefined":true},"date":{"$date":{"$numberLong":"9223372036854775807"}}}}' });
  const rawBefore = await database.collection('preparata').findOne({ id: 3 }, { raw: true });
  await pshell('updateOne', { filter: { id: 3 }, update: { $inc: { n: 1 } } });
  const rawAfter = await database.collection('preparata').findOne({ id: 3 }, { raw: true });
  assert.ok(rawAfter.equals(bson.sostituisciCampi(rawBefore, { n: new Int32(33) })), 'BEFORE preserva i byte BSON dei campi non assegnati');
  await strategy.collectionImport(db, 'preparata', { encoding: bson.ENCODING, upsert: true, docs: [bson.encode({ _id: new Int32(3), id: new Int32(3), n: new Int32(34) })] });
  assert.equal((await database.collection('preparata').findOne({ id: 3 })).n, 35);
  await pshell('insertMany', { docs: [{ id: 4, n: 40 }, { id: 5, n: 50 }] });
  assert.deepEqual((await execute('SELECT n FROM preparata WHERE id>=4 ORDER BY id')).docs, [{ n: 41 }, { n: 51 }]);
  await pshell('updateOne', { filter: { id: 1 }, update: { $set: { n: 98 } } });
  await assert.rejects(pshell('deleteOne', { filter: { id: 1 } }), /non eliminabile/);
  await assert.rejects(execute('DELETE FROM preparata WHERE id=1'), /non eliminabile/);
  assert.equal(await database.collection('_codedb_sql_trigger_stage').countDocuments(), 0);
  console.log('  OK   BEFORE SQL/MQL: visibilità OLD, assegnazioni NEW, upsert, pipeline, array posizionali, BSON esatto e rollback'); checks++;
  await execute('CREATE TABLE padre_eventi(id INT PRIMARY KEY)');
  await execute('CREATE TABLE figlio_eventi(id INT PRIMARY KEY,pid INT,FOREIGN KEY(pid) REFERENCES padre_eventi(id) ON UPDATE CASCADE ON DELETE CASCADE)');
  await execute('CREATE TABLE cascata_log(id INT,pid INT)');
  await execute('CREATE TRIGGER cascata_u AFTER UPDATE ON figlio_eventi FOR EACH ROW INSERT INTO cascata_log VALUES(NEW.id,NEW.pid)');
  await execute('CREATE TRIGGER cascata_d AFTER DELETE ON figlio_eventi FOR EACH ROW INSERT INTO cascata_log VALUES(OLD.id,OLD.pid)');
  await execute('INSERT INTO padre_eventi VALUES(1),(2)');
  await execute('INSERT INTO figlio_eventi VALUES(1,1),(2,2)');
  await execute('UPDATE padre_eventi SET id=3 WHERE id=1');
  await strategy.shellWrite(db, 'padre_eventi', { op: 'deleteOne', filter: '{"id":3}' });
  assert.deepEqual((await execute('SELECT id,pid FROM cascata_log')).docs, [{ id: 1, pid: 3 }, { id: 1, pid: 3 }]);
  await execute("CREATE TRIGGER cascata_blocca BEFORE DELETE ON figlio_eventi FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='cascata annullata'");
  await assert.rejects(execute('DELETE FROM padre_eventi WHERE id=2'), /cascata annullata/);
  assert.equal(await database.collection('padre_eventi').countDocuments({ id: 2 }), 1);
  assert.equal(await database.collection('figlio_eventi').countDocuments({ pid: 2 }), 1);
  console.log('  OK   Trigger sulle cascate FK SQL/MQL, compreso il rollback del padre dopo errore del figlio'); checks++;
  await execute('CREATE TABLE esatti_cursore(id INT PRIMARY KEY,n BIGINT)');
  await execute('INSERT INTO esatti_cursore VALUES(1,9223372036854775807),(2,7)');
  await execute('CREATE TABLE copia_cursore(id INT,n BIGINT)');
  await execute(`CREATE PROCEDURE scorri() BEGIN DECLARE v_id INT; DECLARE v_n BIGINT;
    DECLARE c CURSOR FOR SELECT id,n FROM esatti_cursore ORDER BY id;
    DECLARE EXIT HANDLER FOR NOT FOUND INSERT INTO copia_cursore VALUES(3,3);
    OPEN c; FETCH c INTO v_id,v_n; INSERT INTO copia_cursore VALUES(v_id,v_n);
    FETCH c INTO v_id,v_n; INSERT INTO copia_cursore VALUES(v_id,v_n);
    FETCH c INTO v_id,v_n; INSERT INTO copia_cursore VALUES(99,99); END`);
  await execute('CALL scorri()');
  assert.deepEqual((await execute('SELECT id,CAST(n AS TEXT) AS n FROM copia_cursore ORDER BY id')).docs,
    [{ id: 1, n: '9223372036854775807' }, { id: 2, n: '7' }, { id: 3, n: '3' }]);
  await assert.rejects(execute('CALL scorri()', protectedStrategy(['scorri', 'copia_cursore'])), /Permesso negato/);
  await assert.rejects(execute('CALL scorri()', strategy, { maxRows: 1 }), /limite di righe/);
  assert.equal(await database.collection('copia_cursore').countDocuments(), 3);
  await execute('CREATE PROCEDURE limite_cursori() BEGIN DECLARE c CURSOR FOR SELECT id,n FROM esatti_cursore; DECLARE d CURSOR FOR SELECT id,n FROM esatti_cursore; OPEN c; OPEN d; END');
  base.env = { CODEDB_MAX_RESULT_BYTES: '110' };
  try { await assert.rejects(execute('CALL limite_cursori()'), /budget complessivo|limite di righe/); }
  finally { base.env = {}; }
  console.log('  OK   Cursori: BIGINT esatto, handler EXIT, scope, cap e budget complessivo'); checks++;
  await execute('CREATE TABLE cond_mql(id INT PRIMARY KEY,n INT)');
  await execute('CREATE TABLE cond_mql_log(id INT,n INT)');
  await execute('CREATE TRIGGER prima_cond BEFORE INSERT OR UPDATE ON cond_mql FOR EACH ROW WHEN (NEW.n<0) SET NEW.n=ABS(NEW.n)');
  await execute('CREATE TRIGGER dopo_cond AFTER INSERT OR UPDATE ON cond_mql FOR EACH ROW WHEN (NEW.n>0) INSERT INTO cond_mql_log VALUES(NEW.id,NEW.n)');
  await strategy.shellWrite(db, 'cond_mql', { op: 'insertMany', docs: '[{"_id":1,"id":1,"n":-2},{"_id":2,"id":2,"n":null}]' });
  await strategy.shellWrite(db, 'cond_mql', { op: 'updateOne', filter: '{"id":2}', update: '{"$set":{"n":-3}}' });
  await strategy.collectionImport(db, 'cond_mql', { encoding: bson.ENCODING, upsert: true, docs: [bson.encode({ _id: new Int32(1), id: new Int32(1), n: new Int32(-4) })] });
  assert.deepEqual((await execute('SELECT id,n FROM cond_mql ORDER BY id')).docs, [{ id: 1, n: 4 }, { id: 2, n: 3 }]);
  assert.deepEqual((await execute('SELECT id,n FROM cond_mql_log ORDER BY n')).docs, [{ id: 1, n: 2 }, { id: 2, n: 3 }, { id: 1, n: 4 }]);
  const scoped = protectedStrategy(['cond_mql']);
  await assert.rejects(scoped.shellWrite(db, 'cond_mql', { op: 'insertOne', doc: '{"id":3,"n":0}' }), /Permesso negato/);
  assert.equal(await database.collection('cond_mql').countDocuments({ id: 3 }), 0);
  console.log('  OK   WHEN ed eventi multipli su MQL/import BSON; autorizzazione anche del corpo non percorso'); checks++;
  if (mutant) { assert.ok(mutated); throw new Error(`Mutazione ${mutant} sopravvissuta`); }
  console.log(`\n${checks} verifiche reali degli eventi MQL, griglia e import superate.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  await client.close();
});
