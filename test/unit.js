'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');
const DbFactory = require('../db/DbFactory');

console.log('--- Test Unitari CodeDB ---');

(async () => {
  // Test 1: VirtualJoinEngine check spec validation
  try {
    await VirtualJoinEngine.execute(null, null, null);
    assert.fail('Dovrebbe lanciare errore su spec nulla');
  } catch (err) {
    assert.strictEqual(err.message, 'Formato query Virtual Join non valido. Inserisci una struttura {"virtualJoin": ...}');
    console.log('  OK   VirtualJoinEngine spec null check passed');
  }

  // Test 2: DbFactory PostgreSQL
  const pgStrategy = DbFactory.getStrategy('postgresql');
  assert.strictEqual(pgStrategy.type, 'postgresql');
  console.log('  OK   DbFactory PostgreSQL strategy instantiation passed');

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

  console.log('\nTutti i test unitari superati con successo!');
})();
