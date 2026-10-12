'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const MongoDbStrategy = require('../db/MongoDbStrategy');
const strategy = new MongoDbStrategy();
const streams = [];
strategy.client = { db: db => ({ collection: coll => ({ watch() {
  const stream = new EventEmitter(); Object.assign(stream, { db, coll, closed: false, close: async () => { stream.closed = true; } });
  streams.push(stream); return stream;
} }) }) };
if (process.argv.includes('--mutant')) { const original = strategy.watch; strategy.watch = function(db, coll, handlers) { return original.call(this, db, coll, { ...handlers, watchId: 'default' }); }; }
const changes = [], unavailable = [];
const handlers = watchId => ({ watchId, onChange: c => changes.push([watchId, c]), onUnavailable: () => unavailable.push(watchId) });
strategy.watch('vendite', 'ordini', handlers('left'));
strategy.watch('archivio', 'ordini', handlers('right'));
assert.equal(streams[0].closed, false, 'Aprire un pannello non chiude il live dell’altro');
streams[0].emit('change', { operationType: 'insert' });
streams[1].emit('change', { operationType: 'update' });
assert.deepEqual(changes.map(([id]) => id), ['left', 'right']);
strategy.watch('nuovo', 'clienti', handlers('left'));
assert(streams[0].closed); assert(!streams[1].closed);
streams[0].emit('error', new Error('Vecchio stream'));
assert(!streams[2].closed); assert.deepEqual(unavailable, []);
streams[2].emit('error', new Error('Replica set assente'));
assert.deepEqual(unavailable, ['left']); assert(!streams[1].closed);
strategy.watch('default', 'ordini', handlers('default'));
strategy.unwatch('default'); assert(!streams[1].closed);
strategy.unwatch(); assert(streams.every(s => s.closed));
console.log('OK: watch indipendenti, cambio bersaglio, errori tardivi, fallback e rilascio completo');
