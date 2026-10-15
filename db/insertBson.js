'use strict';

const B = require('bson');
const { DocumentSequence } = require('mongodb/lib/cmap/commands');

function validaWrapper(value) {
  for (const [key, min, max] of [['$numberInt', -2147483648n, 2147483647n], ['$numberLong', -9223372036854775808n, 9223372036854775807n]]) {
    if (!Object.hasOwn(value, key)) continue;
    const text = value[key];
    if (typeof text !== 'string' || !/^[+-]?\d+$/.test(text)) throw new Error(`${key}: serve un intero scritto come stringa.`);
    if (BigInt(text) < min || BigInt(text) > max) throw new Error(`${key}: intero fuori intervallo.`);
  }
  if (Object.hasOwn(value, '$numberDouble') && (typeof value.$numberDouble !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^(?:NaN|[+-]?Infinity)$/.test(value.$numberDouble))) throw new Error('$numberDouble non valido.');
  if (value.$binary) {
    const { base64, subType } = value.$binary;
    if (typeof base64 !== 'string' || Buffer.from(base64, 'base64').toString('base64') !== base64 || !/^[0-9a-f]{2}$/i.test(subType || '') || Object.keys(value.$binary).length !== 2) throw new Error('Binary non valido: controlla base64 e sottotipo a due cifre.');
  }
  if (value.$timestamp) {
    if (Object.keys(value.$timestamp).length !== 2 || !['t', 'i'].every(k => Number.isInteger(value.$timestamp[k]) && value.$timestamp[k] >= 0 && value.$timestamp[k] <= 4294967295)) throw new Error('Timestamp BSON: t e i devono essere interi senza segno a 32 bit.');
  }
  if (value.$regularExpression && (typeof value.$regularExpression.pattern !== 'string' || typeof value.$regularExpression.options !== 'string' || !/^[imsux]*$/.test(value.$regularExpression.options))) throw new Error('Espressione regolare BSON non valida.');
}

function documento(elements) {
  const data = Buffer.concat([Buffer.alloc(4), ...elements, Buffer.from([0])]);
  data.writeInt32LE(data.length);
  if (data.length > 16 * 1024 * 1024) throw new Error('Il documento supera il limite BSON di 16 MiB.');
  return data;
}

function elemento(name, value, depth, dataIsoBson) {
  if (depth > 100) throw new Error('Il documento supera 100 livelli di annidamento.');
  if (name.includes('\0')) throw new Error('Il nome di un campo non può contenere NUL.');
  const field = (tag, bytes = Buffer.alloc(0)) => Buffer.concat([Buffer.from([tag]), Buffer.from(name + '\0'), bytes]);
  const obj = value && typeof value === 'object' && !Array.isArray(value);
  if (obj && Object.keys(value).length === 1 && value.$undefined === true) return field(6);
  if (obj && Object.keys(value).length === 1 && value.$dbPointer) {
    const ptr = value.$dbPointer;
    if (typeof ptr.$ref !== 'string' || !/^[0-9a-f]{24}$/i.test(ptr.$id?.$oid || '') || Object.keys(ptr).length !== 2) throw new Error('DBPointer non valido: servono $ref e $id.$oid.');
    return field(12, Buffer.concat([B.serialize({ x: ptr.$ref }).subarray(7, -1), Buffer.from(ptr.$id.$oid, 'hex')]));
  }
  if (obj && Object.keys(value).length === 1 && value.$date && typeof value.$date === 'object') {
    const text = value.$date.$numberLong;
    if (typeof text !== 'string' || !/^-?\d+$/.test(text) || Object.keys(value.$date).length !== 1) throw new Error('Data BSON non valida: servono millisecondi interi a 64 bit.');
    const n = BigInt(text);
    if (n < -9223372036854775808n || n > 9223372036854775807n) throw new Error('Data BSON fuori intervallo a 64 bit.');
    const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(n);
    return field(9, bytes);
  }
  if (obj && typeof value.$code === 'string' && value.$scope != null && Object.keys(value).length === 2) {
    if (Array.isArray(value.$scope) || typeof value.$scope !== 'object') throw new Error('Lo scope del codice deve essere un documento.');
    const code = B.serialize({ x: value.$code }).subarray(7, -1);
    const scope = documento(Object.entries(value.$scope).map(([k, v]) => elemento(k, v, depth + 1, dataIsoBson)));
    const bytes = Buffer.concat([Buffer.alloc(4), code, scope]); bytes.writeInt32LE(bytes.length);
    return field(15, bytes);
  }
  const wrapper = obj && Object.keys(value).some(k => /^\$(?:oid|date|numberInt|numberLong|numberDouble|numberDecimal|binary|uuid|regularExpression|timestamp|code|symbol|minKey|maxKey|undefined|dbPointer)$/.test(k));
  if (wrapper) {
    validaWrapper(value);
    if (typeof value.$date === 'string') dataIsoBson(value.$date);
    const native = B.EJSON.deserialize(value, { relaxed: false });
    if (!native || typeof native !== 'object' || (!native._bsontype && !(native instanceof Date))) throw new Error(`Valore Extended JSON non valido nel campo "${name}".`);
    if (native instanceof Date && !Number.isFinite(native.getTime())) throw new Error('Data BSON non valida.');
    const encoded = B.serialize({ [name]: native });
    return encoded.subarray(4, -1);
  }
  if (value && typeof value === 'object') {
    return field(Array.isArray(value) ? 4 : 3, documento(Object.entries(value).map(([k, v]) => elemento(k, v, depth + 1, dataIsoBson))));
  }
  return B.serialize({ [name]: value }).subarray(4, -1);
}

