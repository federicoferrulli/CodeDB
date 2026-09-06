'use strict';

const { EJSON } = require('bson');

// Solo queste opzioni di creazione hanno la stessa forma in collMod.
const MODIFICABILI = new Set([
  'validator', 'validationLevel', 'validationAction', 'changeStreamPreAndPostImages',
  'expireAfterSeconds', 'recordPreImages',
]);
const VALIDAZIONE = new Set(['validator', 'validationLevel', 'validationAction']);

function contiene(actual, expected) {
  if (expected && expected._bsontype) {
    return EJSON.stringify(actual, { relaxed: false }) === EJSON.stringify(expected, { relaxed: false });
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual && typeof actual === 'object'
      && Object.keys(expected).every((key) => contiene(actual[key], expected[key]));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Materializza le opzioni prima delle righe; sulle collection esistenti
 * modifica solo ciò che MongoDB permette, senza perdere quelle immutabili. */
async function preparaCollectionMongo(client, db, name, rawOptions = {}, { deferValidation = false } = {}) {
  const options = EJSON.deserialize(Object.fromEntries(Object.entries(rawOptions)
    .filter(([key]) => !deferValidation || !VALIDAZIONE.has(key))), { relaxed: false });
  const database = client.db(db);
  const infos = await database.listCollections({ name }).toArray();
  const existing = infos.find((info) => info.name === name);
  if (!existing) {
    await database.createCollection(name, options);
    return;
  }
  const current = existing.options || {};
  const changes = {};
  for (const [key, value] of Object.entries(options)) {
    if (MODIFICABILI.has(key)) {
      if (EJSON.stringify(current[key], { relaxed: false }) !== EJSON.stringify(value, { relaxed: false })) changes[key] = value;
    } else if (options.capped && (key === 'size' || key === 'max')) {
      if (!contiene(current[key], value)) changes[key === 'size' ? 'cappedSize' : 'cappedMax'] = value;
    } else if (!contiene(current[key], value)) {
      throw new Error(`La collection "${name}" ha l'opzione di creazione "${key}" incompatibile con il file.`);
    }
  }
  if (Object.keys(changes).length) await database.command({ collMod: name, ...changes });
}

module.exports = { preparaCollectionMongo };
