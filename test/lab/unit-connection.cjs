'use strict';

// Una connessione rifiutata si prova contro un endpoint posseduto dal test,
// senza presumere che il PostgreSQL dell'utente sia spento o senza password.
const assert = require('node:assert/strict');
const net = require('node:net');
const PostgreSqlStrategy = require('../../db/PostgreSqlStrategy');
module.exports = (async () => {
  const endpoint = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '127.0.0.1', resolve); });
  const strategy = new PostgreSqlStrategy();
  if (process.argv.includes('--mutant-connection')) strategy.connect = async () => ({ ok: true });
  try {
    await assert.rejects(strategy.connect({ host: '127.0.0.1', port: endpoint.address().port, database: 'postgres', password: 'fixture' }),
      /terminated|ECONNRESET|closed/i, 'Una chiusura durante handshake deve fallire');
    console.log('OK connessione PostgreSQL interrotta: errore propagato, endpoint del test');
  } finally {
    await strategy.disconnect();
    await new Promise(resolve => endpoint.close(resolve));
  }
})();
if (require.main === module) module.exports.catch(err => { console.error(err); process.exitCode = 1; });
