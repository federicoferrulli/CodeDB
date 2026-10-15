'use strict';
const assert = require('node:assert/strict');
if (process.argv.includes('--mutant=quorum')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/sqlAlterMongo.js')) return result;
  const from = "commitQuorum: 'majority'";
  assert.ok(String(result.source).includes(from), 'Mutazione quorum non applicata');
  return { ...result, source: String(result.source).replace(from, "commitQuorum: 'votingMembers'") };
} });
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoClient } = require('mongodb');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const { guardStrategy } = require('../auth/guardStrategy');
const { makePrincipal } = require('../auth/principal');
const { createE2eTargetRegistry } = require('./e2e-harness');
const sql = require('../db/SqlToMql');
const targets = createE2eTargetRegistry({ destructive: true, prefix: 'codedb_sql_failover' }), db = targets.target('mongo');
const container = process.env.CODEDB_E2E_FAILOVER_CONTAINER;
const separate = process.env.CODEDB_E2E_FAILOVER_NODES === '1';
const client = new MongoClient('mongodb://127.0.0.1:27039,127.0.0.1:27040,127.0.0.1:27041/?replicaSet=codedbtest', { monitorCommands: true, serverSelectionTimeoutMS: 20000, writeConcern: { w: 'majority' } });
const base = new MongoDbStrategy({ env: { CODEDB_AGGREGATE_TIMEOUT_MS: '60000' } }); base.client = client;
process.env.CODEDB_RBAC = 'on';
const strategy = guardStrategy(base, { connName: 'test', principal: makePrincipal({ _id: 'test', type: 'subuser', ownerId: 'owner' },
  [{ connName: 'test', capabilities: ['read', 'write', 'delete', 'ddl'], scope: { databases: [db], collections: ['*'] } }]) });
