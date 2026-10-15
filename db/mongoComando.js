'use strict';
const { EJSON, calculateObjectSize } = require('bson');
const DbStrategy = require('./DbStrategy');
const { opzioniDriver } = require('./mongoOpzioni');
const { assertNoMongoServerJs } = require('../auth/capabilities');

// La grammatica del comando appartiene al server. I campi di sessione invece
// appartengono al driver: accettarli dal testo aggirerebbe l'isolamento del run.
function analizza(text) {
  const command = typeof text === 'string' ? EJSON.parse(text, { relaxed: false }) : text;
  if (!command || typeof command !== 'object' || Array.isArray(command) || !Object.keys(command).length) {
    throw new Error('runCommand richiede un documento non vuoto.');
  }
  for (const key of ['lsid', 'txnNumber', 'autocommit', 'startTransaction', '$db']) {
    if (Object.hasOwn(command, key)) throw new Error(`Il campo ${key} è gestito dalla sessione: usa startSession().`);
  }
  assertNoMongoServerJs(command, 'Comando MongoDB');
  if (Object.keys(command)[0] === 'explain') analizza(command.explain);
  if (['eval', '$eval', 'mapReduce', 'mapreduce'].includes(Object.keys(command)[0])) {
    throw new Error('I comandi che eseguono JavaScript lato server non sono consentiti. Usa una pipeline di aggregazione.');
  }
  return command;
}
async function esegui(client, db, payload, env) {
  const command = analizza(payload.command);
  const options = opzioniDriver({}, payload, DbStrategy.queryTimeoutMs(env));
  // maxTimeMS è un campo del comando, non un'opzione del metodo Db.command.
  // I comandi di controllo non accettano tutti comment/maxTimeMS.
  const name = Object.keys(command)[0];
  const controlli = new Set(['ping', 'hello', 'isMaster', 'ismaster', 'buildInfo', 'buildinfo', 'listCommands', 'endSessions', 'killCursors', 'getMore']);
  if (!controlli.has(name)) {
    if (options.maxTimeMS) command.maxTimeMS = Number(command.maxTimeMS) > 0 ? Math.min(Number(command.maxTimeMS), options.maxTimeMS) : options.maxTimeMS;
    if (options.comment !== undefined) command.comment = command.comment === undefined ? options.comment : { codedbRunId: payload.runId, comment: command.comment };
  }
  const result = await client.db(db).command(command, { session: options.session });
  if (calculateObjectSize(result) > DbStrategy.maxResultBytes(env)) throw new Error('Risultato del comando MongoDB oltre il limite di byte. Riduci il batch.');
  const serializzato = require('./mongoEjson').serializza(result);
  if (result.cursor?.id?._bsontype === 'Long') serializzato.cursor.id = EJSON.serialize(result.cursor.id, { relaxed: false });
  return serializzato;
}
module.exports = { analizza, esegui };
