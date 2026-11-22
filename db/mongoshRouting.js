'use strict';

const vm = require('node:vm');
const MongoScript = require('./MongoScript');
const SqlToMql = require('./SqlToMql');
const sqlTriggerMongo = require('./sqlTriggerMongo');
const sqlProcedureMongo = require('./sqlProcedureMongo');

const RE_EXPORT_MONGOSH = /^\s*\/\/\s*Esportazione CodeDB\b[^\n]*\bmongosh\b/i;
const RE_COMANDO_MONGOSH = /^\s*(?:show\s+(?:dbs|databases|collections|tables|users|roles|profile|logs)|cls|it)\s*;?\s*$/i;
const RE_USE_DB = /^\s*use\s+[`"]?[a-zA-Z0-9_\-]+[`"]?\s*;?\s*$/i;
const RE_DOCUMENTO_JSON = /^\s*(?:\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*[[{]/;

// Oggetti/helper nativi esposti da mongosh o Node.js, assenti nella sandbox controllata.
const GLOBALI_SOLO_MONGOSH = new Set([
  'rs', 'sh', 'sp', 'config', 'load', 'sleep', 'require', 'process',
  'console', 'Buffer', 'Map', 'Set', 'Promise', 'fetch',
  'Binary', 'Code', 'DBRef', 'Double', 'Int32', 'Long',
  'Decimal128', 'MaxKey', 'MinKey', 'Timestamp',
]);

// Metodi shell nativi di mongosh non implementati in MongoScriptRunner.
const METODI_SOLO_MONGOSH = new Set([
  'watch', 'initializeUnorderedBulkOp', 'initializeOrderedBulkOp', 'createView',
]);

function jsValidoInV8(code) {
  try {
    // Solo compilazione sintattica: nessuna istruzione viene eseguita.
    new vm.Script(`(async () => {\n${code}\n})`);
    return true;
  } catch {
    return false;
  }
}

function usaApiSoloMongosh(code) {
  let tokens;
  try {
    tokens = MongoScript.tokenize(code);
  } catch {
    return false;
  }
  const dichiarati = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'kw' && (t.v === 'const' || t.v === 'let' || t.v === 'var' || t.v === 'function')) {
      const next = tokens[i + 1];
      if (next && next.t === 'ident') dichiarati.add(next.v);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t !== 'ident') continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const dopoPunto = prev && prev.t === 'op' && (prev.v === '.' || prev.v === '?.');
    const chiaveOggetto = next && next.t === 'op' && next.v === ':';
    if (dopoPunto) {
      if (METODI_SOLO_MONGOSH.has(t.v) && next && next.t === 'op' && next.v === '(') return true;
      continue;
    }
    if (chiaveOggetto || dichiarati.has(t.v)) continue;
    if (GLOBALI_SOLO_MONGOSH.has(t.v)) return true;
  }
  return false;
}

/**
 * Stabilisce se il codice su una connessione MongoDB in modalità `auto`
 * richiede il runtime `mongosh` nativo invece dell'interprete controllato.
 *
 * Restituisce `false` per SQL, documenti/pipeline JSON, `USE <db>`, comandi
 * ordinari e sintassi realmente non valida (così gli errori di digitazione
 * mantengono il percorso diagnostico con evidenziazione precisa).
 */
function richiedeMongoshNativo(code) {
  const s = String(code || '').trim();
  if (!s) return false;
  if (RE_EXPORT_MONGOSH.test(s)) return true;
  if (RE_COMANDO_MONGOSH.test(s)) return true;
  if (RE_USE_DB.test(s)) return false;
  if (RE_DOCUMENTO_JSON.test(s)) return false;
  if (sqlTriggerMongo.riconosci(s) || sqlProcedureMongo.riconosci(s)) return false;
  if (SqlToMql.looksLikeSql(s) || SqlToMql.looksLikeSqlWrite(s)) return false;

  if (usaApiSoloMongosh(s)) return true;

  try {
    MongoScript.parse(s);
    return false;
  } catch {
    // Il parser ridotto non copre questo costrutto: instradiamo a mongosh
    // solo se è JavaScript sintatticamente valido (es. spread, destructuring,
    // class, for-await), mai se è un errore di sintassi dell'utente.
    return jsValidoInV8(s);
  }
}

module.exports = { richiedeMongoshNativo };
