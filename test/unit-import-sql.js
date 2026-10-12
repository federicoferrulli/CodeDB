'use strict';

const assert = require('assert');
const { creaLettoreSql } = require('../db/importSql');
const { normalizzaExportDatabase } = require('../db/artefatti');
const { fingerprint, canonical, congela } = require('../db/pianoComune');
const { createHash } = require('crypto');

function parse(text, dbType, chunk = 17) {
  const reader = creaLettoreSql({ dbType });
  for (let i = 0; i < text.length; i += chunk) reader.scrivi(text.slice(i, i + chunk));
  const artifact = reader.fine();
  if (process.argv.includes('--mutant')) artifact.collections[0].docs[0].id = String(Number(artifact.collections[0].docs[0].id));
  return normalizzaExportDatabase(artifact);
}

const mysql = parse(`-- Dump compatibile mysqldump/phpMyAdmin
CREATE DATABASE IF NOT EXISTS \`origine\`;
USE \`origine\`;
/*!40101 SET NAMES utf8mb4 */;
DROP TABLE IF EXISTS t;
CREATE TABLE t (id BIGINT PRIMARY KEY, n DECIMAL(30,10), testo TEXT, bin BLOB);
LOCK TABLES t WRITE;
INSERT INTO t VALUES (9007199254740993,12345678901234567890.1234567890,'virgola, apice \\' e ; 🦊',X'00ff'),(2,NULL,'',NULL);
UNLOCK TABLES;
DELIMITER ;;
CREATE PROCEDURE origine.p() BEGIN SELECT 'a;b'; SELECT 2; END;;
DELIMITER ;
`, 'mysql');
assert.strictEqual(mysql.collections[0].docs[0].id, '9007199254740993');
assert.strictEqual(mysql.collections[0].docs[0].n, '12345678901234567890.1234567890');
assert.strictEqual(mysql.collections[0].docs[0].testo, "virgola, apice ' e ; 🦊");
assert.strictEqual(mysql.collections[0].docs[0].bin.$binary.base64, 'AP8=');
assert.strictEqual(mysql.collections[0].docs[1].testo, '');
assert.strictEqual(mysql.objects.routines.length, 1);

const pg = parse(String.raw`CREATE SCHEMA origine;
SET standard_conforming_strings = on;
CREATE TABLE origine.t (id bigint NOT NULL, testo text, bin bytea, dt timestamp(6));
COPY origine.t (id, testo, bin, dt) FROM stdin;
9007199254740993	una\triga\n🦊	\\x00ff	2026-10-12 12:00:00.123456
2	\\N	\N	\N
\.
ALTER TABLE ONLY origine.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);
CREATE FUNCTION origine.f() RETURNS text LANGUAGE sql AS $$ SELECT 'a;b' $$;
`, 'postgresql');
assert.strictEqual(pg.collections[0].docs[0].id, '9007199254740993');
assert.strictEqual(pg.collections[0].docs[0].testo, 'una\triga\n🦊');
assert.strictEqual(pg.collections[0].docs[0].bin, '\\x00ff');
assert.strictEqual(pg.collections[0].docs[1].testo, '\\N');
assert.strictEqual(pg.collections[0].docs[1].bin, null);
assert.deepStrictEqual(pg.collections[0].identity.columns, ['id']);

const pgInsert = parse(`CREATE TABLE t (id bigint PRIMARY KEY, testo text); INSERT INTO t (id,testo) VALUES (9007199254740993,E'a\\nb''c;');`, 'postgresql');
assert.strictEqual(pgInsert.collections[0].docs[0].testo, "a\nb'c;");
assert.strictEqual(parse(String.raw`CREATE TABLE t(id text); INSERT INTO t VALUES ('\123\u0041\%\_');`, 'mysql').collections[0].docs[0].id, String.raw`123u0041\%\_`);
assert.strictEqual(parse(String.raw`SET SQL_MODE='NO_BACKSLASH_ESCAPES'; CREATE TABLE t(id text); INSERT INTO t VALUES ('\n');`, 'mysql').collections[0].docs[0].id, String.raw`\n`);
assert.strictEqual(parse(String.raw`CREATE TABLE t(id text); INSERT INTO t VALUES (E'\303\251');`, 'postgresql').collections[0].docs[0].id, 'é');
assert.strictEqual(parse('CREATE TABLE t(id text); COPY t (id) FROM stdin;\n\\303\\251\n\\.\n', 'postgresql').collections[0].docs[0].id, 'é');
assert.strictEqual(parse("CREATE TABLE t(id bit(3)); INSERT INTO t VALUES (b'010');", 'postgresql').collections[0].docs[0].id, '010');
assert.strictEqual(parse("SET time_zone='+05:30'; CREATE TABLE t(id int);", 'mysql').sqlTimeZone, '+05:30');
assert.throws(() => parse('CREATE TABLE t(id int); INSERT INTO t(id,id) VALUES(1,2);', 'mysql'), /duplicato/);
assert.throws(() => parse('CREATE TABLE t(id int); INSERT INTO t VALUES(1--2\n);', 'mysql'), /Espressione SQL/);
assert.throws(() => parse("SET DateStyle = 'SQL, DMY'; CREATE TABLE t(id int);", 'postgresql'), /DateStyle ISO/);
for (const sql of [
  'CREATE TABLE t(id int); INSERT INTO t VALUES (random());',
  'CREATE TABLE t(id int); INSERT INTO t VALUES (1,2);',
  "CREATE TABLE t(id text); INSERT INTO t VALUES ('non finita);",
  'CREATE TABLE t(id int); DELETE FROM t;',
  'CREATE TABLE t(id int); COPY t (id) FROM stdin;\n1\n',
  'CREATE TABLE a.t(id int); CREATE TABLE b.t(id int);',
  'CREATE TABLE t(id int); COPY t FROM PROGRAM \'comando\';',
]) assert.throws(() => parse(sql, 'postgresql'), /SQL|dump|schemi|supportat|completo|colonne/i);

for (const value of [mysql, pg, { z: undefined, a: [1, null, { '20': 'b', '3': 'a', z: '🦊' }] }]) {
  assert.strictEqual(fingerprint(value), createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'));
}
const normalized = congela(normalizzaExportDatabase(mysql));
assert.strictEqual(normalizzaExportDatabase(normalized), normalized, 'riuso sicuro dell’artefatto immutabile');
assert.throws(() => normalizzaExportDatabase(normalized, { expectedDbType: 'postgresql' }), /Motore/i);
console.log('  OK   SQL MySQL/PostgreSQL: precisione, COPY, delimitatori, validazione e impronta');
