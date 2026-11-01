'use strict';

const assert = require('node:assert/strict');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

module.exports = (async () => {
  const { richiedePrecisioneEsatta } = await import('../public/js/valori-esatti.js');
  const strategy = new PostgreSqlStrategy({ env: { CODEDB_QUERY_TIMEOUT_MS: '0' } });
  strategy.primaryKey = async () => ['id'];
  strategy.tableColumnsInfo = async () => ({ columns: [
    { name: 'id', type: 'integer' },
    { name: 'valore', type: '_numeric', declaredType: 'app."numeric"',
      pgType: { kind: 'array', delimiter: ',', element: { kind: 'scalar', name: 'numeric', oid: 1700 } } },
    { name: 'importo', type: 'numeric', declaredType: 'numeric(30,6)', pgType: { kind: 'scalar', name: 'numeric' } },
  ], geo: new Map(), geoNativo: new Map() });
  strategy.pool = { query: async sql => {
    assert.match(sql, /"valore"::text AS "valore"/, 'Il dominio array viene letto senza arrotondamenti');
    return { rows: [{ id: 1, valore: '{9007199254740993.123456}', importo: '123456789012345678.123456' }],
      fields: [{ name: 'id' }, { name: 'valore' }, { name: 'importo' }] };
  } };
  const result = await strategy.collectionFind('app', 'righe', { deferCount: true });
  // La mutazione rimuove solo la classificazione nel payload: il catalogo e
  // il binder restano corretti, per provare proprio il confine server/editor.
  if (process.argv.includes('--mutant')) delete result.columnMeta.valore.pgType;
  const payload = JSON.parse(JSON.stringify(result));
  assert.equal(richiedePrecisioneEsatta(payload.columnMeta.valore), false,
    '[PG-ARRAY-METADATA] Un dominio array chiamato numeric non deve aprire il codec numerico scalare');
  assert.deepEqual(payload.columnMeta.valore.pgType, { kind: 'array' }, 'Il payload espone solo la classificazione necessaria all’editor');
  assert.equal(payload.columnMeta.importo.pgType, undefined, 'Il contratto delle colonne scalari resta invariato');
  assert.equal(richiedePrecisioneEsatta(payload.columnMeta.importo), true, 'NUMERIC scalare mantiene il codec esatto');
  assert.equal(payload.docs[0].valore, '{9007199254740993.123456}');
  console.log('  OK   dominio array: classificazione dal catalogo al payload JSON e all’editor');
})();
