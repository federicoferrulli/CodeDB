'use strict';

const BSON = require('bson');
const { inspect } = require('./mongoBson');
const opzioni = { relaxed: false };
const lettura = { promoteValues: false, bsonRegExp: true, validation: { utf8: true } };

function ejson(value) {
  const testo = BSON.EJSON.stringify(value, opzioni);
  const riletto = BSON.EJSON.parse(testo, opzioni);
  if (!BSON.serialize({ v: riletto }).equals(BSON.serialize({ v: value }))) throw new Error('EJSON ambiguo');
  return `bson(${JSON.stringify(testo)})`;
}

function letterale(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(letterale).join(', ')}]`;
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    // Una proprietà calcolata conserva anche "__proto__". Per il DBMS "$oid"
    // può essere un normale nome di campo anziché il tag di un ObjectId.
    return `({${Object.entries(value).map(([k, v]) => `[${JSON.stringify(k)}]: ${letterale(v)}`).join(', ')}})`;
  }
  return ejson(value);
}

function espressioneBson(raw, contesto = 'metadati') {
  try {
    const doc = BSON.deserialize(raw, lettura);
    // Un documento con chiavi duplicate, o un tipo storico non rappresentabile
    // in JavaScript, deve rimanere nel contenitore BSON grezzo.
    if (!BSON.serialize(doc).equals(raw)) throw new Error('BSON diverso dopo la rilettura');
    try { return ejson(doc); }
    catch { return letterale(doc); }
  } catch {
    throw new Error(`Il BSON di "${contesto}" non si può rappresentare fedelmente in mongosh. Usa il formato completo .codedb.json.`);
  }
}

// Stessa operazione per il driver e per il file mongosh. Il solo confine
// diverso è la funzione che invia il comando e ne attende la risposta.
async function applicaDocumento(comando, modo, nome, doc) {
  const filtro = { _id: { $eq: doc._id } };
  if (modo === 'mantieni') {
    const ricerca = await comando({ find: nome, filter: filtro, projection: { _id: 1 }, limit: 1, singleBatch: true });
    if (ricerca.cursor.firstBatch.length) return 'mantenuti';
  }
  let richiesta;
  if (modo === 'inserisci' || modo === 'mantieni') {
    // Il comando non aggiunge un _id alle misure time-series che ne sono prive.
    richiesta = { insert: nome, documents: [doc] };
  } else if (modo === 'aggiorna' || modo === 'sostituisci') {
    // Anche i nomi punteggiati e i valori che sembrano operatori sono dati.
    const valori = [{ $literal: doc }, { _id: '$_id' }];
    if (modo === 'aggiorna') valori.unshift('$$ROOT');
    richiesta = { update: nome, updates: [{ q: filtro, u: [{ $replaceWith: { $mergeObjects: valori } }], upsert: true }] };
  } else throw new Error('Modalità di scrittura dei documenti MongoDB non supportata.');
  const esito = await comando(richiesta);
  const errore = esito.writeConcernError || esito.writeErrors?.[0];
  if (errore || Number(esito.ok) !== 1) {
    // Un concorrente può aver inserito lo stesso _id dopo la prima lettura.
    const chiave = errore?.keyPattern || errore?.errInfo?.keyPattern;
    if (modo === 'mantieni' && !esito.writeConcernError && Number(errore?.code) === 11000
        && Object.keys(chiave || {}).length === 1 && Object.hasOwn(chiave, '_id')) return 'mantenuti';
    throw new Error(errore?.errmsg || esito.errmsg || 'Scrittura MongoDB non riuscita.');
  }
  if (Number(esito.n) !== 1) throw new Error('Il server MongoDB non ha confermato la scrittura del documento.');
  if (richiesta.insert || esito.upserted?.length) return 'inseriti';
  if (!Number(esito.nModified)) return 'mantenuti';
  return modo === 'aggiorna' ? 'aggiornati' : 'sostituiti';
}

function preamboloMongosh(plan) {
  return `// Esportazione CodeDB. Eseguire il file con mongosh collegato alla destinazione.
(async () => {
  const destinazione = db.getSiblingDB(${JSON.stringify(plan.sourceDb)});
  const bson = testo => EJSON.parse(testo, { relaxed: false });
  const applica = ${applicaDocumento.toString()};
  const scrivi = (nome, doc) => applica(cmd => destinazione.runCommand(cmd), ${JSON.stringify(plan.opzioniMongo.documenti)}, nome, doc);
`;
}

function documentoMongosh(raw, nome, timeSeries) {
  if (!Buffer.isBuffer(raw)) raw = BSON.serialize(raw);
  if (!timeSeries) inspect(raw);
  return `  await scrivi(${JSON.stringify(nome)}, ${espressioneBson(raw, nome)});\n`;
}

module.exports = { preamboloMongosh, documentoMongosh, espressioneBson, applicaDocumento };
