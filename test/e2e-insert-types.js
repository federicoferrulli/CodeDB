'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const B = require('bson');
const { mysqlTypes, pgTypes } = require('./fixture-tipi-sql');
if (process.argv.includes('--mutant')) {
  const codec = require('../db/insertValues'), original = codec.parseSqlInsert;
  codec.parseSqlInsert = async (...args) => {
    const doc = await original(...args);
    if (doc.c11 != null) doc.c11 = Number(doc.c11);
    return doc;
  };
}

async function sql(type) {
  const mysql = type === 'mysql';
  const port = Number(process.env[mysql ? 'INSERT_MYSQL_PORT' : 'INSERT_PG_PORT']);
  assert(port, 'Porte di database usa-e-getta obbligatorie.');
  if (mysql) {
    const setup = await require('mysql2/promise').createConnection({ host: '127.0.0.1', port, user: 'root' });
    await setup.query("SET GLOBAL sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO'");
    await setup.end();
  }
  const st = new (require(`../db/${mysql ? 'MySql' : 'PostgreSql'}Strategy`))();
  await st.connect({ host: '127.0.0.1', port, username: mysql ? 'root' : 'postgres', password: '', database: mysql ? '' : 'postgres' });
  const conn = mysql ? await st.pool.getConnection() : await st.pool.connect();
  const q = async (s, p) => { const r = await conn.query(s, p); return mysql ? r[0] : r.rows; };
  const schema = 'codedb_insert_' + crypto.randomBytes(5).toString('hex');
  const quote = name => (mysql ? '`' : '"') + name + (mysql ? '`' : '"');
  const types = mysql ? mysqlTypes : pgTypes;
  try {
    await q(mysql ? `CREATE DATABASE ${quote(schema)} CHARACTER SET utf8mb4` : `CREATE SCHEMA ${quote(schema)}`);
    await q(mysql ? `USE ${quote(schema)}` : `SET search_path TO ${quote(schema)}, public`);
    if (mysql) await q("SET SESSION sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO', time_zone='+00:00'");
    else {
      await q('CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');
      await q("SET TimeZone='UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET extra_float_digits=3");
      await q("CREATE TYPE mood AS ENUM('a','b,🦊'); CREATE DOMAIN amount AS numeric(38,9) CHECK(VALUE>=0); CREATE TYPE pair AS (m mood, n amount); CREATE TYPE price_range AS RANGE(SUBTYPE=numeric,MULTIRANGE_TYPE_NAME=price_multirange)");
      await q("CREATE TYPE myint; CREATE FUNCTION myint_in(cstring) RETURNS myint AS 'int4in' LANGUAGE internal IMMUTABLE STRICT; CREATE FUNCTION myint_out(myint) RETURNS cstring AS 'int4out' LANGUAGE internal IMMUTABLE STRICT; CREATE TYPE myint(INPUT=myint_in,OUTPUT=myint_out,INTERNALLENGTH=4,PASSEDBYVALUE,ALIGNMENT=int4,STORAGE=plain,CATEGORY='N')");
      await q("CREATE TYPE normalized_range; CREATE FUNCTION canonicalize(normalized_range) RETURNS normalized_range AS 'int4range_canonical' LANGUAGE internal IMMUTABLE STRICT; CREATE TYPE normalized_range AS RANGE(SUBTYPE=integer,CANONICAL=canonicalize)");
      await q("CREATE FUNCTION canonicalize(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1'; CREATE COLLATION locale_test(provider=icu,locale='und-u-ks-level2',deterministic=false); CREATE DOMAIN collated_text AS text COLLATE locale_test");
    }
    await q(`CREATE TABLE tipi(id INT PRIMARY KEY,${types.map(([t], i) => `c${i} ${t}`).join(',')})`);
    await q(`INSERT INTO tipi VALUES(1,${types.map(([, v]) => v).join(',')})`);
    const table = `${quote(schema)}.tipi`;
    if (!mysql) await q('SET search_path TO pg_catalog, public');
    const expressions = types.map(([t], i) => `${mysql ? /BINARY|BLOB|BIT|GEOMETRY/i.test(t) ? `HEX(CAST(c${i} AS BINARY))` : /^FLOAT/i.test(t) ? `CAST(c${i} AS DOUBLE)` : `CAST(c${i} AS CHAR CHARACTER SET utf8mb4)` : /^reg(proc|oper)(\[\])?$/.test(t) ? `c${i}::oid${t.endsWith('[]') ? '[]' : ''}::text` : `c${i}::text`} AS c${i}`);
    const read = async id => (await q(`SELECT ${expressions.join(',')} FROM ${table} WHERE id=${id}`))[0];
    const expected = await read(1);
    const doc = { id: 2, ...expected };
    for (let i = 0; i < types.length; i++) {
      const [t] = types[i], name = `c${i}`;
      if (mysql && /BINARY|BLOB|BIT|GEOMETRY/i.test(t)) doc[name] = { $binary: { base64: Buffer.from(expected[name], 'hex').toString('base64'), subType: '00' } };
    }
    await st.docInsert(schema, 'tipi', { doc: JSON.stringify(doc) });
    assert.deepEqual(await read(2), expected, `${type}: valore e tipo salvati per ogni colonna`);
    await st.docInsert(schema, 'tipi', { doc: JSON.stringify({ id: 3, ...Object.fromEntries(types.map((_, i) => [`c${i}`, null])) }) });
    assert(Object.values(await read(3)).every(v => v === null));
    const identity = mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY';
    await q(`CREATE TABLE ${quote(schema)}.stati(id ${identity}, testo VARCHAR(20) DEFAULT 'predefinito', n INT NOT NULL DEFAULT 7, g INT GENERATED ALWAYS AS(n+1) STORED)`);
    for (const value of [{}, { testo: '' }, { testo: null }, { testo: '  x  ' }, { id: 100, n: 9 }]) await st.docInsert(schema, 'stati', { doc: JSON.stringify(value) });
    assert.deepEqual((await q(`SELECT testo FROM ${quote(schema)}.stati ORDER BY id`)).map(r => r.testo), ['predefinito', '', null, '  x  ', 'predefinito']);
    await assert.rejects(st.docInsert(schema, 'stati', { doc: '{"g":1}' }), /calcolata/);
    await assert.rejects(st.docInsert(schema, 'stati', { doc: '{"non_esiste":1}' }), /inesistente/);
    await assert.rejects(st.docInsert(schema, 'stati', { doc: '{"n":null}' }));
    await assert.rejects(st.docInsert(schema, 'stati', { doc: '{"n":1,"n":2}' }), /duplicato/);
    // Il JSON libero conserva numeri e JSON annidato prima di JSON.parse.
    await q(`CREATE TABLE ${quote(schema)}.esatti(n DECIMAL(65,30), j ${mysql ? 'JSON' : 'json'})`);
    const digits = '12345678901234567890123456789012345.123456789012345678901234567890';
    await st.docInsert(schema, 'esatti', { doc: `{"n":${digits},"j":{"grande":9007199254740993}}` });
    const exact = (await q(`SELECT ${mysql ? 'CAST(n AS CHAR)' : 'n::text'} n, ${mysql ? 'CAST(j AS CHAR)' : 'j::text'} j FROM ${quote(schema)}.esatti`))[0];
    assert.equal(exact.n, digits); assert(exact.j.includes('9007199254740993'));
    if (mysql) {
      await q(`CREATE TABLE ${quote(schema)}.geo(g GEOMETRY)`);
      await st.docInsert(schema, 'geo', { doc: '{"g":"SRID=4326;POINT(12.5 41.9)"}' });
      const g = (await q(`SELECT ST_AsText(g,'axis-order=long-lat') w, ST_SRID(g) srid FROM ${quote(schema)}.geo`))[0];
      assert.equal(g.w, 'POINT(12.5 41.9)'); assert.equal(g.srid, 4326);
      await q(`CREATE TABLE ${quote(schema)}.invisibile(id INT, g GEOMETRY SRID 4326 INVISIBLE)`);
      await st.docInsert(schema, 'invisibile', { doc: '{"id":1,"g":{"type":"Point","coordinates":[12.5,41.9]}}' });
      assert.equal((await q(`SELECT ST_SRID(g) srid FROM ${quote(schema)}.invisibile`))[0].srid, 4326);
      await assert.rejects(st.docInsert(schema, 'stati', { doc: '{"testo":"questo testo supera sicuramente venti caratteri"}' }));
    }
    console.log(`OK ${type}: ${types.length} tipi/valori estremi, NULL, default, stringhe vuote, identità e JSON esatto.`);
  } finally {
    await q(mysql ? `DROP DATABASE IF EXISTS ${quote(schema)}` : `DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    conn.release(); await st.disconnect();
  }
}

async function mongo() {
  const port = Number(process.env.INSERT_MONGO_PORT); assert(port);
  const st = new (require('../db/MongoDbStrategy'))(); await st.connect({ uri: `mongodb://127.0.0.1:${port}` });
  const db = 'codedb_insert_' + crypto.randomBytes(5).toString('hex');
  const values = {
    _id: '0123456789abcdef01234567', double: { $numberDouble: '-0' }, string: '', object: { a: true }, array: [null, 1],
    binary: { $binary: { base64: 'AP8=', subType: '00' } }, undefined: { $undefined: true }, oid: { $oid: '0123456789abcdef01234567' },
    bool: false, date: { $date: { $numberLong: '9223372036854775807' } }, dateMin: { $date: { $numberLong: '-9223372036854775808' } }, null: null,
    regex: { $regularExpression: { pattern: '^a', options: 'imsux' } }, pointer: { $dbPointer: { $ref: 'ns', $id: { $oid: '0123456789abcdef01234567' } } },
    code: { $code: 'return 1' }, symbol: { $symbol: 'a' }, scope: { $code: 'return x', $scope: { x: { $numberLong: '9007199254740993' } } },
    int: { $numberInt: '-2147483648' }, timestamp: { $timestamp: { t: 4294967295, i: 4294967295 } },
    long: { $numberLong: '9223372036854775807' }, decimal: { $numberDecimal: '1234567890123456789012345678901234' },
    min: { $minKey: 1 }, max: { $maxKey: 1 }, nan: { $numberDouble: 'NaN' }, inf: { $numberDouble: 'Infinity' },
  };
  for (const subtype of [1, 2, 3, 4, 5, 6, 7, 8, 9, 128]) {
    const bytes = subtype === 7 ? Buffer.from([0]) : subtype === 9 ? Buffer.from([3, 0, 1, 2, 127]) : Buffer.alloc(subtype === 3 || subtype === 4 ? 16 : 32, subtype);
    values['binary' + subtype] = { $binary: { base64: bytes.toString('base64'), subType: subtype.toString(16).padStart(2, '0') } };
  }
  try {
    await st.docInsert(db, 'tipi', { doc: JSON.stringify(values) });
    const actual = await st.client.db(db).collection('tipi').findOne({}, { raw: true });
    const tags = B.onDemand.parseToElements(actual);
    assert.deepEqual([...new Set(tags.map(e => e[0]))].sort((a, b) => a - b), [...Array.from({ length: 19 }, (_, i) => i + 1), 127, 255]);
    const field = name => tags.find(e => actual.toString('utf8', e[1], e[1] + e[2]) === name);
    assert.equal(field('_id')[0], 2, 'un _id di testo resta testo');
    assert.equal(actual.readBigInt64LE(field('date')[3]), 9223372036854775807n);
    assert.equal(actual.readBigInt64LE(field('dateMin')[3]), -9223372036854775808n);
    const decoded = B.deserialize(actual, { promoteValues: false });
    assert(Object.is(decoded.double.value, -0)); assert.equal(decoded.long.toString(), '9223372036854775807');
    assert.equal(decoded.binary.buffer.toString('hex'), '00ff');
    await st.docInsert(db, 'tipi', { doc: '{"_id":2,"n":9007199254740993}' });
    assert.equal((await st.client.db(db).collection('tipi').findOne({ _id: 2 }, { promoteLongs: false })).n.toString(), '9007199254740993');
    await assert.rejects(st.docInsert(db, 'tipi', { doc: '[{"_id":3},{"_id":3},{"_id":4}]' }), e => e.auditResult.insertedCount === 1);
    assert.equal(await st.client.db(db).collection('tipi').countDocuments({ _id: 4 }), 0, 'bulk ordinato si ferma al primo errore');
    await assert.rejects(st.docInsert(db, 'tipi', { doc: '{"d":{"$date":{"$numberLong":"9223372036854775808"}}}' }), /intervallo/);
    console.log('OK mongodb: tutti i 21 tag BSON memorizzabili, sottotipi binari, date 64 bit, _id testuale, bulk e errori parziali.');
  } finally { await st.client.db(db).dropDatabase(); await st.disconnect(); }
}

(async () => { await sql('mysql'); await sql('postgresql'); await mongo(); })().catch(err => { console.error(err); process.exitCode = 1; });
