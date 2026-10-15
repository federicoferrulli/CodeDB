'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const contesto = new AsyncLocalStorage();

// Ogni richiesta ha il proprio catalogo: nessuna cache globale può conservare
// un vecchio CHECK o mescolare domini omonimi di database diversi.
function avvolgi(fn, payloadIndex) {
  return async function (...args) {
    const [client, db] = args;
    if (contesto.getStore()?.db === db) return fn(...args);
    const payload = args[payloadIndex], session = payload?.[require('./sqlMongoContesto').SESSION];
    if (payload?.opHandle?.interrotto) throw new Error('Query SQL annullata.');
    const database = client.db(db), options = session ? { session } : {};
    const docs = await database.collection('_codedb_sql_domains').find({}, options).toArray();
    const definitions = new Map(docs.map(d => [d._id, d.definition])), resolved = new Map();
    for (const name of definitions.keys()) for (const array of [false, true]) {
      const schema = { columns: [{ name: 'value', domain: name, nullable: true, array }], constraints: [] };
      try {
        await require('./sqlDominiMongo').risolvi(database, schema, definitions, options);
        resolved.set(`${name}:${array}`, schema.columns[0]);
      } catch (error) { resolved.set(`${name}:${array}`, { error }); }
    }
    return contesto.run({ db, definitions, resolved, active: new Set() }, () => fn(...args));
  };
}
function emetti(descriptor, input) {
  const context = contesto.getStore();
  // La traduzione preliminare (editor, autorizzazione) non accede al DB. Il
  // runtime ricompila sotto il catalogo prima di mandare comandi al driver.
  if (!context) return { $codedbCastDomain: { descriptor, input } };
  const key = `${descriptor.domain}:${!!descriptor.array}`, column = context.resolved.get(key);
  if (!column) throw new Error(`Dominio SQL inesistente: ${descriptor.domain}.`);
  if (column.error) throw column.error;
  if (['JSON','ENUM','UUID'].includes(column.type)) throw new Error(`CAST al dominio ${descriptor.domain}: conversione del tipo base ${column.type} non ancora traducibile.`);
  if (context.active.has(key)) throw new Error('Dipendenza ciclica fra CAST e CHECK di dominio.');
  context.active.add(key);
  try {
    const api = require('./sqlArrayMongo');
    const check = value => {
      let result = '$$elementoDominio';
      for (const c of column.domainChecks || []) {
        const expr = require('./sqlEspressioni').emettiEspressione(c.expr, () => '$elementoDominio');
        result = api.richiedi({ $ne: [expr, false] }, result, '23514', `violazione del CHECK ${c.name} del dominio ${descriptor.domain}`);
      }
      return { $let: { vars: { elementoDominio: value }, in: result } };
    };
    const converted = require('./sqlSchemaMongo').convertiValore({ ...column, cast: true }, input);
    let result = column.elementDomain ? { $cond: [{ $eq: ['$$dominio', null] }, null, api.converti('$$dominio', value => api.richiedi(
      column.elementDomainNotNull ? { $ne: [value, null] } : true, check(value), '23502', 'il dominio non ammette NULL'))] } : check('$$dominio');
    if (!column.nullable) result = api.richiedi({ $ne: ['$$dominio', null] }, result, '23502', 'il dominio non ammette NULL');
    return { $let: { vars: { dominio: converted }, in: result } };
  } finally { context.active.delete(key); }
}
async function aggiorna(database, name, definition) {
  const context = contesto.getStore(); if (!context) return;
  context.definitions.set(name, definition);
  for (const domain of context.definitions.keys()) for (const array of [false, true]) {
    const schema = { columns: [{ name: 'value', domain, nullable: true, array }], constraints: [] };
    try {
      await require('./sqlDominiMongo').risolvi(database, schema, context.definitions);
      context.resolved.set(`${domain}:${array}`, schema.columns[0]);
    } catch (error) { context.resolved.set(`${domain}:${array}`, { error }); }
  }
}
module.exports = { avvolgi, emetti, aggiorna };
