'use strict';

const { Query } = require('pg');
const { serializeRow } = require('./sqlValori');

// Il driver decodifica un pacchetto alla volta. Dopo il tetto continua a
// consumare il protocollo senza trattenere né serializzare il resto delle righe.
class RigheSql {
  constructor(fields, limit, budget) {
    this.fields = fields || [];
    this.budget = budget;
    this.bytes = 2;
    this.result = { docs: [], columns: this.fields.map(f => f.name || f), total: 0, skip: 0, limit, resultSet: true, truncated: false };
  }
  aggiungi(row) {
    const out = this.result;
    out.total++;
    if (out.truncated) return;
    const residuo = this.budget - this.bytes - (out.docs.length ? 1 : 0);
    if (out.docs.length >= out.limit || (this.budget && Object.values(row).some(v =>
      (typeof v === 'string' && v.length > residuo) || (Buffer.isBuffer(v) && v.length > residuo)))) {
      out.truncated = true;
      return;
    }
    const doc = serializeRow(row, this.fields);
    if (this.budget) {
      const size = Buffer.byteLength(JSON.stringify(doc));
      if (size > residuo) { out.truncated = true; return; }
      this.bytes += size + (out.docs.length ? 1 : 0);
    }
    out.docs.push(doc);
  }
}

function queryPostgres(client, config, cap, budget) {
  const q = new Query(config);
  return new Promise((resolve, reject) => {
    let ultimo, righe, errore;
    function seleziona(result) {
      if (ultimo !== result) { ultimo = result; righe = new RigheSql(result.fields, cap, budget); }
      return righe;
    }
    q.on('row', (row, result) => {
      if (errore) return;
      try { seleziona(result).aggiungi(row); } catch (err) { errore = err; }
    });
    q.once('error', reject);
    function termina(result) {
      const ultimoSet = Array.isArray(result) ? result.at(-1) : result;
      if (errore) { reject(errore); return; }
      // Gli adattatori di prova possono fornire una risposta a promessa.
      const set = seleziona(ultimoSet);
      for (const row of ultimoSet.rows || []) set.aggiungi(row);
      resolve(set.result);
    }
    q.once('end', termina);
    const inviata = client.query(q);
    if (inviata !== q) inviata.then(termina, reject);
  });
}

module.exports = { RigheSql, queryPostgres };
