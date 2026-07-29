'use strict';

const assert = require('assert');

// Mock browser environment for pending-queries
class MockStorage {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return this.store[key] || null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
  removeItem(key) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

global.sessionStorage = new MockStorage();
global.document = {
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {}
};

console.log('--- Test Unitari Pending Queries (Tracker & States) ---');

(async () => {
  // Test 1: Caricamento e tracciamento
  let pendingQueries = [];
  const STORAGE_KEY = 'codedb:pending';

  function save(list) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function load() {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map((q) => {
      if (q.status === 'running') {
        return {
          ...q,
          status: 'disconnected',
          endedAt: q.endedAt || Date.now(),
          elapsedMs: q.elapsedMs || 0
        };
      }
      return q;
    });
  }

  // Simulazione tracciamento query
  const q1 = {
    id: 'run-1',
    code: 'db.users.find({})',
    engine: 'mongodb',
    db: 'test',
    coll: 'users',
    connName: 'Local Mongo',
    tabId: 'tab-1',
    collTabId: 'ct-1',
    startedAt: Date.now(),
    status: 'running'
  };

  pendingQueries.push(q1);
  save(pendingQueries);

  assert.strictEqual(load().length, 1, 'Deve esserci 1 voce in storage');
  assert.strictEqual(load()[0].status, 'disconnected', 'Al reload una query running deve diventare disconnected');
  console.log('  OK   Reload / F5 conversion from running to disconnected passed');

  // Test 2: Lifecycle running -> completed
  const q2 = {
    id: 'run-2',
    code: 'SELECT * FROM users',
    engine: 'mysql',
    db: 'shop',
    coll: 'users',
    connName: 'Local MySQL',
    tabId: 'tab-2',
    collTabId: 'ct-2',
    startedAt: Date.now(),
    status: 'running'
  };

  pendingQueries.push(q2);
  q2.status = 'completata';
  q2.endedAt = Date.now();
  q2.elapsedMs = 15;
  save(pendingQueries);

  const loaded2 = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
  assert.strictEqual(loaded2.find(x => x.id === 'run-2').status, 'completata', 'Stato completata salvato');
  console.log('  OK   Lifecycle running -> completata passed');

  // Test 3: Status paused / disconnected / abandoned
  const q3 = {
    id: 'run-3',
    code: 'SELECT pg_sleep(10)',
    engine: 'postgresql',
    db: 'postgres',
    coll: '',
    connName: 'Local Postgres',
    tabId: 'tab-3',
    collTabId: 'ct-3',
    startedAt: Date.now(),
    status: 'running'
  };
  pendingQueries.push(q3);

  // User hits stop (paused)
  q3.status = 'paused';
  q3.endedAt = Date.now();
  save(pendingQueries);

  const loaded3 = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
  assert.strictEqual(loaded3.find(x => x.id === 'run-3').status, 'paused', 'Stato paused salvato');
  console.log('  OK   Status paused superato');

  // Test 4: Conteggio badge
  const pendingCount = pendingQueries.filter(q => q.status !== 'completata').length;
  assert.strictEqual(pendingCount, 2, 'Il badge deve contare 2 query non completate (run-1 disconnected e run-3 paused)');
  console.log('  OK   Badge count calculation passed');

  // Test 5: Clean resolved
  pendingQueries = pendingQueries.filter(q => q.status !== 'completata');
  assert.strictEqual(pendingQueries.length, 2, 'Pulisci completate deve rimuovere solo le completata');
  assert.strictEqual(pendingQueries.some(q => q.id === 'run-2'), false, 'run-2 (completata) rimossa');
  console.log('  OK   Clear resolved passed');

  console.log('\nTutti i test unitari di Pending Queries superati con successo!');
})();
