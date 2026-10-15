'use strict';
// Mutazioni solo in memoria: provano la sensibilità senza modificare i sorgenti.
const assert = require('node:assert/strict');
const varianti = {
  instradamento: ['query.js', "engine === 'crossdb' || specJoin", "engine === 'crossdb' || codeStr.includes('\"virtualJoin\"')"],
  colonne: ['MySqlStrategy.js', 'Array.isArray(fields?.[0])', "(result[0] && 'affectedRows' in result[0])"],
  stato_pg: ['PostgreSqlStrategy.js', 'client.getTransactionStatus?.()', 'undefined'],
  stato_mysql: ['MySqlStrategy.js', 'if (Number.isInteger(statoNativo.status))', 'if (false)'],
  bersaglio: ['query.js', 'if (res.activeDb) session.strategy.currentDb = res.activeDb;', '/* bersaglio non aggiornato */'],
  diagnostica: ['MySqlStrategy.js', 'if (db && statoNativo.database !== db)', 'if (db)'],
  stato_select: ['mysqlSessioneNativa.js', 'stato.status = packet.eofStatusFlags();', '/* flag della SELECT ignorati */'],
  marcatori: ['mongoScriptValori.js', "VALORE_BSON: Symbol('valore BSON')", "VALORE_BSON: '__bson'"],
  escape: ['mongoStringhe.js', "c === 'u' || c === 'x'", 'false'],
  lettura: ['MongoScriptRunner.js', 'limit: Math.min(Math.abs(richiesto), tetto + 1) * (richiesto < 0 ? -1 : 1)', 'limit: 50'],
  budget: ['MongoScriptRunner.js', "throw errBudget('Lettura MQL incompleta", "void errBudget('Lettura MQL incompleta"],
  cursore: ['MongoScriptRunner.js', 'posizione = docs.length; ctx.ultimiDocumenti = result; return result;', 'ctx.ultimiDocumenti = result; return result;'],
  conteggio: ['MongoScriptRunner.js', "throw errore('Conteggio MongoDB incompleto", "void errore('Conteggio MongoDB incompleto"],
  byte: ['MongoScriptRunner.js', "throw errBudget('Lettura MQL incompleta", "void errBudget('Lettura MQL incompleta"],
  use_fallito: ['query.js', 'const write = isWriteSql(codeStr);', "const changed = /^USE\\s+`([^`]+)`/i.exec(codeStr); if (changed) session.strategy.currentDb = changed[1]; const write = isWriteSql(codeStr);"],
  join_auto: ['query.js', 'specJoin = parsed;', 'specJoin = undefined;'],
  risultato_cursore: ['MongoScriptRunner.js', 'set: docs => { this.ultimiDocumenti = docs; }', 'set: docs => {}'],
  quota_host: ['MongoScriptRunner.js', 'this.contaChiamataDb(); return method.apply(target, args);', 'return method.apply(target, args);'],
};
const variante = varianti[process.env.CODEDB_QUERY_MUTANT];
assert(variante, 'Mutazione audit sconosciuta');
require('node:module').registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/' + variante[0]) || url.includes('/node_modules/')) return result;
  const source = String(result.source).replaceAll('\r\n', '\n');
  assert(source.includes(variante[1]), 'Mutazione non applicabile');
  return { ...result, source: source.replace(variante[1], variante[2]) };
} });
