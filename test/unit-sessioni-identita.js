'use strict';

const assert = require('assert');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');
const MongoDbStrategy = require('../db/MongoDbStrategy');

module.exports = (async () => {
  console.log('--- Test unitari identità stabile delle sessioni ---');

  let killMysql = false;
  const conn = {
    async query(sql) {
      if (/SELECT THREAD_ID/.test(sql)) return [[{ STABLE_ID: 222 }]];
      if (/^KILL /.test(sql)) killMysql = true;
      return [[]];
    },
    release() {},
  };
  await assert.rejects(
    MySqlStrategy.prototype.killSession.call({ requirePool: () => ({ getConnection: async () => conn }) }, 7, 'query', 'mysql-thread:111'),
    /sessione è cambiata|riutilizzato/i
  );
  assert.strictEqual(killMysql, false, 'MySQL non invia KILL dopo la sostituzione del thread');

  let sqlPg = '';
  await assert.rejects(
    PostgreSqlStrategy.prototype.killSession.call({
      requirePool: () => ({ query: async (sql) => { sqlPg = sql; return { rows: [] }; } }),
    }, 42, 'connessione', 'postgres-backend:2026-01-01T00:00:00.000Z'),
    /sessione è cambiata|riutilizzato/i
  );
  assert.match(sqlPg, /backend_start\s*=\s*\$2/i, 'PostgreSQL rivalida e termina nello stesso statement');

  let killMongo = false;
  const admin = {
    aggregate: () => ({ toArray: async () => [{ opid: 9, operationKey: { id: 'nuova' } }] }),
    command: async () => { killMongo = true; return { ok: 1 }; },
  };
  await assert.rejects(
    MongoDbStrategy.prototype.killSession.call({ requireClient: () => ({ db: () => admin }) }, 9, 'query', '{"id":"vecchia"}'),
    /sessione è cambiata|riutilizzato/i
  );
  assert.strictEqual(killMongo, false, 'MongoDB non invia killOp dopo la sostituzione dell’operazione');

  console.log('  OK   PID/opid riutilizzati vengono rifiutati sui tre motori');
})();