async function preparaDocumenti(text) {
  const { leggiJsonEsatto, campiJson, dataIsoBson } = await import('../public/js/insert-json.mjs');
  const input = leggiJsonEsatto(text);
  const multiplo = Array.isArray(input);
  const docs = multiplo ? input : [input];
  if (!docs.length) throw new Error('Serve un elenco non vuoto di documenti.');
  // Controlla anche i duplicati alla radice prima che JSON.parse li sovrascriva.
  if (!multiplo) campiJson(text);
  const ids = [];
  const raw = docs.map(doc => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Serve un elenco non vuoto di documenti JSON.');
    if (Object.keys(doc).length === 1 && /^\$(?:date|oid|numberInt|numberLong|numberDouble|numberDecimal|binary|uuid|timestamp|minKey|maxKey)$/.test(Object.keys(doc)[0])) throw new Error('Serve un elenco non vuoto di documenti, non un valore BSON scalare.');
    if (!Object.hasOwn(doc, '_id')) doc = { _id: { $oid: new B.ObjectId().toHexString() }, ...doc };
    const bytes = documento(Object.entries(doc).map(([k, v]) => elemento(k, v, 0, dataIsoBson)));
    B.deserialize(bytes, { promoteValues: false, validation: { utf8: true } });
    ids.push(doc._id);
    return bytes;
  });
  return { raw, ids, multiplo };
}

async function inserisciBson(client, db, coll, text, options = {}, triggers = null) {
  const { raw, ids, multiplo } = await preparaDocumenti(text);
  const database = client.db(db);
  const writeConcern = database.writeConcern;
  if (writeConcern?.w === 0) throw new Error('Inserimento senza conferma disabilitato dalla connessione: usa writeConcern w=1 o superiore per conoscere l’esito.');
  let insertedCount = 0;
  if (triggers) await triggers.statement('BEFORE', 'INSERT');
  for (let offset = 0; offset < raw.length;) {
    const start = offset;
    const sequence = new DocumentSequence('documents');
    let bytes = 0;
    while (offset < raw.length && sequence.documents.length < 100000 && (bytes === 0 || bytes + raw[offset].length < 32 * 1024 * 1024)) {
      if (triggers?.hasBefore('INSERT')) {
        raw[offset] = await triggers.beforeRaw('INSERT', null, raw[offset]);
        ids[offset] = B.EJSON.serialize(B.deserialize(require('./mongoBson').inspect(raw[offset]).id, { promoteValues: false })._id, { relaxed: false });
      }
      sequence.push({}, raw[offset]); bytes += raw[offset++].length;
      if (triggers?.hasBefore('INSERT')) break;
    }
    let result;
    try {
      result = await database.command({ insert: coll, documents: sequence, ordered: true, ...(writeConcern && !options.session ? { writeConcern } : {}) }, options);
    } catch (error) {
      error.auditResult = { insertedCount, insertedIds: ids.slice(0, insertedCount).map(id => JSON.stringify(id)) };
      throw error;
    }
    insertedCount += result.n || 0;
    if (result.writeErrors?.length || result.writeConcernError) {
      const error = new Error(result.writeErrors?.[0]?.errmsg || `Conferma di scrittura non ricevuta: ${result.writeConcernError.errmsg}. Verifica i documenti prima di riprovare.`);
      error.auditResult = { insertedCount, insertedIds: ids.slice(0, insertedCount).map(id => JSON.stringify(id)) };
      throw error;
    }
    if (triggers) await triggers.dopo([], raw.slice(start, offset).map(doc => B.deserialize(require('./mongoBson').inspect(doc).id, { promoteValues: false })._id));
  }
  if (triggers) await triggers.statement('AFTER', 'INSERT');
  return multiplo ? { insertedCount, insertedIds: ids.map(id => JSON.stringify(id)) }
    : { insertedId: JSON.stringify(ids[0]) };
}

module.exports = { preparaDocumenti, inserisciBson };
