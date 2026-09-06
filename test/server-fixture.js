'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ROOT_PRINCIPAL } = require('../auth/principal');
const { contestoFinto } = require('./contesto-finto');

function politiche() {
  return require('../server/audit').createModule({
    config: { env: {}, rootDir: path.join(__dirname, '..') },
    dependencies: { makeAuditor: () => ({ audit() {}, readRecent() { return []; }, flush: async () => {}, statoSalute: () => ({}) }) },
    errori: require('../server/errori').createModule({}),
  });
}

/** Invoca i registratori reali: nessuna estrazione o esecuzione di sorgente modificato. */
function catalogoEventi() {
  const result = [];
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'server')).filter(f => /^eventi-.*\.js$/.test(f))) {
    const lifecycle = Object.fromEntries(['safeOn', 'delegate', 'amministrativo', 'operazioneLunga']
      .map(famiglia => [famiglia, (evento, handler) => result.push({ evento, famiglia, handler, file })]));
    require('../server/' + file).createModule({})(contestoFinto(), lifecycle);
  }
  return result;
}

function giuntura(registratori, overrides = {}) {
  const io = new EventEmitter();
  io.sockets = { sockets: new Map() };
  io.engine = { clientsCount: 0 };
  return require('../server/socket').createModule({
    config: { env: {}, rbacOn: () => false },
    trasporto: { io },
    budget: require('../server/budget').createModule({}),
    lock: require('../server/lock').createModule({}),
    errori: require('../server/errori').createModule({}),
    audit: politiche(),
    identita: { principalOf: () => ROOT_PRINCIPAL },
    query: { SERVER_ONLY_PAYLOAD_FIELDS: ['maxRows', 'opHandle'] },
    connessioni: { executeWithReconnect: (sess, fn) => fn(sess.strategy), teardownConnection: async () => {} },
    registratori, ...overrides,
  });
}

module.exports = { politiche, catalogoEventi, giuntura };
