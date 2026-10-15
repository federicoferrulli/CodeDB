'use strict';
const assert = require('node:assert/strict');
if (process.argv.includes('--mutant')) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/guardStrategy.js')) return result;
  return { ...result, source: String(result.source).replace(
    'const analysis = analyzeMongoPipeline([...(plan.selection || []), ...(plan.returning || [])]);',
    'const analysis = { write: false, readTargets: [], targets: [] };') };
} });
const { guardStrategy } = require('../auth/guardStrategy');
const { makePrincipal } = require('../auth/principal');
const runtime = require('../db/MongoSqlRuntime');
const sql = require('../db/SqlToMql');

module.exports = (async () => {
  const oldRbac = process.env.CODEDB_RBAC;
  process.env.CODEDB_RBAC = 'on';
  let calls = 0;
  const base = { type: 'mongodb', mongoSqlRead: async () => { calls++; }, mongoSqlReturning: async () => { calls++; } };
  const protetta = (caps, collections = ['consentita']) => guardStrategy(base, { connName: 'test', principal: makePrincipal(
    { _id: 'test', type: 'subuser', ownerId: 'owner' }, [{ connName: 'test', capabilities: caps, scope: { databases: ['db'], collections } }]) });
  try {
    const read = protetta(['read']);
    await read.mongoSqlRead('db', undefined, { sql: 'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<3) SELECT n FROM x' });
    for (const query of [
      'WITH RECURSIVE x(n) AS (SELECT n FROM segreta UNION ALL SELECT n+1 FROM x WHERE n<3) SELECT n FROM x',
      'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT s.n FROM x JOIN segreta s ON s.n=x.n) SELECT n FROM x',
      'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<3) SELECT s.n FROM x JOIN segreta s ON s.n=x.n',
      'SELECT a.n FROM consentita a FULL JOIN segreta b ON a.n=b.n',
      'SELECT n FROM consentita WHERE EXISTS(SELECT 1 FROM segreta WHERE segreta.n=consentita.n)',
      'SELECT (SELECT MAX(n) FROM segreta) AS n FROM consentita',
    ]) await assert.rejects(() => read.mongoSqlRead('db', undefined, { sql: query }), /Permesso negato/);
    assert.equal(calls, 1, 'Nessuna sorgente fuori scope deve arrivare al driver.');
    console.log('  OK   CTE: scope verificato su seed, ricorsione e query finale; FULL JOIN include entrambi i lati');
    for (const caps of [['read'], ['write'], ['delete']]) await assert.rejects(() => protetta(caps).mongoSqlReturning('db', 'consentita', {
      sql: 'UPDATE consentita SET n=1 RETURNING n',
    }), /Permesso negato/);
    await protetta(['read', 'write']).mongoSqlReturning('db', 'consentita', { sql: 'UPDATE consentita SET n=1 RETURNING n' });
    await assert.rejects(() => protetta(['read', 'write']).mongoSqlReturning('db', 'consentita', { sql: 'DELETE FROM consentita RETURNING n' }), /Permesso negato/);
    await assert.rejects(() => protetta(['read', 'write']).mongoSqlReturning('db', 'consentita', { sql: 'UPDATE segreta SET n=1 RETURNING n' }), /Piano SQL di scrittura non valido/);
    await assert.rejects(() => protetta(['read', 'write']).mongoSqlReturning('db', 'consentita', { sql: 'UPDATE consentita SET n=1 RETURNING (SELECT MAX(n) FROM segreta) AS n' }), /Permesso negato/);
    assert.equal(calls, 2);
    for (const query of [
      'INSERT INTO consentita(n) SELECT n FROM segreta',
      'INSERT INTO consentita(n) SELECT n FROM consentita EXCEPT SELECT n FROM segreta',
      'UPDATE consentita c SET n=s.n FROM segreta s WHERE c.n=s.n',
      'DELETE c FROM consentita c JOIN segreta s ON c.n=s.n',
    ]) await assert.rejects(() => protetta(['read', 'write', 'delete']).mongoSqlReturning('db', 'consentita', { sql: query }), /Permesso negato/);
    assert.equal(calls, 2, 'Sorgenti delle scritture fuori scope bloccate prima del driver.');
    console.log('  OK   RETURNING: permessi read e mutazione cumulativi, bersaglio non falsificabile');
    let mutations = 0;
    const standalone = { db: () => ({ command: async () => ({ ok: 1 }), collection: name => {
      if (name === '_codedb_sql_domains') return { find: () => ({ toArray: async () => [] }) };
      mutations++;
    } }) };
    await assert.rejects(() => runtime.scrivi(standalone, 'db', 't', { sql: 'UPDATE t SET n=1 RETURNING n' }, {}), /replica set/);
    assert.equal(mutations, 0);
    await assert.rejects(() => runtime.leggi(standalone, 'db', { sql: 'WITH RECURSIVE x(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT n FROM x', opHandle: { interrotto: true } }, {}), /annullata/);
    console.log('  OK   Standalone senza transazioni e annullamento prima della lettura non producono mutazioni');
    for (const query of [
      'SELECT RANK() OVER sconosciuta FROM t',
      'SELECT SUM(n) OVER(ORDER BY n ROWS BETWEEN 2 FOLLOWING AND 1 PRECEDING) FROM t',
      'SELECT LAG(n,-1) OVER(ORDER BY n) FROM t',
      'SELECT COUNT(*) OVER(ORDER BY a,b RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t',
    ]) assert.throws(() => sql.translate(query));
    assert.throws(() => sql.translateWrite('UPDATE t SET n=1 RETURNING COUNT(*)'), /aggregati/);
    assert.throws(() => sql.translateWrite('UPDATE t SET n=1 RETURNING COALESCE(SUM(n),0)'), /aggregati/);
    console.log('  OK   Finestre e RETURNING invalidi vengono rifiutati prima dell’esecuzione');
  } finally {
    if (oldRbac == null) delete process.env.CODEDB_RBAC; else process.env.CODEDB_RBAC = oldRbac;
  }
})().catch(e => { process.exitCode = 1; console.error(e); });
