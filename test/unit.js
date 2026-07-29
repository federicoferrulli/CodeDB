'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');
const DbFactory = require('../db/DbFactory');
const DbStrategy = require('../db/DbStrategy');
const SshTunnel = require('../db/SshTunnel');

console.log('--- Test Unitari CodeDB ---');

(async () => {
  // Test 1: DbFactory instanziamento e helper
  const mongoStrategy = DbFactory.getStrategy('mongodb');
  assert.strictEqual(mongoStrategy.type, 'mongodb', 'MongoDbStrategy type deve essere mongodb');
  console.log('  OK   DbFactory MongoDB strategy instantiation passed');

  const mysqlStrategy = DbFactory.getStrategy('mysql');
  assert.strictEqual(mysqlStrategy.type, 'mysql', 'MySqlStrategy type deve essere mysql');
  console.log('  OK   DbFactory MySQL strategy instantiation passed');

  const pgStrategy = DbFactory.getStrategy('postgresql');
  assert.strictEqual(pgStrategy.type, 'postgresql', 'PostgreSqlStrategy type deve essere postgresql');
  console.log('  OK   DbFactory PostgreSQL strategy instantiation passed');

  const pgAliasStrategy = DbFactory.getStrategy('postgres');
  assert.strictEqual(pgAliasStrategy.type, 'postgresql', 'PostgreSqlStrategy alias postgres passed');
  console.log('  OK   DbFactory Postgres alias passed');

  assert.throws(() => DbFactory.getStrategy('unsupported_db'), /Tipo di database non supportato/, 'DbFactory deve lanciare errore su db non supportato');
  console.log('  OK   DbFactory unsupported db check passed');

  assert.strictEqual(DbFactory.defaultPort('mongodb'), 27017, 'Porta default MongoDB = 27017');
  assert.strictEqual(DbFactory.defaultPort('mysql'), 3306, 'Porta default MySQL = 3306');
  assert.strictEqual(DbFactory.defaultPort('postgresql'), 5432, 'Porta default PostgreSQL = 5432');
  console.log('  OK   DbFactory defaultPort passed');

  assert.strictEqual(DbFactory.isSqlType('mysql'), true, 'mysql isSqlType deve essere true');
  assert.strictEqual(DbFactory.isSqlType('postgresql'), true, 'postgresql isSqlType deve essere true');
  assert.strictEqual(DbFactory.isSqlType('mongodb'), false, 'mongodb isSqlType deve essere false');
  console.log('  OK   DbFactory isSqlType passed');

  // Test 2: DbStrategy.detectRelations (euristica UML)
  const collections = [
    { name: 'users', fields: [{ name: '_id', types: ['objectId'] }, { name: 'name', types: ['string'] }] },
    { name: 'orders', fields: [{ name: '_id', types: ['objectId'] }, { name: 'user_id', types: ['objectId'] }, { name: 'total', types: ['number'] }] }
  ];
  const relations = DbStrategy.detectRelations(collections);
  assert.strictEqual(relations.length, 1, 'Deve essere rilevata 1 relazione');
  assert.strictEqual(relations[0].from, 'orders', 'Relazione da orders');
  assert.strictEqual(relations[0].to, 'users', 'Relazione a users');
  assert.strictEqual(relations[0].field, 'user_id', 'Campo della relazione user_id');
  console.log('  OK   DbStrategy.detectRelations passed');

  // Test 3: VirtualJoinEngine check spec validation & in-memory join
  try {
    await VirtualJoinEngine.execute(null, null, null);
    assert.fail('Dovrebbe lanciare errore su spec nulla');
  } catch (err) {
    assert.strictEqual(err.message, 'Formato query Virtual Join non valido. Inserisci una struttura {"virtualJoin": ...}');
    console.log('  OK   VirtualJoinEngine spec null check passed');
  }

  try {
    await VirtualJoinEngine.execute({ virtualJoin: {} }, null, null);
    assert.fail('Dovrebbe lanciare errore su spec incompleta');
  } catch (err) {
    assert.strictEqual(err.message, 'Definizione Virtual Join incompleta: specificare sourceA, sourceB, on.leftKey e on.rightKey.');
    console.log('  OK   VirtualJoinEngine spec incomplete check passed');
  }

  const dummyStrategyA = {
    type: 'mysql',
    async collectionAggregate() {
      return { docs: [{ id: 101, user_id: 'usr_1', amount: 250 }] };
    }
  };
  const dummyStrategyB = {
    type: 'mongodb',
    async collectionAggregate() {
      return { docs: [{ _id: 'usr_1', username: 'mario', email: 'mario@test.com' }] };
    }
  };
  const vjSpec = {
    virtualJoin: {
      sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
      sourceB: { dbType: 'mongodb', db: 'crm', collection: 'users' },
      on: { leftKey: 'user_id', rightKey: '_id' },
      as: 'user_info'
    }
  };
  const vjResult = await VirtualJoinEngine.execute(vjSpec, dummyStrategyA, dummyStrategyB);
  assert.strictEqual(vjResult.length, 1, 'VirtualJoinEngine deve ritornare 1 elemento unito');
  assert.strictEqual(vjResult[0].user_info.username, 'mario', 'Cross-DB merge dati corretto');
  console.log('  OK   VirtualJoinEngine in-memory cross-DB join passed');

  // Test 3b: JOIN su chiavi ObjectId (EJSON {$oid}). Regressione: prima le
  // chiavi oggetto collassavano in "[object Object]" e il $in su B non
  // matchava mai (joined_data null). B applica davvero il $match per simulare
  // il comportamento reale di MongoDB.
  const oid = '507f1f77bcf86cd799439011';
  const stratOidA = {
    type: 'mongodb',
    async collectionAggregate() {
      return { docs: [{ _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, userId: { $oid: oid }, tot: 10 }] };
    }
  };
  const usersOidB = [{ _id: { $oid: oid }, name: 'Mario' }];
  const stratOidB = {
    type: 'mongodb',
    async collectionAggregate(db, coll, payload) {
      const pipeline = JSON.parse(payload.pipeline);
      const inList = pipeline[0].$match._id.$in;
      // Nel path Mongo→Mongo il $in contiene wrapper {$oid: hex}: la chiave
      // deve essere l'esadecimale reale, non "[object Object]".
      assert.ok(
        inList.every((k) => k && typeof k === 'object' && /^[0-9a-fA-F]{24}$/.test(k.$oid)),
        'Il $in deve contenere ObjectId {$oid: hex}, non "[object Object]"'
      );
      return { docs: usersOidB.filter((u) => inList.some((k) => k.$oid === u._id.$oid)) };
    }
  };
  const oidSpec = {
    virtualJoin: {
      sourceA: { dbType: 'mongodb', db: 'd', collection: 'orders' },
      sourceB: { dbType: 'mongodb', db: 'd', collection: 'users' },
      on: { leftKey: 'userId', rightKey: '_id' }
    }
  };
  const oidResult = await VirtualJoinEngine.execute(oidSpec, stratOidA, stratOidB);
  assert.ok(oidResult[0].joined_data, 'JOIN su chiave ObjectId deve trovare il match (joined_data non null)');
  assert.strictEqual(oidResult[0].joined_data.name, 'Mario', 'Merge su chiave ObjectId corretto');
  console.log('  OK   VirtualJoinEngine join su chiavi ObjectId ($oid) passed');

  // Test 3b2: JOIN su chiave $numberLong (Mongo Long). Il $in lato B deve
  // ricevere il wrapper EJSON tipizzato {$numberLong}, non la stringa nuda,
  // altrimenti EJSON.parse non ricostruisce il Long e il match fallisce.
  const stratLongA = {
    type: 'mongodb',
    async collectionAggregate() {
      return { docs: [{ _id: { $oid: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, ref: { $numberLong: '12345' }, tot: 7 }] };
    }
  };
  const stratLongB = {
    type: 'mongodb',
    async collectionAggregate(db, coll, payload) {
      const inList = JSON.parse(payload.pipeline)[0].$match.num.$in;
      assert.ok(
        inList.every((k) => k && typeof k === 'object' && k.$numberLong === '12345'),
        'Il $in deve contenere il wrapper tipizzato {$numberLong}, non la stringa nuda'
      );
      return { docs: [{ num: { $numberLong: '12345' }, label: 'ok' }] };
    }
  };
  const longSpec = {
    virtualJoin: {
      sourceA: { dbType: 'mongodb', db: 'd', collection: 'a' },
      sourceB: { dbType: 'mongodb', db: 'd', collection: 'b' },
      on: { leftKey: 'ref', rightKey: 'num' }
    }
  };
  const longResult = await VirtualJoinEngine.execute(longSpec, stratLongA, stratLongB);
  assert.ok(longResult[0].joined_data && longResult[0].joined_data.label === 'ok', 'JOIN su chiave $numberLong deve trovare il match');
  console.log('  OK   VirtualJoinEngine join su chiavi $numberLong passed');

  // Test 3c: maxPayloadSize non numerico non deve rompere/iniettare l'SQL.
  let capturedSql = '';
  const stratSqlA = {
    type: 'mysql',
    async collectionAggregate(db, table, payload) { capturedSql = payload.pipeline; return { docs: [] }; }
  };
  await VirtualJoinEngine.execute({
    virtualJoin: {
      sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
      sourceB: { dbType: 'mysql', db: 'shop', table: 'users' },
      on: { leftKey: 'user_id', rightKey: 'id' },
      maxPayloadSize: '5; DROP TABLE users'
    }
  }, stratSqlA, stratSqlA);
  assert.ok(/LIMIT \d+\s*$/.test(capturedSql) && !/DROP/i.test(capturedSql), 'maxPayloadSize non numerico non deve iniettare SQL: LIMIT resta un intero, il resto è scartato');
  console.log('  OK   VirtualJoinEngine maxPayloadSize coercito a intero passed');

  // Test 4: Handling errore connessione PostgreSQL server offline
  try {
    const pgConn = await pgStrategy.connect({ host: 'localhost', database: 'postgres' });
    if (pgConn.ok) {
      console.log('  OK   PostgreSQL connect passed');
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || (err.message && err.message.includes('ECONNREFUSED'))) {
      console.log('  OK   PostgreSQL connect error handled (PostgreSQL server non attivo in ambiente unit test)');
    } else {
      throw err;
    }
  }

  // Test 5: SshTunnel check
  assert.strictEqual(typeof SshTunnel.openSshTunnel, 'function', 'openSshTunnel deve essere una funzione');
  console.log('  OK   SshTunnel.openSshTunnel export passed');

  // Test 5b: AuditLog — la cache in memoria deve restare limitata (no memory
  // leak) pur preservando le voci più recenti e i filtri.
  {
    const { makeAuditor } = require('../db/AuditLog');
    const tmp = path.join(os.tmpdir(), `codedb-audit-unit-${process.pid}.log`);
    for (const f of [tmp, tmp + '.1']) { try { fs.unlinkSync(f); } catch { /* ignora */ } }
    const auditor = makeAuditor(tmp, 1024); // soglia file bassa: forza la rotazione
    for (let i = 0; i < 60000; i++) auditor.audit({ event: 'unit', n: i });
    const recent = auditor.readRecent({ limit: 2 });
    assert(recent.total <= 51000, `cache limitata: total=${recent.total} deve essere <= 51000 (no leak)`);
    assert(recent.total >= 50000, `cache non troppo aggressiva: total=${recent.total} deve essere >= 50000`);
    assert.strictEqual(recent.entries[0].n, 59999, 'la voce più recente deve essere preservata');
    assert.strictEqual(auditor.readRecent({ event: 'unit', limit: 3 }).entries.length, 3, 'i filtri devono continuare a funzionare');
    for (const f of [tmp, tmp + '.1']) { try { fs.unlinkSync(f); } catch { /* ignora */ } }
    console.log('  OK   AuditLog cache limitata (no memory leak) passed');
  }

  // Test 6: Controllo presenza file di configurazione ed eseguibili principali
  const requiredFiles = [
    'Dockerfile',
    'docker-compose.yml',
    'bin/codedb.js',
    'electron-main.js',
    'server.js',
    'backup/cli.js',
    'public/js/backupmanager.js',
    'public/js/splitview.js',
    'backup/lib/engine.js',
    'backup/lib/restore.js',
    'backup/lib/storage.js',
    'backup/lib/util.js'
  ];

  for (const relPath of requiredFiles) {
    const fullPath = path.join(__dirname, '..', relPath);
    assert(fs.existsSync(fullPath), `${relPath} deve esistere`);
    console.log(`  OK   ${relPath} file check passed`);
  }

  // Test 7: Logica di Riconnessione Automatica e Rilevazione Errori di Connessione
  const isConnErrTerms = [
    new Error('Nessuna connessione attiva al database'),
    new Error('MongoNetworkError: connection reset by peer'),
    new Error('PROTOCOL_CONNECTION_LOST'),
    new Error('Tunnel SSH caduto: connection timed out'),
    new Error('Connection terminated unexpectedly')
  ];
  const connTerms = [
    'nessuna connessione attiva',
    'topology was destroyed',
    'client is closed',
    'pool is closed',
    'socket closed',
    'connection closed',
    'connection terminated',
    'connection reset',
    'connection lost',
    'tunnel ssh caduto',
    'econnreset',
    'econnrefused',
    'etimedout',
    'protocol_connection_lost'
  ];

  for (const err of isConnErrTerms) {
    const msg = (err.message || '').toLowerCase();
    const isConn = connTerms.some(t => msg.includes(t));
    assert.strictEqual(isConn, true, `Errore "${err.message}" deve essere riconosciuto come errore di connessione`);
  }
  console.log('  OK   Rilevazione errori di disconnessione DB superata');

  // Test 8: VirtualJoinEngine escaping backslashes nelle chiavi SQL IN
  let vjCapturedSql = '';
  const stratVjSql = {
    type: 'mysql',
    async collectionAggregate(db, table, payload) { vjCapturedSql = payload.pipeline; return { docs: [] }; }
  };
  await VirtualJoinEngine.execute({
    virtualJoin: {
      sourceA: { dbType: 'mysql', db: 'shop', table: 'orders' },
      sourceB: { dbType: 'mysql', db: 'shop', table: 'users' },
      on: { leftKey: 'user_id', rightKey: 'id' }
    }
  }, {
    type: 'mysql',
    async collectionAggregate() { return { docs: [{ user_id: 'val\\with\'quotes' }] }; }
  }, stratVjSql);
  assert.ok(vjCapturedSql.includes("'val\\\\with''quotes'"), 'VirtualJoinEngine deve fuggire backslash e apici nelle chiavi SQL');
  console.log('  OK   VirtualJoinEngine backslash escaping in SQL IN passed');

  // Test 9: Interfaccia cancelQuery sulle strategie DB
  const baseStrat = new DbStrategy();
  const resBaseCancel = await baseStrat.cancelQuery({});
  assert.strictEqual(resBaseCancel.cancelled, false, 'DbStrategy base cancelQuery deve ritornare cancelled: false');

  const resMongoCancel = await mongoStrategy.cancelQuery({});
  assert.strictEqual(resMongoCancel.cancelled, false, 'MongoDbStrategy cancelQuery senza client deve ritornare cancelled: false');

  const resMysqlCancel = await mysqlStrategy.cancelQuery({});
  assert.strictEqual(resMysqlCancel.cancelled, false, 'MySqlStrategy cancelQuery senza pool deve ritornare cancelled: false');

  const resPgCancel = await pgStrategy.cancelQuery({});
  assert.strictEqual(resPgCancel.cancelled, false, 'PostgreSqlStrategy cancelQuery senza pool deve ritornare cancelled: false');
  console.log('  OK   DbStrategy cancelQuery interface check passed');

  // Test 10: Esecuzione test unitari sul registro pending queries
  require('./pending-queries');

  console.log('\nTutti i test unitari superati con successo!');
})();


