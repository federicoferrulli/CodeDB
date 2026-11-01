'use strict';

const { documentoCanonico } = require('./mongoSchemaBson');
const uguale = (a, b) => JSON.stringify(documentoCanonico(a)) === JSON.stringify(documentoCanonico(b));

// Solo queste opzioni di creazione hanno la stessa forma in collMod.
const MODIFICABILI = new Set([
  'validator', 'validationLevel', 'validationAction', 'changeStreamPreAndPostImages',
  'expireAfterSeconds', 'recordPreImages',
]);
const VALIDAZIONE = new Set(['validator', 'validationLevel', 'validationAction']);

function contiene(actual, expected) {
  if ((expected && (expected._bsontype || expected instanceof Date || expected instanceof RegExp))
      || (actual && (actual._bsontype || actual instanceof Date || actual instanceof RegExp))) {
    return uguale(actual, expected);
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual && typeof actual === 'object'
      && Object.keys(expected).every((key) => contiene(actual[key], expected[key]));
  }
  return uguale(actual, expected);
}

/** Materializza le opzioni prima delle righe; sulle collection esistenti
 * modifica solo ciò che MongoDB permette, senza perdere quelle immutabili. */
async function preparaCollectionMongo(client, db, name, rawOptions = {}, { deferValidation = false, metadata = null } = {}) {
  const actual = require('./mongoSchemaBson').decodificaMetadati(metadata || { options: rawOptions });
  const options = Object.fromEntries(Object.entries(actual.options || {})
    .filter(([key]) => !deferValidation || !VALIDAZIONE.has(key)));
  const database = client.db(db);
  const infos = await database.listCollections({ name }, { promoteValues: false }).toArray();
  const existing = infos.find((info) => info.name === name);
  if (!existing) {
    await database.createCollection(name, options);
    return;
  }
  const current = existing.options || {};
  const changes = {};
  for (const [key, value] of Object.entries(options)) {
    if (MODIFICABILI.has(key)) {
      if (!uguale(current[key], value)) changes[key] = value;
    } else if (options.capped && (key === 'size' || key === 'max')) {
      if (!contiene(current[key], value)) changes[key === 'size' ? 'cappedSize' : 'cappedMax'] = value;
    } else if (!contiene(current[key], value)) {
      throw new Error(`La collection "${name}" ha l'opzione di creazione "${key}" incompatibile con il file.`);
    }
  }
  if (Object.keys(changes).length) await database.command({ collMod: name, ...changes });
}

module.exports = { preparaCollectionMongo };
