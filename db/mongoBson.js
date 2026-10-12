'use strict';

const BSON = require('bson');
// Il driver non espone insert di BSON grezzo nell'API pubblica. Questo seam è
// verificato dai roundtrip reali e resta confinato al trasporto, senza fork del driver.
const { DocumentSequence } = require('mongodb/lib/cmap/commands');
const ENCODING = 'bson-base64';

function document(elements) {
  const size = 5 + elements.reduce((n, b) => n + b.length, 0);
  const head = Buffer.alloc(4); head.writeInt32LE(size);
  return Buffer.concat([head, ...elements, Buffer.from([0])], size);
}

function inspect(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 5 || raw.length > 16 * 1024 * 1024 || raw.readInt32LE() !== raw.length) throw new Error('Documento BSON non valido.');
  const elements = BSON.onDemand.parseToElements(raw);
  const ids = elements.filter(e => raw.toString('utf8', e[1], e[1] + e[2]) === '_id');
  if (ids.length !== 1) throw new Error('Il documento BSON deve contenere un solo _id.');
  // Valida anche documenti annidati, lunghezze e UTF-8; non riusa i valori convertiti.
  BSON.deserialize(raw, { promoteValues: false, validation: { utf8: true } });
  const e = ids[0];
  return { id: document([raw.subarray(e[1] - 1, e[3] + e[4])]), columns: elements.map(e => raw.toString('utf8', e[1], e[1] + e[2])) };
}

function encode(value) {
  const raw = Buffer.isBuffer(value) ? value : BSON.serialize(value);
  const { id } = inspect(raw);
  return { _id: { $binary: { base64: id.toString('base64'), subType: '00' } }, bson: raw.toString('base64') };
}

function decode(value) {
  if (!value || typeof value.bson !== 'string') throw new Error('Documento BSON base64 non valido.');
  const raw = Buffer.from(value.bson, 'base64');
  if (raw.toString('base64') !== value.bson) throw new Error('Documento BSON base64 non valido.');
  const { id } = inspect(raw);
  if (id.toString('base64') !== value._id?.$binary?.base64) throw new Error('Identità BSON diversa dal documento dichiarato.');
  return raw;
}

function decodeId(value) {
  const encoded = value?._id?.$binary?.base64;
  if (typeof encoded !== 'string') throw new Error('Identità BSON assente.');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded || inspect(raw).columns.length !== 1) throw new Error('Identità BSON non valida.');
  return raw;
}

function checkWrite(response) {
  if (response.writeConcernError) {
    const error = new Error(`Esito di scrittura BSON incerto: ${response.writeConcernError.errmsg}`);
    error.importOutcomeUnknown = true;
    throw error;
  }
}

async function deleteRows(client, db, coll, rows) {
  const sequence = new DocumentSequence('deletes');
  for (const row of rows) sequence.push({}, document([
    Buffer.concat([Buffer.from([3, 113, 0]), decodeId(row)]),
    Buffer.from([16, ...Buffer.from('limit\0'), 1, 0, 0, 0]),
  ]));
  const response = await client.db(db).command({ delete: coll, deletes: sequence, ordered: true });
  checkWrite(response);
  if (response.writeErrors?.length) throw new Error(response.writeErrors.map(e => e.errmsg).join('; '));
}

async function importRows(client, db, coll, rows, upsert = false) {
  if (!Array.isArray(rows)) throw new Error('Documenti BSON non validi.');
  let inserted = 0;
  const errors = [];
  for (let offset = 0; offset < rows.length;) {
    const sequence = new DocumentSequence(upsert ? 'updates' : 'documents');
    let count = 0, bytes = 0;
    while (offset < rows.length && count < 500) {
      const raw = decode(rows[offset]);
      if (count && bytes + raw.length > 8 * 1024 * 1024) break;
      const encoded = upsert ? document([
        Buffer.concat([Buffer.from([3, 113, 0]), inspect(raw).id]),
        Buffer.concat([Buffer.from([3, 117, 0]), raw]),
        Buffer.from([8, ...Buffer.from('upsert\0'), 1]),
      ]) : raw;
      sequence.push({}, encoded); bytes += encoded.length; count++; offset++;
    }
    const response = await client.db(db).command({ [upsert ? 'update' : 'insert']: coll, [sequence.field]: sequence, ordered: false });
    checkWrite(response);
    inserted += response.n || 0;
    for (const error of response.writeErrors || []) if (errors.length < 10) errors.push(`Documento ${offset - count + error.index + 1}: ${error.errmsg}`);
  }
  return { inserted, failed: rows.length - inserted, errors };
}

module.exports = { ENCODING, encode, decode, decodeId, inspect, importRows, deleteRows };
