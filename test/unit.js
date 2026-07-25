'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
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

  // Test 6: Controllo presenza file di configurazione ed eseguibili principali
  const requiredFiles = [
    'Dockerfile',
    'docker-compose.yml',
    'bin/codedb.js',
    'electron-main.js',
    'server.js',
    'backup/cli.js'
  ];

  for (const relPath of requiredFiles) {
    const fullPath = path.join(__dirname, '..', relPath);
    assert(fs.existsSync(fullPath), `${relPath} deve esistere`);
    console.log(`  OK   ${relPath} file check passed`);
  }

  console.log('\nTutti i test unitari superati con successo!');
})();