async function execute(text) {
  const procedures = require('../db/sqlProcedureMongo');
  if (procedures.riconosci(text)) return strategy.mongoSqlProcedure(db, procedures.parse(text).name, { sql: text });
  const triggers = require('../db/sqlTriggerMongo');
  if (triggers.riconosci(text)) return strategy.mongoSqlTrigger(db, triggers.parse(text).coll, { sql: text });
  const plan = sql.looksLikeSql(text) ? sql.translate(text) : sql.translateWrite(text);
  return strategy[plan.kind === 'ddl' ? 'mongoSqlSchema' : plan.kind === 'write' ? 'mongoSqlReturning' : 'mongoSqlRead'](db, plan.coll, { sql: text });
}
let connected = false, stopped;
function control(action, port) {
  assert.ok([27039, 27040, 27041].includes(port));
  if (separate) {
    const name = `codedb-sql-node-${port}`;
    const info = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true }))[0];
    assert.equal(info.Config.Labels['codedb.test'], 'sql-replica', 'Il nodo deve appartenere al fixture isolato.');
    const command = action === 'stop' ? ['kill', '--signal=KILL', name] : ['start', name];
    execFileSync('docker', command, { timeout: 30000, windowsHide: true });
    return;
  }
  assert.equal(container, 'codedb-sql-failover-mongo', 'Il test può arrestare soltanto il container isolato documentato.');
  execFileSync('docker', ['exec', container, 'bash', '/sql-failover-start.sh', action, String(port)], { timeout: 30000, windowsHide: true });
}
async function healthy() {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const status = await client.db('admin').command({ replSetGetStatus: 1 });
    if (status.members.every(m => [1, 2].includes(m.state) && m.health === 1)) return;
    await delay(200);
  }
  throw new Error('I tre membri non sono tornati disponibili.');
}
(async () => {
  targets.assertOwned(db); if (!separate) assert.equal(container, 'codedb-sql-failover-mongo');
  await client.connect(); connected = true; await healthy();
  const database = client.db(db), admin = client.db('admin');
  const config = (await admin.command({ replSetGetConfig: 1 })).config;
  assert.equal(config._id, 'codedbtest');
  const hosts = config.members.map(m => m.host).sort();
  const porte = [27039, 27040, 27041];
  const attesi = separate ? porte.map(p => `codedb-sql-node-${p}:${p}`) : porte.map(p => `127.0.0.1:${p}`);
  // Anche il vecchio fixture a tre container resta utilizzabile; mai un cluster arbitrario.
  const legacy = separate && hosts.every((host, i) => host === `host.docker.internal:${porte[i]}`);
  if (!legacy) assert.deepEqual(hosts, attesi);
  const phases = process.argv.includes('--mutant=quorum') ? ['indice'] : ['barriera', 'prima_riga', 'commit', 'trigger_mql', 'indice', 'indice_commit', 'dipendenza', 'dipendenza_commit', 'savepoint', 'dominio', 'dominio_commit', 'routine_commit', 'native_savepoint', 'trigger_state_commit', 'routine_nested_commit', 'dominio_validate_commit', 'cascade_before', 'cascade_commit'];
  const selected = process.argv.find(a => a.startsWith('--phase='))?.slice(8);
  if (selected) { assert.ok(phases.includes(selected), 'Fase di failover sconosciuta.'); phases.splice(0, phases.length, selected); }
  for (const phase of phases) {
    if (phase.startsWith('dominio')) await execute(`CREATE DOMAIN ${phase}_tipo AS INT CHECK(VALUE>0)`);
    await execute(`CREATE TABLE ${phase}(id INT PRIMARY KEY,n ${phase.startsWith('dominio') ? phase+'_tipo' : 'INT'})`);
    await execute(`INSERT INTO ${phase} VALUES(1,10),(2,20)`);
    if (phase.startsWith('dominio')) {
      await execute(`CREATE TABLE ${phase}_altro(id INT PRIMARY KEY,n ${phase}_tipo)`);
      await execute(`INSERT INTO ${phase}_altro VALUES(1,10)`);
    }
    if (phase === 'routine_commit') await execute('CREATE PROCEDURE routine_failover() LANGUAGE SQL BEGIN ATOMIC INSERT INTO routine_commit(id,n) VALUES(3,30); END');
    if (phase === 'routine_nested_commit') await execute('CREATE PROCEDURE nested_failover() LANGUAGE SQL BEGIN ATOMIC INSERT INTO routine_nested_commit(id,n) SELECT 3,d.n+10 FROM (SELECT n FROM routine_nested_commit WHERE id=2) d; END');
    if (phase === 'dominio_validate_commit') await execute(`ALTER DOMAIN ${phase}_tipo ADD CONSTRAINT sotto_trenta CHECK(VALUE<30) NOT VALID`);
    if (phase === 'trigger_state_commit') {
      await execute('CREATE TABLE state_log(n INT)');
      await execute('CREATE TRIGGER state_trigger AFTER UPDATE ON trigger_state_commit FOR EACH ROW INSERT INTO state_log VALUES(NEW.n)');
    }
    if (phase === 'native_savepoint') {
      await execute('ALTER TABLE native_savepoint ADD COLUMN a INT[]');
      await execute('UPDATE native_savepoint SET a=ARRAY[n]');
      await database.collection(phase).createIndex({a:1},{unique:true,name:'native_array'});
      await execute(`CREATE PROCEDURE native_failover() LANGUAGE plpgsql AS $$ BEGIN SAVEPOINT punto;
        INSERT INTO native_savepoint VALUES(3,30,ARRAY[30]);
        BEGIN INSERT INTO native_savepoint VALUES(4,40,ARRAY[10]); EXCEPTION WHEN unique_violation THEN INSERT INTO native_savepoint VALUES(5,50,ARRAY[50]); END;
        ROLLBACK TO punto; UPDATE native_savepoint SET n=n+2; END $$`);
    }
    if (phase.startsWith('indice')) await database.collection(phase).createIndex({ n: 1 }, { name: 'prima', unique: true });
    if (phase.startsWith('dipendenza')) {
      await execute(`CREATE TABLE ${phase}_figli(id INT PRIMARY KEY,pid INT REFERENCES ${phase}(id))`);
      await execute(`INSERT INTO ${phase}_figli VALUES(1,1)`);
    }
    if (phase === 'savepoint') {
      await execute('CREATE TABLE audit_savepoint(n INT)');
      await execute('CREATE TRIGGER salva_update AFTER UPDATE ON savepoint FOR EACH ROW INSERT INTO audit_savepoint VALUES(NEW.n)');
      await execute('CREATE PROCEDURE prova_savepoint() BEGIN SAVEPOINT punto; UPDATE savepoint SET n=n+1; ROLLBACK TO punto; UPDATE savepoint SET n=n+2; END');
    }
    if (phase === 'trigger_mql') {
      await execute('CREATE TABLE audit_failover(id INT,n INT)');
      await execute('CREATE TRIGGER prima_failover BEFORE UPDATE ON trigger_mql FOR EACH ROW SET NEW.n=NEW.n+1');
      await execute('CREATE TRIGGER dopo_failover AFTER UPDATE ON trigger_mql FOR EACH ROW INSERT INTO audit_failover VALUES(NEW.id,NEW.n)');
    }
    let fired = false, oldPrimary, watchdog, scadenza, restoredEarly = false;
    const progresso = () => { if (!restoredEarly) watchdog?.refresh(); };
    client.on('commandSucceeded', progresso);
    if (phase.startsWith('cascade')) {
      await execute(`CREATE DOMAIN ${phase}_tipo AS INT CHECK(VALUE>0)`);
      await execute(`ALTER TABLE ${phase} ALTER COLUMN n TYPE ${phase}_tipo`);
      await execute(`CREATE TABLE ${phase}_other(id INT PRIMARY KEY,n ${phase}_tipo UNIQUE)`);
      await execute(`INSERT INTO ${phase}_other VALUES(1,10)`);
      await execute(`CREATE PROCEDURE ${phase}_proc(p ${phase}_tipo) BEGIN INSERT INTO ${phase}_other VALUES(2,p); END`);
    }
    async function crash() {
      if (fired) return;
      fired = true; oldPrimary = (await admin.command({ hello: 1 })).primary;
      stopped = Number(oldPrimary.split(':')[1]); control('stop', stopped);
      // Verifica la nuova elezione, non basta che il driver accetti una query.
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        try {
          const hello = await admin.command({ hello: 1 });
          if (hello.isWritablePrimary && hello.primary !== oldPrimary) {
            // Un indice in attesa del quorum non avanza; due indici validi possono
            // invece superare insieme 20 s su disco carico. Misuriamo l'inattività,
            // senza perdere un limite totale contro retry che non terminano mai.
            const ripristina = () => {
              if (restoredEarly) return;
              restoredEarly = true; control('start', stopped); stopped = null;
            };
            watchdog = setTimeout(ripristina, 20000);
            scadenza = setTimeout(ripristina, 120000);
            console.log(`  OK   ${phase}: arrestato ${oldPrimary}, eletto ${hello.primary}`); return;
          }
        } catch (err) { if (Date.now() >= until) throw err; }
        await delay(100);
      }
      throw new Error('Nessun nuovo primario eletto.');
    }
    const originalDb = client.db.bind(client), originalSession = client.startSession.bind(client);
    client.db = (...args) => {
      const d = originalDb(...args), command = d.command.bind(d), collection = d.collection.bind(d);
      d.command = async (cmd, opts) => {
        const result = await command(cmd, opts);
        if (phase === 'barriera' && cmd.collMod === phase && cmd.validator?.$and?.some(c => c.$expr?.$eq?.[1] === 0)) await crash();
        if (phase === 'dipendenza' && cmd.collMod === `${phase}_figli` && cmd.validator?.$and?.some(c => c.$expr?.$eq?.[1] === 0)) await crash();
        if (phase === 'dominio' && cmd.collMod === `${phase}_altro` && cmd.validator?.$and?.some(c => c.$expr?.$eq?.[1] === 0)) await crash();
        if (phase === 'cascade_before' && cmd.collMod === `${phase}_other` && cmd.validator?.$and?.some(c => c.$expr === false)) await crash();
        return result;
      };
      d.collection = (name, opts) => {
        const c = collection(name, opts), replace = c.replaceOne.bind(c), update = c.updateOne.bind(c), createIndexes = c.createIndexes.bind(c), remove = c.deleteMany.bind(c), insert=c.insertOne.bind(c);
        c.insertOne=async (...params)=>{const result=await insert(...params);if(phase==='native_savepoint'&&name.startsWith('_codedb_sql_probe_')&&params[0].id===3)await crash();return result;};
        c.deleteMany = async (...params) => {
          const result = await remove(...params);
          if (phase === 'savepoint' && name === phase) await crash();
          return result;
        };
        c.createIndexes = async (...params) => {
          const result = await createIndexes(...params);
          if (phase === 'indice' && name === phase && params[0].some(i => i.name === 'dopo')) await crash();
          return result;
        };
        c.replaceOne = async (...params) => {
          const result = await replace(...params);
          if (phase === 'prima_riga' && name === phase && params[2]?.bypassDocumentValidation) await crash();
          return result;
        };
        c.updateOne = async (...params) => {
          const result = await update(...params);
          if (phase === 'trigger_mql' && name === '_codedb_sql_trigger_stage') await crash();
          return result;
        };
        return c;
      };
      return d;
    };
    client.startSession = (...args) => {
      const session = originalSession(...args), transact = session.withTransaction.bind(session);
      session.withTransaction = async (...params) => {
        const result = await transact(...params);
        if (['commit', 'indice_commit', 'dipendenza_commit', 'dominio_commit', 'routine_commit', 'trigger_state_commit', 'routine_nested_commit', 'dominio_validate_commit', 'cascade_commit'].includes(phase) && await database.collection('_codedb_sql_migrations').findOne({ _id: /:commit$/ })) await crash();
        return result;
      };
      return session;
    };
    const text = phase.startsWith('cascade')?`DROP DOMAIN ${phase}_tipo CASCADE`
      : phase==='dominio_validate_commit'?`ALTER DOMAIN ${phase}_tipo VALIDATE CONSTRAINT sotto_trenta`
      : phase==='trigger_state_commit'?'ALTER TABLE trigger_state_commit DISABLE TRIGGER state_trigger'
      : phase==='native_savepoint'?'CALL native_failover()'
      : phase.startsWith('dominio') ? `ALTER DOMAIN ${phase}_tipo ADD CONSTRAINT sotto_trenta CHECK(VALUE<30)`
      : phase.startsWith('dipendenza') || phase.startsWith('routine_') ? `ALTER TABLE ${phase} RENAME COLUMN id TO nuovo`
      : phase === 'savepoint' ? 'CALL prova_savepoint()'
        : phase.startsWith('indice') ? `ALTER TABLE ${phase} RENAME INDEX prima TO dopo` : `ALTER TABLE ${phase} ALTER COLUMN n TYPE BIGINT USING n+1`;
    try {
      if (phase === 'trigger_mql') await strategy.shellWrite(db, phase, { op: 'updateOne', filter: '{"id":1}', update: '{"$inc":{"n":1}}' });
      else await execute(text);
      assert.ok(fired, 'Il failover deve essere avvenuto davvero nel punto previsto.');
      assert.equal(restoredEarly, false, 'Migrazione senza progressi per oltre 20 secondi o durata oltre 120 secondi con un nodo offline.');
    } finally {
      clearTimeout(watchdog); clearTimeout(scadenza); client.removeListener('commandSucceeded', progresso);
      client.db = originalDb; client.startSession = originalSession;
    }
    if (phase.startsWith('cascade')) {
      assert.deepEqual((await execute(`SELECT id FROM ${phase} ORDER BY id`)).docs,[{id:1},{id:2}]);
      assert.deepEqual((await execute(`SELECT id FROM ${phase}_other`)).docs,[{id:1}]);
      assert.deepEqual((await require('../db/sqlSchemaMongo').leggi(database,`${phase}_other`)).columns.map(c=>c.name),['id']);
      assert.equal(await database.collection('_codedb_sql_domains').countDocuments({_id:`${phase}_tipo`}),0);
      assert.equal(await database.collection('_codedb_sql_procedures').countDocuments({_id:`${phase}_proc`}),0);
      assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(),0);
      await execute(`INSERT INTO ${phase}_other VALUES(2)`);
      await assert.rejects(execute(`INSERT INTO ${phase}_other VALUES(2)`),/duplic|E11000/i);
      control('start',stopped); stopped=null; await healthy();
      console.log(`  OK   ${phase}: CASCADE atomico, dati conservati e cataloghi recuperati`);continue;
    }
    const id = phase.startsWith('dipendenza') || phase.startsWith('routine_') ? 'nuovo' : 'id';
    assert.deepEqual((await execute(`SELECT ${id} AS id,n FROM ${phase} ORDER BY ${id}`)).docs,
      ['savepoint','native_savepoint'].includes(phase) ? [{ id: 1, n: 12 }, { id: 2, n: 22 }] : phase === 'trigger_mql' ? [{ id: 1, n: 12 }, { id: 2, n: 20 }] : phase.startsWith('indice') || phase.startsWith('dipendenza') || phase.startsWith('dominio') || phase.startsWith('routine_') || phase==='trigger_state_commit' ? [{ id: 1, n: 10 }, { id: 2, n: 20 }] : [{ id: 1, n: 11 }, { id: 2, n: 21 }]);
    if (phase.startsWith('dominio')) {
      await assert.rejects(execute(`INSERT INTO ${phase} VALUES(3,30)`), /validation/i);
      await assert.rejects(database.collection(`${phase}_altro`).insertOne({id:2,n:30}), /validation/i);
      assert.equal((await database.collection('_codedb_sql_domains').findOne({_id:`${phase}_tipo`})).definition.checks.length, 2);
    }
    if (phase === 'routine_commit') {
      await execute('CALL routine_failover()');
      assert.deepEqual((await execute('SELECT nuovo,n FROM routine_commit WHERE nuovo=3')).docs, [{nuovo:3,n:30}]);
    }
    if (phase === 'routine_nested_commit') { await execute('CALL nested_failover()'); assert.deepEqual((await execute('SELECT nuovo,n FROM routine_nested_commit WHERE nuovo=3')).docs,[{nuovo:3,n:30}]); }
    if (phase === 'trigger_state_commit') {
      await execute('UPDATE trigger_state_commit SET n=n WHERE id=1'); assert.equal(await database.collection('state_log').countDocuments(),0);
      await execute('ALTER TABLE trigger_state_commit ENABLE TRIGGER state_trigger'); await execute('UPDATE trigger_state_commit SET n=n WHERE id=1');
      assert.deepEqual((await execute('SELECT n FROM state_log')).docs,[{n:10}]);
    }
    if (phase === 'native_savepoint') assert.equal(await database.listCollections({name:/^_codedb_sql_probe_/}).hasNext(),false);
    if (phase.startsWith('dipendenza')) {
      const schema = await require('../db/sqlSchemaMongo').leggi(database, `${phase}_figli`);
      assert.deepEqual(schema.constraints.find(c => c.kind === 'FOREIGN').references.columns, ['nuovo']);
      await execute(`INSERT INTO ${phase}_figli VALUES(2,2)`);
      await assert.rejects(execute(`INSERT INTO ${phase}_figli VALUES(3,99)`), /FOREIGN KEY/);
    }
    if (phase === 'savepoint') assert.deepEqual((await execute('SELECT n FROM audit_savepoint ORDER BY n')).docs, [{ n: 12 }, { n: 22 }]);
    if (phase.startsWith('indice')) {
      const indexes = await database.collection(phase).listIndexes().toArray();
      assert.ok(indexes.some(i => i.name === 'dopo' && i.unique)); assert.ok(!indexes.some(i => i.name === 'prima'));
      await assert.rejects(execute(`INSERT INTO ${phase} VALUES(3,10)`), /duplic|E11000/i);
    }
    if (phase === 'trigger_mql') {
      assert.deepEqual((await execute('SELECT id,n FROM audit_failover')).docs, [{ id: 1, n: 12 }]);
      assert.equal(await database.collection('_codedb_sql_trigger_stage').countDocuments(), 0);
    }
    assert.equal(await database.collection('_codedb_sql_migrations').countDocuments(), 0);
    await execute(`UPDATE ${phase} SET n=n+1 WHERE ${id}=1`);
    await assert.rejects(execute(`INSERT INTO ${phase}(${id},n) VALUES(1,1)`), /duplic|E11000/i);
    control('start', stopped); stopped = null; await healthy();
    console.log(`  OK   ${phase}: conversione applicata una volta, registro vuoto, indici e scritture ripristinati`);
  }
  console.log(`\n${phases.length} failover reali ${separate ? 'con arresto del container primario (tre container distinti)' : 'del processo primario'} superati.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    if (stopped) { control('start', stopped); stopped = null; }
    if (connected) { await healthy(); targets.assertOwned(db); await client.db(db).dropDatabase(); }
  } finally { await client.close(); }
});
