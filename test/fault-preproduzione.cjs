'use strict';

// Mutazioni solo in memoria: dimostrano che le regressioni riconoscono i difetti.
const Module = require('node:module');
const originale = Module.prototype._compile;
const casi = {
  byte: ['DbStrategy.js', /Buffer\.byteLength\(EJSON\.stringify\((doc|rows\[i\]), \{ relaxed: true \}\), 'utf8'\)/g, 'JSON.stringify($1).length'],
  gruppo: ['SqlToMql.js', 'pipeline.push({ $group: groupStage });', 'pipeline.push(groupStage);'],
  join: ['VirtualJoinEngine.js', 'mapB.get(bKeyStr).push(bDoc);', 'mapB.get(bKeyStr)[0] = bDoc;'],
  schema: ['schemaProgressivo.js', '.update(JSON.stringify({ collections: forma, relations }))', '.update("stesso-conteggio")'],
  transazione: ['sqlSessione.js', 'corrente?.scope || strategy', '{}'],
  riconnessione: ['../server/connessioni.js', /(err.message = `Connessione ripristinata[^;]+;\s*)throw err;/, '$1return actionFn(sess.strategy);'],
};
const caso = casi[process.env.CODEDB_TEST_PREPROD_FAULT];
if (!caso) throw new Error('Mutazione di preproduzione sconosciuta.');
Module.prototype._compile = function (sorgente, filename) {
  const target = require('node:path').resolve(__dirname, '../db', caso[0]);
  if (filename === target) sorgente = sorgente.replace(caso[1], caso[2]);
  return originale.call(this, sorgente, filename);
};
