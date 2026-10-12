import { decodificaNumeroEsatto } from './valori-esatti.js';
import { leggiJsonEsatto, dataIsoBson } from './insert-json.mjs';

export const tipiBson = [
  ['text', 'Testo'], ['int', 'Intero · 32 bit'], ['long', 'Intero · 64 bit'], ['double', 'Double'],
  ['decimal', 'Decimal128'], ['bool', 'Booleano'], ['datetime', 'Data · UTC / 64 bit'],
  ['oid', 'ObjectId'], ['json', 'Documento / array'], ['geo', 'GeoJSON'],
  ['binary', 'Binario'], ['uuid', 'UUID'], ['regex', 'Espressione regolare'], ['timestamp', 'Timestamp BSON'],
  ['code', 'Codice'], ['scope', 'Codice con scope'], ['symbol', 'Simbolo'], ['dbpointer', 'DBPointer'],
  ['undefined', 'Undefined'], ['minkey', 'MinKey'], ['maxkey', 'MaxKey'],
];

const esempi = {
  text: ['Testo, anche vuoto', 'Gli spazi vengono conservati.'],
  number: ['0', 'Numero nel formato del database.'], int: ['2147483647', 'Intero con segno a 32 bit.'],
  long: ['9223372036854775807', 'Intero con segno a 64 bit, senza arrotondamenti.'],
  double: ['1.25', 'Accetta anche NaN, Infinity e -Infinity.'], decimal: ['1234567890.123456789', 'Tutte le cifre arrivano al database.'],
  datetime: ['2026-10-12T20:55:00Z', 'ISO 8601 con fuso, oppure millisecondi interi a 64 bit. Senza fuso: UTC.'],
  temporal: ['2026-10-12 20:55:00.123456', 'Formato nativo: frazioni, fuso e valori speciali restano intatti.'],
  date: ['2026-10-12', 'Formato nativo, inclusi i valori speciali ammessi dal database.'],
  bool: ['', 'Scegli true o false.'], oid: ['0123456789abcdef01234567', '24 caratteri esadecimali.'],
  json: ['{"nome": "valore"}', 'JSON valido. Su SQL anche numeri grandi e chiavi ripetute restano intatti.'],
  native: ['Valore nel formato nativo', 'Array, intervalli, tipi composti ed estensioni: usa la sintassi di input del tipo, senza apici SQL esterni.'],
  pggeo: ['(12.5, 41.9)', 'Geometria cartesiana PostgreSQL: usa il formato nativo del tipo.'],
  geo: ['{"type":"Point","coordinates":[12.5,41.9]}', 'GeoJSON; su SQL anche WKT / SRID=4326;POINT(12.5 41.9).'],
  binary: ['{"base64":"AP8=","subType":"00"}', 'BSON Binary: base64 e sottotipo esadecimale (00–ff).'],
  bytes: ['00ff', 'Byte esadecimali, due cifre per byte. Il valore vuoto contiene zero byte.'],
  bits: ['10101010', 'Sequenza di bit, senza prefissi o apici.'],
  uuid: ['12345678-1234-1234-1234-123456789abc', 'UUID standard, sottotipo BSON 04.'],
  regex: ['{"pattern":"^ciao","options":"i"}', 'Pattern e opzioni BSON: i, m, s, u, x.'],
  timestamp: ['{"t":1760295300,"i":1}', 'Secondi e incremento: due interi senza segno a 32 bit.'],
  code: ['return 1;', 'Il codice viene memorizzato, mai eseguito da questo modulo.'],
  scope: ['{"$code":"return x","$scope":{"x":1}}', 'Documento Extended JSON con codice e scope.'],
  symbol: ['simbolo', 'Tipo BSON storico Symbol.'],
  dbpointer: ['{"$ref":"database.collection","$id":{"$oid":"0123456789abcdef01234567"}}', 'Riferimento BSON storico DBPointer.'],
  undefined: ['', 'Valore BSON Undefined, distinto da NULL e da campo omesso.'],
  minkey: ['', 'Valore BSON MinKey.'], maxkey: ['', 'Valore BSON MaxKey.'],
};

