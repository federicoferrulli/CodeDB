'use strict';

// Connessione del pool per testare l'import senza un server MySQL.
module.exports = pool => {
  pool.getConnection = async () => ({
    query: async (sql, params) => /^SELECT @@SESSION/.test(sql)
      ? [[{ timezone: 'SYSTEM', mode: '' }]]
      : /^SET SESSION/.test(sql) ? [{}] : pool.query(sql, params),
    release() {}, destroy() {},
  });
};
