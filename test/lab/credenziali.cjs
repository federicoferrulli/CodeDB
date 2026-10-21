'use strict';

// Credenziali delle fixture: nessuna lettura del vault o delle connessioni utente.
module.exports = function password(type) {
  if (type === 'mysql') return process.env.MYSQL_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '';
  if (type === 'postgresql') return process.env.PG_PASSWORD || process.env.PGPASSWORD || '';
  return '';
};
