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
    const execute = command.execute;
    command.execute = function (packet, connection) {
      if (packet?.isEOF() && (this.next === this.row || this.next === this.fieldsEOF)) {
        stato.status = packet.eofStatusFlags();
      }
      return execute.call(this, packet, connection);
    };
  });
}

module.exports = { queryMysql, statoMysql };
