'use strict';
const assert = require('node:assert/strict');
const mutant = process.argv.find(a => a.startsWith('--mutant='))?.split('=')[1];
const variants = {
  alter: ['sqlAlterMongo.js', "if (!await validation.hasNext()) throw", 'if (false) throw'],
  recupero: ['sqlAlterMongo.js', "const forward = !!await catalog.findOne({ _id: `${job._id}:commit` }, { session });", 'const forward = false;'],
  trigger: ['sqlTriggerMongo.js', 'for (const id of ids) {', 'for (const id of []) {'],
  controllo: ['sqlProcedureMongo.js', "if (control === 'return') return control;", "if (false) return control;"],
  enum: ['sqlSchemaMongo.js', "if (c.type === 'ENUM') prop.enum", "if (false) prop.enum"],
  unsigned: ['sqlSchemaMongo.js', 'bits - (c.unsigned ? 0 : 1)', 'bits - 1'],
  parentesi: ['sqlAlterMongo.js', "t.type === 'punct' && t.value === '('", "t.value === '('"],
  letterale: ['sqlEspressioni.js', "t.type === 'punct' && t.value === '('", "t.value === '('"],
  nomi: ['sqlSchemaMongo.js', 'while (schema.constraints.some(c => c.name === `${coll}_${constraint.kind.toLowerCase()}_${suffix}`)) suffix++;', 'while (false) suffix++;'],
};
let mutato = false;
if (mutant) {
  assert.ok(variants[mutant]);
  require('node:module').registerHooks({ load(url, context, next) {
    const result = next(url, context), [file, from, to] = variants[mutant];
    if (!url.endsWith('/' + file)) return result;
    assert.ok(String(result.source).includes(from), `Mutazione ${mutant} non applicata`); mutato = true;
    return { ...result, source: String(result.source).replace(from, to) };
  } });
}
const { MongoClient } = require('mongodb');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { guardStrategy } = require('../auth/guardStrategy');
const { makePrincipal } = require('../auth/principal');
const { createE2eTargetRegistry } = require('./e2e-harness');
const sql = require('../db/SqlToMql'), procedures = require('../db/sqlProcedureMongo'), triggers = require('../db/sqlTriggerMongo');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_migrazioni' }), db = targets.target('mongo');
const client = new MongoClient(`mongodb://127.0.0.1:${process.env.MONGO_PORT || 27039}`, { serverSelectionTimeoutMS: 5000 });
const base = new MongoDbStrategy({ env: {} }); base.client = client;
process.env.CODEDB_RBAC = 'on';
const protectedStrategy = (caps = ['read', 'write', 'delete', 'ddl'], collections = ['*']) => guardStrategy(base, {
  connName: 'test', principal: makePrincipal({ _id: 'test', type: 'subuser', ownerId: 'owner' },
    [{ connName: 'test', capabilities: caps, scope: { databases: [db], collections } }]),
});
const strategy = protectedStrategy();
async function execute(text, target = strategy) {
  if (triggers.riconosci(text)) return target.mongoSqlTrigger(db, triggers.parse(text).coll, { sql: text });
  if (procedures.riconosci(text)) return target.mongoSqlProcedure(db, procedures.parse(text).name, { sql: text });
  const plan = sql.looksLikeSql(text) ? sql.translate(text) : sql.translateWrite(text);
  return target[plan.kind === 'ddl' ? 'mongoSqlSchema' : plan.kind === 'write' ? 'mongoSqlReturning' : 'mongoSqlRead'](db, plan.coll, { sql: text });
}
let connected = false;
(async () => {
  targets.assertOwned(db); await client.connect(); connected = true;
  const database = client.db(db);
  await execute('CREATE TABLE migrata(id INT PRIMARY KEY,n INT)');
  await execute('INSERT INTO migrata VALUES(1,1),(2,32767)');
  const before = await database.collection('migrata').find().toArray();
  await assert.rejects(execute('ALTER TABLE migrata ALTER COLUMN n TYPE SMALLINT USING n+1'), /schema/);
  assert.deepEqual(await database.collection('migrata').find().toArray(), before, 'La prima riga convertita viene annullata se la seconda non è valida');
  console.log('  OK   Migrazione con errore sulla seconda riga: rollback completo');

  for (const phase of ['prepared', 'committed']) {
    const ddl = `ALTER TABLE migrata ADD COLUMN ${phase} INT DEFAULT 7`;
    const original = client.db.bind(client);
    client.db = (...args) => {
      const d = original(...args), command = d.command.bind(d);
      d.command = async (cmd, options) => {
        if (cmd.collMod !== 'migrata') return command(cmd, options);
        const barrier = cmd.validator?.$and?.some(c => c.$expr?.$eq?.[0] === 1 && c.$expr.$eq[1] === 0);
        if (phase === 'prepared') {
          if (barrier) await command(cmd, options);
          throw new Error('Connessione DDL interrotta intenzionalmente');
        }
        if (!barrier) throw new Error('Finalizzazione DDL interrotta intenzionalmente');
        return command(cmd, options);
      };
      return d;
    };
    try { await assert.rejects(execute(ddl), /DDL interrotta/); }
    finally { client.db = original; }
    assert.ok(await database.collection('_codedb_sql_migrations').countDocuments() > 0);
    const stored = await database.collection('migrata').findOne({ id: 1 });
    assert.equal(stored[phase], phase === 'committed' ? 7 : undefined);
    await assert.rejects(execute('UPDATE migrata SET n=8 WHERE id=1'), /Migrazione SQL/);
    await assert.rejects(database.collection('migrata').insertOne({ id: 3, n: 1 }), e => e.code === 121);
    await execute(ddl);
    assert.equal((await database.collection('migrata').findOne({ id: 1 }))[phase], 7);
    assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(), 0);
    await execute('UPDATE migrata SET n=n WHERE id=1');
  }
  console.log('  OK   Interruzione prima/dopo il commit: recupero durabile e nessuna doppia applicazione');
  const originalSession = client.startSession.bind(client); let transactions = 0;
  client.startSession = (...args) => {
    const session = originalSession(...args), transact = session.withTransaction.bind(session);
    session.withTransaction = async (...params) => {
      const result = await transact(...params);
      if (++transactions === 2) throw new Error('Risposta persa dopo il commit DDL');
      return result;
    };
    return session;
  };
  try { await execute('ALTER TABLE migrata ADD COLUMN confermata INT DEFAULT 9'); }
  finally { client.startSession = originalSession; }
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).confermata, 9);
  assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(), 0);
  await execute('CREATE TABLE log_trigger(id INT,n INT)');
  await execute('CREATE TRIGGER traccia AFTER UPDATE ON migrata FOR EACH ROW INSERT INTO log_trigger VALUES(NEW.id,OLD.n)');
  await execute('UPDATE migrata SET n=10 WHERE id=1');
  assert.deepEqual((await execute('SELECT id,n FROM log_trigger')).docs, [{ id: 1, n: 1 }]);
  await assert.rejects(execute('UPDATE migrata SET n=11 WHERE id=1', protectedStrategy(['read', 'write'], ['migrata'])), /Permesso negato/);
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).n, 10);
  await execute('CREATE PROCEDURE interna() BEGIN UPDATE migrata SET n=99 WHERE id=1; END');
  await execute('CREATE PROCEDURE esterna() BEGIN CALL interna(); END');
  await assert.rejects(execute('CALL esterna()', protectedStrategy(['read'])), /Permesso negato/);
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).n, 10);
  console.log('  OK   Trigger e CALL annidate rispettano gli scope e non elevano i privilegi');
  await execute("CREATE TABLE enumerata(stato ENUM('si','no'))");
  await assert.rejects(database.collection('enumerata').insertOne({ stato: 'forse' }), e => e.code === 121);
  await execute('CREATE PROCEDURE ritorna() BEGIN LOOP RETURN; END LOOP; UPDATE migrata SET n=99 WHERE id=1; END');
  await execute('CALL ritorna()');
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).n, 10);
  await execute('CREATE TABLE senza_segno(n BIGINT UNSIGNED)');
  await execute('INSERT INTO senza_segno VALUES(18446744073709551615)');
  assert.deepEqual((await execute('SELECT CAST(n AS TEXT) AS n FROM senza_segno')).docs, [{ n: '18446744073709551615' }]);
  await execute('DROP TRIGGER traccia ON migrata');
  await assert.rejects(strategy.mongoSqlSchema(db, 'migrata', { sql: 'ALTER TABLE migrata ADD COLUMN annullata INT DEFAULT 1', opHandle: { interrotto: true } }), /annullata/);
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).annullata, undefined);
  assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(), 0);
  await assert.rejects(strategy.mongoSqlSchema(db, 'migrata', { sql: 'ALTER TABLE migrata ADD COLUMN oltre INT', maxRows: 1 }), /limite di righe/);
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).oltre, undefined);
  const increment = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await execute('UPDATE migrata SET n=n+1 WHERE id=1'); return; }
      catch (err) { if (!/Schema SQL modificato|Migrazione SQL/.test(err.message)) throw err; }
    }
    assert.fail('Scrittura non completata dopo il cambio di schema');
  };
  await Promise.all([execute('ALTER TABLE migrata ADD COLUMN concorrente INT DEFAULT 7'), ...Array.from({ length: 6 }, increment)]);
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).n, 16);
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).concorrente, 7);
  console.log('  OK   Interi senza segno esatti, annullamento e ALTER concorrente con sei scritture senza perdite');
  await execute("ALTER TABLE migrata ADD COLUMN segno TEXT DEFAULT '(', ADD COLUMN libero INT");
  assert.equal((await database.collection('migrata').findOne({ id: 1 })).segno, '(');
  await execute('CREATE TABLE nomi(a INT PRIMARY KEY,b INT UNIQUE)');
  await execute('ALTER TABLE nomi DROP PRIMARY KEY');
  await execute('ALTER TABLE nomi ADD UNIQUE(a)');
  await execute('INSERT INTO nomi VALUES(1,2)');
  await assert.rejects(execute('INSERT INTO nomi VALUES(1,3)'), /E11000|duplic/i);
  if (mutant) { assert.ok(mutato); console.error(`Mutazione ${mutant} sopravvissuta.`); }
  console.log('PASS: migrazioni recuperabili, trigger, controllo di flusso e autorizzazione su MongoDB reale.');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  if (connected) { targets.assertOwned(db); await client.db(db).dropDatabase(); }
  await client.close();
});
