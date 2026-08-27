'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { cellaCsv, rigaCsv } = require('../db/csv');

module.exports = (async () => {
  const { analizzaCsv, preparaImportCsv } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'csv.js')).href
  );

  console.log('--- Test unitari CSV strutturato e sicuro ---');

  assert.deepStrictEqual(analizzaCsv('a,b\r\n"x,y","riga 1\r\nriga 2"\r\n').righe, [
    ['a', 'b'], ['x,y', 'riga 1\r\nriga 2'],
  ]);
  assert.throws(() => analizzaCsv('a\n"non chiuso'), /riga 2, colonna 12.*virgolette/i);
  assert.throws(() => analizzaCsv('a\n"ok"spazzatura'), /riga 2, colonna 5.*dopo la virgoletta/i);
  assert.throws(() => analizzaCsv('a,b\r\n"x\r\ny"oops,z'), /riga 3, colonna 3.*dopo la virgoletta/i,
    'un CRLF dentro una cella quotata conta come una sola nuova riga');
  assert.throws(() => preparaImportCsv('a,a\n1,2'), /intestazione duplicata.*a/i);
  assert.throws(() => preparaImportCsv('a,b\n1'), /riga 2.*1 campi.*2/i);
  assert.throws(() => preparaImportCsv('a,b\n1,2,3'), /riga 2.*3 campi.*2/i);
  assert.deepStrictEqual(preparaImportCsv('a,b\n1,\n').documenti, [{ a: '1', b: null }]);
  assert.deepStrictEqual(preparaImportCsv('a,b\n,\n').documenti, [{ a: null, b: null }],
    'una riga di celle vuote non deve essere scambiata per una riga bianca');

  assert.strictEqual(cellaCsv('=1+1'), "'=1+1");
  assert.strictEqual(cellaCsv('+cmd'), "'+cmd");
  assert.strictEqual(cellaCsv('-2'), "'-2");
  assert.strictEqual(cellaCsv('@formula'), "'@formula");
  assert.strictEqual(cellaCsv('=1+1', { modalita: 'letterale' }), '=1+1');
  assert.strictEqual(cellaCsv('a,"b"'), '"a,""b"""');
  assert.strictEqual(rigaCsv(['=titolo', 'normale']), "'=titolo,normale",
    'intestazioni e celle attraversano lo stesso encoder');

  console.log('  OK   parser strutturato, preflight e CSV spreadsheet-safe');
})();
