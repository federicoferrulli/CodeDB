'use strict';

// Database reali; diniego dei cataloghi iniettato sul pool per non modificare
// i privilegi globali delle viste di sistema dell'installazione dell'utente.
const assert = require('node:assert/strict');
const MySqlStrategy = require('../db/MySqlStrategy');
const PostgreSqlStrategy = require('../db/PostgreSqlStrategy');

async function verifica(mysql) {
  const strategia = mysql ? new MySqlStrategy() : new PostgreSqlStrategy();
  const nome = `cdb_srid_${process.pid}_${Date.now()}`;
  const q = (s) => mysql ? '`' + s + '`' : '"' + s + '"';
  const table = `${q(nome)}.${q('forme')}`;
  await strategia.connect({
    host: process.env[mysql ? 'MYSQL_HOST' : 'PG_HOST'] || '127.0.0.1',
    port: process.env[mysql ? 'MYSQL_PORT' : 'PG_PORT'] || (mysql ? 3306 : 5432),
    username: process.env[mysql ? 'MYSQL_USER' : 'PG_USER'] || (mysql ? 'root' : 'postgres'),
    password: process.env[mysql ? 'MYSQL_PASSWORD' : 'PG_PASSWORD'] || '',
    database: mysql ? undefined : process.env.PG_DATABASE || 'postgres',
  });
  const pool = strategia.requirePool();
  const query = pool.query.bind(pool);
  const leggi = async () => {
    const res = await query(`SELECT id, ST_SRID(g) AS srid, ST_AsGeoJSON(g) AS geo FROM ${table} ORDER BY id`);
    return (mysql ? res[0] : res.rows).map((r) => ({ id: r.id, srid: r.srid, geo: typeof r.geo === 'string' ? JSON.parse(r.geo) : r.geo }));
  };
  try {
    await query(`CREATE ${mysql ? 'DATABASE' : 'SCHEMA'} ${q(nome)}`);
    await query(`CREATE TABLE ${table} (id INT PRIMARY KEY, g GEOMETRY)`);
    await query(`INSERT INTO ${table} VALUES (1, ST_GeomFromText('POINT(10 20)', 3003)), (2, ST_GeomFromText('POINT(30 40)', 0)), (3, NULL)`);
    const punto = { type: 'Point', coordinates: [1200, 3400] };
    await strategia.docUpdate(nome, 'forme', { id: '{"id":1}', set: { g: punto } });
    let rows = await leggi();
    assert.equal(rows[0].srid, 3003, 'SRID originale non predefinito conservato');
    assert.deepEqual(rows[0].geo.coordinates, punto.coordinates, 'Coordinate proiettate conservate');
    await strategia.docReplace(nome, 'forme', { id: '{"id":2}', doc: JSON.stringify({ id: 2, g: punto }) });
    rows = await leggi();
    assert.equal(rows[1].srid, 0, 'Zero conservato solo quando attestato dal valore originale');
    assert.deepEqual(rows[1].geo.coordinates, punto.coordinates);
    await assert.rejects(strategia.docUpdate(nome, 'forme', { id: '{"id":3}', set: { g: punto } }), /SRID non noto/);
    assert.deepEqual(await leggi(), rows, 'SRID ignoto: nessuna mutazione');

    // Satura il pool: nessuna transazione deve chiedere una seconda connessione
    // per leggere metadata mentre trattiene il lock della geometria.
    await Promise.all(Array.from({ length: 8 }, () => strategia.docUpdate(nome, 'forme', { id: '{"id":1}', set: { g: punto } })));
    assert.deepEqual(await leggi(), rows);

    for (const catalogo of mysql ? ['information_schema.COLUMNS'] : ['information_schema.columns', 'geometry_columns']) {
      strategia._cacheColonne.clear();
      pool.query = async (sql, ...args) => {
        if (String(sql).includes(catalogo)) throw new Error('Permesso SELECT negato al catalogo');
        return query(sql, ...args);
      };
      try {
        await assert.rejects(strategia.docUpdate(nome, 'forme', { id: '{"id":1}', set: { g: punto } }), /SRID non noto.*privilegi.*schema/);
        assert.deepEqual(await leggi(), rows, 'Metadata negati: nessuna mutazione');
      } finally { pool.query = query; }
    }
    console.log(`OK ${mysql ? 'MySQL' : 'PostgreSQL'}: SRID 3003 e 0, coordinate, replace, NULL e metadata negati`);
  } finally {
    pool.query = query;
    await query(`DROP ${mysql ? 'DATABASE' : 'SCHEMA'} IF EXISTS ${q(nome)}${mysql ? '' : ' CASCADE'}`);
    await strategia.disconnect();
  }
}

(async () => {
  for (const mysql of [true, false]) await verifica(mysql);
})().catch((err) => { console.error(err); process.exitCode = 1; });
