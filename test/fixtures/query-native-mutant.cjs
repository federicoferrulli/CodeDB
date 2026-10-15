'use strict';
// Le mutazioni vivono soltanto nel processo di prova: i sorgenti restano intatti.
const assert = require('node:assert/strict');
const mutants = {
  sessione: ['mongoOpzioni.js', 'if (session && !opzioni.session) opzioni.session = session;', 'if (false) opzioni.session = session;'],
  ddl: ['MongoDbStrategy.js', '.drop(opzioniDriver({}, {}, DbStrategy.queryTimeoutMs(this.env)))', '.drop()'],
  indici: ['mongoMetadatiShell.js', "args[0] === undefined ? '*' : args[0]", "'*'"],
  chiavi: ['mongoMetadatiShell.js', 'args[0].map(key => ({ ...args[1], key }))', 'args[0]'],
  scope: ['guardStrategy.js', 'if (spec.whole && !canWholeConnection(principal, connName, spec.cap))', 'if (false)'],
  opzioni: ['MongoDbStrategy.js', 'const opts = EJSON.deserialize(options, { relaxed: false });', 'const opts = {};'],
  precisione: ['MongoDbStrategy.js', 'const opts = EJSON.deserialize(options, { relaxed: false });', 'const opts = EJSON.deserialize(options, { relaxed: true });'],
  bson: ['MongoDbStrategy.js', 'parseQueryObject(text, fallback, !payload.nativeResult)', 'parseQueryObject(text, fallback, true)'],
  errori: ['MongoScriptRunner.js', "['name', 'code', 'codeName', 'errorLabels', 'keyPattern', 'keyValue', 'writeErrors', 'result']", '[]'],
  comandi: ['mongoComando.js', 'const command = analizza(payload.command);', 'throw new Error("Mutazione del comando nativo"); const command = analizza(payload.command);'],
};
const selected = mutants[process.env.CODEDB_NATIVE_MUTANT];
assert(selected, 'Nome della mutazione sconosciuto');
require('node:module').registerHooks({ load(url, context, next) {
  const r = next(url, context);
  if (!url.endsWith('/' + selected[0])) return r;
  assert(String(r.source).includes(selected[1]), 'Mutazione non applicata');
  return { ...r, source: String(r.source).replace(selected[1], selected[2]) };
} });
