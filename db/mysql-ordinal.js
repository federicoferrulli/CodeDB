'use strict';

// ENUM distingue l'indice 0 dalla voce valida ""; SET può avere 64 bit.
// Il testo visualizzato non basta: si trasferisce l'ordinale numerico esatto.
const { Decimal128 } = require('bson');
const isOrdinal = c => /^(enum|set)\b/i.test(String(c?.type || c?.ctype || ''));
const isEnum = c => /^enum\b/i.test(String(c?.type || c?.ctype || ''));
function encode(row, columns) {
  const out = { ...row };
  for (const c of columns || []) if (isOrdinal(c) && out[c.name] != null) out[c.name] = Decimal128.fromString(String(out[c.name]));
  return out;
}
function binding(value, column) {
  if (!isOrdinal(column) || value == null || (typeof value !== 'number' && !['Int32','Double','Long','Decimal128'].includes(value?._bsontype))) return null;
  const ordinal = String(value);
  if (!/^(0|[1-9]\d*)$/.test(ordinal) || BigInt(ordinal) > (isEnum(column) ? 65535n : 18446744073709551615n)) throw new Error('Ordinale ENUM/SET non valido.');
  return { sql: 'CAST(? AS UNSIGNED)', param: ordinal, zero: isEnum(column) && ordinal === '0' };
}
async function write(conn, sql, params, zeroColumns = []) {
  // Solo lo zero storico ENUM necessita della modalità non stretta. Nessun
  // altro warning di conversione viene accettato, nemmeno nello stesso batch.
  let mode, maxErrors;
  try {
    if (zeroColumns.length) {
      [[{mode,maxErrors}]] = await conn.query('SELECT @@SESSION.sql_mode AS mode, @@SESSION.max_error_count AS maxErrors');
      await conn.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO', SESSION max_error_count=65535");
    }
    const [result] = await conn.query(sql, params);
    const warnings = result.warningStatus ? (await conn.query('SHOW WARNINGS'))[0] : [];
    if (Number(result.warningStatus)>warnings.length || warnings.some(w => ![1287,1681].includes(Number(w.Code)) && !(Number(w.Code) === 1265 && zeroColumns.some(c => String(w.Message).endsWith(`for column '${c.column}' at row ${c.row}`))))) {
      const err = new Error('Il database ha segnalato una conversione dei dati: import interrotto per evitare troncamenti.');
      err.importDoNotRetry = true;
      throw err;
    }
    return result;
  } finally {
    if (mode != null) await conn.query('SET SESSION sql_mode = ?', [mode]);
    if (maxErrors != null) await conn.query('SET SESSION max_error_count = ?', [maxErrors]);
  }
}
module.exports = { isOrdinal, isEnum, encode, binding, write };
