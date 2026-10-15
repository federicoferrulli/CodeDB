'use strict';

// Il testo canonico conserva microsecondi, limiti degli array, JSON numerici e tipi
// di estensione: convertirli in Date/Array/Number JavaScript perderebbe informazione.
const { types } = require('pg');
const scalariPostgres = new Set([16, 17, 18, 19, 20, 21, 23, 25, 26, 700, 701, 1042, 1043]);
const tipiPostgresNativi = {
  getTypeParser(oid, format) {
    return scalariPostgres.has(oid) ? types.getTypeParser(oid, format) : testo => testo;
  },
};
function tipoMysqlNativo(field, next) {
  if (field.type === 'JSON') return field.buffer()?.toString('utf8') ?? null;
  return ['DATE', 'DATETIME', 'TIMESTAMP', 'TIME'].includes(field.type) ? field.string() : next();
}
module.exports = { tipiPostgresNativi, tipoMysqlNativo };