export function guidaTipo(kind, typeName = '') {
  if (kind === 'pggeo') {
    const native = { point: '(12.5,41.9)', line: '{1,2,3}', lseg: '[(0,0),(1,2)]', box: '(3,4),(1,2)', path: '[(0,0),(1,2)]', polygon: '((0,0),(1,0),(1,1))', circle: '<(1,2),3>' };
    return [native[typeName.toLowerCase()] || esempi.pggeo[0], esempi.pggeo[1]];
  }
  return esempi[kind] || esempi.native;
}

export function valoreInserimento(raw, kind, meta = {}, sql = false) {
  const t = String(raw ?? '').trim();
  if (kind === 'pggeo' && /^\{\s*"type"\s*:/.test(t)) return JSON.parse(t);
  if (kind === 'text' || kind === 'native' || kind === 'pggeo' || kind === 'code' || kind === 'symbol') {
    return kind === 'code' ? { $code: raw } : kind === 'symbol' ? { $symbol: raw } : raw;
  }
  if (['undefined', 'minkey', 'maxkey'].includes(kind)) return { [{ undefined: '$undefined', minkey: '$minKey', maxkey: '$maxKey' }[kind]]: kind === 'undefined' ? true : 1 };
  if (kind === 'bytes') {
    const hex = t.replace(/^(?:0x|\\x)/, '').replace(/\s/g, '');
    if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('Binario non valido: usa coppie di cifre esadecimali.');
    return { $binary: { base64: btoa(hex.replace(/../g, pair => String.fromCharCode(parseInt(pair, 16)))), subType: '00' } };
  }
  if (kind === 'bits') {
    if (!/^[01]*$/.test(t)) throw new Error('Sono ammessi soltanto 0 e 1.');
    if (meta.dbType === 'mysql') {
      if (!t) throw new Error('Inserisci almeno un bit.');
      return { $numberDecimal: BigInt('0b' + t).toString() };
    }
    return t;
  }
  if (!t) throw new Error('Inserisci un valore oppure scegli NULL o Predefinito.');
  if (kind === 'number' || kind === 'decimal' || kind === 'int' || kind === 'long' || kind === 'double') {
    if (/^(?:NaN|[+-]?Infinity)$/.test(t) && ['number', 'decimal', 'double'].includes(kind)) return sql ? t : { [kind === 'decimal' ? '$numberDecimal' : '$numberDouble']: t };
    const wrapper = { int: '$numberInt', long: '$numberLong', double: '$numberDouble', decimal: '$numberDecimal' }[kind];
    return decodificaNumeroEsatto(t, { ...meta, ...(wrapper ? { wrapper } : {}) });
  }
  if (kind === 'bool') {
    if (!['true', 'false'].includes(t)) throw new Error('Scegli true o false.');
    return t === 'true';
  }
  if (kind === 'date' || kind === 'temporal') return raw;
  if (kind === 'datetime') {
    if (/^-?\d+$/.test(t)) {
      const n = BigInt(t);
      if (n < -9223372036854775808n || n > 9223372036854775807n) throw new Error('Millisecondi fuori intervallo a 64 bit.');
      return { $date: { $numberLong: t } };
    }
    return { $date: dataIsoBson(t) };
  }
  if (kind === 'oid') {
    if (!/^[0-9a-f]{24}$/i.test(t)) throw new Error('ObjectId non valido: servono 24 caratteri esadecimali.');
    return { $oid: t };
  }
  if (kind === 'uuid') {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(t)) throw new Error('UUID non valido.');
    return { $uuid: t };
  }
  if (kind === 'geo' && sql && t[0] !== '{') return raw;
  JSON.parse(t);
  if (kind === 'json' && sql) return raw;
  const value = leggiJsonEsatto(t);
  const wrapper = { binary: '$binary', regex: '$regularExpression', timestamp: '$timestamp', dbpointer: '$dbPointer' }[kind];
  return wrapper ? { [wrapper]: value } : value;
}
