'use strict';

/* ---------------------------------------------------------------------------
 * Regressione: export database PostgreSQL -> import database, con tipi
 * geometrici nativi. Il driver `pg` rappresenta `point` come `{ x, y }`: un
 * artefatto storico con quella forma deve ancora essere reimportabile, e il
 * percorso a blocchi deve applicare la stessa conversione di `docInsert`.
 * ------------------------------------------------------------------------- */

const assert = require('assert');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

module.exports = (async () => {
  const strategy = new PostgreSqlStrategy();
  const query = [];
  strategy.pool = {
    query: async (sql, params = []) => {
      query.push({ sql, params });
      if (/^INSERT\s/i.test(sql) && params[1] !== '(12.4794194,41.9025426)') {
        throw new Error(`invalid input syntax for type point: "${JSON.stringify(params[1])}"`);
      }
      return { rows: [], fields: [], rowCount: 1 };
    },
  };
  strategy.tableColumnsInfo = async () => ({
    columns: [
      { name: 'id', type: 'int4' },
      { name: 'punto', type: 'point' },
      { name: 'poligono', type: 'polygon' },
    ],
    geo: new Map(),
    geoNativo: new Map([
      ['punto', { name: 'punto', type: 'point' }],
      ['poligono', { name: 'poligono', type: 'polygon' }],
    ]),
  });

  const risultato = await strategy.collectionImport('diego_2', 'Prova', {
    docs: [{
      id: 1,
      punto: { x: 12.4794194, y: 41.9025426 },
      poligono: '((13.0506972,42.2164725),(14.0883656,42.360732),(13.9428724,41.7735201))',
    }],
  });

  assert.strictEqual(risultato.inserted, 1,
    `la riga geometrica deve essere importata: ${risultato.errors.join('; ')}`);
  const inserimento = query.find((q) => /^INSERT\s/i.test(q.sql));
  assert.ok(inserimento, 'deve essere stata eseguita una INSERT');
  assert.strictEqual(inserimento.params[1], '(12.4794194,41.9025426)',
    'il point del driver deve diventare un letterale PostgreSQL, non JSON');

  // I nuovi export non devono piu' produrre la forma privata `{ x, y }` del
  // driver: il file deve contenere GeoJSON e restare portabile.
  const esportazione = new PostgreSqlStrategy();
  esportazione.primaryKey = async () => ['id'];
  esportazione.tableColumnsInfo = strategy.tableColumnsInfo;
  esportazione.pool = {
    query: async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 1 }] };
      assert.match(sql, /"punto"::text AS "punto"/,
        'l\'export JSON deve leggere il point come testo traducibile');
      return {
        rows: [{
          id: 1,
          punto: '(12.4794194,41.9025426)',
          poligono: '((0,0),(1,0),(1,1))',
        }],
        fields: [{ name: 'id' }, { name: 'punto' }, { name: 'poligono' }],
      };
    },
  };
  const esportato = await esportazione.collectionExport('diego', 'Prova', {
    format: 'json', limit: 1000,
  });
  const riga = JSON.parse(esportato.lines[0]);
  assert.deepStrictEqual(riga.punto, {
    type: 'Point', coordinates: [12.4794194, 41.9025426],
  }, 'il nuovo artefatto deve contenere un Point GeoJSON');
  assert.strictEqual(riga.poligono.type, 'Polygon');

  console.log('  OK   Import database PostgreSQL: point e polygon nativi reimportabili');
})();
