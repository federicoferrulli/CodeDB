'use strict';

const crypto = require('crypto');
const { stringifyRiga, parseRiga } = require('../../db/codecFedele');
const { chiaveIdentita } = require('./identity');
const { identitaDellaRiga } = require('./tombstones');
const { readLines, fileDelBackup, verifyBackupDir } = require('./util');

// I marcatori casuali sono un dettaglio del trasporto PostgreSQL. Si leggono
// soltanto nelle colonne che il catalogo ha dichiarato riferimenti: un JSON o
// una stringa uguale a un marcatore resta un dato dell'utente.
function rigaStabile(row, file) {
  let stable = row;
  for (const column of file.columnSchema || []) {
    if (!column.references || row[column.name]?.$pgReference?.kind !== 'nested') continue;
    if (stable === row) stable = { ...row };
    stable[column.name] = require('../../db/pg-alias').identitaStabile(row[column.name], column.references);
  }
  return stable;
}

function chiaveRiga(row, file) {
  return chiaveIdentita(rigaStabile(row, file), file.identity);
}

function hashRiga(row, file) {
  const hash = crypto.createHash('sha256');
  if (file.encoding === require('../../db/mongoBson').ENCODING) {
    // Il BSON binario distingue ordine dei documenti, tipi numerici e tag
    // EJSON letterali senza deserializzare e ricostruire il documento.
    return hash.update(require('../../db/mongoBson').decode(row)).digest('hex');
  }
  const stable = rigaStabile(row, file);
  return hash.update(stringifyRiga(file.columns.map(name => stable[name]))).digest('hex');
}

// Ricostruisce lo stato di una SINGOLA collection lungo la catena già verificata.
// Permette al motore di backup di processare una tabella alla volta: picco RAM
// O(tabella più grande) invece di O(intero database).
async function caricaStatoCollezione(chain, collection, controllo) {
  let state = new Map();
  let esiste = false;
  for (const layer of chain) {
    if ((layer.manifest.entityInventory?.removed || []).includes(collection)) {
      state = new Map();
      esiste = false;
    }
    const dataFile = layer.manifest.files.find(file => file.kind === 'data' && file.collection === collection);
    const tombstoneFiles = layer.manifest.files.filter(file => file.kind === 'tombstones' && file.collection === collection);
    if (dataFile) {
      esiste = true;
      if (dataFile.mode === 'full') state = new Map();
    }
    const files = [...tombstoneFiles, ...(dataFile ? [dataFile] : [])];
    for (const original of files) {
      const file = { ...dataFile, ...original, columnSchema: original.columnSchema || dataFile?.columnSchema };
      let count = 0;
      const seen = new Set();
      for await (const line of readLines(fileDelBackup(layer.dir, file.path))) {
        await controllo.avanza(file.collection, ++count, 'lettura-base');
        let row = file.encoding === require('../../db/mongoBson').ENCODING ? JSON.parse(line) : parseRiga(line);
        if (!file.identity) continue;
        if (file.identity.kind === 'mongodb-id' && file.encoding !== require('../../db/mongoBson').ENCODING) {
          row = require('../../db/mongoBson').encode(row);
        }
        const key = chiaveRiga(row, file);
        if (seen.has(key)) throw new Error(`Identità duplicata nella base "${file.collection}".`);
        seen.add(key);
        if (file.kind === 'tombstones') state.delete(key);
        else state.set(key, {
          identity: identitaDellaRiga(row, file.identity),
          hash: module.exports.hashRiga(row, file.identity.kind === 'mongodb-id' ? { ...file, encoding: require('../../db/mongoBson').ENCODING } : file),
        });
      }
      if (count !== file.count) throw new Error(`Conteggio non valido nella base "${file.collection}": ${count}/${file.count}.`);
    }
    if (dataFile) {
      const expected = dataFile.replayCardinality ?? (dataFile.mode === 'full' ? dataFile.count : null);
      if (dataFile.identity && expected != null && state.size !== expected) {
        throw new Error(`Identità della catena non coerenti con la cardinalità di "${dataFile.collection}".`);
      }
    }
  }
  return esiste ? state : undefined;
}

// Verifica l'intera catena una sola volta e restituisce un indice leggero
// (O(numero di tabelle) in RAM) che carica le righe una collection alla volta.
async function preparaCatena(backupDir, controllo) {
  const chain = require('./restore').resolveChain(backupDir);
  const attive = new Set();
  for (const layer of chain) {
    await controllo.avanza(null, 0, 'verifica-base', true);
    const integrity = await verifyBackupDir(layer.dir);
    if (!integrity.valid) {
      throw new Error(`La base ${layer.manifest.id} non supera la verifica di integrità.`);
    }
    for (const nome of layer.manifest.entityInventory?.removed || []) attive.delete(nome);
    for (const file of layer.manifest.files) {
      if (file.kind === 'data' && file.collection) attive.add(file.collection);
    }
  }
  return {
    has: (name) => attive.has(name),
    keys: () => attive.keys(),
    carica: (name) => (attive.has(name) ? caricaStatoCollezione(chain, name, controllo) : Promise.resolve(undefined)),
  };
}

async function caricaStatoCatena(backupDir, controllo) {
  const catena = await preparaCatena(backupDir, controllo);
  const states = new Map();
  for (const name of catena.keys()) {
    const state = await catena.carica(name);
    if (state) states.set(name, state);
  }
  return states;
}

function creaDelta(previous, file, { incremental = false, explicit = false } = {}) {
  const remaining = previous || new Map();
  const snapshot = !incremental || !file.identity;
  let scanned = 0, emitted = 0, replay = remaining.size;
  return {
    considera(row, selected = true) {
      scanned += 1;
      if (!file.identity) { emitted += 1; return true; }
      const key = chiaveRiga(row, file);
      const before = remaining.get(key);
      remaining.delete(key);
      const emit = snapshot || (explicit ? selected : !before || before.hash !== module.exports.hashRiga(row, file));
      if (emit) { emitted += 1; if (!before) replay += 1; }
      return emit;
    },
    conclude(sourceCardinality) {
      if (scanned !== sourceCardinality) throw new Error(`Scansione incompleta di "${file.collection}": ${scanned}/${sourceCardinality}.`);
      const tombstones = file.identity ? [...remaining.values()].map(entry => entry.identity) : [];
      const replayCardinality = snapshot ? scanned : replay - remaining.size;
      remaining.clear();
      return {
        tombstones, replayCardinality,
        content: { version: 1, mode: snapshot ? 'snapshot' : explicit ? 'explicit-filter' : 'content-delta', complete: snapshot || !explicit },
        scanned, emitted,
      };
    },
  };
}

module.exports = { rigaStabile, chiaveRiga, hashRiga, preparaCatena, caricaStatoCollezione, caricaStatoCatena, creaDelta };
