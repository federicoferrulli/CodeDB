'use strict';
const assert = require('node:assert/strict');
if (process.env.CODEDB_SQL_ERROR_LOG) process.on('uncaughtExceptionMonitor', err => {
  require('node:fs').appendFileSync(process.env.CODEDB_SQL_ERROR_LOG, `${err.stack}\n`);
});
const varianti = {
  schema_cache: ['PostgreSqlStrategy.js', 'await client.query(`SET search_path TO ${qid(schema)}`);', 'if (client.__schema !== schema) { await client.query(`SET search_path TO ${qid(schema)}`); client.__schema = schema; }'],
  database_cache: ['mysqlSessioneNativa.js', 'if (header.stateChanges?.schema != null)', 'if (false)'],
  riconnessione: ['connessioni.js', 'if (err.sqlConnectionLost || /^(08\\w{3}|57p0[123])$/.test(code)) return true;', 'if (err.sqlConnectionLost) return false;'],
  identita: ['tetti.js', 'if (!soggetto(prop)) return valore.bind(bersaglio);', 'if (!soggetto(prop)) return valore;'],
  ascolto_errori: ['sqlSessione.js', "conn.on?.('error', stato.onErrore);", '/* listener omesso nella mutazione */'],
  dialetto_sessione: ['PostgreSqlStrategy.js', "stripSqlNoise(sql, { dbms: 'postgresql' })", 'stripSqlNoise(sql)'],
  recupero: ['PostgreSqlStrategy.js', '} else if (!recupero) {', '} else if (true) { await client.query("SET search_path TO public");'],
  sessione: ['query.js', '!!payload.run || dependencies.DbFactory.isSqlType(session.strategy.type)', '!!payload.run'],
  precisione_pg: ['sqlRisultatiNativi.js', 'scalariPostgres.has(oid)', 'true'],
  precisione_my: ['sqlRisultatiNativi.js', "['DATE', 'DATETIME', 'TIMESTAMP', 'TIME'].includes(field.type)", 'false'],
  destinazione: ['query.js', "['mysql', 'postgresql', 'mongodb'].includes(engine)", 'false'],
  delimitatore: ['sqlText.js', "if (dbms === 'mysql' && !haCodice", 'if (false && !haCodice'],
};
const variante = varianti[process.env.CODEDB_SQL_MUTANT];
if (variante) require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/' + variante[0]) || url.includes('/node_modules/')) return result;
  const source = String(result.source).replaceAll('\r\n', '\n');
  assert(source.includes(variante[1]), 'Mutazione non applicabile');
  return { ...result, source: source.replace(variante[1], variante[2]) };
} });
