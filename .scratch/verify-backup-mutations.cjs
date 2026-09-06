'use strict';

// Mutazioni solo nel caricatore del processo di prova: i sorgenti restano intatti.
const fs = require('fs');
const Module = require('module');
const path = require('path');
const mutation = process.argv[2];
const transformations = {
  rollback: ['db/importPlan.js', (s) => s.replace("if (name !== 'rollback') annullata(signal);", 'annullata(signal);')],
  metadati: ['public/js/exportimport.js', (s) => s.replace(
    "const aux = await emit('collection:auxddl', { tabId, db, coll: c.name });",
    "const aux = await emit('collection:auxddl', { tabId, db, coll: c.name }).catch(() => ({ indexes: [], foreignKeys: [] }));")],
  eventi: ['backup/lib/engine.js', (s) => s.replace(
    /(const \[events\] = await conn.query\([\s\S]*?)(\);)/, '$1).catch(() => [[]]);')],
  opzioni: ['db/mongoCollectionOptions.js', (s) => s.replace('database.createCollection(name, options)', 'database.createCollection(name, {})')],
  ricevuta: ['public/js/exportimport.js', (s) => s.replaceAll('uncertain += batch.length;', 'failed += batch.length;')],
  driver: ['db/importFailure.js', (s) => s.replace('if (uncertain)', 'if (false && uncertain)')],
};
const [file, transform] = transformations[mutation];
const target = path.resolve(__dirname, '..', file);
const originalRead = fs.readFileSync;
let hits = 0;
fs.readFileSync = function (filename, ...args) {
  const data = originalRead.call(this, filename, ...args);
  if (typeof filename !== 'string' || path.resolve(filename) !== target) return data;
  const changed = transform(data.toString());
  if (changed !== data.toString()) hits++;
  return Buffer.isBuffer(data) ? Buffer.from(changed) : changed;
};
const originalLoader = Module._extensions['.js'];
Module._extensions['.js'] = function (module, filename) {
  if (path.resolve(filename) === target) return module._compile(fs.readFileSync(filename, 'utf8'), filename);
  return originalLoader(module, filename);
};
require('../test/unit-backup-import-regressioni');
process.on('exit', () => {
  if (!hits) { console.error('Mutazione non applicata:', mutation); process.exitCode = 2; }
});
