'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'import-status.js'), 'utf8')
  .replace('export function descriviEsitoImport', 'function descriviEsitoImport')
  + '\nthis.descriviEsitoImport = descriviEsitoImport;';
const context = {};
vm.runInNewContext(source, context);

for (const [status, label, ok] of [
  ['completato', 'Import completato e verificato', true],
  ['ripristinato_dopo_errore', 'Errore: destinazione originale ripristinata', false],
  ['intervento_richiesto', 'Errore: intervento manuale richiesto', false],
]) {
  const state = context.descriviEsitoImport(status);
  assert.strictEqual(state.label, label);
  assert.strictEqual(state.terminal, true);
  assert.strictEqual(state.ok, ok);
  assert.match(state.className, new RegExp(`esito-${status}$`));
}

console.log('  OK   UI import distingue i tre esiti terminali passed');
