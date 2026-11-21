'use strict';

// mysql2 espone i flag dell'OK, ma scarta quelli dell'EOF di una SELECT.
// Osserviamo il pacchetto prima che il comando lo consumi: nessuna query
// aggiuntiva che alteri ROW_COUNT(), FOUND_ROWS() o le warning dell'utente.
const stati = new WeakMap();
function statoMysql(conn) {
  if (!stati.has(conn)) stati.set(conn, {});
  return stati.get(conn);
}

async function queryMysql(conn, sql, params) {
  if (!conn.connection) return conn.query(sql, params); // Adattatori di prova.
  const stato = statoMysql(conn);
  return new Promise((resolve, reject) => {
    const command = conn.connection.query(sql, params, (err, result, fields) => {
      if (err) { stato.status = undefined; reject(err); return; }
      // CALL può produrre più result set e un OK finale, anche vuoti.
      for (const header of Array.isArray(fields?.[0]) ? result : [result]) {
        if (!header || Array.isArray(header)) continue;
        if (Number.isInteger(header.serverStatus)) stato.status = header.serverStatus;
        if (header.stateChanges?.schema != null) stato.database = header.stateChanges.schema;
      }
      resolve([result, fields]);
    });
    osservaEof(command, stato);
  });
}

function osservaEof(command, stato) {
  const execute = command.execute;
  command.execute = function (packet, connection) {
    if (packet?.isEOF() && (this.next === this.row || this.next === this.fieldsEOF)) {
      stato.status = packet.eofStatusFlags();
    }
    return execute.call(this, packet, connection);
  };
}

async function queryRisultatoMysql(conn, sql, params, cap, budget) {
  const { RigheSql } = require('./sqlRighe');
  const stato = statoMysql(conn);
  let righe, campi, header, istruzioni = 0, coinvolte = 0;
  function inizia(fields) {
    istruzioni++;
    campi = fields;
    if (fields) righe = new RigheSql(fields, cap, budget);
  }
  function aggiungi(row) {
    if (campi) { righe.aggiungi(row); return; }
    header = row;
    coinvolte += row.affectedRows || 0;
    if (Number.isInteger(row.serverStatus)) stato.status = row.serverStatus;
    if (row.stateChanges?.schema != null) stato.database = row.stateChanges.schema;
  }
  if (conn.connection) {
    await new Promise((resolve, reject) => {
      const command = conn.connection.query(sql, params);
      osservaEof(command, stato);
      let errore;
      command.on('fields', inizia);
      command.on('result', row => {
        if (!errore) try { aggiungi(row); } catch (err) { errore = err; }
      });
      command.once('error', err => { stato.status = undefined; reject(err); });
      command.once('end', () => errore ? reject(errore) : resolve());
    });
  } else {
    // Adattatori di prova a promessa.
    const [rows, fields] = await conn.query(sql, params);
    const multi = Array.isArray(rows) && (Array.isArray(rows[0]) || Array.isArray(fields?.[0]));
    for (const [index, entry] of (multi ? rows : [rows]).entries()) {
      inizia(Array.isArray(entry) ? (multi ? fields?.[index] : fields) || [] : null);
      if (Array.isArray(entry)) for (const row of entry) aggiungi(row);
      else if (entry) aggiungi(entry);
    }
  }
  return { righe: righe?.result, header, istruzioni, coinvolte };
}

module.exports = { queryMysql, statoMysql, queryRisultatoMysql };
